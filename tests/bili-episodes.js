'use strict';

const assert = require('node:assert/strict');
const {launch,fixture,intercept,test,until} = require('./lib/harness');

const frieren = {id:779776,season:46089,cid:1339446381,title:'葬送的芙莉莲',index:'2',subtitle:'也不一定要是魔法…'};
const elaina = {id:341208,season:34412,cid:281989571,title:'魔女之旅',index:'1',subtitle:'见习魔女伊蕾娜'};
const next = {...elaina,id:341209,cid:281989572,index:'2',subtitle:'测试分集'};
const third = {...elaina,id:341210,cid:281989573,index:'3',subtitle:'第三集样本'};
const media = (ep,code) => 'https://cdn.bilivideo.com/archive/'+ep.cid+'-1-'+code+'.m4s';
const singleFile = ep => 'https://cdn.bilivideo.com/archive/'+ep.cid+'/episode.mp4?quality=32';
const cover = ep => 'https://i0.hdslb.com/snag-test/'+ep.season+'.png';
const formats = [[125,'HDR 真彩'],[122,'SDR增强'],[120,'4K 超高清'],[112,'1080P 高码率'],[80,'1080P 高清'],[64,'720P 准高清'],[32,'480P 标清'],[16,'360P 流畅']]
    .map(([quality,new_description])=>({quality,new_description}));
function versions(ep) {
    return {video:[{id:80,baseUrl:media(ep,30080),height:1080,codecs:'avc1.640028'},{id:80,baseUrl:media(ep,100032),height:1080,codecs:'av01.0.08M.08'},
        {id:112,baseUrl:media(ep,30112),height:1080,codecs:'avc1.640028'},
        {id:120,baseUrl:media(ep,30120),height:2160,codecs:'hvc1.1.6'},{id:125,baseUrl:media(ep,30125),height:2160,codecs:'av01.0.12M'}],
        audio:[{baseUrl:media(ep,30280),codecs:'mp4a.40.2'}]};
}
function markup(ep,withVersions,video) {
    // Shapes published in the two reported episode / season pages. Only synthetic media is served.
    const result = {arc:{cid:ep.cid},supplement:{ogv_episode_info:{episode_id:ep.id,index_title:ep.index,long_title:ep.subtitle},
        ogv_season_info:{season_id:ep.season}},play_view_business_info:{episode_info:{ep_id:ep.id,cid:ep.cid}},
        video_info:{is_preview:!withVersions,timelength:1560041,support_formats:formats,dash:withVersions ? versions(ep) : undefined}};
    const native = !withVersions ? '' : 'window.switches=[];window.q=80;window.player={' +
        'getManifest:()=>('+JSON.stringify({cid:ep.cid,episodeId:ep.id,seasonId:ep.season})+'),'+
        'getSupportedQualityList:()=>[125,120,112,80,64,32,16],getQuality:()=>({nowQ:q,realQ:q}),'+
        'getMediaInfo:()=>({playUrl:q===32?'+JSON.stringify(singleFile(ep))+':(q===64?'+JSON.stringify(media(ep,30064))+':'+JSON.stringify(media(ep,30080))+')+","+'+JSON.stringify(media(ep,30280))+'}),'+
        'requestQuality:async v=>{switches.push(v);if(v===64)await new Promise(r=>window.finishSwitch=r);else if(v!==32)throw Error("unavailable");q=v}};';
    return '<!doctype html><meta charset="utf-8"><meta property="og:title" content="'+ep.title+'"><meta property="og:image" content="'+cover(ep).replace('https:','http:')+'">'+
        '<meta property="og:url" content="https://www.bilibili.com/bangumi/play/ep'+ep.id+'"><title>'+ep.title+'</title>'+
        '<script>window.__PLAYURL_HYDRATE_DATA__='+JSON.stringify({code:0,result})+';'+native+'</script>'+
        '<div id="bilibili-player"><video muted preload="auto" src="data:video/mp4;base64,'+video.toString('base64')+'"></video></div>';
}

test('番剧分集页、整季页与切集',async t => {
    const browser = await launch(); t.defer(browser.close);
    const page = await browser.open('about:blank');
    const v = fixture('video.mp4'), a = fixture('preview-audio.m4s');
    const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1cAAAAASUVORK5CYII=','base64');
    await intercept(page,['*'],url => {
        if (url.pathname === '/bangumi/play/ep'+frieren.id) return ['text/html; charset=utf-8',markup(frieren,false,v)];
        if (url.pathname === '/bangumi/play/ss'+elaina.season) return ['text/html; charset=utf-8',markup(elaina,true,v)];
        if (url.pathname.endsWith('.m4s')) return ['application/octet-stream',url.pathname.endsWith('30280.m4s') ? a : v];
        if (url.pathname.endsWith('/playurl')) return ['application/json','{}'];
        return ['text/plain','',404];
    });
    await page.send('Page.navigate',{url:'https://www.bilibili.com/bangumi/play/ep'+frieren.id});
    const tab = await browser.tabId('ep'+frieren.id);
    const panel = await browser.open('about:blank',430,800);
    let catalogCalls = 0;
    const unexpected = [];
    await intercept(panel,['https://api.bilibili.com/*','https://i0.hdslb.com/*'],url => {
        if (url.hostname === 'i0.hdslb.com') return ['image/png',pixel];
        if (url.pathname !== '/pgc/view/web/season') { unexpected.push(url.pathname); return ['text/plain','',404]; }
        catalogCalls++;
        return ['application/json',JSON.stringify({code:0,result:{title:elaina.title,season_id:elaina.season,cover:cover(elaina),new_ep:{id:9999},
            episodes:[elaina,next,third].map(ep=>({id:ep.id,cid:ep.cid,title:ep.index,long_title:ep.subtitle,cover:cover(ep)}))}})];
    });
    await panel.send('Page.navigate',{url:browser.url('sidebar.html?tabId='+tab)});
    const wait = async (condition,reason) => assert.ok(await until(()=>panel.eval(condition),10000),reason);
    const capture = (ep,code) => page.eval('fetch('+JSON.stringify(media(ep,code))+').then(r=>r.arrayBuffer()).then(b=>b.byteLength)');
    await capture(frieren,30080); await capture(frieren,30280);
    await wait('currentVideo?.cid==="1339446381" && groups.some(g=>g.kind==="audio" && g.point?.biliMain)','episode tracks and player');
    const expectedNumber = n => panel.eval('chrome.i18n.getMessage("sideEpisode",'+JSON.stringify(n)+')');
    const title2 = await expectedNumber('2');
    const card = '#cards .resource';
    const title = () => panel.eval('document.querySelector("'+card+' h3")?.textContent');
    assert.equal(await title(),[frieren.title,title2,frieren.subtitle].join(' · '));
    await wait('document.querySelector("#cards .thumb img")?.naturalWidth===1','loaded episode poster');
    assert.equal(await panel.eval('document.querySelector("#cards .quality").hidden'),true);
    assert.ok(await panel.eval('document.querySelector(\'#cards .quality-tier option[value="qn:125"]\')?.disabled'));
    const height = await page.eval('document.querySelector("video").videoHeight');
    assert.ok(height>0);
    await wait('document.querySelector("#cards .playback-quality").textContent===i18n("sidePlayingResolution","'+height+'p")','rendered player resolution when the file has no quality label');
    assert.ok(await panel.eval('document.querySelector("#cards .meta").textContent.includes(bytes('+v.length+'))'));
    await panel.eval('document.querySelector("#cards .locate").click()');
    assert.ok(await until(()=>page.eval('!!document.querySelector("[data-snag-outline]")')));
    assert.equal(await panel.eval('currentVideo.poster'),cover(frieren));
    t.check('分集页把已抓到的音画、封面和原位关联到正确集数，只显示实际可用版本',true);
    await page.eval('(()=>{const v=window.__PLAYURL_HYDRATE_DATA__.result.video_info;v.timelength=document.querySelector("video").duration*1000;v.durl=[{length:500}];'+
        'window.player={getManifest:()=>('+JSON.stringify({cid:frieren.cid,episodeId:frieren.id,seasonId:frieren.season})+'),getQuality:()=>({realQ:80}),'+
        'getSupportedQualityList:()=>[80,64],requestQuality:()=>{},getMediaInfo:()=>({playUrl:'+JSON.stringify(media(frieren,30080))+ '})}})()');
    await panel.eval('$id("rescan").click()');
    await wait('currentVideo.canSwitch && !document.querySelector(\'#cards .quality-tier option[value="qn:64"]\')?.disabled','full player replaced earlier preview');
    t.check('初始页面仍保留试看信息时，识别已在正常播放的完整正片',true);

    await page.send('Page.navigate',{url:'https://www.bilibili.com/bangumi/play/ss'+elaina.season});
    await wait('currentVideo?.cid==="281989571" && document.querySelectorAll("#cards .encoding option").length===2','season route with player manifest');
    assert.equal(await title(),[elaina.title,await expectedNumber('1'),elaina.subtitle].join(' · '));
    assert.ok(await panel.eval('Array.from(document.querySelectorAll("#cards .encoding option")).some(o=>o.text.includes("AV1"))'));
    assert.ok(await panel.eval('Array.from(document.querySelectorAll("#cards .encoding option")).some(o=>o.text.includes("H.264"))'));
    assert.ok(await panel.eval('document.querySelector("#cards .encoding").getClientRects().length > 0'));
    assert.ok(await panel.eval('groups.filter(g=>g.biliId).every(g=>g.biliId===currentVideo.cid)'));
    t.check('整季入口按正在看的第一集显示标题和两种编码',true);

    const tiers = await panel.eval('[...document.querySelector("#cards .quality-tier").options].map(o=>[o.value,o.text])');
    assert.deepEqual(tiers.map(([key])=>key),['qn:125','qn:120','qn:112','qn:80','qn:64','qn:32','qn:16']);
    assert.deepEqual(tiers.slice(0,4).map(([,label])=>label.split(' · ')[0]),['HDR 真彩','4K 超高清','1080P 高码率','1080P 高清']);
    const choose = async (selector,value) => panel.eval('(()=>{const s=document.querySelector("#cards '+selector+'");s.value='+JSON.stringify(value)+';s.dispatchEvent(new Event("change"));})()');
    await choose('.quality-tier','qn:125');
    assert.equal(await page.eval('switches.length'),0);
    assert.ok(await panel.eval('choice(groups.find(g=>g.kind==="video")).key.endsWith("-30125")'));
    await choose('.quality-tier','qn:80');
    await choose('.encoding','bili:'+elaina.cid+'-1-100032');
    assert.ok(await panel.eval('choice(groups.find(g=>g.kind==="video")).codec==="AV1"'));
    t.check('两个 2160p 档位保留不同站方名称，已有文件选档和选编码都不切换网页',true);

    await choose('.quality-tier','qn:64');
    await wait('document.querySelector("#cards .download").disabled','no earlier version can start during native switch');
    assert.ok(await until(()=>page.eval('typeof finishSwitch==="function"')));
    await page.eval('finishSwitch()');
    await wait('!document.querySelector("#cards .download").disabled && choice(groups.find(g=>g.kind==="video")).key.endsWith("-30064")','file from the selected native tier');
    await browser.sw.eval('chrome.offscreen.createDocument({url:"media-host.html",reasons:["BLOBS"],justification:"Test media fixtures"})');
    const target = await until(async ()=>(await browser.targets()).find(target=>target.url===browser.url('media-host.html')));
    const host = await browser.attach(target.targetId);
    const fetched = new Set();
    let saved;
    await intercept(host,['https://cdn.bilivideo.com/*'],url => {
        fetched.add(url.href);
        if (url.href===media(elaina,30064)) return ['video/mp4',v];
        if (url.href===media(elaina,30280)) return ['audio/mp4',a];
        if (url.href===singleFile(elaina) && saved) return ['video/mp4',saved];
        return ['text/plain','unexpected file',404];
    });
    const before = browser.files();
    await panel.eval('document.querySelector("#cards .download").click()');
    saved = await browser.download(before,20000);
    assert.ok(saved && saved.toString('ascii',4,8)==='ftyp' && saved.includes(Buffer.from('soun')) && saved.includes(Buffer.from('vide')),'saved MP4 with video and audio');
    assert.deepEqual([...fetched].sort(),[media(elaina,30064),media(elaina,30280)].sort());
    await choose('.quality-tier','qn:16');
    await wait('!document.querySelector("#cards .quality-tier").disabled && !document.querySelector("#cards .tier-note").hidden','reported native rejection');
    assert.equal(await panel.eval('document.querySelector("#cards .quality-tier").value'),'qn:64');
    assert.deepEqual(await page.eval('switches'),[64,16]);
    t.check('只有菜单名称时通过网站取得选中档位的实际音画，网站拒绝时保留之前的选择',true);
    await choose('.quality-tier','qn:32');
    await wait('!document.querySelector("#cards .quality-tier").disabled && choice(groups.find(g=>g.kind==="video")).qualityId===32','single-file variant of same episode');
    assert.equal(await panel.eval('groups.filter(g=>g.kind==="video" && g.info?.episodeId).length'),1);
    fetched.clear();
    const beforeSingle = browser.files();
    await panel.eval('document.querySelector("#cards .download").click()');
    assert.deepEqual(await browser.download(beforeSingle,20000),saved);
    assert.deepEqual([...fetched],[singleFile(elaina)]);
    t.check('同一集切到自带声音的单文件版本时只保存该文件',true);

    // The season URL and stale server-rendered data stay in place while the player changes CID.
    await page.eval('window.player={getVideoInfo:()=>('+JSON.stringify({cid:next.cid,epId:next.id,seasonId:next.season,dash:versions(next)})+')};'+
        'fetch("https://api.bilibili.com/pgc/player/web/v2/playurl?ep_id='+next.id+'").then(r=>r.json())');
    await wait('currentVideo?.cid==="281989572" && groups.some(g=>g.point?.biliMain && g.biliId===currentVideo.cid)','same season, late manifest');
    assert.equal(await title(),[next.title,title2,next.subtitle].join(' · '));
    assert.ok(await panel.eval('groups.every(g=>!g.biliId || g.biliId===currentVideo.cid)'));
    t.check('地址未变时也能切到新一集，旧封面关联和旧画质不会混入',true);

    await page.eval('history.pushState(null,"","/bangumi/play/ep'+third.id+'")');
    await capture(third,30080); await capture(third,30280);
    await wait('currentVideo?.cid==="281989573" && groups.some(g=>g.info?.cid===currentVideo.cid)','episode after in-page navigation');
    assert.equal(await title(),[third.title,await expectedNumber('3'),third.subtitle].join(' · '));
    assert.ok(await panel.eval('document.querySelector("#cards .quality").hidden && groups.every(g=>!g.biliId || g.biliId===currentVideo.cid)'));
    assert.ok(catalogCalls>0); assert.deepEqual(unexpected,[]);
    assert.ok(await panel.eval('!SnagBili.episodeInfo({seasonId:"34412"},{},{season_id:34412,episodes:[{id:1,cid:17}],new_ep:{id:1}})'));
    const stale = {canonicalEp:next.id,entries:[{cid:elaina.cid,seasonId:elaina.season,epId:elaina.id,index:elaina.index}]};
    const catalog = {season_id:next.season,episodes:[{id:next.id,cid:next.cid,title:next.index}]};
    assert.equal(await panel.eval('SnagBili.episodeInfo({seasonId:"34412"},'+JSON.stringify(stale)+','+JSON.stringify(catalog)+').cid'),String(next.cid));
    t.check('播放器数据滞后时按分集编号核对公开目录，不把推荐集或旧版本当成当前集',true);
    assert.deepEqual(panel.errors,[]);
});
