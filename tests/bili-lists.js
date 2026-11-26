'use strict';

const assert = require('node:assert/strict');
const {launch,fixture,intercept,test,until} = require('./lib/harness');
const {pictureInfo} = require('./lib/mp4');

const origin = 'https://www.bilibili.com';
const first = {bvid:'BV1ListA',aid:74101,cid:84101,title:'列表甲',duration:12};
const second = {bvid:'BV1ListB',aid:74102,cid:84102,title:'列表乙',duration:12};
const secondPart = {...second,cid:84103};
const parts = [first,second,secondPart];
const watchLater = origin+'/list/watchlater/?oid=91234&bvid='+first.bvid+'&watchlater_cfg=test';
const favorites = origin+'/list/ml7654';
const file = (part,rendition) => 'https://cdn.bilivideo.com/list/'+part.cid+'-1-'+rendition+'.m4s';
const playurl = part => 'https://api.bilibili.com/x/player/wbi/playurl?cid='+part.cid+'&bvid='+part.bvid;
const call = (tab,fn,...args) => tab.eval('('+fn.toString()+')(...'+JSON.stringify(args)+')');
function view(part) {
    const pages = (part === first ? [part] : [second,secondPart])
        .map((p,i)=>({page:i+1,cid:p.cid,part:'分 P '+(i+1),duration:12}));
    return {...part,pages};
}
function playlist(part) {
    return {code:0,data:{dash:{duration:12,
        video:[{id:116,baseUrl:file(part,30116),height:1080,codecs:'avc1',frameRate:'60',bandwidth:4000000}],
        audio:[{baseUrl:file(part,30280),codecs:'mp4a.40.2'}]},
        accept_quality:[116,64],accept_description:['1080P 60帧','720P 高清']}};
}
function player(part,video,audio,alternate) {
    let q = 116;
    window.switches = [];
    window.player = {
        getManifest:()=>({cid:part.cid}),getVideoInfo:()=>({bvid:part.bvid,aid:part.aid,cid:part.cid}),
        getSupportedQualityList:()=>[116,64],getQuality:()=>({realQ:q}),
        getMediaInfo:()=>({playUrl:(q===116 ? video : alternate)+','+audio}),
        requestQuality:id=>{window.switches.push(id);q=id}
    };
    document.querySelector('video').dispatchEvent(new Event('loadedmetadata'));
}

test('B 站列表播放器与当前音画的关联',async t => {
    const browser = await launch(); t.defer(browser.close);
    const page = await browser.open('about:blank');
    const picture = fixture('youtube-picture.m4s'), sound = fixture('youtube-sound.m4s');
    const requests = [];
    const documentBody = '<!doctype html><meta charset="utf-8"><title>列表</title><h1>队列</h1>'+
        '<div id="bilibili-player"><video muted preload="metadata"></video></div><script>'+
        'window.__INITIAL_STATE__='+JSON.stringify({videoData:view(second)})+';'+
        'const bytes=Uint8Array.from(atob('+JSON.stringify(picture.toString('base64'))+'),s=>s.charCodeAt(0));'+
        'document.querySelector("video").src=URL.createObjectURL(new Blob([bytes],{type:"video/mp4"}));</script>';
    await intercept(page,['https://*/*'],u=>{
        if (u.origin===origin) return ['text/html; charset=utf-8',documentBody];
        if (u.pathname==='/x/player/wbi/playurl') {
            const part = parts.find(p=>String(p.cid)===u.searchParams.get('cid'));
            return ['application/json',JSON.stringify(playlist(part))];
        }
        if (u.hostname==='cdn.bilivideo.com') return u.pathname.endsWith('-30280.m4s') ? ['audio/mp4',sound] : ['video/mp4',picture];
        return ['text/plain','unknown fixture',404];
    });
    const ready = () => until(()=>page.eval('document.querySelector("video")?.videoHeight===1080'));
    const observe = part => call(page,address=>fetch(address).then(r=>r.json()).then(b=>b.code),playurl(part));
    const setPlayer = part => call(page,player,part,file(part,30116),file(part,30280),file(part,30064));
    const navigate = path => call(page,path=>history.pushState(null,'',path),path);
    await page.send('Page.navigate',{url:watchLater});
    assert.ok(await ready(),'the visible player has a decoded blob video');
    assert.equal(await observe(first),0);
    await call(page,(v,a)=>Promise.all([v,a].map(u=>fetch(u).then(r=>r.arrayBuffer().then(b=>b.byteLength)))),file(first,30116),file(first,30280));
    const earlyList = await page.eval('!!window.__snagBiliList') && await until(()=>page.eval('!!window.__snagBiliList('+first.cid+')'));

    const tab = await browser.tabId('/list/watchlater/'), panel = await browser.open('about:blank',470,720);
    await intercept(panel,['https://api.bilibili.com/*'],u=>{
        requests.push(u.href);
        const part = parts.find(p=>p.bvid===u.searchParams.get('bvid') || String(p.aid)===(u.searchParams.get('aid') || u.searchParams.get('avid')));
        if (part && u.pathname==='/x/web-interface/view') return ['application/json',JSON.stringify({code:0,data:view(part)})];
        if (part === second && u.pathname==='/x/player/playurl') {
            const match = parts.find(p=>p.bvid===part.bvid && String(p.cid)===u.searchParams.get('cid'));
            if (match) return ['application/json',JSON.stringify(playlist(match))];
        }
        // A raw network capture and the site's own list must suffice even if the public quality query fails.
        return ['application/json','{"code":-404}',404];
    });
    await panel.send('Page.navigate',{url:browser.url('sidebar.html?tabId='+tab)});
    const wait = async (expr,msg) => assert.ok(await until(()=>panel.eval(expr)),msg);
    const current = 'groups.find(g=>g.kind==="video" && g.biliId===currentVideo?.cid)';
    const matched = async part => {
        const ok = await until(()=>panel.eval('currentVideo?.cid==="'+part.cid+'" && currentVideo.title.includes('+JSON.stringify(part.title)+') && '+
            current+'?.point?.biliMain && '+current+'.tracks.some(t=>t.kind==="audio") && '+
            'groups.filter(g=>g.kind==="video").length===1 && !!document.querySelector("#cards .download:not([disabled])")'));
        if (!ok) assert.fail('one main card with sound expected for '+part.cid+', got '+JSON.stringify(await panel.eval(
            'groups.filter(g=>g.kind==="video").map(g=>({player:!!g.point,video:g.biliId,tracks:g.tracks.map(t=>t.kind)}))')));
    };
    await matched(first);
    assert.ok(earlyList,'the playlist was captured before opening the sidebar');
    assert.ok(requests.some(href=>new URL(href).searchParams.get('bvid')===first.bvid));
    t.check('稍后再看在侧栏打开前收到清单，旧页面数据与播放器 blob 均不妨碍归并正在播放的音画',true);

    await browser.sw.eval('chrome.offscreen.createDocument({url:"media-host.html",reasons:["BLOBS"],justification:"Test media fixtures"})');
    const hostTarget = await until(async()=>(await browser.targets()).find(v=>v.url===browser.url('media-host.html')));
    const host = await browser.attach(hostTarget.targetId), savedUrls = [];
    await intercept(host,['https://cdn.bilivideo.com/*'],u=>{
        savedUrls.push(u.href);
        if (u.href===file(first,30116)) return ['video/mp4',picture];
        if (u.href===file(first,30280)) return ['audio/mp4',sound];
        return ['text/plain','wrong list item',404];
    });
    const before = browser.files();
    await panel.eval('document.querySelector("#cards .download").click()');
    const saved = await browser.download(before,20000);
    assert.deepEqual(pictureInfo(saved),{frames:720,fps:60,seconds:12});
    assert.equal(await call(page,source=>new Promise((resolve,reject)=>{
        const video=document.createElement('video');
        video.onloadedmetadata=()=>resolve(video.videoHeight);video.onerror=reject;video.src=source;
    }),'data:video/mp4;base64,'+saved.toString('base64')),1080);
    assert.deepEqual([...new Set(savedUrls)].sort(),[file(first,30116),file(first,30280)].sort());
    t.check('从正片卡片保存 MP4，核对视频、音轨、720 帧及 12 秒时长',true);

    await setPlayer(first);
    const tier = 'document.querySelector("#cards .quality-tier")';
    await wait('currentVideo?.canSwitch && '+tier+'?.querySelector(\'option[value="qn:64"]\')','site offers manual 720p');
    await panel.eval(tier+'.value="qn:64";'+tier+'.dispatchEvent(new Event("change"))');
    await wait('choice('+current+').record.url==='+JSON.stringify(file(first,30064)),'chosen file belongs to current list item');
    assert.deepEqual(await page.eval('window.switches'),[64]);
    const epoch = await panel.eval('generation');
    await navigate(watchLater+'&spm_id_from=local');
    await call(panel,()=>new Promise(resolve=>setTimeout(resolve,200)));
    assert.equal(await panel.eval('generation'),epoch);
    t.check('列表中手动选 720p 能找到对应文件，仅改变跟踪参数会保留当前选择',true);

    await observe(secondPart);
    const collection = '/list/74120/?sid=835&bvid='+second.bvid+'&p=2';
    await navigate(collection);
    await setPlayer(secondPart);
    await matched(secondPart);
    await observe(first);
    await panel.eval('rescan()');
    assert.ok(await panel.eval('groups.every(g=>!g.biliId || g.biliId==="'+secondPart.cid+'") && currentVideo.title.includes("分 P 2")'));
    t.check('进入合集的第二个分 P 后，只采用对应 CID 的音画，上一项迟到的响应不会改回卡片',true);

    await page.send('Page.navigate',{url:favorites});
    assert.ok(await ready());
    await wait('videoRoute?.list && !videoRoute.id && frames.get(0)?.ready && !currentVideo','addressless queue waits for the player');
    await observe(first);
    await call(page,url=>fetch(url).then(r=>r.arrayBuffer()).then(b=>b.byteLength),file(first,30116));
    await panel.eval('rescan()');
    await wait('!currentVideo && !groups.some(g=>g.biliId) && groups.some(g=>g.rawSegment)','uncertain media stays in the fragments drawer');
    await setPlayer(first);
    await matched(first);
    const sameDocument = await panel.eval('generation');
    // Let an old public reply arrive after the actual player changed but before its next metadata event.
    await panel.eval('Promise.resolve(frames.get(0).qualityScan)');
    await call(panel,(cid,body)=>{
        const fetchPublic=window.fetch;
        window.fetch=function(address,options) {
            const url=new URL(address);
            if (url.pathname!=='/x/player/playurl' || url.searchParams.get('cid')!==String(cid)) return fetchPublic(address,options);
            window.fetch=fetchPublic;
            return new Promise(resolve=>{window.finishOldList=()=>resolve(new Response(JSON.stringify(body)))});
        };
        window.oldLookup=recoverPublicTracks(generation,tabId);
    },first.cid,playlist(first));
    await wait('typeof window.finishOldList==="function"','old public request in flight');
    await call(page,part=>{window.player={getManifest:()=>({cid:part.cid}),getVideoInfo:()=>part}},secondPart);
    await panel.eval('window.finishOldList(); window.oldLookup');
    assert.ok(await panel.eval('!publicTracks.length'),'old public files are discarded before the next scan');
    await observe(secondPart);
    await call(page,(cid,stale)=>{
        window.__INITIAL_STATE__.videoData=stale;
        window.player={getManifest:()=>({cid})};
        document.querySelector('video').dispatchEvent(new Event('loadedmetadata'));
    },secondPart.cid,view(first));
    await matched(secondPart);
    assert.equal(await panel.eval('generation'),sameDocument);
    assert.ok(await panel.eval('currentVideo.title.includes("分 P 2") && groups.every(g=>!g.biliId || g.biliId==="'+secondPart.cid+'")'));
    t.check('收藏夹地址不变、播放器只给 CID 时，按该分 P 的清单识别换片，单独预载不会改变当前项',true);

    await call(page,stale=>{player.getVideoInfo=()=>stale;document.querySelector('video').dispatchEvent(new Event('loadedmetadata'))},first);
    await wait('!currentVideo && !groups.some(g=>g.biliId)','conflicting player snapshots clear the old card');
    await navigate('/medialist/play/ml7654/'+first.bvid);
    await setPlayer(first);
    await matched(first);
    await navigate('/watchlater/#/av'+first.aid+'/p1');
    await call(page,part=>{
        player.getVideoInfo=()=>({bvid:part.bvid,cid:part.cid});
        document.querySelector('video').dispatchEvent(new Event('loadedmetadata'));
    },first);
    await matched(first);
    await wait('videoRoute.fragment && currentVideo?.id==="av'+first.aid+'" && currentVideo.canSwitch','an AV link and a BV-only player can match the same part');
    await call(page,(bvid)=>{location.hash='/'+bvid+'/p2'},second.bvid);
    await setPlayer(secondPart);
    await matched(secondPart);
    assert.ok(await panel.eval('videoRoute.fragment && currentVideo.title.includes("分 P 2")'));
    t.check('旧式稍后再看只切换地址锚点时，正片卡片跟随新视频及其分 P',true);
    const routes = await call(panel,paths=>paths.map(path=>SnagBili.route(path)),[
        origin+'/list/42?aid=74102&p=2',origin+'/list/ml7654?oid=1234',origin+'/video/av74102?p=2',
        origin+'/medialist/play/watchlater/BV1ListB?cid=84103',origin+'/search?bvid=BV1ListA',
        'https://example.com/list/watchlater?bvid=BV1ListA',origin+'/watchlater/#/list']);
    assert.deepEqual(routes.map(r=>r ? [r.id,r.part,r.cid || ''] : null),[
        ['av74102',2,''],['',1,''],['av74102',2,''],['BV1ListB',1,'84103'],null,null,null]);
    assert.ok(requests.every(href=>{
        const u=new URL(href);
        return ['/x/web-interface/view','/x/player/playurl'].includes(u.pathname) &&
            parts.some(p=>p.bvid===u.searchParams.get('bvid') || String(p.aid)===(u.searchParams.get('aid') || u.searchParams.get('avid')));
    }),'all lookups identify a known video; no queries for private list contents');
    assert.deepEqual(panel.errors,[]);
    t.check('识别旧式播放列表与 AV 编号，播放器信息冲突时清除旧项，收藏夹编号和推荐参数不会被认作视频',true);
});
