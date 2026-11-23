// Use the same names for player metadata, manifest variants and finished files.
globalThis.SnagFormat = (() => {
    const video = {avc1:'H.264',avc3:'H.264',h264:'H.264',hev1:'H.265',hvc1:'H.265',hevc:'H.265',
        av01:'AV1',av1:'AV1',vp09:'VP9',vp9:'VP9',vp08:'VP8',vp8:'VP8',theora:'Theora',mpeg4:'MPEG-4'};
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
    return {codec,extension};
})();
