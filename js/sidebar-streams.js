"use strict";

// Match a generic player's document to observed playlists. The capture records keep their original signed URLs.
function streamPathHasId(url,id) {
    return !!id && new URL(url).pathname.split("/").some(part => part === id || part.endsWith("_"+id+".mp4"));
}

function sameStreamDocument(frame,record) {
    if (record.fromSrcdoc || record.frameId !== frame.frameId || (record.method && record.method !== "GET") || !/^https?:\/\//i.test(record.url)) return false;
    return record.documentId && frame.documentId ? record.documentId === frame.documentId :
        record.fromPage || record.getTime >= frame.documentStart;
}

function nativeMediaFiles(frame) {
    return new Set((frame.items || []).filter(p => !p.stream && p.current).map(p => resourceAddress(p.current)));
}
function streamDownloadUrls(frame,records,transfers) {
    if (!frame) return;
    const nativeFiles = nativeMediaFiles(frame);
    const urls = new Set((frame.segments || []).filter(url => !nativeFiles.has(url)));
    const retained = new Set();
    for (const sample of transfers || []) {
        if (sameStreamDocument(frame,sample) && !nativeFiles.has(sample.url)) urls.add(sample.url);
    }
    for (const r of records) {
        if (!sameStreamDocument(frame,r)) continue;
        const playlist = isM3U8(r) || isMPD(r);
        const captured = !r.fromPage && !r.isRegex;
        const key = captured && /\.key$/i.test(new URL(r.url).pathname);
        if (!playlist && !key && (nativeFiles.has(resourceAddress(r.url)) || !SnagFormat.segmentSample(r.url,r.type,captured))) continue;
        const url = resourceAddress(r.url);
        urls.add(url);
        if (playlist) retained.add(url);
    }
    // Unsigned child playlists also identify the rendition the player requested.
    for (const url of urls) {
        if (!url.includes("?")) continue;
        retained.add(url);
        const path = url.split("?",1)[0];
        if (urls.has(path)) retained.add(path); // Preserve ambiguity when both forms were actually requested.
    }
    return retained.size ? [...retained] : undefined;
}

function receivePlaylistText(frame,{url,text,retryable}) {
    const entry = frame.streamLists?.get(url);
    if (!entry?.pending) return;
    entry.pending = false;
    if (!text) {
        if (retryable && entry.attempts < 3) {
            const delay = 600 * entry.attempts;
            entry.retryAt = Date.now() + delay;
            setTimeout(() => {
                if (frames.get(frame.frameId) === frame && frame.streamLists.get(url) === entry) scheduleRender();
            },delay);
        }
        return;
    }
    try { entry.list = MediaSources.playlistReferences(text,url,entry.format); }
    catch { entry.unsupported = true; }
}

function inspectStreamLists(frame,playlists,inspect) {
    const cache = frame.streamLists ??= new Map();
    const addresses = [...playlists.keys()];
    const candidates = new Set([...addresses.slice(0,8),...addresses.slice(-24).reverse()]);
    for (const [url,entry] of cache) if (!entry.pending && !candidates.has(url)) cache.delete(url);
    if (inspect) {
        let pending = [...cache.values()].filter(entry => entry.pending).length;
        for (const url of candidates) {
            if (pending >= 2) break;
            const prior = cache.get(url), record = playlists.get(url);
            if (prior && !(prior.retryAt && Date.now() >= prior.retryAt)) continue;
            const captured = !!frame.documentId && frame.documentId === record.documentId && record.isRegex === false && !record.fromPage;
            try { frame.port.postMessage({type:"inspectPlaylist",url,documentStart:captured ? frame.documentStart : undefined}); }
            catch { break; } // A navigation can disconnect the port before its notification reaches the sidebar.
            cache.set(url,{pending:true,attempts:(prior?.attempts || 0)+1,format:isMPD(record) ? "dash" : "hls"});
            pending++;
        }
    }
    return cache;
}

// Follow only cached references. A master with the same child paths can still lead to two different films.
function sameStreamRevision(first,second,cache,resolve,seen = new Set()) {
    if (first === second) return true;
    const a = cache.get(first), b = cache.get(second);
    if (a?.unsupported || b?.unsupported) return false;
    if (!a?.list || !b?.list) return true; // The parent layout is the available evidence for an uninspected child.
    if (!a.list.layout || a.list.layout !== b.list.layout) return false;
    const pair = JSON.stringify([first,second]);
    if (seen.has(pair)) return true;
    seen.add(pair);
    const previous = [...a.list.children,...a.list.audio], current = [...b.list.children,...b.list.audio];
    return previous.every((url,i) => sameStreamRevision(resolve(url),resolve(current[i]),cache,resolve,seen));
}

function streamRoots(matches,nested,identified,pictureLists,playlists,cache,resolve) {
    let roots = [...matches].filter(url => !nested.has(url));
    if (roots.length < 2) return roots;
    // When two ID matches are pending, a readable playlist supplies the evidence that a filename alone lacks.
    const read = roots.filter(url => cache.get(url)?.list);
    if (read.length && read.length < roots.length && !read.some(url => pictureLists.has(url))) return [];
    if (read.length) roots = read;
    const revisions = new Map();
    for (const url of roots) {
        const key = url.split("?",1)[0];
        if (!revisions.has(key)) revisions.set(key,[]);
        revisions.get(key).push(url);
    }
    const unique = [];
    for (const versions of revisions.values()) {
        if (versions.length === 1) { unique.push(versions[0]); continue; }
        const first = versions[0], layout = cache.get(first)?.list?.layout;
        const selector = MediaSources.contentPath(first);
        if (!layout || !versions.every(url => MediaSources.contentPath(url) === selector &&
            cache.get(url)?.list?.layout && sameStreamRevision(first,url,cache,resolve))) return [];
        versions.sort((a,b) => (playlists.get(a).getTime || 0) - (playlists.get(b).getTime || 0));
        const newest = versions.at(-1);
        // Inherit the first proven identity, including after its signed URL leaves the capture buffer.
        const identity = cache.get(versions[0]).identity || MediaSources.revisionKey(versions[0]);
        for (const url of versions) cache.get(url).identity = identity;
        unique.push(newest);
        for (const old of versions) if (old !== newest) nested.add(old);
    }
    if (unique.length > 1) {
        if (!unique.every(url => identified.has(url) && pictureLists.has(url))) return [];
    }
    return unique;
}

function leafSize(list,bitrate,sizes,ranges,resolve) {
    if (!list?.streamLeaf) return;
    if (list.rangeBytes) return {value:list.rangeBytes,estimated:false};
    if (!sizes || bitrate || !(list.duration > 0)) return;
    const sampled = new Set();
    let mediaCount = 0, sampledBytes = 0, sampledDuration = 0;
    for (const part of list.mediaParts) {
        if (part.init) continue;
        mediaCount++;
        const url = resolve(part.url);
        const key = part.range ? JSON.stringify([url,part.range.offset,part.range.length]) : url;
        const size = part.range ? ranges.has(key) && part.range.length : sizes.get(url);
        if (!(size > 0 && part.duration > 0) || sampled.has(key)) continue;
        sampled.add(key);
        sampledBytes += size; sampledDuration += part.duration;
    }
    if (sampled.size < Math.min(2,mediaCount) || !sampledDuration || !sampledBytes) return;
    const value = Math.round(sampledBytes * list.duration / sampledDuration);
    if (Number.isSafeInteger(value) && value > 0) return {value,estimated:true};
}

function streamListDetails(list,cache,resolve = url => url,observation = url => cache.get(url),measure = leafSize) {
    if (!list) return;
    // Keep a manual choice across a signature refresh. Distinct URIs advertised together keep distinct identities.
    const identities = new Map();
    for (const v of list.variants) if (v.url) {
        const key = MediaSources.contentPath(v.url);
        identities.set(key,!identities.has(key) || identities.get(key) === v.url ? v.url : null);
    }
    const variants = list.variants.filter(v => !v.url || !cache.get(resolve(v.url))?.unsupported).map(v => {
        const child = v.url && resolve(v.url);
        const seen = child && observation(child);
        const childList = child && cache.get(child)?.list;
        const partSize = measure(childList,v.bitrate);
        const key = v.url && MediaSources.contentPath(v.url);
        return {...v,identity:key && identities.get(key) ? key : v.url || v.repId,observed:!!seen,observedAt:seen?.getTime || 0,
            partSize,pictureOnly:v.pictureOnly || (!!partSize && v.externalAudio),duration:childList?.duration || list.duration};
    });
    return {variants,masterLayout:list.children.length ? list.layout : undefined,duration:list.duration,
        partSize:measure(list),pictureOnly:list.pictureOnly,unavailable:list.variants.length > 0 && !variants.length};
}

function inspectLeafCodec(frame,entry,record,player,observed,resolve) {
    if (!player.id || !player.loaded || !entry?.list?.streamLeaf || entry.probeUrl ||
        SnagFormat.codec(record.codecs || record.type,"video") || player.sources?.some(s => s.url === record.url && s.codec)) return;
    const parts = entry.list.mediaParts;
    if (parts.some(p => p.key)) return;
    const seen = p => observed.has(resolve(p.url));
    const part = parts.find(p => p.init && seen(p)) || parts.find(p => !p.init && seen(p));
    if (!part) return;
    entry.probeUrl = resolve(part.url);
    try { frame.port.postMessage({type:"inspectLeaf",playlist:record.url,url:entry.probeUrl,id:player.id,range:part.range,
        documentStart:frame.documentStart}); } catch { /* Frame disconnected. */ }
}

function matchFrameStreams(frame,players,records,result,inspect,transfers) {
    const playlists = new Map(), segments = [], videoParts = new Set(frame.videoSegments || []);
    const nativeFiles = nativeMediaFiles(frame);
    const observed = new Set(frame.segments || []), sizes = new Map(), ranges = new Set(), partRecords = new Map();
    for (const record of records) {
        if (!sameStreamDocument(frame,record)) continue;
        if (isM3U8(record) || isMPD(record)) playlists.set(resourceAddress(record.url),record);
        else if (!nativeFiles.has(resourceAddress(record.url)) && SnagFormat.segmentSample(record.url,record.type,!record.fromPage && !record.isRegex)) {
            segments.push(record.url);
            partRecords.set(record.url,record);
            if (!record.fromPage && !record.isRegex) observed.add(record.url);
            const size = record.responseSize ?? record.size;
            if (Number.isSafeInteger(size) && size > 0) sizes.set(record.url,size);
            if (/^video\//i.test(record.type)) videoParts.add(resourceAddress(record.url));
        }
    }
    if (!playlists.size) return;
    players = players.filter(p => p.stream || playlists.has(resourceAddress(p.current)));
    const loadedIds = new Set(players.filter(p => p.loaded && p.streamId).map(p => p.streamId));
    players = players.filter(p => p.loaded || !loadedIds.has(p.streamId));
    if (!players.length) return;
    for (const sample of transfers || []) {
        if (!sameStreamDocument(frame,sample) || nativeFiles.has(sample.url)) continue;
        observed.add(sample.url);
        sizes.set(sample.url,sample.bytes);
        if (sample.offset != null) ranges.add(JSON.stringify([sample.url,sample.offset,sample.bytes]));
    }
    const samples = [...new Set([...segments.slice(-96).map(resourceAddress),...observed])].filter(url => !nativeFiles.has(url));
    const requests = MediaSources.observedRequests([...playlists.keys(),...segments,...observed]);
    const sampleReferences = new Set(samples);
    for (const url of samples) {
        const path = url.split("?",1)[0];
        if (requests.get(path) === url) sampleReferences.add(path);
    }
    const references = [...sampleReferences];
    const cache = inspectStreamLists(frame,playlists,inspect && (samples.length || players.some(p => p.loaded || !p.stream)));
    const resolve = ref => requests.get(ref) || ref;
    const children = url => (cache.get(url)?.list?.children || []).map(resolve);
    const videos = frame.items.filter(i => i.kind === "video" && !i.inactiveSlot && (i.loaded || i.playing));
    const playing = videos.filter(i => i.playing);
    const primary = videos.length === 1 ? videos[0] : playing.length === 1 ? playing[0] : null;
    const owners = new Map();
    for (const player of players) {
        const identified = new Set(), timed = new Set(), pictureLists = new Set();
        for (const url of playlists.keys()) {
            const entry = cache.get(url);
            if (entry?.unsupported) continue;
            if (streamPathHasId(url,player.streamId)) identified.add(url);
            const list = entry?.list;
            if (!list) continue;
            const sameDuration = item => item.duration > 0 && list.duration > 0 &&
                Math.abs(item.duration-list.duration) <= Math.min(2,Math.max(0.25,item.duration*0.005));
            const durationMatches = primary === player && sameDuration(player) && !videos.some(i => i !== player && sameDuration(i));
            const hits = references.filter(part => list.parts.has(part) || list.templates?.some(pattern => pattern.test(part)));
            if (hits.some(part => streamPathHasId(part,player.streamId))) identified.add(url);
            if (durationMatches && hits.length) timed.add(url);
            if (hits.some(part => videoParts.has(resolve(part))) || list.variants?.length) pictureLists.add(url);
        }
        const native = resourceAddress(player.current);
        const matches = playlists.has(native) && !cache.get(native)?.unsupported ? new Set([native]) : identified.size ? identified : timed;
        // Follow only links between captured playlists. A master can have an unrelated CDN path.
        for (let count = -1; count !== matches.size;) {
            count = matches.size;
            for (const url of playlists.keys()) if (children(url).some(child => matches.has(child))) matches.add(url);
        }
        const nested = new Set();
        for (const url of matches) {
            for (const child of [...children(url),...(cache.get(url)?.list?.audio || []).map(resolve)]) nested.add(child);
        }
        const roots = streamRoots(matches,nested,identified,pictureLists,playlists,cache,resolve);
        for (const url of roots) owners.set(url,owners.has(url) ? null : {player,nested});
    }
    for (const [url,owner] of owners) {
        if (!owner) continue;
        const entry = cache.get(url), record = playlists.get(url);
        const details = streamListDetails(entry?.list,cache,resolve,child => playlists.get(child),
            (list,bitrate) => leafSize(list,bitrate,sizes,ranges,resolve));
        const streamLeaf = !!entry?.list?.streamLeaf && (resourceAddress(owner.player.current) === url ||
            ![...owners].some(([other,match]) => other !== url && match?.player === owner.player));
        if (streamLeaf && inspect) inspectLeafCodec(frame,entry,record,owner.player,observed,resolve);
        result.set(record,{player:owner.player,identity:entry?.identity,streamLeaf,codec:entry?.codec,...details});
        // An observed part of this player's media sequence has a known owner in the fragments drawer.
        for (const member of [url,...owner.nested]) {
            const list = cache.get(member)?.list;
            if (!list?.streamLeaf) continue;
            for (const [address,part] of partRecords) {
                const path = address.split("?",1)[0];
                if (list.parts.has(address) || list.parts.has(path) && resolve(path) === address) result.set(part,{child:true});
            }
        }
        for (const child of owner.nested) {
            if (playlists.has(child) && !owners.has(child)) result.set(playlists.get(child),{child:true});
        }
    }
}

function genericStreamMatches(records,frames,inspect,transfers) {
    const result = new Map();
    for (const frame of frames.values()) {
        if (SnagBili.route(frame.url) || SnagPlayer.youtubeId(frame.url)) continue;
        const players = frame.items.filter(p => p.kind === "video" && (p.stream || /^https?:\/\//i.test(p.current)) && (p.loaded || p.streamId) &&
            !p.ad && !p.protectedMedia && !p.objectStream && !p.inactiveSlot && !p.youtubeId && !p.biliMain);
        if (players.length) matchFrameStreams(frame,players,records.values(),result,inspect,transfers?.values());
    }
    return result;
}
