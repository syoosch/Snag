'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {EXT,fixture,launch,serve,send,html,test,until} = require('./lib/harness');
const {boxes,pictureInfo,checkFastStart} = require('./lib/mp4');
const {checkLeafStreams} = require('./lib/leaf-streams');

// Runs in the sidebar with its real manifest parser.
function checkDashOwnership() {
    const base = 'https://example.test/edge/main.mpd?tag=1', seg = 'https://example.test/edge/v/7.m4s?part=abc%2Bdef';
    const xml = '<MPD type="static" mediaPresentationDuration="PT4S"><Period><AdaptationSet><BaseURL>v/</BaseURL>'+
        '<SegmentTemplate media="$Number$.m4s?part=abc%2Bdef"/></AdaptationSet></Period></MPD>';
    const player = {kind:'video',stream:true,loaded:true,playing:true,duration:4};
    const frame = {url:'https://example.test/view',frameId:5,documentId:'current',items:[player],segments:[seg],streamLists:new Map()};
    const record = {frameId:5,documentId:'current',ext:'mpd',url:base};
    frame.streamLists.set(base,{pending:true,format:'dash'});
    receivePlaylistText(frame,{url:base,text:xml});
    const match = () => genericStreamMatches(new Map([[1,record]]),new Map([[5,frame]]),false).has(record);
    const valid = match();
    frame.segments = [seg.replace('abc','other')];
    const wrongSignature = match();
    frame.segments = [seg]; record.documentId = 'previous';
    return [valid,wrongSignature,match()];
}

function checkEarlyInspection() {
    const doc = {frameId:2,documentId:'here',isRegex:false};
    const root = {url:'https://example.test/index.m3u8',ext:'m3u8',...doc};
    const wrong = {...root,url:'https://example.test/previous.m3u8',documentId:'old'};
    const ad = {...root,url:'https://example.test/ad.m3u8',fromSrcdoc:true};
    const player = {kind:'video',loaded:true,stream:true,duration:4};
    const requests = [], frame = {...doc,url:'https://example.test/watch',items:[player],documentStart:100,
        port:{postMessage:m=>requests.push(m.url)}};
    const records = new Map([root,wrong,ad].map(r=>[r.url,r]));
    const match = () => genericStreamMatches(records,new Map([[2,frame]]),true);
    const before = match().size;
    receivePlaylistText(frame,{url:root.url,text:'#EXTM3U\n#EXTINF:4,\n/seg/1\n#EXT-X-ENDLIST'});
    const sample = {...doc,url:'https://example.test/seg/1',type:'video/mp4'};
    records.set(sample.url,sample);
    const after = match().get(root)?.player === player;
    frame.items.push({kind:'video',current:sample.url,loaded:true,duration:4});
    const direct = match().has(root);
    return {before,after,direct,requests,
        allowed:['seg.mp4','aud.m4a','aud.aac','chunk.webm'].every(name=>SnagFormat.segmentSample(name,'',true)),
        excluded:['text/html','application/json','text/javascript','text/css','image/png'].every(type=>!SnagFormat.segmentSample('chunk.mp4',type,true)),
        observed:streamDownloadUrls(frame,[{...sample,url:sample.url+'?h=sample'},{...wrong,url:wrong.url+'?h=other'}])};
}

async function checkObservedAddresses() {
    const host = 'https://example.test', original = '/chosen.m4s?quality=720&sig=x%2By', refs =
        [original,'/ambiguous.m4s','/unseen.m4s','https://other.example.test/only.m4s','/only.m4s'];
    const signed = host+'/only.m4s?auth_key=x%2By%2Fz&v=1';
    const file = {kind:'video',url:host+'/master.m3u8?auth_key=master',playlist:'hls',
        observedUrls:[signed,host+'/chosen.m4s?quality=1080',host+'/ambiguous.m4s?a=1',host+'/ambiguous.m4s?a=2']};
    const result = await MediaSources.plan({mode:'full',files:[file]},async () => ({url:file.url,
        text:'#EXTM3U\n#EXT-X-TARGETDURATION:1\n'+refs.map(ref=>'#EXTINF:1,\n'+ref+'\n').join('')+'#EXT-X-ENDLIST'}));
    return result.tracks[0].parts.map(part=>part.url);
}

async function checkEncryptionPlan() {
    const base = 'https://example.test/v/master.m3u8', signed = 'https://example.test/v/id.key?token=one%2Btwo';
    const file = {url:base,kind:'video',playlist:'hls',observedUrls:[signed]};
    const make = async body => (await MediaSources.plan({mode:'full',files:[file]},async()=>({url:base,
        text:'#EXTM3U\n'+body+'\n#EXTINF:1,\nlast.m4s\n#EXT-X-ENDLIST'}))).tracks[0].parts;
    const key = '#EXT-X-KEY:METHOD=AES-128,URI="id.key"';
    const parts = await make('#EXT-X-MEDIA-SEQUENCE:4294967306\n#EXT-X-MAP:URI="init"\n'+key+'\n#EXTINF:1,\none\n'+
        key+',IV=0xB\n#EXT-X-MAP:URI="init"\n#EXTINF:1,\ntwo\n#EXT-X-KEY:METHOD=NONE');
    const errors = [];
    for (const method of ['SAMPLE-AES','SAMPLE-AES-CTR','SAMPLE-AES-CENC']) errors.push(['#EXT-X-KEY:METHOD='+method+',URI="unread"','mediaProtected']);
    errors.push([key+',KEYFORMAT="Identity"','mediaProtected'],['#EXT-X-KEY:METHOD=AES-128','mediaProtected'],
        [key+'\n#EXT-X-MAP:URI="init"','mediaBadFile'],['#EXT-X-MEDIA-SEQUENCE:9007199254740991\n#EXTINF:1,\nfirst','mediaBadFile']);
    for (const iv of ['0x','0x1z','1','0x'+'a'.repeat(33)]) errors.push([key+',IV='+iv,'mediaBadFile']);
    for (const seq of ['-1','1.2','1e3','9007199254740992','']) errors.push(['#EXT-X-MEDIA-SEQUENCE:'+seq,'mediaBadFile']);
    for (const uri of ['file:///secret','chrome-extension://id/path','javascript:void(0)','data:;base64,YQ=='])
        errors.push([key.replace('id.key',uri),'mediaBadFile']);
    for (const [tag,expected] of errors) {
        let result;
        try { await make(tag); } catch (error) { result=error.message; }
        if (result !== expected) throw new Error('unexpected result for '+tag);
    }
    file.observedUrls.push(signed+'3');
    const ambiguous = (await make(key))[0].key.url;
    const observedKeys = streamDownloadUrls({frameId:1,documentId:'frame'},[
        {frameId:1,documentId:'frame',url:signed},{frameId:2,documentId:'other',url:signed+'4'}]);
    return {ivs:parts.map(p=>p.key?.iv || null),matched:parts[1].key.url,ambiguous,observedKeys};
}

async function checkHlsPreferences() {
    const base = 'https://example.test/main.m3u8';
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=10,RESOLUTION=1280x720\nlow.m3u8\n'+
        '#EXT-X-STREAM-INF:BANDWIDTH=20,RESOLUTION=1920x1080\nhigh.m3u8';
    const read = async file => ({url:file.url,text:file.url === base ? master : '#EXTM3U\n#EXTINF:4,\nclip.ts\n#EXT-X-ENDLIST'});
    async function select(options) {
        const file = {url:base,kind:'video',playlist:'hls',...options};
        const result = await MediaSources.plan({mode:'full',files:[file]},read);
        return new URL(result.tracks[0].url).pathname;
    }
    const observedUrls = [new URL('low.m3u8',base).href];
    return [await select({playbackHeight:720}),await select({observedUrls}),await select({}),
        await select({quality:{height:1080},playbackHeight:720,observedUrls})];
}

// Exercise incomplete observations and refreshed URLs in different arrival orders.
async function checkStreamRevisions() {
    const host = 'https://example.test/', base = host+'hls/4687/';
    const player = {key:'player',kind:'video',stream:true,loaded:true,streamId:'4687',sources:[],width:1280,height:720,duration:4};
    const frame = {url:host+'watch',frameId:5,documentId:'doc',items:[player],streamLists:new Map()};
    const frames = new Map([[5,frame]]), records = new Map();
    const master = (height,leaf) => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION='+height*16/9+'x'+height+',CODECS="avc1.42c01e"\n'+leaf;
    const vod = part => '#EXTM3U\n#EXTINF:4,\n'+part+'\n#EXT-X-ENDLIST';
    const add = (url,ext,getTime,text) => {
        records.set(url,{frameId:5,documentId:'doc',ext,url,getTime,type:ext==='m4s' ? 'video/mp4' : 'application/vnd.apple.mpegurl'});
        if (ext==='m3u8') {
            frame.streamLists.set(url,{pending:true,format:'hls'});
            if (text) receivePlaylistText(frame,{url,text});
        }
    };
    const match = () => genericStreamMatches(records,frames,false);
    const owners = matches => [...matches].filter(([,m])=>m.player===player).map(([r])=>r.url);
    const leaf = base+'media.m3u8', part = base+'clip.m4s?sig=watched';
    const old = base+'master.m3u8?token=older', fresh = base+'master.m3u8?token=newest';
    add(part,'m4s',1); add(leaf,'m3u8',2,vod(part)); add(old,'m3u8',3);
    frame.items.unshift(...Array.from({length:5},()=>({kind:'video',stream:true,loaded:false,streamId:'4687',sources:[]})));
    const pending = owners(match());
    receivePlaylistText(frame,{url:old,text:master(720,leaf)});
    const resolved = owners(match());
    const downloadKey = () => sidebarGroups(records,frames,undefined,undefined,undefined,[],match()).find(g=>g.point===player)?.tracks[0]?.key;
    const originalKey = downloadKey();
    add(fresh,'m3u8',8,master(720,leaf));
    records.delete(old); add(old,'m3u8',3,master(720,leaf));
    const refreshed = match();
    const retainedChoice = !!originalKey && originalKey===downloadKey();
    const hidden = [old,leaf].every(u => refreshed.get(records.get(u))?.child);
    const second = base+'higher.m3u8';
    add(second,'m3u8',9,master(1080,base+'high-index.m3u8'));
    const together = sidebarGroups(records,frames,undefined,undefined,undefined,[],match()).find(g=>g.point===player);
    add(leaf,'m3u8',2,vod(part).replace('#EXTINF:4,','#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\n#EXTINF:4,'));
    const playable = sidebarGroups(records,frames,undefined,undefined,undefined,[],match()).find(g=>g.point===player);
    add(leaf,'m3u8',2,vod(part));
    add(base+'master.m3u8?video=other&token=new','m3u8',10,master(720,base+'other.m3u8'));
    const differentQuery = owners(match());
    records.clear(); frame.streamLists.clear(); delete player.streamId;
    const a = host+'opaque.m3u8?token=a', b = host+'opaque.m3u8?token=b';
    const one = host+'a.m4s', two = host+'b.m4s';
    add(a,'m3u8',2,vod(one)); add(one,'m4s',3); add(b,'m3u8',5,vod(two)); add(two,'m4s',6);
    const distinct = owners(match());
    add(b,'m3u8',5,vod(one));
    const equivalent = owners(match());
    frame.items.push({...player,key:'second',playing:true});
    const twoPlayers = [...match().values()].some(m=>m.player);
    const selected = {url:host+'select.m3u8?token=master',kind:'video',playlist:'hls',
        quality:{url:host+'tier.m3u8?lang=en&token=old',height:720,codec:'H.264'}};
    const selectedReads = [];
    const planned = await MediaSources.plan({mode:'full',files:[selected]},async f => {
        selectedReads.push(f.url);
        return {url:f.url,text:f.url===selected.url ? master(720,host+'tier.m3u8?lang=en&token=fresh') : vod('unseen.m4s')};
    });
    frame.items = [player]; records.clear(); frame.streamLists.clear();
    const rotate = (n,h) => {
        const root = host+'queue.m3u8?ttl='+n+'&h='+h, child = host+'tier.m3u8?ticket='+h, segment = host+'chunks/one.m4s?h='+h;
        add(segment,'m4s',n); add(child,'m3u8',n,vod(segment)); add(root,'m3u8',n,master(720,child));
        return {root,child,segment};
    };
    const prev = rotate(1000,'old'), pinned = downloadKey(), proof = match().get(records.get(prev.root)).masterLayout;
    const next = rotate(2000,'fresh'), changed = match();
    const rotation = {roots:owners(changed),hidden:!!(changed.get(records.get(prev.root))?.child && changed.get(records.get(prev.child))?.child),
        stable:!!pinned && downloadKey() === pinned};
    const quality = {url:prev.child,height:720,codec:'H.264',masterLayout:proof};
    const manual = {mode:'full',files:[{url:next.root,playlist:'hls',kind:'video',quality}]};
    const updates = [];
    await MediaSources.plan(manual,async f=>{
        updates.push(f.url);
        return {url:f.url,text:f.url === next.root ? master(720,next.child) : vod(next.segment)};
    });
    rotation.reads = updates;
    await assertNoMatch(master(720,host+'another.m3u8'));
    async function assertNoMatch(text) {
        let reads = 0, failure;
        try { await MediaSources.plan(manual,async f=>{reads++;return {url:f.url,text}}); } catch (error) { failure=error.message; }
        if (failure!=='mediaSegmentQuality' || reads!==1) throw new Error('different playlist or unexpected child request');
    }
    records.clear(); frame.streamLists.clear();
    add(prev.root,'m3u8',1,vod(one)); add(one,'m4s',2); add(next.root,'m3u8',3,vod(two)); add(two,'m4s',4);
    if (owners(match()).length) throw new Error('equal root paths cannot hide different segment paths');
    const media = parts => '#EXTM3U\n'+parts.map(p=>'#EXTINF:'+4/parts.length+',\n'+p+'\n').join('')+'#EXT-X-ENDLIST';
    for (const different of [[two,one],[one,two,two],[one,two+'?lang=fr']]) {
        add(prev.root,'m3u8',1,media([one,two])); add(next.root,'m3u8',3,media(different));
        if (owners(match()).length) throw new Error('different segment order, count or content selector');
    }
    add(prev.child,'m3u8',1,vod(one)); add(next.child,'m3u8',3,vod(two));
    add(prev.root,'m3u8',1,master(720,prev.child)); add(next.root,'m3u8',3,master(720,next.child));
    if (owners(match()).length) throw new Error('matching master paths conceal two different parsed child playlists');
    return {pending,resolved,newest:owners(refreshed),hidden,retainedChoice,rotation,tiers:together?.tracks.map(t=>t.label).sort(),playable:playable?.tracks.map(t=>t.label),
        differentQuery,distinct,equivalent,twoPlayers,selectedReads,part:planned.tracks[0].parts[0].url};
}

async function checkExtensionlessRetry(browser,t) {
    const chunks = boxes(fixture('hls-av-fragmented.mp4'));
    const pieces = [Buffer.concat(chunks.slice(0,2).map(b=>b.data))];
    for (let i=2; chunks[i]?.name==='moof'; i+=2) pieces.push(Buffer.concat([chunks[i].data,chunks[i+1].data]));
    const root = h => '/root.m3u8?ttl='+(h==='old' ? 1000 : 2000)+'&h='+h;
    const leaf = h => '/tier.m3u8?ticket='+h;
    const refs = h => pieces.map((_,i)=>'/seg/'+(i || 'init')+'?h='+h);
    const playlistType = 'application/vnd.apple.mpegurl';
    let expired = false, requireFreshReferrer = false;
    const site = await serve((req,res,u)=>{
        const h = u.searchParams.get('h') || u.searchParams.get('ticket');
        if (u.pathname==='/watch') return html(res,'<video muted controls aria-label="Extensionless"></video><script>'+
            'const v=document.querySelector("video");window.loadRevision=async(urls,play)=>{'+
            'await fetch(urls[0],{referrer:new URL(play?"/viewer/old":"/viewer/fresh",location.href).href});'+
            'await fetch(urls[1]);const data=[];for(const url of urls.slice(2))data.push(await (await fetch(url)).arrayBuffer());'+
            'if(play){v.src=URL.createObjectURL(new Blob(data,{type:"video/mp4"}));await v.play();v.pause()}};</script>');
        if (u.pathname==='/root.m3u8' && h==='old' && expired) {res.writeHead(410);res.end();return true;}
        if (u.pathname==='/root.m3u8') {
            if (requireFreshReferrer && req.headers.referer !== site.origin+'/viewer/fresh') { res.writeHead(403);res.end();return true; }
            send(req,res,Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=1920x1080,FRAME-RATE=60,CODECS="avc1.640028,mp4a.40.2"\n'+leaf(h)+
                '\n#EXT-X-STREAM-INF:BANDWIDTH=80000,RESOLUTION=640x360,CODECS="avc1.42c01e"\n/unplayed.m3u8?ticket='+h),'application/vnd.apple.mpegurl');return true;
        }
        if (u.pathname==='/tier.m3u8') {
            const [init,...media] = refs(h);
            const text = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:1\n#EXT-X-MAP:URI="'+init+'"\n'+
                media.map(part=>'#EXTINF:'+0.5/media.length+',\n'+part+'\n').join('')+'#EXT-X-ENDLIST';
            send(req,res,Buffer.from(text),playlistType);return true;
        }
        if (u.pathname.startsWith('/seg/')) {
            const index = u.pathname==='/seg/init' ? 0 : Number(u.pathname.slice(5));
            send(req,res,pieces[index],index===0 ? 'application/octet-stream' : 'video/mp4');return true;
        }
    });
    t.defer(site.close);
    const page = await browser.open(site.origin+'/watch');
    const load = (h,play) => page.eval('loadRevision('+JSON.stringify([root(h),leaf(h),...refs(h)])+','+play+')');
    await load('old',true);
    const tab = await browser.tabId(site.origin+'/watch');
    const panel = await browser.open(browser.url('sidebar.html?tabId='+tab));
    const group = 'groups.find(g=>g.point?.title==="Extensionless" && g.point.loaded && g.tracks.some(t=>t.streamQuality))';
    const row = 'rows.get(('+group+').key).node';
    assert.ok(await until(()=>panel.eval('('+group+')?.tracks.length===2')),'blob playback with extensionless segments');
    await panel.eval('(()=>{const s='+row+'.querySelector(".quality-tier");s.value="1080p60";s.dispatchEvent(new Event("change"))})()');
    assert.ok(await until(()=>panel.eval(row+'.querySelector(".codec-value").textContent==="H.264" && '+
        row+'.querySelector(".file-size").textContent===i18n("sideEstimatedSize",bytes(25000))')));
    const key = await panel.eval('choices.get(('+group+').key)');
    assert.ok(key);
    t.check('无后缀的初始化段和画面分片匹配 blob 正片，卡片能选择画质并显示编码和估算大小',true);
    const before = browser.files();
    expired = true;
    await panel.eval(row+'.querySelector(".download").click()');
    const failed = await until(()=>panel.eval('mediaJobs.find(j=>j.tabId===tabId && j.state==="failed")'));
    assert.equal(failed.sourceFailure.status,410);
    assert.deepEqual(browser.files(),before);
    await load('fresh',false);
    assert.ok(await until(()=>panel.eval('choice('+group+').record.url.endsWith('+JSON.stringify(root('fresh'))+') && '+
        'choices.get(('+group+').key)==='+JSON.stringify(key))),'same selected track with new signed master');
    const currentFile = () => panel.eval('mediaFile(choice('+group+'),'+group+',null)');
    const allObserved = await until(async()=>{
        const urls = (await currentFile()).observedUrls || [];
        return refs('fresh').every(url=>urls.includes(site.origin+url));
    },3500);
    if (!allObserved) assert.fail('missing extensionless observation '+JSON.stringify({urls:(await currentFile()).observedUrls,
        timing:await page.eval('performance.getEntriesByType("resource").filter(e=>e.name.includes("/seg/")).map(e=>[e.name,e.contentType,e.initiatorType])')}));
    assert.equal((await currentFile()).headers.referer,site.origin+'/viewer/fresh');
    const mark = site.log.length;
    requireFreshReferrer = true;
    await panel.eval(row+'.querySelector(".download-state button").click()');
    const saved = await browser.download(before,20000);
    checkFastStart(saved,{width:1920,height:1080,frames:30,fps:60,seconds:0.5});
    assert.ok(browser.files().some(name=>!before.includes(name) && name.endsWith('.mp4')));
    const decoded = await page.eval('new Promise((resolve,reject)=>{const v=document.createElement("video");'+
        'const timeout=setTimeout(()=>reject(new Error("saved MP4 seek timed out")),5000);'+
        'v.onloadedmetadata=()=>{v.currentTime=0.25};v.onerror=()=>reject(new Error(v.error.message));'+
        'v.onseeked=()=>{clearTimeout(timeout);resolve([v.videoWidth,v.videoHeight,v.currentTime,v.readyState>=2])};'+
        'v.src="data:video/mp4;base64,'+saved.toString('base64')+'"})');
    assert.deepEqual(decoded,[1920,1080,0.25,true]);
    const downloaded = site.log.slice(mark).map(r=>r.path);
    assert.ok([root('fresh'),leaf('fresh'),...refs('fresh')].every(url=>downloaded.includes(url)));
    assert.ok(!downloaded.some(url=>url.includes('old')) && !site.log.some(r=>r.path.startsWith('/unplayed')));
    assert.ok(await until(()=>panel.eval('mediaJobs.some(j=>j.id==='+JSON.stringify(failed.id)+' && j.state==="done")')));
    assert.ok(await until(()=>panel.eval('(async()=>!(await Array.fromAsync((await (await navigator.storage.getDirectory()).getDirectoryHandle("snag-media-v1")).keys())).length)()')));
    assert.deepEqual(panel.errors,[]);
    t.check('同一卡片在 410 后用新地址与请求头重试，保存的双轨 MP4 可在浏览器定位解码，临时文件全部释放',true);
}

test('通用播放器、跨域 iframe 与签名 HLS',async t => {
    const id = '468709505', library = fs.readFileSync(path.join(EXT,'lib/hls.min.js'));
    const assets = new Map(), runtimeUrls = new Map(), rejected = [];
    function asset(pathname,body,type) {
        const url = pathname+'?auth_key=test%2B'+assets.size+'%2Fsample&v=2';
        assets.set(url,{body:Buffer.from(body),type});
        return url;
    }
    const hls = 'application/vnd.apple.mpegurl';
    function loaderReference(url) {
        const pathname = url.split('?',1)[0];
        runtimeUrls.set(pathname,url);
        return pathname;
    }
    function rendition(name,file,type,dir,opaque = false) {
        const chunks = boxes(fixture(file));
        const init = asset(dir+'/init-'+name+'.m4s',Buffer.concat(chunks.slice(0,2).map(b=>b.data)),type);
        const parts = [];
        for (let i=2; i<chunks.length && chunks[i].name==='moof'; i+=2) {
            const basename = opaque ? (name === 'picture' ? '6113_' : '8213_')+parts.length : 'seg-'+(parts.length+1)+'-'+name;
            const url = asset(dir+'/'+basename+'.m4s',Buffer.concat([chunks[i].data,chunks[i+1].data]),type);
            parts.push(opaque && parts.length % 2 === 0 ? loaderReference(url) : url);
        }
        const duration = 4/parts.length;
        return asset('/lists/'+name+'.m3u8','#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:1\n'+
            '#EXT-X-MAP:URI="'+(opaque ? loaderReference(init) : init)+'"\n'+parts.map(p=>'#EXTINF:'+duration+',\n'+p+'\n').join('')+'#EXT-X-ENDLIST\n',hls);
    }
    const folder = '/hls/videos/202505/16/'+id+'/720P_4000K_'+id+'.mp4';
    const video = rendition('v1-a1','video.mp4','video/mp4',folder);
    const audio = rendition('audio','preview-audio.m4s','audio/mp4',folder);
    function masterList(pathname,picture,sound,alternatives = '') {
        return asset(pathname,'#EXTM3U\n#EXT-X-VERSION:7\n'+
            '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="sound",NAME="Main",DEFAULT=YES,AUTOSELECT=YES,URI="'+sound+'"\n'+
            '#EXT-X-STREAM-INF:BANDWIDTH=170000,RESOLUTION=320x180,CODECS="avc1.42c01e,mp4a.40.2",AUDIO="sound"\n'+picture+'\n'+alternatives,hls);
    }
    const master = masterList('/lists/master.m3u8',video,audio);
    const firstUrls = [...assets.keys()];
    const ad = asset('/ads/'+id+'9.m3u8','#EXTM3U\n#EXT-X-TARGETDURATION:9\n#EXTINF:9,\nclip.m4s\n#EXT-X-ENDLIST',hls);
    const anonymous = masterList('/cdn/a2e178-h.m3u8',loaderReference(rendition('picture','video.mp4','video/mp4','/chunks',true)),
        rendition('sound','preview-audio.m4s','audio/mp4','/chunks',true),
        '#EXT-X-STREAM-INF:BANDWIDTH=280000,RESOLUTION=320x180,CODECS="avc1.42c01e,mp4a.40.2",AUDIO="sound"\n/unplayed/alternate.m3u8\n'+
        '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,FRAME-RATE=60,CODECS="avc1.42c01e,mp4a.40.2"\n/unplayed/high.m3u8\n'+
        '#EXT-X-STREAM-INF:BANDWIDTH=4200000,RESOLUTION=1920x1080,FRAME-RATE=60,CODECS="av01.0.05M.08,mp4a.40.2"\n/unplayed/high-av1.m3u8\n');
    const highFile = fixture('quality-1080p60.mp4'), header = highFile.readUInt32BE(0);
    const highInit = asset('/hd/init.m4s',highFile.subarray(0,header),'video/mp4');
    const highPart = asset('/hd/movie.m4s',highFile.subarray(header),'video/mp4');
    const highList = '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MAP:URI="'+highInit+'"\n#EXTINF:0.5,\n'+highPart+'\n#EXT-X-ENDLIST';
    const dashXml = '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT4S" minBufferTime="PT1S">'+
        '<Period id="p" duration="PT4S"><AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.42c01e">'+
        [['low',320,180,170000],['high',1920,1080,4000000]].map(([id,w,h,rate])=>
            '<Representation id="'+id+'" width="'+w+'" height="'+h+'" bandwidth="'+rate+'"><SegmentList timescale="1" duration="4">'+
            '<SegmentURL media="/dash/'+id+'.m4s"/></SegmentList></Representation>').join('')+'</AdaptationSet></Period></MPD>';
    const rivalPart = asset('/prefetch/9911_0.m4s',fixture('video.mp4'),'video/mp4');
    const rival = asset('/prefetch/another.m3u8','#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n'+rivalPart+'\n#EXT-X-ENDLIST\n',hls);
    let failedResponse, failInspection = false, inspectionFailures = 0;
    const embedded = await serve((req,res,url) => {
        if (url.pathname === '/hls.js') { send(req,res,library,'text/javascript'); return true; }
        if (url.pathname === '/dash-player') return html(res,'<video muted loop aria-label="DASH"></video><script>const v=document.querySelector("video"),m=new MediaSource();'+
            'm.onsourceopen=async()=>{await fetch("/dash/movie.mpd");const sb=m.addSourceBuffer(\'video/mp4; codecs="avc1.42c01e"\');'+
            'sb.onupdateend=()=>{m.endOfStream();v.play()};sb.appendBuffer(await (await fetch("/dash/low.m4s")).arrayBuffer())};v.src=URL.createObjectURL(m)</script>');
        if (url.pathname === '/dash/movie.mpd') { send(req,res,Buffer.from(dashXml),'application/dash+xml'); return true; }
        if (url.pathname === '/dash/low.m4s' || url.pathname === '/dash/high.m4s') {
            send(req,res,url.pathname.endsWith('low.m4s') ? fixture('video.mp4') : highFile,'video/mp4'); return true;
        }
        if (url.pathname === '/player') return html(res,'<style>.playerFlvContainer{position:relative;width:400px;height:240px}video,.mgp_eventCatcher{position:absolute;inset:0;width:100%;height:100%}video{pointer-events:none}</style>'+
            '<div id="playerDiv_'+id+'" class="playerFlvContainer mgp_container"><video aria-label="Feature" class="player-html5" muted loop playsinline><source src="" type="video/mp4"></video>'+
            '<div class="mgp_videoWrapper"></div><div class="mgp_eventCatcher"></div></div><script src="/hls.js"></script><script>'+
            'const v=document.querySelector("video"); const h=new Hls({enableWorker:false});h.loadSource('+JSON.stringify(master)+');h.attachMedia(v);v.play().catch(()=>{});'+
            'fetch('+JSON.stringify(ad)+').then(r=>r.text());</script>');
        if (url.pathname === '/unplayed/high.m3u8') { send(req,res,Buffer.from(highList),hls); return true; }
        if (url.pathname.startsWith('/unplayed/')) { res.writeHead(404); res.end(); return true; }
        if (failInspection && req.url === anonymous) { failInspection = false; inspectionFailures++; res.writeHead(503); res.end(); return true; }
        if (req.url === failedResponse?.path) {
            res.writeHead(failedResponse.status,{'Content-Type':'text/html'});
            res.end('<html><title>Fixture</title></html>'); return true;
        }
        const entry = assets.get(req.url);
        if (entry) { send(req,res,entry.body,entry.type); return true; }
        if (/\.(m4s|m3u8)$/.test(url.pathname)) { rejected.push(req.url); res.writeHead(403); res.end(); return true; }
    });
    t.defer(embedded.close);
    const outer = await serve((req,res,url) => {
        if (url.pathname === '/dplayer') return html(res,'<div class="dplayer"><div class="dplayer-video-wrap">'+
            '<video class="dplayer-video" muted hidden></video><video class="dplayer-video dplayer-video-current" muted loop playsinline></video></div></div>'+
            '<video hidden preload="none"><source></video>'.repeat(5)+'<script src="'+embedded.origin+'/hls.js"></script><script>const v=document.querySelector(".dplayer-video-current");const urls='+JSON.stringify(Object.fromEntries(runtimeUrls))+';'+
            'class PlayerLoader extends Hls.DefaultConfig.loader {load(ctx,cfg,cb){const u=new URL(ctx.url,document.baseURI);if(!u.search && urls[u.pathname])ctx.url=new URL(urls[u.pathname],u).href;super.load(ctx,cfg,cb)}}'+
            'const h=new Hls({enableWorker:false,loader:PlayerLoader,startLevel:0});h.on(Hls.Events.ERROR,(_,e)=>window.lastPlaybackError=[e.details,e.error?.message]);'+
            'h.loadSource('+JSON.stringify(embedded.origin+anonymous)+');h.autoLevelCapping=0;h.attachMedia(v);v.play().catch(()=>{});</script>');
        if (url.pathname === '/watch') return html(res,'<iframe style="border:0;width:440px;height:280px" src="'+embedded.origin+'/player"></iframe>'+
            '<iframe srcdoc="<video muted preload=auto src=/advert.mp4></video>"></iframe>');
        if (url.pathname === '/placeholder') return html(res,'<video muted preload=auto aria-label="Direct"><source src="/video.mp4" type="video/mp4">'+
            '<source src="" type="video/mp4"><source src="  " type="video/mp4"></video>');
        if (url.pathname === '/advert.mp4') { send(req,res,fixture('quality-360.mp4'),'video/mp4'); return true; }
    });
    t.defer(outer.close);
    const b = await launch();
    t.defer(b.close);
    const page = await b.open(outer.origin+'/watch'), tab = await b.tabId('/watch');
    const panel = await b.open(b.url('sidebar.html?tabId='+tab));
    const first = 'document.querySelector("#cards .resource")';
    async function wait(expr,label) {
        if (!await until(()=>panel.eval(expr),12000)) assert.fail(label+' | '+(await panel.eval('document.body.innerText')).slice(0,850)+' | '+panel.errors);
    }
    const target = JSON.stringify(embedded.origin+master);
    const matched = 'groups.find(g=>g.point?.title==="Feature" && g.point.loaded && g.tracks.some(t=>t.record.url==='+target+'))';
    await wait(matched,'master playlist attached to playing iframe');
    await wait(first+'.querySelector(".codec-value").textContent==="H.264"','parsed master metadata');
    assert.ok(await panel.eval(first+'.querySelector(".quality-tier").hidden && '+first+'.querySelector(".quality-value").textContent==="180p" && '+
        first+'.querySelector(".file-size").textContent===i18n("sideEstimatedSize",bytes(85000))'));
    assert.ok(await panel.eval(matched+'.point.current.startsWith("blob:")'));
    assert.equal(await panel.eval('groups.filter(g=>g.tracks.some(t=>['+JSON.stringify(embedded.origin+video)+','+JSON.stringify(embedded.origin+audio)+'].includes(t.record.url))).length'),0);
    assert.ok(await panel.eval('!groups.some(g=>g.tracks.some(t=>t.record.url.endsWith("/player")))'));
    assert.ok(await panel.eval('!visible.some(g=>g.tracks.some(t=>t.record.url.endsWith("/advert.mp4")))'));
    await panel.eval('document.querySelector("[data-filter=all]").click()');
    await wait('visible.some(g=>g.tracks.some(t=>t.record.url.endsWith("/advert.mp4")))','srcdoc clip available in All');
    await panel.eval('document.querySelector("[data-filter=video]").click()');
    t.check('跨域播放器对应到主清单，同帧近似编号广告、srcdoc 广告和音画子清单未混入正片',true);

    await panel.eval('document.querySelector("#pick").click()');
    await wait('picking','picker ready');
    await page.click(60,60);
    await wait('picked?.title==="Feature" && visible.length===1 && '+matched,'overlay picks the video');
    t.check('穿过透明遮罩可选中禁用指针事件的视频',true);
    const before = b.files(), start = embedded.log.length;
    await panel.eval(first+'.querySelector(".download").click()');
    const saved = await b.download(before,20000);
    assert.ok(saved,'download failed: '+JSON.stringify(await panel.eval('mediaCommand("list")')));
    assert.equal(pictureInfo(saved).seconds,4);
    const fetched = new Set(embedded.log.slice(start).map(r=>r.path));
    for (const url of firstUrls) assert.ok(fetched.has(url),'missing '+url.split('?')[0]);
    assert.deepEqual(rejected,[]);
    t.check('每个请求使用各自的完整签名；初始化段、全部视频分片和独立音轨合为四秒有声 MP4',true);

    const dp = await b.open(outer.origin+'/dplayer');
    assert.ok(await until(()=>dp.eval('v.readyState>=2 && v.videoWidth===320')));
    await dp.eval('v.pause();performance.clearResourceTimings()');
    failInspection = true;
    const dpTab = await b.tabId('/dplayer'), dpPanel = await b.open(b.url('sidebar.html?tabId='+dpTab));
    const dpMatch = 'groups.find(g=>g.point?.current.startsWith("blob:") && !g.point.streamId && g.tracks.some(t=>t.record.url==='+
        JSON.stringify(embedded.origin+anonymous)+'))';
    if (!await until(()=>dpPanel.eval(dpMatch))) assert.fail('anonymous signed master | '+JSON.stringify({
        media:await dp.eval('[v.readyState,v.duration,v.currentSrc,v.error?.message,window.lastPlaybackError]'), errors:dp.errors,
        pages:await dpPanel.eval('[...frames.values()].map(f=>[f.items.map(i=>[i.kind,i.streamId,i.loaded,i.duration,i.inactiveSlot]),[...(f.streamLists || [])].map(([u,e])=>[u,e.pending,e.unsupported,e.list?.children]),f.segments])'),
        requests:embedded.log.slice(-14).map(r=>r.path), rejected}));
    assert.ok(await until(()=>[...runtimeUrls.values()].every(url=>embedded.log.some(r=>r.path===url))),'player requested its signed samples');
    assert.ok(await until(()=>dpPanel.eval('('+dpMatch+')?.tracks.length===4')));
    assert.equal(inspectionFailures,1);
    assert.ok(await dp.eval('v.paused && [...document.querySelectorAll("video")].filter(v=>!v.readyState).length>=5'));
    await dp.eval('v.parentElement.dataset.videoId="998877"');
    assert.ok(await until(()=>dpPanel.eval('groups.some(g=>g.point?.streamId==="998877" && g.tracks.length===4)')));
    await dp.eval('delete v.parentElement.dataset.videoId');
    assert.ok(await until(()=>dpPanel.eval(dpMatch)));
    t.check('五个空占位旁暂停的视频仍能匹配；清空性能记录并让首次检查返回 503 后自动恢复，页面编号也可与 CDN 路径不同',true);
    const second = b.files();
    await dpPanel.eval(first+'.querySelector(".download").click()');
    const finished = await until(()=>dpPanel.eval('mediaJobs.find(j=>j.tabId===tabId && ["done","failed"].includes(j.state))'),20000);
    assert.equal(finished?.state,'done','selected '+embedded.log.filter(r=>r.path.startsWith('/unplayed/')).map(r=>r.path)+' | '+finished?.error);
    assert.deepEqual(await b.download(second,20000),saved);
    assert.deepEqual(rejected,[]);
    assert.ok(!embedded.log.some(r=>r.path.startsWith('/unplayed/')));
    assert.deepEqual(await dpPanel.eval('('+checkHlsPreferences.toString()+')()'),['/low.m3u8','/low.m3u8','/high.m3u8','/high.m3u8']);
    t.check('多画质 HLS 选择播放器实际请求的版本，即使同分辨率还有更高码率，也保存了逐字节相同的有声视频',true);

    const outputFiles = b.files();
    const statusBox = first+'.querySelector(".download-state")';
    for (const failure of [
        {path:anonymous,status:403,stage:'mediaPlaylistReadFailed'},
        {path:runtimeUrls.get('/chunks/6113_0.m4s'),status:404,stage:'mediaSegmentReadFailed'},
        {path:anonymous,status:200,stage:'mediaPlaylistReadFailed',reason:'mediaUnexpectedResponse'}
    ]) {
        const previous = new Set(await dpPanel.eval('mediaJobs.map(j=>j.id)'));
        failedResponse = failure;
        assert.ok(await until(()=>dpPanel.eval('!'+first+'.querySelector(".download").disabled')));
        await dpPanel.eval(first+'.querySelector(".download").click()');
        const job = await until(async () => (await dpPanel.eval('mediaJobs')).find(j=>!previous.has(j.id) && j.state==='failed'));
        assert.ok(job?.canRetry,'failure '+failure.status+' | '+JSON.stringify(await dpPanel.eval('mediaJobs.map(j=>[j.title,j.state,j.error])')));
        assert.equal(job.sourceFailure.stage,failure.stage);
        assert.equal(job.sourceFailure.status,failure.status === 200 ? undefined : failure.status);
        assert.equal(job.sourceFailure.reason,failure.reason);
        const reason = failure.reason ? await dpPanel.eval('i18n.'+failure.reason) : 'HTTP '+failure.status;
        const expected = await dpPanel.eval('i18n.'+failure.stage)+' · '+reason;
        assert.ok(await until(()=>dpPanel.eval(statusBox+'.textContent.includes('+JSON.stringify(expected)+')')));
        assert.doesNotMatch(await dpPanel.eval(statusBox+'.textContent'),/https?:|auth_key|\.m3u8|\.m4s/);
    }
    assert.deepEqual(b.files(),outputFiles);
    for (const width of [320,740]) {
        await dpPanel.send('Emulation.setDeviceMetricsOverride',{width,height:720,deviceScaleFactor:1,mobile:false});
        assert.ok(await dpPanel.eval('document.documentElement.scrollWidth<=document.documentElement.clientWidth && '+
            statusBox+'.getBoundingClientRect().right<=innerWidth'));
    }
    failedResponse = null;
    await dpPanel.eval(statusBox+'.querySelector("button").click()');
    assert.deepEqual(await b.download(outputFiles,20000),saved);
    t.check('卡片区分清单 403、分片 404 和网页响应，两种栏宽都能显示；恢复后可从同一张卡重试保存',true);

    const chooseTier = value => '(()=>{const select='+first+'.querySelector(".quality-tier");select.value='+JSON.stringify(value)+
        ';select.dispatchEvent(new Event("change"))})()';
    await dpPanel.eval(chooseTier('1080p60'));
    assert.ok(await until(()=>dpPanel.eval(first+'.querySelector(".encoding-current").textContent==="H.264" && '+
        first+'.querySelector(".playback-quality").textContent.includes("180p") && '+first+'.querySelector(".file-size").textContent===i18n("sideEstimatedSize",bytes(2000000))')));
    assert.ok(await dpPanel.eval('[...'+first+'.querySelector(".encoding").options].some(o=>o.text.includes("AV1"))'));
    for (const width of [320,740]) {
        await dpPanel.send('Emulation.setDeviceMetricsOverride',{width,height:720,deviceScaleFactor:1,mobile:false});
        assert.ok(await dpPanel.eval('document.documentElement.scrollWidth<=innerWidth && ['+first+'.querySelector(".tier-current"),'+
            first+'.querySelector(".encoding-current")].every(e=>e.offsetWidth && e.getBoundingClientRect().right<=innerWidth)'));
    }
    assert.ok(!embedded.log.some(r=>r.path.startsWith('/unplayed/') || r.path.startsWith('/hd/')));
    const beforeHigh = b.files();
    await dpPanel.eval(first+'.querySelector(".download").click()');
    checkFastStart(await b.download(beforeHigh,20000),{width:1920,height:1080,frames:30,fps:60,seconds:0.5});
    assert.ok(b.files().some(name=>!beforeHigh.includes(name) && name.endsWith('.mp4')));
    assert.ok(!embedded.log.some(r=>r.path==='/unplayed/high-av1.m3u8'));
    t.check('单档显示清晰度、编码和约数；多档手选 1080p60 后网页仍为 180p，点击下载才请求所选清单并保存正确成品',true);

    await dp.eval('v.classList.remove("dplayer-video-current");document.querySelector("video").classList.add("dplayer-video-current")');
    assert.ok(await until(()=>dpPanel.eval('!('+dpMatch+') && !groups.some(g=>g.point?.inactiveSlot)')));
    await dp.eval('document.querySelector("video").classList.remove("dplayer-video-current");v.classList.add("dplayer-video-current")');
    assert.ok(await until(()=>dpPanel.eval(dpMatch)));
    await dp.eval('Promise.all('+JSON.stringify([embedded.origin+rival,embedded.origin+rivalPart])+'.map(url=>fetch(url).then(r=>r.arrayBuffer())))');
    assert.ok(await until(()=>dpPanel.eval('groups.some(g=>g.playerOnly) && !('+dpMatch+')')));
    t.check('切换当前播放器会解除旧匹配；同帧预加载另一部等长视频时保留两份清单供选择',true);

    const dash = await dpPanel.eval('('+checkDashOwnership.toString()+')()');
    assert.deepEqual(dash,[true,false,false]);
    assert.deepEqual(await dpPanel.eval('('+checkEarlyInspection.toString()+')()'),{before:0,after:true,direct:false,
        requests:['https://example.test/index.m3u8'],allowed:true,excluded:true,observed:['https://example.test/seg/1?h=sample']});
    assert.ok(await dpPanel.eval('(()=>{const u="https://example.test/v.m3u8";return MediaSources.revisionKey(u+"?sign=a&hash=b&md5=c&expire=4&ttl=5&validfrom=6&validto=7&hdnea=8&st=9&wssecret=x&wstime=y&id=i&v=v&video=f&lang=en&quality=hd&p=2")===u+"?id=i&v=v&video=f&lang=en&quality=hd&p=2"})()'));
    t.check('DASH 模板保留查询参数，其他签名或旧 iframe 文档的请求不能认领当前播放器',true);
    const testHost = 'https://example.test/', testFolder = testHost+'hls/4687/';
    const expectedKey = testHost+'v/id.key?token=one%2Btwo';
    assert.deepEqual(await dpPanel.eval('('+checkEncryptionPlan.toString()+')()'),{
        ivs:[null,'10000000a'.padStart(32,'0'),'B'.padStart(32,'0'),'B'.padStart(32,'0'),null],
        matched:expectedKey,ambiguous:testHost+'v/id.key',observedKeys:[expectedKey]});
    t.check('AES 清单正确区分初始化段和序号，按原路径匹配密钥，拒绝无效 IV、序号、协议及受保护格式',true);
    assert.deepEqual(await dpPanel.eval('('+checkStreamRevisions.toString()+')()'),{
        pending:[testFolder+'media.m3u8'],resolved:[testFolder+'master.m3u8?token=older'],newest:[testFolder+'master.m3u8?token=newest'],
        hidden:true,retainedChoice:true,rotation:{roots:[testHost+'queue.m3u8?ttl=2000&h=fresh'],hidden:true,stable:true,
            reads:[testHost+'queue.m3u8?ttl=2000&h=fresh',testHost+'tier.m3u8?ticket=fresh']},
        tiers:['1080p','720p'],playable:['1080p'],differentQuery:[],distinct:[],equivalent:[testHost+'opaque.m3u8?token=b'],twoPlayers:false,
        selectedReads:[testHost+'select.m3u8?token=master',testHost+'tier.m3u8?lang=en&token=fresh'],part:testHost+'unseen.m4s'
    });
    t.check('主清单待查时保留已确认的子清单，同一节目的新签名和独立画质正确归组，内容不同或多播放器时保留歧义',true);
    assert.deepEqual(await dpPanel.eval('('+checkObservedAddresses.toString()+')()'),[
        'https://example.test/chosen.m4s?quality=720&sig=x%2By','https://example.test/ambiguous.m4s','https://example.test/unseen.m4s',
        'https://other.example.test/only.m4s','https://example.test/only.m4s?auth_key=x%2By%2Fz&v=1']);
    t.check('已有参数照原样使用；有歧义、跨域或尚未请求的分片不会套用另一个文件的签名',true);
    await b.open(outer.origin+'/placeholder');
    const blankTab = await b.tabId('/placeholder'), blankPanel = await b.open(b.url('sidebar.html?tabId='+blankTab));
    assert.ok(await until(()=>blankPanel.eval('groups.some(g=>g.point?.loaded && g.point.title==="Direct" && g.tracks.length===1)')));
    assert.deepEqual(await blankPanel.eval('[...new Set(frames.get(0).items.find(i=>i.title==="Direct").sources.map(s=>s.url))]'),[outer.origin+'/video.mp4']);
    t.check('空白 source 与有效相对地址并列时，网页地址不会出现在视频候选里',true);
    await b.open(embedded.origin+'/dash-player');
    const dashPanel = await b.open(b.url('sidebar.html?tabId='+await b.tabId('/dash-player')));
    assert.ok(await until(()=>dashPanel.eval('groups.some(g=>g.point?.title==="DASH" && g.tracks.length===2)')));
    await dashPanel.eval(chooseTier('1080p'));
    assert.ok(await dashPanel.eval(first+'.querySelector(".codec-value").textContent==="H.264" && '+
        first+'.querySelector(".file-size").textContent===i18n("sideEstimatedSize",bytes(2000000))'));
    await dashPanel.eval(first+'.querySelector(".toggle-details").click()');
    assert.ok(await dashPanel.eval(first+'.querySelector(".detail-info").textContent.includes(i18n("sideEstimatedSize",bytes(2000000)))'));
    assert.ok(!embedded.log.some(r=>r.path==='/dash/high.m4s'));
    const beforeDash = b.files();
    await dashPanel.eval(first+'.querySelector(".download").click()');
    const dashResult = await b.download(beforeDash,20000);
    assert.ok(dashResult && pictureInfo(dashResult).fps===60 && embedded.log.some(r=>r.path==='/dash/high.m4s'));
    t.check('静态 DASH 从已读 MPD 列出两档并估算大小，手选后保存了指定 Representation 的 60 帧率视频',true);
    assert.deepEqual(panel.errors,[]);
    assert.deepEqual(dpPanel.errors,[]);
    await checkExtensionlessRetry(b,t);
    await checkLeafStreams(b,t);
});
