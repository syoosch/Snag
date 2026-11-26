"use strict";

// The source frame can show its existing player or decode a captured file using its normal web permissions.
function framePreview(host, point, frame, file = "", fallback, kind = "video", waitMs = 10000, listening) {
    const audio = kind === "audio";
    const image = el("img"), status = el("div",null,"preview-caption");
    const label = el("span",i18n.sidePreviewLoading), clock = el("span");
    const play = el("button",i18n.sidePlayOnPage);
    image.alt = point?.title || i18n.video;
    if (point?.poster && !file) image.src = point.poster;
    else image.hidden = true;
    play.hidden = true;
    status.append(label,clock,play);
    const seek = el("input");
    seek.type = "range"; seek.min = "0"; seek.step = "0.1"; seek.value = "0"; seek.hidden = true;
    seek.setAttribute("aria-label",i18n.playbackPosition);
    host.replaceChildren(...(audio ? [status,seek] : [image,status,seek]));
    const request = crypto.randomUUID();
    let timer, replyTimer, lastTime = null, inView = false, pending = false, stopped = false, paused = true;
    let action = listening?.requested ? "play" : "";
    let waitingSince = 0, seekTime = 0, seeking = false, needsGesture = false;
    function stop() {
        stopped = true;
        clearTimeout(timer);
        clearTimeout(replyTimer);
        observer.disconnect();
        document.removeEventListener("visibilitychange",visibility);
        frame.port.onMessage.removeListener(receive);
        frame.port.onDisconnect.removeListener(disconnected);
        if (file) try { frame.port.postMessage({type:"endPreview",request}); } catch { /* Frame closed. */ }
    }
    function disconnected() {
        if (stopped) return;
        stop();
        if (fallback?.()) return;
        label.textContent = i18n.sidePreviewUnavailable;
        image.hidden = play.hidden = seek.hidden = true;
        clock.textContent = "";
    }
    function refresh() {
        clearTimeout(timer);
        if (stopped || pending || !inView || document.hidden) return;
        pending = true;
        replyTimer = setTimeout(disconnected,5000);
        try {
            frame.port.postMessage({type:"previewFrame",request,id:point?.id,current:point?.current,page:point?.page,file,kind,lastTime,action,time:seekTime});
            action = "";
        } catch { disconnected(); }
    }
    function receive(reply) {
        if (reply.type !== "previewFrame" || reply.request !== request) return;
        clearTimeout(replyTimer);
        pending = false;
        if (reply.state === "gone" || reply.state === "unavailable") { disconnected(); return; }
        if (file && reply.state === "waiting" && (!audio || listening.requested)) {
            waitingSince ||= Date.now();
            if (Date.now() - waitingSince > waitMs) { disconnected(); return; }
        } else waitingSince = 0;
        if (reply.image) { image.src = reply.image; image.hidden = false; lastTime = reply.time; }
        paused = reply.paused;
        label.textContent = needsGesture ? i18n.sideAudioGesture : reply.state === "waiting" && (!audio || listening.requested) ?
            (file ? i18n.sidePreviewLoading : i18n.sidePreviewWaiting) : audio ? i18n.sideAudioTrack : file ? i18n.sidePreviewSilent : i18n.sidePreviewFollows;
        clock.textContent = reply.duration ? secToTime(reply.time) + " / " + secToTime(reply.duration) : "";
        if (audio) play.textContent = paused ? i18n.sideListen : i18n.sidePauseListening;
        else play.textContent = file ? (paused ? i18n.sidePlayPreview : i18n.sidePausePreview) : i18n.sidePlayOnPage;
        play.hidden = !file && !paused;
        seek.hidden = !file || !reply.duration;
        if (!seek.hidden && !seeking) { seek.max = reply.duration; seek.value = reply.time; }
        // A paused or buffered player sends only its state until its displayed frame changes.
        if (inView && !document.hidden) timer = setTimeout(refresh,action ? 0 : paused || reply.state === "waiting" ? 650 : 150);
    }
    function pauseHiddenFile() {
        if (!file || stopped) return;
        action = "";
        if (listening) listening.requested = false;
        try { frame.port.postMessage({type:"pausePreview",request}); } catch { disconnected(); }
    }
    function visibility() {
        if (document.hidden) { waitingSince = 0; pauseHiddenFile(); }
        refresh();
    }
    const observer = new IntersectionObserver(([entry]) => {
        inView = entry.isIntersecting;
        if (!inView) pauseHiddenFile();
        refresh();
    });
    observer.observe(host);
    frame.port.onMessage.addListener(receive);
    frame.port.onDisconnect.addListener(disconnected);
    document.addEventListener("visibilitychange",visibility);
    play.onclick = async () => {
        if (listening) listening.requested = paused;
        if (audio && paused) {
            // Dispatch directly from the user's click. Polling the port does not carry a playback gesture.
            try {
                const [reply] = await chrome.scripting.executeScript({
                    target:{tabId,frameIds:[frame.frameId]}, args:[request],
                    func:async token => {
                        const player = globalThis.__snagAudioSamples?.get(token);
                        if (!player) return "gone";
                        try { await player.play(); return "playing"; }
                        catch (error) { return error.name; }
                    }
                });
                if (stopped) return;
                needsGesture = reply?.result === "NotAllowedError";
                if (!needsGesture && reply?.result !== "playing") { disconnected(); return; }
            } catch { if (!stopped) disconnected(); return; }
        } else action = paused ? "play" : "pause";
        refresh();
    };
    seek.oninput = () => { seeking = true; };
    seek.onchange = () => { seeking = false; action = "seek"; seekTime = Number(seek.value); refresh(); };
    seek.onblur = () => { seeking = false; };
    return stop;
}

function detailPreview(pane, group, track) {
    const record = track.record, point = group.point;
    const frame = point?.kind === "video" && frames.get(point.frameId);
    const rendition = SnagBili.representation(record.url);
    const matched = frame && frame.serial === point.serial && (
        (point.biliMain && rendition && rendition.cid === group.info?.cid) ||
        point.sources.some(source => resourceAddress(source.url) === resourceAddress(record.url) ||
            (rendition && rendition.identity === SnagBili.representation(source.url)?.identity)));
    const segmented = isMPD(record) || /^(m4s|ts|m2ts)$/i.test(record.ext);
    const host = el("div",null,"detail-preview");
    pane.append(host);
    if (track.streamLeaf && point.loaded && frame?.serial === point.serial) return framePreview(host,point,frame);
    const openNative = () => nativePreview(host,point,track,matched && frame,segmented);
    const fileFrame = matched ? frame : frames.get(record.frameId >= 0 ? record.frameId : 0);
    const canPreviewFile = fileFrame && (matched || !record.documentId || !fileFrame.documentId || fileFrame.documentId === record.documentId);
    if (track.kind === "audio" && canPreviewFile && /^m4s$/i.test(record.ext)) {
        const mirrors = new Set([record.url]);
        if (rendition) for (const source of [...(point?.sources || []),...videoSources,...publicTracks]) {
            if (source.kind === "audio" && SnagBili.representation(source.url)?.identity === rendition.identity) mirrors.add(source.url);
        }
        const addresses = [...mirrors].slice(0,5);
        const listening = {requested:false};
        let stop, index = 0;
        function nextAddress() {
            const file = addresses[index++];
            stop = framePreview(host,point,fileFrame,file,() => {
                if (index < addresses.length && frames.get(fileFrame.frameId) === fileFrame) nextAddress();
                else stop = openNative();
                return true;
            },"audio",index < addresses.length ? 3500 : 10000,listening);
        }
        nextAddress();
        return () => stop?.();
    }
    if (canPreviewFile && /^m4s$/i.test(record.ext)) {
        let stop = framePreview(host,point,fileFrame,record.url,() => {
            if (!matched || frames.get(point.frameId) !== frame) return false;
            stop = framePreview(host,point,frame);
            return true;
        });
        return () => stop();
    }
    if (track.kind === "video" && matched && segmented) return framePreview(host,point,frame);
    if (isMPD(record)) {
        host.append(el("p",i18n.sidePreviewManifest,"preview-caption"));
        return;
    }
    return openNative();
}

function nativePreview(host, point, track, matchedFrame, segmented) {
    const record = track.record;
    const player = el(track.kind === "audio" ? "audio" : "video");
    const status = el("p",i18n.sidePreviewLoading,"preview-caption");
    status.setAttribute("role","status");
    player.controls = true;
    player.playsInline = true;
    const audio = track.kind === "audio";
    player.preload = audio ? "metadata" : "auto";
    if (player.localName === "video" && point?.poster) player.poster = point.poster;
    host.replaceChildren(player,status);
    let hls, timer, stopFollow;
    const life = new AbortController();
    function endFile() {
        clearTimeout(timer);
        life.abort();
        hls?.destroy();
        player.pause();
        player.removeAttribute("src");
        player.load();
    }
    function failed() {
        if (life.signal.aborted) return;
        endFile();
        if (matchedFrame && track.kind === "video") stopFollow = framePreview(host,point,matchedFrame);
        else {
            status.hidden = false;
            status.textContent = track.kind === "audio" ? i18n.sideAudioUnavailable : segmented ? i18n.sidePreviewSegment : i18n.sidePreviewUnavailable;
            host.replaceChildren(status);
        }
    }
    const ready = () => { clearTimeout(timer); status.hidden = true; };
    player.addEventListener(audio ? "loadedmetadata" : "loadeddata",ready,{signal:life.signal});
    player.addEventListener("error",failed,{signal:life.signal});
    timer = setTimeout(() => { if (player.readyState < (audio ? 1 : 2)) failed(); },12000);
    if (isM3U8(record) && Hls.isSupported() && !player.canPlayType("application/vnd.apple.mpegurl")) {
        hls = new Hls({enableWorker:false,maxBufferLength:10,maxMaxBufferLength:20});
        hls.on(Hls.Events.ERROR,(_event,data) => { if (data.fatal) failed(); });
        hls.loadSource(record.url);
        hls.attachMedia(player);
    } else player.src = record.url;
    return () => {
        if (!life.signal.aborted) endFile();
        stopFollow?.();
    };
}
