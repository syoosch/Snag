'use strict';

let mediaJobs = [];
async function mediaCommand(op,params = {}) {
    const reply = await chrome.runtime.sendMessage({mediaTarget:'bridge',op,...params});
    if (!reply?.ok) throw new Error(i18n[reply?.error] || i18n.mediaUnavailable);
    return reply.value;
}
function receiveJobs(jobs) {
    mediaJobs = jobs || [];
    scheduleRender();
}
chrome.runtime.onMessage.addListener(msg => {
    if (msg.mediaTarget === 'sidebar') receiveJobs(msg.jobs);
});
function mediaFile(track,group,page) {
    const record = downloadData(track);
    const headers = {...record.requestHeaders};
    if (record.fromPage && group.info && SnagBili.route(page?.url)?.key === group.info.route &&
        (track.episodeCid === group.info.cid || SnagBili.representation(record.url)?.cid === group.info.cid)) headers.referer = new URL(page.url).origin + '/';
    const ext = SnagFormat.extension(record);
    const identity = group.biliId && SnagBili.representation(record.url)?.identity;
    const backups = identity ? [...new Set([...(group.point?.sources || []),...videoSources,...publicTracks]
        .filter(s => s.url !== record.url && SnagBili.representation(s.url)?.identity === identity).map(s => s.url))] : [];
    const playlist = isM3U8(record) ? 'hls' : isMPD(record) ? 'dash' : null;
    const point = group.point, frame = playlist && frames.get(point?.frameId ?? record.frameId);
    const nativePlaylist = frame && point?.kind === 'video' && point.loaded && !point.protectedMedia && !point.inactiveSlot &&
        !SnagBili.route(frame.url) && !SnagPlayer.youtubeId(frame.url) && resourceAddress(point.current) === resourceAddress(record.url);
    const linked = frame && (track.streamPlaylist || nativePlaylist) && sameStreamDocument(frame,record);
    const observedUrls = linked ? streamDownloadUrls(frame,recordsWithPageFiles().values()) : undefined;
    const playbackHeight = linked && playlist === 'hls' && point?.loaded ? Math.min(point.width,point.height) || undefined : undefined;
    return {url:record.url,originalUrl:record.url,playlist,observedUrls,playbackHeight,quality:track.streamQuality,
        backups,kind:track.kind,headers,size:playlist ? undefined : track.size || record.size,ext};
}
async function startMedia(group,mode = 'full') {
    if (tierRequests.get(group.key)?.pending) return;
    const track = choice(group), id = tabId;
    if (track.segments) {
        return mediaCommand('start',{request:{tabId:id,windowId,key:track.key,title:title(group,track.record),mode,
            youtube:track.segments,files:[],saveAs:G.saveAs}});
    }
    const split = group.kind === 'video' && (track.separate || group.biliId && !track.episodeCid);
    const sound = split && (group.tracks.find(t => t.kind === 'audio' && t.defaultAudio) || group.tracks.find(t => t.kind === 'audio'));
    if (split && !sound && mode !== 'video') {
        await rescan();
        if (id !== tabId) return;
        render();
        const updated = groups.find(g => g.key === group.key);
        if (updated?.tracks.some(t => t.kind === 'audio')) return startMedia(updated,mode);
        say(i18n.mediaNoAudio); return;
    }
    const pair = group.kind === 'video' && !!sound && sound !== track;
    const tracks = pair && mode === 'audio' ? [sound] : pair && mode === 'full' ? [track,sound] : [track];
    const page = group.biliId ? await chrome.tabs.get(id) : null;
    const files = tracks.map(t => mediaFile(t,group,page));
    const data = downloadData(track);
    const name = group.biliId || group.point?.title ? title(group,track.record) : data.downFileName || title(group,track.record);
    await mediaCommand('start',{request:{tabId:id,windowId,key:track.key,title:name,mode,files,saveAs:G.saveAs}});
}
function activeJob(job) { return ['downloading','processing','saving'].includes(job.state); }
function mainDownloadMode(group,track) {
    return group.kind === 'audio' && (group.biliId || track.separate) ? 'audio' : 'full';
}
function progressLabel(job) {
    if (job.state === 'processing') return job.mode === 'full' ? i18n.mediaMerging : i18n.mediaExtracting;
    if (job.state === 'saving') return i18n.mediaSaving;
    if (job.state === 'done') return i18n.downloaded;
    if (job.state === 'failed') {
        const detail = job.sourceFailure;
        if (!detail?.stage) return i18n[job.error] || i18n.mediaSourceFailed;
        return [i18n[detail.stage],detail.status && 'HTTP ' + detail.status,detail.reason && i18n[detail.reason]].filter(Boolean).join(' · ');
    }
    if (job.segmentProgress != null) return i18n.mediaSegments + ' ' + job.segmentProgress + '%';
    if (job.totalParts) return i18n('mediaPartProgress',[String(job.completedParts),String(job.totalParts),
        String(Math.floor(100*job.completedParts/job.totalParts))]);
    const amount = job.total ? Math.min(99,Math.floor(job.bytes / job.total * 100)) + '%' : bytes(job.bytes);
    return [i18n.sideDownloading,amount].filter(Boolean).join(' ');
}
function jobActions(box,job,showProgress = true,showFile = false) {
    box.replaceChildren();
    if (showProgress) {
        const parts = [progressLabel(job)];
        if (showFile && job.state === 'done' && job.result) parts.push(job.result.ext?.toUpperCase(),bytes(job.result.size));
        box.append(document.createTextNode(parts.filter(Boolean).join(' · ') + ' '));
    }
    function action(label,run) {
        const button = el('button',label,'text-btn');
        button.onclick = () => Promise.resolve(run()).catch(error => say(error.message));
        box.append(button);
    }
    if (job.state === 'done') action(i18n.sideShowFile,() => chrome.downloads.show(job.fileId));
    else if (job.state === 'failed') {
        if (job.bytes) {
            const until = new Date(job.expires).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
            box.append(document.createTextNode(i18n('mediaRetention',[bytes(job.bytes),until]) + ' '));
        }
        if (job.canRetry) action(i18n.retryDownload,() => mediaCommand('retry',{id:job.id}));
        action(job.bytes ? i18n.mediaClear : i18n.close,() => mediaCommand('clear',{id:job.id}));
    } else action(i18n.mediaCancel,() => mediaCommand('cancel',{id:job.id}));
}
function cardJob(track) {
    const matching = mediaJobs.filter(j => j.tabId === tabId && j.key === track.key);
    return matching.findLast(activeJob) || matching.at(-1);
}
function renderOtherJobs() {
    const panel = $id('media-tasks');
    const shown = new Set();
    for (const row of rows.values()) {
        if (row.group.playerOnly) continue;
        const job = cardJob(choice(row.group));
        if (job) shown.add(job.id);
    }
    const others = mediaJobs.filter(j => !shown.has(j.id) && (j.windowId == null || j.windowId === windowId));
    const signature = JSON.stringify(others);
    if (panel.dataset.signature === signature) return;
    panel.dataset.signature = signature; panel.hidden = !others.length;
    const list = panel.querySelector('div');
    list.replaceChildren();
    for (const job of others) {
        const entry = el('div',null,'task-item');
        entry.append(el('strong',job.title));
        const actions = el('div'); entry.append(actions); jobActions(actions,job,true,true);
        list.append(entry);
    }
}
function attachDownloadModes(row) {
    const menu = row.node.querySelector('.download-modes');
    const toggle = menu.querySelector('summary');
    toggle.title = i18n.mediaChoose;
    toggle.setAttribute('aria-label',i18n.mediaChoose);
    for (const entry of menu.querySelectorAll('button')) {
        const mode = entry.dataset.mode;
        entry.textContent = mode === 'audio' ? i18n.mediaAudioOnly : i18n.mediaVideoOnly;
        entry.onclick = () => { menu.open = false; startMedia(row.group,mode).catch(error => say(error.message)); };
    }
    menu.addEventListener('keydown',e => {
        if (e.key === 'Escape') { menu.open = false; toggle.focus(); }
    });
    menu.addEventListener('focusout',e => { if (!menu.contains(e.relatedTarget)) menu.open = false; });
}
document.addEventListener('click',e => {
    for (const menu of document.querySelectorAll('.download-modes[open]')) if (!menu.contains(e.target)) menu.open = false;
});
