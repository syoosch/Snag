'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {launch,serve,send,html,fixture,test,until} = require('./lib/harness');

// Read the track handlers inside moov/trak/mdia, not arbitrary byte matches.
function handlers(bytes) {
    const found = [];
    function boxes(start,end) {
        while (start+8 <= end) {
            const size = bytes.readUInt32BE(start), type = bytes.toString('ascii',start+4,start+8);
            assert.ok(size >= 8 && start+size <= end, type);
            if (['moov','trak','mdia'].includes(type)) boxes(start+8,start+size);
            if (type === 'hdlr' && start+20 <= end) found.push(bytes.toString('ascii',start+16,start+20));
            start += size;
        }
    }
    boxes(0,bytes.length);
    return found.filter(h => ['soun','vide'].includes(h)).sort();
}
async function checkFrameReferrers(browser,t,movie) {
    const allowed = new Map();
    const cdn = await serve((req,res,u)=>{
        if (!allowed.has(u.pathname)) return;
        if (req.headers.referer !== allowed.get(u.pathname)) { res.writeHead(403); res.end(); }
        else if (u.pathname === '/cross.ts') send(req,res,fixture('segment.ts'),'video/mp2t');
        else send(req,res,movie,'video/mp4');
        return true;
    });
    t.defer(cdn.close);
    const film = name => '<video muted preload="metadata" aria-label="'+name+'"><source src="/video.mp4" type="video/mp4">'+
        '<source src="'+cdn.origin+'/'+name+'.mp4" type="video/mp4" label="720p">'+
        (name==='top' ? '<source src="/same-origin.m3u8" type="application/vnd.apple.mpegurl" label="1080p">' : '')+'</video>';
    const embed = await serve((req,res,u)=>u.pathname==='/nested/private' && html(res,film('embed')));
    t.defer(embed.close);
    const site = await serve((req,res,u)=>{
        if (u.pathname==='/watch/private') return html(res,film('top')+'<iframe src="'+embed.origin+'/nested/private?secret=frame"></iframe>');
        if (u.pathname==='/same-origin.m3u8') {
            if (req.headers.referer!==site.origin+'/') { res.writeHead(403);res.end(); }
            else send(req,res,Buffer.from('#EXTM3U\n#EXTINF:2,\n'+cdn.origin+'/cross.ts\n#EXT-X-ENDLIST'),'application/vnd.apple.mpegurl');
            return true;
        }
    });
    t.defer(site.close);
    allowed.set('/top.mp4',site.origin+'/'); allowed.set('/embed.mp4',embed.origin+'/');
    const page = await browser.open(site.origin+'/watch/private?secret=top');
    const panel = await browser.open(browser.url('sidebar.html?tabId='+await browser.tabId(site.origin+'/watch/private')));
    const target = name => 'groups.find(g=>g.tracks.some(t=>t.record.fromPage && t.record.url==='+JSON.stringify(cdn.origin+'/'+name+'.mp4')+'))';
    for (const name of ['top','embed']) {
        const group = target(name), src = JSON.stringify(cdn.origin+'/'+name+'.mp4');
        assert.ok(await until(()=>panel.eval('!!('+group+')')),'uncaptured source in '+name);
        const header = await panel.eval('(()=>{const g='+group+', t=g.tracks.find(t=>t.record.url==='+src+');'+
            'choices.set(g.key,t.key);render();return mediaFile(choice(g),g,null).headers.referer})()');
        assert.equal(header,allowed.get('/'+name+'.mp4'));
        const before = browser.files();
        await panel.eval('rows.get(('+group+').key).node.querySelector(".download").click()');
        assert.deepEqual(await browser.download(before,12000),movie);
        assert.ok(cdn.log.some(r=>r.path==='/'+name+'.mp4' && r.headers.referer===header));
    }
    t.check('页面备用源在顶层和跨域 iframe 均能保存，服务端收到各自来源的 origin，没有收到页面路径或参数',true);
    const top = target('top');
    const fromTop = edits => panel.eval('(()=>{const g='+top+',t=choice(g);return mediaFile({...t,record:{...t.record,...'+JSON.stringify(edits)+'}},g,null).headers.referer || null})()');
    await page.eval('const meta=document.createElement("meta");meta.name="ReFeRrEr";meta.content="same-origin";document.head.append(meta);'+
        'const last=meta.cloneNode();last.content="   ";document.head.append(last)');
    assert.ok(await until(()=>panel.eval('frames.get(0).referrerPolicy==="same-origin"')));
    assert.equal(await fromTop({}),null);
    assert.equal(await fromTop({url:site.origin+'/same.mp4'}),site.origin+'/');
    allowed.set('/cross.ts',undefined);
    const beforeHls = browser.files();
    await panel.eval('(()=>{const g='+top+', t=g.tracks.find(t=>t.record.fromPage && t.record.url.endsWith("/same-origin.m3u8"));'+
        'choices.set(g.key,t.key);render();rows.get(g.key).node.querySelector(".download").click()})()');
    assert.deepEqual(handlers(await browser.download(beforeHls,12000)),['soun','vide']);
    assert.ok(cdn.log.some(r=>r.path==='/cross.ts' && r.headers.referer===undefined));
    await page.eval('last.content=" NO-REFERRER "');
    assert.ok(await until(()=>panel.eval('frames.get(0).referrerPolicy==="no-referrer"')));
    assert.equal(await fromTop({url:site.origin+'/same.mp4'}),null);
    assert.equal(await fromTop({requestHeaders:{referer:site.origin+'/already-observed'}}),site.origin+'/already-observed');
    assert.equal(await panel.eval('MediaSources.originReferrer("https://example.test/private","http://example.test/file","origin") || null'),null);
    assert.equal(await panel.eval('MediaSources.originReferrer("https://example.test/private","https://example.test/file","never") || null'),null);
    t.check('动态更新的最后一条非空 Referrer 策略、同源限制、HTTPS 降级和已捕获标头的优先级都生效',true);
}

test('侧栏本地下载、音轨与清理',async t => {
    const picture = fixture('video.mp4'), sound = fixture('preview-audio.m4s');
    const flac = fixture('preview-flac.m4s'), flacMedia = flac.indexOf('moof')-4;
    assert.ok(flacMedia > 0);
    let pictureReady = false, audioGets = 0, slowMode = false, response, mixed, releaseSpecial;
    const special = '/special?sig=a|b*c^d', similar = '/special?sig=aXbYcZd';
    const site = await serve((req,res,url) => {
        if (url.pathname === '/special') {
            if (req.headers.referer !== site.origin+'/watch') { res.writeHead(403); res.end(); }
            else if (req.url===special) releaseSpecial = () => send(req,res,picture,'video/mp4');
            else send(req,res,picture,'video/mp4');
            return true;
        }
        if (url.pathname === '/watch') return html(res,'<title>Sample</title>');
        if (url.pathname === '/mixed.mp4' && mixed) { send(req,res,mixed,'video/mp4'); return true; }
        if (url.pathname === '/capped.mp4' && mixed) {
            const start = Number(/bytes=(\d+)-/.exec(req.headers.range || '')?.[1] || 0);
            const end = Math.min(start+4096,mixed.length);
            res.writeHead(206,{'Content-Type':'video/mp4','Content-Range':'bytes '+start+'-'+(end-1)+'/'+mixed.length});
            res.end(mixed.subarray(start,end)); return true;
        }
        const lists = {
            '/flac.m3u8':'#EXTM3U\n#EXT-X-MAP:URI="/flac/init"\n#EXTINF:5,\n/flac/1\n#EXT-X-ENDLIST',
            '/master.m3u8':'#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Main",DEFAULT=YES,URI="/sound.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=900000,AUDIO="a"\n/movie.m3u8',
            '/movie.m3u8':'#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n/playlist-video.m4s\n#EXT-X-ENDLIST',
            '/sound.m3u8':'#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n/playlist-sound.m4s\n#EXT-X-ENDLIST',
            '/movie.mpd':'<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT4S" minBufferTime="PT1S"><Period id="p" duration="PT4S">'+
                '<AdaptationSet mimeType="video/mp4" contentType="video"><Representation id="v" bandwidth="900000" codecs="avc1.640028" width="160" height="90"><SegmentList timescale="1" duration="4"><SegmentURL media="/playlist-video.m4s"/></SegmentList></Representation></AdaptationSet>'+
                '<AdaptationSet mimeType="audio/mp4" contentType="audio" lang="en"><Representation id="a" bandwidth="64000" codecs="mp4a.40.2"><SegmentList timescale="1" duration="4"><SegmentURL media="/playlist-sound.m4s"/></SegmentList></Representation></AdaptationSet></Period></MPD>'
        };
        if (lists[url.pathname]) {
            send(req,res,Buffer.from(lists[url.pathname]),url.pathname.endsWith('.mpd') ? 'application/dash+xml' : 'application/vnd.apple.mpegurl'); return true;
        }
        if (url.pathname === '/playlist-video.m4s') { send(req,res,picture,'video/mp4'); return true; }
        if (url.pathname === '/playlist-sound.m4s') { send(req,res,sound,'audio/mp4'); return true; }
        if (url.pathname === '/flac/init' || url.pathname === '/flac/1') {
            send(req,res,url.pathname.endsWith('init') ? flac.subarray(0,flacMedia) : flac.subarray(flacMedia),'audio/mp4');
            return true;
        }
        if (!['/v.m4s','/a.m4s'].includes(url.pathname)) return;
        if (req.headers.referer !== site.origin + '/watch') { res.writeHead(403); res.end(); return true; }
        if (url.pathname === '/v.m4s' && !pictureReady) { res.writeHead(503); res.end(); return true; }
        if (slowMode && url.pathname === '/v.m4s') { response = res; res.writeHead(200,{'Content-Length':picture.length}); res.write(picture.subarray(0,80)); return true; }
        if (url.pathname === '/a.m4s') audioGets++;
        send(req,res,url.pathname === '/a.m4s' ? sound : picture,'application/octet-stream'); return true;
    });
    t.defer(site.close);
    const browser = await launch(); t.defer(browser.close);
    await browser.open(site.origin+'/watch');
    const tab = await browser.tabId('/watch');
    const panelUrl = browser.url('sidebar.html?tabId='+tab);
    let panel = await browser.open(panelUrl);
    const url = name => site.origin+'/'+name;
    const names = {video:'v.m4s',audio:'a.m4s'};
    const tracks = Object.entries(names).map(([kind,name]) => ({kind,key:kind+'-test',record:{
        url:url(name),ext:'m4s',requestHeaders:{referer:url('watch')},name,title:'Garden'}}));
    async function card(tracks,biliId = null) {
        await until(() => panel.eval('!loading && typeof attachDownloadModes === "function"'));
        await panel.eval('(function(){const g='+JSON.stringify({key:'garden',kind:'video',tracks,biliId})+
            ';const row=createRow(g);updateRow(row,g);row.node.id="test-card";document.querySelector("#test-card")?.remove();document.body.append(row.node);window.testRow=row;})()');
    }
    async function click(mode) {
        const selector = mode === 'full' ? '.download' : '[data-mode='+mode+']';
        await panel.eval('document.querySelector("#test-card '+selector+'").click()');
    }
    const list = () => panel.eval('mediaCommand("list")');
    const find = async state => (await list()).find(j => j.state === state);
    const activeDirs = () => panel.eval('(async()=>{const root=await (await navigator.storage.getDirectory()).getDirectoryHandle("snag-media-v1");const dirs=[];for await (const k of root.keys())dirs.push(k);return dirs;})()');
    async function result(before,ext) {
        const files = await until(() => browser.files().filter(n => !before.includes(n) && !n.endsWith('.crdownload')).at(-1),22000);
        if (!files) throw new Error('Missing output: '+JSON.stringify((await list()).at(-1)));
        if (ext) assert.equal(path.extname(files),ext,'unexpected download filename: ' + files);
        const bytes = fs.readFileSync(path.join(browser.downloads,files));
        assert.ok(await until(async () => !(await activeDirs()).length),'temporary files still present');
        return bytes;
    }
    await card(tracks,'123');
    const initialTabs = await browser.pages(/./);
    const before = browser.files();
    await click('full');
    const failed = await until(() => find('failed'),12000);
    assert.ok(failed,'expected retryable failure'); assert.equal(failed.bytes,sound.length);
    assert.ok(failed.expires>Date.now() && failed.expires<=Date.now()+600000);
    assert.equal(audioGets,1);
    t.check('画面获取失败时显示音轨占用和清理期限',true);
    await panel.close(); panel = await browser.open(panelUrl);
    await until(() => panel.eval('typeof mediaCommand === "function"'));
    pictureReady = true;
    await panel.eval('mediaCommand("retry",{id:'+JSON.stringify(failed.id)+'})');
    mixed = await result(before,'.mp4');
    assert.deepEqual(handlers(mixed),['soun','vide']); assert.equal(audioGets,1);
    t.check('重新打开侧栏可重试，两条轨道在本地合成一个 MP4，原材料自动清理',true);
    pictureReady = false;
    const nextTracks = tracks.map(t=>({...t,key:t.key+'-partial'}));
    await card(nextTracks,'123');
    const beforePartial = browser.files();
    await click('full');
    const partial = await until(async()=>(await list()).find(j=>j.key===nextTracks[0].key && j.state==='failed'));
    assert.equal(partial.bytes,sound.length);
    const audioBeforeRetry = audioGets;
    const bogus = {tabId:tab,key:partial.key,mode:'full',files:[{url:url('unexpected')} ]};
    for (const change of [{key:'other'},{mode:'video'},{tabId:tab+10},{files:[]}]) {
        await assert.rejects(()=>panel.eval('mediaCommand("retry",'+JSON.stringify({id:partial.id,request:{...bogus,...change}})+')'));
    }
    pictureReady = true;
    await card(nextTracks.map(t=>({...t,record:{...t.record,url:url('unexpected')}})),'123');
    await panel.eval('testRow.node.querySelector(".download-state button").click()');
    assert.deepEqual(handlers(await result(beforePartial,'.mp4')),['soun','vide']);
    assert.equal(audioGets,audioBeforeRetry);
    assert.ok(!site.log.some(r=>r.path==='/unexpected'));
    t.check('卡片重试保留已完成的音轨和原画轨计划，错误的任务编号、模式、标签页或空请求均被拒绝',true);
    const generic = [{kind:'video',key:'mixed',record:{url:url('mixed.mp4'),name:'mixed.mp4',ext:'mp4',type:'video/mp4'}}];
    for (const [mode,expected] of [['audio',['soun']],['video',['vide']]]) {
        await card(generic);
        const old = browser.files(); await click(mode);
        assert.deepEqual(handlers(await result(old,mode === 'audio' ? '.m4a' : '.mp4')),expected);
        t.check(mode === 'audio' ? '从含声音的视频只提取音轨' : '从同一文件保存无声视频',true);
    }
    const vGets = site.log.filter(r => r.path === '/v.m4s').length;
    const aGets = audioGets;
    await card(tracks,'123');
    const old = browser.files(); await click('audio');
    assert.deepEqual(handlers(await result(old,'.m4a')),['soun']);
    assert.equal(site.log.filter(r => r.path === '/v.m4s').length,vGets);
    assert.equal(audioGets,aGets+1);
    t.check('分开提供音画时只下载所选音轨',true);
    for (const [name,ext,type] of [['master.m3u8','m3u8','application/vnd.apple.mpegurl'],['movie.mpd','mpd','application/dash+xml']]) {
        await card([{kind:'video',key:name,record:{url:url(name),ext,type,name}}]);
        const beforePair = browser.files(); await click('full');
        assert.deepEqual(handlers(await result(beforePair)),['soun','vide']);
        const count = site.log.filter(r => r.path === '/playlist-video.m4s').length;
        const beforeAudio = browser.files(); await click('audio');
        assert.deepEqual(handlers(await result(beforeAudio)),['soun']);
        assert.equal(site.log.filter(r => r.path === '/playlist-video.m4s').length,count);
        t.check(ext.toUpperCase()+' 清单支持完整视频和独立音轨，按需获取分段',true);
    }
    await card([{kind:'video',key:'capped',record:{url:url('capped.mp4'),ext:'mp4',name:'capped.mp4',type:'video/mp4'}}]);
    const beforeCapped = browser.files(); await click('full');
    assert.deepEqual(await result(beforeCapped),mixed);
    assert.ok(site.log.filter(r => r.path === '/capped.mp4').length>1);
    t.check('服务器分批返回时保存了逐字节相同的完整文件',true);
    const unavailable = {key:'quota',mode:'full',tabId:tab,title:'quota',files:[{url:url('no-disk'),size:Number.MAX_SAFE_INTEGER,ext:'mp4'}]};
    const quota = await panel.eval('mediaCommand("start",{request:'+JSON.stringify(unavailable)+'})');
    assert.ok(await until(async () => (await list()).some(j => j.id===quota.id && j.error==='mediaSpace' && !j.bytes && !j.canRetry)));
    assert.ok(!site.log.some(r => r.path === '/no-disk'));
    assert.deepEqual(await activeDirs(),[]);
    await panel.eval('mediaCommand("clear",{id:'+JSON.stringify(quota.id)+'})');
    t.check('已知空间不足时提前结束并清理目录',true);
    await card([{kind:'video',key:'silent',record:{url:url('video.mp4'),name:'video.mp4',ext:'mp4',type:'video/mp4'}}]);
    const beforeMissing = browser.files(); await click('audio');
    assert.ok(await until(async () => (await list()).some(j => j.key==='silent' && j.error==='mediaNoAudio' && !j.canRetry)));
    assert.deepEqual(await activeDirs(),[]); assert.deepEqual(browser.files(),beforeMissing);
    t.check('原片确实没有声音时给出明确结果并清除临时输入',true);
    await card([{kind:'video',key:'flac',record:{url:url('preview-flac.m4s'),name:'original.m4s',ext:'m4s',type:'video/mp4'}}]);
    const beforeFlac = browser.files(); await click('audio');
    assert.equal((await result(beforeFlac,'.flac')).toString('ascii',0,4),'fLaC');
    t.check('无损音轨以可识别的 FLAC 文件保存',true);
    await card([{kind:'video',key:'flac-hls',record:{url:url('flac.m3u8'),ext:'m3u8',type:'application/vnd.apple.mpegurl'}}]);
    const beforeMatroska = browser.files(); await click('full');
    const matroska = await result(beforeMatroska,'.mkv');
    assert.equal(matroska.readUInt32BE(0),0x1a45dfa3);
    assert.ok(matroska.includes(Buffer.from('A_FLAC')));
    const beforeExtraction = browser.files(); await click('audio');
    assert.equal((await result(beforeExtraction,'.flac')).toString('ascii',0,4),'fLaC');
    t.check('单轨 FLAC HLS 完整保存回退到 MKV，选择仅音频仍导出 FLAC',true);
    slowMode = true;
    const beforeClose = browser.files();
    await card(tracks,'123'); await click('video');
    assert.ok(await until(() => !!response));
    const busy = 'testRow.node.querySelector(".download")';
    assert.ok(await until(() => panel.eval('updateRow(testRow,testRow.group);'+busy+'.disabled && '+busy+'.textContent.includes("%")')));
    function luminance(css) {
        const [r,g,b] = css.match(/\d+(?:\.\d+)?/g).slice(0,3).map(Number).map(value => {
            const c = value/255;
            return c <= .04045 ? c/12.92 : ((c+.055)/1.055)**2.4;
        });
        return r*.2126 + g*.7152 + b*.0722;
    }
    const ratios = [];
    for (const value of ['light','dark']) {
        await panel.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value}]});
        const [fg,bg,opacity] = await panel.eval('(()=>{const s=getComputedStyle('+busy+');return [s.color,s.backgroundColor,s.opacity]})()');
        const [low,high] = [fg,bg].map(luminance).sort((a,b) => a-b);
        const ratio = (high+.05)/(low+.05);
        assert.equal(opacity,'1'); assert.ok(ratio>=7,value+' progress contrast '+ratio);
        ratios.push(ratio.toFixed(1));
    }
    t.check('实际下载中的文字在浅色和深色下都清晰，对比分别为 '+ratios.join(' / '),true);
    await panel.close(); response.end(picture.subarray(80)); response = null;
    assert.deepEqual(handlers(await browser.download(beforeClose)),['vide']);
    panel = await browser.open(panelUrl);
    assert.ok(await until(async () => (await list()).some(j => j.key==='video-test' && j.mode==='video' && j.state==='done')));
    assert.deepEqual(await activeDirs(),[]);
    t.check('收起侧栏期间继续下载、保存并清理，重开后可见结果',true);
    await card(tracks,'123');
    await click('video');
    assert.ok(await until(() => !!response));
    const job = await find('downloading');
    await panel.eval('mediaCommand("cancel",{id:'+JSON.stringify(job.id)+'})');
    response.destroy(); response = null;
    assert.ok(await until(async () => !(await activeDirs()).length));
    assert.equal(audioGets,aGets+1);
    t.check('取消无声视频任务后移除未完成文件',true);
    assert.equal((await browser.pages(/./)).length,initialTabs.length);
    assert.equal((await browser.pages(/downloader\.html|ffmpeg\.(bmmmd|94cat)\.com/)).length,0);
    t.check('侧栏下载没有打开新标签页或在线 FFmpeg',true);
    await card([{kind:'video',key:'literal-url',record:{url:site.origin+special,name:'literal.mp4',ext:'mp4',requestHeaders:{referer:url('watch')}}}]);
    const beforeSpecial = browser.files(); await click('full');
    assert.ok(await until(()=>!!releaseSpecial),'special URL with source headers reached the server');
    const activeRules = () => browser.sw.eval('chrome.declarativeNetRequest.getSessionRules().then(rs=>rs.filter(r=>isMediaRuleId(r.id)))');
    const exact = (await activeRules()).find(r=>r.condition.regexFilter);
    assert.ok(exact && !exact.condition.urlFilter && exact.condition.isUrlFilterCaseSensitive);
    assert.deepEqual(exact.condition.tabIds,[-1]); assert.deepEqual(exact.condition.resourceTypes,['xmlhttprequest']);
    assert.deepEqual(exact.condition.initiatorDomains,[new URL(browser.url('media-host.html')).hostname]);
    await browser.sw.eval('clearRedundant()');
    assert.ok((await activeRules()).some(r=>r.id===exact.id));
    const target = (await browser.targets()).find(t=>t.url===browser.url('media-host.html'));
    const host = await browser.attach(target.targetId);
    assert.equal(await host.eval('fetch('+JSON.stringify(site.origin+similar)+').then(r=>r.status)'),403);
    assert.ok(site.log.filter(r=>r.path===similar).every(r=>r.headers.referer!==url('watch')));
    releaseSpecial();
    assert.deepEqual(await result(beforeSpecial,'.mp4'),picture);
    assert.ok(await until(async()=>!(await activeRules()).length));
    const tooLong = site.origin+'/special?sig=|'+Array.from({length:4096},(_,i)=>i.toString(36)).join('*');
    const tryLongRule = () => host.eval('bridge("headers",{url:'+JSON.stringify(tooLong)+',headers:{referer:'+JSON.stringify(url('watch'))+
        '}}).then(id=>({id}),error=>({error:error.message}))');
    const longRule = await tryLongRule();
    if (longRule.id) {
        assert.ok((await activeRules()).some(r=>r.id===longRule.id && new RegExp(r.condition.regexFilter).test(tooLong)));
        await host.eval('bridge("release",{id:'+longRule.id+'})');
    } else assert.equal(longRule.error,'mediaSourceFailed');
    // Engines have different RE2 budgets. Exercise the rejection path even if this literal fits the current browser.
    await browser.sw.eval('(()=>{const api=chrome.declarativeNetRequest,original=api.updateSessionRules;'+
        'globalThis.restoreDnr=()=>{api.updateSessionRules=original;delete globalThis.restoreDnr};'+
        'api.updateSessionRules=function(options){const regex=options.addRules?.[0]?.condition.regexFilter;'+
        'if(regex?.length>10000)return Promise.reject(new Error("RE2 limit: "+regex));return original.call(api,options)}})()');
    try { assert.deepEqual(await tryLongRule(),{error:'mediaSourceFailed'}); }
    finally { await browser.sw.eval('restoreDnr()'); }
    assert.deepEqual(await activeRules(),[]);
    t.check('特殊字符规则仅命中原址，近似地址得到 403，过长正则报错隐藏地址，任务结束后规则已释放',true);
    await checkFrameReferrers(browser,t,picture);
});
