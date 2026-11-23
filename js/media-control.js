"use strict";

// Executed in the selected frame's isolated world. A player keeps its identity if other elements move.
async function playbackInFrame(command) {
    const ids = globalThis.__snagPlaybackIds ??= new WeakMap();
    const media = [...document.querySelectorAll("video,audio")].filter(node =>
        node.currentSrc || node.srcObject || node.getAttribute("src") || node.querySelector("source[src]"));
    if (!command) {
        return media.map(node => {
            if (!ids.has(node)) ids.set(node, crypto.getRandomValues(new Uint32Array(4)).join("-"));
            const caption = node.getAttribute("aria-labelledby")?.split(/\s+/)
                .map(id => document.getElementById(id)?.textContent || "").join(" ").trim();
            const title = node.getAttribute("aria-label") || caption || node.title ||
                node.closest("figure")?.querySelector("figcaption")?.textContent || (media.length === 1 ? document.title : "");
            return { id:ids.get(node), title:title.trim().slice(0,160), kind:node.localName, paused:node.paused,
                position:node.currentTime, duration:Number.isFinite(node.duration) ? node.duration : null,
                rate:node.playbackRate, volume:node.volume, muted:node.muted, loop:node.loop, live:node.duration === Infinity,
                pip:!!document.pictureInPictureEnabled && !node.disablePictureInPicture,
                inPip:document.pictureInPictureElement === node, fullscreen:!!document.fullscreenEnabled,
                inFullscreen:!!document.fullscreenElement?.contains(node), fullscreenPrompt:globalThis.__snagFullscreen?.node === node };
        });
    }
    const node = media.find(item => ids.get(item) === command.id);
    if (!node) return "gone";
    const value = command.value, doc = node.ownerDocument;
    try {
        switch (command.action) {
            case "play": await node.play(); break;
            case "pause": node.pause(); break;
            case "rate":
                try { node.playbackRate = value; } catch { return "unsupportedRate"; }
                if (node.playbackRate !== value) return "unsupportedRate";
                break;
            case "volume": node.volume = value / 100; break;
            case "muted": node.muted = value; break;
            case "loop": node.loop = value; break;
            case "seek":
                if (!Number.isFinite(node.duration) || node.duration <= 0) return "gone";
                node.currentTime = node.duration * value / 100;
                break;
            case "pip":
                if (doc.pictureInPictureElement === node) await doc.exitPictureInPicture();
                else await node.requestPictureInPicture();
                break;
            case "fullscreen": {
                globalThis.__snagFullscreen?.close();
                if (doc.fullscreenElement?.contains(node)) { await doc.exitFullscreen(); break; }
                if (!doc.fullscreenEnabled) return "fullscreenBlocked";
                try { await node.requestFullscreen(); break; } catch { /* The click may belong to the sidebar instead of this document. */ }
                if (!node.isConnected) return "gone";
                const host = doc.createElement("div");
                host.setAttribute("data-snag-fullscreen","");
                const shadow = host.attachShadow({mode:"open"});
                const enter = doc.createElement("button"), cancel = doc.createElement("button");
                enter.textContent = chrome.i18n.getMessage("playbackEnterFullscreen");
                cancel.textContent = chrome.i18n.getMessage("close");
                const style = doc.createElement("style");
                style.textContent = ":host{all:initial!important;position:fixed!important;z-index:2147483647!important;left:50%!important;bottom:18px!important;transform:translateX(-50%)!important}div{display:flex;gap:8px;padding:8px;background:#fff;border:1px solid #dadbe5;border-radius:12px;box-shadow:0 3px 20px #17183242}button{font:600 15px system-ui;white-space:nowrap;padding:9px 14px;border:0;border-radius:7px;color:#332e58;background:#efeff6;cursor:pointer}button:first-child{background:#494594;color:white}button:focus-visible{outline:2px solid #24204f;outline-offset:2px}";
                const bar = doc.createElement("div");
                bar.append(enter,cancel);
                shadow.append(style,bar);
                const life = new AbortController();
                const close = () => {
                    host.remove(); life.abort(); clearTimeout(timer);
                    if (globalThis.__snagFullscreen?.node === node) delete globalThis.__snagFullscreen;
                };
                const timer = setTimeout(close,30000);
                globalThis.__snagFullscreen = {node,close};
                cancel.onclick = close;
                enter.onclick = async () => {
                    try { await node.requestFullscreen(); close(); }
                    catch { enter.textContent = chrome.i18n.getMessage("playbackFullscreenBlocked"); enter.disabled = true; }
                };
                doc.addEventListener("keydown", e => { if (e.key === "Escape") close(); },{signal:life.signal});
                node.addEventListener("emptied",close,{signal:life.signal});
                window.addEventListener("pagehide",close,{signal:life.signal});
                node.scrollIntoView({block:"nearest",inline:"nearest"});
                doc.documentElement.append(host);
                enter.focus({preventScroll:true});
                return "fullscreenPrompt";
            }
            case "screenshot": {
                if (!node.videoWidth || !node.videoHeight) return "failed";
                const canvas = doc.createElement("canvas");
                canvas.width = node.videoWidth;
                canvas.height = node.videoHeight;
                canvas.getContext("2d").drawImage(node,0,0);
                const link = doc.createElement("a");
                link.href = canvas.toDataURL("image/jpeg");
                link.download = location.hostname + "-" + Math.floor(node.currentTime) + "s.jpg";
                link.click();
                break;
            }
            default: return "failed";
        }
        return "ok";
    } catch { return "failed"; }
}

const control = id => document.getElementById(id);
const query = new URLSearchParams(location.search);
const inSidebar = query.get("view") === "sidebar";
const requestedTab = Number(query.get("tabId")) || 0;
let sourceTab = requestedTab, players = [], selected = "", pollTimer, revision = 0, editingRate = false;
const changing = new Set();
document.documentElement.lang = chrome.i18n.getUILanguage();
document.body.classList.toggle("embedded", window !== window.top);
control("source-field").hidden = inSidebar;
control("settings-link").hidden = inSidebar;

function replaceOptions(select, items) {
    if (items.length === select.length && items.every(([value,text], i) =>
        select.options[i].value === String(value) && select.options[i].text === text)) return;
    select.replaceChildren(...items.map(([value,text]) => new Option(text,value)));
}

async function listSources(initial = false) {
    const all = await chrome.tabs.query({ windowType:"normal" });
    const tabs = all.filter(tab => /^https?:/.test(tab.url || ""));
    if (initial && !tabs.some(tab => tab.id === requestedTab)) {
        const ownWindow = all.find(tab => tab.id === G.tabId)?.windowId;
        const local = tabs.filter(tab => tab.windowId === ownWindow);
        const audible = local.filter(tab => tab.audible);
        const candidate = local.find(tab => tab.id === G.tabId) || (audible.length === 1 && audible[0]) ||
            local.find(tab => tab.id === G.mediaControl?.tabid) || (local.length === 1 && local[0]);
        sourceTab = candidate?.id || 0;
    }
    const select = control("source");
    replaceOptions(select, [[0,i18n.playbackChoosePage], ...tabs.map(t => [t.id,t.title || t.url])]);
    select.value = tabs.some(t => t.id === sourceTab) ? String(sourceTab) : "0";
}

function playerName(player, index) {
    return player.title || (i18n(player.kind) + " " + (index + 1));
}

function renderPlayback(sourceAvailable = true) {
    const player = players.find(p => p.id === selected);
    control("empty-player").hidden = !!player;
    control("player").hidden = !player;
    if (!player) {
        control("empty-title").textContent = sourceAvailable ? i18n.playbackEmpty : i18n.playbackChoosePage;
        control("empty-help").textContent = sourceAvailable ? i18n.playbackEmptyHelp : i18n.playbackPageHelp;
        return;
    }
    const picker = control("player-list");
    const names = players.map(playerName);
    replaceOptions(picker, players.map((p,i) => [p.id, (names.indexOf(names[i]) === names.lastIndexOf(names[i])
        ? names[i] : names[i] + " (" + (i + 1) + ")") + (p.duration ? " · " + secToTime(p.duration) : "")]));
    picker.value = player.id;
    control("player-picker").hidden = players.length < 2;
    control("player-name").hidden = players.length > 1;
    control("player-name").textContent = playerName(player,0);
    control("play").textContent = player.paused ? i18n.play : i18n.pause;
    if (!editingRate) {
        const rate = control("rate"), value = player.rate + "×";
        if (![...rate.options].some(option => option.value === value)) rate.add(new Option(value,value),rate.lastElementChild);
        rate.value = value;
    }
    control("seek").disabled = !player.duration;
    if (!changing.has("seek")) {
        control("seek").value = player.duration ? player.position / player.duration * 100 : 0;
        control("clock").textContent = player.live ? i18n.playbackLive : secToTime(player.position) + " / " + (player.duration ? secToTime(player.duration) : "—");
    }
    if (!changing.has("volume")) {
        control("volume").value = Math.round(player.volume * 100);
        control("volume-value").textContent = control("volume").value + "%";
    }
    control("loop").checked = player.loop;
    control("muted").checked = player.muted;
    control("video-actions").hidden = player.kind !== "video";
    control("pip").hidden = !player.pip;
    control("pip").textContent = player.inPip ? i18n.exit : i18n.pictureInPicture;
    control("fullscreen").disabled = !player.fullscreen;
    control("fullscreen").title = player.fullscreen ? "" : i18n.playbackFullscreenBlocked;
    control("fullscreen").textContent = player.inFullscreen ? i18n.playbackExitFullscreen : i18n.fullscreen;
    if (!player.fullscreenPrompt && control("playback-status").textContent === i18n.playbackConfirmFullscreen) control("playback-status").textContent = "";
}

function queuePoll(delay = 0) {
    const seq = ++revision;
    clearTimeout(pollTimer);
    if (!document.hidden) pollTimer = setTimeout(() => readPlayers(seq), delay);
}

async function readPlayers(seq) {
    const id = sourceTab;
    let sourceAvailable = false, found = [];
    try {
        const tab = id && await chrome.tabs.get(id);
        sourceAvailable = /^https?:/.test(tab?.url || "");
        if (sourceAvailable) {
            const frames = await chrome.webNavigation.getAllFrames({ tabId:id });
            const results = await Promise.allSettled((frames || []).filter(frame => /^(https?:|about:(?:blank|srcdoc))/.test(frame.url))
                .map(frame => chrome.scripting.executeScript({ target:{tabId:id,frameIds:[frame.frameId]}, func:playbackInFrame, args:[null] })));
            for (const result of results) {
                if (result.status !== "fulfilled") continue;
                for (const frame of result.value) for (const player of frame.result || []) {
                    found.push({ ...player, frameId:frame.frameId });
                }
            }
        }
    } catch { /* The source tab may have closed or navigated. */ }
    if (seq !== revision) return;
    const previous = selected;
    players = found;
    if (!found.some(p => p.id === selected)) {
        const remembered = G.mediaControl?.tabid === id ? G.mediaControl : null;
        selected = (found.find(p => p.id === remembered?.player) || found.find(p => !p.paused) ||
            found[remembered?.index] || found[0])?.id || "";
    }
    if (selected !== previous) {
        changing.clear();
        editingRate = false;
        control("custom-rate").hidden = true;
    }
    renderPlayback(sourceAvailable);
    control("find-players").disabled = false;
    control("find-players").textContent = i18n.playbackFind;
    pollTimer = setTimeout(() => readPlayers(seq), players.length ? 900 : 1600);
}

async function operate(action, value) {
    const player = players.find(p => p.id === selected), id = sourceTab;
    if (!player) return;
    let result;
    try {
        const target = { tabId:id, frameIds:[player.frameId] };
        const [reply] = await chrome.scripting.executeScript({ target, func:playbackInFrame, args:[{ id:player.id, action, value:value ?? null }] });
        result = reply?.result;
        if (action === "fullscreen" && (result === "fullscreenPrompt" || (result === "ok" && !player.inFullscreen))) {
            const tab = await chrome.tabs.update(id,{active:true});
            await chrome.windows.update(tab.windowId,{focused:true});
        }
        if (result === "ok" && action === "rate") {
            editingRate = false;
            control("custom-rate").hidden = true;
            await chrome.storage.sync.set({ playbackRate:value });
        }
    } catch { /* The frame may have navigated since detection. */ }
    if (sourceTab !== id || selected !== player.id) return;
    const messages = {ok:"", fullscreenPrompt:i18n.playbackConfirmFullscreen, fullscreenBlocked:i18n.playbackFullscreenBlocked,
        unsupportedRate:value > 16 ? i18n.playbackRateLimit : i18n.playbackRateUnsupported, gone:i18n.playbackGone};
    control("playback-status").textContent = messages[result] ?? (!result ? i18n.playbackGone : action === "screenshot" ? i18n.playbackShotFailed : i18n.playbackActionFailed);
    queuePoll();
}

control("source").onfocus = () => listSources().catch(() => {});
if (!inSidebar) chrome.tabs.onUpdated.addListener((id, change, tab) => {
    if (change.title === undefined) return;
    const option = [...control("source").options].find(item => Number(item.value) === id);
    if (option) option.text = change.title || tab.url || i18n.currentPage;
});
control("source").onchange = event => {
    sourceTab = Number(event.target.value);
    selected = "";
    players = [];
    control("playback-status").textContent = "";
    renderPlayback(!!sourceTab);
    queuePoll();
};
control("player-list").onchange = event => {
    selected = event.target.value;
    editingRate = false;
    changing.clear();
    control("custom-rate").hidden = true;
    control("playback-status").textContent = "";
    (chrome.storage.session ?? chrome.storage.local).set({ mediaControl:{tabid:sourceTab, player:selected, index:players.findIndex(p => p.id === selected)} });
    renderPlayback();
};
control("play").onclick = () => operate(players.find(p => p.id === selected)?.paused ? "play" : "pause");
control("rate").onchange = event => {
    editingRate = event.target.value === "custom";
    control("custom-rate").hidden = !editingRate;
    if (editingRate) {
        control("rate-value").value = G.playbackRate || 2;
        control("rate-value").focus();
    } else operate("rate",parseFloat(event.target.value));
};
control("custom-rate").onsubmit = event => {
    event.preventDefault();
    const value = control("rate-value").valueAsNumber;
    if (!Number.isFinite(value) || value <= 0) { control("playback-status").textContent = i18n.playbackRateUnsupported; return; }
    operate("rate",value);
};
for (const key of ["seek","volume"]) {
    const input = control(key);
    input.oninput = () => {
        changing.add(key);
        const p = players.find(item => item.id === selected);
        if (key === "volume") control("volume-value").textContent = input.value + "%";
        else if (p?.duration) control("clock").textContent = secToTime(p.duration * input.value / 100) + " / " + secToTime(p.duration);
    };
    input.onchange = async () => { await operate(key, Number(input.value)); changing.delete(key); };
    input.onblur = () => changing.delete(key);
}
for (const key of ["loop","muted"]) control(key).onchange = event => operate(key,event.target.checked);
for (const key of ["pip","fullscreen","screenshot"]) control(key).onclick = () => operate(key);
control("find-players").onclick = () => {
    control("playback-status").textContent = "";
    control("find-players").disabled = true;
    control("find-players").textContent = i18n.loading;
    queuePoll();
};
control("settings-link").onclick = () => chrome.runtime.openOptionsPage();
document.addEventListener("visibilitychange", () => queuePoll());
window.addEventListener("pagehide", () => { ++revision; clearTimeout(pollTimer); });
awaitG(async () => {
    control("ffmpeg").onclick = () => {
        const frame = control("local-ffmpeg");
        if (!frame.getAttribute("src")) frame.src = G.ffmpegConfig.url;
        frame.hidden = !frame.hidden;
        control("ffmpeg").setAttribute("aria-expanded",String(!frame.hidden));
    };
    if (!inSidebar) await listSources(true);
    queuePoll();
});
