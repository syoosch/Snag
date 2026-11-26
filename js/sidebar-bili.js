// A Bilibili video can change inside one browser document. The part number is part of its identity.
globalThis.SnagBili = (() => {
    function representation(address) {
        if (typeof address !== "string" || !/\.m4s(?:[?#]|$)/i.test(address)) return;
        let url;
        try { url = new URL(address); } catch { return; }
        if (!/(^|\.)bilivideo\.(com|cn)$/i.test(url.hostname)) return;
        // The CDN can insert a tag such as _qe1 after the numeric content ID.
        const match = /\/((\d+)(?:_[a-z]+\d+)?-(\d+)-(\d+))\.m4s$/i.exec(url.pathname);
        if (!match) return;
        const [,filename,cid,part,rendition] = match;
        const kind = /^302\d{2}$/.test(rendition) ? "audio" : /^(?:30[01]\d{2}|100[01]\d{2})$/.test(rendition) ? "video" : "";
        const key = "bili:" + cid + "-" + part;
        return { key, cid, rendition, kind, identity:"bili:" + filename };
    }

    function videoInfo(route, data) {
        if (!route?.id || !data || (route.id !== data.bvid && route.id.toLowerCase() !== "av" + data.aid)) return;
        const byPart = !route.list || route.explicitPart;
        const pages = data.pages?.length ? data.pages : [data];
        const page = pages.find(item => (!route.cid || String(item.cid) === route.cid) &&
            (byPart ? (item.page ?? 1) === route.part : !!route.cid || Number(data.videos || pages.length) === 1));
        if (!page || !/^\d+$/.test(String(page.cid)) || Number(page.cid) <= 0) return;
        const title = data.pages?.length > 1 || data.videos > 1 ? [data.title, page.part].filter(Boolean).join(" · ") : data.title;
        return { route:route.key, id:route.id, cid:String(page.cid), title:String(title || "").slice(0,200),
            poster:/^https?:\/\//i.test(data.pic || "") ? data.pic : "", duration:Number(page.duration) || 0 };
    }

    function episodeInfo(route, page = {}, catalog) {
        const active = page.active || {};
        const id = route.episodeId || active.epId || (!active.cid && page.canonicalEp);
        const belongs = item => item && /^[1-9]\d*$/.test(String(item.cid)) && /^[1-9]\d*$/.test(String(item.epId)) &&
            (!id || String(item.epId) === String(id)) && (route.episodeId || String(item.seasonId) === route.seasonId &&
                (!active.cid || String(item.cid) === String(active.cid)));
        let item = (page.entries || []).find(belongs);
        let series = page.series, poster = page.poster;
        if ((!item?.index && !item?.subtitle) && catalog && (!route.seasonId || String(catalog.season_id) === route.seasonId)) {
            const episodes = [...(catalog.episodes || []),...(catalog.section || []).flatMap(section => section.episodes || [])];
            const match = episodes.find(ep => (!route.episodeId && active.cid) ? String(ep.cid) === String(active.cid) : String(ep.id) === String(id));
            const entry = match && {cid:match.cid,epId:match.id,seasonId:catalog.season_id,index:match.title,
                subtitle:match.long_title,cover:match.cover};
            if (belongs(entry)) { item = entry; series = catalog.season_title || catalog.title; poster = catalog.cover; }
        }
        if (!item && belongs(active)) item = active;
        if (!item) return;
        const index = String(item.index || "");
        const label = /^\d+(?:\.\d+)?$/.test(index) ? chrome.i18n.getMessage("sideEpisode",index) : index;
        const title = label || item.subtitle ? [series,label,item.subtitle].filter(Boolean).join(" · ") : page.title || series;
        const cover = String(item.cover || poster || "").replace(/^\/\//,"https://")
            .replace(/^http:(?=\/\/(?:[\w-]+\.)*hdslb\.com\/)/i,"https:");
        return {route:route.key,cid:String(item.cid),episodeId:String(item.epId),episodeLabel:label || item.subtitle,
            title:String(title || "").slice(0,200),
            poster:/^https?:\/\//i.test(cover) ? cover : "",duration:page.playerDuration || item.duration || 0};
    }

    function tracks(dash) {
        const sources = [];
        function add(track, kind) {
            if (!track) return;
            const label = kind === "video" && track.height > 0 ? track.height + "p" : "";
            const codec = SnagPlayer.codecName(track.codecs);
            const [rate, divisor = 1] = String(track.frameRate || track.frame_rate || "").split("/").map(Number);
            const fps = kind === "video" && rate/divisor > 0 && rate/divisor < 1000 ? Math.round(100*rate/divisor)/100 : 0;
            for (const address of [track.baseUrl || track.base_url, ...(track.backupUrl || track.backup_url || [])]) {
                if (!address) continue;
                const url = address.startsWith("//") ? "https:" + address : address;
                if (/^https?:\/\//i.test(url)) sources.push({ url, kind, label, codec, fps, bitrate:Number(track.bandwidth) || 0,
                    qualityId:kind === "video" && Number(track.id) > 0 ? Number(track.id) : undefined,
                    size:Number.isSafeInteger(track.size) && track.size > 0 ? track.size : undefined });
            }
        }
        for (const track of dash?.video || []) add(track,"video");
        for (const track of dash?.audio || []) add(track,"audio");
        add(dash?.flac?.audio,"audio");
        for (const track of dash?.dolby?.audio || []) add(track,"audio");
        return sources;
    }
    function playingTracks(urls, cid, qualityId) {
        if (!(qualityId > 0)) return [];
        if (urls?.length === 1) {
            let direct;
            try { direct = new URL(urls[0]); } catch { return []; }
            if (/^https?:$/.test(direct.protocol) && /(^|\.)bilivideo\.(com|cn)$/i.test(direct.hostname) && /\.(mp4|webm|flv)$/i.test(direct.pathname)) {
                return [{url:direct.href,kind:"video",qualityId,episodeCid:cid}];
            }
        }
        return (urls || []).flatMap((url,i) => {
            const rep = representation(url), kind = i === 0 ? "video" : "audio";
            if (rep?.cid !== cid || rep.kind && rep.kind !== kind) return [];
            return [{url,kind,...(i === 0 ? {qualityId} : {})}];
        });
    }
    function mergeTrack(prior,source) {
        if (!prior) return source;
        const merged = {...prior,...source};
        for (const field of ["qualityId","label","codec","fps","bitrate","size"]) {
            if (!source[field] && prior[field]) merged[field] = prior[field];
        }
        // During a player switch its reported quality can change before the file address.
        if (prior.qualityId && !source.label && !source.codec) merged.qualityId = prior.qualityId;
        return merged;
    }
    // Keep previously seen tiers of the same part, refreshing signed addresses per CDN.
    function mergeTracks(previous, additions) {
        const known = new Map();
        for (const source of [...previous,...additions]) {
            const address = new URL(source.url);
            const identity = representation(source.url)?.identity || source.qualityId + ":" + address.pathname;
            const key = identity + "@" + address.host;
            known.set(key,mergeTrack(known.get(key),source));
        }
        return [...known.values()];
    }
    // Runs in the page's world. Return only public player metadata needed for this part.
    function readPlayer(route, knownCid) {
        const state = window.__INITIAL_STATE__;
        const data = state?.videoData;
        const player = window.player;
        const read = method => { try { return player?.[method]?.(); } catch { /* Player not ready. */ } };
        const active = read("getVideoInfo"), manifest = read("getManifest");
        const main = document.querySelector("#bilibili-player video,.bpx-player-video-wrap video");
        const liveCid = manifest?.cid || active?.cid;
        const bvid = manifest?.bvid || active?.bvid, aid = manifest?.aid || active?.aid;
        const livePart = Number(active?.p || manifest?.p);
        const matches = item => route.id && item && (item.bvid === route.id || "av" + item.aid === route.id.toLowerCase());
        const comparableId = item => /^av/i.test(route.id) ? item?.aid : item?.bvid;
        let selection, pending = false;
        if (route.list) {
            // A queue can reuse the URL, video element and even the title. Only the current player can select a row.
            const entry = liveCid && data?.pages?.find(item => String(item.cid) === String(liveCid));
            const initialOwner = liveCid && (entry || String(data?.cid) === String(liveCid)) && data;
            // A CID-only player can identify its video through the site's own list for that exact part.
            const owner = bvid || aid ? {bvid,aid} : initialOwner || (liveCid && window.__snagBiliList?.(liveCid));
            const id = /^BV[0-9A-Za-z]+$/i.test(owner?.bvid || "") ? owner.bvid :
                /^[1-9]\d*$/.test(owner?.aid || "") ? "av" + owner.aid : "";
            const reportedPart = livePart || entry?.page;
            const disagrees = field => manifest?.[field] && active?.[field] && String(manifest[field]) !== String(active[field]);
            pending = !main || !!(disagrees("cid") || disagrees("bvid") || disagrees("aid") ||
                (route.id && comparableId(owner) && !matches(owner)) || (route.cid && liveCid && route.cid !== String(liveCid)) ||
                (route.explicitPart && reportedPart && route.part !== reportedPart));
            if (!pending && (id || route.id) && /^[1-9]\d*$/.test(liveCid || "")) {
                // With a URL ID and only a player CID, videoInfo still requires public metadata to match both.
                selection = {id:route.id || id,cid:String(liveCid),part:reportedPart || route.part};
                route = {...route,...selection};
            }
        }
        const {part} = route;
        const page = data?.pages?.find(item => route.cid ? String(item.cid) === route.cid : item.page === part);
        const info = data && { bvid:data.bvid, aid:data.aid, cid:data.pages?.length ? page?.cid : data.cid, title:data.title, pic:data.pic,
            duration:data.duration, videos:data.pages?.length || data.videos, pages:page ? [{ page:page.page, part:page.part, cid:page.cid, duration:page.duration }] : [] };
        let playing;
        function track(item) {
            if (!item) return;
            return { id:item.id, baseUrl:item.baseUrl || item.base_url, backupUrl:(item.backupUrl || item.backup_url || []).slice(0,4),
                height:item.height, codecs:item.codecs, frameRate:item.frameRate || item.frame_rate, bandwidth:item.bandwidth, size:item.size };
        }
        function playbackStatus(supported) {
            const quality = read("getQuality"), address = read("getMediaInfo")?.playUrl;
            return {qualityId:Number(quality?.realQ) || Number(quality?.nowQ) || 0,
                urls:typeof address === "string" ? address.split(/,(?=https?:\/\/)/i).slice(0,2) : [],
                canSwitch:Array.isArray(supported) && supported.length > 0 && typeof player?.requestQuality === "function" &&
                    typeof player.getQuality === "function" && typeof player.getMediaInfo === "function"};
        }
        let videoInfo = window.__playinfo__?.data;
        let dash = videoInfo?.dash, episode, supported, menuCid, playback;
        if (route.bangumi) {
            const result = window.__PLAYURL_HYDRATE_DATA__?.result;
            const business = result?.play_view_business_info;
            const details = result?.supplement?.ogv_episode_info;
            const vid = result?.video_info;
            const legacy = state?.epInfo, media = state?.mediaInfo;
            const meta = key => document.querySelector('meta[property="og:' + key + '"]')?.content;
            const live = {cid:manifest?.cid || active?.cid,epId:manifest?.episodeId || active?.epId || active?.epid || active?.ep_id,
                seasonId:manifest?.seasonId || active?.seasonId || active?.season_id};
            const first = {cid:business?.episode_info?.cid || result?.arc?.cid,epId:details?.episode_id || business?.episode_info?.ep_id,
                seasonId:result?.supplement?.ogv_season_info?.season_id || business?.season_info?.season_id,
                index:details?.index_title,subtitle:details?.long_title,duration:vid?.is_preview ? 0 : (Number(vid?.timelength) || 0)/1000};
            episode = {active:live,entries:[first,legacy && {cid:legacy.cid,epId:legacy.id || legacy.ep_id,
                seasonId:legacy.season_id || media?.season_id,index:legacy.title,subtitle:legacy.long_title || legacy.longTitle,cover:legacy.cover}],
                series:meta("title") || media?.season_title || media?.title,poster:meta("image") || media?.cover,
                title:(document.querySelector("#player-title h1,h1")?.textContent || document.title).trim().slice(0,200),
                canonicalEp:/\/bangumi\/play\/ep(\d+)\/?(?:[?#]|$)/i.exec(meta("url") || "")?.[1],
                playerDuration:Number.isFinite(main?.duration) ? main.duration : 0};
            const sameEpisode = !live.cid || String(live.cid) === String(first.cid);
            videoInfo = active?.video_info || (sameEpisode ? vid : null);
            const protectedMedia = !!(main?.mediaKeys || videoInfo?.is_drm);
            dash = protectedMedia || videoInfo?.is_preview ? null : active?.video_info?.dash || active?.dash || (sameEpisode && vid?.dash) || dash;
            supported = read("getSupportedQualityList");
            if (manifest?.cid && !protectedMedia) {
                const status = playbackStatus(supported);
                // The initial HTML can still describe a short MP4 preview after the player has loaded the full DASH episode.
                const previewMs = videoInfo?.is_preview && Array.isArray(videoInfo.durl)
                    ? videoInfo.durl.reduce((sum,part) => sum + (Number(part.length) || 0),0) : 0;
                const fullMs = Number(videoInfo?.timelength);
                const fullPlayback = previewMs > 0 && fullMs > previewMs+2000 && Math.abs(1000*episode.playerDuration-fullMs) <= 2000 &&
                    /\.m4s(?:[?#]|$)/i.test(status.urls[0] || "");
                if (!videoInfo?.is_preview || fullPlayback) playback = status;
            }
            menuCid = live.cid || first.cid || legacy?.cid;
        } else {
            const initialCid = matches(data) && (page?.cid || (part === 1 && !data.pages?.length && data.cid));
            const expectedCid = route.cid || knownCid || initialCid;
            const liveOwner = {bvid,aid};
            const sameOwner = matches(liveOwner) || (route.list && !comparableId(liveOwner) &&
                [knownCid,initialCid].some(cid => cid && String(cid) === String(liveCid)));
            const samePart = !pending && liveCid && (!expectedCid || String(liveCid) === String(expectedCid)) &&
                (bvid || aid ? sameOwner && (livePart ? livePart === part : part === 1 || !!expectedCid) : !!expectedCid);
            if (samePart) {
                const title = active?.title || (!route.list && document.querySelector("h1.video-title,h1")?.textContent.trim());
                playing = {bvid,aid,title:title || "",pages:[{page:part,cid:liveCid}]};
            }
            const cid = String(expectedCid || (samePart && liveCid) || "");
            const observed = cid && window.__snagBiliList?.(cid);
            const liveInfo = samePart && active?.video_info;
            const initial = videoInfo;
            // Page globals can update independently during autoplay. Verify a DASH file's part before using its menu.
            const firstVideo = initial?.dash?.video?.[0];
            const firstUrl = firstVideo?.baseUrl || firstVideo?.base_url;
            const initialMatches = firstUrl ? /\/(\d+)(?:_[a-z]+\d+)?-\d+-\d+\.m4s(?:[?#]|$)/i.exec(firstUrl)?.[1] === cid :
                !!initialCid && String(initialCid) === cid;
            videoInfo = observed || liveInfo || (initialMatches && initial);
            const protectedMedia = main?.mediaKeys || liveInfo?.is_drm || liveInfo?.is_preview || (initialMatches && (initial?.is_drm || initial?.is_preview));
            dash = protectedMedia ? null : videoInfo?.dash || (samePart && (active?.dash || manifest?.dash)) || initial?.dash;
            menuCid = protectedMedia ? null : cid;
            if (samePart && !protectedMedia) {
                supported = read("getSupportedQualityList");
                playback = playbackStatus(supported);
            }
        }
        const names = new Map();
        for (const [i,id] of (videoInfo?.accept_quality || []).entries()) names.set(Number(id),videoInfo.accept_description?.[i]);
        for (const item of videoInfo?.support_formats || []) {
            names.set(Number(item.quality),item.new_description || item.description ||
                [item.display_desc,item.superscript].filter(Boolean).join(" ") || names.get(Number(item.quality)));
        }
        const ids = Array.isArray(supported) && supported.length ? supported.map(Number) : [...names.keys()];
        const formats = [...new Set(ids)].filter(id => Number.isSafeInteger(id) && id > 0).slice(0,64)
            .map(id => ({id,name:String(names.get(id) || "").slice(0,64)}));
        return { page:location.href, knowsRoute:typeof snagBiliRoute === "function", observesLists:typeof window.__snagBiliList === "function",
            selection, pending, info, playing, episode, menuCid, playback, formats, dash:dash && {
            duration:dash.duration,
            video:dash.video?.slice(0,128).map(track), audio:dash.audio?.slice(0,32).map(track),
            flac:{audio:track(dash.flac?.audio)}, dolby:{audio:dash.dolby?.audio?.slice(0,16).map(track)} } };
    }
    // Runs only after a user chooses a site tier that has no identified file yet.
    async function requestQuality(cid, episodeId, qualityId, routeKey) {
        const player = window.player;
        const samePart = () => {
            const route = typeof snagBiliRoute === "function" && snagBiliRoute(location.href);
            if (!route || route.key !== routeKey) return false;
            const state = player?.getManifest?.();
            const main = document.querySelector("#bilibili-player video,.bpx-player-video-wrap video");
            if (main?.mediaKeys) return false;
            if (!episodeId) {
                const active = player?.getVideoInfo?.();
                return !route.bangumi && (!route.list || main) && String(state?.cid || active?.cid) === cid &&
                    (!active?.cid || String(active.cid) === cid) &&
                    !active?.video_info?.is_drm && !active?.video_info?.is_preview;
            }
            if (!route.bangumi ||
                String(state?.cid) !== cid || state.episodeId && String(state.episodeId) !== episodeId) return false;
            const result = window.__PLAYURL_HYDRATE_DATA__?.result;
            const info = String(result?.arc?.cid) === cid ? result?.video_info : null;
            return !info?.is_drm;
        };
        const rendered = () => {
            const status = player.getQuality?.();
            return Number(status?.realQ) || Number(status?.nowQ);
        };
        const urls = () => String(player.getMediaInfo?.()?.playUrl || "").split(/,(?=https?:\/\/)/i).slice(0,2);
        if (!samePart() || !player?.getSupportedQualityList?.()?.map(Number).includes(qualityId)) return;
        const fileKey = url => {
            try {
                const parsed = new URL(url);
                return /\.m4s$/i.test(parsed.pathname) ? parsed.pathname.split("/").pop() : parsed.pathname + parsed.search;
            } catch { return ""; }
        };
        const old = rendered(), before = fileKey(urls()[0]);
        const deadline = Date.now()+12000;
        let timer;
        try {
            if (old !== qualityId) await Promise.race([player.requestQuality(qualityId),
                new Promise((_,reject) => { timer = setTimeout(() => reject(Error("timeout")),12000); })]);
            if (!player.getMediaInfo || !player.getQuality) return;
            while (samePart() && Date.now() < deadline) {
                const result = urls();
                if (rendered() === qualityId && result[0] && (old === qualityId || fileKey(result[0]) !== before)) return result;
                await new Promise(resolve => setTimeout(resolve,150));
            }
        } catch { /* The website decides whether this quality is playable for this viewer. */ }
        finally { clearTimeout(timer); }
    }
    return { route:snagBiliRoute, representation, videoInfo, episodeInfo, tracks, playingTracks, mergeTrack, mergeTracks, readPlayer, requestQuality };
})();
