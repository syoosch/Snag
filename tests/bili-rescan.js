'use strict';

const assert = require('node:assert/strict');
const {launch, fixture, test, until, intercept} = require('./lib/harness');

const oldVideo = { bvid:'BV1FFyhzSED7', cid:43784735064, title:'【龙哥/卫戍】一回合倒转400层吓哭了？', duration:4 };
const newVideo = { bvid:'BV1KQ4y1c7zB', cid:1417563286, title:'太空探索', duration:4 };
const part2 = { page:2, cid:1417563299, part:'第二段', duration:4 };
const part3 = { page:3, cid:1417563300, part:'第三段', duration:4 };
const watch = video => 'https://www.bilibili.com/video/' + video.bvid + '/';
const file = (cid,code,mirror = 'a') => 'https://' + mirror + '.bilivideo.com/video/' + cid + '-1-' + code + '.m4s';
const track = (cid,id,codecs,bitrate) => ({baseUrl:file(cid,id),codecs,bandwidth:bitrate,height:1080,frameRate:'30000/1001'});
const dash = cid => ({duration:4,video:[track(cid,100029,'avc1.640028',5200000),track(cid,100032,'av01.0.08M.08',1900000)],
    audio:[{baseUrl:file(cid,30280),backupUrl:[file(cid,30280,'backup')],codecs:'mp4a.40.2',bandwidth:192000}],
    flac:{audio:{baseUrl:file(cid,30251),codecs:'fLaC',bandwidth:990000}}});

test('B 站同一页换片、重扫与独立音轨试听',async t => {
    const browser = await launch({requireGesture:true});
    t.defer(browser.close);
    t.check('部分响应只按完整文件的总长度显示大小',await browser.sw.eval(`(() => {
        const headers = [{name:'content-length',value:'1000'}];
        const range = value => ({name:'content-range',value:'bytes 0-999/'+value});
        const size = (statusCode,responseHeaders) => getResponseHeadersValue({statusCode,responseHeaders}).size;
        return size(200,headers)===1000 && size(206,[...headers,range('240000')])===240000 &&
            size(206,[range('*'),...headers])===undefined;
    })()`));
    const page = await browser.open('about:blank');
    const aac = fixture('preview-audio.m4s'), flac = fixture('preview-flac.m4s'), video = fixture('video.mp4');
    let documents = 0, mediaRequests = 0, lookups = 0, publicLists = 0;
    const taggedCid = oldVideo.cid + '_qe1';
    const markup = '<title>' + oldVideo.title + '</title><script>window.__INITIAL_STATE__=' + JSON.stringify({videoData:oldVideo}) +
        ';</script><script>window.__playinfo__=' + JSON.stringify({data:{dash:dash(taggedCid)}}) +
        ';</script><div id="bilibili-player"><video id="web" muted preload="auto" src="data:video/mp4;base64,' +
        video.toString('base64') + '"></video></div>';
    await intercept(page,['*'],(url,request) => {
        if (url.pathname.startsWith('/video/BV')) {
            documents++;
            return ['text/html; charset=utf-8','<!doctype html>' + markup];
        }
        if (url.hostname === 'api.bilibili.com' && url.pathname === '/x/player/wbi/playurl') return ['application/json','{"code":0}'];
        if (url.pathname.endsWith('.m4s')) {
            mediaRequests++;
            if (url.hostname === 'a.bilivideo.com' && url.pathname.endsWith('30280.m4s')) return ['text/plain','temporarily unavailable',503];
            // A common CDN behaviour: the track is playable from the original video page.
            if (!Object.entries(request.headers).some(([key,value]) => key.toLowerCase() === 'referer' && value.startsWith('https://www.bilibili.com/'))) return ['text/plain','missing page',403];
            const audio = url.pathname.endsWith('30251.m4s') ? flac : url.pathname.endsWith('30280.m4s') ? aac : null;
            return ['application/octet-stream',audio || video];
        }
        return ['text/plain','',404];
    });
    await page.send('Page.navigate',{url:watch(oldVideo)});
    assert.ok(await until(() => page.eval('web.readyState>=2')));
    const tabId = await browser.tabId(oldVideo.bvid);
    const panel = await browser.open('about:blank',470,800);
    await intercept(panel,['https://api.bilibili.com/*'],url => {
        assert.equal(url.searchParams.get('bvid'),newVideo.bvid);
        if (url.pathname === '/x/player/playurl') {
            if (url.searchParams.get('cid') !== String(part3.cid)) return ['application/json',JSON.stringify({code:0,data:{}})];
            publicLists++;
            return ['application/json',JSON.stringify({code:0,data:{dash:dash(part3.cid + '_qe1')}})];
        }
        lookups++;
        const pages = [{page:1,cid:newVideo.cid,part:'上半场',duration:4},part2,part3];
        return ['application/json',JSON.stringify({code:0,data:{...newVideo,pages}})];
    });
    await panel.send('Page.navigate',{url:browser.url('sidebar.html?tabId=' + tabId)});
    const wait = async (expr,note) => assert.ok(await until(() => panel.eval(expr)),note);
    await wait("!loading && !$id('rescan').disabled",'panel connected');
    const fetchTrack = url => page.eval('fetch(' + JSON.stringify(url) + ').then(r=>{if(!r.ok)throw Error(r.status);return r.arrayBuffer().then(b=>b.byteLength)})');
    const encoding = "document.querySelector('#cards .encoding-options:not([hidden]) .encoding')";
    await wait(encoding+"?.options.length===2",'unplayed encodings on first open');
    t.check('首次打开就显示同一画质的两个编码版本和估算大小',await panel.eval(`[...${encoding}.options].every(o=>o.textContent.includes(
        i18n('sideEstimatedSize',bytes(o.value.endsWith('100032')?950000:2600000))))`));
    await panel.eval("const quality="+encoding+";quality.value=[...quality.options].find(o=>o.value.endsWith('100032')).value;quality.dispatchEvent(new Event('change'))");
    const pair = await panel.eval(`(async () => {
        const original = mediaCommand;
        let resolve;
        const payload = new Promise(r => { resolve = r; });
        mediaCommand = async (op,params) => {
            if (op === 'start') { resolve(params.request); return {}; }
            return original(op,params);
        };
        try {
            document.querySelector('#cards .download').click();
            const request = await payload;
            return request.files.map(f => ({kind:f.kind,referer:f.headers.referer,title:request.title}));
        } finally { mediaCommand = original; }
    })()`);
    t.check('未播放的画质可直接把正确的音画和来源交给本机任务',pair.length===2 &&
        pair[0].kind==='video' && pair[1].kind==='audio' && pair.every(f=>f.title===oldVideo.title && f.referer==='https://www.bilibili.com/'));
    const more = dash(taggedCid);
    more.video.push({...track(taggedCid,30064,'avc1.640028',800000),height:720,size:123456});
    await page.eval('window.__playinfo__=' + JSON.stringify({data:{dash:more}}) + ';fetch("https://api.bilibili.com/x/player/wbi/playurl").then(r=>r.json())');
    const tier = "document.querySelector('#cards .quality-tier:not([hidden])')";
    const choose = (control,value) => panel.eval("(()=>{const s="+control+";s.value="+JSON.stringify(value)+";s.dispatchEvent(new Event('change'))})()");
    await wait(tier+" && [..."+tier+".options].some(o=>o.value==='720p') && "+encoding+"?.value.endsWith('100032')",'new quality joins without losing selected encoding');
    await choose(tier,'720p');
    const meta = "document.querySelector('#cards .file-size').textContent";
    await wait(meta+".includes(bytes(123456))",'actual size of new rendition');
    t.check('播放器后来收到的新画质也能自动加入，有明确字节数时显示准确大小',!await panel.eval(meta+".includes(i18n('sideEstimatedSize',bytes(123456)))"));
    await choose(tier,'1080p');
    const av1 = await panel.eval("[..."+encoding+".options].find(o=>o.value.endsWith('100032')).value");
    await choose(encoding,av1);
    await fetchTrack(file(taggedCid,100032));
    await wait("document.querySelector('#cards .meta').textContent.includes(bytes(" + video.length + "))",'actual size replaced estimate');
    t.check('捕获到文件后以实测大小替换估算，并保留选中的版本',await panel.eval(encoding+".value.endsWith('100032') && !"+encoding+".selectedOptions[0].textContent.includes(i18n('sideEstimatedSize',bytes(950000)))"));
    await fetchTrack(file(taggedCid,30102) + '?s=one');
    await fetchTrack(file(taggedCid,30102,'b') + '?s=two');
    await fetchTrack(file(taggedCid,30280,'b'));
    await wait("['video','audio'].every(kind=>groups.some(g=>g.kind===kind && g.biliId==='43784735064' && g.point?.biliMain))",'tagged tracks match the player');
    await wait("groups.some(g=>g.kind==='video' && g.tracks.some(track=>track.rendition==='30102'))",'newly captured rendition added');
    t.check('两条 30102 镜像合为一个可定位的视频，30280 出现在音频分类',await panel.eval(`(() => {
        const group=groups.find(g=>g.kind==='video' && g.biliId===currentVideo.cid);
        const audio=groups.find(g=>g.kind==='audio' && g.biliId===currentVideo.cid);
        return document.querySelector('#cards h3')?.textContent===${JSON.stringify(oldVideo.title)} &&
            group.tracks.filter(t=>t.rendition==='30102').length===1 && !group.rawSegment && !audio.rawSegment &&
            audio.tracks.some(t=>t.rendition==='30280' && t.codec==='AAC');
    })()`));
    await fetchTrack(file(oldVideo.cid,30102,'b'));
    await wait("groups.some(g=>g.kind==='video' && g.tracks.filter(t=>t.rendition==='30102').length===2)",'distinct tagged and untagged files');
    await choose(tier,'captured');
    t.check('相同编码的两份文件在版本菜单里分别选择',await panel.eval("new Set([...document.querySelector('#cards .quality:not([hidden])').options].map(o=>o.value).filter(key=>key.endsWith('-30102'))).size===2"));
    const timeOrigin = await page.eval('performance.timeOrigin');
    await page.eval('history.pushState(null,"",' + JSON.stringify(watch(newVideo) + '?from=playlist') + ');document.title="太空探索";web.currentTime=1.1');
    // The old document and inline manifest stay in place. The new CDN uses a different mirror and signature.
    await fetchTrack(file(newVideo.cid,100029,'b') + '?s=changed');
    await fetchTrack(file(newVideo.cid,30251,'b') + '?s=changed');
    await wait("currentVideo?.cid==='1417563286' && ['video','audio'].every(kind=>groups.some(g=>g.kind===kind && g.point?.biliMain && g.biliId===currentVideo.cid))",'both new tracks attached');
    t.check('同页换片后当前视频和音轨分别可见，上一条的文件移出列表',lookups > 0 &&
        await panel.eval("groups.filter(g=>g.biliId).length===2 && groups.every(g=>!g.biliId || (g.biliId===currentVideo.cid && !g.rawSegment))"));
    await page.eval('window.__playinfo__=' + JSON.stringify({data:{dash:dash(newVideo.cid)}}) + ';performance.clearResourceTimings()');
    const before = mediaRequests;
    const encodings = "[..."+encoding+".options]";
    await wait(encodings+".some(o=>o.textContent.includes('AV1'))",'late player manifest without manual rescan');
    t.check('同页换片后迟到的画质清单也会自动出现',true);
    await panel.eval("$id('rescan').click()");
    await wait("$id('rescan').textContent===i18n.sideScanned && "+encodings+".some(o=>o.textContent.includes('AV1'))",'rescan recovered live manifest and missing rendition');
    const labels = await panel.eval(encodings+".map(o=>o.textContent)");
    t.check('同为 1080p 的两个版本显示各自的编码、帧率和码率',labels.length===2 && labels.some(s=>s.includes('H.264') && s.includes('29.97 fps') && s.includes('5.2 Mbps')) && labels.some(s=>s.includes('AV1') && s.includes('1.9 Mbps')));
    t.check('轻量重扫能补回未留在请求记录的版本，页面和视频都没有重新请求',documents===1 && mediaRequests===before && await page.eval('performance.timeOrigin')===timeOrigin && await page.eval('web.paused && web.currentTime>1'));
    await panel.eval("selectFilter('audio')");
    const selectAudio = async label => panel.eval("(()=>{const s=document.querySelector('#cards .encoding-options:not([hidden]) select, #cards .quality:not([hidden])');s.value=[...s.options].find(o=>o.textContent.includes(" + JSON.stringify(label) + ")).value;s.dispatchEvent(new Event('change'));})()");
    await selectAudio('FLAC');
    await panel.eval("document.querySelector('#cards .toggle-details').click()");
    await wait("document.querySelector('.detail-preview button')?.textContent===i18n.sideListen && document.querySelector('.detail-preview input')?.max > 3",'audio decoded with duration');
    const isolated = page.isolated(browser.extId);
    const player = "[...globalThis.__snagAudioSamples.values()][0]";
    t.check('音频详情显示独立音轨控件并保持暂停',await page.eval(player + '?.paused && !' + player + '.muted',isolated) && await panel.eval("!document.querySelector('.detail-preview :is(img,video)')"));
    const listen = async () => {
        const button = await panel.eval("(()=>{const r=document.querySelector('.detail-preview button').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()");
        await panel.click(...button);
        assert.ok(await until(() => page.eval(player + '?.currentTime>0.3 && !' + player + '.paused && ' + player + '.webkitAudioDecodedByteCount>0',isolated)),'audible track starts from a user click');
    };
    await listen();
    t.check('点试听能独立播放真实 FLAC 音轨，网页视频保持原来的进度',await page.eval('web.paused && Math.abs(web.currentTime-1.1)<0.1') && await page.eval(player+'.currentSrc.includes("30251.m4s")',isolated));
    await selectAudio('AAC');
    await wait("document.querySelector('.detail-preview button:enabled')?.textContent===i18n.sideListen && Number(document.querySelector('.detail-preview input')?.max)>3",'new track ready');
    await listen();
    t.check('切到 AAC 后主地址失败会播放同一音轨的备用地址，上一条音轨已释放',await page.eval('globalThis.__snagAudioSamples.size===1 && new URL(' + player + '.currentSrc).hostname==="backup.bilivideo.com" && ' + player + '.currentSrc.includes("30280.m4s")',isolated));
    await panel.eval("document.querySelector('.toggle-details').click()");
    assert.ok(await until(() => page.eval('globalThis.__snagAudioSamples.size===0',isolated)),'closing cleans up audio');
    await page.eval('history.pushState(null,"","?p=2")');
    await fetchTrack(file(part2.cid,100029));
    await wait("currentVideo?.cid==='1417563299' && groups.some(g=>g.biliId===currentVideo.cid)",'new part');
    const epoch = await panel.eval('generation');
    await page.eval('history.replaceState(null,"","?p=2&spm_id_from=tracking#heading")');
    t.check('切换分 P 更新编号，跟踪参数和锚点保留原列表',documents===1 && await panel.eval("groups.every(g=>!g.biliId || g.biliId===currentVideo.cid) && generation===" + epoch));
    await page.eval('web.remove();history.pushState(null,"","?p=3");performance.clearResourceTimings()');
    await wait("currentVideo?.cid==='1417563300' && !loading && !$id('rescan').disabled",'third part attached');
    const beforePublic = mediaRequests;
    await wait("groups.some(g=>g.kind==='audio' && g.info?.cid==='1417563300')",'public tracks recovered automatically');
    t.check('播放器尚未加载时自动从当前分 P 的公开清单找到可选音画',await panel.eval("groups.some(g=>g.kind==='video' && g.info?.cid==='1417563300' && !g.point && g.tracks.some(t=>t.codec==='AV1'))"));
    await panel.eval("$id('rescan').click()");
    await wait("scanLabel==='sideScanned'",'repeat public scan');
    t.check('再次重扫复用刚读取的清单，扫描期间没有下载媒体或重载网页',publicLists===1 && beforePublic===mediaRequests && documents===1);
    assert.deepEqual(panel.errors,[]);
});
