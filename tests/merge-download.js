'use strict';

const assert = require('node:assert/strict');
const {launch, serve, send, html, fixture, test, until} = require('./lib/harness');

test('旧版任务链接的本机音画合并与重试', async t => {
    const video = fixture('video.mp4'), audio = fixture('preview-audio.m4s');
    let videoAvailable = false, audioRequests = 0, toolVisits = 0;
    const site = await serve((req,res,url) => {
        if (url.pathname === '/watch') return html(res,'<title>Sample</title>');
        if (url.pathname === '/picture.m4s' || url.pathname === '/sound.m4s') {
            if (req.headers.referer !== site.origin + '/') { res.writeHead(403); res.end(); return true; }
            if (url.pathname === '/picture.m4s' && !videoAvailable) { res.writeHead(503); res.end(); return true; }
            if (url.pathname === '/sound.m4s') audioRequests++;
            send(req,res,url.pathname === '/sound.m4s' ? audio : video,'application/octet-stream');
            return true;
        }
        if (url.pathname === '/' && url.searchParams.get('_') === 'iframe') toolVisits++;
        return false;
    });
    t.defer(site.close);
    const browser = await launch();
    t.defer(browser.close);
    await browser.sw.eval("chrome.storage.sync.set({downAutoClose:false})");
    const watch = await browser.open(site.origin + '/watch');
    const tabId = await browser.tabId('/watch');
    const panel = await browser.open(browser.url('sidebar.html?tabId=' + tabId));
    assert.ok(await until(() => panel.eval("!loading && availableTab")));
    const tracks = ['picture','sound'].map((name,index) => ({
        trackKind:index ? 'audio' : 'video',url:site.origin + '/' + name + '.m4s',name:name + '.m4s',ext:'m4s',
        title:'Sample',fromPage:!index,requestId:index ? '3343' : undefined,requestHeaders:{referer:site.origin + '/'}
    }));
    const before = browser.files();
    const key = 'sidebarTransfer-00000000-0000-4000-8000-000000000001';
    await panel.eval('chrome.storage.session.set({'+ JSON.stringify(key) + ':' + JSON.stringify(tracks)+'})');
    const jobId = await panel.eval('chrome.tabs.create({url:chrome.runtime.getURL("downloader.html?ffmpeg=merge&transfer='+key+'")}).then(t=>t.id)');
    const target = await browser.waitPage(/downloader\.html/);
    assert.ok(target);
    const job = await browser.attach(target.targetId);
    const ready = expr => until(() => job.eval(expr));
    assert.ok(await ready("document.querySelectorAll('.downItem').length===2 && document.querySelector('.cancel-btn').textContent===i18n.retryDownload"),'video retry button');
    t.check('没有请求编号的画质也能与声音一起建立任务',await job.eval("sidebarMerge && _data.length===2 && !params.has('requestId')"));
    t.check('声音先下载，画面失败时仍留在进度页，合并工具尚未打开',toolVisits===0 && audioRequests===1 &&
        await job.eval("!iframeFFmpeg && document.querySelectorAll('.down-file-progress')[1].textContent===i18n.mergeFileReady && !document.getElementById('merge-status').hidden") &&
        (await browser.pages(/ffmpeg\.(bmmmd|94cat)\.com/)).length===0);
    const rules = await panel.eval(`(async () => {
        const url = ${JSON.stringify(site.origin + '/sound.m4s')};
        const file = {url,requestId:'3343',requestHeaders:{referer:${JSON.stringify(site.origin + '/other')}}};
        await new Promise((resolve,reject)=>setHeaders(file,resolve,tabId,reject));
        return (await chrome.declarativeNetRequest.getSessionRules()).filter(r=>r.condition.urlFilter==='|'+url+'|')
            .map(r=>[r.condition.tabIds[0],r.action.requestHeaders.find(h=>h.header==='referer')?.value]);
    })()`);
    t.check('同时处理同一个文件的两个标签页可各自保留下载所需的来源',new Map(rules).get(jobId)===site.origin+'/' && new Map(rules).get(tabId)===site.origin+'/other');
    videoAvailable = true;
    await job.eval("document.querySelector('.cancel-btn').click()");
    const file = await browser.download(before,20000);
    assert.ok(file && file.includes(Buffer.from('soun')) && file.includes(Buffer.from('vide')),JSON.stringify({
        status:await job.eval("document.getElementById('merge-status').textContent"),
        tasks:await panel.eval('mediaCommand("list")'),errors:job.errors
    }));
    assert.ok(await ready("document.getElementById('merge-status').textContent===i18n.mergeFinished"));
    t.check('旧下载页也用内置引擎合成一个含音画的文件，仅重取失败的画面',audioRequests===1 && toolVisits===0);
    const expired = await browser.open(browser.url('downloader.html?ffmpeg=merge&requestId=%2C3343&transfer=sidebarTransfer-00000000-0000-4000-8000-000000000000'));
    assert.ok(await until(() => expired.eval("document.getElementById('merge-status').textContent===i18n.mergeMissingFiles")));
    t.check('旧链接过期时提示回到视频重试',audioRequests===1 && toolVisits===0);
    assert.deepEqual(job.errors,[]);
    await watch.close();
});
