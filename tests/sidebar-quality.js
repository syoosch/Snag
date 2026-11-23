'use strict';

const assert = require('node:assert/strict');
const {launch, serve, send, html, fixture, intercept, until, test} = require('./lib/harness');

test('网页播放与文件下载的画质', async t => {
    const low = fixture('quality-360.mp4'), high = fixture('quality-1080p60.mp4');
    const lowUrl = 'https://test.googlevideo.com/videoplayback?file=low';
    const highUrl = 'https://test.googlevideo.com/videoplayback?file=high';
    const lowTrack = {url:lowUrl,mimeType:'video/mp4; codecs="avc1.640028, mp4a.40.2"',qualityLabel:'360p',height:360,fps:30,audioQuality:'AUDIO_QUALITY_LOW'};
    const highTrack = {...lowTrack,url:undefined,qualityLabel:'1080p60',height:1080,fps:60};
    const data = {playabilityStatus:{status:'OK'},videoDetails:{videoId:'quality1234'},streamingData:{formats:[lowTrack,highTrack]}};
    const b = await launch();
    t.defer(b.close);
    const page = await b.open('about:blank');
    const wait = async (p,code,why) => {
        if (!await until(()=>p.eval(code))) assert.fail(why+' | '+(await p.eval('document.body.innerText')).slice(0,650)+' | '+p.errors);
    };
    const videoData = bytes => 'data:video/mp4;base64,'+bytes.toString('base64');
    const doc = '<!doctype html><title>Quality test</title><div id="movie_player"><video muted autoplay loop class="html5-main-video" src="'+
        videoData(high)+'"></video><div class="ytp-settings-menu"><div class="ytp-menuitem"><span class="ytp-menuitem-label">Quality</span>'+
        '<span class="ytp-menuitem-content">1080p<sup>60</sup> HD</span></div></div></div>'+
        '<script>window.response='+JSON.stringify(data)+';movie_player.getPlayerResponse=()=>response;</script>';
    await intercept(page,['*'],u=>u.pathname==='/watch'?['text/html',doc]:['text/plain','',404]);
    await page.send('Page.navigate',{url:'https://www.youtube.com/watch?v=quality1234'});
    await wait(page,"document.querySelector('video')?.videoHeight===1080",'real decoded HD picture');
    const tab = await b.tabId('watch?v=quality1234');
    const panel = await b.open(b.url('sidebar.html?tabId='+tab));
    const card = 'document.querySelector("#cards .resource")';
    const label = (sel,expected) => card+'?.querySelector('+JSON.stringify(sel)+')?.textContent.includes('+JSON.stringify(expected)+')';
    await wait(panel,label('.playback-quality','1080p60')+' && '+label('.file-meta','360p'),'1080p60 playing, 360p available');
    assert.ok(await panel.eval(label('.download','360p')));
    assert.ok(await panel.eval(`[...${card}.querySelector('.quality-tier').options].some(o=>o.disabled && o.text.includes('1080p60'))`));
    await page.eval(`document.querySelector('.ytp-settings-menu').insertAdjacentHTML('beforeend',
        '<div class="ytp-quality-menu"><span class="ytp-menuitem-label">2160p60</span></div>')`);
    const menuOnly = `[...${card}.querySelector('.quality-tier').options].some(o=>o.disabled && o.text.includes('2160p60'))`;
    await wait(panel,menuOnly,'page lists another quality without a file');
    await page.eval("document.querySelector('.ytp-quality-menu').remove()");
    await b.sw.eval('chrome.offscreen.createDocument({url:"media-host.html",reasons:["BLOBS"],justification:"Test local quality fixtures"})');
    const target = await until(async ()=>(await b.targets()).find(t=>t.url===b.url('media-host.html')));
    const host = await b.attach(target.targetId);
    const fetched = [];
    await intercept(host,['https://test.googlevideo.com/*'],u=>{
        fetched.push(u.href); return u.href===lowUrl ? ['video/mp4',low] : u.href===highUrl ? ['video/mp4',high] : ['text/plain','',404];
    });
    const download = async (want, url, height) => {
        const before = b.files(); fetched.length=0;
        await panel.eval(card+'.querySelector(".download").click()');
        const saved = await b.download(before,16000);
        assert.deepEqual(saved,want);
        assert.deepEqual(fetched,[url]);
        const decoded = await page.eval(`new Promise((ok,fail)=>{const v=document.createElement('video');
            v.onloadedmetadata=()=>ok(v.videoHeight);v.onerror=fail;v.src=${JSON.stringify(videoData(saved))};})`);
        assert.equal(decoded,height);
    };
    await download(low,lowUrl,360);
    assert.ok(await panel.eval(menuOnly));
    t.check('网页实播 1080p60、仅有 360p 文件时，标签和按钮说明画质，保存文件解码为 360p',true);
    await page.eval('response.streamingData.formats[1].url='+JSON.stringify(highUrl)+';document.dispatchEvent(new Event("yt-navigate-finish"))');
    await wait(panel,label('.download','1080p60'),'prefer matching HD when its real file arrives');
    await download(high,highUrl,1080);
    t.check('高清文件到达后，自动匹配网页画质，保存文件解码为 1080p',true);
    await panel.eval(`const menu=${card}.querySelector('.quality-tier');menu.value='360p';menu.dispatchEvent(new Event('change'))`);
    await page.eval('document.dispatchEvent(new Event("yt-navigate-finish"))');
    await wait(panel,label('.download','360p')+' && '+label('.playback-quality','1080p60'),'preserve manual file quality');
    assert.equal(await page.eval('document.querySelector("video").videoHeight'),1080);
    await page.eval("document.querySelector('.ytp-menuitem-content').textContent='720p'");
    await wait(panel,label('.playback-quality','1080p')+' && !'+label('.playback-quality','60'),'stale setting does not override decoded dimensions');
    t.check('手选 360p 可保留，网页切档途中按已解码画面更新',true);
    let lowRequests = 0;
    const site = await serve((req,res,u)=>{
        if (u.pathname==='/demo') return html(res,'<video muted autoplay loop><source src="/high.mp4" label="1080p60"><source src="/low.mp4" label="360p"></video>');
        if (u.pathname==='/live') return html(res,'<video muted autoplay></video><canvas width="640" height="360"></canvas><script>const c=document.querySelector("canvas");'+
            'document.querySelector("video").srcObject=c.captureStream(10);setInterval(()=>c.getContext("2d").fillRect(0,0,c.width,c.height),100)</script>');
        if (u.pathname==='/low.mp4') lowRequests++;
        if (['/low.mp4','/high.mp4'].includes(u.pathname)) {send(req,res,u.pathname==='/low.mp4'?low:high,'video/mp4'); return true;}
    });
    t.defer(site.close);
    const ordinary = await b.open(site.origin+'/demo');
    const normal = await b.open(b.url('sidebar.html?tabId='+await b.tabId('/demo')));
    await wait(normal,label('.playback-quality','1080p')+' && '+label('.download','1080p60'),'ordinary HTML player');
    await normal.eval(`const s=${card}.querySelector('.quality-tier');s.value='360p';s.dispatchEvent(new Event('change'))`);
    await wait(normal,label('.playback-quality','1080p')+' && '+label('.file-meta','360p'),'same control on a generic website');
    assert.equal(lowRequests,0);
    assert.equal(await ordinary.eval('document.querySelector("video").videoHeight'),1080);
    t.check('普通网页中的备用清晰度直接可选，列出选项期间没有下载备用文件',true);
    const switchPageQuality = () => ordinary.eval('(()=>{const v=document.querySelector("video");v.prepend(v.lastElementChild);v.load()})()');
    await switchPageQuality();
    await wait(normal,label('.playback-quality','360p'),'page switches down');
    await switchPageQuality();
    await wait(normal,label('.playback-quality','1080p')+' && '+label('.download','360p'),'manual download choice survives page quality changes');
    const live = await b.open(site.origin+'/live');
    const livePanel = await b.open(b.url('sidebar.html?tabId='+await b.tabId('/live')));
    await wait(livePanel,label('.playback-quality','360p'),'stream without downloadable file');
    await live.eval('c.width=1280;c.height=720');
    await wait(livePanel,label('.playback-quality','720p'),'same stream resizes to 720p');
    assert.equal(await livePanel.eval(card+'.querySelector(".download")'),null);
    t.check('同一视频流从 360p 切到 720p 会自动更新，只有画面时没有下载按钮',true);
    assert.deepEqual([...panel.errors,...normal.errors],[]);
});
