// Runs at document start only in a download's temporary YouTube player.
// The website does its own playback requests. This collector sees the same
// encoded input as Media Source Extensions, after transport framing.
(() => {
    'use strict';
    const marker = /^#snag-segments=(job-[a-f0-9-]{36})$/.exec(location.hash);
    const videoId = new URL(location.href).searchParams.get('v');
    if (!marker || !/^[\w-]{11}$/.test(videoId || '') || !globalThis.MediaSource || !globalThis.SourceBuffer) return;

    const urls = new Map(), buffers = new WeakMap(), pendingTracks = new Set();
    const maxPending = 48 * 1024 * 1024, blockSize = 512 * 1024;
    let serial = 0, pendingBytes = 0, fatal, requested, pinnedAt = 0, restarted = false, protectedVideo, selectedMode;
    let menuStep = 0, menuTime = 0, lastPlay = 0;
    const needed = kind => !selectedMode || selectedMode === 'full' || selectedMode === kind;
    const nativeUrl = URL.createObjectURL;
    URL.createObjectURL = function (object) {
        const url = nativeUrl.call(this,object);
        if (object instanceof MediaSource) urls.set(url,object);
        return url;
    };
    function reset(track) {
        pendingBytes -= track.queued;
        Object.assign(track,{serial:++serial,queue:[],queued:0,offset:0,frontier:0,init:false,header:null,gap:false});
    }
    function initSegment(data) {
        return data.length >= 8 && ((data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) ||
            String.fromCharCode(...data.subarray(4,8)) === 'ftyp');
    }
    function appended(track,bytes) {
        if (!needed(track.kind)) return;
        if (initSegment(bytes)) {
            // Repeated identical initialization is common at an adaptation boundary.
            // A different header starts a new file and must cover the beginning again.
            if (track.header && bytes.length === track.header.length && bytes.every((b,i)=>b === track.header[i])) return;
            const hadMedia = track.init && track.frontier > 0.12;
            reset(track);
            track.gap = hadMedia;
            track.init = true;
            if (bytes.length <= 65536) track.header = bytes;
            if (/pssh|encv|enca/.test(new TextDecoder('latin1').decode(bytes.subarray(0,262144)))) {
                track.protected = true;
                return;
            }
        }
        if (!track.init || track.protected) return;
        if (pendingBytes + bytes.length > maxPending) { fatal = 'mediaSegmentIncomplete'; return; }
        track.queue.push(bytes);
        track.queued += bytes.length;
        pendingBytes += bytes.length;
        try {
            const ranges = track.buffer.buffered;
            for (let i = 0; i < ranges.length; i++) {
                if (ranges.start(i) > track.frontier + 0.12) { track.gap = true; break; }
                track.frontier = Math.max(track.frontier,ranges.end(i));
            }
        } catch { /* A replaced SourceBuffer will no longer be selected. */ }
    }
    const add = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (type) {
        const buffer = add.call(this,type);
        const kind = /^(video|audio)\//i.exec(type)?.[1];
        if (kind) {
            const track = {source:this,buffer,kind,queued:0};
            reset(track); buffers.set(buffer,track); pendingTracks.add(track);
            this.addEventListener('sourceclose',() => { reset(track); pendingTracks.delete(track); },{once:true});
        }
        return buffer;
    };
    const append = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function (data) {
        const track = buffers.get(this), player = document.getElementById('movie_player');
        if (!track || !needed(track.kind) || fatal || player?.matches('.ad-showing,.ad-interrupting')) return append.call(this,data);
        // Copy the view, not the entire backing buffer, before the player reuses it.
        const view = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer,data.byteOffset,data.byteLength) : new Uint8Array(data);
        if (view.byteLength > maxPending) { fatal = 'mediaSegmentIncomplete'; return append.call(this,data); }
        const bytes = view.slice();
        const result = append.call(this,data);
        let failed = false;
        const failure = () => { failed = true; };
        this.addEventListener('error',failure,{once:true});
        this.addEventListener('abort',failure,{once:true});
        this.addEventListener('updateend',() => {
            this.removeEventListener('error',failure); this.removeEventListener('abort',failure);
            if (!failed && !player?.matches('.ad-showing,.ad-interrupting')) appended(track,bytes);
        },{once:true});
        return result;
    };
    document.addEventListener('encrypted',e => { protectedVideo = e.target; },true);

    function take(track) {
        const head = track.queue[0], end = Math.min(track.offset + blockSize,head.length);
        const data = head.subarray(track.offset,end);
        let encoded;
        if (data.toBase64) encoded = data.toBase64();
        else {
            let binary = '';
            for (let i=0; i<data.length; i+=8192) binary += String.fromCharCode(...data.subarray(i,i+8192));
            encoded = btoa(binary);
        }
        track.queued -= data.length; pendingBytes -= data.length;
        if (end === head.length) { track.queue.shift(); track.offset = 0; } else track.offset = end;
        return {kind:track.kind,data:encoded};
    }
    // Use the site's ordinary quality menu when two frame rates share its hd1080 level.
    // All clicks target the muted job tab. The original page never receives this script.
    function selectMenuQuality(player,quality) {
        if (menuStep >= 3 || Date.now() - menuTime < 250) return;
        const settings = player.querySelector('.ytp-settings-button');
        if (!settings) return;
        menuTime = Date.now();
        const visible = node => node?.getClientRects().length;
        const list = player.querySelector('.ytp-quality-menu');
        if (visible(list)) {
            for (const item of list.querySelectorAll('.ytp-menuitem')) {
                const label = item.querySelector('.ytp-menuitem-label')?.textContent || '';
                const match = /(\d+)p(?:\s*(\d{2,3})(?!\d))?/i.exec(label);
                if (!match || Number(match[1]) !== quality.height || Number(match[2] || 0) !== quality.fps ||
                    item.getAttribute('aria-disabled') === 'true' || /premium/i.test(label)) continue;
                if (item.getAttribute('aria-checked') !== 'true') item.click();
                break;
            }
            menuStep = 3;
        } else if (menuStep < 2 && settings.getAttribute('aria-expanded') === 'true') {
            const entry = [...player.querySelectorAll('.ytp-settings-menu .ytp-menuitem')].find(item=>
                /\d+p\b|\d+p\d+/i.test(item.querySelector('.ytp-menuitem-content')?.textContent || '') ||
                /^(quality|画质|畫質|清晰度)$/i.test(item.querySelector('.ytp-menuitem-label')?.textContent?.trim() || ''));
            if (entry) { entry.click(); menuStep = 2; }
        } else if (!menuStep) { settings.click(); menuStep = 1; }
    }
    function pin(player,video,height) {
        const levels = {144:'tiny',240:'small',360:'medium',480:'large',720:'hd720',1080:'hd1080',1440:'hd1440',2160:'hd2160',4320:'highres'};
        const level = levels[height] || 'hd' + height;
        try { player.setPlaybackQualityRange?.(level,level); } catch { /* verify the resulting file */ }
        if (!requested && video.currentTime > 0.25) video.currentTime = 0;
        requested = level;
        pinnedAt = Date.now();
    }
    function pull(token,quality,mode) {
        if (token !== marker[1] || quality.videoId !== videoId || new URL(location.href).searchParams.get('v') !== videoId) return {error:'mediaSegmentIncomplete'};
        if (!selectedMode) {
            selectedMode = mode;
            for (const track of pendingTracks) if (!needed(track.kind)) reset(track);
        }
        if (fatal) return {error:fatal};
        const player = document.getElementById('movie_player');
        const response = player?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
        if (response?.playabilityStatus?.status && response.playabilityStatus.status !== 'OK') return {error:'mediaSegmentUnavailable'};
        const video = player?.querySelector('video.html5-main-video,video');
        if (!video) return {waiting:true};
        if (video.paused && !video.ended && Date.now()-lastPlay>2000) {
            lastPlay = Date.now(); video.muted = true; video.play().catch(()=>{});
        }
        if (player.matches('.ad-showing,.ad-interrupting')) {
            for (const track of pendingTracks) if (track.init) reset(track);
            return {waiting:true};
        }
        if (video.mediaKeys || protectedVideo === video || response?.streamingData?.licenseInfos?.length ||
            response?.streamingData?.adaptiveFormats?.some(f=>f?.drmTrackType || f?.drmFamilies?.length)) return {error:'mediaProtected'};
        if (response?.videoDetails?.isLiveContent) return {error:'mediaLive'};
        if (response?.videoDetails?.videoId !== videoId || response.playabilityStatus?.status !== 'OK' ||
            player.getVideoData?.()?.video_id && player.getVideoData().video_id !== videoId) return {waiting:true};
        if (!requested || Date.now() - pinnedAt > 4000 && Math.min(video.videoWidth,video.videoHeight) !== quality.height) pin(player,video,quality.height);
        if (mode !== 'audio') selectMenuQuality(player,quality);
        const source = urls.get(video.currentSrc || video.src);
        if (!source || !Number.isFinite(video.duration) || video.duration <= 0) return {waiting:true};
        if (Math.abs(quality.duration-video.duration) > Math.max(1,quality.duration*0.001)) return {error:'mediaSegmentIncomplete'};
        const active = Array.from(source.activeSourceBuffers.length ? source.activeSourceBuffers : source.sourceBuffers, b=>buffers.get(b)).filter(Boolean);
        const wanted = mode === 'full' ? ['video','audio'] : [mode];
        const tracks = wanted.map(kind=>active.find(t=>t.kind === kind));
        if (tracks.some(t=>t?.protected)) return {error:'mediaProtected'};
        if (tracks.some(t=>!t?.init)) {
            if (source.readyState === 'ended') return {error:wanted.some((kind,i)=>kind === 'audio' && !tracks[i]) ? 'mediaNoAudio' : 'mediaSegmentIncomplete'};
            return {waiting:true};
        }
        // A quality switch or resume position can leave the first seconds in a different
        // representation. Let the normal player start a fresh run at the requested tier.
        const wrongSize = mode !== 'audio' && video.videoWidth && Math.min(video.videoWidth,video.videoHeight) !== quality.height;
        if (tracks.some(t=>t.gap) || wrongSize && video.currentTime > 1 && Date.now()-pinnedAt > 1200) {
            if (!restarted && player.loadVideoById) {
                restarted = true;
                menuStep = 0;
                for (const t of pendingTracks) reset(t);
                player.loadVideoById({videoId,startSeconds:0,suggestedQuality:requested});
                pin(player,video,quality.height);
                return {waiting:true};
            }
            return {error:wrongSize ? 'mediaSegmentQuality' : 'mediaSegmentIncomplete'};
        }
        const frontier = Math.min(...tracks.map(t=>t.frontier));
        const result = {serials:Object.fromEntries(tracks.map(t=>[t.kind,t.serial])),frontier};
        const pending = tracks.find(t=>t.queue.length);
        if (pending) { result.block = take(pending); return result; }
        const tolerance = Math.min(0.12,video.duration*0.05);
        if (frontier >= video.duration - tolerance && tracks.every(t=>!t.buffer.updating) &&
            (source.readyState === 'ended' || video.ended || frontier >= video.duration-0.025)) {
            return {...result,done:true};
        }
        if (source.readyState === 'ended' && tracks.every(t=>!t.buffer.updating)) return {error:'mediaSegmentIncomplete'};
        // All bytes up to frontier are already in the job. Seek inside that buffer to
        // allow the website to fetch the next segments without moving the user's player.
        if (!video.seeking && frontier > video.currentTime + 6) video.currentTime = Math.max(0,frontier-2);
        return result;
    }
    Object.defineProperty(pull,'job',{value:marker[1]});
    Object.defineProperty(window,'__snagPullSegments',{value:pull});
})();
