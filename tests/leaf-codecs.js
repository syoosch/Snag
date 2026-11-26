'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const {EXT,fixture} = require('./lib/harness');
require(path.join(EXT,'js/media-formats.js'));

function box(name,...payload) {
    const bytes = Buffer.concat([Buffer.alloc(8),...payload]);
    bytes.writeUInt32BE(bytes.length);
    bytes.write(name,4,4,'ascii');
    return bytes;
}
function track(entries) {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(entries.length,4);
    return box('trak',box('mdia',box('minf',box('stbl',box('stsd',header,...entries)))));
}
test('MP4 sample entries in a complete or prefix-only moov',() => {
    for (const [entry,expected] of Object.entries({avc1:'H.264',avc3:'H.264',hev1:'H.265',hvc1:'H.265',av01:'AV1',
        vp09:'VP9',vp08:'VP8',mp4v:'MPEG-4'})) {
        const movie = box('moov',track([box('mp4a')]),track([box('unknown'),box(entry,Buffer.alloc(20000))]));
        assert.equal(SnagFormat.probeCodec(movie.subarray(0,160)),expected);
    }
    const movie = box('moov',track([box('avc1')]));
    const extended = Buffer.alloc(16);
    extended.writeUInt32BE(1); extended.write('moov',4); extended.writeBigUInt64BE(BigInt(movie.length+8),8);
    assert.equal(SnagFormat.probeCodec(Buffer.concat([extended,movie.subarray(8)])),'H.264');
    for (const invalid of [movie.subarray(0,-1),box('mdat',movie),box('moov',box('stsd',box('avc1'))),
        Buffer.concat([box('free',Buffer.alloc(16384)),movie]),Buffer.from('avc1'),fixture('preview-audio.m4s')]) {
        assert.equal(SnagFormat.probeCodec(invalid),'');
    }
    assert.equal(SnagFormat.probeCodec(fixture('hls-av-fragmented.mp4')),'H.264');
});

function packet(pid,start,cc,payload) {
    const data = Buffer.alloc(188,0xff), stuffing = 183-payload.length;
    data.set([0x47,(start ? 0x40 : 0) | pid >> 8,pid & 255,0x30 | cc,stuffing,0]);
    data.set(payload,5+stuffing);
    return data;
}
test('188-byte TS PAT and PMT, pointers, descriptors and split PSI sections',() => {
    const pat = [0,0xb0,17,0,1,0xc1,0,0,0,0,0xe0,0x10,0,1,0xe1,0x10,0,0,0,0];
    const ts = type => {
        const pmt = [2,0xb0,25,0,1,0xc1,0,0,0xe1,0x11,0xf0,2,9,0,
            0x0f,0xe1,0x12,0xf0,0,type,0xe1,0x11,0xf0,0,0,0,0,0];
        return [packet(0,true,5,[2,0xff,0xff,...pat.slice(0,9)]),packet(0,false,6,pat.slice(9)),
            packet(0x110,true,2,[0,...pmt.slice(0,18)]),packet(0x110,false,3,pmt.slice(18))];
    };
    for (const [type,name] of [[0x1b,'H.264'],[0x24,'H.265'],[2,'MPEG-2'],[0x10,'MPEG-4'],[0x0f,'']]) {
        assert.equal(SnagFormat.probeCodec(Buffer.concat(ts(type))),name);
    }
    const packets = ts(0x1b);
    assert.equal(SnagFormat.probeCodec(Buffer.concat(packets.slice(2))),'');
    packets[3][3]++; // Missing packet in the middle of the PMT.
    assert.equal(SnagFormat.probeCodec(Buffer.concat(packets)),'');
    assert.equal(SnagFormat.probeCodec(fixture('segment.ts')),'H.264');
});
