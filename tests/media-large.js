'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {launch,test,until,fixture} = require('./lib/harness');

// A real, seekable file whose AAC packets come *after* a 10 GiB MP4 free
// box. Mark it sparse before writing the far end to avoid reserving 10 GiB.
test('本地 FFmpeg 大文件寻址',async t => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(),'snag-sparse-'));
    const file = path.join(temp,'large.m4s');
    t.defer(() => { fs.rmSync(file,{force:true}); fs.rmdirSync(temp); });
    fs.writeFileSync(file,'');
    if (process.platform === 'win32') execFileSync('fsutil.exe',['sparse','setflag',file],{windowsHide:true});
    const audio = fixture('preview-audio.m4s');
    const split = audio.indexOf('moof') - 4, end = audio.indexOf('mfra') - 4;
    const hole = 10 * 1024**3, atom = Buffer.alloc(16);
    atom.writeUInt32BE(1); atom.write('free',4); atom.writeBigUInt64BE(BigInt(hole),8);
    const fd = fs.openSync(file,'r+');
    try {
        fs.writeSync(fd,audio,0,split,0); fs.writeSync(fd,atom,0,atom.length,split);
        fs.writeSync(fd,audio,split,end-split,split+hole);
    } finally { fs.closeSync(fd); }
    assert.ok(fs.statSync(file).size > hole);
    const browser = await launch(); t.defer(browser.close);
    const tool = await browser.open(browser.url('media-tool.html'));
    assert.ok(await until(() => tool.eval("document.readyState==='complete' && !!document.querySelector('#files')")));
    const {root} = await tool.send('DOM.getDocument');
    const {nodeId} = await tool.send('DOM.querySelector',{nodeId:root.nodeId,selector:'#files'});
    assert.ok(nodeId);
    await tool.send('DOM.setFileInputFiles',{nodeId,files:[file]});
    assert.ok(await until(() => tool.eval("!document.querySelector('[data-action=onlyAudio]').disabled")));
    const before = browser.files();
    await tool.eval("document.querySelector('[data-action=onlyAudio]').click()");
    const saved = await browser.download(before,25000);
    assert.ok(saved && saved.includes(Buffer.from('soun')) && saved.includes(Buffer.from('mdat')) && saved.length > 11000,
        'failed to reach audio packets: '+await tool.eval("document.getElementById('feedback').textContent"));
    assert.equal(fs.statSync(file).size, hole+end);
    t.check('从 10 GiB 偏移之后提取真实 AAC 成品，保留用户原文件',true);
});
