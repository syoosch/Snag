// Shared by the sidebar, the isolated content script and the site's player observer.
globalThis.snagBiliRoute = function(address) {
    let url;
    try { url = new URL(address); } catch { return; }
    if (!/^https?:$/.test(url.protocol) || !/^(?:www\.|m\.)?bilibili\.com$/i.test(url.hostname)) return;
    const series = /^\/bangumi\/play\/(ep|ss)([1-9]\d*)\/?$/i.exec(url.pathname);
    if (series) {
        const episode = series[1].toLowerCase() === "ep";
        return {bangumi:true,episodeId:episode ? series[2] : "",seasonId:episode ? "" : series[2],
            key:"bangumi/" + series[1].toLowerCase() + series[2]};
    }
    const params = url.searchParams;
    const legacy = /^\/watchlater\/?$/i.test(url.pathname) &&
        /^#\/(BV[0-9A-Za-z]+|av\d+)(?:\/p([1-9]\d*))?\/?(?:\?.*)?$/i.exec(url.hash);
    const part = Number(legacy?.[2] || params.get("p") || 1);
    if (!Number.isSafeInteger(part) || part < 1) return;
    const direct = /^\/video\/(BV[0-9A-Za-z]+|av\d+)\/?$/i.exec(url.pathname);
    if (direct) return {id:direct[1],part,key:direct[1] + "/" + part};

    const list = /^\/(list|medialist\/play)\/([\w-]+)(?:\/(BV[0-9A-Za-z]+|av\d+))?\/?$/i.exec(url.pathname);
    if (!list && !legacy) return;
    const bvid = params.get("bvid"), aid = params.get("aid") || params.get("avid");
    const queryBvid = /^BV[0-9A-Za-z]+$/i.test(bvid || "") && bvid;
    const queryAid = /^[1-9]\d*$/.test(aid || "") && "av" + aid;
    const id = legacy?.[1] || queryBvid || list?.[3] || queryAid || "";
    const cid = /^[1-9]\d*$/.test(params.get("cid") || "") ? params.get("cid") : "";
    const sid = /^[1-9]\d*$/.test(params.get("sid") || "") ? params.get("sid") : "";
    // A list/folder ID, oid or tracking parameter cannot identify a video part.
    const explicitPart = params.has("p") || !!legacy?.[2];
    const container = legacy ? "watchlater" : list[1] + "/" + list[2];
    return {list:true,id,part,explicitPart,cid,fragment:!!legacy,key:[container,sid,id,explicitPart ? part : "",cid].join("/")};
};
