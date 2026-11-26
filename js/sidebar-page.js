// Page scanning starts when a sidebar connects. Binary response hints live only in this document.
(() => {
    if (globalThis.__snagSidebarPage === chrome.runtime.onConnect) return;
    globalThis.__snagSidebarPage = chrome.runtime.onConnect;
    const mediaSelector = 'video,audio,img,a[download],a[href*=".pdf" i]';
    const nodeIds = new WeakMap();
    const thumbnails = new WeakMap();
    const youtubeSettings = new WeakMap();
    const publishers = new Map();
    const segmentSamples = new Map();
    const codecProbes = new Map();
    const audioSamples = globalThis.__snagAudioSamples = new Map();
    let nextId = 0;
    let lastScan, confirmed, liveSources = [];
    const navigation = performance.getEntriesByType("navigation")[0];
    const playbackRoute = url => SnagBili.route(url)?.key || SnagPlayer.youtubeId(url);
    const initialRoute = playbackRoute(navigation?.name);
    let timingRoute = initialRoute, routeStarted = 0;

    function updateTimingRoute() {
        const route = playbackRoute(location.href);
        if (route !== timingRoute) { timingRoute = route; routeStarted = performance.now(); }
    }

    function webUrl(value, allowBlob = false) {
        if (typeof value !== "string" || !value.trim()) return "";
        try {
            const url = new URL(value, document.baseURI);
            return /^(https?:)$/.test(url.protocol) || (allowBlob && url.protocol === "blob:") ? url.href : "";
        } catch { return ""; }
    }
    function rememberSegment(url,video) {
        if (!url || segmentSamples.has(url) && (!video || segmentSamples.get(url))) return false;
        segmentSamples.set(url,video);
        if (segmentSamples.size > 48) segmentSamples.delete(segmentSamples.keys().next().value);
        return true;
    }

    async function readLeafCodec(url,range,life) {
        const offset = range?.offset || 0;
        if (offset >= SnagFormat.probeLimit) return "";
        const prefix = new Uint8Array(Math.min(SnagFormat.probeLimit,range ? offset + range.length : SnagFormat.probeLimit));
        const controller = new AbortController(), abort = () => controller.abort();
        const timer = setTimeout(abort,3000);
        life.addEventListener("abort",abort,{once:true});
        let reader, used = 0;
        try {
            const response = await fetch(url,{cache:"force-cache",redirect:"error",signal:controller.signal});
            if (!response.ok || !response.body) return "";
            // A BYOB reader limits even the last read when the browser already buffered a much larger block.
            reader = response.body.getReader({mode:"byob"});
            while (used < prefix.length) {
                const {value,done} = await reader.read(new Uint8Array(prefix.length-used));
                if (done) break;
                prefix.set(value,used); used += value.byteLength;
            }
        } catch { return ""; }
        finally {
            reader?.cancel().catch(() => {});
            abort(); clearTimeout(timer);
            life.removeEventListener("abort",abort);
        }
        return SnagFormat.probeCodec(prefix.subarray(offset,used));
    }

    const scriptCache = new Map();
    function inlineData(name) {
        const prefix = new RegExp("^(?:window\\.)?" + name + "\\s*=\\s*");
        for (const script of document.scripts) {
            if (script.src) continue;
            const text = script.textContent.trim(), start = prefix.exec(text);
            if (!start || text.length > 2_000_000) continue;
            const cached = scriptCache.get(name);
            if (cached?.text === text) return cached.data;
            try {
                const data = JSON.parse(text.slice(start[0].length).split(/;\s*\(function\s*\(/,1)[0].replace(/;\s*$/, ""));
                scriptCache.set(name,{text,data});
                return data;
            } catch { return; }
        }
    }
    function mainPlayer(node) {
        if (!SnagBili.route(location.href) || !node.closest("#bilibili-player,.bpx-player-video-wrap")) return false;
        const players = document.querySelectorAll("#bilibili-player video,.bpx-player-video-wrap video");
        if (players.length === 1) return players[0] === node;
        const visible = [...players].filter(player => player.readyState >= 1 && player.checkVisibility?.() && player.getClientRects().length);
        return visible.length === 1 && visible[0] === node;
    }
    function videoPage() {
        return location.hash && SnagBili.route(location.href)?.fragment ? location.href : location.href.split("#")[0];
    }
    function pageInfo() {
        const route = SnagBili.route(location.href);
        if (!route) return;
        if (confirmed?.route === route.key) return confirmed;
        if (route.list) return;
        return SnagBili.videoInfo(route,inlineData("__INITIAL_STATE__")?.videoData);
    }
    function declaredTracks(video) {
        if (!mainPlayer(video)) return [];
        const route = SnagBili.route(location.href);
        const info = pageInfo();
        if (!info && (route.list || route.bangumi || route.key !== initialRoute)) return [];
        const dash = !route.bangumi && inlineData("__playinfo__")?.data?.dash;
        const sameDuration = !dash?.duration || !Number.isFinite(video.duration) || Math.abs(dash.duration-video.duration) <= 2;
        const sources = sameDuration ? SnagBili.tracks(dash) : [];
        if (confirmed?.route === route.key && liveSources.length) {
            const seen = new Set(sources.map(source => source.url));
            for (const source of liveSources) if (!seen.has(source.url)) sources.push(source);
        }
        return info ? sources.filter(source => source.episodeCid === info.cid || SnagBili.representation(source.url)?.cid === info.cid) : sources;
    }
    function useContext(message) {
        if (message.info === null && message.route === SnagBili.route(location.href)?.key) {
            confirmed = null; liveSources = []; return;
        }
        if (!message.info || message.info.route !== SnagBili.route(location.href)?.key) return;
        confirmed = message.info;
        if (Array.isArray(message.sources)) liveSources = message.sources;
    }

    function videoThumbnail(node) {
        const poster = webUrl(node.poster);
        if (poster || node.mediaKeys || node.readyState < 2 || !node.videoWidth) return poster;
        const previous = thumbnails.get(node);
        const route = SnagBili.route(location.href)?.key;
        const cid = confirmed?.route === route ? confirmed?.cid : null;
        if (previous?.src === node.currentSrc && previous.route === route && previous.cid === cid) return previous.url;
        let url = "";
        try {
            const canvas = document.createElement("canvas");
            canvas.width = 240;
            canvas.height = Math.min(320, Math.max(1, Math.round(240 * node.videoHeight / node.videoWidth)));
            canvas.getContext("2d").drawImage(node, 0, 0, canvas.width, canvas.height);
            url = canvas.toDataURL("image/jpeg", 0.68);
        } catch { /* Some cross-origin videos only expose their poster. */ }
        thumbnails.set(node, { src: node.currentSrc, route, cid, url });
        return url;
    }

    function playerContainer(node) {
        for (let element = node; element; element = element.getRootNode().host) {
            const container = element.closest('[id^="playerDiv_"],[data-video-id]');
            if (container) return container;
        }
    }
    function describe(node) {
        const tag = node.localName;
        if (tag === "a" && !node.hasAttribute("download") && !/\.pdf(?:[?#]|$)/i.test(node.href)) return;
        const kind = { img: "image", a: "other" }[tag] || tag;
        const current = node.srcObject ? "" : webUrl(node.currentSrc || node.getAttribute("src") || node.getAttribute("href"), true);
        const sources = current ? [{ url: current, label: "" }] : [];
        if (tag === "video" || tag === "audio") {
            // An assigned src or srcObject takes precedence over <source> children left over from the ad.
            if (!node.srcObject && !node.hasAttribute("src")) {
                for (const source of node.querySelectorAll(":scope > source[src]")) {
                    const url = webUrl(source.getAttribute("src"));
                    if (url) sources.push({url, htmlSource:true, label:(source.getAttribute("label") || source.dataset.quality || "").slice(0,48),
                        type:source.type.split(";")[0].trim().toLowerCase(),codec:SnagPlayer.codecName(source.type)});
                }
            }
            if (tag === "video") sources.push(...declaredTracks(node));
        }
        if (!nodeIds.has(node)) nodeIds.set(node, ++nextId);
        const figure = node.closest("figure");
        const captionId = node.getAttribute("aria-labelledby");
        const player = tag === "video" && node.closest("#movie_player");
        const ad = !!player && player.matches(".ad-showing,.ad-interrupting");
        const playingAd = ad && [...player.querySelectorAll("video")].find(video => !video.paused && !video.ended && video.readyState >= 1);
        const youtubeId = player && (playingAd || player.querySelector("video.html5-main-video") || player.querySelector("video")) === node ?
            SnagPlayer.youtubeId(location.href) : "";
        let qualitySetting = "", menuQualities;
        if (youtubeId && !ad) {
            const menu = player.querySelector(".ytp-settings-menu");
            const labels = nodes => Array.from(nodes || [], n => SnagPlayer.quality(n.textContent)).filter(Boolean);
            qualitySetting = labels(menu?.querySelectorAll('.ytp-quality-menu [aria-checked="true"] .ytp-menuitem-label, .ytp-menuitem-content'))[0] || "";
            if (qualitySetting) youtubeSettings.set(node,{id:youtubeId,qualitySetting});
            else if (youtubeSettings.get(node)?.id === youtubeId) qualitySetting = youtubeSettings.get(node).qualitySetting;
            menuQualities = labels(menu?.querySelectorAll(".ytp-quality-menu .ytp-menuitem-label"));
        }
        const caption = captionId && captionId.trim().split(/\s+/).map(id =>
            (node.getRootNode().getElementById?.(id) || document.getElementById(id))?.textContent).filter(Boolean).join(" ");
        const title = node.getAttribute("aria-label") || caption || node.title || node.alt ||
            figure?.querySelector("figcaption")?.textContent || (tag === "a" ? node.textContent : "");
        const container = tag === "video" && playerContainer(node);
        const streamId = container && (/^playerDiv_(\d+)$/.exec(container.id)?.[1] || container.dataset.videoId);
        const currentSlot = tag === "video" && node.matches(".dplayer-video") &&
            node.parentElement?.querySelector(":scope > video.dplayer-video-current");
        return {
            id: nodeIds.get(node), kind, sources, current, biliMain:tag === "video" && mainPlayer(node),
            page: tag === "video" ? videoPage() : undefined,
            playing: (tag === "video" || tag === "audio") && !node.paused && !node.ended && node.readyState >= 1,
            stream: tag === "video" && (!current || current.startsWith("blob:") || !!node.srcObject) &&
                (!node.paused || node.getClientRects().length > 0),
            protectedMedia: !!node.mediaKeys,
            streamId: /^\d{1,20}$/.test(streamId) ? streamId : undefined,
            inactiveSlot: !!currentSlot && currentSlot !== node,
            objectStream: !!globalThis.MediaStream && node.srcObject instanceof MediaStream,
            youtubeId, ad: !!youtubeId && ad, qualitySetting, menuQualities,
            loaded: tag === "a" || (tag === "img" ? node.complete && node.naturalWidth > 0 : node.readyState >= 1),
            title: (title || "").trim().slice(0, 160),
            poster: tag === "video" ? videoThumbnail(node) : "",
            width: node.videoWidth || node.naturalWidth || 0,
            height: node.videoHeight || node.naturalHeight || 0,
            duration: Number.isFinite(node.duration) ? node.duration : 0
        };
    }

    function fromSidebar(sender) {
        return sender?.id === chrome.runtime.id && sender.url?.split("?")[0] === chrome.runtime.getURL("sidebar.html");
    }

    function manifestFile(entry) {
        const type = (entry.contentType || "").split(";")[0].trim().toLowerCase();
        const typed = /^(?:audio|application)\/(?:x-mpegurl|mpegurl|vnd\.apple\.mpegurl|octet-stream-m3u8|dash\+xml)$/.test(type);
        if (!typed && !/\.(?:m3u8|mpd)(?:[?#]|$)/i.test(entry.name)) return;
        const url = webUrl(entry.name);
        if (!url || entry.responseStatus >= 400) return;
        if (!typed && !/\.(?:m3u8|mpd)$/i.test(new URL(url).pathname)) return;
        return {url,kind:"video",type:typed ? type : ""};
    }

    function discoverShadowRoots(scope,depth,roots,added) {
        if (depth >= 6 || roots.size >= 64) return;
        const walker = document.createTreeWalker(scope,NodeFilter.SHOW_ELEMENT);
        for (let node = scope.nodeType === 1 ? scope : walker.nextNode(); node && roots.size < 64; node = walker.nextNode()) {
            const root = node.shadowRoot;
            if (!root || roots.has(root)) continue;
            roots.set(root,depth+1);
            added?.(root);
            discoverShadowRoots(root,depth+1,roots,added);
        }
    }
    function mediaElements(roots) {
        const result = new Set(document.querySelectorAll(mediaSelector));
        for (const root of roots.keys()) for (const node of root.querySelectorAll(mediaSelector)) result.add(node);
        return result;
    }
    function pageReferrerPolicy() {
        const policies = document.querySelectorAll('meta[name="referrer" i]');
        for (let i = policies.length-1; i >= 0; i--) {
            const value = policies[i].content.trim().toLowerCase();
            if (value) return value;
        }
        return document.referrerPolicy || "";
    }
    // Read only the current document and its completed requests. Scanning never starts playback or fetches a file.
    function scanPage(roots) {
        updateTimingRoute();
        const info = pageInfo();
        const files = new Map();
        for (const entry of performance.getEntriesByType("resource")) {
            const url = webUrl(entry.name);
            if (!url || entry.responseStatus >= 400) continue;
            if (timingRoute && entry.startTime < routeStarted &&
                !(info && SnagBili.representation(url)?.cid === info.cid)) continue;
            const kind = { img:"image", image:"image", video:"video", audio:"audio" }[entry.initiatorType];
            const type = (entry.contentType || "").split(";")[0].toLowerCase();
            const mediaType = /^(?:image\/|audio\/|video\/|application\/(?:pdf|dash\+xml|x-mpegurl|vnd\.apple\.mpegurl)$)/.test(type);
            const streamed = /^(fetch|xmlhttprequest|link)$/.test(entry.initiatorType) &&
                /\.(?:m3u8|mpd|m4s|ts|m2ts|mp4|webm|mov|mkv|mp3|m4a|aac|ogg|opus|wav|flac|pdf)$/i.test(new URL(url).pathname);
            if (kind || mediaType || streamed) {
                files.set(url, { url, kind:kind || "other", type:mediaType ? type : "",
                    size:entry.responseStatus === 200 && entry.encodedBodySize > 0 ? entry.encodedBodySize : undefined });
            }
        }
        const declared = [];
        for (const node of mediaElements(roots)) {
            const item = describe(node);
            if (!item) continue;
            if (item.loaded && /^https?:\/\//i.test(item.current)) {
                files.set(item.current, { ...files.get(item.current), url:item.current, kind:item.kind });
            }
            if (item.biliMain) declared.push(...item.sources);
        }
        // The verified part list can arrive before the actual player. Keep one address per rendition.
        if (info && info.route === confirmed?.route) declared.push(...liveSources);
        const seen = new Set([...files.keys()].map(url => SnagBili.representation(url)?.identity).filter(Boolean));
        for (const source of declared) {
            const rep = SnagBili.representation(source.url);
            if (source.episodeCid && source.episodeCid === info?.cid) {
                if (!files.has(source.url)) files.set(source.url,{url:source.url,kind:source.kind});
                continue;
            }
            if (!rep || seen.has(rep.identity) || (info && rep.cid !== info.cid)) continue;
            files.set(source.url,{ url:source.url,kind:source.kind,size:source.size });
            seen.add(rep.identity);
        }
        return [...files.values()];
    }
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
        if (message.Message === "sidebarBinarySample") {
            if (sender.id !== chrome.runtime.id || sender.tab || !(message.time >= performance.timeOrigin) ||
                !/^https?:$/.test(location.protocol) || playbackRoute(location.href)) return;
            const url = webUrl(message.url);
            if (url && SnagFormat.segmentSample(url,"application/octet-stream",true) && rememberSegment(url,false)) {
                for (const queue of publishers.values()) queue();
            }
            return;
        }
        if (message.Message !== "sidebarScanPage" || !fromSidebar(sender)) return;
        useContext(message);
        const roots = new Map();
        discoverShadowRoots(document,0,roots);
        for (const publish of publishers.keys()) publish(roots);
        const files = scanPage(roots);
        lastScan = { page:location.href, files };
        respond(files);
    });

    chrome.runtime.onConnect.addListener(port => {
        if (port.name !== "snag-sidebar" || !fromSidebar(port.sender)) return;
        const life = new AbortController();
        updateTimingRoute();
        window.navigation?.addEventListener("currententrychange",updateTimingRoute,{signal:life.signal});
        window.addEventListener("popstate",updateTimingRoute,{signal:life.signal});
        const nodes = new Map();
        const pickedInShadow = new Set();
        const shadowRoots = new Map();
        const filePreviews = new Map();
        const manifests = new Map();
        const observedSlots = new WeakSet();
        const slotObserver = new MutationObserver(queue);
        let watchingStream = false;
        let watchedPlayer, watchedMenu, menuVideoId, menuQualities = [], watchRevision = 0;
        const menuObserver = new MutationObserver(queue);
        let pending, hideTimer, outline, highlighted, previewCanvas, audioRoot, previous = "", picking = false;
        const adObserver = new MutationObserver(() => {
            const ad = watchedPlayer?.matches(".ad-showing,.ad-interrupting");
            if (ad === lastAd) return;
            lastAd = ad;
            for (const video of watchedPlayer.querySelectorAll("video")) thumbnails.delete(video);
            queue();
        });
        let lastAd = false;

        function releasePreview(request) {
            const player = filePreviews.get(request);
            if (!player) return;
            filePreviews.delete(request);
            audioSamples.delete(request);
            player.pause();
            player.removeAttribute("src");
            player.load();
            player.remove();
            if (audioRoot && !audioRoot.childNodes.length) { audioRoot.host.remove(); audioRoot = null; }
        }
        function filePlayer(request, url, id, kind) {
            if (filePreviews.has(request)) return filePreviews.get(request);
            // Only read an address already loaded by this document, under its normal media/CORS policy.
            if (!/^https?:\/\//i.test(url)) return;
            if (!performance.getEntriesByName(url,"resource").length && !describeSourcesMatch(nodes.get(id),url)) return;
            const audio = kind === "audio";
            const player = document.createElement(audio ? "audio" : "video");
            player.muted = !audio;
            player.playsInline = true;
            player.preload = "metadata";
            if (audio) {
                // Keep the sample connected for browsers that defer detached media. Hide it from the page's player list.
                if (!audioRoot) {
                    const host = document.createElement("span");
                    host.hidden = true;
                    audioRoot = host.attachShadow({mode:"closed"});
                    document.documentElement.append(host);
                }
                audioRoot.append(player);
                audioSamples.set(request,player);
            }
            else player.crossOrigin = "anonymous";
            if (!audio) player.addEventListener("loadedmetadata", () => {
                if (player.readyState < 2 && player.duration > 0) player.currentTime = Math.min(0.01,player.duration/2);
            },{once:true});
            player.src = url;
            filePreviews.set(request,player);
            if (audio) player.load();
            return player;
        }
        function describeSourcesMatch(node,url) {
            const track = SnagBili.representation(url);
            // This sidebar may still hold the captured request after the timing buffer evicted it.
            if (track && pageInfo()?.cid === track.cid) return true;
            if (node?.localName !== "video") return false;
            const item = describe(node);
            return item.sources.some(source => source.url === url ||
                (track && track.identity === SnagBili.representation(source.url)?.identity));
        }

        function publish(scannedRoots) {
            clearTimeout(pending);
            pending = null;
            pruneShadowRoots();
            if (scannedRoots) for (const [root,depth] of scannedRoots) {
                if (!shadowRoots.has(root) && shadowRoots.size < 64) {
                    shadowRoots.set(root,depth);
                    observeShadow(root);
                }
            }
            const list = [], all = mediaElements(shadowRoots);
            for (const node of pickedInShadow) {
                if (node.isConnected) all.add(node);
                else pickedInShadow.delete(node);
            }
            nodes.clear();
            for (const node of all) {
                const item = describe(node);
                if (!item) continue;
                if (node.matches("video.dplayer-video") && !observedSlots.has(node)) {
                    observedSlots.add(node);
                    slotObserver.observe(node,{attributes:true,attributeFilter:["class"]});
                }
                nodes.set(item.id, node);
                list.push(item);
            }
            const videos = list.filter(item => item.kind === "video");
            watchingStream = !playbackRoute(location.href) && videos.some(item => item.stream && !item.objectStream && !item.protectedMedia);
            const primary = videos.find(item => item.youtubeId);
            if (primary?.ad || primary?.youtubeId !== menuVideoId) {
                menuVideoId = primary?.youtubeId;
                menuQualities = [];
            }
            if (primary && !primary.ad) {
                if (primary.menuQualities.length) menuQualities = primary.menuQualities;
                else primary.menuQualities = menuQualities;
            }
            const pageTitle = document.title.trim();
            if (primary && !primary.title && pageTitle) primary.title = pageTitle.replace(/\s+[-–]\s+YouTube$/i,"").slice(0,160);
            const currentVideos = videos.filter(v => !v.inactiveSlot && (v.loaded || v.playing));
            if (currentVideos.length === 1 && !currentVideos[0].title && pageTitle) currentVideos[0].title = pageTitle.slice(0,160);
            const host = primary && nodes.get(primary.id)?.closest("#movie_player");
            if (host !== watchedPlayer) {
                adObserver.disconnect();
                watchedPlayer = host;
                if (host) {
                    lastAd = primary.ad;
                    adObserver.observe(host,{attributes:true,attributeFilter:["class"]});
                }
            }
            const menu = host?.querySelector(".ytp-settings-menu");
            if (menu !== watchedMenu) {
                menuObserver.disconnect();
                watchedMenu = menu;
                if (menu) menuObserver.observe(menu,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:["aria-checked"]});
            }
            const info = pageInfo();
            const playlists = [...manifests.values()];
            const segments = watchingStream ? [...segmentSamples.keys()] : [];
            const videoSegments = segments.filter(url => segmentSamples.get(url));
            const referrerPolicy = pageReferrerPolicy();
            const signature = JSON.stringify([list,info,playlists,segments,videoSegments,watchRevision,referrerPolicy]);
            if (signature !== previous) {
                previous = signature;
                port.postMessage({type:"elements",list,info,playlists,segments,videoSegments,watchRevision,referrerPolicy,documentStart:performance.timeOrigin});
            }
        }
        function queue() {
            if (!pending) pending = setTimeout(publish, 180);
        }
        const watchedNodes = mediaSelector + ',source,.ytp-settings-menu,meta[name="referrer" i]';
        const observation = {childList:true,subtree:true,attributes:true,
            attributeFilter:["src","srcset","sizes","href","poster","alt","title","aria-label","aria-labelledby","label","data-quality","type","download","id","data-video-id","name","content"]};
        const mediaEvents = ["load","loadeddata","loadedmetadata","durationchange","resize","emptied","playing","pause","ended","encrypted"];
        function mediaEvent(event) {
            const node = event.target;
            if (!node.matches?.(mediaSelector)) return;
            if (event.type === "loadedmetadata") {
                thumbnails.delete(node);
                if (node.closest("#movie_player") && SnagPlayer.youtubeId(location.href)) watchRevision++;
            }
            if (["loadedmetadata","resize"].includes(event.type) && node.localName === "video" && mainPlayer(node)) queuePlaybackList();
            queue();
        }
        function listenMedia(root) {
            for (const event of mediaEvents) root.addEventListener(event,mediaEvent,{capture:true,signal:life.signal});
        }
        function observeShadow(root) {
            observer.observe(root,observation);
            listenMedia(root);
        }
        function pruneShadowRoots() {
            let pruned = false;
            for (const root of shadowRoots.keys()) {
                let scope = root, depth = 0;
                while (scope?.mode === "open" && depth <= 6) { depth++; scope = scope.host.getRootNode(); }
                if (scope === document && depth <= 6 && root.host.isConnected) { shadowRoots.set(root,depth); continue; }
                for (const event of mediaEvents) root.removeEventListener(event,mediaEvent,true);
                shadowRoots.delete(root);
                pruned = true;
            }
            if (pruned) {
                // MutationObserver has no unobserve(target). Release detached hosts and keep a single live observer.
                observer.disconnect();
                observer.observe(document,observation);
                for (const root of shadowRoots.keys()) observer.observe(root,observation);
            }
            return pruned;
        }
        const observer = new MutationObserver(changes => {
            let changed = changes.some(c => c.removedNodes.length) && pruneShadowRoots();
            for (const change of changes) {
                if (change.type === "attributes") {
                    changed ||= change.target.matches(watchedNodes) || change.target.localName === "meta" ||
                        (["id","data-video-id"].includes(change.attributeName) && (shadowRoots.size || change.target.querySelector("video")));
                    continue;
                }
                const parent = change.target.getRootNode(), depth = parent === document ? 0 : shadowRoots.get(parent);
                if (depth === undefined) continue;
                for (const node of change.addedNodes) if (node.nodeType === 1 && node.isConnected) {
                    const count = shadowRoots.size;
                    discoverShadowRoots(node,depth,shadowRoots,observeShadow);
                    changed ||= shadowRoots.size !== count;
                }
                changed ||= [...change.addedNodes,...change.removedNodes].some(n =>
                    n.nodeType === 1 && (n.matches(watchedNodes) || n.querySelector(watchedNodes)));
            }
            if (changed) queue();
        });
        observer.observe(document,observation);
        listenMedia(document);
        discoverShadowRoots(document,0,shadowRoots,observeShadow);
        function rememberLists(entries) {
            let changed = false;
            const generic = !playbackRoute(location.href);
            for (const entry of entries) {
                if (timingRoute && entry.startTime < routeStarted) continue;
                const fetched = entry.initiatorType === "fetch" || entry.initiatorType === "xmlhttprequest";
                if (generic && !(entry.responseStatus >= 400) && SnagFormat.segmentSample(entry.name,entry.contentType,fetched)) {
                    const url = webUrl(entry.name);
                    const video = /^video\//i.test(entry.contentType || "");
                    if (rememberSegment(url,video)) changed ||= watchingStream;
                }
                const file = manifestFile(entry);
                if (!file || manifests.has(file.url)) continue;
                manifests.set(file.url,file);
                if (manifests.size > 128) manifests.delete(manifests.keys().next().value);
                changed = true;
            }
            return changed;
        }
        rememberLists(performance.getEntriesByType("resource"));
        let listTimer;
        function queuePlaybackList() {
            const route = SnagBili.route(location.href);
            if (!route || window !== window.top) return;
            clearTimeout(listTimer);
            listTimer = setTimeout(() => port.postMessage({type:"playbackList",route:route.key}),100);
        }
        document.addEventListener("snag-bili-list",queuePlaybackList,{signal:life.signal});
        const playbackLists = new PerformanceObserver(batch => {
            const entries = batch.getEntries();
            if (rememberLists(entries)) queue();
            if (watchedPlayer && entries.some(entry => /\/youtubei\/v1\/player(?:[?#]|$)/.test(entry.name) &&
                new URL(entry.name).origin === location.origin)) {
                watchRevision++;
                queue();
            }
            if (window === window.top) {
                const route = SnagBili.route(location.href);
                if (route && entries.some(entry =>
                    /^https:\/\/api\.bilibili\.com\/(?:x\/player\/(?:wbi\/)?|pgc\/player\/web\/(?:v\d+\/)?)playurl(?:\?|$)/i.test(entry.name))) {
                    queuePlaybackList();
                }
            }
        });
        playbackLists.observe({entryTypes:["resource"]});
        document.addEventListener("yt-navigate-finish",() => {
            if (!SnagPlayer.youtubeId(location.href)) return;
            watchRevision++;
            queue();
        },{signal:life.signal});
        window.addEventListener("resize", queue, { signal: life.signal });

        function clearMark() {
            clearTimeout(hideTimer);
            outline?.remove();
            outline = highlighted = null;
        }
        function position() {
            if (!highlighted) return;
            const rect = highlighted.getBoundingClientRect();
            for (const prop of ["left","top","width","height"]) outline.style.setProperty(prop, rect[prop] + "px", "important");
        }
        function mark(node) {
            if (!node) { clearMark(); return; }
            if (!outline) {
                outline = document.createElement("div");
                outline.setAttribute("aria-hidden","true");
                outline.setAttribute("data-snag-outline","");
                outline.style.cssText = "all:initial!important;position:fixed!important;pointer-events:none!important;box-sizing:border-box!important;border:3px solid #635bd4!important;box-shadow:inset 0 0 0 1px white!important;border-radius:5px!important;z-index:2147483647!important";
                document.documentElement.append(outline);
            }
            highlighted = node;
            position();
        }
        window.addEventListener("scroll", position, { capture:true, passive:true, signal:life.signal });
        window.addEventListener("resize", position, { signal:life.signal });
        function hit(event) {
            const direct = event.composedPath().find(node => node.matches?.(mediaSelector));
            if (direct) return direct;
            const {clientX:x,clientY:y} = event;
            const under = document.elementsFromPoint(x,y).find(node => node.matches(mediaSelector));
            if (under) return under;
            // A video with pointer-events:none is absent from the hit-test stack.
            const shadowVideos = [...nodes.values()].filter(node => node.localName === "video" && node.isConnected && node.getRootNode().host);
            for (const parent of event.composedPath()) {
                if (parent === document.body || parent === document.documentElement) break;
                if (!(parent instanceof Element || parent instanceof ShadowRoot)) continue;
                const candidates = new Set(parent.querySelectorAll("video"));
                for (const video of shadowVideos) {
                    for (let host = video.getRootNode().host; host; host = host.getRootNode().host) {
                        if (parent.contains(host)) { candidates.add(video); break; }
                    }
                }
                const videos = [...candidates].filter(video => {
                    const rect = video.getBoundingClientRect();
                    return rect.left <= x && x < rect.right && rect.top <= y && y < rect.bottom &&
                        getComputedStyle(video).visibility === "visible";
                });
                if (videos.length) return videos.length === 1 ? videos[0] : undefined;
            }
        }
        function capture(event) {
            if (!picking || !event.isTrusted) return;
            const node = hit(event);
            if (event.type === "pointermove") { mark(node); return; }
            if (!node || event.button !== 0) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (event.type !== "click") return;
            if (node.getRootNode() !== document) pickedInShadow.add(node);
            publish();
            picking = false;
            clearMark();
            port.postMessage({ type: "picked", id: nodeIds.get(node) });
        }
        for (const type of ["pointermove","pointerdown","pointerup","mousedown","mouseup","click"]) {
            window.addEventListener(type, capture, { capture:true, passive:false, signal:life.signal });
        }
        window.addEventListener("keydown", event => {
            if (!picking || event.key !== "Escape") return;
            event.preventDefault();
            event.stopImmediatePropagation();
            picking = false;
            clearMark();
            port.postMessage({ type:"cancel" });
        }, { capture:true, signal:life.signal });

        port.onMessage.addListener(message => {
            if (message.type === "inspectLeaf") {
                const {url,playlist,range} = message;
                const node = nodes.get(message.id);
                if (node?.localName !== "video" || node.readyState < 1 || node.mediaKeys ||
                    !/^https?:\/\//i.test(url) || playbackRoute(location.href)) return;
                const item = describe(node);
                if (item.ad || item.inactiveSlot || item.objectStream || !(segmentSamples.has(url) || performance.getEntriesByName(url,"resource").length ||
                    message.documentStart === performance.timeOrigin)) return;
                if (!codecProbes.has(playlist)) codecProbes.set(playlist,readLeafCodec(url,range,life.signal).catch(() => ""));
                codecProbes.get(playlist).then(codec => {
                    if (!life.signal.aborted) port.postMessage({type:"leafCodec",url,playlist,codec});
                });
            }
            if (message.type === "inspectPlaylist") {
                const url = message.url;
                const observed = manifests.has(url) || performance.getEntriesByName(url,"resource").length ||
                    message.documentStart === performance.timeOrigin;
                let retryable = false;
                const read = async () => {
                    if (!observed || !/^https?:\/\//i.test(url)) return "";
                    const controller = new AbortController();
                    const abort = () => controller.abort();
                    const timer = setTimeout(abort,5000);
                    life.signal.addEventListener("abort",abort,{once:true});
                    try {
                        const response = await fetch(url,{cache:"force-cache",redirect:"error",signal:controller.signal});
                        retryable = [408,500,502,503,504].includes(response.status);
                        return await SnagPlayer.playlistText(response);
                    } catch {
                        retryable = true;
                        return "";
                    } finally {
                        clearTimeout(timer);
                        life.signal.removeEventListener("abort",abort);
                    }
                };
                read().catch(() => "").then(text => {
                    if (!life.signal.aborted) port.postMessage({type:"playlistText",url,text,retryable});
                });
            }
            if (message.type === "videoContext") {
                useContext(message);
                publish();
            }
            if (message.type === "endPreview") releasePreview(message.request);
            if (message.type === "pausePreview") filePreviews.get(message.request)?.pause();
            if (message.type === "previewFrame") {
                const node = message.file ? filePlayer(message.request,message.file,message.id,message.kind) : nodes.get(message.id);
                const reply = {type:"previewFrame", request:message.request};
                if (!node || (!message.file && (!node.isConnected || node.localName !== "video" ||
                    node.currentSrc !== message.current || videoPage() !== message.page))) reply.state = "gone";
                else if (node.mediaKeys || node.error) reply.state = "unavailable";
                else {
                    reply.paused = node.paused;
                    reply.time = node.currentTime;
                    reply.duration = Number.isFinite(node.duration) ? node.duration : 0;
                    if (message.action === "play" && node.paused) node.play().catch(() => {});
                    if (message.action === "pause" && message.file) node.pause();
                    if (message.action === "seek" && message.file && Number.isFinite(message.time) && reply.duration) {
                        node.currentTime = Math.max(0,Math.min(message.time,reply.duration));
                    }
                    if (node.localName === "audio") reply.state = node.readyState >= 1 ? "ready" : "waiting";
                    else if (node.readyState < 2 || !node.videoWidth) reply.state = "waiting";
                    else if (message.lastTime !== reply.time) {
                        try {
                            previewCanvas ??= document.createElement("canvas");
                            const scale = Math.min(1,480/node.videoWidth,300/node.videoHeight);
                            const width = Math.max(1,Math.round(node.videoWidth*scale)), height = Math.max(1,Math.round(node.videoHeight*scale));
                            if (previewCanvas.width !== width || previewCanvas.height !== height) {
                                previewCanvas.width = width; previewCanvas.height = height;
                            }
                            previewCanvas.getContext("2d").drawImage(node,0,0,width,height);
                            reply.image = previewCanvas.toDataURL("image/jpeg",0.72);
                        } catch { previewCanvas = null; reply.state = "unavailable"; }
                    }
                }
                port.postMessage(reply);
            }
            if (message.type === "pick") { picking = message.active; clearMark(); }
            if (message.type === "locate") {
                const node = nodes.get(message.id);
                const found = !!(node?.isConnected && node.getClientRects().length);
                if (found) {
                    node.scrollIntoView({ block:"center", inline:"nearest", behavior:"instant" });
                    clearMark();
                    mark(node);
                    hideTimer = setTimeout(clearMark, 2200);
                }
                port.postMessage({ type:"located", found, id:message.id });
            }
        });
        port.onDisconnect.addListener(() => {
            void chrome.runtime.lastError;
            publishers.delete(publish);
            for (const request of filePreviews.keys()) releasePreview(request);
            life.abort();
            observer.disconnect();
            adObserver.disconnect();
            menuObserver.disconnect();
            slotObserver.disconnect();
            playbackLists.disconnect();
            clearTimeout(listTimer);
            clearTimeout(pending);
            clearMark();
        });
        publishers.set(publish,() => { if (watchingStream) queue(); });
        publish();
        if (lastScan?.page === location.href) port.postMessage({ type:"scanFiles", files:lastScan.files });
    });
})();
