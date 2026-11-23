// Join network responses with the actual elements reported by each connected frame.
// Keep query parameters: signed URLs and different renditions often share a pathname.
function resourceAddress(value) {
    if (!value || !/^(?:https?:\/\/|blob:)/i.test(value)) return "";
    try {
        const url = new URL(value);
        url.hash = "";
        return url.href;
    } catch { return ""; }
}

function resourceKind(record) {
    if (isM3U8(record) || isMPD(record)) return "video";
    if (isPicture(record) || /^(avif|heic|ico|jxl|tiff?)$/i.test(record.ext)) return "image";
    if (record.type?.startsWith("audio/")) return "audio";
    if (record.type?.startsWith("video/")) return "video";
    if (/^(mp3|mp2|m4a|aac|acc|weba|wav|wma|opus|oga|ogg|flac)$/i.test(record.ext)) return "audio";
    if (/^(mp4|m4v|m4s|webm|ogv|mov|flv|mkv|avi|3gp|ts|m2ts|mpeg4?|wmv|f4v|hlv|divx|vid|movie|asf)$/i.test(record.ext)) return "video";
    return "other";
}

function sidebarGroups(records, frames, pickedKey, currentVideo, route, sources = []) {
    const byAddress = new Map(), byRendition = new Map();
    const metadata = new Map();
    let partGroup;
    for (const source of sources) {
        const rep = SnagBili.representation(source.url);
        if (rep && source.kind === "video" && rep.cid === currentVideo?.cid) partGroup ||= rep.key;
        const id = rep?.identity || (source.episodeCid && resourceAddress(source.url));
        if (id) metadata.set(id,SnagBili.mergeTrack(metadata.get(id),source));
    }
    const main = frames.get(0)?.items.find(item => item.biliMain && currentVideo &&
        SnagBili.route(item.page)?.key === currentVideo.route &&
        (!item.duration || !currentVideo.duration || Math.abs(item.duration-currentVideo.duration) <= 2));
    function index(map, key, source) {
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(source);
    }
    for (const frame of frames.values()) {
        for (const element of frame.items) {
            const watch = frame.watch;
            const item = watch && !element.ad && element.id === watch.id && element.youtubeId === watch.videoId ?
                {...element,sources:[...element.sources,...watch.sources],menuQualities:[...new Set([...(element.menuQualities || []),...watch.qualities])]} : element;
            for (const source of item.sources) {
                const url = resourceAddress(source.url);
                if (!url) continue;
                const candidate = { ...source, item };
                index(byAddress,url,candidate);
                const representation = SnagBili.representation(url);
                if (representation) index(byRendition,representation.identity,candidate);
            }
        }
    }
    const groups = new Map();
    for (const [recordKey, record] of records) {
        const url = resourceAddress(record.url);
        if (!url) continue;
        const address = new URL(url);
        if (SnagPlayer.isPartialRequest(address,record)) continue;
        if (record.webUrl && SnagPlayer.isYouTubeMedia(address)) {
            const previous = SnagPlayer.youtubeId(record.webUrl);
            const frame = frames.get(record.frameId >= 0 ? record.frameId : 0);
            const current = frame?.items.find(item => item.youtubeId)?.youtubeId;
            if (previous && current && previous !== current) continue;
        }
        const representation = record.ext === "m4s" && SnagBili.representation(url);
        const onMainPage = record.frameId == null || record.frameId <= 0;
        if (representation && onMainPage && currentVideo && representation.cid !== currentVideo.cid) continue;
        const candidates = byAddress.get(url) || byRendition.get(representation?.identity) || [];
        if (route && onMainPage && !candidates.length && !(representation && currentVideo?.cid === representation.cid)) {
            const capturedOn = SnagBili.route(record.webUrl);
            if (capturedOn && capturedOn.key !== route.key) continue;
        }
        const matches = candidates.filter(({item}) =>
            (record.frameId == null || record.frameId < 0 || record.frameId === item.frameId) &&
            (!record.documentId || !item.documentId || record.documentId === item.documentId));
        // The capture engine de-duplicates equal URLs across frames. An explicitly
        // picked second occurrence can still refer to exactly the same captured file.
        const pointMatch = candidates.find(({item}) => item.key === pickedKey) ||
            matches.find(({item}) => item.kind !== "other") || matches[0];
        const match = candidates.find(source => source.item === pointMatch?.item && source.codec && source.label) ||
            candidates.find(source => source.item === pointMatch?.item && source.codec) ||
            candidates.find(source => source.item === pointMatch?.item && source.label) ||
            candidates.find(source => source.item === pointMatch?.item && source.kind) || pointMatch;
        const description = metadata.get(representation?.identity || url);
        const explicitKind = /^(video|audio)\//.exec(record.type || "")?.[1];
        const bili = representation && (match?.kind || description?.kind || explicitKind || representation.kind) ? representation : null;
        const directEpisode = currentVideo && !representation &&
            (description?.episodeCid === currentVideo.cid || currentVideo.episodeId && main && match?.item === main);
        const info = onMainPage && (directEpisode || bili && bili.cid === currentVideo?.cid) ? currentVideo : null;
        const point = match?.item || (info ? main : null);
        const kind = match?.kind || description?.kind || bili?.kind || (bili && explicitKind) ||
            (point?.kind === "other" ? null : point?.kind) || resourceKind(record);
        const rawSegment = /^(m4s|ts|m2ts)$/i.test(record.ext) && !bili && !point;
        const key = info?.episodeId ? "episode:" + info.cid : bili?.key ||
            (directEpisode && info ? partGroup || "bili:" + info.cid + "-1" : point?.key || recordKey);
        if (!groups.has(key)) {
            groups.set(key, { key, kind, point, info, rawSegment, biliId:bili?.cid || (directEpisode ? info?.cid : undefined), tracks:[] });
        }
        const group = groups.get(key);
        if (!group.point || point?.key === pickedKey || (info && !group.info)) group.point = point || group.point;
        if (info) group.info = info;
        if (kind === "video") group.kind = "video";
        const rendition = bili?.rendition;
        const track = { record, kind, label:match?.label || description?.label || "", codec:match?.codec || description?.codec,
            separate:match?.separate,defaultAudio:match?.defaultAudio,
            fps:match?.fps || description?.fps, bitrate:match?.bitrate || description?.bitrate, size:match?.size || description?.size,
            qualityId:description?.qualityId || match?.qualityId, episodeCid:directEpisode ? info?.cid : undefined, rendition,
            key:bili?.identity || (directEpisode ? url : recordKey) };
        const duplicate = bili || track.episodeCid ? group.tracks.findIndex(entry => entry.key === track.key) : -1;
        if (duplicate >= 0) {
            const prior = group.tracks[duplicate].record;
            if ((!prior.size && record.size) || (!record.fromPage && (record.getTime || 0) > (prior.getTime || 0))) {
                if (!record.size && prior.size) track.record = { ...record, size:prior.size };
                group.tracks[duplicate] = track;
            }
        } else group.tracks.push(track);
    }
    for (const frame of frames.values()) {
        const watch = frame.watch;
        if (!watch?.segments) continue;
        const item = frame.items.find(p => p.id === watch.id && p.youtubeId === watch.videoId && p.stream && p.loaded &&
            !p.ad && !p.protectedMedia && p.duration > 0 && p.width && p.height);
        if (!item) continue;
        const group = groups.get(item.key) || {key:item.key,kind:"video",point:item,tracks:[]};
        const point = group.point = {...group.point,menuQualities:[...new Set([...(item.menuQualities || []),...watch.qualities])]};
        const playing = SnagPlayer.playbackQuality(point);
        const variants = watch.manifestVariants || [], descriptions = watch.representations || [];
        const labels = new Set([...point.menuQualities,...variants.map(v=>v.label)]);
        const setting = SnagPlayer.quality(point.qualitySetting);
        if (setting) labels.add(setting);
        // A decoded picture can be cropped or be a low-resolution placeholder.
        // Infer only the site's standard tiers; other names must come from the player.
        const standard = /^(144|240|360|480|720|1080|1440|2160|4320)p\d*$/.test(playing);
        if (standard && (!playing.endsWith("p") || ![...labels].some(label => parseInt(label,10) === parseInt(playing,10)))) labels.add(playing);
        const audio = group.tracks.some(t => t.kind === "audio");
        for (const label of labels) {
            const match = /^(\d+)p(\d*)$/.exec(label);
            if (!match) continue;
            const direct = group.tracks.filter(t=>t.kind === "video" && t.label === label && (!t.separate || audio));
            const segments = {videoId:watch.videoId,height:Number(match[1]),fps:Number(match[2]),duration:item.duration,manifests:watch.manifests};
            const base = {key:"youtube:"+watch.videoId+":"+label,kind:"video",label,segments,record:{name:item.title || "YouTube",fromPage:true}};
            const listed = variants.filter(v=>v.label === label);
            // Some players announce a codec before exposing its bitrate or byte count.
            const docs = descriptions.filter(d=>d.type.startsWith('video/') && d.label === label).flatMap(d=>{
                if (d.size || d.bitrate) return [d];
                const rates = listed.filter(v=>v.codec === d.codec && v.bitrate > 0);
                return rates.length ? rates : [d];
            });
            const audioDocs = descriptions.filter(d=>d.type.startsWith('audio/'));
            const sounds = audioDocs.some(d=>d.defaultAudio) ? audioDocs.filter(d=>d.defaultAudio) : audioDocs;
            const listedCodecs = new Set(listed.map(v=>v.codec));
            if (!direct.length) {
                const versions = [...docs,...listed.filter(v => !docs.some(d => d.codec === v.codec))];
                group.tracks.unshift({...base,videoVersions:versions,audioVersions:sounds});
                if (listedCodecs.size <= 1 && !docs.some(d => d.codec && !listedCodecs.has(d.codec))) continue;
            }
            for (const codec of listedCodecs) {
                if (direct.some(t=>t.codec === codec)) continue;
                const paths = listed.filter(v=>v.codec === codec);
                const manifests = [...new Set(paths.map(v=>v.source))];
                const known = docs.filter(d=>d.codec === codec);
                group.tracks.push({...base,key:base.key+':'+codec,codec,segments:{...segments,codec,manifests},
                    videoVersions:known.length ? known : paths,audioVersions:sounds});
            }
        }
        if (group.tracks.length) groups.set(item.key,group);
    }
    const result = [];
    for (const group of groups.values()) {
        if (!group.biliId && !group.tracks.some(track => track.separate)) { result.push(group); continue; }
        const audio = group.tracks.filter(track => track.kind === "audio");
        if (group.kind === "video") result.push(group);
        if (audio.length) result.push({ ...group, key:group.key + ":audio", kind:"audio", tracks:audio });
    }
    const matched = new Set(result.filter(group => group.kind === "video").map(group => group.point?.key));
    for (const frame of frames.values()) {
        for (const item of frame.items) {
            if (!item.stream || !item.loaded || !item.width || matched.has(item.key)) continue;
            result.push({key:item.key + ":player",kind:"video",point:item,playerOnly:true,tracks:[]});
        }
    }
    return result;
}
