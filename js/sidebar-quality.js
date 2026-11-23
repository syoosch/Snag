"use strict";

const tierRequests = new Map();
const biliTierNames = {16:"360p",32:"480p",64:"720p",80:"1080p",112:"1080p+",116:"1080p 60 fps",120:"4K",122:"SDR+",125:"HDR",126:"Dolby Vision",127:"8K"};

function fileQuality(group,track) {
    if (track.kind !== "video") return "";
    const declared = SnagPlayer.quality(track.label || biliTierNames[track.qualityId],0,track.fps);
    const point = group.point;
    if (/^https?:\/\//i.test(point?.current) && resourceAddress(point.current) === resourceAddress(track.record.url) &&
        !isM3U8(track.record) && !isMPD(track.record)) {
        // Only the exact, direct file can inherit the decoded dimensions.
        const decoded = SnagPlayer.playbackQuality(point);
        if (decoded && parseInt(decoded,10) !== parseInt(declared,10)) return decoded;
    }
    return declared;
}

function tierKey(group,track) {
    return track.qualityId ? "qn:" + track.qualityId : fileQuality(group,track) || track.label || "captured";
}

function qualityTiers(group, variants) {
    const tiers = new Map();
    for (const format of group.info?.formats || []) {
        tiers.set("qn:" + format.id,{id:format.id,name:format.name || biliTierNames[format.id],tracks:[]});
    }
    if (group.point?.menuQualities && !group.point.ad) {
        const known = group.point.menuQualities;
        for (const label of known) tiers.set(label,{name:label,tracks:[]});
        const playing = SnagPlayer.playbackQuality(group.point);
        // Without an observed frame rate, 1080p playback may already be represented by 1080p60.
        if (playing && !known.some(name => name === playing || (playing.endsWith("p") && parseInt(name,10) === parseInt(playing,10)))) {
            tiers.set(playing,{name:playing,tracks:[]});
        }
    }
    for (const track of variants) {
        const key = tierKey(group,track);
        if (!tiers.has(key)) tiers.set(key,{id:track.qualityId,name:biliTierNames[track.qualityId],tracks:[]});
        const tier = tiers.get(key);
        tier.name ||= fileQuality(group,track) || track.label;
        tier.tracks.push(track);
    }
    for (const [key,tier] of tiers) {
        if (!tier.tracks.length && tier.id && !group.info?.episodeId && !group.info?.canSwitch) tiers.delete(key);
        tier.name ||= tier.id ? i18n.sideTier + " " + tier.id : i18n.sideCapturedVersion;
    }
    if (group.info?.formats?.length || variants.some(item => item.qualityId)) return tiers;
    const rank = key => {
        const match = /^(\d+)p(\d*)$/.exec(key);
        return match ? Number(match[1])*1000 + Number(match[2]) : 0;
    };
    return new Map([...tiers].sort(([a],[b]) => rank(b) - rank(a)));
}

function selectOptions(select, entries, value) {
    const signature = JSON.stringify(entries);
    if (select.dataset.options !== signature) {
        select.replaceChildren(...entries.map(([key,label,disabled,details]) => {
            const option = new Option(label,key);
            option.disabled = !!disabled;
            if (details && CSS.supports("appearance","base-select") && CSS.supports("selector(::picker(select))")) {
                option.setAttribute("aria-label",label);
                const copy = el("span",null,"encoding-choice");
                copy.append(el("span",details.name,"encoding-name"));
                if (details.size) copy.append(" ",el("span",details.size,"encoding-size"));
                if (details.stats) copy.append(" ",el("small",details.stats,"encoding-stats"));
                option.replaceChildren(copy);
            }
            return option;
        }));
        select.dataset.options = signature;
    }
    select.value = value;
}

function trackForTier(tracks,active,playingKey) {
    return tracks.find(t => t.key === active.key) || tracks.find(t => active.codec && t.codec === active.codec) ||
        tracks.find(t => t.key === playingKey) || tracks[0];
}

function displayTiers(row,variants,track,duration) {
    const group = row.group, selector = row.node.querySelector(".quality-tier");
    const versions = row.node.querySelector(".encoding-options"), note = row.node.querySelector(".tier-note");
    const tiers = group.kind === "video" ? qualityTiers(group,variants) : new Map();
    const named = group.point?.menuQualities?.length || variants.some(item => SnagPlayer.quality(item.label));
    const grouped = group.kind === "video" && (group.info?.episodeId || group.info?.canSwitch || variants.some(item => item.qualityId) ||
        named && (tiers.size > 1 || variants.length > 1));
    const request = tierRequests.get(group.key);
    let tracks = variants;
    selector.hidden = !grouped || tiers.size < 2;
    selector.parentElement.hidden = selector.hidden;
    if (grouped) {
        const selected = request?.pending ? request.key : tierKey(group,track);
        tracks = tiers.get(selected)?.tracks || [];
        selector.disabled = !!request?.pending;
        selector.setAttribute("aria-label",i18n.sideTier);
        if (!selector.hidden) {
            row.node.querySelector(".tier-current").textContent = tiers.get(selected)?.name || track.label;
            selectOptions(selector,[...tiers].map(([key,tier]) => {
                if (!tier.tracks.length) return [key,i18n(group.info?.canSwitch ? "sideTierOnPage" : "sideTierNoFile",tier.name),!group.info?.canSwitch];
                const item = trackForTier(tier.tracks,track,group.info?.playingKey);
                const split = item.separate || group.biliId && !item.episodeCid;
                const meta = cardMetadata(group,item,duration,split);
                return [key,[tier.name,meta.format,meta.size].filter(v => v && v !== "—").join(" · ")];
            }),selected);
        }
    }
    const codecs = new Set(tracks.map(item => item.codec || ""));
    const sameTier = grouped || group.kind === "audio" || new Set(tracks.map(item => item.label)).size === 1;
    versions.hidden = !sameTier || codecs.size < 2 || !!request?.pending;
    if (!versions.hidden) {
        const encoding = versions.querySelector("select");
        versions.querySelector(".encoding-current").textContent = track.codec || (track.segments ? i18n.sideAutomatic : i18n.sideVersion);
        encoding.setAttribute("aria-label",i18n.sideEncodings);
        selectOptions(encoding,tracks.map(item => {
            const name = item.codec || item.label || (item.segments ? i18n.sideAutomatic : i18n.sideVersion);
            const size = trackSizeLabel(item,duration);
            const audioName = item.kind === "audio" && item.label !== name && item.label;
            const stats = [audioName,...encodingStats(item,duration)].filter(Boolean).join(" · ");
            return [item.key,[name,size,stats].filter(Boolean).join(" · "),false,{name,size,stats}];
        }),track.key);
    }
    note.textContent = request?.text || "";
    note.hidden = !note.textContent;
    return versions.hidden && !request?.pending ? tracks : [];
}

async function selectTier(row,key) {
    const group = row.group, active = choice(group);
    const variants = group.tracks.filter(track => track.kind === "video");
    const tier = qualityTiers(group,variants).get(key);
    if (!tier || tierRequests.get(group.key)?.pending) return;
    tierRequests.delete(group.key);
    if (tier.tracks.length) {
        const chosen = trackForTier(tier.tracks,active,group.info?.playingKey);
        choices.set(group.key,chosen.key);
        render();
        return;
    }
    if (!group.info?.canSwitch) return;
    const {cid,episodeId} = group.info, id = tabId, epoch = generation, state = frames.get(0);
    const request = {key,pending:true,text:i18n.sideTierSwitching};
    tierRequests.set(group.key,request);
    const current = () => epoch === generation && currentVideo?.cid === cid && tierRequests.get(group.key) === request;
    stopDetail(row);
    render();
    try {
        const [reply] = await chrome.scripting.executeScript({target:{tabId:id,frameIds:[0]},world:"MAIN",
            func:SnagBili.requestQuality,args:[cid,episodeId || "",tier.id,group.info.route]});
        if (!current() || !state || frames.get(0) !== state) return;
        const sources = SnagBili.playingTracks(reply?.result,cid,tier.id);
        const file = sources.find(source => source.kind === "video");
        const identity = SnagBili.representation(file?.url)?.identity || file?.url;
        // The fresh scan below verifies the current episode, access state and file before enabling the download.
        if (state.qualityScan) await state.qualityScan;
        if (!current() || frames.get(0) !== state) return;
        await scanVideo(id,state,epoch);
        if (!current()) return;
        render();
        const found = groups.find(item => item.key === group.key)?.tracks.find(item =>
            item.kind === "video" && item.qualityId === tier.id && item.key === identity);
        if (found) {
            choices.set(group.key,found.key);
            tierRequests.delete(group.key);
        }
    } catch { /* Website rejection, navigation or player timeout. */ }
    finally {
        if (tierRequests.get(group.key) === request) {
            if (current()) {
                choices.set(group.key,active.key);
                request.pending = false;
                request.text = i18n("sideTierFailed",tier.name);
            } else tierRequests.delete(group.key);
        }
        if (epoch === generation) render();
    }
}
