'use strict';

const assert = require('node:assert/strict');
const {launch,fixture,intercept,test,until} = require('./lib/harness');
const {pictureInfo} = require('./lib/mp4');

const previous = {cid:72801,bvid:'BV1AutoA',title:'Dear John'};
const next = {cid:72802,bvid:'BV1AutoB',title:'香格里拉'};
const third = {cid:72803,bvid:'BV1AutoC',title:'下一首'};
const url = (part,id) => 'https://cdn.bilivideo.com/video/'+part.cid+'-1-'+id+'.m4s';
const pageUrl = part => 'https://www.bilibili.com/video/'+part.bvid;
const playbackUrl = part => 'https://api.bilibili.com/x/player/wbi/playurl?cid='+part.cid+'&bvid='+part.bvid;
function list(part, high) {
    const track = (id,file,height,codecs,frameRate,bandwidth) => ({id,baseUrl:url(part,file),height,codecs,frameRate,bandwidth});
    const video = [track(32,30032,480,'avc1',30,380000),track(16,30016,360,'avc1',30,242000)];
    if (high) video.unshift(track(116,30116,1080,'avc1',60,6800000),track(116,100116,1080,'hev1',60,3200000),
        track(80,30080,1080,'avc1',30,1400000));
    return {code:0,data:{dash:{duration:12,video,audio:[{baseUrl:url(part,30280),codecs:'mp4a.40.2'}]},
        accept_quality:high ? [116,80,32,16] : [32,16],
        accept_description:high ? ['1080P 60帧','1080P 高清','480P 标清','360P 流畅'] : ['480P 标清','360P 流畅']}};
}
const call = (page,fn,...args) => page.eval('('+fn.toString()+')(...'+JSON.stringify(args)+')');

test('B 站连续播放时的实际画质、编码和保存文件',async t => {
    const browser = await launch(); t.defer(browser.close);
    const page = await browser.open('about:blank');
    const picture = fixture('youtube-picture.m4s'), audio = fixture('youtube-sound.m4s');
    let documents = 0, pageLists = 0;
    await intercept(page,['*'],u => {
        if (u.href==='https://www.bilibili.com/') return ['text/html; charset=utf-8','<!doctype html><title>首页</title>'];
        if (u.href===pageUrl(previous)) {
            documents++;
            return ['text/html; charset=utf-8','<!doctype html><title>Dear John</title><h1>Dear John</h1><script>window.__INITIAL_STATE__='+
                JSON.stringify({videoData:previous})+';window.__playinfo__='+JSON.stringify(list(previous,true))+
                ';</script><div id="bilibili-player"><video muted src="data:video/mp4;base64,'+picture.toString('base64')+'"></video></div>'];
        }
        if (u.pathname==='/x/player/wbi/playurl') {
            pageLists++;
            const part = [previous,next,third].find(p=>String(p.cid)===u.searchParams.get('cid'));
            return ['application/json',JSON.stringify(list(part,true))];
        }
        return ['text/plain','',404];
    });
    await page.send('Page.navigate',{url:pageUrl(previous)});
    assert.ok(await until(()=>page.eval('document.querySelector("video").videoHeight===1080')));
    const tab = await browser.tabId(previous.bvid), panel = await browser.open('about:blank',470,720);
    await intercept(panel,['https://api.bilibili.com/*'],u => {
        const part = [previous,next,third].find(p=>p.bvid===u.searchParams.get('bvid'));
        assert.ok(part,'lookup belongs to one of the fixtures');
        return ['application/json',JSON.stringify(u.pathname.endsWith('/view') ? {code:0,data:part} : list(part,false))];
    });
    await panel.send('Page.navigate',{url:browser.url('sidebar.html?tabId='+tab)});
    const tier = 'document.querySelector("#cards .quality-tier")';
    const codec = 'document.querySelector("#cards .encoding")';
    const current = 'choice(groups.find(g=>g.kind==="video" && g.biliId===currentVideo.cid))';
    const wait = async (expr,note) => assert.ok(await until(()=>panel.eval(expr)),note);
    await wait('currentVideo?.cid==="72801" && '+tier+'?.options.length>=4','initial rich list');
    await call(page,(address,title)=>{
        history.pushState(null,'',address);
        document.querySelector('h1').textContent=title;
        // Both the tab title and initial HTML still refer to the previous video.
    },pageUrl(next),next.title);
    await wait('currentVideo?.cid==="72802" && '+tier+'?.value==="qn:32"','only the anonymous low tiers have arrived');
    assert.ok(await panel.eval('!Array.from('+tier+'.options).some(o=>o.value==="qn:116")'));
    const single = 'https://cdn.bilivideo.com/video/'+next.cid+'/small.mp4';
    await call(page,(part,picture,audio,other,single)=>{
        window.q=116;
        window.switches=[];
        window.player={getVideoInfo:()=>({bvid:part.bvid,cid:part.cid,p:1}),getManifest:()=>({cid:part.cid}),
            getQuality:()=>({realQ:q}),getSupportedQualityList:()=>[116,80,64,32,16,6],
            getMediaInfo:()=>({playUrl:q===6 ? single : (q===116?picture:other)+','+audio}),
            requestQuality:v=>{switches.push(v);q=v}};
        document.querySelector('video').dispatchEvent(new Event('loadedmetadata'));
    },next,url(next,30116),url(next,30280),url(next,30064),single);
    await wait(tier+'.value==="qn:116" && '+current+'.record.url==='+JSON.stringify(url(next,30116)),'current stream is available before its full list');
    t.check('连播暂时只查到 480p 时，播放器就绪会自动识别正在播的 1080p60 文件',true);
    const xhr = (address) => call(page,address=>new Promise((resolve,reject)=>{
        const x=new XMLHttpRequest();x.open('GET',address);x.responseType='json';
        x.onload=()=>resolve(x.response.code);x.onerror=reject;x.send();
    }),address);
    assert.equal(await xhr(playbackUrl(next)),0);
    await wait(codec+'?.options.length===2 && '+tier+'.options[0].text.includes("1080P 60帧")','late XHR list yields both encodings and official tier names');
    assert.ok(await panel.eval('document.querySelector("#cards .playback-quality").textContent.includes("1080p60")'));
    await wait('document.querySelector("#scope").selectedOptions[0]?.text.includes("香格里拉") && '+
        '(!window.HTMLSelectedContentElement || document.querySelector("#scope selectedcontent").textContent.includes("香格里拉"))',
        'visible header title follows current video');
    const geometry = await panel.eval('('+function() {
        if (!CSS.supports("appearance","base-select") || !CSS.supports("selector(::picker(select))")) return;
        const select=document.querySelector('#cards .encoding');
        const option=select.selectedOptions[0];
        return {name:option.querySelector('.encoding-name')?.textContent,size:option.querySelector('.encoding-size')?.textContent,
            stats:option.querySelector('.encoding-stats')?.textContent,trigger:select.getBoundingClientRect().width};
    }.toString()+')()');
    if (geometry) assert.ok(geometry.name==='H.264' && geometry.size && geometry.stats.includes('60 fps') && geometry.stats.includes('6.8 Mbps') && geometry.trigger<90);
    await call(page,address=>fetch(address).then(r=>r.json()).then(r=>r.code),playbackUrl(previous));
    assert.ok(await panel.eval(current+'.record.url==='+JSON.stringify(url(next,30116))));
    assert.deepEqual(await page.eval('switches'),[]);

    await browser.sw.eval('chrome.offscreen.createDocument({url:"media-host.html",reasons:["BLOBS"],justification:"Test media fixtures"})');
    const target=await until(async()=>(await browser.targets()).find(v=>v.url===browser.url('media-host.html')));
    const host=await browser.attach(target.targetId), fetched=new Set();
    await intercept(host,['https://cdn.bilivideo.com/*'],u=>{
        fetched.add(u.href);
        if (u.href===url(next,30116)) return ['video/mp4',picture];
        if (u.href===url(next,30280)) return ['audio/mp4',audio];
        return ['text/plain','wrong part or quality',404];
    });
    const before=browser.files();
    await panel.eval('document.querySelector("#cards .download").click()');
    const saved=await browser.download(before,20000);
    assert.deepEqual(pictureInfo(saved),{frames:720,fps:60,seconds:12});
    assert.equal(await call(page,source=>new Promise((resolve,reject)=>{
        const video=document.createElement('video');video.onloadedmetadata=()=>resolve(video.videoHeight);video.onerror=reject;video.src=source;
    }),'data:video/mp4;base64,'+saved.toString('base64')),1080);
    assert.deepEqual([...fetched].sort(),[url(next,30116),url(next,30280)].sort());
    t.check('原网页标题仍是上一首时，侧栏显示新标题和两个编码，保存的 MP4 实测 1080p60 并含声音',true);
    await call(panel,()=>{const select=document.querySelector('#cards .quality-tier');select.value='qn:64';select.dispatchEvent(new Event('change'))});
    await wait(current+'.record.url==='+JSON.stringify(url(next,30064))+' && '+tier+'.value==="qn:64"','explicit choice resolves the actual 720p file');
    assert.deepEqual(await page.eval('switches'),[64]);
    await call(panel,()=>{const select=document.querySelector('#cards .quality-tier');select.value='qn:6';select.dispatchEvent(new Event('change'))});
    await wait(current+'.record.url==='+JSON.stringify(single)+' && '+tier+'.value==="qn:6"','a progressive tier shares the same current video card');
    t.check('只有菜单名称的画质，在点选时才切换网页并核对实际文件',true);
    await call(page,address=>fetch(address).then(r=>r.json()).then(r=>r.code),playbackUrl(third));
    await call(page,(address,title)=>{delete window.player;history.pushState(null,'',address);document.querySelector('h1').textContent=title},pageUrl(third),third.title);
    await wait('currentVideo?.cid==="72803" && document.querySelector(\'#cards .quality-tier option[value="qn:116"]\') && '+current+'.record.url.includes("72803-")',
        'prefetched fetch list works on next route without runtime player API');
    assert.ok(await panel.eval('groups.every(g=>!g.biliId || g.biliId==="72803")'));
    assert.equal(documents,1);
    assert.equal(pageLists,3);
    assert.deepEqual(panel.errors,[]);
    t.check('预载清单和上一条的迟到响应按视频区分，全程只加载一次网页',true);

    await page.send('Page.navigate',{url:'https://www.bilibili.com/'});
    assert.ok(await until(()=>page.eval('document.title==="首页" && typeof window.__snagBiliList==="undefined"')));
    await call(page,address=>history.pushState(null,'',address),pageUrl(next));
    assert.ok(await until(()=>page.eval('typeof window.__snagBiliList==="function"')));
    await xhr(playbackUrl(next));
    await wait('currentVideo?.cid==="72802" && document.querySelector(\'#cards .quality-tier option[value="qn:116"]\')',
        'a document opened outside /video can acquire the observer without a reload');
    t.check('从已打开的首页进入视频，也能原地接收后续的高清清单',true);
});
