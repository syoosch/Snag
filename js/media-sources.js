'use strict';

const MediaSources = (() => {
    function address(value, base) {
        const url = new URL(value,base);
        if (!/^https?:$/.test(url.protocol)) throw new Error('mediaSourceFailed');
        url.hash = '';
        return url.href;
    }
    // An identity for comparing manifest revisions. Requests always use the verbatim URI from an observation or manifest.
    function revisionKey(value) {
        const url = new URL(value);
        for (const name of [...url.searchParams.keys()]) {
            if (/^(?:auth_key|token|sig|signature|expires|exp|hdnts|policy|key-pair-id|x-amz-(?:signature|date|expires|credential|security-token))$/i.test(name)) url.searchParams.delete(name);
        }
        return url.href;
    }
    function attributes(line) {
        const result = {};
        for (const [,key,value] of line.matchAll(/([\w-]+)=("[^"]*"|[^,]*)/g)) result[key] = value.replace(/^"|"$/g,'');
        return result;
    }
    function hls(text, base) {
        const variants = [], audio = [], parts = [];
        let variant, range, end = 0, previous, init, discontinuity = false, duration = 0;
        function part(uri, bytes) {
            const url = address(uri,base);
            if (!bytes) return {url};
            const [length,start] = bytes.split('@').map(Number);
            const offset = start ?? (url === previous ? end : 0);
            if (!Number.isSafeInteger(length) || length < 1 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('mediaBadFile');
            previous = url; end = offset + length;
            return {url,range:{offset,length}};
        }
        if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('mediaBadFile');
        for (const raw of text.split(/\r?\n/)) {
            const line = raw.trim();
            if (!line) continue;
            if (line.startsWith('#EXT-X-STREAM-INF:')) variant = attributes(line);
            else if (line.startsWith('#EXT-X-MEDIA:')) audio.push(attributes(line));
            else if (line.startsWith('#EXTINF:')) duration += parseFloat(line.slice(8));
            else if (line.startsWith('#EXT-X-BYTERANGE:')) range = line.slice(17);
            else if (line.startsWith('#EXT-X-KEY:') && attributes(line).METHOD !== 'NONE') throw new Error('mediaProtected');
            else if (line.startsWith('#EXT-X-MAP:')) {
                const map = attributes(line);
                const key = map.URI + '|' + map.BYTERANGE;
                if (init !== key) { parts.push(part(map.URI,map.BYTERANGE)); init = key; }
            } else if (line === '#EXT-X-DISCONTINUITY') discontinuity = true;
            else if (line[0] !== '#') {
                if (variant) { variants.push({...variant,url:address(line,base)}); variant = null; }
                else { parts.push(part(line,range)); range = null; }
            }
        }
        if (!variants.length && !text.includes('#EXT-X-ENDLIST')) throw new Error('mediaLive');
        return {variants,audio,parts,ext:init ? 'mp4' : 'ts',discontinuity,duration};
    }
    async function hlsTracks(file, mode, read, wasRequested, level = 0) {
        if (level > 4) throw new Error('mediaBadFile');
        const {text,url} = await read(file);
        const list = hls(text,url);
        if (!list.variants.length) {
            if (!list.parts.length) throw new Error('mediaBadFile');
            return [{...file,parts:list.parts,ext:list.ext,remux:list.discontinuity}];
        }
        const variants = list.variants.sort((a,b) => Number(b.BANDWIDTH) - Number(a.BANDWIDTH));
        const wanted = file.quality || (file.playbackHeight && {height:file.playbackHeight});
        const matching = wanted ? variants.filter(v => {
            const [w,h] = (v.RESOLUTION || '').split('x').map(Number);
            return (!wanted.height || matchesQuality(wanted,w,h,v['FRAME-RATE'])) && matchesCodec(wanted,v.CODECS);
        }) : [];
        // Explicit quality is binding. Decoded dimensions and actual child requests are hints for an automatic selection.
        const candidates = file.quality || matching.length ? matching : variants;
        const observed = !file.quality && candidates.find(v => wasRequested(v.url));
        // A generic master can list multiple files with identical dimensions and codec.
        let variant = observed || candidates[0];
        if (file.quality?.url) {
            variant = candidates.find(v => v.url === file.quality.url);
            if (!variant) {
                const key = revisionKey(file.quality.url);
                const updated = candidates.filter(v => revisionKey(v.url) === key);
                if (updated.length === 1) variant = updated[0];
            }
        }
        if (!variant) throw new Error('mediaSegmentQuality');
        const audio = list.audio.filter(a => a.TYPE === 'AUDIO' && variant.AUDIO && a['GROUP-ID'] === variant.AUDIO && a.URI);
        const chosen = audio.find(a => a.DEFAULT === 'YES') || audio[0];
        const branch = (source,kind) => hlsTracks({...file,url:source,quality:file.quality?.url ? undefined : file.quality,
            kind:kind === 'audio' ? 'audio' : file.kind},kind,read,wasRequested,level + 1);
        if (mode === 'audio' && chosen) return branch(address(chosen.URI,url),'audio');
        const video = await branch(variant.url,mode);
        if (mode === 'full' && chosen) video.push(...await branch(address(chosen.URI,url),'audio'));
        return video;
    }
    function dashTrack(file,playlist) {
        const segments = playlist?.segments || [];
        if (!segments.length && !playlist?.sidx) throw new Error('mediaBadFile');
        const parts = [];
        let lastInit;
        const add = segment => parts.push({url:address(segment.resolvedUri || segment.uri,file.url),range:segment.byterange});
        for (const s of segments) {
            if (s.key || s.contentProtection) throw new Error('mediaProtected');
            // mpd-parser also supplies a map with an empty URI and no range when
            // the representation has no initialization segment.
            const init = (s.map?.uri || s.map?.byterange) && JSON.stringify([s.map.resolvedUri,s.map.byterange]);
            if (init && init !== lastInit) { add(s.map); lastInit = init; }
            add(s);
        }
        if (!segments.length) parts.push({url:address(playlist.sidx.resolvedUri || playlist.sidx.uri,file.url)});
        return {...file,parts,ext:'mp4',remux:true};
    }
    function matchesQuality(expected,w,h,rate) {
        if (Math.min(Number(w),Number(h)) !== expected.height) return false;
        const [num,den = 1] = String(rate || 0).split('/').map(Number);
        const fps = num / den;
        return !expected.fps || !fps || Math.abs(expected.fps - fps) <= 0.6;
    }
    function matchesCodec(expected,codecs) {
        return !expected.codec || SnagFormat.codec(codecs,'video') === expected.codec;
    }
    function dashDocument(text) {
        const xml = new DOMParser().parseFromString(text,'application/xml');
        if (xml.querySelector('parsererror') || xml.documentElement.localName !== 'MPD') throw new Error('mediaBadFile');
        if (xml.getElementsByTagNameNS('*','ContentProtection').length) throw new Error('mediaProtected');
        if (xml.documentElement.getAttribute('type') === 'dynamic') throw new Error('mediaLive');
        return xml;
    }
    // Inspect only references already present in the document. Never expand a DASH timeline to find a player.
    function playlistReferences(text,url,format) {
        if (format === 'hls') {
            const list = hls(text,url);
            return {children:list.variants.map(v => v.url),variants:hlsVariants(list),
                audio:list.audio.filter(a => a.URI && a.TYPE === 'AUDIO').map(a => address(a.URI,url)),
                parts:new Set(list.parts.map(p => p.url)), duration:list.duration};
        }
        const xml = dashDocument(text), root = xml.documentElement;
        const duration = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(root.getAttribute('mediaPresentationDuration') || '');
        const parts = new Set(), templates = [], baseUrls = new WeakMap();
        function elementBase(parent) {
            if (!parent) return url;
            if (!baseUrls.has(parent)) {
                const inherited = elementBase(parent.parentElement);
                const base = [...parent.children].find(c => c.localName === 'BaseURL')?.textContent.trim();
                baseUrls.set(parent,base ? address(base,inherited) : inherited);
            }
            return baseUrls.get(parent);
        }
        for (const node of root.querySelectorAll('SegmentURL[media],SegmentTemplate[media]')) {
            const media = address(node.getAttribute('media'),elementBase(node.parentElement));
            if (node.localName === 'SegmentURL') parts.add(media);
            else {
                const tokens = media.split(/(\$(?:Number|Time|Bandwidth|RepresentationID)(?:%0\d+d)?\$)/);
                if (tokens.length > 9 || templates.length >= 64) continue;
                const pattern = tokens.map((s,i) => i % 2 ? (s === '$RepresentationID$' ? '[^/?#]{1,160}' : '[0-9]{1,24}') :
                    s.replace(/[.*+?^$()|[\]{}\\]/g,'\\$&'));
                templates.push(new RegExp('^'+pattern.join('')+'$'));
            }
        }
        return {children:[],audio:[],parts,templates,variants:dashVariants(xml),
            duration:duration && Number(duration[1] || 0)*86400 + Number(duration[2] || 0)*3600 +
                Number(duration[3] || 0)*60 + Number(duration[4] || 0)};
    }
    // Only metadata from the master playlist is needed to list the encodings.
    function hlsVariants(list) {
        const audioGroups = new Set(list.audio.filter(t => t.TYPE === 'AUDIO').map(t => t['GROUP-ID']));
        return list.variants.map(v => {
            const [w,h] = (v.RESOLUTION || '').split('x').map(Number);
            return {url:v.url,height:Math.min(w,h) || 0,fps:Number(v['FRAME-RATE']) || 0,codec:SnagFormat.codec(v.CODECS,'video'),
                bandwidth:Number(v.BANDWIDTH) || 0,bitrate:Number(v['AVERAGE-BANDWIDTH'] || v.BANDWIDTH) || 0,
                includesAudio:audioGroups.has(v.AUDIO) || !!SnagFormat.codec(v.CODECS,'audio')};
        });
    }
    function dashVariants(xml) {
        const representations = Array.from(xml.getElementsByTagNameNS('*','Representation'));
        const independentAudio = representations.some(r => /audio/i.test(r.getAttribute('mimeType') ||
            r.parentElement?.getAttribute('mimeType') || r.parentElement?.getAttribute('contentType') || ''));
        return representations.map(rep => {
            const attr = name => rep.getAttribute(name) || rep.parentElement?.getAttribute(name);
            const [rate,divisor = 1] = (attr('frameRate') || '').split('/').map(Number);
            return {repId:rep.getAttribute('id'),height:Math.min(Number(attr('width')),Number(attr('height'))),fps:rate/divisor || 0,
                codec:SnagFormat.codec(attr('codecs'),'video'),bitrate:Number(attr('bandwidth')),type:attr('mimeType') || attr('contentType'),pictureOnly:independentAudio};
        }).filter(v => !/^audio/i.test(v.type) && (v.height || v.codec || /^video/i.test(v.type)));
    }
    function videoVariants(text,source) {
        const variants = source.playlist === 'hls' ? hlsVariants(hls(text,source.url)) : dashVariants(dashDocument(text));
        return variants.filter(v=>v.height && v.codec);
    }
    async function dashTracks(file,mode,read) {
        const {text,url} = await read(file);
        const xml = dashDocument(text);
        const data = mpdParser.parse(text,{manifestUri:url});
        const best = xs => [...xs].sort((a,b) => (b.attributes?.BANDWIDTH || 0) - (a.attributes?.BANDWIDTH || 0))[0];
        const groups = Object.values(data.mediaGroups?.AUDIO?.audio || {});
        const sound = best((groups.find(g => g.default) || groups[0])?.playlists || []);
        let pictures = data.playlists || [];
        if (file.quality) {
            const representations = Array.from(xml.getElementsByTagNameNS('*','Representation'));
            pictures = pictures.filter(p => {
                const a = p.attributes || {};
                if (file.quality.repId && String(a.NAME) !== file.quality.repId) return false;
                const rep = representations.find(r=>r.getAttribute('id') === String(a.NAME));
                const attr = name => rep?.getAttribute(name) || rep?.parentNode?.getAttribute(name);
                if (!file.quality.repId && file.quality.bitrate && Number(a.BANDWIDTH || attr('bandwidth')) !== file.quality.bitrate) return false;
                return (!file.quality.height || matchesQuality(file.quality,a.RESOLUTION?.width || attr('width'),a.RESOLUTION?.height || attr('height'),
                    attr('frameRate') || a['FRAME-RATE'])) && matchesCodec(file.quality,attr('codecs') || a.CODECS);
            });
            if (!pictures.length) throw new Error('mediaSegmentQuality');
        }
        const picture = best(pictures);
        const tracks = mode === 'audio' ? [sound || picture] : mode === 'full' && picture && sound ? [picture,sound] : [picture || sound];
        return tracks.map(p => dashTrack({...file,url},p));
    }
    // A loader can add a query to a queryless playlist reference. Only use a complete observed URL for
    // the same origin and pathname. Two different requests for that path make the lookup ambiguous.
    function observedRequests(urls) {
        const requests = new Map();
        for (const url of urls) {
            if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue;
            const path = url.split('?',1)[0];
            requests.set(path,requests.has(path) && requests.get(path) !== url ? null : url);
        }
        return requests;
    }
    async function plan(request,read) {
        let files = request.files;
        const {observedUrls,...first} = files[0];
        const seen = new Set(observedUrls || []);
        const observed = observedRequests(seen);
        const resolve = url => observed.get(url) || url;
        const readList = observed.size ? file => read({...file,url:resolve(file.url)}) : read;
        if (first.playlist === 'hls') files = await hlsTracks(first,request.mode,readList,url => seen.has(resolve(url)));
        if (first.playlist === 'dash') files = await dashTracks(first,request.mode,readList);
        const tracks = files.map(f => ({...f,parts:f.parts || (f.local || f.recording ? [] : [{url:address(f.url)}])}));
        for (const track of tracks) if (track.playlist) {
            // The manifest response describes a text document. Only explicit byte ranges give a media byte count.
            track.size = track.parts.every(part => Number.isSafeInteger(part.range?.length) && part.range.length > 0)
                ? track.parts.reduce((sum,part) => sum + part.range.length,0) : undefined;
        }
        if (observed.size) for (const track of tracks) {
            for (const part of track.parts) part.url = resolve(part.url);
        }
        // Ordinary complete files retain their original container, tracks and metadata.
        const copy = request.mode === 'full' && tracks.length === 1 && !tracks[0].remux;
        return {tracks,copy};
    }
    return {address,plan,videoVariants,playlistReferences,observedRequests,revisionKey};
})();
