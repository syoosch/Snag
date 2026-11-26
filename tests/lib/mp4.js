'use strict';

const assert = require('node:assert/strict');

function boxes(bytes) {
    const result = [];
    for (let at = 0; at < bytes.length;) {
        const size = bytes.readUInt32BE(at);
        assert.ok(size >= 8 && at + size <= bytes.length);
        result.push({name:bytes.toString('ascii',at+4,at+8),data:bytes.subarray(at,at+size)});
        at += size;
    }
    return result;
}
function child(box,name) { return boxes(box.data.subarray(8)).find(b=>b.name === name); }
function videoCodec(bytes) {
    const movie = boxes(bytes).find(b=>b.name==='moov');
    const media = boxes(movie.data.subarray(8)).filter(b=>b.name==='trak').map(t=>child(t,'mdia'));
    const video = media.find(m=>child(m,'hdlr').data.toString('ascii',16,20)==='vide');
    return child(child(child(video,'minf'),'stbl'),'stsd').data.toString('ascii',20,24);
}
function pictureInfo(bytes) {
    const moov = boxes(bytes).find(b => b.name === 'moov');
    const tracks = boxes(moov.data.subarray(8)).filter(b=>b.name === 'trak').map(t=>child(t,'mdia'));
    const kind = t => child(t,'hdlr').data.toString('ascii',16,20);
    assert.deepEqual(tracks.map(kind).sort(),['soun','vide']);
    const video = tracks.find(t=>kind(t)==='vide');
    const mdhd = child(video,'mdhd').data;
    const scale = mdhd.readUInt32BE(mdhd[8] === 1 ? 28 : 20);
    const table = child(child(video,'minf'),'stbl');
    const stts = child(table,'stts').data;
    let frames = 0, ticks = 0;
    for (let i=0; i<stts.readUInt32BE(12); i++) {
        const count = stts.readUInt32BE(16+i*8);
        frames += count; ticks += count*stts.readUInt32BE(20+i*8);
    }
    return {frames,fps:frames*scale/ticks,seconds:ticks/scale};
}

function checkFastStart(bytes,{width,height,frames,fps,seconds}) {
    assert.ok(bytes?.length,'saved MP4 is nonempty');
    const top = boxes(bytes), names = top.map(b=>b.name);
    assert.equal(names[0],'ftyp');
    assert.ok(names.includes('moov') && names.indexOf('moov') < names.indexOf('mdat') && !names.includes('moof'),'indexed fast-start MP4');
    const movie = top.find(b=>b.name==='moov');
    const video = boxes(movie.data.subarray(8)).find(b=>b.name==='trak' && child(child(b,'mdia'),'hdlr').data.toString('ascii',16,20)==='vide');
    const header = child(video,'tkhd').data;
    assert.equal(header.readUInt32BE(header.length-8)/65536,width);
    assert.equal(header.readUInt32BE(header.length-4)/65536,height);
    assert.deepEqual(pictureInfo(bytes),{frames,fps,seconds});
}
module.exports = {boxes, videoCodec, pictureInfo, checkFastStart};
