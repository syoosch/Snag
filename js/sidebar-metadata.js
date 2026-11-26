"use strict";

function bytes(value) {
    if (!Number.isFinite(value) || value < 0) return "";
    const units = ["B","KB","MB","GB","TB"];
    const index = value < 1024 ? 0 : Math.min(units.length - 1,Math.floor(Math.log(value) / Math.log(1024)));
    const amount = value / 1024 ** index;
    return Number(amount.toFixed(index ? 1 : 0)) + " " + units[index];
}

function trackAmount(track,duration) {
    const captured = Number(track.record?.size);
    const exact = Number.isSafeInteger(captured) && captured > 0 ? captured : Number(track.size);
    if (Number.isSafeInteger(exact) && exact > 0) return {value:exact,estimated:false};
    const value = Math.round(Number(track.bitrate) * Number(duration) / 8);
    if (Number.isSafeInteger(value) && value > 0) return {value,estimated:true};
}

function trackSizeLabel(track,duration) {
    if (track.segments) return segmentSize(track,duration).text;
    if (isM3U8(track.record) || isMPD(track.record)) {
        if (track.partSize && (!track.partSize.estimated || !track.bitrate))
            return track.partSize.estimated ? i18n("sideEstimatedSize",bytes(track.partSize.value)) : bytes(track.partSize.value);
        const size = Math.round(track.bitrate * (track.duration || duration) / 8);
        return Number.isSafeInteger(size) && size > 0 ? i18n("sideEstimatedSize",bytes(size)) : "";
    }
    const amount = trackAmount(track,duration);
    return !amount ? "" : amount.estimated ? i18n("sideEstimatedSize",bytes(amount.value)) : bytes(amount.value);
}

function segmentSize(track,duration) {
    const pictures = track.videoVersions || [], sounds = track.audioVersions || [];
    const pictureBytes = pictures.map(t => trackAmount(t,duration)?.value);
    if (!pictures.length || pictureBytes.some(n => !n)) return {text:""};
    const soundBytes = sounds.map(t => trackAmount(t,duration)?.value);
    const paired = soundBytes.length > 0 && soundBytes.every(n => n > 0);
    const includesSound = pictures.every(t => t.includesAudio || paired);
    // A playlist's aggregate bandwidth already includes the associated audio.
    // With a mix of combined and picture-only rates a single range would be misleading.
    if (!includesSound && pictures.some(t => t.includesAudio)) return {text:""};
    const lowAudio = paired ? Math.min(...soundBytes) : 0, highAudio = paired ? Math.max(...soundBytes) : 0;
    const low = bytes(Math.min(...pictureBytes.map((n,i) => n + (pictures[i].includesAudio ? 0 : lowAudio))));
    const high = bytes(Math.max(...pictureBytes.map((n,i) => n + (pictures[i].includesAudio ? 0 : highAudio))));
    let value = low;
    if (low !== high) {
        const [number,unit] = low.split(" ");
        value = (high.endsWith(" " + unit) ? number : low) + "–" + high;
    }
    return {text:i18n("sideEstimatedSize",value),pictureOnly:!includesSound};
}

function encodingStats(track,duration) {
    const versions = track.videoVersions || [];
    const shared = field => versions.length && versions.every(t => t[field] === versions[0][field]) && versions[0][field];
    const fps = track.fps || track.segments?.fps || shared("fps");
    const bitrate = track.bitrate || shared("bitrate");
    const rate = bitrate || (track.rendition && duration > 0 ? 8 * track.record.size / duration : 0);
    const speed = rate >= 1000000 ? (rate / 1000000).toFixed(1) + " Mbps" : rate > 0 ? Math.round(rate / 1000) + " kbps" : "";
    return [fps && Number(Number(fps).toFixed(2)) + " fps",speed && (bitrate ? speed : "≈" + speed)].filter(Boolean);
}

function qualityLabel(track,duration) {
    const codec = track.codec || (track.segments ? i18n.sideAutomatic : "");
    const name = track.label || codec || (track.rendition ? i18n(types[track.kind]) + " " + track.rendition : track.record.name);
    return [name,track.label && codec,trackSizeLabel(track,duration),
        ...encodingStats(track,duration)].filter(Boolean).join(" · ");
}

function cardMetadata(group,track,duration,split) {
    const record = track.record, media = group.kind === "video" || group.kind === "audio";
    const mode = mainDownloadMode(group,track);
    const saved = mediaJobs.findLast(j => j.tabId === tabId && j.key === track.key && j.mode === mode && j.state === "done" && j.result)?.result ||
        outcomes.get(track.key)?.result;
    const ext = SnagFormat.extension(record);
    let format = isM3U8(record) ? "HLS" : isMPD(record) ? "DASH" : ext.toUpperCase();
    let size, sizeLabel = i18n.sideCardSize, formatLabel = i18n.sideCardFormat;
    let codec = track.codec || SnagFormat.codec(record.codecs || record.type,group.kind), codecLabel = i18n.sideCodec;
    if (track.segments) {
        const amount = segmentSize(track,duration);
        size = amount.text;
        if (amount.pictureOnly) sizeLabel = i18n.sidePictureSize;
        format = "MP4";
        formatLabel = i18n.sideExpectedFormat;
        const versions = track.videoVersions || [];
        if (!codec && versions.length && versions[0].codec && versions.every(v => v.codec === versions[0].codec)) {
            codec = versions[0].codec;
            codecLabel = i18n.sideExpectedCodec;
        }
    } else {
        size = trackSizeLabel(track,duration);
        if (split || track.pictureOnly) sizeLabel = i18n.sidePictureSize;
    }
    if (saved) {
        if (saved.ext) { format = saved.ext.toUpperCase(); formatLabel = i18n.sideSavedFormat; }
        if (Number.isFinite(saved.size) && saved.size >= 0) { size = bytes(saved.size); sizeLabel = i18n.sideCardSize; }
        if (saved.codec) { codec = saved.codec; codecLabel = i18n.sideCodec; }
    }
    const kind = group.kind === "other" ? (/^(pdf|docx?|xlsx?|pptx?|od[tpfs]|epub|rtf|txt|csv)$/.test(ext) ? i18n.sideDocument : i18n.sideGenericFile) : i18n(types[group.kind]);
    return {format:format || "—",formatLabel,size:size || "—",sizeLabel,codec:codec || "—",codecLabel,kind,media};
}

function showFileMetadata(row,track,quality,duration,split,paired) {
    const {group,node} = row, point = group.point;
    const data = cardMetadata(group,track,duration,split);
    const dimensions = group.kind === "image" && point?.width > 0 && point.height > 0 && point.width + " × " + point.height;
    const context = [data.kind,data.media && duration > 0 && secToTime(duration),dimensions];
    node.querySelector(".resource-context").textContent = context.filter(Boolean).join(" · ");
    node.querySelector(".format-label").textContent = data.formatLabel;
    node.querySelector(".file-format").textContent = data.format;
    node.querySelector(".size-label").textContent = data.sizeLabel;
    node.querySelector(".file-size").textContent = data.size;
    node.querySelector(".codec-field").hidden = !data.media;
    const options = node.querySelector(".encoding-options"), fixed = node.querySelector(".codec-value");
    node.querySelector(".codec-label").textContent = options.hidden ? data.codecLabel : i18n.sideCodec;
    if (!options.hidden && !track.codec && track.segments && data.codec !== "—" && data.codecLabel === i18n.sideCodec)
        options.querySelector(".encoding-current").textContent = data.codec;
    fixed.hidden = !options.hidden;
    fixed.textContent = data.codec;
    const tier = node.querySelector(".quality-tier"), value = node.querySelector(".quality-value");
    value.textContent = quality || track.label || (group.kind === "video" && SnagPlayer.playbackQuality(point) ? "—" : "");
    value.hidden = !tier.hidden;
    node.querySelector(".tier-field").hidden = tier.hidden && !value.textContent;
    const version = node.querySelector(".version-field");
    version.hidden = node.querySelector(".quality").hidden;
    const note = node.querySelector(".track-note");
    note.textContent = group.rawSegment ? i18n.sideSegment : split && !paired ? i18n.noAudio : "";
    note.hidden = !note.textContent;
    node.querySelector(".variant-controls").hidden = node.querySelector(".tier-field").hidden && version.hidden && note.hidden;
}
