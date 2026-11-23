'use strict';

const assert = require('node:assert/strict');
const { launch, serve, send, fixture, segment, test, until } = require('./lib/harness');

const tracks = [segment(1), segment(2), segment(3)];
function playlist(live, count) {
    const body = tracks.slice(0,count).map((_, i) => '#EXTINF:1,\ntrack-' + i + '.ts\n').join('');
    return Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:1\n' + body + (live ? '' : '#EXT-X-ENDLIST\n'));
}
const tempFiles = `(async () => {
    const root = await navigator.storage.getDirectory();
    try { return Array.fromAsync((await root.getDirectoryHandle('snag-streams-v1')).keys()); }
    catch (e) { if (e.name === 'NotFoundError') return []; throw e; }
})()`;

test('本机流式保存与清理', async t => {
    let liveCount = 1;
    let delayed, releaseTrack;
    const site = await serve(async (req, res, url) => {
        if (['/live.m3u8','/vod.m3u8'].includes(url.pathname)) {
            const live = url.pathname === '/live.m3u8';
            send(req,res,playlist(live,live ? liveCount : 2),'application/vnd.apple.mpegurl');
            return true;
        }
        const match = /^\/track-(\d)\.ts$/.exec(url.pathname);
        if (match) {
            if (delayed && match[1] === '1') await delayed;
            send(req,res,tracks[Number(match[1])],'video/mp2t');
            return true;
        }
    });
    t.defer(site.close);
    const browser = await launch();
    t.defer(browser.close);
    assert.equal(await browser.sw.eval('chrome.runtime.onMessageExternal.hasListeners()'),false);
    assert.equal(await browser.sw.eval('G.mqttEnable || G.mqttBroker'),'');
    await browser.sw.eval("chrome.storage.sync.set({downAutoClose:false,saveAs:false,M3u8Mp4:false,M3u8Ffmpeg:false})");

    let before = browser.files();
    const direct = await browser.open(browser.url('downloader.html'));
    assert.ok(await until(() => direct.eval("document.querySelector('#getURL').offsetWidth > 0")));
    await direct.eval(`$('#url').val(${JSON.stringify(site.origin + '/video.mp4')}); $('#downStream').prop('checked',true); $('#getURL_btn').click()`);
    assert.deepEqual(await browser.download(before),fixture('video.mp4'));
    assert.ok(await until(async () => !(await direct.eval(tempFiles)).length));
    t.check('下载器边下边存得到完整 MP4，临时文件已清理',true);

    async function openHls(name) {
        const url = site.origin + '/' + name + '.m3u8';
        const parser = await browser.open(browser.url('m3u8.html?url=' + encodeURIComponent(url)));
        assert.ok(await until(() => parser.eval("_fragments.length > 0 && !!document.querySelector('#mediaList .media-item')")));
        await parser.eval("$('#mp4,#ffmpeg,#onlyAudio,#chooseOutputFile').prop('checked',false); $('#streamToDisk').prop('checked',true)");
        return parser;
    }
    const vod = await openHls('vod');
    before = browser.files();
    await vod.eval("$('#mergeTs').click(); true");
    assert.deepEqual(await browser.download(before),Buffer.concat(tracks.slice(0,2)));
    t.check('HLS 点播按清单顺序保存了每个字节',true);

    const live = await openHls('live');
    before = browser.files();
    await live.eval("$('#recorder').click(); true");
    delayed = new Promise(resolve => { releaseTrack = resolve; });
    try {
        liveCount = 2;
        assert.ok(await until(() => live.eval("recorderLast === 2"),12000),'未发现第二个分片');
        liveCount = 3;
        assert.ok(await until(() => live.eval("recorderLast === 3"),12000),'未发现第三个分片');
    } finally { releaseTrack(); }
    assert.ok(await until(() => live.eval("downDuration >= 3"),12000), '直播录制未写入更新的分片');
    await live.eval("$('#recorder').click(); true");
    assert.deepEqual(await browser.download(before),Buffer.concat(tracks));
    assert.ok(await until(async () => !(await direct.eval(tempFiles)).length));
    t.check('直播更新时等候较慢的分片，按原顺序保存并清理',true);

    const holder = await browser.open(browser.url('downloader.html'));
    assert.ok(await until(() => holder.eval('typeof SnagStream === "object"')));
    for (const page of [direct,holder]) {
        await page.eval("globalThis.testWriter = SnagStream.open('discard.bin'); testWriter.write(new Uint8Array([7,8,9]))");
    }
    const active = await direct.eval(tempFiles);
    assert.equal(active.length,2,JSON.stringify(active));
    await browser.sw.eval('SnagStream.sweep()');
    assert.deepEqual((await direct.eval(tempFiles)).sort(),active.sort());
    await direct.eval('testWriter.abort()');
    const remaining = await direct.eval(tempFiles);
    assert.equal(remaining.length,1,JSON.stringify(remaining));
    await browser.cdp.send('Target.closeTarget',{targetId:holder.targetId});
    assert.ok(await until(async () => !(await direct.eval(tempFiles)).length,12000));
    assert.ok(!browser.files().includes('discard.bin'));
    t.check('并行任务互不清理，取消和关闭页面后会回收各自的临时文件',true);
    const external = (await browser.targets()).filter(target => /^https?:/.test(target.url) && !target.url.startsWith(site.origin + '/'));
    assert.deepEqual(external.map(target => target.url),[]);
    assert.deepEqual([...direct.errors, ...vod.errors, ...live.errors],[]);
    t.check('整个流程只使用扩展与本地样片',true);
});
