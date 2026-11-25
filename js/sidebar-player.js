// Read the current player's own links. Only the panel reads advertised master playlists.
globalThis.SnagPlayer = {
    // Keep the website's named quality when available. In particular, 1080p and 1080p60 can be different files.
    quality(label, height = 0, fps = 0) {
        const match = /(?:^|[^\d])(\d{2,5})p(?:(\d{2,3})(?!\d)|\s+(\d{2,3}(?:\.\d+)?)\s*fps)?/i.exec(String(label || ""));
        const lines = Number(match?.[1] || height);
        if (!Number.isInteger(lines) || lines <= 0 || lines > 16384) return "";
        const rate = Number(match?.[2] || match?.[3] || fps);
        return lines + "p" + (rate >= 48 && rate <= 240 ? Math.round(rate) : "");
    },
    playbackQuality(point) {
        if (point?.kind !== "video" || !point.loaded || !point.width || !point.height) return "";
        const lines = Math.min(point.width,point.height);
        const setting = this.quality(point.qualitySetting);
        return parseInt(setting,10) === lines ? setting : this.quality("",lines);
    },
    codecName(codecs) {
        return SnagFormat.codec(codecs);
    },
    youtubeId(address) {
        let url;
        try { url = new URL(address); } catch { return ""; }
        if (!/^https?:$/.test(url.protocol) || !/(^|\.)youtube(?:-nocookie)?\.com$/i.test(url.hostname)) return "";
        const id = url.pathname === "/watch" ? url.searchParams.get("v") : /^\/(?:embed|shorts|live)\/([^/]+)/.exec(url.pathname)?.[1];
        return /^[\w-]{11}$/.test(id || "") ? id : "";
    },
    // Executed in the page. Only return small metadata fields; never evaluate player scripts.
    readYouTubeFormats: function (id) {
        const player = document.getElementById("movie_player");
        if (!player || player.matches(".ad-showing,.ad-interrupting")) return [];
        const liveId = player.getVideoData?.()?.video_id;
        if (liveId && liveId !== id) return [];
        const response = player.getPlayerResponse?.() || window.ytInitialPlayerResponse;
        if (response?.playabilityStatus?.status !== "OK" || response.videoDetails?.videoId !== id ||
            response.videoDetails.isLiveContent || response.streamingData?.licenseInfos?.length) return [];
        const data = response.streamingData;
        const files = [], qualities = [], representations = [];
        for (const [formats,separate] of [[data?.formats,false],[data?.adaptiveFormats,true]]) {
            for (const f of Array.isArray(formats) ? formats.slice(0,128) : []) {
                if (!f || f.drmFamilies?.length || f.drmTrackType || !/^(?:video|audio)\/(?:mp4|webm)\b/i.test(f.mimeType)) continue;
                const quality = {label:String(f.qualityLabel || "").slice(0,48),height:Number(f.height) || 0,fps:Number(f.fps) || 0};
                if (f.mimeType.startsWith("video/")) qualities.push(quality);
                const meta = {...quality,type:f.mimeType.split(";")[0],codecs:String(f.mimeType).slice(0,160),
                    size:Number(f.contentLength) || 0,bitrate:Number(f.averageBitrate || f.bitrate) || 0,separate,defaultAudio:f.audioTrack?.audioIsDefault === true};
                if (separate) representations.push(meta);
                if (!f.url || f.signatureCipher || f.cipher) continue;
                if (!separate && !(f.audioQuality || f.audioChannels || /\b(?:mp4a|opus|vorbis)\b/i.test(f.mimeType))) continue;
                files.push({...meta,url:f.url,label:quality.label || f.audioTrack?.displayName});
            }
        }
        // A finite player session can also deliver the original encoded segments.
        const adaptive = Array.isArray(data?.adaptiveFormats) ? data.adaptiveFormats : [];
        const video = player.querySelector('video.html5-main-video,video');
        const bufferedVideo = video && !video.mediaKeys && video.readyState >= 1 && Number.isFinite(video.duration) &&
            (video.currentSrc || video.src).startsWith('blob:');
        const segments = !adaptive.some(f => f?.drmFamilies?.length || f?.drmTrackType) &&
            !!(bufferedVideo || data?.serverAbrStreamingUrl || data?.dashManifestUrl || data?.hlsManifestUrl || adaptive.some(f => f?.itag && Number(f.height) > 0));
        const manifests = [];
        for (const [playlist,address] of [['dash',data?.dashManifestUrl],['hls',data?.hlsManifestUrl]]) {
            if (typeof address !== 'string' || address.length > 16384) continue;
            try {
                const url = new URL(address);
                if (url.protocol === 'https:' && !url.username && !url.password && /(^|\.)googlevideo\.com$/.test(url.hostname))
                    manifests.push({url:url.href,playlist});
            } catch { /* The native player may still provide the segments. */ }
        }
        return {files,qualities,segments,manifests,representations};
    },
    directSources(entries) {
        const sources = [];
        for (const entry of Array.isArray(entries) ? entries : []) {
            let url;
            try { url = new URL(entry.url); } catch { continue; }
            if (url.protocol !== "https:" || url.username || url.password || !this.isYouTubeMedia(url) || this.isPartialRequest(url,entry) ||
                !/^(audio|video)\/(mp4|webm)$/.test(entry.type)) continue;
            const kind = entry.type.split("/")[0];
            sources.push({url:url.href,kind,type:entry.type,codec:this.codecName(entry.codecs),
                label:kind === "video" ? this.quality(entry.label,entry.height,entry.fps) : String(entry.label || "").slice(0,48),
                size:Number.isSafeInteger(entry.size) && entry.size > 0 ? entry.size : undefined, bitrate:Number(entry.bitrate) || 0,
                fps:Number(entry.fps) || 0,separate:entry.separate === true,defaultAudio:entry.defaultAudio === true});
        }
        return sources;
    },
    isYouTubeMedia(url) {
        return /(^|\.)googlevideo\.com$/i.test(url.hostname) && url.pathname === "/videoplayback";
    },
    isPartialRequest(url,record) {
        return this.isYouTubeMedia(url) && ((record.method && record.method !== "GET") ||
            /(?:yt-ump|sabr)/i.test(record.type || "") || ["range","sq","ump","sabr"].some(key => url.searchParams.has(key)));
    },
    async playlistText(response) {
        const limit = 2 * 1024 * 1024;
        if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit) {
            await response.body?.cancel();
            return '';
        }
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let text = '', length = 0;
        try {
            while (true) {
                const {done,value} = await reader.read();
                if (done) break;
                length += value.length;
                if (length > limit) return '';
                text += decoder.decode(value,{stream:true});
            }
            return text+decoder.decode();
        } finally { await reader.cancel().catch(()=>{}); }
    },
    async manifestVariants(source,signal) {
        const url = new URL(source.url);
        if (url.protocol !== 'https:' || !/(^|\.)googlevideo\.com$/.test(url.hostname) || url.username || url.password) return [];
        const response = await fetch(url,{signal,credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});
        const text = await this.playlistText(response);
        return text ? MediaSources.videoVariants(text,source).slice(0,256) : [];
    }
};
