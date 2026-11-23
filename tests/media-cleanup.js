'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {launch,serve,send,fixture,test,until} = require('./lib/harness');

test('临时媒体到期及重启清理',async t => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(),'snag-recovery-'));
    t.defer(() => { if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('snag-recovery-'))
        fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:300}); });
    const audio = fixture('preview-audio.m4s');
    const site = await serve((req,res,url) => {
        if (url.pathname === '/broken') { res.writeHead(503); res.end(); return true; }
        if (url.pathname === '/sound') { send(req,res,audio,'audio/mp4'); return true; }
    });
    t.defer(site.close);
    let browser = await launch({profile}); t.defer(() => browser.close());
    const panel = await browser.open(browser.url('sidebar.html'));
    assert.ok(await until(() => panel.eval('typeof mediaCommand === "function"')));
    const finished = {key:'keep',mode:'full',title:'keep.m4a',tabId:42,files:[{url:site.origin+'/sound',ext:'m4a'}]};
    await panel.eval('mediaCommand("start",{request:'+JSON.stringify(finished)+'})');
    assert.deepEqual(await browser.download([]),audio);
    const submit = () => panel.eval('mediaCommand("start",{request:'+JSON.stringify({key:'cleanup',mode:'full',title:'test',tabId:42,
        files:[{url:site.origin+'/broken',ext:'mp4'},{url:site.origin+'/sound',ext:'m4a'}]})+'})');
    async function failed() {
        const task = await submit();
        assert.ok(await until(() => panel.eval('mediaCommand("list").then(all => all.some(j => j.state==="failed" && j.id==='+JSON.stringify(task.id)+' && j.bytes==='+audio.length+'))')));
        return task.id;
    }
    const readDirs = '(async()=>{const root=await (await navigator.storage.getDirectory()).getDirectoryHandle("snag-media-v1");const names=[];for await(const name of root.keys())names.push(name);return names;})()';
    let id = await failed();
    const host = await browser.attach((await browser.targets()).find(target => target.url.endsWith('/media-host.html')).targetId,false);
    await panel.eval('mediaCommand("clear",{id:'+JSON.stringify(id)+'})');
    assert.deepEqual(await host.eval(readDirs),[]);
    t.check('立即清理确实释放失败任务的文件',true);
    id = await failed();
    await host.eval('jobs.get('+JSON.stringify(id)+').expires=Date.now()-1;reap()');
    assert.deepEqual(await host.eval(readDirs),[]);
    t.check('到期清理释放磁盘并移除任务',true);
    id = await failed();
    await host.eval('(async()=>{const r=await navigator.storage.getDirectory();await r.getFileHandle("user-sentinel",{create:true});})()');
    const stream = await browser.open(browser.url('downloader.html'));
    assert.ok(await until(() => stream.eval('typeof SnagStream === "object"')));
    await stream.eval("globalThis.pendingWriter = SnagStream.open('unfinished.ts'); pendingWriter.write(new Uint8Array([1,2,3]))");
    await stream.eval("(async()=>{const dir=await (await navigator.storage.getDirectory()).getDirectoryHandle('snag-streams-v1');await dir.getFileHandle('keep-this',{create:true});})()");
    await browser.kill();
    browser = await launch({profile});
    const clean = await until(async () => {
        const dirs = await browser.sw.eval(readDirs);
        return !dirs.includes(id);
    },15000);
    assert.ok(clean,'abandoned task survived browser restart');
    assert.ok(await browser.sw.eval('(async()=> (await (await navigator.storage.getDirectory()).getFileHandle("user-sentinel")).kind==="file")()'));
    assert.deepEqual(fs.readFileSync(path.join(browser.downloads,'keep.m4a')),audio);
    t.check('实际终止并重启浏览器，遗留任务被清理，任务目录以外的文件保留',true);
    const streamFiles = "(async()=>{const dir=await (await navigator.storage.getDirectory()).getDirectoryHandle('snag-streams-v1');return Array.fromAsync(dir.keys());})()";
    assert.ok(await until(async () => {
        const files = await browser.sw.eval(streamFiles);
        return files.length === 1 && files[0] === 'keep-this';
    },12000),JSON.stringify(await browser.sw.eval(streamFiles)));
    assert.ok(!browser.files().includes('unfinished.ts'));
    t.check('浏览器意外退出后，未完成的流式下载被回收，其他文件保留',true);
});
