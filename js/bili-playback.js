// Bilibili reuses the same document during autoplay. Keep the lists the page itself received,
// indexed by part ID, so opening the sidebar later does not require another playback request.
(() => {
    "use strict";
    // The manifest selects playback paths at document start; the sidebar also installs this after SPA navigation.
    if (!/^(?:www\.|m\.)?bilibili\.com$/i.test(location.hostname) || window.__snagBiliList) return;
    // A developer reload can leave the previous observer running in this document.
    if (typeof window.__framepickBiliList === "function") {
        Object.defineProperty(window,"__snagBiliList",{value:window.__framepickBiliList});
        document.addEventListener("framepick-bili-list",() => document.dispatchEvent(new Event("snag-bili-list")));
        return;
    }
    const lists = new Map();
    Object.defineProperty(window,"__snagBiliList",{value:cid => lists.get(String(cid))});

    function partId(address) {
        let url;
        try { url = new URL(address,location.href); } catch { return; }
        if (url.origin !== "https://api.bilibili.com" || !/^\/x\/player\/(?:wbi\/)?playurl$/.test(url.pathname)) return;
        const cid = url.searchParams.get("cid");
        return /^[1-9]\d*$/.test(cid) ? cid : undefined;
    }
    function remember(cid, body, address) {
        const info = body?.data;
        if (body?.code !== 0 || !info) return;
        if (info.is_drm || info.is_preview) { lists.delete(cid); return; }
        if (!Array.isArray(info.dash?.video) || !info.dash.video.length) return;
        const {dash,accept_quality,accept_description,support_formats} = info;
        const params = new URL(address).searchParams, previous = lists.get(cid);
        const bvid = params.get("bvid"), aid = params.get("avid") || params.get("aid");
        lists.delete(cid);
        lists.set(cid,{dash,accept_quality,accept_description,support_formats,
            bvid:/^BV[0-9A-Za-z]+$/i.test(bvid || "") ? bvid : previous?.bvid,
            aid:/^[1-9]\d*$/.test(aid || "") ? aid : previous?.aid});
        if (lists.size > 4) lists.delete(lists.keys().next().value);
        document.dispatchEvent(new Event("snag-bili-list"));
    }

    const fetchPage = window.fetch;
    window.fetch = function(input) {
        const result = Reflect.apply(fetchPage,this,arguments);
        const cid = partId(input instanceof Request ? input.url : input);
        if (cid) result.then(response => {
            if (response.ok && partId(response.url) === cid && Number(response.headers.get("content-length")) < 2_000_000) {
                return response.clone().json().then(body => remember(cid,body,response.url));
            }
        }).catch(() => {});
        return result;
    };

    const openPage = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method,address) {
        const result = Reflect.apply(openPage,this,arguments);
        const cid = partId(address);
        if (cid) this.addEventListener("loadend",() => {
            if (this.status !== 200 || partId(this.responseURL) !== cid) return;
            try {
                if (this.responseType === "json") remember(cid,this.response,this.responseURL);
                else if ((!this.responseType || this.responseType === "text") && this.responseText.length < 2_000_000)
                    remember(cid,JSON.parse(this.responseText),this.responseURL);
            } catch { /* Incomplete playback response. */ }
        },{once:true});
        return result;
    };
})();
