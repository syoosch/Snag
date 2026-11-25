'use strict';

const retention = 10 * 60 * 1000;
const jobs = new Map(), garbage = new Map(), saves = new Map();
const retryable = new Set(['mediaSourceFailed','mediaSaveFailed','mediaBadFile','mediaSegmentIncomplete','mediaSegmentUnavailable','mediaSegmentQuality']);
const jobName = /^job-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/;
let root, recentTimer;
const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
function sourceError(reason,status,retryAfter) {
    return Object.assign(new Error('mediaSourceFailed'),{sourceFailure:{reason,status},retryAfter});
}
function transportError(error) {
    if (error.name === 'TypeError' || error.name === 'NetworkError') throw Object.assign(sourceError(),{networkFailure:true});
    throw error;
}
async function withNetworkTimeout(signal,stage,fn) {
    signal.throwIfAborted();
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    let timer;
    const activity = () => {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(sourceError('mediaRequestTimeout')),45000);
    };
    signal.addEventListener('abort',cancel,{once:true});
    activity();
    try { return await fn(controller.signal,activity); }
    catch (error) {
        signal.throwIfAborted();
        const failure = controller.signal.aborted ? controller.signal.reason : error;
        if (failure.message === 'mediaSourceFailed' || ['TypeError','NetworkError'].includes(failure.name)) {
            const detail = sourceError(failure.sourceFailure?.reason,failure.sourceFailure?.status,failure.retryAfter);
            detail.sourceFailure.stage = stage;
            detail.networkFailure = failure.networkFailure;
            throw detail;
        }
        throw failure;
    }
    finally { clearTimeout(timer); signal.removeEventListener('abort',cancel); }
}
async function bridge(op,params = {}) {
    const reply = await chrome.runtime.sendMessage({mediaTarget:'bridge',op,...params});
    if (!reply?.ok) throw new Error(reply?.error || 'mediaUnavailable');
    return reply.value;
}
async function remove(dir,name,recursive = false) {
    for (let i = 0; ; i++) {
        try { await dir.removeEntry(name,{recursive}); return; }
        catch (error) {
            if (error.name === 'NotFoundError') return;
            if (i >= 4) throw error;
            await wait(30 * (i + 1));
        }
    }
}
async function discard(job) {
    for (const file of job.request?.files || []) {
        if (file.recording) bridge('recordingRelease',{source:file.recording}).catch(() => {});
    }
    if (job.directory) {
        try { await remove(root,job.id,true); }
        catch { garbage.get(root).add(job.id); }
        job.directory = null;
    }
    job.ready = []; job.counts = []; job.partCounts = []; job.totalParts = 0;
}
function view(job) {
    const {id,key,tabId,windowId,title,mode,state,error,sourceFailure,expires,fileId,total} = job;
    return {id,key,tabId,windowId,title,mode,state,error,sourceFailure,expires,fileId,total,result:job.result,segmentProgress:job.segmentProgress,
        totalParts:job.totalParts,completedParts:job.partCounts?.reduce((sum,n) => sum+n,0),canRetry:state === 'failed' && !!job.request,
        bytes:job.counts.reduce((a,b) => a+b,0)};
}
function notify(immediate = false) {
    const publish = () => {
        recentTimer = null;
        chrome.runtime.sendMessage({mediaTarget:'sidebar',jobs:[...jobs.values()].map(view)}).catch(() => {});
    };
    if (immediate) { clearTimeout(recentTimer); publish(); }
    else if (!recentTimer) recentTimer = setTimeout(publish,200);
}
async function reap() {
    const now = Date.now();
    for (const [id,job] of jobs) {
        if (job.expires && job.expires <= now && !job.task) {
            jobs.delete(id); await discard(job); notify(true);
        }
    }
    for (const [dir,names] of garbage) {
        for (const name of names) {
            try { await remove(dir,name,true); names.delete(name); } catch { /* retry on the next pass */ }
        }
    }
}
const initialized = (async () => {
    await bridge('admit');
    const storage = await navigator.storage.getDirectory();
    root = await storage.getDirectoryHandle('snag-media-v1',{create:true});
    const previous = await storage.getDirectoryHandle('framepick-media-v1').catch(error => {
        if (error.name !== 'NotFoundError' && error.name !== 'TypeMismatchError') throw error;
    });
    for (const dir of [root,previous].filter(Boolean)) {
        const names = new Set();
        garbage.set(dir,names);
        for await (const name of dir.keys()) if (jobName.test(name)) names.add(name);
    }
    await reap();
    await bridge('clearRules');
    setInterval(() => reap().catch(console.warn),15000);
})();
initialized.catch(console.warn);

async function fetchPart(file,part,signal) {
    const url = MediaSources.address(part.url);
    const sameOrigin = new URL(url).origin === new URL(file.originalUrl || file.url).origin;
    const headers = new Headers();
    const special = {};
    for (const [name,val] of Object.entries(file.headers || {})) {
        const key = name.toLowerCase();
        if (key === 'referer' || (sameOrigin && ['origin','user-agent'].includes(key))) special[key] = val;
        if (sameOrigin && key === 'authorization') headers.set(name,val);
    }
    const r = part.range;
    if (r) headers.set('Range','bytes=' + r.offset + '-' + (r.offset+r.length-1));
    // Header rules only live until response headers arrive. Two requests for the
    // same signed URL may have different referrers and must never share a rule.
    return navigator.locks.request('snag-source-' + url,{signal},async () => {
        let rule;
        try {
            if (Object.keys(special).length) rule = await bridge('headers',{url,headers:special});
            signal.throwIfAborted();
            const response = await fetch(url,{headers,credentials:'include',cache:'no-store',signal}).catch(transportError);
            if (!response.ok) {
                await response.body?.cancel().catch(() => {});
                throw sourceError(undefined,response.status,response.headers.get('Retry-After'));
            }
            if (!response.body) throw sourceError('mediaResponseIncomplete');
            return response;
        } finally { if (rule) await bridge('release',{id:rule}); }
    });
}
async function readList(file,signal,activity) {
    const response = await fetchPart(file,{url:file.url},signal);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let bytes = 0, text = '';
    try {
        for (;;) {
            const {value,done} = await reader.read();
            if (done) break;
            activity();
            bytes += value.length;
            if (bytes > 16 * 1024 * 1024) throw new Error('mediaBadFile');
            text += decoder.decode(value,{stream:true});
        }
        text += decoder.decode();
        if (/^\s*(?:<!doctype\s+html\b|<html\b|[\[{])/i.test(text)) throw sourceError('mediaUnexpectedResponse');
        return {text,url:response.url};
    } finally { await reader.cancel().catch(() => {}); }
}
async function checkSpace(job) {
    const {quota,usage} = await navigator.storage.estimate();
    if (!quota) return;
    const remaining = job.sizes.reduce((n,size,i) => n + (job.plan.tracks[i].local ? 0 : Math.max(0,size-(job.counts[i] || 0))),0);
    const output = job.plan.tracks.length > 1 && !job.plan.copy ? job.total : 0;
    if (remaining + output > quota - usage) throw new Error('mediaSpace');
}
async function appendPart(job,index,track,part,out,signal,activity) {
    // Some CDNs cap the first GET. Continue from Content-Range instead of saving
    // a valid-looking prefix of the movie.
    let range = part.range, remainder = false;
    do {
        const response = await fetchPart(track,{...part,range},signal);
        const reader = response.body.getReader();
        try {
            if (['video','audio'].includes(track.kind) && /^(text\/html|application\/json)\b/i.test(response.headers.get('content-type') || '')) throw sourceError('mediaUnexpectedResponse');
            const cr = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(response.headers.get('content-range') || '');
            if (response.status === 206 && (!cr || Number(cr[1]) !== (range?.offset || 0))) throw sourceError('mediaResponseIncomplete');
            const size = cr && cr[3] !== '*' ? +cr[3] : Number(response.headers.get('content-length')) || 0;
            if (!part.range && track.parts.length === 1 && size && size !== job.sizes[index]) {
                job.sizes[index] = size;
                job.total = job.sizes.every(n => n > 0) ? job.sizes.reduce((a,b) => a+b,0) : 0;
                await checkSpace(job);
            }
            let skip = response.status === 200 && range ? range.offset : 0;
            let left = range?.length ?? Infinity;
            let written = 0;
            for (;;) {
                const {value,done} = await reader.read().catch(transportError);
                if (done) break;
                activity();
                if (skip >= value.length) { skip -= value.length; continue; }
                const block = value.subarray(skip, Math.min(value.length, skip + left));
                skip = 0;
                await out.write(block);
                written += block.length; left -= block.length;
                if (!job.totalParts) { job.counts[index] += block.length; notify(); }
                if (left === 0) break;
            }
            if (!written || (cr && written !== Math.min(range?.length ?? Infinity,Number(cr[2])-Number(cr[1])+1))) throw sourceError('mediaResponseIncomplete');
            const next = (range?.offset || 0) + written;
            const end = part.range ? part.range.offset + part.range.length : cr && cr[3] !== '*' ? +cr[3] : next;
            remainder = next < end;
            if (remainder && response.status !== 206) throw sourceError('mediaResponseIncomplete');
            if (remainder) range = {offset:next,length:end-next};
        } finally { await reader.cancel().catch(() => {}); }
    } while (remainder);
}

// Fail a window as a unit. Join cancelled writers before their scratch directory is removed.
async function runWindow(items,signal,run) {
    signal.throwIfAborted();
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    signal.addEventListener('abort',cancel,{once:true});
    try {
        const results = await Promise.allSettled(items.map(async (item,index) => {
            try { return await run(item,index,controller.signal); }
            catch (error) { controller.abort(error); throw error; }
        }));
        controller.signal.throwIfAborted();
        return results.map(result => result.value);
    } finally { signal.removeEventListener('abort',cancel); }
}
function partRetryDelay(error,attempt) {
    if (attempt >= 2) return;
    const {status,reason} = error.sourceFailure || {};
    if (!error.networkFailure && reason !== 'mediaRequestTimeout' && ![408,429,500,502,503,504].includes(status)) return;
    let delay = 200 * 2 ** attempt;
    if (error.retryAfter) {
        const value = error.retryAfter.trim();
        const suggested = /^\d+$/.test(value) ? Number(value)*1000 : Date.parse(value)-Date.now();
        if (!Number.isNaN(suggested)) delay = Math.max(delay,suggested);
    }
    // Leave a longer server-requested wait to an explicit later retry.
    if (delay <= 2000) return delay;
}
function waitForRetry(ms,signal) {
    signal.throwIfAborted();
    return new Promise((resolve,reject) => {
        const cancel = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort',cancel); resolve(); },ms);
        signal.addEventListener('abort',cancel,{once:true});
    });
}
async function retryPart(signal,run) {
    for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        try { return await run(); }
        catch (error) {
            signal.throwIfAborted();
            const delay = partRetryDelay(error,attempt);
            if (delay == null) throw error;
            await waitForRetry(delay,signal);
        }
    }
}
function stagePart(job,index,track,part,handle,signal) {
    return retryPart(signal,async () => {
        const writer = await handle.createWritable();
        try {
            await withNetworkTimeout(signal,'mediaSegmentReadFailed',(s,touch) => appendPart(job,index,track,part,writer,s,touch));
            signal.throwIfAborted();
            await writer.close();
            return handle.getFile();
        } catch (error) {
            await writer.abort().catch(() => {});
            throw error;
        }
    });
}
async function receiveParts(job,index,track,out,signal) {
    const name = 'parts-' + index;
    const scratch = await job.directory.getDirectoryHandle(name,{create:true});
    const width = Math.max(1,Math.floor(4/job.plan.tracks.length));
    try {
        for (let start = 0; start < track.parts.length; start += width) {
            const batch = track.parts.slice(start,start+width);
            const files = await runWindow(batch,signal,async (part,slot,s) => {
                const handle = await scratch.getFileHandle(String(slot),{create:true});
                return stagePart(job,index,track,part,handle,s);
            });
            // Network completion order is independent of media order. Even an oversized part stays on disk.
            for (const [slot,file] of files.entries()) {
                for await (const chunk of file.stream()) {
                    signal.throwIfAborted();
                    await out.write(chunk);
                }
                job.counts[index] += file.size;
                job.partCounts[index]++;
                notify();
                await remove(scratch,String(slot));
            }
        }
    } finally { await remove(job.directory,name,true); }
}
async function receive(job,index,track,signal) {
    if (job.ready[index]) return;
    if (track.local) {
        job.ready[index] = track.local;
        job.counts[index] = track.local.size;
        notify(); return;
    }
    const name = 'input-' + index;
    const file = await job.directory.getFileHandle(name,{create:true});
    const out = await file.createWritable();
    job.counts[index] = 0;
    try {
        if (track.recording) {
            const source = track.recording;
            while (job.counts[index] < source.size) {
                signal.throwIfAborted();
                const chunk = await bridge('recordingRead',{source,offset:job.counts[index]});
                if (!chunk) throw new Error('mediaSourceFailed');
                const block = Uint8Array.from(atob(chunk),c => c.charCodeAt(0));
                await out.write(block); job.counts[index] += block.length; notify();
            }
        } else if (job.totalParts) await receiveParts(job,index,track,out,signal);
        else for (const part of track.parts)
            await withNetworkTimeout(signal,track.playlist ? 'mediaSegmentReadFailed' : 'mediaFileReadFailed',
                (s,touch) => appendPart(job,index,track,part,out,s,touch));
        signal.throwIfAborted();
        await out.close();
        job.ready[index] = file;
        if (track.recording) bridge('recordingRelease',{source:track.recording}).catch(() => {});
    } catch (error) {
        await out.abort().catch(() => {});
        await remove(job.directory,name);
        job.counts[index] = 0;
        if (job.partCounts) job.partCounts[index] = 0;
        throw error;
    }
}
function runCodec(message,signal) {
    signal.throwIfAborted();
    return new Promise((resolve,reject) => {
        const worker = new Worker('js/media-worker.js');
        const stop = () => { signal.removeEventListener('abort',abort); worker.terminate(); };
        const abort = () => { stop(); reject(signal.reason); };
        signal.addEventListener('abort',abort,{once:true});
        worker.onmessage = ({data}) => { stop(); if (data.error) reject(new Error(data.error)); else resolve(data); };
        worker.onerror = () => { stop(); reject(new Error('mediaBadFile')); };
        worker.postMessage(message);
    });
}
async function receiveTrack(job,index,track,signal) {
    try {
        if (track.playlist && !job.totalParts) await retryPart(signal,() => receive(job,index,track,signal));
        else await receive(job,index,track,signal);
    }
    catch (error) {
        if (signal.aborted || error.name === 'QuotaExceededError' || error.message === 'mediaSpace' ||
            track.parts?.length !== 1 || !track.backups?.length) throw error;
        // Alternate URLs all describe the same rendition. Start this input
        // afresh so bytes from separate origins are never stitched together.
        for (const url of track.backups) {
            try { await receive(job,index,{...track,parts:[{url}]},signal); return; }
            catch (next) {
                if (signal.aborted || next.name === 'QuotaExceededError' || next.message === 'mediaSpace') throw next;
                error = next;
            }
        }
        throw error;
    }
}

async function receiveYouTube(job,signal) {
    const {youtube,mode,windowId} = job.request;
    const quality = {videoId:youtube.videoId,height:youtube.height,fps:youtube.fps,duration:youtube.duration};
    const kinds = mode === 'full' ? ['video','audio'] : [mode];
    const context = {job:job.id,quality,mode,windowId};
    const outputs = new Map();
    let lastProgress = Date.now(), bestTime = 0;
    try {
        for (const [index,kind] of kinds.entries()) {
            const handle = await job.directory.getFileHandle('input-' + index,{create:true});
            outputs.set(kind,{index,handle,writer:await handle.createWritable()});
            job.counts[index] = 0;
        }
        job.segmentProgress = 0; notify(true);
        await bridge('segmentsOpen',context);
        while (true) {
            signal.throwIfAborted();
            const part = await bridge('segmentsPull',context);
            if (part.error) throw new Error(part.error);
            for (const [kind,serial] of Object.entries(part.serials || {})) {
                const out = outputs.get(kind);
                if (!out || out.serial === serial) continue;
                await out.writer.truncate(0); await out.writer.seek(0);
                out.serial = serial; job.counts[out.index] = 0;
            }
            if (part.block) {
                const out = outputs.get(part.block.kind);
                if (!out?.serial || part.block.data.length > 720000) throw new Error('mediaBadFile');
                const bytes = Uint8Array.fromBase64 ? Uint8Array.fromBase64(part.block.data) : Uint8Array.from(atob(part.block.data),c=>c.charCodeAt(0));
                await out.writer.write(bytes);
                lastProgress = Date.now();
                job.counts[out.index] += bytes.length;
            }
            if (part.frontier > bestTime) { bestTime = part.frontier; lastProgress = Date.now(); }
            if (part.frontier != null) job.segmentProgress = Math.min(99,Math.floor(100*part.frontier/quality.duration));
            notify();
            if (part.done) break;
            if (Date.now()-lastProgress > 120000) throw new Error('mediaSegmentIncomplete');
            if (!part.block) await wait(200);
        }
        for (const out of outputs.values()) {
            if (!job.counts[out.index]) throw new Error('mediaSegmentIncomplete');
            await out.writer.close(); out.writer = null;
            job.ready[out.index] = out.handle;
        }
        job.plan = {tracks:kinds.map((kind,i)=>({kind,size:job.counts[i]})),copy:false};
    } catch (error) {
        for (const out of outputs.values()) {
            await out.writer?.abort().catch(()=>{});
            await remove(job.directory,'input-' + out.index).catch(()=>{});
        }
        job.ready = []; job.counts = [];
        throw error;
    } finally {
        await bridge('segmentsClose',context).catch(()=>{});
    }
}
const manifestFallback = new Set(['mediaSourceFailed','mediaBadFile','mediaNoAudio','mediaNoVideo','mediaSegmentQuality','mediaSegmentIncomplete']);
async function youtubeManifest(request,signal) {
    function mediaUrl(value) {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || !/(^|\.)googlevideo\.com$/i.test(url.hostname))
            throw new Error('mediaBadFile');
        return url.href;
    }
    const read = file => withNetworkTimeout(signal,'mediaPlaylistReadFailed',(s,touch)=>readList({...file,url:mediaUrl(file.url)},s,touch));
    for (const source of (request.youtube.manifests || []).slice(0,2)) {
        if (!['dash','hls'].includes(source.playlist)) continue;
        try {
            const quality = request.mode === 'audio' ? {...request.youtube,codec:undefined} : request.youtube;
            const file = {playlist:source.playlist,url:mediaUrl(source.url),kind:'video',quality};
            const plan = await MediaSources.plan({...request,files:[file]},read);
            for (const track of plan.tracks) for (const part of track.parts) mediaUrl(part.url);
            return {...plan,copy:false,youtubeManifest:true};
        } catch (error) {
            signal.throwIfAborted();
            if (error.message === 'mediaProtected' || error.message === 'mediaLive') throw error;
        }
    }
}
function outputName(name,ext) {
    const suffix = /^[a-z0-9]{1,8}$/i.test(ext || '') ? ext : 'mp4';
    const input = String(name || 'media');
    const lastExtension = /\.([a-z0-9]{1,8})$/i.exec(input)?.[1];
    const replaceExtension = lastExtension && (lastExtension.toLowerCase() === suffix.toLowerCase() ||
        /^(mp4|m4[avs]|webm|mov|mkv|mp3|flac|aac|wav|ogg|ts|m3u8|mpd)$/i.test(lastExtension));
    let stem = (replaceExtension ? input.slice(0,-lastExtension.length-1) : input)
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').trim().slice(0,145).replace(/[\s.]+$/,'') || 'media';
    if (/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(stem)) stem = '_' + stem;
    return stem + '.' + suffix;
}
async function save(job,file,name,signal) {
    const bytes = file instanceof Blob ? file : await file.getFile();
    // OPFS entries have names like "output" and usually no media type. Set the
    // type on a disk-backed slice so the browser keeps the requested extension.
    const types = {mp4:'video/mp4',m4a:'audio/mp4',m4s:'video/iso.segment',mov:'video/quicktime',webm:'video/webm',
        mkv:'video/x-matroska',mka:'audio/x-matroska',mp3:'audio/mpeg',aac:'audio/aac',flac:'audio/flac',wav:'audio/wav',
        opus:'audio/ogg',ogg:'audio/ogg',ts:'video/mp2t',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',
        webp:'image/webp',avif:'image/avif',gif:'image/gif',svg:'image/svg+xml',pdf:'application/pdf'};
    const type = types[name.split('.').at(-1).toLowerCase()] || bytes.type || 'application/octet-stream';
    const url = URL.createObjectURL(bytes.slice(0,bytes.size,type));
    let id;
    try {
        signal.throwIfAborted();
        job.state = 'saving'; notify(true);
        id = await bridge('save',{url,name,saveAs:job.request.saveAs});
        job.fileId = id;
        // The terminal event may race the download() callback on tiny files.
        const changed = new Promise(resolve => saves.set(id,resolve));
        const item = await bridge('downloadState',{id});
        let event = item?.state === 'in_progress' ? null : item;
        const cancelled = () => bridge('cancelSave',{id}).catch(() => {});
        signal.addEventListener('abort',cancelled,{once:true});
        if (signal.aborted) cancelled();
        try {
            if (!event) event = await changed;
            if (event.state !== 'complete') throw new Error(event.error === 'USER_CANCELED' || signal.aborted ? 'mediaCancelled' : 'mediaSaveFailed');
        } finally { signal.removeEventListener('abort',cancelled); }
    } finally { saves.delete(id); URL.revokeObjectURL(url); }
}
async function prepareOutput(job,signal,tryManifest) {
    const req = job.request;
    job.directory ||= await root.getDirectoryHandle(job.id,{create:true});
    if (req.youtube && !job.plan) {
        if (tryManifest) job.plan = await youtubeManifest(req,signal);
        if (!job.plan && req.youtube.codec && req.mode !== 'audio') throw new Error('mediaCodecUnavailable');
        if (!job.plan) await receiveYouTube(job,signal);
    }
    job.plan ||= await MediaSources.plan(req,file => withNetworkTimeout(signal,'mediaPlaylistReadFailed',(s,touch) => readList(file,s,touch)));
    const tracks = job.plan.tracks;
    const parts = tracks.every(t => t.playlist) ? tracks.reduce((n,t) => n+t.parts.length,0) : 0;
    job.totalParts = parts > 1 ? parts : 0;
    job.partCounts = tracks.map((t,i) => job.totalParts && job.ready[i] ? t.parts.length : 0);
    job.sizes = tracks.map((t,i) => job.sizes?.[i] || Number(t.size) || 0);
    job.total = job.sizes.every(n => n > 0) ? job.sizes.reduce((a,b) => a+b,0) : 0;
    await checkSpace(job);
    if (job.totalParts) {
        for (let start = 0; start < tracks.length; start += 4)
            await runWindow(tracks.slice(start,start+4),signal,(t,i,s) => receiveTrack(job,start+i,t,s));
    }
    else {
        const transfers = await Promise.allSettled(tracks.map((t,i) => receiveTrack(job,i,t,signal)));
        const failure = transfers.find(r => r.status === 'rejected');
        if (failure) throw failure.reason;
    }
    signal.throwIfAborted();
    let output = job.ready[0], ext = tracks[0].ext || 'mp4', codec;
    if (!job.plan.copy) {
        job.state = 'processing'; notify(true);
        output = await job.directory.getFileHandle('output',{create:true});
        ({ext,codec} = await navigator.locks.request('snag-local-codec',{signal},() =>
            runCodec({inputs:job.ready,output,mode:req.mode,paired:tracks.length > 1,expected:req.youtube},signal)));
    }
    return {output,ext,codec};
}
async function processJob(job) {
    const signal = job.controller.signal, req = job.request;
    try {
        await bridge('dirty');
        signal.throwIfAborted();
        let result;
        try { result = await prepareOutput(job,signal,true); }
        catch (error) {
            signal.throwIfAborted();
            if (!job.plan?.youtubeManifest || req.youtube?.codec && req.mode !== 'audio' || !manifestFallback.has(error.message)) throw error;
            await discard(job);
            job.plan = null; job.sizes = []; job.total = 0;
            job.state = 'downloading'; notify(true);
            result = await prepareOutput(job,signal,false);
        }
        const outputFile = result.output instanceof Blob ? result.output : await result.output.getFile();
        await save(job,outputFile,outputName(req.title,result.ext),signal);
        job.result = {size:outputFile.size,ext:result.ext,codec:result.codec};
        await discard(job);
        job.state = 'done'; job.expires = Date.now() + retention;
        for (const tab of job.legacyTabs || []) MediaLegacy.receipt(tab,null,'done');
        job.request = job.plan = null;
    } catch (error) {
        job.fileId = null;
        if (signal.aborted || error.message === 'mediaCancelled' || /user.*cancel|cancel.*user/i.test(error.message)) {
            await discard(job); jobs.delete(job.id);
        } else {
            const key = error.name === 'QuotaExceededError' ? 'mediaSpace' : error.message;
            job.error = /^media[A-Z]/.test(key) ? key : 'mediaSourceFailed';
            job.sourceFailure = error.sourceFailure;
            job.state = 'failed'; job.expires = Date.now()+retention;
            if (job.directory) await remove(job.directory,'output').catch(() => {});
            if (req.youtube || req.files[0]?.playlist && !job.ready.some(Boolean)) {
                await discard(job);
                // An explicit retry can read a fresh manifest when no completed track depends on the old plan.
                job.plan = null; job.sizes = []; job.total = 0;
            }
            if (!retryable.has(job.error)) {
                await discard(job);
                job.request = job.plan = null;
            }
        }
    } finally {
        job.task = null;
        if (job.expires) job.expiryTimer = setTimeout(() => reap().catch(console.warn),Math.max(0,job.expires - Date.now()));
        notify(true);
    }
}
function launch(job) {
    clearTimeout(job.expiryTimer);
    job.state = 'downloading'; job.error = null; job.sourceFailure = null; job.expires = 0;
    job.controller = new AbortController();
    job.task = processJob(job); notify(true);
    return view(job);
}
async function command(m) {
    await initialized;
    if (m.op === 'ping') return;
    if (m.op === 'saved') { saves.get(m.id)?.(m); return; }
    if (m.op === 'legacy') return MediaLegacy.receive(m.data);
    if (m.op === 'list') return [...jobs.values()].map(view);
    if (m.op === 'start') {
        const req = m.request;
        if (!['full','audio','video'].includes(req?.mode) || !Array.isArray(req.files) || req.files.length > 2) throw new Error('mediaBadFile');
        if (req.youtube) {
            const q = req.youtube;
            if (req.files.length || !/^[\w-]{11}$/.test(q.videoId) || !Number.isInteger(q.height) || q.height < 1 || q.height > 16384 ||
                !Number.isFinite(q.fps) || q.fps < 0 || q.fps > 240 || !Number.isFinite(q.duration) || q.duration <= 0 ||
                (q.manifests != null && (!Array.isArray(q.manifests) || q.manifests.length > 2))) throw new Error('mediaBadFile');
        } else if (!req.files.length) throw new Error('mediaBadFile');
        const duplicate = [...jobs.values()].find(j => j.tabId === req.tabId && j.key === req.key && j.mode === req.mode && j.task);
        if (duplicate) return view(duplicate);
        const job = {id:'job-' + crypto.randomUUID(),key:req.key,title:req.title,tabId:req.tabId,windowId:req.windowId,mode:req.mode,request:req,ready:[],counts:[]};
        jobs.set(job.id,job); return launch(job);
    }
    const job = jobs.get(m.id);
    if (!job) return;
    if (m.op === 'retry' && job.request && job.state === 'failed' && !job.task && job.expires > Date.now()) return launch(job);
    if (m.op === 'cancel' || m.op === 'clear') {
        if (!job.task) { clearTimeout(job.expiryTimer); jobs.delete(job.id); await discard(job); notify(true); return; }
        job.controller.abort();
        await job.task;
        if (job.state !== 'done') { jobs.delete(job.id); await discard(job); notify(true); }
    }
}
chrome.runtime.onMessage.addListener((m,sender,reply) => {
    if (m.mediaTarget !== 'host' || sender.id !== chrome.runtime.id || sender.tab || sender.url?.includes('/sidebar.html')) return;
    command(m).then(value => reply({ok:true,value}),error => reply({ok:false,error:error.message}));
    return true;
});
