'use strict';

const MediaSources = (() => {
    function address(value, base) {
        const url = new URL(value,base);
        if (!/^https?:$/.test(url.protocol)) throw new Error('mediaSourceFailed');
        url.hash = '';
        return url.href;
    }
    function attributes(line) {
        const result = {};
        for (const [,key,value] of line.matchAll(/([\w-]+)=("[^"]*"|[^,]*)/g)) result[key] = value.replace(/^"|"$/g,'');
        return result;
    }
    function hls(text, base) {
        const variants = [], audio = [], parts = [];
        let variant, range, end = 0, previous, init, discontinuity = false;
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
        return {variants,audio,parts,ext:init ? 'mp4' : 'ts',discontinuity};
    }
    async function hlsTracks(file, mode, read, level = 0) {
        if (level > 4) throw new Error('mediaBadFile');
        const {text,url} = await read(file);
        const list = hls(text,url);
        if (!list.variants.length) {
            if (!list.parts.length) throw new Error('mediaBadFile');
            return [{...file,parts:list.parts,ext:list.ext,remux:list.discontinuity}];
        }
        const variants = file.quality ? list.variants.filter(v => {
            const [w,h] = (v.RESOLUTION || '').split('x').map(Number);
            return matchesQuality(file.quality,w,h,v['FRAME-RATE']) && matchesCodec(file.quality,v.CODECS);
        }) : list.variants;
        const variant = variants.sort((a,b) => Number(b.BANDWIDTH) - Number(a.BANDWIDTH))[0];
        if (!variant) throw new Error('mediaSegmentQuality');
        const audio = list.audio.filter(a => a.TYPE === 'AUDIO' && variant.AUDIO && a['GROUP-ID'] === variant.AUDIO && a.URI);
        const chosen = audio.find(a => a.DEFAULT === 'YES') || audio[0];
        const branch = (source,kind) => hlsTracks({...file,url:source,kind:kind === 'audio' ? 'audio' : file.kind},kind,read,level + 1);
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
        if (xml.querySelector('parsererror')) throw new Error('mediaBadFile');
        if (xml.getElementsByTagNameNS('*','ContentProtection').length) throw new Error('mediaProtected');
        if (xml.documentElement.getAttribute('type') === 'dynamic') throw new Error('mediaLive');
        return xml;
    }
    // Only metadata from the master playlist is needed to list the encodings.
    function videoVariants(text,source) {
        if (source.playlist === 'hls') {
            const list = hls(text,source.url);
            const audioGroups = new Set(list.audio.filter(t => t.TYPE === 'AUDIO').map(t => t['GROUP-ID']));
            return list.variants.map(v => {
                const [w,h] = (v.RESOLUTION || '').split('x').map(Number);
                return {height:Math.min(w,h),fps:Number(v['FRAME-RATE']) || 0,codec:SnagFormat.codec(v.CODECS,'video'),
                    bitrate:Number(v['AVERAGE-BANDWIDTH'] || v.BANDWIDTH),
                    includesAudio:audioGroups.has(v.AUDIO) || !!SnagFormat.codec(v.CODECS,'audio')};
            }).filter(v=>v.height && v.codec);
        }
        return Array.from(dashDocument(text).getElementsByTagNameNS('*','Representation'),rep => {
            const attr = name => rep.getAttribute(name) || rep.parentElement?.getAttribute(name);
            const [rate,divisor = 1] = (attr('frameRate') || '').split('/').map(Number);
            return {height:Math.min(Number(attr('width')),Number(attr('height'))),fps:rate/divisor || 0,
                codec:SnagFormat.codec(attr('codecs'),'video'),bitrate:Number(attr('bandwidth')),type:attr('mimeType')};
        }).filter(v=>v.height && v.codec);
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
                const rep = representations.find(r=>r.getAttribute('id') === String(a.NAME));
                const attr = name => rep?.getAttribute(name) || rep?.parentNode?.getAttribute(name);
                return matchesQuality(file.quality,a.RESOLUTION?.width || attr('width'),a.RESOLUTION?.height || attr('height'),
                    attr('frameRate') || a['FRAME-RATE']) && matchesCodec(file.quality,attr('codecs') || a.CODECS);
            });
            if (!pictures.length) throw new Error('mediaSegmentQuality');
        }
        const picture = best(pictures);
        const tracks = mode === 'audio' ? [sound || picture] : mode === 'full' && picture && sound ? [picture,sound] : [picture || sound];
        return tracks.map(p => dashTrack({...file,url},p));
    }
    async function plan(request,read) {
        let files = request.files;
        const first = files[0];
        if (first.playlist === 'hls') files = await hlsTracks(first,request.mode,read);
        if (first.playlist === 'dash') files = await dashTracks(first,request.mode,read);
        const tracks = files.map(f => ({...f,parts:f.parts || (f.local || f.recording ? [] : [{url:address(f.url)}])}));
        // Ordinary complete files retain their original container, tracks and metadata.
        const copy = request.mode === 'full' && tracks.length === 1 && !tracks[0].remux;
        return {tracks,copy};
    }
    return {address,plan,videoVariants};
})();
