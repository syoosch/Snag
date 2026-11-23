"use strict";

const $id = id => document.getElementById(id);
const types = { video:"video", image:"sideImages", audio:"audio", other:"sideOther", all:"sideAll" };
const filterButtons = new Map();
const records = new Map(), frames = new Map(), rows = new Map();
const selections = new Set(), choices = new Map(), downloads = new Map(), outcomes = new Map();
const fixedTab = Number(new URLSearchParams(location.search).get("tabId")) || null;
let tabId, windowId, generation = 0, connectionId = 0, tabQuery = 0;
let filter = "video", picked = null, picking = false, multi = false, limit = 45;
let directPick = null;
let enabled = true, blocked = false, loading = true, availableTab = false;
let groups = [], visible = [], renderTimer;
let scanLabel = "sideRescan", scanTimer;
let videoRoute, currentVideo, videoLookup, lookupAbort, watchId;
let videoSources = [];
let publicTracks = [], publicTracksAt = 0, publicLookup;
document.documentElement.lang = chrome.i18n.getUILanguage();

function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
}
function say(message = "") { $id("status").textContent = message; }
function scheduleRender() {
    if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; render(); }, 50);
}
function addRecord(record) {
    if (!record || blocked || record.tabId !== tabId) return;
    const url = resourceAddress(record.url);
    if (!url) return;
    const key = (record.frameId ?? "?") + ":" + url;
    if ((records.get(key)?.getTime || 0) <= (record.getTime || 0)) records.set(key, record);
}
function choice(group) {
    const tracks = group.tracks.filter(track => track.kind === group.kind);
    const pinned = choices.get(group.key), current = resourceAddress(group.point?.current);
    const exact = tracks.find(track => track.key === pinned) || tracks.find(track => track.key === group.info?.playingKey) ||
        (current && tracks.find(track => resourceAddress(track.record.url) === current));
    if (exact) return exact;
    // The user's chosen YouTube quality can be known before the first HD frame arrives.
    if (group.point?.youtubeId && tracks.some(track => track.segments)) {
        const requested = SnagPlayer.quality(group.point.qualitySetting);
        const match = requested && tracks.find(track => fileQuality(group,track) === requested);
        if (match) return match;
    }
    const playing = group.kind === "video" && SnagPlayer.playbackQuality(group.point);
    const currentTier = group.kind === "video" && group.info?.playingQuality;
    if (currentTier) {
        const matching = tracks.find(track => track.qualityId === currentTier);
        if (matching) return matching;
    }
    if (playing) {
        const candidates = tracks.map(track => ({track,quality:fileQuality(group,track)})).filter(item => item.quality);
        const same = candidates.find(item => item.quality === playing);
        if (same) return same.track;
        const lines = parseInt(playing,10);
        const distance = item => Math.abs(parseInt(item.quality,10) - lines);
        const nearest = candidates.sort((a,b) => distance(a) - distance(b) || parseInt(a.quality,10) - parseInt(b.quality,10))[0];
        if (nearest) return nearest.track;
    }
    return tracks[0] || group.tracks[0];
}
function title(group, record) {
    if (group.point?.ad) return i18n.sideAdvertisement;
    if (group.info?.title) return group.info.title;
    if (group.point?.title) return group.point.title;
    if (group.biliId) return i18n(types[group.kind]) + " · " + group.biliId;
    return record.name || record.title || i18n(types[group.kind]);
}
function stopPicker() {
    if (!picking) return;
    picking = false;
    for (const frame of frames.values()) frame.port.postMessage({ type:"pick", active:false });
}
function selectFilter(kind) {
    stopPicker();
    filter = kind;
    picked = null;
    directPick = null;
    multi = false;
    selections.clear();
    limit = 45;
    say();
    render();
}

async function acceptPageFiles(frameId, state, files) {
    if (!Array.isArray(files) || frames.get(frameId) !== state) return false;
    const revision = ++state.fileRevision;
    const accepted = await chrome.runtime.sendMessage({ Message:"sidebarPageFiles", tabId, files });
    if (!Array.isArray(accepted) || frames.get(frameId) !== state || state.fileRevision !== revision) return false;
    state.files = accepted.map(file => ({ ...file, frameId, documentId:state.documentId }));
    scheduleRender();
    return true;
}

// Keep the live player's discoveries independent of a user's full page scan.
// A slow reply for the ad or a previous document must never replace the new program.
async function syncPlayerFiles(id, state, force = false) {
    if (!enabled || blocked) return;
    const loadedMedia = state.items.filter(item => item.loaded && !item.protectedMedia && ["video","audio"].includes(item.kind));
    const files = new Map((state.playlists || []).map(file => [file.url,file]));
    for (const item of loadedMedia) {
        if (/^https?:\/\//i.test(item.current)) files.set(item.current,{...files.get(item.current),url:item.current,kind:item.kind});
        for (const source of item.sources) {
            if (source.htmlSource) files.set(source.url,{url:source.url,kind:item.kind,type:source.type || files.get(source.url)?.type});
        }
    }
    const watch = loadedMedia.find(item => item.youtubeId && !item.ad);
    const identity = JSON.stringify([watch?.id,watch?.youtubeId,watch?.current,watch?.duration,watch?.width,watch?.height,state.watchRevision]);
    const key = JSON.stringify([identity,[...files.values()]]);
    if (!force && state.playerKey === key) return;
    const revision = state.playerRevision = (state.playerRevision || 0) + 1;
    state.playerKey = key;
    const current = () => frames.get(state.frameId) === state && state.playerRevision === revision && enabled && !blocked;
    const previous = state.watch;
    if (previous?.identity !== identity) state.watch = null;
    state.playerFiles = (state.playerFiles || []).filter(file => files.has(file.url) || state.watch?.sources.some(s => s.url === file.url));
    let sources = [], qualities = [], segments = false, manifests = [], representations = [];
    if (watch) {
        if (!force && previous?.identity === identity) ({sources,qualities,segments,manifests,representations} = previous);
        else {
            const target = state.documentId && !G.isFirefox ? {tabId:id,documentIds:[state.documentId]} : {tabId:id,frameIds:[state.frameId]};
            const [reply] = await chrome.scripting.executeScript({target,world:"MAIN",func:SnagPlayer.readYouTubeFormats,args:[watch.youtubeId]}).catch(() => []);
            if (!current()) return;
            sources = SnagPlayer.directSources(reply?.result?.files);
            qualities = [...new Set((reply?.result?.qualities || []).map(item => SnagPlayer.quality(item.label,item.height,item.fps)).filter(Boolean))];
            segments = reply?.result?.segments === true;
            manifests = reply?.result?.manifests || [];
            representations = (reply?.result?.representations || []).map(f => ({...f,
                label:SnagPlayer.quality(f.label,f.height,f.fps),codec:SnagFormat.codec(f.codecs)}));
        }
        for (const source of sources) files.set(source.url,source);
    }
    const accepted = files.size ? await chrome.runtime.sendMessage({Message:"sidebarPageFiles",tabId:id,files:[...files.values()]}) : [];
    if (!current() || !Array.isArray(accepted)) return;
    state.playerFiles = accepted.map(file => ({...file,frameId:state.frameId,documentId:state.documentId}));
    const allowed = new Set(accepted.map(file => file.url));
    state.watch = watch ? {identity,id:watch.id,videoId:watch.youtubeId,qualities,segments,manifests,representations,sources:sources.filter(source => allowed.has(source.url))} : null;
    syncManifestVariants(state,force);
    scheduleRender();
}

function syncManifestVariants(state,force) {
    const watch = state.watch;
    const key = watch?.segments && watch.manifests.length ? JSON.stringify([watch.videoId,watch.manifests]) : '';
    const prior = state.manifestCache;
    if (prior?.key === key && !(force && prior.failed)) { watch.manifestVariants = prior.variants; return; }
    prior?.controller.abort();
    state.manifestCache = null;
    if (!key) return;
    const controller = new AbortController();
    const cache = state.manifestCache = {key,controller,variants:[]};
    const timeout = setTimeout(()=>controller.abort(),7000);
    Promise.allSettled(watch.manifests.map(async source => {
        const list = await SnagPlayer.manifestVariants(source,controller.signal);
        return list.map(v=>({...v,label:SnagPlayer.quality('',v.height,v.fps),source}));
    })).then(results => {
        if (state.manifestCache !== cache || frames.get(state.frameId) !== state || !state.watch) return;
        cache.variants = results.flatMap(r=>r.status === 'fulfilled' ? r.value : []);
        cache.failed = !cache.variants.length;
        state.watch.manifestVariants = cache.variants;
        scheduleRender();
    }).finally(()=>clearTimeout(timeout));
}
function recordsWithPageFiles() {
    if (![...frames.values()].some(frame => frame.files?.length || frame.playerFiles?.length)) return records;
    const combined = new Map(records);
    const seen = new Set([...records.values()].map(record => resourceAddress(record.url)));
    for (const [frameId, frame] of frames) {
        for (const file of [...(frame.playerFiles || []),...(frame.files || [])]) {
            const url = resourceAddress(file.url);
            if (!url || seen.has(url)) continue;
            seen.add(url);
            combined.set(frameId + ":" + url, file);
        }
    }
    return combined;
}

// Read the site's public part list when navigation reused its player and the original HTML still describes the previous video.
function resolveVideo(retry = false) {
    if (!enabled || blocked || !videoRoute) return;
    if (lookupAbort || (!retry && videoLookup)) return videoLookup;
    if (currentVideo && !retry) return;
    const route = videoRoute, epoch = generation, controller = new AbortController();
    lookupAbort = controller;
    const timeout = setTimeout(() => controller.abort(),4000);
    videoLookup = (async () => {
        try {
            const readPlayer = async cid => (await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:"MAIN",
                func:SnagBili.readPlayer,args:[route,cid || null]}).catch(() => []))[0]?.result;
            let live = await readPlayer(currentVideo?.cid);
            if (epoch !== generation) return;
            if (live && SnagBili.route(live.page)?.key !== route.key) return;
            if (live && !route.bangumi && !live.observesLists) {
                // This tab may predate the extension, or may have reached /video through same-document navigation.
                await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:"MAIN",files:["js/bili-playback.js"]}).catch(() => {});
                if (epoch !== generation) return;
            }
            let info;
            if (route.bangumi) {
                const episode = live?.episode, activeCid = episode?.active?.cid;
                const activeId = episode?.active?.epId || (!activeCid && episode?.canonicalEp);
                if (route.seasonId && currentVideo && (activeCid && currentVideo.cid !== String(activeCid) ||
                    activeId && currentVideo.episodeId !== String(activeId))) {
                    currentVideo = null; videoSources = [];
                    frames.get(0)?.port.postMessage({type:"videoContext",route:route.key,info:null});
                    scheduleRender();
                }
                info = SnagBili.episodeInfo(route,live?.episode);
                if (info && !info.episodeLabel && info.cid === currentVideo?.cid && currentVideo.episodeLabel) info = currentVideo;
                if (!info || !info.episodeLabel && info.cid !== currentVideo?.cid) {
                    const api = new URL("https://api.bilibili.com/pgc/view/web/season");
                    api.searchParams.set(route.episodeId ? "ep_id" : "season_id",route.episodeId || route.seasonId);
                    const response = await fetch(api,{credentials:"omit",signal:controller.signal}).catch(() => null);
                    if (response?.ok) info = SnagBili.episodeInfo(route,live?.episode,(await response.json()).result) || info;
                }
            } else {
                const initial = SnagBili.videoInfo(route,live?.info), player = SnagBili.videoInfo(route,live?.playing);
                info = initial || currentVideo || player;
                if (!initial && player?.title && info?.cid === player.cid) info = {...info,title:player.title};
            }
            if (!route.bangumi && !info?.title) {
                const api = new URL("https://api.bilibili.com/x/web-interface/view");
                if (/^av/i.test(route.id)) api.searchParams.set("aid",route.id.slice(2));
                else api.searchParams.set("bvid",route.id);
                const response = await fetch(api,{credentials:"omit",signal:controller.signal}).catch(() => null);
                if (response?.ok) info = SnagBili.videoInfo(route,(await response.json()).data) || info;
                if (info && epoch === generation && live && live.menuCid !== info.cid) live = await readPlayer(info.cid);
            }
            if (epoch !== generation || !info || live && SnagBili.route(live.page)?.key !== route.key) return;
            if (currentVideo && currentVideo.cid !== info.cid) videoSources = [];
            const sources = SnagBili.tracks(live?.dash).filter(source => SnagBili.representation(source.url)?.cid === info.cid);
            const menuMatches = String(live?.menuCid) === info.cid;
            const playback = menuMatches && live?.playback;
            const playing = SnagBili.playingTracks(playback?.urls,info.cid,playback?.qualityId);
            const picture = playing.find(file => file.kind === "video");
            const playingKey = SnagBili.representation(picture?.url)?.identity || picture?.url;
            info = {...info,formats:menuMatches ? live.formats : [],canSwitch:!!playback?.canSwitch,playingKey,
                playingQuality:playback?.qualityId || 0};
            videoSources = SnagBili.mergeTracks(videoSources,[...sources,...playing]);
            if (sources.length) {
                const duration = Number(live.dash?.duration);
                if (!info.duration && Number.isFinite(duration) && duration > 0) info = {...info,duration};
            }
            currentVideo = info;
            if (!route.bangumi && info.title) setTabTitle(tabId,info.title);
            frames.get(0)?.port.postMessage({type:"videoContext",info,sources:[...publicTracks,...videoSources]});
            scheduleRender();
        } catch { /* A captured file remains usable when the site is offline. */ }
        finally {
            clearTimeout(timeout);
            if (lookupAbort === controller) lookupAbort = null;
        }
    })();
    return videoLookup;
}

function scanFrame(id, frameId, state) {
    if (state.scanPending) return state.scanPending;
    state.requestedScan = true;
    const target = state.documentId ? { documentId:state.documentId } : { frameId };
    const context = frameId === 0 && currentVideo ? { info:currentVideo,sources:[...publicTracks,...videoSources] } : {};
    state.scanPending = chrome.tabs.sendMessage(id, { Message:"sidebarScanPage", ...context }, target)
        .then(files => acceptPageFiles(frameId,state,files))
        .finally(() => { state.scanPending = null; });
    return state.scanPending;
}

async function recoverPublicTracks(epoch, id) {
    const info = currentVideo, state = frames.get(0);
    if (!info || videoRoute?.bangumi || !state?.ready || Date.now()-publicTracksAt < 60000) return;
    const known = sidebarGroups(recordsWithPageFiles(),frames,null,info,videoRoute,videoSources);
    if (!publicTracks.length && known.some(group => group.biliId === info.cid && group.kind === "video" &&
        group.tracks.filter(track => track.kind === "video" && track.codec).length >= 2 &&
        group.tracks.some(track => track.kind === "audio" && track.codec))) return;
    // Only metadata, with the site's anonymous playback options. The scan never fetches the media bytes.
    const controller = publicLookup = new AbortController();
    const timeout = setTimeout(() => controller.abort(),5000);
    try {
        const api = new URL("https://api.bilibili.com/x/player/playurl");
        if (/^av/i.test(videoRoute.id)) api.searchParams.set("avid",videoRoute.id.slice(2));
        else api.searchParams.set("bvid",videoRoute.id);
        api.searchParams.set("cid",info.cid);
        api.searchParams.set("fnval","16");
        const response = await fetch(api,{credentials:"omit",signal:controller.signal});
        if (!response.ok) return;
        const body = await response.json();
        if (body.code !== 0 || epoch !== generation || frames.get(0) !== state || currentVideo?.cid !== info.cid) return;
        const tracks = SnagBili.tracks(body.data?.dash).filter(source => SnagBili.representation(source.url)?.cid === info.cid);
        if (!tracks.length) return;
        publicTracks = tracks;
        publicTracksAt = Date.now();
        const duration = Number(body.data.dash.duration);
        if (!currentVideo.duration && Number.isFinite(duration) && duration > 0) currentVideo = {...currentVideo,duration};
        await scanFrame(id,0,state);
    } catch { /* The files already seen on this page stay available while offline. */ }
    finally {
        clearTimeout(timeout);
        if (publicLookup === controller) publicLookup = null;
    }
}

function scanVideo(id, state, epoch) {
    if (state.qualityScan) return state.qualityScan;
    state.qualityScan = (async () => {
        await resolveVideo(true);
        if (epoch !== generation || frames.get(0) !== state) return false;
        const ok = await scanFrame(id,0,state);
        if (ok && epoch === generation && frames.get(0) === state) await recoverPublicTracks(epoch,id);
        return ok;
    })().finally(() => { state.qualityScan = null; });
    return state.qualityScan;
}

async function autoScanVideo(id, state, epoch) {
    // Some players publish their logged-in quality list after the sidebar first connects.
    for (const delay of [0,1500,4000]) {
        if (delay) await new Promise(resolve => setTimeout(resolve,delay));
        if (epoch !== generation || frames.get(0) !== state || !enabled || blocked) return;
        await scanVideo(id,state,epoch).catch(() => false);
        const versions = new Set(videoSources.filter(track => track.kind === "video")
            .map(track => SnagBili.representation(track.url)?.identity));
        if (versions.size >= 2 && videoSources.some(track => track.kind === "audio")) return;
    }
}

async function rescan() {
    if ($id("rescan").disabled) return;
    const epoch = generation, id = tabId;
    clearTimeout(scanTimer);
    scanLabel = "sideScanning";
    say();
    render();
    try {
        const snapshot = await chrome.runtime.sendMessage({ Message:"sidebarData", tabId:id });
        if (epoch !== generation) return;
        if (!Array.isArray(snapshot?.records)) throw new Error();
        enabled = snapshot.enabled;
        blocked = snapshot.blocked;
        if (blocked || !enabled) {
            if (blocked) records.clear();
            scanLabel = "sideRescan";
            return;
        }
        snapshot.records.forEach(addRecord);
        const ready = [...frames].filter(([,state]) => state.ready);
        const results = await Promise.allSettled(ready.map(async ([frameId,state]) => {
            await syncPlayerFiles(id,state,true);
            if (epoch !== generation || frames.get(frameId) !== state) return false;
            return frameId === 0 && videoRoute ? scanVideo(id,state,epoch) : scanFrame(id,frameId,state);
        }));
        if (epoch !== generation) return;
        if (!results.some(result => result.status === "fulfilled" && result.value)) throw new Error();
        scanLabel = "sideScanned";
        if (videoRoute && ["audio","video"].includes(filter)) {
            render();
            if (!visible.some(group => group.kind === filter && !group.rawSegment && (!group.biliId || group.info || group.point))) say(i18n.sideScanNoMedia);
        }
        scanTimer = setTimeout(() => { scanLabel = "sideRescan"; scheduleRender(); }, 1800);
    } catch {
        if (epoch === generation) { scanLabel = "sideRescan"; say(i18n.sideScanFailed); }
    } finally {
        if (epoch === generation) render();
    }
}

function connectFrame(frame, epoch, canInject = true) {
    if (epoch !== generation || !availableTab || blocked || !/^https?:/.test(frame.url || "")) return;
    const existing = frames.get(frame.frameId);
    if (existing) {
        if (!frame.documentId || existing.documentId === frame.documentId) return;
        existing.port.disconnect();
    }
    const targetTab = tabId;
    const port = chrome.tabs.connect(tabId, { name:"snag-sidebar", frameId:frame.frameId });
    const state = { port, frameId:frame.frameId, items:[], serial:++connectionId, documentId:frame.documentId, ready:false, fileRevision:0 };
    frames.set(frame.frameId, state);
    port.onDisconnect.addListener(() => {
        const disconnected = chrome.runtime.lastError;
        state.manifestCache?.controller.abort();
        if (frames.get(frame.frameId) !== state) return;
        frames.delete(frame.frameId);
        if (canInject && !state.ready && disconnected) {
            // Tabs that were already open during installation have no content script yet.
            chrome.scripting.executeScript({ target:{ tabId:targetTab, frameIds:[frame.frameId] }, files:["js/sidebar-bili.js","js/media-formats.js","js/sidebar-player.js","js/sidebar-page.js"] })
                .then(() => connectFrame(frame,epoch,false)).catch(() => {});
        }
        if (picked?.serial === state.serial) { picked = null; say(i18n.sideGone); }
        if (!frames.size) stopPicker();
        scheduleRender();
    });
    port.onMessage.addListener(message => {
        if (epoch !== generation || frames.get(frame.frameId) !== state) return;
        if (message.type === "elements") {
            if (frame.frameId === 0 && videoRoute && enabled) {
                if (!currentVideo && !videoRoute.bangumi && message.info?.route === videoRoute.key) currentVideo = message.info;
                else if (currentVideo && !state.ready) port.postMessage({type:"videoContext",info:currentVideo});
                else resolveVideo();
            }
            const priorMedia = new Map(state.items.filter(item => choices.has(item.key)).map(item => [item.id,item]));
            state.items = message.list.map(item => ({ ...item, key:"element:" + state.serial + ":" + item.id,
                serial:state.serial, frameId:frame.frameId, documentId:frame.documentId }));
            for (const item of state.items) {
                const prior = priorMedia.get(item.id);
                if (!prior) continue;
                const newSource = prior.current !== item.current && !item.youtubeId && !item.sources.some(source => source.url === prior.current);
                if (prior.youtubeId !== item.youtubeId || newSource) choices.delete(item.key);
            }
            state.playlists = message.playlists;
            state.watchRevision = message.watchRevision;
            syncPlayerFiles(targetTab,state).catch(() => {});
            if (picked?.serial === state.serial && !state.items.some(item => item.key === picked.key)) {
                picked = directPick = null;
                say(i18n.sideGone);
            }
            const first = !state.ready;
            if (first && picking) port.postMessage({ type:"pick", active:true });
            state.ready = true;
            if (first && frame.frameId === 0 && videoRoute && enabled) {
                autoScanVideo(targetTab,state,epoch).catch(() => {});
            }
            scheduleRender();
        } else if (message.type === "scanFiles" && enabled && !state.requestedScan) {
            acceptPageFiles(frame.frameId, state, message.files).catch(() => {});
        } else if (message.type === "playbackList" && frame.frameId === 0 && message.route === videoRoute?.key && enabled && !blocked) {
            // Let any earlier scan finish so it cannot overwrite the list the player just received.
            Promise.resolve(state.qualityScan).then(() => {
                if (epoch === generation && frames.get(0) === state) return scanVideo(targetTab,state,epoch);
            }).catch(() => {});
        } else if (message.type === "picked" && picking) {
            const item = state.items.find(entry => entry.id === message.id);
            if (!item) return;
            stopPicker();
            picked = item;
            directPick = null;
            filter = item.kind;
            selections.clear();
            multi = false;
            say();
            render();
            $id("back").focus({ preventScroll:true });
        } else if (message.type === "cancel" && picking) {
            stopPicker(); say(); render();
        } else if (message.type === "located") {
            say(message.found ? "" : i18n.sideGone);
        }
    });
}

function setTabTitle(id,title) {
    const select = $id("scope"), option = [...select.options].find(item => item.value === String(id));
    if (!option || option.text === title) return;
    const selected = option.selected;
    option.replaceWith(new Option(title,String(id),false,selected));
    if (selected) select.value = String(id);
}
async function tabOptions() {
    const revision = ++tabQuery, epoch = generation;
    const tabs = await chrome.tabs.query({ windowId });
    if (revision !== tabQuery || epoch !== generation) return;
    const select = $id("scope");
    const options = tabs.filter(tab => tab.id === tabId || /^https?:/.test(tab.url || "") && !/#snag-segments=job-[a-f\d-]{36}$/.test(tab.url))
        .map(tab => new Option((tab.id === tabId && !videoRoute?.bangumi && currentVideo?.title) || tab.title || tab.url || i18n.currentPage,
            tab.id,false,tab.id === tabId));
    select.options.length = 0;
    select.append(...options);
    select.value = String(tabId);
}
async function refreshTab(id, nextUrl) {
    const epoch = ++generation;
    lookupAbort?.abort();
    publicLookup?.abort();
    lookupAbort = videoLookup = videoRoute = currentVideo = null;
    watchId = "";
    videoSources = [];
    publicLookup = null;
    publicTracks = [];
    publicTracksAt = 0;
    clearTimeout(scanTimer);
    scanLabel = "sideRescan";
    for (const frame of frames.values()) frame.port.disconnect();
    frames.clear(); records.clear(); selections.clear(); choices.clear(); outcomes.clear(); tierRequests.clear();
    for (const row of rows.values()) removeRow(row);
    rows.clear();
    tabId = G.tabId = id;
    if (!$id("playback-view").hidden) loadPlayback();
    picking = multi = blocked = availableTab = false;
    loading = true;
    enabled = true;
    picked = null;
    directPick = null;
    limit = 45;
    $id("segments").open = $id("help").open = false;
    say();
    render();
    try {
        const tab = await chrome.tabs.get(id);
        if (epoch !== generation) return;
        availableTab = /^https?:/.test(tab.url || "");
        videoRoute = SnagBili.route(nextUrl || tab.url);
        watchId = SnagPlayer.youtubeId(nextUrl || tab.url);
        windowId = tab.windowId;
        await tabOptions();
        let snapshot = await chrome.runtime.sendMessage({ Message:"sidebarData", tabId:id });
        // The service worker may be waking up from sleep.
        for (let tries = 0; epoch === generation && !Array.isArray(snapshot?.records) && tries < 8; tries++) {
            await new Promise(resolve => setTimeout(resolve, 120));
            snapshot = await chrome.runtime.sendMessage({ Message:"sidebarData", tabId:id });
        }
        if (epoch !== generation) return;
        if (!Array.isArray(snapshot?.records)) throw new Error(i18n.dataFetchFailed);
        enabled = snapshot.enabled;
        blocked = snapshot.blocked;
        if (blocked) records.clear();
        else snapshot.records.forEach(addRecord);
        if (availableTab && !blocked) {
            const list = await chrome.webNavigation.getAllFrames({ tabId:id });
            for (const frame of list || []) connectFrame(frame, epoch);
        }
    } catch {
        if (epoch === generation) say(i18n.sideUnavailable);
    } finally {
        if (epoch === generation) { loading = false; render(); }
    }
}

// Fetch preview media only for cards near the viewport. Never start a player in the list.
const thumbs = new IntersectionObserver(entries => {
    for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const box = entry.target;
        thumbs.unobserve(box);
        const { preview, medium } = box.dataset;
        if (!preview) continue;
        const image = el(medium);
        if (medium === "video") {
            image.muted = true;
            image.preload = "metadata";
            image.playsInline = true;
        } else { image.alt = ""; image.decoding = "async"; image.referrerPolicy = "no-referrer"; }
        image.addEventListener("error", () => {
            image.remove();
            box.classList.add("placeholder");
        }, { once:true });
        image.src = preview;
        box.append(image);
    }
}, { rootMargin:"100px" });

function thumbnail(box, group, record) {
    let preview = "", medium = "img";
    if (group.kind === "image") preview = record.url;
    else if (group.kind === "video" || group.kind === "audio") {
        const poster = group.info?.poster || group.point?.poster || "";
        if (/^(https?:\/\/|data:image\/jpeg;base64,)/i.test(poster)) preview = poster;
        else if (group.kind === "video" && !group.biliId && !group.rawSegment && !isM3U8(record) && !isMPD(record) && /^https?:/.test(record.url)) {
            const url = new URL(record.url);
            url.hash = "t=0.1";
            preview = url.href;
            medium = "video";
        }
    }
    if (box.dataset.preview === preview && box.dataset.medium === medium) return;
    thumbs.unobserve(box);
    box.replaceChildren(el("span",group.rawSegment ? i18n.sideSegment : group.kind === "video" ? i18n.sideNoPreview : i18n(types[group.kind])));
    box.classList.toggle("placeholder", !preview);
    box.dataset.preview = preview;
    box.dataset.medium = medium;
    if (preview) thumbs.observe(box);
}

function stopDetail(row) {
    row.stopPreview?.();
    row.stopPreview = null;
    const pane = row.node.querySelector(".details");
    pane.replaceChildren();
    pane.hidden = true;
    row.node.querySelector(".toggle-details").setAttribute("aria-expanded","false");
}
function showDetails(row) {
    stopDetail(row);
    const group = row.group;
    const pane = row.node.querySelector(".details");
    pane.hidden = false;
    row.detailPoint = group.point?.key;
    row.node.querySelector(".toggle-details").setAttribute("aria-expanded","true");
    if (group.playerOnly || choice(group).segments) {
        const point = group.point, frame = frames.get(point.frameId);
        row.detailUrl = group.playerOnly ? point.current : undefined;
        const host = el("div",null,"detail-preview");
        pane.append(host);
        if (point.protectedMedia || !frame || frame.serial !== point.serial) host.textContent = i18n.sidePreviewUnavailable;
        else row.stopPreview = framePreview(host,point,frame);
        if (!group.playerOnly) {
            const details = encodingStats(choice(group),point.duration).join(" · ");
            if (details) pane.append(el("div",details,"detail-info"));
        }
        return;
    }
    const track = choice(group), record = track.record;
    row.detailUrl = record.url;
    if (group.kind === "image") {
        const img = el("img"); img.alt = title(group, record); img.src = record.url; pane.append(img);
    } else if (["video","audio"].includes(group.kind)) row.stopPreview = detailPreview(pane,group,track);
    pane.append(el("div", [record.name,record.type,...encodingStats(track,group.info?.duration || group.point?.duration),
        record.size > 0 && bytes(record.size)].filter(Boolean).join(" · "), "detail-info"));
    const link = el("a",record.url);
    link.target = "_blank"; link.rel = "noreferrer"; link.href = record.url;
    pane.append(link);
    const actions = el("div",null,"detail-actions");
    const copy = el("button",i18n.sideCopyLink);
    copy.onclick = () => copyTracks([track]);
    actions.append(copy);
    if (!G.disableInternalDownloader && record.requestId && group.kind !== "video" && group.kind !== "audio") {
        const retry = el("button",i18n.downloadWithRequestHeader);
        retry.onclick = () => startMedia(group).catch(error => say(error.message));
        actions.append(retry);
    }
    if (isM3U8(record) || isMPD(record)) {
        const parser = el("button",i18n.parser);
        parser.onclick = () => openParser(downloadData(track)).catch(error => say(error.message));
        actions.append(parser);
    }
    pane.append(actions);
}

function createRow(group) {
    const node = $id(group.playerOnly ? "player-template" : "card-template").content.firstElementChild.cloneNode(true);
    const row = { node, group };
    for (const text of node.querySelectorAll("[data-i18n]")) text.textContent = i18n(text.dataset.i18n);
    node.querySelector(".toggle-details").textContent = i18n.sideDetails;
    node.querySelector(".toggle-details").onclick = () => node.querySelector(".details").hidden ? showDetails(row) : stopDetail(row);
    node.querySelector(".locate").onclick = async () => {
        const point = row.group.point;
        const frame = frames.get(point?.frameId);
        if (!frame || frame.serial !== point.serial) { say(i18n.sideGone); return; }
        await chrome.tabs.update(tabId, { active:true });
        if (frames.get(point.frameId) === frame) frame.port.postMessage({ type:"locate", id:point.id });
    };
    if (group.playerOnly) return row;
    attachDownloadModes(row);
    node.querySelector(".download").onclick = () => downloadGroup(row.group).catch(error => say(error.message));
    node.querySelector(".check").onchange = event => {
        if (event.target.checked) selections.add(row.group.key);
        else selections.delete(row.group.key);
        updateBatch();
    };
    node.querySelector(".quality").onchange = event => {
        tierRequests.delete(row.group.key);
        choices.set(row.group.key, event.target.value);
        updateRow(row,row.group);
    };
    node.querySelector(".encoding").onchange = node.querySelector(".quality").onchange;
    node.querySelector(".quality-tier").onchange = event => selectTier(row,event.target.value);
    return row;
}

function updateRow(row, group) {
    const node = row.node, point = group.point;
    row.group = group;
    node.dataset.kind = group.kind;
    const locate = node.querySelector(".locate");
    locate.disabled = !point;
    locate.textContent = point ? i18n.sideLocate : i18n.sideNoLocation;
    const decoded = group.kind === "video" && SnagPlayer.playbackQuality(point);
    const liveTrack = decoded && group.info?.playingKey && group.tracks.find(t => t.key === group.info.playingKey);
    const liveQuality = liveTrack && fileQuality(group,liveTrack);
    const playing = liveQuality && parseInt(liveQuality,10) === parseInt(decoded,10) ? liveQuality : decoded;
    const playback = node.querySelector(".playback-quality");
    playback.textContent = playing ? i18n("sidePlayingResolution",playing) : "";
    playback.hidden = !playing;
    const fileMeta = node.querySelector(".file-meta");
    if (group.playerOnly) {
        node.querySelector("h3").textContent = point.ad ? i18n.sideAdvertisement : point.title || i18n.video;
        fileMeta.textContent = [!playing && point.playing && i18n.sidePlayingNow,point.duration && secToTime(point.duration),
            point.protectedMedia ? i18n.sideProtectedPlayer : i18n.sidePlayerNoFile].filter(Boolean).join(" · ");
        thumbnail(node.querySelector(".thumb"),group,{});
        if (!node.querySelector(".details").hidden && row.detailUrl !== point.current) showDetails(row);
        return;
    }
    const track = choice(group), record = track.record;
    node.querySelector("h3").textContent = title(group,record);
    node.querySelector(".check").checked = selections.has(group.key);
    node.querySelector(".select-resource").hidden = !multi;
    node.querySelector(".select-resource span").textContent = i18n.sideSelect;
    const split = group.kind === "video" && (track.separate || group.biliId && !track.episodeCid);
    const paired = split && group.tracks.some(item => item.kind === "audio");
    const quality = fileQuality(group,track);
    const duration = group.info?.duration || point?.duration;
    playback.hidden = !playing || playing === quality;
    const selector = node.querySelector(".quality");
    const variants = group.tracks.filter(item => item.kind === group.kind);
    const versions = displayTiers(row,variants,track,duration);
    selector.hidden = versions.length < 2;
    if (!selector.hidden) {
        selectOptions(selector,versions.map(item => [item.key,qualityLabel(item,duration)]),track.key);
        selector.title = selector.selectedOptions[0]?.textContent || "";
        selector.setAttribute("aria-label",i18n.sideVersion);
    }
    showFileMetadata(row,track,quality,duration,split,paired);
    const button = node.querySelector(".download");
    const job = cardJob(track);
    const video = group.kind === "video" && !group.rawSegment;
    let downloadLabel = i18n.download;
    if (video) downloadLabel = quality ? i18n("sideDownloadAt",quality) : i18n.mediaDownloadVideo;
    if (split && !paired) downloadLabel = i18n.mediaFindAudio;
    if (group.rawSegment) downloadLabel = i18n.sideSaveSegment;
    button.textContent = job && activeJob(job) ? progressLabel(job) : downloadLabel;
    const modes = node.querySelector(".download-modes");
    const outcome = outcomes.get(track.key);
    const changing = !!tierRequests.get(group.key)?.pending;
    button.disabled = changing || !!outcome?.pending || !!(job && activeJob(job));
    modes.hidden = !video || changing;
    node.querySelector(".toggle-details").disabled = changing;
    if (row.outcome !== outcome || row.job !== job) {
        row.job = job;
        row.outcome = outcome;
        const status = node.querySelector(".download-state");
        status.textContent = outcome?.text || "";
        if (job) jobActions(status,job,!activeJob(job),job.mode !== mainDownloadMode(group,track));
        else if (outcome?.tabId || outcome?.fileId != null) {
            const follow = el("button",outcome.tabId ? i18n.sideProgress : i18n.sideShowFile,"text-btn");
            follow.onclick = () => {
                if (outcome.fileId != null) chrome.downloads.show(outcome.fileId);
                else chrome.tabs.update(outcome.tabId,{ active:true }).catch(() => { outcomes.delete(track.key); scheduleRender(); });
            };
            status.append(" ",follow);
        }
    }
    thumbnail(node.querySelector(".thumb"),group,record);
    if (!node.querySelector(".details").hidden && (row.activeTrack !== track.key || row.detailPoint !== point?.key || row.detailUrl !== record.url)) showDetails(row);
    row.activeTrack = track.key;
}
function removeRow(row) {
    thumbs.unobserve(row.node.querySelector(".thumb"));
    stopDetail(row);
    row.node.remove();
}

function resolvePickedFile() {
    if (!picked || !enabled || blocked || groups.some(group => group.point?.key === picked.key)) return;
    const item = frames.get(picked.frameId)?.items.find(item => item.key === picked.key);
    if (!item?.loaded || !/^https?:\/\//i.test(item.current)) return;
    if (directPick?.key === item.key && directPick.url === item.current) {
        if (directPick.record) {
            const kind = item.kind === "other" ? resourceKind(directPick.record) : item.kind;
            groups.push({ key:item.key, kind, point:item, tracks:[
                { key:item.key + ":" + item.current, kind, record:directPick.record }
            ] });
        }
        return;
    }
    const request = directPick = { key:item.key, url:item.current };
    chrome.runtime.sendMessage({ Message:"sidebarDirectFile", tabId, url:item.current, kind:item.kind }).then(record => {
        if (request !== directPick || !record?.url) return;
        request.record = record;
        scheduleRender();
    }).catch(() => {});
}

function render() {
    groups = blocked ? [] : sidebarGroups(recordsWithPageFiles(), frames, picked?.key, currentVideo, videoRoute, [...publicTracks,...videoSources]);
    if (!enabled) groups = groups.filter(group => !group.playerOnly);
    resolvePickedFile();
    const pickedGroup = picked && (groups.find(group => group.point?.key === picked.key && group.kind === picked.kind) ||
        groups.find(group => group.point?.key === picked.key));
    if (pickedGroup) filter = pickedGroup.kind;
    const totals = { all:groups.length, video:0, image:0, audio:0, other:0 };
    for (const group of groups) totals[group.kind]++;
    for (const [type,button] of filterButtons) {
        button.textContent = i18n(types[type]) + " " + totals[type];
        button.setAttribute("aria-pressed", String(filter === type));
    }
    visible = groups.filter(group => picked ? group.point?.key === picked.key && group.kind === filter : filter === "all" || group.kind === filter);
    if (G.reverse) visible.reverse();
    const raw = visible.filter(group => group.rawSegment);
    const regular = visible.filter(group => !group.rawSegment);
    const playerOrder = group => group.kind === "video" && group.point?.loaded ? (group.point.playing ? 2 : 1) : 0;
    regular.sort((a,b) => playerOrder(b) - playerOrder(a));
    const canSelect = visible.some(group => group.tracks.length);
    if (multi && !canSelect) { multi = false; selections.clear(); }
    const segments = $id("segments");
    segments.hidden = !raw.length;
    segments.querySelector("summary").textContent = i18n.sideSegments + " (" + raw.length + ")";
    const listed = regular.slice(0,limit);
    const fragments = segments.open ? raw.slice(0,limit) : [];
    const keep = new Set([...listed,...fragments].map(group => group.key));
    for (const [key,row] of rows) {
        if (!keep.has(key)) { removeRow(row); rows.delete(key); }
    }
    for (const [parent,entries] of [[$id("cards"),listed],[$id("segment-cards"),fragments]]) {
        entries.forEach((group,index) => {
            const row = rows.get(group.key) || createRow(group);
            rows.set(group.key,row);
            updateRow(row,group);
            if (parent.children[index] !== row.node) parent.insertBefore(row.node,parent.children[index] || null);
        });
    }
    $id("load-more").hidden = regular.length <= limit && (!segments.open || raw.length <= limit);
    $id("selection-tools").hidden = !picked;
    $id("multi").hidden = !!picked || !canSelect;
    $id("multi").textContent = multi ? i18n.sideDone : i18n.sideMulti;
    $id("multi").setAttribute("aria-pressed",String(multi));
    $id("pick").textContent = picking ? i18n.sideCancelPick : i18n.sidePick;
    $id("pick").setAttribute("aria-pressed",String(picking));
    $id("pick").disabled = blocked || !availableTab || ![...frames.values()].some(frame => frame.ready);
    $id("rescan").textContent = i18n(scanLabel);
    $id("rescan").disabled = $id("pick").disabled || !enabled || loading || scanLabel === "sideScanning";
    $id("reload-page").disabled = !availableTab || blocked || !enabled || loading;
    const empty = $id("empty");
    empty.hidden = visible.length > 0 && !blocked;
    empty.textContent = loading ? i18n.loadingData : blocked ? i18n.isBlockedSite :
        !availableTab ? i18n.sideUnavailable : !enabled ? i18n.sidePaused :
        picked ? i18n.sideWaiting : i18n.sideEmpty;
    $id("help").hidden = !availableTab || blocked || !enabled || G.version < (G.isFirefox ? 128 : 102);
    updateBatch();
    renderOtherJobs();
}
function updateBatch() {
    const selectable = visible.filter(group => group.tracks.length && (!group.rawSegment || $id("segments").open));
    const selected = selectable.filter(group => selections.has(group.key));
    $id("batch").hidden = !multi;
    $id("select-all").checked = !!selectable.length && selected.length === selectable.length;
    $id("select-all").indeterminate = selected.length > 0 && selected.length < selectable.length;
    $id("select-all").disabled = !selectable.length;
    $id("copy-selected").disabled = $id("save-selected").disabled = !selected.length || selected.some(group => tierRequests.get(group.key)?.pending);
    if (selected.some(group => choice(group)?.segments)) $id("copy-selected").disabled = true;
    $id("save-selected").textContent = i18n.download + " (" + selected.length + ")";
}

function downloadData(track) {
    const data = { ...track.record };
    data.parsing = isM3U8(data) ? "m3u8" : isMPD(data) ? "mpd" : false;
    const suffix = data.parsing || SnagFormat.extension(data);
    let name = (data.name || data.title || "media").replace(/[/\\]/g,"_");
    if (!/\.[a-z\d]{1,8}$/i.test(name) && /^[a-z\d]{1,8}$/i.test(suffix || "")) name += "." + suffix;
    data.downFileName = filterFileName(G.TitleName ? templates(G.downFileName,data) || name : name);
    // With only a DOM URL and no suffix, let the browser name the file from its response.
    if (data.fromPage && !data.ext && !G.TitleName) delete data.downFileName;
    return data;
}
async function copyTracks(tracks) {
    try {
        await navigator.clipboard.writeText(tracks.map(track => copyLink(downloadData(track))).join("\n"));
        say(i18n.copiedToClipboard);
    } catch { say(i18n.sideCopyFailed); }
}
async function downloadGroup(group) {
    const track = choice(group);
    if (group.kind === "video" || group.kind === "audio")
        return startMedia(group,mainDownloadMode(group,track));
    await downloadTrack(track);
}
async function downloadTrack(track) {
    if (outcomes.get(track.key)?.pending) return;
    const epoch = generation;
    outcomes.set(track.key,{ text:i18n.sideDownloading, pending:true });
    scheduleRender();
    try {
        const data = downloadData(track);
        if (G.clipboard) await getClipboardText(data);
        const result = await saveCapturedFile(data, { useParser:true, editCommand: args => prompt(i18n.confirm,args), notify:say });
        if (epoch !== generation) return;
        if (result.id != null) {
            downloads.set(result.id, { track, epoch });
            const [item] = await chrome.downloads.search({ id:result.id });
            if (item) downloadState(result.id,item.state,item.error);
        } else if (result.handedOff) {
            outcomes.set(track.key,{ text:i18n.sideHandedOff, tabId:result.tabId });
        } else outcomes.delete(track.key);
    } catch (error) {
        if (epoch === generation) outcomes.set(track.key,{ text:i18n.sideInterrupted });
        throw error;
    } finally {
        scheduleRender();
    }
}
function downloadState(id,state,error) {
    const job = downloads.get(id);
    if (!job || !["complete","interrupted"].includes(state)) return;
    downloads.delete(id);
    if (job.epoch !== generation) return;
    const { track } = job;
    if (!G.disableInternalDownloader && track.record.requestId && /^(SERVER_|NETWORK_FAILED)/.test(error || "")) {
        startMedia({key:track.key,kind:track.kind,tracks:[track]}).then(() => {
            if (job.epoch === generation) outcomes.delete(track.key);
        }).catch(() => {
            if (job.epoch === generation) outcomes.set(track.key,{ text:i18n.sideInterrupted });
        }).finally(scheduleRender);
    } else {
        outcomes.set(track.key,state === "complete" ? { text:i18n.downloaded, fileId:id } : { text:i18n.sideInterrupted });
        if (state === "complete") chrome.downloads.search({id}).then(([item]) => {
            const outcome = outcomes.get(track.key);
            if (!item || job.epoch !== generation || outcome?.fileId !== id) return;
            outcome.result = {size:item.fileSize,ext:SnagFormat.extension({name:item.filename,type:item.mime})};
            scheduleRender();
        }).catch(() => {});
    }
    scheduleRender();
}
chrome.downloads.onChanged.addListener(event => downloadState(event.id,event.state?.current,event.error?.current));
chrome.runtime.onMessage.addListener(message => {
    if (message.Message === "popupAddData" && message.data?.tabId === tabId) {
        if (message.removed) {
            const old = message.removed;
            const key = (old.frameId ?? "?") + ":" + resourceAddress(old.url);
            if (records.get(key)?.requestId === old.requestId) records.delete(key);
        }
        addRecord(message.data);
        scheduleRender();
    }
});
chrome.tabs.onActivated.addListener(info => {
    if (!fixedTab && info.windowId === windowId && info.tabId !== tabId) refreshTab(info.tabId);
});
chrome.tabs.onUpdated.addListener((id, change, tab) => {
    if (change.title === undefined) return;
    setTabTitle(id,(id === tabId && !videoRoute?.bangumi && currentVideo?.title) || change.title || tab.url || i18n.currentPage);
});
chrome.webNavigation.onCommitted.addListener(event => {
    if (event.tabId === tabId && event.frameId === 0) refreshTab(tabId);
});
chrome.webNavigation.onHistoryStateUpdated.addListener(event => {
    if (event.tabId === tabId && event.frameId === 0 &&
        (SnagBili.route(event.url)?.key !== videoRoute?.key || SnagPlayer.youtubeId(event.url) !== watchId)) refreshTab(tabId,event.url);
});
chrome.webNavigation.onDOMContentLoaded.addListener(event => {
    if (event.tabId === tabId && !loading) connectFrame(event,generation);
});
chrome.storage.onChanged.addListener((changes,area) => {
    if (area === "sync" && (changes.enable || changes.blockUrl || changes.blockUrlWhite) && tabId) refreshTab(tabId);
});
window.addEventListener("pagehide",() => { for (const frame of frames.values()) frame.port.disconnect(); });

for (const type of ["all","video","image","audio","other"]) {
    const button = el("button");
    button.dataset.filter = type;
    button.onclick = () => selectFilter(type);
    filterButtons.set(type,button);
    $id("filters").append(button);
}
$id("filters").setAttribute("aria-label",i18n.filter);
$id("scope").onfocus = () => tabOptions().catch(() => {});
$id("scope").onchange = async event => {
    const id = Number(event.target.value);
    await chrome.tabs.update(id,{ active:true });
    if (id !== tabId) await refreshTab(id);
};
$id("back").onclick = () => selectFilter(filter);
$id("rescan").onclick = rescan;
$id("reload-page").onclick = async () => {
    const epoch = generation;
    try { await chrome.tabs.reload(tabId); }
    catch { if (epoch === generation) say(i18n.sideScanFailed); }
};
$id("pick").onclick = async () => {
    if (picking) { stopPicker(); say(); render(); return; }
    const epoch = generation;
    await chrome.tabs.update(tabId,{ active:true });
    if (epoch !== generation) return;
    picking = true;
    for (const frame of frames.values()) frame.port.postMessage({ type:"pick",active:true });
    say(i18n.sidePickHint);
    render();
};
document.addEventListener("keydown",event => {
    if (event.key === "Escape" && picking) { stopPicker(); say(); render(); }
});
$id("multi").onclick = () => { multi = !multi; selections.clear(); render(); };
$id("select-all").onchange = event => {
    selections.clear();
    if (event.target.checked) for (const group of visible) {
        if (group.tracks.length && (!group.rawSegment || $id("segments").open)) selections.add(group.key);
    }
    render();
};
$id("copy-selected").onclick = () => copyTracks(visible.filter(group => selections.has(group.key)).map(choice));
$id("save-selected").onclick = async () => {
    const jobs = visible.filter(group => selections.has(group.key));
    if (jobs.length >= 10 && !confirm(i18n("confirmDownload",[String(jobs.length)]))) return;
    for (const group of jobs) {
        try { await downloadGroup(group); } catch (error) { say(error.message); }
    }
};
$id("segments").ontoggle = () => {
    if (!$id("segments").open) for (const group of visible) {
        if (group.rawSegment) selections.delete(group.key);
    }
    scheduleRender();
};
$id("load-more").onclick = () => { limit += 45; render(); };
$id("settings").onclick = () => { $id("more").open = false; chrome.runtime.openOptionsPage(); };
function loadPlayback() {
    const frame = $id("sidebar-playback");
    const src = "playback.html?view=sidebar&tabId=" + (tabId || 0);
    if (frame.getAttribute("src") !== src) frame.src = src;
}
$id("tools").onclick = () => {
    stopPicker();
    for (const player of document.querySelectorAll(".details video,.details audio")) player.pause();
    $id("more").open = false;
    $id("playback-view").hidden = false;
    document.body.classList.add("playback-open");
    $id("sidebar-playback").title = i18n.playbackTitle;
    loadPlayback();
    $id("back-to-resources").focus();
};
$id("back-to-resources").onclick = () => {
    $id("playback-view").hidden = true;
    $id("sidebar-playback").removeAttribute("src");
    document.body.classList.remove("playback-open");
    render();
    $id("more").querySelector("summary").focus({preventScroll:true});
};
$id("help").ontoggle = async () => {
    if (!$id("help").open) return;
    const state = await chrome.runtime.sendMessage({ Message:"getButtonState",tabId });
    for (const button of document.querySelectorAll("[data-script]")) {
        const script = G.scriptList.get(button.dataset.script);
        button.textContent = state?.[script.key] ? script.off : script.name;
    }
};
for (const button of document.querySelectorAll("[data-script]")) {
    button.onclick = () => chrome.runtime.sendMessage({ Message:"script", tabId, script:button.dataset.script });
}
awaitG(async () => {
    const [tab] = await chrome.tabs.query({ active:true,currentWindow:true });
    windowId = tab?.windowId;
    await mediaCommand('list').then(receiveJobs).catch(() => {});
    if (fixedTab || tab?.id) await refreshTab(fixedTab || tab.id);
});
