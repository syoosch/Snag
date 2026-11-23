'use strict';

const assert = require('node:assert/strict');
const { launch, serve, html, test, until } = require('./lib/harness');

test('播放控制与常用设置', async t => {
    const embedded = await serve((req,res,url) => url.pathname === '/embed' && html(res,
        '<video id="clip" aria-label="Embedded film" src="/video.mp4" preload="auto" muted loop></video>'));
    t.defer(embedded.close);
    const site = await serve((req,res,url) => {
        if (url.pathname === '/watch') return html(res,
            '<video id="main" title="Main film" src="/video.mp4" preload="auto" muted loop></video>' +
            '<audio aria-label="Commentary" src="/video.mp4" preload="metadata"></audio>' +
            '<iframe src="' + embedded.origin + '/embed"></iframe>');
        if (url.pathname === '/other') return html(res,'<video title="Another tab" src="/video.mp4" muted loop></video>');
    });
    t.defer(site.close);
    const browser = await launch();
    t.defer(browser.close);
    const page = await browser.open(site.origin + '/watch');
    const tabId = await browser.tabId('/watch');
    const other = await browser.open(site.origin + '/other');
    await other.eval("document.querySelector('video').play()");
    await page.eval("document.querySelector('#main').play()");
    const panel = await browser.open(browser.url('sidebar.html?tabId=' + tabId),340,800);
    await until(() => panel.eval('!loading'));
    await panel.eval("document.querySelector('[data-filter=audio]').click();document.querySelector('#more').open=true");
    const tabCount = () => browser.sw.eval("chrome.tabs.query({}).then(tabs=>tabs.length)");
    const count = await tabCount();
    await panel.eval("document.querySelector('#tools').click()");
    const embeddedUI = expression => panel.eval("(() => {const d=document.querySelector('#sidebar-playback').contentDocument; const $=id=>d.getElementById(id); return (" + expression + ");})()");
    assert.ok(await until(() => embeddedUI("$('player-list')?.options.length===3 && $('player-list').selectedOptions[0].textContent.includes('Main film')")),
        'playing media in source tab should be selected');
    t.check('从侧栏控制原网页，按标题识别主播放器和嵌入播放器', await tabCount() === count);
    await page.eval("document.title='Next episode'");
    t.check('网页连播时侧栏页名会跟着更新',await until(() => panel.eval("document.querySelector('#scope').selectedOptions[0]?.text==='Next episode'")));
    await embeddedUI("$('play').click()");
    assert.ok(await until(() => page.eval("document.querySelector('#main').paused")));
    const otherStillPlaying = await other.eval("!document.querySelector('video').paused");
    await embeddedUI("($('rate').value='1.5×',$('rate').dispatchEvent(new Event('change')))");
    assert.ok(await until(() => page.eval("document.querySelector('#main').playbackRate===1.5")));
    await embeddedUI("($('seek').value=50,$('seek').dispatchEvent(new Event('change')))");
    assert.ok(await until(() => page.eval("Math.abs(main.currentTime/main.duration - 0.5)<0.03")));
    t.check('暂停、倍速与进度实际作用于所选播放器，另一标签继续播放',otherStillPlaying && await other.eval("document.querySelector('video').playbackRate===1"));
    await embeddedUI("($('rate').value='16×',$('rate').dispatchEvent(new Event('change')))");
    assert.ok(await until(() => page.eval("main.playbackRate===16")));
    await embeddedUI("($('rate').value='custom',$('rate').dispatchEvent(new Event('change')),$('rate-value').value='32',$('custom-rate').requestSubmit())");
    assert.ok(await until(() => embeddedUI("$('playback-status').textContent===chrome.i18n.getMessage('playbackRateLimit')")));
    t.check('16 倍可用，32 倍由浏览器拒绝后保留真实速度并显示说明',await page.eval("main.playbackRate===16"));
    await embeddedUI("($('rate-value').value='1.75',$('custom-rate').requestSubmit())");
    assert.ok(await until(() => page.eval("main.playbackRate===1.75")));
    await embeddedUI("$('fullscreen').click()");
    const prompt = "document.querySelector('[data-snag-fullscreen]')";
    assert.ok(await until(() => page.eval("!!" + prompt)), 'a click outside the webpage should offer an in-page fullscreen action');
    assert.ok(await page.eval(prompt + ".shadowRoot.querySelector('button:last-child').textContent.trim()"));
    await page.eval(prompt + ".shadowRoot.querySelector('button:last-child').click()");
    assert.ok(await page.eval("!document.fullscreenElement && !" + prompt));
    await embeddedUI("$('fullscreen').click()");
    const target = await until(() => page.eval("(()=>{const b=" + prompt + "?.shadowRoot.querySelector('button');if(!b)return;const r=b.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()"));
    assert.ok(target);
    await page.click(...target);
    assert.ok(await until(() => page.eval("document.fullscreenElement===main && !" + prompt)));
    assert.ok(await other.eval("!document.fullscreenElement"));
    await page.eval("document.exitFullscreen()");
    await panel.send("Page.bringToFront");
    t.check('网页确认按钮可以取消，也能用真实点击让选中的视频进入和退出全屏',await page.eval("!document.fullscreenElement"));
    const choose = async name => embeddedUI("($('player-list').value=Array.from($('player-list').options).find(o=>o.textContent.includes(" + JSON.stringify(name) + ")).value,$('player-list').dispatchEvent(new Event('change')))");
    await choose('Commentary');
    assert.ok(await embeddedUI("$('video-actions').hidden"));
    await embeddedUI("($('volume').value=35,$('volume').dispatchEvent(new Event('change')))");
    assert.ok(await until(() => page.eval("document.querySelector('audio').volume===0.35")));
    await choose('Embedded film');
    await embeddedUI("$('loop').click()");
    assert.ok(await until(() => browser.sw.eval("chrome.scripting.executeScript({target:{tabId:" + tabId +
        ",allFrames:true},func:()=>document.querySelector('#clip')?.loop}).then(list=>list.some(frame=>frame.result===false))")));
    t.check('音频隐藏视频专用操作，跨来源嵌入播放器也能单独控制',true);
    assert.ok(await embeddedUI("d.documentElement.scrollWidth<=d.documentElement.clientWidth && !$('utilities').open && $('utilities').querySelectorAll('a').length===4"));
    const toolTabs = (await browser.pages(/./)).length;
    await embeddedUI("($('utilities').open=true,$('ffmpeg').click())");
    assert.ok(await until(() => embeddedUI("!$('local-ffmpeg').hidden && $('local-ffmpeg').contentDocument?.querySelector('#files') !== null && $('local-ffmpeg').src===chrome.runtime.getURL('media-tool.html')")));
    await embeddedUI("$('ffmpeg').click()");
    t.check('手动 FFmpeg 在当前侧栏展开和收起', await embeddedUI("$('local-ffmpeg').hidden") && (await browser.pages(/./)).length === toolTabs);
    await panel.eval("document.querySelector('#back-to-resources').click()");
    t.check('返回时保留原来的资源筛选，窄栏没有横向滚动',await panel.eval("document.querySelector('[data-filter=audio]').getAttribute('aria-pressed')==='true' && !document.querySelector('#sidebar-playback').hasAttribute('src')"));
    const legacy = await browser.open(browser.url('popup.html?tabId=' + tabId + '&section=controls'));
    assert.ok(await until(() => legacy.eval("location.pathname==='/playback.html' && document.querySelector('#source')?.value===" + JSON.stringify(String(tabId)) + " && !document.querySelector('#player').hidden")));
    await page.eval("document.querySelectorAll('video,audio,iframe').forEach(el=>el.remove())");
    assert.ok(await until(() => legacy.eval("document.querySelector('#player').hidden && !document.querySelector('#empty-player').hidden && document.querySelector('#empty-help').textContent.length>0")));
    await page.eval("(()=>{const v=document.createElement('video');v.title='New player';v.src='/video.mp4';document.body.append(v)})()");
    assert.ok(await until(() => legacy.eval("!document.querySelector('#player').hidden && document.querySelector('#player-name').textContent==='New player'")));
    t.check('旧入口保留原网页，播放器移除后给出指引，新出现的播放器能自动识别',true);
    const classic = await browser.open(browser.url('popup.html?tabId=' + tabId));
    assert.ok(await until(() => classic.eval("document.readyState==='complete' && !!document.querySelector('#otherTab') && G.initSyncComplete")));
    await classic.eval("document.querySelector('#otherTab').click()");
    assert.ok(await until(() => classic.eval("document.querySelector('#classic-playback').contentDocument?.querySelector('#player-name')?.textContent==='New player'")));
    await classic.eval("document.querySelector('#currentTab').click()");
    t.check('原版弹窗里的播放入口共用新版控件，切回资源后停止读取播放器',
        await classic.eval("!document.querySelector('#classic-playback').hasAttribute('src')"));

    await browser.sw.eval("chrome.storage.sync.set({saveAs:true,reverse:true})");
    const settings = await browser.open(browser.url('options.html'));
    const section = () => settings.eval("document.querySelector('.settings-pane > .active').id");
    assert.ok(await until(() => settings.eval("!document.querySelector('#saveAs').disabled && document.querySelector('#saveAs').checked && document.querySelector('#reverse').checked")));
    t.check('设置首页显示用户原有的常用开关',await section() === 'general');
    await settings.eval("document.querySelector('label:has(#saveAs)').click()");
    assert.ok(await until(() => browser.sw.eval("chrome.storage.sync.get('saveAs').then(x=>x.saveAs===false)")));
    assert.ok(await settings.eval("document.querySelector('#setting-feedback').textContent===chrome.i18n.getMessage('settingsSaved')"));
    await settings.eval("document.querySelector('a[href=\"#downFileName\"]').click()");
    assert.ok(await until(async () => await section() === 'anchorReplaceTags'));
    await settings.eval("history.back()");
    assert.ok(await until(async () => await section() === 'general'));
    await settings.send('Page.reload');
    assert.ok(await until(() => settings.eval("!document.querySelector('#saveAs').disabled && !document.querySelector('#saveAs').checked")));
    t.check('从常用项跳到模板后能返回，修改保存位置会持久保存',true);
    await settings.send('Emulation.setDeviceMetricsOverride',{width:320,height:720,deviceScaleFactor:1,mobile:false});
    assert.ok(await settings.eval("document.querySelector('#settings-jump').offsetWidth>0"));
    const routes = await settings.eval("Array.from(document.querySelector('#settings-jump').options,o=>o.value)");
    for (const route of routes) {
        await settings.eval("(()=>{const s=document.querySelector('#settings-jump');s.value=" + JSON.stringify(route) + ";s.dispatchEvent(new Event('change'))})()");
        assert.ok(await until(async () => '#' + await section() === route),route);
        assert.ok(await settings.eval("document.documentElement.scrollWidth<=innerWidth"),'horizontal overflow ' + route);
    }
    t.check('手机宽度下每个分类都可访问，原有设置链接继续生效',routes.length === 19);
    await settings.eval("location.hash='#anchorType'");
    assert.ok(await until(async () => await section() === 'anchorType'));
    await settings.eval("document.querySelector('#anchorType [data-toggle-all=off]').click()");
    assert.ok(await until(() => browser.sw.eval("chrome.storage.sync.get('Type').then(x=>x.Type?.length && x.Type.every(row=>!row.state))")));
    assert.ok(await browser.sw.eval("G.Ext.get('mp4').state"));
    t.check('分类内批量开关只修改该类规则',true);
    assert.deepEqual([...panel.errors,...legacy.errors,...classic.errors,...settings.errors],[]);
});
