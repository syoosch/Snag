'use strict';

const assert = require('node:assert/strict');
const {launch, serve, send, html, fixture, test, until} = require('./lib/harness');

test('详情显示真正解码的画面', async t => {
    const video = fixture('video.mp4');
    const site = await serve((req,res,url) => {
        if (url.pathname === '/watch') return html(res,
            '<video id="web" title="Web player" muted playsinline><source src="/linked.m4s"></video>' +
            '<video title="Direct file" src="/direct.mp4" preload="auto"></video>');
        if (!['/linked.m4s','/separate.m4s','/broken.m4s','/direct.mp4'].includes(url.pathname)) return;
        if (url.pathname.endsWith('.m4s') && req.headers.referer !== site.origin + '/watch') {
            res.writeHead(403); res.end(); return true;
        }
        const incomplete = url.pathname === '/broken.m4s' || (url.pathname === '/linked.m4s' && req.headers['sec-fetch-dest'] === 'video');
        send(req,res,incomplete ? Buffer.from('fragment without media') : video,
            url.pathname === '/direct.mp4' ? 'video/mp4' : 'application/octet-stream');
        return true;
    });
    t.defer(site.close);
    const browser = await launch();
    t.defer(browser.close);
    const page = await browser.open(site.origin + '/watch');
    const id = await browser.tabId('/watch');
    await page.eval("(async()=>{const bytes=await fetch('/linked.m4s').then(r=>r.arrayBuffer());web.src=URL.createObjectURL(new Blob([bytes],{type:'video/mp4'}));web.load();await Promise.all(['/separate.m4s','/broken.m4s'].map(u=>fetch(u).then(r=>r.arrayBuffer())))})()");
    assert.ok(await until(() => page.eval("web.readyState>=2")));
    const panel = await browser.open(browser.url('sidebar.html?tabId=' + id),440,950);
    const card = name => "Array.from(document.querySelectorAll('.resource')).find(r=>r.querySelector('h3').textContent===" + JSON.stringify(name) + ")";
    const detail = name => card(name) + "?.querySelector('.detail-preview')";
    const toggle = name => panel.eval(card(name) + ".querySelector('.toggle-details').click()");
    const visible = async name => panel.eval(detail(name) + "?.scrollIntoView({block:'center'})");
    assert.ok(await until(() => panel.eval("!!" + card('Web player') + " && !!" + card('Direct file'))));
    await toggle('Direct file');
    assert.ok(await until(() => panel.eval(detail('Direct file') + "?.querySelector('video')?.videoWidth===320")));
    await panel.eval(detail('Direct file') + ".querySelector('video').play()");
    assert.ok(await until(() => panel.eval(detail('Direct file') + ".querySelector('video').currentTime>0.2")));
    t.check('直链视频在详情中确实解码并能独立播放',await page.eval("web.paused"));
    await toggle('Direct file');

    const requests = () => site.log.filter(r => r.path === '/linked.m4s').length;
    await toggle('Web player');
    await visible('Web player');
    const decoded = name => detail(name) + "?.querySelector('img')?.naturalWidth>0";
    const position = name => detail(name) + "?.querySelector('.preview-caption span:nth-child(2)')?.textContent || ''";
    assert.ok(await until(() => panel.eval(decoded('Web player'))));
    assert.ok(await until(() => panel.eval(detail('Web player') + ".textContent.includes(chrome.i18n.getMessage('sidePreviewFollows'))")));
    const before = requests();
    await page.eval("web.currentTime=2.2");
    assert.ok(await until(() => panel.eval("(" + position('Web player') + ").includes('00:02')")));
    const firstFrame = await panel.eval(detail('Web player') + ".querySelector('img').src");
    await panel.eval(detail('Web player') + ".querySelector('button').click()");
    assert.ok(await until(() => page.eval("!web.paused")));
    assert.ok(await until(() => panel.eval(detail('Web player') + ".querySelector('img').src!==" + JSON.stringify(firstFrame))));
    t.check('分段视频展示网页里的实际画面，随进度变化且无需再次请求分片', requests() === before);
    await page.eval("web.pause();history.pushState(null,'','/next-episode')");
    assert.ok(await until(() => panel.eval(detail('Web player') + ".textContent.includes(chrome.i18n.getMessage('sidePreviewUnavailable'))")));
    t.check('连播切换页面后，旧文件详情会停止展示复用播放器的画面',await panel.eval(detail('Web player') + ".querySelector('img').hidden"));
    await page.eval("history.replaceState(null,'','/watch')");
    await toggle('Web player');
    await page.eval("web.pause()");

    await panel.eval("document.querySelector('#segments').open=true");
    assert.ok(await until(() => panel.eval("!!" + card('separate.m4s'))));
    await toggle('separate.m4s');
    await visible('separate.m4s');
    assert.ok(await until(() => panel.eval(decoded('separate.m4s'))),'separate file decodes in the source document');
    await panel.eval(detail('separate.m4s') + ".querySelector('button').click()");
    assert.ok(await until(() => panel.eval("(" + position('separate.m4s') + ").includes('00:01')")));
    await panel.eval(detail('separate.m4s') + ".querySelector('button').click()");
    assert.ok(await until(() => panel.eval(detail('separate.m4s') + ".querySelector('button').textContent===chrome.i18n.getMessage('sidePlayPreview')")));
    const slider = detail('separate.m4s') + ".querySelector('input[type=range]')";
    await panel.eval("(()=>{const input=" + slider + ";input.value=3;input.dispatchEvent(new Event('change'))})()");
    assert.ok(await until(() => panel.eval("(" + position('separate.m4s') + ").startsWith('00:03')")));
    t.check('点选的 M4S 可以独立播放、暂停和拖动进度，原网页仍保持暂停',await page.eval("web.paused"));
    await toggle('separate.m4s');
    await toggle('broken.m4s');
    await visible('broken.m4s');
    assert.ok(await until(() => panel.eval(detail('broken.m4s') + "?.textContent.includes(chrome.i18n.getMessage('sidePreviewUnavailable'))")));
    t.check('不可解码的碎片显示原因，详情中没有无效播放器',await panel.eval("!" + detail('broken.m4s') + ".querySelector('video')"));
    assert.deepEqual(panel.errors,[]);
});
