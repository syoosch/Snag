'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const {EXT,fixture,serve,send,segment,until} = require('./harness');
const {boxes,videoCodec} = require('./mp4');

// Run the real HLS player and let the test release its second fragment independently.
function startPlayer() {
    const kind = new URL(location.href).searchParams.get('kind');
    let allowed = 0;
    const pending = new Map();
    window.nextFragment = () => { allowed++; pending.get(allowed)?.(); };
    class Loader extends Hls.DefaultConfig.loader {
        load(context,config,callbacks) {
            const n = /\/(\d+)\.(?:ts|m4s)$/.exec(new URL(context.url,location.href).pathname);
            if (n && Number(n[1]) > allowed) pending.set(Number(n[1]),() => super.load(context,config,callbacks));
            else super.load(context,config,callbacks);
        }
    }
    const v = document.querySelector('#main'), h = new Hls({enableWorker:false,loader:Loader});
    h.loadSource('/914/'+kind+'/071e8e-h.m3u8'); h.attachMedia(v); v.play().catch(() => {});
}
// Count isolated-world reads even when the HTTP cache satisfies them without contacting the server.
function monitorProbes() {
    const original = globalThis.fetch;
    globalThis.probeReads = [];
    globalThis.fetch = async (url,options) => {
        const response = await original(url,options);
        if (!/\.(ts|m4s)(?:\?|$)/.test(url)) return response;
        const probe = {url,cache:options.cache,redirect:options.redirect,credentials:options.credentials,bytes:0,cancelled:false};
        probeReads.push(probe);
        const getReader = response.body.getReader.bind(response.body);
        response.body.getReader = (...args) => {
            const reader = getReader(...args), read = reader.read.bind(reader), cancel = reader.cancel.bind(reader);
            reader.read = async (...args) => {
                const result = await read(...args); probe.bytes += result.value?.byteLength || 0; return result;
            };
            reader.cancel = (...args) => { probe.cancelled = true; return cancel(...args); };
            return reader;
        };
        return response;
    };
}
function checkedFrame(panel,id,frameId,world,func) {
    return panel.eval('chrome.scripting.executeScript({target:{tabId:'+id+',frameIds:['+frameId+']},world:"'+world+'",func:('+
        func.toString()+')}).then(([r])=>{if(r.error) throw new Error(r.error.message); return r.result})');
}

// Exercise size/probe decisions with the same parser and frame matching code that builds the cards.
function sampleBoundaries() {
    const base = 'https://example.test/914/', url = base+'leaf.m3u8';
    const player = {id:1,key:'player',kind:'video',loaded:true,stream:true,streamId:'914',sources:[]};
    const record = {frameId:2,documentId:'doc',url,ext:'m3u8'};
    const messages = [], frame = {frameId:2,documentId:'doc',url:base,items:[player],port:{postMessage:m=>messages.push(m)}};
    const frames = new Map([[2,frame]]), records = new Map([[url,record]]);
    function match(body,observations,loaded = true) {
        player.loaded = loaded; messages.length = 0;
        frame.streamLists = new Map([[url,{pending:true,format:'hls'}]]);
        receivePlaylistText(frame,{url,text:'#EXTM3U\n'+body+'\n#EXT-X-ENDLIST'});
        const samples = observations.map(([name,bytes,documentId = 'doc'])=>({url:base+name,frameId:2,documentId,bytes}));
        const m = genericStreamMatches(records,frames,true,samples).get(record);
        genericStreamMatches(records,frames,true,samples);
        return [m?.partSize?.value ?? null,messages.filter(m=>m.type==='inspectLeaf').map(m=>m.url.slice(base.length))];
    }
    const two = '#EXT-X-MAP:URI="unseen-init"\n#EXTINF:1,\na\n#EXTINF:3,\nb\n#EXTINF:2,\nc';
    return [match('#EXTINF:4,\na',[['a',127]]),match(two,[['a',300],['a',300],['b',200,'old']]),
        match(two,[['a',100],['b?sig=fresh',700]]),match('#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x1\n'+two,[['a',50],['b',50]]),
        match(two,[]),match(two,[['a',300]],false),match('#EXTINF:0,\na',[['a',500]])];
}

async function checkTransferCache(browser,t) {
    const site = await serve((req,res,u)=>{
        if (u.pathname === '/page') { res.writeHead(200,{'Content-Type':'text/html'}); res.end('<title>Observed bytes</title>'); }
        else if (u.pathname === '/failed.ts') { res.writeHead(404); res.end(); }
        else send(req,res,Buffer.alloc(64),u.pathname.endsWith('/binary') ? 'application/octet-stream' : 'video/mp2t');
        return true;
    });
    t.defer(site.close);
    const page = await browser.open(site.origin+'/page'), id = await browser.tabId(site.origin+'/page');
    const values = () => browser.sw.eval('[...(segmentTransfers.get('+id+')?.values() || [])]');
    await page.eval('Promise.all([fetch("/range.ts",{headers:{Range:"bytes=12-26"}}),fetch("/binary"),fetch("/never.ts",{method:"HEAD"}),fetch("/failed.ts")].map(async r=>(await r).arrayBuffer()))');
    const samples = await values();
    const range = samples.find(s=>s.url.endsWith('/range.ts'));
    assert.equal(range?.bytes,15); assert.equal(range.offset,12);
    assert.equal(samples.find(s=>s.url.endsWith('/binary'))?.bytes,64);
    assert.ok(!samples.some(s=>/(never|failed)\.ts/.test(s.url)));
    assert.deepEqual(await browser.sw.eval('getResponseHeadersValue({statusCode:206,responseHeaders:[{name:"Content-Length",value:"9"}]})'),{responseSize:9});
    await page.eval('Promise.all(Array.from({length:130},(_,i)=>fetch("/"+i+".ts").then(r=>r.arrayBuffer())))');
    assert.equal((await values()).length,128);
    await page.send('Page.reload');
    assert.ok(await until(async()=>!(await values()).some(s=>s.url.endsWith('.ts'))));
    await page.eval('fetch("/current.ts").then(r=>r.arrayBuffer())');
    assert.ok((await values()).some(s=>s.url.endsWith('/current.ts')));
    await page.close();
    assert.ok(await until(()=>browser.sw.eval('!segmentTransfers.has('+id+')')));
    t.check('206 只计实际区间，支持无后缀二进制，忽略 HEAD 和错误响应；128 条上限、刷新和关页清理均生效',true);
}

async function checkLeafStreams(browser,t) {
    const type = 'application/vnd.apple.mpegurl', hls = fs.readFileSync(path.join(EXT,'lib/hls.min.js'));
    const ts = [segment(0),segment(1,6000),segment(2,3500)];
    const top = boxes(fixture('video.mp4')), init = Buffer.concat(top.slice(0,2).map(b=>b.data));
    const fragments = top.filter((b,i)=>b.name === 'moof').map((b,i)=>Buffer.concat([b.data,top[3+i*2].data]));
    const ranged = Buffer.concat([init,...fragments]);
    const immutable = {'Cache-Control':'public, max-age=3600'};
    let failureReads = 0;
    function manifest(kind) {
        const entries = ['#EXTM3U','#EXT-X-VERSION:7','#EXT-X-TARGETDURATION:2'];
        let offset = init.length;
        if (kind === 'range') entries.push('#EXT-X-MAP:URI="all.mp4",BYTERANGE="'+init.length+'@0"');
        if (kind === 'm4s') entries.push('#EXT-X-MAP:URI="init.m4s"');
        const parts = kind === 'ts' ? ts : fragments;
        parts.forEach((p,i) => {
            if (kind === 'ts' && i) entries.push('#EXT-X-DISCONTINUITY');
            entries.push('#EXTINF:'+(kind === 'ts' ? 2 : 1)+',');
            if (kind === 'range') {
                entries.push('#EXT-X-BYTERANGE:'+p.length+'@'+offset,'all.mp4'); offset += p.length;
            } else entries.push(i+'.'+kind);
        });
        return entries.concat('#EXT-X-ENDLIST').join('\n');
    }
    const site = await serve((req,res,u) => {
        if (u.pathname === '/player') {
            const titled = u.searchParams.get('kind') !== 'm4s';
            res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
            res.end('<!doctype html><head>'+(titled ? '<title>River field notes</title>' : '')+'</head><body>'+
                '<video hidden preload="none"></video>'.repeat(4)+'<div data-video-id="914"><video id="main" muted playsinline></video></div>'+
                '<script src="/hls.js"></script><script>window.startPlayer='+startPlayer.toString()+'</script></body>'); return true;
        }
        if (u.pathname === '/hls.js') { send(req,res,hls,'text/javascript',immutable); return true; }
        if (u.pathname === '/declared.mp4') { send(req,res,fixture('video.mp4'),'video/mp4; codecs="av01.0.08M.08"',immutable); return true; }
        const [,kind,name] = /^\/914\/(ts|m4s|range|failure)\/(.+)$/.exec(u.pathname) || [];
        if (!kind) return;
        if (name === '071e8e-h.m3u8') {
            send(req,res,Buffer.from(manifest(kind === 'failure' ? 'ts' : kind)),kind === 'range' ? type+'; codecs="avc1.42c01e"' : type,immutable);
        } else if (kind === 'failure' && name === '0.ts') {
            if (++failureReads === 1) send(req,res,ts[0],'video/mp2t');
            else { res.writeHead(503); res.end(); }
        } else if (name === 'master.m3u8') {
            send(req,res,Buffer.from('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",DEFAULT=YES,NAME="Main",URI="sound.m3u8"\n'+
                '#EXT-X-STREAM-INF:AUDIO="a"\n071e8e-h.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000\nunplayed.m3u8'),type,immutable);
        } else if (name === 'init.m4s') send(req,res,init,'video/mp4',immutable);
        else if (name === 'all.mp4') send(req,res,ranged,'video/mp4',immutable);
        else if (/^\d+\.(m4s|ts)$/.test(name)) send(req,res,(kind === 'ts' ? ts : fragments)[parseInt(name,10)],kind === 'ts' ? 'video/mp2t' : 'video/mp4',immutable);
        else return;
        return true;
    });
    t.defer(site.close);
    const outer = await serve((req,res) => {
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
        res.end('<!doctype html><title>Harbour documentary</title><iframe src="'+site.origin+'/player?kind=m4s"></iframe>');
        return true;
    });
    t.defer(outer.close);
    assert.equal(await browser.sw.eval('G.Ext.get("ts").state'),false);
    for (const kind of ['ts','m4s','range','failure']) {
        const embedded = kind === 'm4s', name = embedded ? 'Harbour documentary' : 'River field notes';
        const url = embedded ? outer.origin+'/outer' : site.origin+'/player?kind='+kind;
        const page = await browser.open(url), id = await browser.tabId(url);
        const panelUrl = browser.url('sidebar.html?tabId='+id);
        let panel = await browser.open(panelUrl);
        const frame = await until(()=>panel.eval('[...frames.values()].filter(f=>f.ready && f.url.includes("/player?kind=")).map(f=>({frameId:f.frameId}))[0]'));
        assert.ok(frame,'player document connected');
        const run = (world,fn) => checkedFrame(panel,id,frame.frameId,world,fn);
        assert.ok(await until(()=>run('MAIN',()=>typeof window.startPlayer==='function' && typeof Hls==='function')),'HLS fixture loaded');
        await run('ISOLATED',monitorProbes);
        await run('MAIN',()=>window.startPlayer());
        const group = 'groups.find(g=>g.point?.loaded && g.tracks.some(t=>t.streamLeaf))';
        const row = 'rows.get(('+group+').key).node';
        const field = sel => row+'.querySelector('+JSON.stringify(sel)+')';
        const wait = async (expr,label) => {
            if (!await until(()=>panel.eval(expr),12000)) assert.fail(kind+' '+label+' | '+await panel.eval('document.body.innerText')+
                ' | '+JSON.stringify(site.log.slice(-9).map(r=>r.path)));
        };
        if (kind === 'failure') {
            await wait('('+group+')?.point.loaded','loaded player before failed probe');
            assert.ok(await until(async()=>(await run('ISOLATED',()=>probeReads)).length===1));
            await panel.close(); panel = await browser.open(panelUrl);
            await wait('('+group+')?.point.loaded','reopened sidebar');
            await panel.eval('rescan()');
            assert.equal(await panel.eval(field('.codec-value')+'.textContent'),'—');
            assert.equal((await run('ISOLATED',()=>probeReads)).length,1);
            assert.equal(failureReads,2); // First playback request, then the one unsuccessful probe.
            assert.ok(!site.log.some(r=>r.path==='/914/failure/1.ts'));
            t.check('已播首段探测失败时保持未知，重新打开侧栏和重扫都不会重复探测或读取未播放分片',true);
            await panel.close(); await page.close(); continue;
        }
        await wait('('+group+')?.point.current.startsWith("blob:") && '+field('.codec-value')+'.textContent==="H.264"','leaf with codec');
        const quality = kind === 'ts' ? '90p' : '180p';
        assert.equal(await panel.eval(field('h3')+'.textContent'),name);
        assert.equal(await panel.eval('('+group+').point.title'),embedded ? '' : name);
        assert.equal(await panel.eval(field('.quality-value')+'.textContent'),quality);
        assert.equal(await panel.eval(field('.download')+'.textContent'),await panel.eval('i18n("sideDownloadAt","'+quality+'")'));
        assert.equal(await panel.eval(field('.playback-quality')+'.hidden'),true);
        if (kind === 'range') {
            assert.equal(await panel.eval(field('.file-size')+'.textContent'),await panel.eval('bytes('+ranged.length+')'));
            assert.deepEqual(await run('ISOLATED',()=>probeReads),[]);
            const before = browser.files();
            await panel.eval('G.TitleName=true;G.downFileName="Archive-$'+'{title}";'+field('.download')+'.click()');
            assert.ok((await browser.download(before,16000))?.length);
            assert.ok(browser.files().includes('Archive-'+name+'.mp4'));
            t.check('全部 BYTERANGE 含初始化段时显示精确大小，已声明编码免探测，自定义模板决定实际保存名',true);
        } else {
            const reads = () => run('ISOLATED',()=>probeReads);
            const probes = await reads();
            assert.equal(probes.length,1); assert.equal(probes[0].cancelled,true);
            assert.equal(probes[0].url,site.origin+'/914/'+kind+'/'+(embedded ? 'init.m4s' : '0.ts'));
            assert.equal(probes[0].cache,'force-cache'); assert.equal(probes[0].redirect,'error');
            assert.equal(probes[0].credentials,undefined); assert.equal(probes[0].bytes,embedded ? init.length : 16384);
            assert.equal(await panel.eval(field('.file-size')+'.textContent'),'—');
            await panel.eval(field('.toggle-details')+'.click()');
            const beforeSecond = site.log.length, pathPrefix = '/914/'+kind+'/';
            await run('MAIN',()=>window.nextFragment());
            const parts = embedded ? fragments : ts;
            const expected = Math.round((parts[0].length+parts[1].length)*parts.length/2);
            const label = 'i18n("sideEstimatedSize",bytes('+expected+'))';
            await wait(field('.file-size')+'.textContent==='+label+' && '+field('.detail-info')+'.textContent.includes('+label+')','second observed part');
            assert.equal(await panel.eval('document.querySelector("#segments").hidden'),true);
            assert.deepEqual(site.log.slice(beforeSecond).filter(r=>r.path.startsWith(pathPrefix)).map(r=>r.path),[pathPrefix+'1.'+kind]);
            assert.ok(!site.log.some(r=>r.path === pathPrefix+'2.'+kind));
            assert.deepEqual(await reads(),probes);
            const stored = await panel.eval('chrome.runtime.sendMessage({Message:"sidebarData",tabId})');
            assert.ok(stored.transfers.some(s=>s.url.endsWith('/1.'+kind) && s.bytes===parts[1].length));
            if (!embedded) assert.ok(!stored.records.some(r=>r.ext==='ts'));
            for (const width of [320,740]) {
                await panel.send('Emulation.setDeviceMetricsOverride',{width,height:760,deviceScaleFactor:1,mobile:false});
                assert.ok(await panel.eval('document.documentElement.scrollWidth<=innerWidth && '+field('.download')+'.getBoundingClientRect().right<=innerWidth'));
            }
            await panel.eval(field('.toggle-details')+'.click()');
            const before = browser.files();
            await panel.eval(field('.download')+'.click()');
            const saved = await browser.download(before,18000);
            assert.ok(saved?.length); assert.equal(videoCodec(saved),'avc1');
            assert.ok(browser.files().includes(name+'.mp4'),'saved filename: '+browser.files().join(', '));
            assert.deepEqual(await reads(),probes);
            t.check(kind+' 真实 blob 播放显示画质、下载按钮和 H.264，两段后卡片与已打开的详情同步估算，保存文件使用'+(embedded?'外层页标题':'唯一已加载播放器的网页标题'),true);
            if (!embedded) {
                assert.deepEqual(await panel.eval('(()=>{const point=('+group+').point,r={name:"clip.mp4",ext:"mp4",title:"Tab title"};'+
                    'return [title({kind:"video",point:{...point,title:""}},r),title({kind:"video",point:{kind:"other"}},r),'+
                    'title({kind:"image"},{...r,name:"photo.jpg"}),title({kind:"video",point:{...point,title:""}},{...r,title:"NULL"})]})()'),
                    ['Tab title','clip.mp4','photo.jpg','clip.mp4']);
                assert.deepEqual(await panel.eval('('+sampleBoundaries.toString()+')()'),[
                    [127,['a']],[null,['a']],[1200,['a']],[150,[]],[null,[]],[null,[]],[null,['a']]]);
                await page.eval('fetch("/914/ts/master.m3u8").then(r=>r.text())');
                const master = 'groups.find(g=>g.point?.loaded && g.tracks.some(t=>t.record.url.endsWith("/master.m3u8")))';
                const node = 'rows.get(('+master+').key).node';
                await wait('('+master+')?.tracks.length===2 && '+node+'.querySelector(".quality-value").textContent==="—"','master without RESOLUTION');
                assert.ok(await panel.eval('('+master+').tracks.every(t=>!t.streamLeaf) && !'+node+'.querySelector(".playback-quality").hidden'));
                assert.equal(await panel.eval(node+'.querySelector(".file-size").textContent'),await panel.eval(label));
                assert.equal(await panel.eval(node+'.querySelector(".size-label").textContent'),await panel.eval('i18n.sidePictureSize'));
                assert.ok(!site.log.some(r=>/\/(?:sound|unplayed)\.m3u8$/.test(r.path)));
                await page.eval('fetch("/declared.mp4").then(r=>r.arrayBuffer())');
                await wait('[...rows.values()].some(r=>r.group.tracks.some(t=>t.record.type==="video/mp4" && t.record.codecs?.startsWith("av01")) && '+
                    'r.node.querySelector(".codec-value").textContent==="AV1")','direct MP4 codecs parameter');
                t.check('无 RESOLUTION 的 Master 保留独立播放画质，无 BANDWIDTH 的已播子清单显示画面估算，直链从响应头显示 AV1',true);
            }
        }
        assert.deepEqual(panel.errors,[]);
        await panel.close(); await page.close();
    }
    await checkTransferCache(browser,t);
}
module.exports = {checkLeafStreams};
