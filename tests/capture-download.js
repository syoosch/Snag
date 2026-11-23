'use strict';

const assert = require('node:assert/strict');
const { launch, serve, send, html, fixture, test, until } = require('./lib/harness');

test('本地网页抓取与保存', async (t) => {
    const site = await serve((req, res, url) => {
        if (url.pathname === '/watch') {
            return html(res, '<video controls src="/video.mp4"></video>');
        }
        if (url.pathname === '/playlist') {
            const manifest = '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n';
            send(req, res, Buffer.from(manifest), 'application/vnd.apple.mpegurl');
            return true;
        }
        if (url.pathname === '/tracks.mpd') {
            const list = '<SegmentTemplate duration="1" timescale="1" media="$RepresentationID$-$Number$.m4s" initialization="$RepresentationID$-init.m4s"/>';
            const video = '<AdaptationSet mimeType="video/mp4">' + list + '<Representation id="picture" codecs="avc1.42E01E" width="640" height="360" frameRate="30" bandwidth="180000"/></AdaptationSet>';
            const audio = ['en','fr'].map(lang => '<AdaptationSet lang="' + lang + '" mimeType="audio/mp4">' + list +
                '<Representation id="sound-' + lang + '" codecs="mp4a.40.2" bandwidth="64000"/></AdaptationSet>').join('');
            send(req,res,Buffer.from('<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT2S" minBufferTime="PT1S"><Period>' + video + audio + '</Period></MPD>'),'application/dash+xml');
            return true;
        }
        return false;
    });
    t.defer(site.close);

    const browser = await launch();
    t.defer(browser.close);
    const page = await browser.open(site.origin + '/watch');
    await page.eval("fetch('/playlist').then(response => response.text())");
    const tabId = await browser.tabId('/watch');
    assert.ok(tabId, '找不到测试标签页');

    const popup = await browser.open(browser.url('popup.html?tabId=' + tabId));
    const ready = await until(() => popup.eval(`(() => {
        const names = Array.from(document.querySelectorAll('#mediaList .name'), el => el.textContent);
        return names.includes('video.mp4') && names.includes('playlist');
    })()`));
    assert.ok(ready, '资源列表没有同时显示 MP4 和没有扩展名的 HLS 清单');
    const before = browser.files();
    await popup.eval(`Array.from(document.querySelectorAll('#mediaList .panel'))
        .find(row => row.querySelector('.name').textContent === 'video.mp4')
        .querySelector('.download').click()`);
    const saved = await browser.download(before);
    assert.ok(saved, '点下载后没有生成文件');
    t.check('从列表保存的 MP4 与测试视频逐字节一致', saved.equals(fixture('video.mp4')));
    await page.eval(`localStorage.setItem('CatCatchCatch_selector','title');
        window.beforeCaptureToString = Function.prototype.toString;
        window.beforeCaptureHTML = Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML').set`);
    await browser.sw.eval(`chrome.scripting.executeScript({target:{tabId:${tabId}},world:"MAIN",files:["catch-script/i18n.js","catch-script/catch.js"]})`);
    assert.ok(await page.eval("localStorage.getItem('snagCapture_selector') === 'title' && window.beforeCaptureToString === Function.prototype.toString && window.beforeCaptureHTML === Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML').set"));
    t.check('缓存捕获沿用旧设置，网页自带的文本和 HTML 行为保持正常',true);
    const dash = await browser.open(browser.url('mpd.html?url=' + encodeURIComponent(site.origin + '/tracks.mpd')));
    assert.ok(await until(() => dash.eval("document.querySelector('#mpdAudioLists')?.options.length === 2")));
    const links = await dash.eval(`[...document.querySelector('#mpdAudioLists').options].map(option => {
        $('#mpdAudioLists').val(option.value).trigger('change');
        return $('#media_file').val();
    })`);
    assert.ok(links.some(value => value.includes('sound-en-1.m4s')) && links.some(value => value.includes('sound-fr-1.m4s')));
    await dash.eval("$('#audioToM3u8').click(); true");
    const selected = links.at(-1).includes('sound-fr-') ? 'sound-fr-init.m4s' : 'sound-en-init.m4s';
    assert.ok(await until(() => dash.eval('m3u8Content.includes(' + JSON.stringify(selected) + ')')));
    t.check('DASH 解析器按所选音轨列出分片并生成对应清单',true);
});
