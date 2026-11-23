'use strict';

// Older parsers can deliver the video and audio in separate messages (and in
// either order). Keep only local file references while waiting for the pair.
const MediaLegacy = (() => {
    const batches = new Map();
    const actionModes = {merge:'full',catchMerge:'full',transcode:'full',onlyAudio:'audio',videoOnly:'video',addFile:'full'};
    const toolChannel = new BroadcastChannel('snag-media-tool-v1');
    function receipt(tabId,index,state) {
        if (tabId > 0) chrome.runtime.sendMessage({Message:'snagFFmpegResult',tabId,index,state}).catch(() => {});
    }
    async function input(item) {
        let blob = item.data;
        if (item.recording) return {recording:item.recording,size:item.recording.size,kind:item.type,ext:'mp4',remux:true};
        if (typeof blob === 'string' && blob.startsWith('blob:' + location.origin + '/')) {
            const url = blob;
            try {
                const response = await fetch(url);
                if (!response.ok) throw new Error('mediaSourceFailed');
                blob = await response.blob();
            } finally { URL.revokeObjectURL(url); }
        }
        if (!(blob instanceof Blob) || !blob.size) throw new Error('mediaBadFile');
        return {local:blob,size:blob.size,kind:item.type || blob.type.split('/')[0],ext:'mp4',remux:true};
    }
    async function receive(data) {
        if (data.action === 'openFFmpeg') return;
        const mode = actionModes[data.action];
        const files = data.files || [data];
        const quantity = Number(data.quantity || files.length);
        if (!mode || !Number.isInteger(quantity) || quantity < 1 || quantity > 2 || !files.length) throw new Error('mediaBadFile');
        const key = String(data.taskId ?? crypto.randomUUID());
        let batch = batches.get(key);
        if (!batch) {
            batch = {parts:new Map(),senders:new Set(),expires:Date.now()+retention};
            batches.set(key,batch);
        }
        for (const item of files) {
            const file = await input(item);
            const identity = (data.tabId || '') + ':' + (item.index ?? data.index ?? item.name ?? file.kind ?? batch.parts.size);
            batch.parts.set(identity,file);
            batch.senders.add(data.tabId);
            receipt(data.tabId,item.index ?? data.index,'ok');
        }
        if (batch.parts.size < quantity) return;
        batches.delete(key);
        const inputs = [...batch.parts.values()];
        const title = data.output || data.title || files[0].name || 'media';
        const req = {key:'local-' + key,tabId:data.tabId,windowId:data.windowId,title,mode,files:inputs,saveAs:!!data.saveAs};
        const task = await command({op:'start',request:req});
        const job = jobs.get(task.id);
        if (job) job.legacyTabs = batch.senders;
        return task;
    }
    toolChannel.onmessage = async ({data}) => {
        if (!data || data.op !== 'localInput') return;
        try {
            await initialized;
            const value = await receive(data.request);
            toolChannel.postMessage({reply:data.id,value});
        } catch (error) { toolChannel.postMessage({reply:data.id,error:error.message}); }
    };
    setInterval(() => { for (const [key,batch] of batches) if (batch.expires <= Date.now()) batches.delete(key); },15000);
    return {receive,receipt};
})();
