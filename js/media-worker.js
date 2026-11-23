'use strict';

// Each conversion has a fresh worker and a private filesystem. FFmpeg sees seekable
// files, but only the requested packets cross its 32-bit linear memory.
importScripts('../lib/ffmpeg/ffmpeg-core.js');
importScripts('media-formats.js');

function mountDiskFile(fs, path, handle, writable) {
    fs.writeFile(path, new Uint8Array());
    const node = fs.lookupPath(path).node;
    const original = node.node_ops;
    node.node_ops = {
        ...original,
        getattr(n) {
            const stat = original.getattr(n);
            stat.size = handle.getSize();
            stat.blocks = Math.ceil(stat.size / 4096);
            return stat;
        },
        setattr(n, attrs) {
            const {size, ...rest} = attrs;
            if (size !== undefined) {
                if (!writable) throw new fs.ErrnoError(2);
                handle.truncate(size);
            }
            original.setattr(n,rest);
        }
    };
    node.stream_ops = {
        read(stream, buffer, offset, length, position) {
            return handle.read(buffer.subarray(offset, offset + length), {at:position});
        },
        write(stream, buffer, offset, length, position) {
            if (!writable) throw new fs.ErrnoError(2);
            return handle.write(buffer.subarray(offset, offset + length), {at:position});
        },
        llseek(stream, offset, whence) {
            const pos = offset + (whence === 2 ? handle.getSize() : whence === 1 ? stream.position : 0);
            if (!Number.isSafeInteger(pos) || pos < 0) throw new fs.ErrnoError(28);
            return pos;
        }
    };
}

function inspectOutput(core,expected,mode) {
    let height = 0, fps = 0, duration = 0, audio = false, video = false, videoCodec = '', audioCodec = '';
    core.setLogger(({message}) => {
        const time = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(message);
        if (time) duration = Number(time[1])*3600 + Number(time[2])*60 + Number(time[3]);
        if (/Stream #.*Audio:/.test(message)) {
            audio = true;
            audioCodec = SnagFormat.codec(/Audio:\s*([\w-]+)/.exec(message)?.[1],'audio');
        }
        if (!/Stream #.*Video:/.test(message) || message.includes('attached pic')) return;
        video = true;
        videoCodec = SnagFormat.codec(/Video:\s*([\w-]+)/.exec(message)?.[1],'video');
        const size = /[, ](\d{2,5})x(\d{2,5})(?:[ ,\[]|$)/.exec(message);
        if (size) height = Math.min(+size[1],+size[2]);
        fps = Number(/([\d.]+) fps\b/.exec(message)?.[1]);
    });
    core.reset();
    core.exec('-hide_banner','-protocol_whitelist','file','-i','/output');
    const codec = video ? videoCodec : audioCodec;
    if (!expected) return codec;
    if (mode !== 'video' && !audio) throw new Error('mediaNoAudio');
    if (mode !== 'audio' && (height !== expected.height || expected.fps && !(Math.abs(fps-expected.fps) <= 0.6))) throw new Error('mediaSegmentQuality');
    if (mode !== 'audio' && expected.codec && videoCodec !== expected.codec) throw new Error('mediaCodecUnavailable');
    if (!duration || Math.abs(duration-expected.duration) > Math.max(0.25,Math.min(1,expected.duration*0.003))) throw new Error('mediaSegmentIncomplete');
    return codec;
}

async function convert({inputs, output, mode, paired, expected}) {
    const handles = [];
    try {
        const wasm = new URL('../lib/ffmpeg/ffmpeg-core.wasm', location.href).href;
        const core = await createFFmpegCore({mainScriptUrlOrBlob:'#' + btoa(JSON.stringify({wasmURL:wasm}))});
        for (const [i,file] of [...inputs,output].entries()) {
            let handle;
            if (file instanceof Blob) {
                const reader = new FileReaderSync();
                handle = {getSize:() => file.size,close:() => {},
                    read(target,{at}) {
                        const chunk = new Uint8Array(reader.readAsArrayBuffer(file.slice(at,at + target.length)));
                        target.set(chunk);
                        return chunk.length;
                    }};
            } else handle = await file.createSyncAccessHandle();
            handles.push(handle);
            mountDiskFile(core.FS,i < inputs.length ? '/input' + i : '/output',handle,i === inputs.length);
        }
        const flags = ['-hide_banner','-nostats'];
        const args = [];
        for (let i = 0; i < inputs.length; i++) args.push('-protocol_whitelist','file','-i','/input' + i);
        let codec = '', missing = false, hasVideo = false;
        core.setLogger(({message}) => {
            if (!codec) codec = /\bAudio:\s*([\w]+)/.exec(message)?.[1] || '';
            if (/\bVideo:/.test(message) && !message.includes('attached pic')) hasVideo = true;
            if (/matches no streams|does not contain any stream/i.test(message)) missing = true;
        });
        let ext = 'mp4', format = 'mp4';
        let audioFirst = false;
        if (paired) {
            core.exec(...flags,'-protocol_whitelist','file','-i','/input0');
            audioFirst = !hasVideo;
            core.reset();
        }
        if (mode === 'audio') {
            core.exec(...flags, ...args);
            core.reset();
            const audioTypes = {aac:['m4a','ipod'],alac:['m4a','ipod'],mp3:['mp3','mp3'],flac:['flac','flac'],opus:['opus','opus'],vorbis:['ogg','ogg']};
            [ext,format] = audioTypes[codec] || ['mka','matroska'];
        }
        const map = mode === 'audio' ? ['-map','0:a:0'] : mode === 'video' ? ['-map','0:V:0'] :
            paired ? ['-map', (audioFirst ? '1' : '0') + ':V:0','-map',(audioFirst ? '0' : '1') + ':a:0'] :
            ['-map','0:V:0?','-map','0:a?'];
        const exec = type => core.exec(...flags, ...args, ...map, '-c','copy','-map_metadata','-1','-f',type,'/output');
        missing = false;
        if (exec(format) !== 0) {
            if (missing) throw new Error(mode === 'video' ? 'mediaNoVideo' : 'mediaNoAudio');
            core.reset();
            ext = mode === 'audio' ? 'mka' : 'mkv';
            if (exec('matroska') !== 0) throw new Error('mediaBadFile');
        }
        const last = handles[handles.length-1];
        last.flush();
        if (!last.getSize()) throw new Error('mediaBadFile');
        return {ext,codec:inspectOutput(core,expected,mode)};
    } finally {
        for (const handle of handles) handle.close();
    }
}
self.onmessage = async event => {
    try { self.postMessage(await convert(event.data)); }
    catch (error) { self.postMessage({error:error.name === 'QuotaExceededError' ? 'mediaSpace' : error.message}); }
};
