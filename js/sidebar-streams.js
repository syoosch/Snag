"use strict";

// Match a generic player's document to observed playlists. The capture records keep their original signed URLs.
function streamPathHasId(url,id) {
    return !!id && new URL(url).pathname.split("/").some(part => part === id || part.endsWith("_"+id+".mp4"));
}

function sameStreamDocument(frame,record) {
    if (record.frameId !== frame.frameId || (record.method && record.method !== "GET") || !/^https?:\/\//i.test(record.url)) return false;
    return record.documentId && frame.documentId ? record.documentId === frame.documentId :
        record.fromPage || record.getTime >= frame.documentStart;
}

function streamDownloadUrls(frame,records) {
    if (!frame) return;
    const urls = new Set(frame.segments || []);
    const retained = new Set();
    for (const r of records) {
        if (!sameStreamDocument(frame,r)) continue;
        const playlist = isM3U8(r) || isMPD(r);
        if (!playlist && !/^(mp4|m4s|ts|m2ts|cmfv|cmfa)$/i.test(r.ext)) continue;
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

function streamRoots(matches,nested,identified,pictureLists,playlists,cache) {
    let roots = [...matches].filter(url => !nested.has(url));
    if (roots.length < 2) return roots;
    // When two ID matches are pending, a readable playlist supplies the evidence that a filename alone lacks.
    const read = roots.filter(url => cache.get(url)?.list);
    if (read.length && read.length < roots.length && !read.some(url => pictureLists.has(url))) return [];
    if (read.length) roots = read;
    const revisions = new Map();
    for (const url of roots) {
        const key = MediaSources.revisionKey(url);
        if (!revisions.has(key)) revisions.set(key,[]);
        revisions.get(key).push(url);
    }
    const unique = [];
    for (const versions of revisions.values()) {
        if (versions.length === 1) { unique.push(versions[0]); continue; }
        if (!versions.every(url => identified.has(url))) {
            // Some applications encode the entire content identity in an opaque query. Require matching media as well.
            const refs = versions.map(url => {
                const list = cache.get(url)?.list;
                return list && [...list.children,...list.audio,...list.parts].map(MediaSources.revisionKey);
            });
            if (!refs[0]?.length || !refs.every(items => items?.length === refs[0].length && items.every((s,i) => s === refs[0][i]))) return [];
        }
        const newest = versions.reduce((a,b) => (playlists.get(a).getTime || 0) > (playlists.get(b).getTime || 0) ? a : b);
        unique.push(newest);
        for (const old of versions) if (old !== newest) nested.add(old);
    }
    if (unique.length > 1) {
        const paths = new Set(unique.map(url => url.split("?",1)[0]));
        if (paths.size !== unique.length || !unique.every(url => identified.has(url) && pictureLists.has(url))) return [];
    }
    return unique;
}

function streamListDetails(list,cache,resolve = url => url,observation = url => cache.get(url)) {
    if (!list) return;
    // Keep a manual choice across a signature refresh. Distinct URIs advertised together keep distinct identities.
    const identities = new Map();
    for (const v of list.variants) if (v.url) {
        const key = MediaSources.revisionKey(v.url);
        identities.set(key,!identities.has(key) || identities.get(key) === v.url ? v.url : null);
    }
    const variants = list.variants.filter(v => !v.url || !cache.get(resolve(v.url))?.unsupported).map(v => {
        const child = v.url && resolve(v.url);
        const seen = child && observation(child);
        const key = v.url && MediaSources.revisionKey(v.url);
        return {...v,identity:key && identities.get(key) ? key : v.url || v.repId,observed:!!seen,observedAt:seen?.getTime || 0,
            duration:(child && cache.get(child)?.list?.duration) || list.duration};
    });
    return {variants,duration:list.duration,unavailable:list.variants.length > 0 && !variants.length};
}

function matchFrameStreams(frame,players,records,result,inspect) {
    const playlists = new Map(), segments = [], videoParts = new Set();
    for (const record of records) {
        if (!sameStreamDocument(frame,record)) continue;
        if (isM3U8(record) || isMPD(record)) playlists.set(resourceAddress(record.url),record);
        else if (/^(m4s|ts|m2ts|cmfv|cmfa)$/i.test(record.ext)) {
            segments.push(record.url);
            if (/^video\//i.test(record.type)) videoParts.add(resourceAddress(record.url));
        }
    }
    if (!playlists.size) return;
    players = players.filter(p => p.stream || playlists.has(resourceAddress(p.current)));
    const loadedIds = new Set(players.filter(p => p.loaded && p.streamId).map(p => p.streamId));
    players = players.filter(p => p.loaded || !loadedIds.has(p.streamId));
    if (!players.length) return;
    const samples = [...new Set(segments.slice(-96).map(resourceAddress).concat(frame.segments || []))];
    const requests = MediaSources.observedRequests([...playlists.keys(),...segments,...(frame.segments || [])]);
    const sampleReferences = new Set(samples);
    for (const url of samples) {
        const path = url.split("?",1)[0];
        if (requests.get(path) === url) sampleReferences.add(path);
    }
    const references = [...sampleReferences];
    const cache = inspectStreamLists(frame,playlists,inspect && (samples.length || players.some(p => !p.stream)));
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
        const roots = streamRoots(matches,nested,identified,pictureLists,playlists,cache);
        for (const url of roots) owners.set(url,owners.has(url) ? null : {player,nested});
    }
    for (const [url,owner] of owners) {
        if (!owner) continue;
        const details = streamListDetails(cache.get(url)?.list,cache,resolve,child => playlists.get(child));
        result.set(playlists.get(url),{player:owner.player,...details});
        for (const child of owner.nested) {
            if (playlists.has(child) && !owners.has(child)) result.set(playlists.get(child),{child:true});
        }
    }
}

function genericStreamMatches(records,frames,inspect) {
    const result = new Map();
    for (const frame of frames.values()) {
        if (SnagBili.route(frame.url) || SnagPlayer.youtubeId(frame.url)) continue;
        const players = frame.items.filter(p => p.kind === "video" && (p.stream || /^https?:\/\//i.test(p.current)) && (p.loaded || p.streamId) &&
            !p.ad && !p.protectedMedia && !p.objectStream && !p.inactiveSlot && !p.youtubeId && !p.biliMain);
        if (players.length) matchFrameStreams(frame,players,records.values(),result,inspect);
    }
    return result;
}
