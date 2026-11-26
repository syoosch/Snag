// Use the same names for player metadata, manifest variants and finished files.
globalThis.SnagFormat = (() => {
    const video = {avc1:'H.264',avc3:'H.264',h264:'H.264',hev1:'H.265',hvc1:'H.265',hevc:'H.265',
        av01:'AV1',av1:'AV1',vp09:'VP9',vp9:'VP9',vp08:'VP8',vp8:'VP8',theora:'Theora',mpeg4:'MPEG-4',mp4v:'MPEG-4'};
    const audio = {mp4a:'AAC',aac:'AAC',mp3:'MP3',alac:'ALAC',flac:'FLAC',opus:'Opus',vorbis:'Vorbis',
        'ec-3':'E-AC-3','ac-3':'AC-3',ac3:'AC-3',eac3:'E-AC-3'};
    function codec(value,kind) {
        const source = String(value || '').toLowerCase().trim();
        if (/^h\.26[45]$/.test(source) && kind !== 'audio') return source.toUpperCase();
        const list = source.match(/\bcodecs\s*=\s*["']?([^"';]+)/)?.[1] || source;
        for (const token of list.split(',')) {
            const [key,object,profile] = token.trim().split('.');
            if (kind !== 'audio' && video[key]) return video[key];
            if (kind !== 'video' && audio[key]) {
                if (key === 'mp4a' && object === '40' && ['5','29'].includes(profile)) return profile === '5' ? 'HE-AAC' : 'HE-AAC v2';
                return audio[key];
            }
        }
        return '';
    }
    const mimeExtensions = {
        'video/mp4':'mp4','audio/mp4':'m4a','video/webm':'webm','audio/webm':'webm','audio/mpeg':'mp3','video/mpeg':'mpg',
        'video/mp2t':'ts','video/iso.segment':'m4s','audio/iso.segment':'m4s','video/quicktime':'mov','video/x-matroska':'mkv',
        'audio/x-matroska':'mka','video/x-msvideo':'avi','audio/wave':'wav','audio/x-wav':'wav','audio/x-flac':'flac',
        'audio/ogg':'ogg','video/ogg':'ogv','application/ogg':'ogg','image/jpeg':'jpg','image/svg+xml':'svg',
        'image/x-icon':'ico','image/vnd.microsoft.icon':'ico','image/tiff':'tiff','application/pdf':'pdf',
        'application/msword':'doc','application/vnd.ms-excel':'xls','application/vnd.ms-powerpoint':'ppt',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'xlsx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation':'pptx',
        'text/plain':'txt','text/html':'html','text/csv':'csv','application/x-7z-compressed':'7z','application/x-rar-compressed':'rar',
        'application/x-zip-compressed':'zip','application/vnd.rar':'rar','application/epub+zip':'epub',
        'application/vnd.oasis.opendocument.text':'odt','application/vnd.oasis.opendocument.spreadsheet':'ods',
        'application/vnd.oasis.opendocument.presentation':'odp'
    };
    function extension(record) {
        const mime = (record.type || '').split(';')[0].toLowerCase().trim();
        let suffix = String(record.ext || '').toLowerCase();
        if (!/^[a-z\d]{1,8}$/.test(suffix)) {
            const tail = /\.([a-z\d]{1,8})$/i;
            suffix = tail.exec(record.name || '')?.[1].toLowerCase() || '';
            if (!suffix && record.url) {
                try { suffix = tail.exec(new URL(record.url).pathname)?.[1].toLowerCase() || ''; } catch { /* no source address */ }
            }
        }
        if (['audio/mp4','video/mp4'].includes(mime) && ['m4a','m4s','m4v'].includes(suffix)) return suffix;
        if (mime === 'audio/ogg' && suffix === 'opus') return suffix;
        if (mimeExtensions[mime]) return mimeExtensions[mime];
        if (/^(audio|video|image|application)\/[a-z\d]{1,8}$/.test(mime) &&
            !['application/binary','application/download','application/unknown'].includes(mime)) return mime.split('/')[1];
        return /^(php|ashx|aspx|cgi|do|unknown|binary|download)$/.test(suffix) ? '' : suffix;
    }
    function segmentSample(url,type,fetched) {
        const mime = (type || '').split(';')[0].trim().toLowerCase();
        const path = url.split(/[?#]/,1)[0];
        if (/^(?:text\/|image\/)|(?:json|javascript|xml|mpegurl)$/.test(mime) ||
            /\.(?:html?|json|m?js|css|svg|png|jpe?g|gif|webp|avif|ico|m3u8|mpd)$/i.test(path)) return false;
        return /\.(?:m4s|ts|m2ts|cmfv|cmfa)$/i.test(path) || fetched &&
            (/\.(?:mp4|m4a|aac|webm)$/i.test(path) || /^(?:video\/|audio\/|application\/octet-stream$)/.test(mime));
    }
    // Both the background and a newly opened sidebar retain just the most recent response observations.
    function rememberTransfer(cache,sample) {
        const key = JSON.stringify([sample.documentId || sample.frameId,sample.url,sample.offset]);
        if (cache.get(key)?.getTime > sample.getTime) return;
        cache.delete(key);
        cache.set(key,sample);
        if (cache.size > 128) cache.delete(cache.keys().next().value);
    }

    const probeLimit = 16 * 1024;
    function mp4Codec(bytes) {
        const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.length);
        const path = ['moov','trak','mdia','minf','stbl','stsd'];
        function boxes(start,end,depth,count = Infinity) {
            const available = Math.min(end,bytes.length);
            for (let pos = start; count > 0 && pos + 8 <= available; count--) {
                let size = view.getUint32(pos), payload = pos + 8;
                const type = String.fromCharCode(...bytes.subarray(pos+4,payload));
                if (size === 1) {
                    if (payload + 8 > available) break;
                    size = Number(view.getBigUint64(payload)); payload += 8;
                    if (!Number.isSafeInteger(size)) break;
                }
                const next = size === 0 ? end : pos + size;
                if (next < payload || next > end) break;
                if (depth === path.length) {
                    if (/^(avc[13]|hvc1|hev1|av01|vp09|vp08|mp4v)$/.test(type)) return video[type];
                } else if (type === path[depth]) {
                    let entries;
                    if (type === 'stsd') {
                        if (payload + 8 > Math.min(available,next)) break;
                        entries = view.getUint32(payload+4); payload += 8;
                    }
                    const found = boxes(payload,next,depth+1,entries);
                    if (found) return found;
                }
                pos = next;
            }
            return '';
        }
        // An enclosing box may extend beyond the cached prefix while its sample entry header is already present.
        return boxes(0,Infinity,0);
    }
    function tsCodec(bytes) {
        const programs = new Map(), partial = new Map(), counters = new Map();
        const types = {0x1b:'H.264',0x24:'H.265',0x02:'MPEG-2',0x10:'MPEG-4'};
        function table(pid,section,end) {
            if (end < 8 || !(section[5] & 1)) return;
            if (pid === 0 && section[0] === 0) {
                for (let i = 8; i + 4 <= end; i += 4) {
                    const program = section[i] * 256 + section[i+1];
                    if (program) programs.set(((section[i+2] & 31) << 8) | section[i+3],program);
                }
            } else if (section[0] === 2 && end >= 12 && programs.get(pid) === section[3] * 256 + section[4]) {
                let i = 12 + ((section[10] & 15) << 8) + section[11];
                while (i + 5 <= end) {
                    const type = section[i];
                    i += 5 + ((section[i+3] & 15) << 8) + section[i+4];
                    if (i > end) break;
                    if (types[type]) return types[type];
                }
            }
        }
        // PSI sections can span packets. A payload-unit-start pointer can finish the previous section first.
        function feed(pid,pos,end,canStart) {
            while (pos < end) {
                let part = partial.get(pid);
                if (!part) {
                    if (!canStart || bytes[pos] === 0xff) break;
                    part = {data:new Uint8Array(1024),used:0,needed:3};
                    partial.set(pid,part);
                }
                const n = Math.min(part.needed-part.used,end-pos);
                part.data.set(bytes.subarray(pos,pos+n),part.used);
                part.used += n; pos += n;
                if (part.used < part.needed) break;
                if (part.needed === 3) {
                    part.needed = 3 + ((part.data[1] & 15) << 8) + part.data[2];
                    if (part.needed < 12 || part.needed > 1024) { partial.delete(pid); break; }
                } else {
                    partial.delete(pid);
                    const found = table(pid,part.data,part.used-4); // Exclude the CRC.
                    if (found) return found;
                }
            }
        }
        let first = 0;
        while (first < 188 && !(bytes[first] === 0x47 && bytes[first+188] === 0x47)) first++;
        if (first === 188) return '';
        for (let pos = first; pos + 188 <= bytes.length && bytes[pos] === 0x47; pos += 188) {
            const pid = ((bytes[pos+1] & 31) << 8) | bytes[pos+2], flags = bytes[pos+3];
            if ((pid !== 0 && !programs.has(pid)) || (bytes[pos+1] & 0x80) || (flags & 0xc0) || !(flags & 0x10)) continue;
            const cc = flags & 15, prior = counters.get(pid);
            if (prior === cc) continue;
            if (cc !== ((prior+1) & 15)) partial.delete(pid);
            counters.set(pid,cc);
            let offset = pos + 4;
            if (flags & 0x20) offset += 1 + bytes[offset];
            const end = pos + 188;
            if (offset >= end) continue;
            const start = !!(bytes[pos+1] & 0x40);
            if (start) {
                const pointer = bytes[offset++];
                if (offset + pointer > end) { partial.delete(pid); continue; }
                const found = feed(pid,offset,offset+pointer,false);
                if (found) return found;
                offset += pointer; partial.delete(pid);
            }
            const found = feed(pid,offset,end,start);
            if (found) return found;
        }
        return '';
    }
    function probeCodec(data) {
        const bytes = data.subarray(0,probeLimit);
        return mp4Codec(bytes) || tsCodec(bytes);
    }
    return {codec,extension,segmentSample,rememberTransfer,probeLimit,probeCodec};
})();
