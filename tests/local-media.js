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
test('侧栏本地下载、音轨与清理',async t => {
    const picture = fixture('video.mp4'), sound = fixture('preview-audio.m4s');
    let pictureReady = false, audioGets = 0, slowMode = false, response, mixed;
    const site = await serve((req,res,url) => {
        if (url.pathname === '/watch') return html(res,'<title>Sample</title>');
        if (url.pathname === '/mixed.mp4' && mixed) { send(req,res,mixed,'video/mp4'); return true; }
        if (url.pathname === '/capped.mp4' && mixed) {
            const start = Number(/bytes=(\d+)-/.exec(req.headers.range || '')?.[1] || 0);
            const end = Math.min(start+4096,mixed.length);
            res.writeHead(206,{'Content-Type':'video/mp4','Content-Range':'bytes '+start+'-'+(end-1)+'/'+mixed.length});
            res.end(mixed.subarray(start,end)); return true;
        }
        const lists = {
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
});
