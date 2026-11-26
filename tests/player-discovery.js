'use strict';

const assert = require('node:assert/strict');
const {fixture, launch, serve, send, html, intercept, test, until} = require('./lib/harness');

function mountShadow(host,title) {
    const outer = host.attachShadow({mode:'open'}), inner = document.createElement('snag-inner');
    outer.append(inner);
    const root = inner.attachShadow({mode:'open'});
    root.innerHTML = '<span id="caption"></span><video muted loop aria-labelledby="caption" src="/opening.mp4"></video>';
    root.getElementById('caption').textContent=title;
    return root.querySelector('video');
}
async function checkShadowPlayers(browser,site,t) {
    const page = await browser.open(site.origin+'/shadow'), tab = await browser.tabId(site.origin+'/shadow');
    const panel = await browser.open(browser.url('sidebar.html?tabId='+tab));
    const item = title => 'frames.get(0)?.items.find(i=>i.title==='+JSON.stringify(title)+')';
    assert.ok(await until(()=>panel.eval(item('Shadow film')+'?.streamId==="4687" && '+item('Shadow film')+'?.loaded')));
    await page.eval('movie.play()');
    assert.ok(await until(()=>panel.eval(item('Shadow film')+'?.playing')));
    await page.eval('movie.pause()');
    assert.ok(await until(()=>panel.eval(item('Shadow film')+'?.playing===false')));
    const row = 'rows.get(groups.find(g=>g.point?.title==="Shadow film").key).node';
    await panel.eval(row+'.querySelector(".locate").click()');
    assert.ok(await until(()=>page.eval('document.querySelector("[data-snag-outline]")?.getBoundingClientRect().top===movie.getBoundingClientRect().top')));
    const hit = await page.eval('(()=>{const rect=movie.getBoundingClientRect();movie.style.pointerEvents="none";'+
        'const cover=document.createElement("div");cover.style.cssText="position:fixed;z-index:2;"+'+
        '"left:"+rect.left+"px;top:"+rect.top+"px;width:"+rect.width+"px;height:"+rect.height+"px";'+
        'document.querySelector("snag-outer").shadowRoot.append(cover);return [rect.left+rect.width/2,rect.top+rect.height/2]})()');
    await panel.eval('document.querySelector("#pick").click()');
    assert.ok(await until(()=>panel.eval('picking')));
    await page.click(...hit);
    assert.ok(await until(()=>panel.eval('!picking && picked?.title==="Shadow film"')));
    assert.ok(!await panel.eval('frames.get(0).items.some(i=>i.title==="closed player")'));
    await page.eval('document.querySelector("snag-outer").remove()');
    assert.ok(await until(()=>panel.eval('!('+item('Shadow film')+')')));
    t.check('嵌套两层开放根的播放器自动出现，使用内部标签和外层编号，播放、暂停、定位及移除均自动更新',true);
    await page.eval('const extra=document.createElement("snag-late");document.body.append(extra);'+
        'const arriving=document.createElement("snag-arriving");mountShadow(arriving,"Added subtree");document.body.append(arriving)');
    assert.ok(await until(()=>panel.eval(item('Added subtree')+'?.loaded')));
    await page.eval('mountShadow(extra,"Delayed attach"); true');
    await panel.eval('rescan()');
    assert.ok(await until(()=>panel.eval(item('Delayed attach')+'?.loaded')));
    await page.eval('const depthHost=document.createElement("div");let r=depthHost;for(let d=1;d<=7;d++){'+
        'const open=r.attachShadow({mode:"open"});const img=document.createElement("img");img.alt="Depth "+d;open.append(img);'+
        'r=document.createElement("div");open.append(r)}document.body.append(depthHost);');
    assert.ok(await until(()=>panel.eval('!!('+item('Depth 6')+')')));
    assert.ok(!await panel.eval('!!('+item('Depth 7')+')'));
    await page.eval('const nodes=new DocumentFragment();for(let i=0;i<68;i++){const h=document.createElement("div");'+
        'const img=document.createElement("img");img.alt="Quota "+i;h.attachShadow({mode:"open"}).append(img);nodes.append(h)}document.body.append(nodes)');
    assert.ok(await until(()=>panel.eval('frames.get(0).items.filter(i=>i.title.startsWith("Quota ")).length===54')));
    assert.deepEqual(panel.errors,[]);
    t.check('新增宿主即时发现，重新扫描补获延迟创建的根，关闭根、六层深度和 64 个开放根的边界生效',true);
}

test('播放器识别与广告切换', async t => {
    const movie = fixture('video.mp4');
    // A real fragmented MP4 fed into MediaSource. The player never gets an HTTP file URL.
    const startStream = `async video => {
        const media = new MediaSource();
        const opened = new Promise(ok => media.addEventListener('sourceopen',ok,{once:true}));
        video.src = URL.createObjectURL(media);
        await opened;
        const buffer = media.addSourceBuffer('video/mp4; codecs="avc1.42c01e"');
        const appended = new Promise(ok => buffer.addEventListener('updateend',ok,{once:true}));
        buffer.appendBuffer(Uint8Array.from(atob('${movie.toString('base64')}'), c => c.charCodeAt(0)));
        await appended;
        media.endOfStream();
        video.loop = true;
        await video.play();
    }`;
    const site = await serve((req,res,url) => {
        if (url.pathname === '/shadow') return html(res,'<span id="caption">Wrong document label</span><snag-outer data-video-id="4687"></snag-outer>'+
            '<script>'+mountShadow.toString()+';const movie=mountShadow(document.querySelector("snag-outer"),"Shadow film");'+
            'const h=document.createElement("div");h.attachShadow({mode:"closed"}).innerHTML=\'<video aria-label="closed player"></video>\';document.body.append(h)</script>');
        if (url.pathname === '/show') return html(res,'<video id="player" muted aria-label="Opening"><source src="/opening.mp4"></video>');
        if (url.pathname === '/embed') return html(res,'<video aria-label="Embedded feature" muted></video><script>('+startStream+')(document.querySelector("video"))</script>');
        if (url.pathname === '/feature.m3u8') {
            send(req,res,Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n'),'application/vnd.apple.mpegurl');
            return true;
        }
        if (url.pathname === '/opening.mp4' || url.pathname === '/feature') {
            send(req,res,movie,url.pathname === '/feature' ? 'application/octet-stream' : 'video/mp4');
            return true;
        }
    });
    t.defer(site.close);
    const b = await launch();
    t.defer(b.close);
    const page = await b.open(site.origin + '/show');
    const tab = await b.tabId('/show');
    const panel = await b.open(b.url('sidebar.html?tabId=' + tab));
    const wait = async (p,expr,why) => {
        if (!await until(() => p.eval(expr))) assert.fail(why + ' | ' + (await p.eval('document.body.innerText')).slice(0,650) + ' | ' + p.errors);
    };
    const first = 'document.querySelector("#cards .resource")';
    await wait(panel,first+'?.querySelector("h3").textContent==="Opening"','preroll found');
    const origin = await page.eval('performance.timeOrigin');
    await page.eval(`new Promise((ok,fail) => {
        const v = document.querySelector('video');
        v.addEventListener('ended',() => {
            v.setAttribute('aria-label','Feature');
            (${startStream})(v).then(ok,fail);
        },{once:true});
        v.currentTime = Math.max(0,v.duration-0.15);
        v.play().catch(fail);
    })`);
    await wait(panel,first+'?.querySelector("h3").textContent==="Feature"','main program should appear automatically before the ad');
    assert.ok(await panel.eval(first+'.dataset.playerOnly==="true" && !'+first+'.querySelector(".download")'));
    await panel.eval(first+'.querySelector(".locate").click()');
    await wait(page,'!!document.querySelector("[data-snag-outline]")','current player can be located');
    await panel.eval(first+'.querySelector(".toggle-details").click()');
    await wait(panel,first+'?.querySelector(".details img")?.naturalWidth>0','current player preview');
    t.check('广告自然结束后，正片自动排到前面；没有文件地址时可定位、预览',true);
    await page.eval("player.src='/feature'; player.loop=true; player.play()");
    await wait(panel,first+'?.querySelector("h3").textContent==="Feature" && !!'+first+'?.querySelector(".download")','real source replaces player-only card');
    const before = b.files();
    await panel.eval(first+'.querySelector(".download").click()');
    assert.deepEqual(await b.download(before,15000),movie);
    assert.equal(await page.eval('performance.timeOrigin'),origin);
    t.check('有完整文件后可直接从同一张正片卡下载，未刷新网页',true);
    await page.eval("const frame=document.createElement('iframe');frame.src='/embed';document.querySelector('video').replaceWith(frame)");
    await wait(panel,first+'?.dataset.playerOnly==="true" && '+first+'?.querySelector("h3").textContent==="Embedded feature"','the new iframe player replaces the previous current video');
    assert.ok(await panel.eval("groups.filter(g=>g.point?.playing && g.kind==='video').length===1"));
    t.check('网站换成另一个嵌入播放器后，侧栏继续跟随新视频',true);
    await b.sw.eval('chrome.storage.sync.set({enable:false})');
    await wait(panel,'!loading && !enabled && !groups.some(g=>g.playerOnly)','paused capture');
    await page.eval("fetch('/feature.m3u8').then(r=>r.text())");
    assert.ok(await b.sw.eval(`!(cacheData[${tab}] || []).some(f=>f.url.endsWith('/feature.m3u8'))`));
    await b.sw.eval('chrome.storage.sync.set({enable:true})');
    await wait(panel,"enabled && groups.some(g=>g.tracks.some(t=>t.record.fromPage && t.record.url.endsWith('/feature.m3u8')))",'playlist discovered on reconnect');
    assert.equal(site.log.filter(r=>r.path==='/feature.m3u8').length,1);
    t.check('重新打开抓取可找回已经加载的播放清单，识别过程未重取文件',true);

    const yt = await b.open('about:blank');
    const id = 'aaaaaaaaaaa', next = 'bbbbbbbbbbb';
    const cdn = 'https://stream.example.googlevideo.com/videoplayback?test=whole';
    const format = {url:cdn,mimeType:'video/mp4; codecs="avc1.42c01e, mp4a.40.2"',qualityLabel:'360p',audioQuality:'AUDIO_QUALITY_LOW',contentLength:String(movie.length)};
    const markup = '<!doctype html><title>Watch test</title><div id="movie_player" class="ad-showing"><video class="html5-main-video" muted></video></div>'+
        '<script>window.response={playabilityStatus:{status:"OK"},videoDetails:{videoId:"'+id+'"},streamingData:{formats:'+JSON.stringify([format])+'}};'+
        'movie_player.getPlayerResponse=()=>response;('+startStream+')(document.querySelector("video"));</script>';
    await intercept(yt,['*'],url => url.pathname==='/watch' ? ['text/html',markup] : ['text/plain','',404]);
    await yt.send('Page.navigate',{url:'https://www.youtube.com/watch?v='+id});
    const ytTab = await b.tabId('watch?v='+id);
    const yp = await b.open(b.url('sidebar.html?tabId='+ytTab));
    await wait(yp,first+'?.dataset.playerOnly==="true"','already-playing, in-page stream found on opening');
    assert.ok(await yp.eval(first+'.querySelector("h3").textContent===i18n.sideAdvertisement'));
    await yt.eval('movie_player.classList.remove("ad-showing")');
    await wait(yp,first+'?.querySelector("h3").textContent==="Watch test" && !!'+first+'?.querySelector(".download")','same blob, late YouTube main program link');
    await yp.eval(first+'.querySelector(".toggle-details").click()');
    assert.equal(await yp.eval(first+'.querySelector(".details a").href'),cdn);
    t.check('广告和正片复用同一播放地址时，等正片开始才提供对应的完整链接',true);
    const sound = fixture('preview-audio.m4s');
    const vision = cdn.replace('whole','picture'), audio = cdn.replace('whole','sound');
    const files = [{...format,url:vision,audioQuality:undefined,mimeType:'video/mp4; codecs="avc1.42c01e"'},
        {url:audio,mimeType:'audio/mp4; codecs="mp4a.40.2"',contentLength:String(sound.length),audioTrack:{audioIsDefault:true}},
        {...format,url:cdn+'&range=0-12'}, {...format,url:cdn+'&drm=1',drmFamilies:['protected']}, {...format,url:null,signatureCipher:'unused'}];
    await yt.eval('response.streamingData='+JSON.stringify({adaptiveFormats:files})+'; document.dispatchEvent(new Event("yt-navigate-finish"))');
    await wait(yp,'groups.find(g=>g.kind==="video")?.tracks.filter(t=>t.separate).length===2','two direct tracks and no partial or protected files');
    const target = await until(async () => (await b.targets()).find(t => t.url === b.url('media-host.html')));
    const host = await b.attach(target.targetId), fetched = new Set();
    let merged;
    await intercept(host,['https://stream.example.googlevideo.com/*'],url => {
        fetched.add(url.href);
        if (url.href === vision) return ['video/mp4',movie];
        if (url.href === audio) return ['audio/mp4',sound];
        if (url.href === cdn && merged) return ['video/mp4',merged];
        return ['text/plain','unexpected',404];
    });
    const pairBefore = b.files();
    await yp.eval(first+'.querySelector(".download").click()');
    merged = await b.download(pairBefore,15000);
    assert.ok(merged?.includes(Buffer.from('soun')) && merged.includes(Buffer.from('vide')),'download contains picture and sound');
    assert.deepEqual([...fetched].sort(),[vision,audio].sort());
    t.check('从当前正片的两条普通直链下载并合成有声视频，分段请求不混入',true);
    await yt.eval('response.streamingData.formats='+JSON.stringify([format])+'; document.dispatchEvent(new Event("yt-navigate-finish"))');
    await wait(yp,'groups.some(g=>g.tracks.some(t=>t.record.url==='+JSON.stringify(cdn)+'))','combined version appears');
    await yp.eval(`(() => {const g=groups.find(g=>g.kind==="video"),s=document.querySelector("#cards .encoding-options:not([hidden]) .encoding, #cards .quality:not([hidden])");s.value=g.tracks.find(t=>t.record.url===${JSON.stringify(cdn)}).key;s.dispatchEvent(new Event("change"));})()`);
    fetched.clear();
    const wholeBefore = b.files();
    await yp.eval(first+'.querySelector(".download").click()');
    assert.deepEqual(await b.download(wholeBefore,15000),merged);
    assert.deepEqual([...fetched],[cdn]);
    t.check('自带声音的完整版本单独保存，文件内容与原文件一致',true);
    await yt.eval('history.pushState({}, "", "/watch?v='+next+'"); document.title="Next feature"; document.dispatchEvent(new Event("yt-navigate-finish"))');
    await wait(yp,first+'?.dataset.playerOnly==="true" && '+first+'?.querySelector("h3").textContent==="Next feature"','SPA must discard previous video file');
    await yt.eval('response.videoDetails.videoId="'+next+'";response.playabilityStatus.status="LOGIN_REQUIRED";document.dispatchEvent(new Event("yt-navigate-finish"))');
    await yp.eval('document.querySelector("#rescan").click()');
    await wait(yp,'document.querySelector("#rescan").textContent===i18n.sideScanned','rescan done');
    assert.ok(await yp.eval(first+'.dataset.playerOnly==="true" && !'+first+'.querySelector(".download")'));
    await yp.eval("document.querySelector('[data-filter=all]').click()");
    assert.ok(await yp.eval('document.querySelector("#multi").hidden'),'a player without a file cannot be batch-downloaded');
    t.check('站内换片清除旧下载地址，需登录或仅发现播放器时不会提供无效下载',true);
    assert.deepEqual([...panel.errors,...yp.errors],[]);
    await checkShadowPlayers(b,site,t);
});
