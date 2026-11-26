'use strict';

const assert = require('node:assert/strict');
const {createCipheriv} = require('node:crypto');
const {launch,serve,send,html,fixture,segment,until,test} = require('./lib/harness');
const {boxes,checkFastStart} = require('./lib/mp4');

async function checkEncryptedDownloads(browser,t,source,parts,reference) {
    const a = Buffer.alloc(16,0x17), b = Buffer.alloc(16,0x42), assets = new Map();
    const keyUrl = id => '/keys/'+id+'.key?ticket=fixture-private';
    const inline = 'data:application/octet-stream;base64,'+a.toString('base64');
    function playlist(name,rows,start) {
        const lines = ['#EXTM3U','#EXT-X-TARGETDURATION:1'];
        if (start !== undefined) lines.push('#EXT-X-MEDIA-SEQUENCE:'+start);
        let seq = start || 0, previous;
        for (const [index,{body,key,iv,init}] of rows.entries()) {
            const uri = key === 'inline' ? inline : keyUrl(key);
            const tag = key ? '#EXT-X-KEY:METHOD=AES-128,KEYFORMAT="identity",URI="'+uri+'"'+(iv ? ',IV=0x'+iv : '') : '#EXT-X-KEY:METHOD=NONE';
            if (previous !== tag) { lines.push(tag); previous=tag; }
            const path = '/parts/'+name+'/'+index;
            let bytes = body;
            if (key) {
                const vector = Buffer.from((iv || seq.toString(16)).padStart(32,'0'),'hex');
                const enc = createCipheriv('aes-128-cbc',key==='b' ? b : a,vector);
                bytes = Buffer.concat([enc.update(body),enc.final()]);
            }
            if (name === 'unaligned') bytes = bytes.subarray(1);
            if (name === 'empty') bytes = Buffer.alloc(0);
            if (name === 'padding') bytes[bytes.length-17] ^= 0x80;
            assets.set(path,bytes);
            if (init) lines.push('#EXT-X-MAP:URI="'+path+'"');
            else { lines.push('#EXTINF:1,',path); seq++; }
        }
        assets.set('/'+name+'.m3u8',Buffer.from([...lines,'#EXT-X-ENDLIST'].join('\n')));
    }
    playlist('many',parts.map(body=>({body,key:'shared'})),10);
    const atoms = boxes(fixture('hls-av-fragmented.mp4')), pieces = [];
    for (let i=2; atoms[i]?.name==='moof'; i+=2) pieces.push(Buffer.concat([atoms[i].data,atoms[i+1].data]));
    assert.ok(pieces.length>=3);
    const mixed = [{body:Buffer.concat(atoms.slice(0,2).map(x=>x.data)),init:true,key:'a',iv:'05'}];
    pieces.forEach((body,i)=>mixed.push({body,key:i===0?'a':i===1?'b':null,iv:i===0?'05':undefined}));
    playlist('mixed',mixed,10);
    for (const key of ['flaky','exhausted','inline','short','forbidden','json','html','empty','unaligned','padding']) playlist(key,[{body:source,key}]);
    for (const [name,tag] of [['sample','METHOD=SAMPLE-AES'],['drm','METHOD=AES-128,KEYFORMAT="com.example.drm"']]) {
        assets.set('/'+name+'.m3u8',Buffer.from('#EXTM3U\n#EXT-X-KEY:'+tag+',URI="'+keyUrl('unread')+'"\n#EXTINF:1,\n/unread.ts\n#EXT-X-ENDLIST'));
    }
    let flaky = 0, flakyMedia = 0;
    const site = await serve((req,res,u)=>{
        if (u.pathname==='/view') return html(res,'<title>AES playback fixtures</title>');
        const id = /^\/keys\/(\w+)\.key$/.exec(u.pathname)?.[1];
        if (id) {
            assert.equal(req.url,keyUrl(id));
            if (id==='forbidden' || req.headers.referer!==site.origin+'/view') { res.writeHead(403); res.end(); return true; }
            if (id==='exhausted' || id==='flaky' && ++flaky<=2) { res.writeHead(503); res.end(); return true; }
            if (id==='json') { send(req,res,Buffer.from('{"message":"bad"}'),'application/json');return true; }
            if (id==='html') { send(req,res,Buffer.from('<!doctype html><html>invalid key</html>'),'application/octet-stream');return true; }
            send(req,res,id==='short'?a.subarray(1):id==='b'?b:a,'application/octet-stream'); return true;
        }
        if (assets.has(u.pathname)) {
            if (u.pathname === '/parts/flaky/0' && ++flakyMedia === 1) { res.writeHead(503);res.end();return true; }
            send(req,res,assets.get(u.pathname),u.pathname.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'application/octet-stream');
            return true;
        }
    });
    t.defer(site.close);
    const page = await browser.open(site.origin+'/view'), tab = await browser.tabId(site.origin+'/view');
    const panel = await browser.open(browser.url('sidebar.html?tabId='+tab));
    const keyGets = id => site.log.filter(r=>r.path===keyUrl(id)).length;
    async function run(name,expectedError) {
        const url = site.origin+'/'+name+'.m3u8';
        await page.eval('fetch('+JSON.stringify(url)+').then(r=>r.text())');
        const group = 'groups.find(g=>g.tracks.some(t=>t.record.url==='+JSON.stringify(url)+'))';
        assert.ok(await until(()=>panel.eval('!!('+group+')')),'missing playlist '+name);
        const row = 'rows.get(('+group+').key).node';
        const before = browser.files(), key = await panel.eval('choice('+group+').key');
        await panel.eval(row+'.querySelector(".download").click()');
        const job = await until(()=>panel.eval('mediaJobs.find(j=>j.key==='+JSON.stringify(key)+' && ["failed","done"].includes(j.state))'),22000);
        assert.ok(job,name);
        assert.equal(job.state,expectedError?'failed':'done',name+' '+job.error);
        assert.ok(await until(()=>panel.eval('(async()=>!(await Array.fromAsync((await (await navigator.storage.getDirectory()).getDirectoryHandle("snag-media-v1")).keys())).length)()')));
        if (expectedError) {
            assert.equal(job.error,expectedError);
            assert.deepEqual(browser.files(),before);
            const status = await panel.eval(row+'.querySelector(".download-state").textContent');
            assert.doesNotMatch(status,/\/keys\/|ticket|fixture-private|https?:\/\//);
            return job.sourceFailure;
        }
        const saved = await browser.download(before);
        assert.ok(browser.files().some(f=>!before.includes(f) && f.endsWith('.mp4')));
        return saved;
    }
    assert.deepEqual(await run('many'),reference);
    assert.equal(keyGets('shared'),1);
    t.check('116 个 AES 分片从序号 10 开始，共用密钥只读取一次，成品与明文重封装逐字节一致',true);
    checkFastStart(await run('mixed'),{width:1920,height:1080,frames:30,fps:60,seconds:0.5});
    assert.equal(keyGets('a'),1); assert.equal(keyGets('b'),1);
    assert.deepEqual(await run('flaky'),reference); assert.equal(flaky,3); assert.equal(flakyMedia,2);
    assert.deepEqual(await run('inline'),reference);
    t.check('加密初始化段、显式 IV、轮换和恢复明文可混排，单片密钥暂时失败后重试成功，内联密钥也可保存',true);
    for (const name of ['short','empty','unaligned','padding']) await run(name,'mediaBadFile');
    const forbidden = await run('forbidden','mediaSourceFailed');
    assert.deepEqual(forbidden,{stage:'mediaSegmentReadFailed',status:403});
    assert.equal((await run('json','mediaSourceFailed')).reason,'mediaUnexpectedResponse');
    assert.equal((await run('html','mediaSourceFailed')).reason,'mediaUnexpectedResponse');
    assert.equal((await run('exhausted','mediaSourceFailed')).status,503); assert.equal(keyGets('exhausted'),3);
    for (const name of ['sample','drm']) await run(name,'mediaProtected');
    assert.equal(keyGets('unread'),0); assert.ok(!site.log.some(r=>r.path==='/unread.ts'));
    t.check('无效密钥、密文、HTTP 403 和受保护清单在正确阶段终止，卡片隐藏密钥地址，OPFS 已清理',true);
}

async function checkDownloadQueue(browser,t,source) {
    const held = new Map();
    let retryGets = 0;
    const site = await serve((req,res,u) => {
        if (u.pathname === '/queue') return html(res,'<script>(async()=>{for(let n=1;n<=4;n++)await fetch("/job/"+n+".m3u8",{method:"HEAD"})})()</script>');
        if (u.pathname === '/retry.mp4' && ++retryGets === 1) { res.writeHead(410); res.end(); return true; }
        if (u.pathname === '/piece.ts') { send(req,res,source,'video/mp2t'); return true; }
        const list = Buffer.from('#EXTM3U\n#EXTINF:2,\n/piece.ts\n#EXT-X-ENDLIST');
        if (req.method === 'HEAD') { send(req,res,list,'application/vnd.apple.mpegurl'); return true; }
        if (u.pathname.startsWith('/job/') || u.pathname === '/retry.mp4') {
            held.set(u.pathname,() => {
                if (u.pathname === '/retry.mp4') { res.writeHead(410); res.end(); }
                else send(req,res,list,'application/vnd.apple.mpegurl');
            });
            res.once('close',()=>held.delete(u.pathname));
            return true;
        }
    });
    t.defer(site.close);
    const url = site.origin+'/queue', page = await browser.open(url), tab = await browser.tabId(url);
    const panel = await browser.open(browser.url('sidebar.html?tabId='+tab));
    assert.ok(await until(()=>panel.eval('typeof mediaCommand==="function" && !loading')));
    const list = () => panel.eval('mediaCommand("list").then(js=>js.filter(j=>j.tabId===tabId))');
    const request = (key,file) => ({key,tabId:tab,title:key,mode:'full',files:[{url:site.origin+file,kind:'video',ext:'mp4'}]});
    const command = (op,args) => panel.eval('mediaCommand('+JSON.stringify(op)+','+JSON.stringify(args)+')');
    const old = await command('start',{request:request('retry job','/retry.mp4')});
    assert.ok(await until(async()=>(await list()).some(j=>j.id===old.id && j.state==='failed' && j.expires>0)));
    assert.ok(await until(()=>panel.eval('groups.filter(g=>g.tracks.some(t=>t.record.url.includes("/job/"))).length===4')));
    const row = n => '([...rows.values()].find(r=>r.group.tracks.some(t=>t.record.url.endsWith("/job/'+n+'.m3u8"))).node)';
    const requestsSince = site.log.length;
    // Use the sidebar's real multi-select entry point and its visible FIFO order.
    const order = await panel.eval('document.querySelector("#multi").click();document.querySelector("#select-all").click();'+
        'visible.filter(g=>selections.has(g.key)).map(g=>Number(choice(g).record.name.split(".")[0]))');
    assert.equal(new Set(order).size,4);
    const [first,second,third,fourth] = order;
    const jobPath = n => '/job/'+n+'.m3u8';
    await panel.eval('document.querySelector("#save-selected").click()');
    const four = await until(async()=>{
        const jobs = (await list()).filter(j=>j.id!==old.id);
        return jobs.length===4 && held.size===2 && jobs;
    });
    assert.deepEqual(four.map(j=>j.state),['downloading','downloading','queued','queued']);
    assert.deepEqual(site.log.slice(requestsSince).map(r=>r.path).sort(),[jobPath(first),jobPath(second)].sort());
    assert.equal(four[2].expires,0); assert.equal(four[3].expires,0);
    const dirIds = () => panel.eval('(async()=>Array.fromAsync((await (await navigator.storage.getDirectory()).getDirectoryHandle("snag-media-v1")).keys()))()');
    assert.ok(!(await dirIds()).some(id=>id===four[2].id || id===four[3].id));
    assert.ok(await until(()=>panel.eval([third,fourth].map(n=>row(n)+'.querySelector(".download").disabled && '+
        row(n)+'.querySelector(".download").textContent===i18n.mediaQueued && '+row(n)+'.querySelector(".download-state button").textContent===i18n.mediaCancel').join(' && '))));
    await panel.eval('startMedia([...rows.values()].find(r=>r.node==='+row(third)+').group)');
    assert.equal((await list()).length,5,'a queued task is deduplicated');
    const retry = await command('retry',{id:old.id});
    assert.equal(retry.state,'queued'); assert.equal(retry.expires,0); assert.equal(retry.error,null); assert.equal(retry.sourceFailure,null);
    assert.equal(retryGets,1);
    const clear = await command('start',{request:request('remove waiting','/cleared.mp4')});
    assert.equal(clear.state,'queued'); await command('clear',{id:clear.id});
    await panel.eval(row(third)+'.querySelector(".download-state button").click()');
    assert.ok(await until(async()=>!(await list()).some(j=>j.id===four[2].id || j.id===clear.id)));
    for (const width of [320,740]) {
        await panel.send('Emulation.setDeviceMetricsOverride',{width,height:720,deviceScaleFactor:1,mobile:false});
        assert.ok(await panel.eval('document.documentElement.scrollWidth<=innerWidth && '+row(fourth)+'.querySelector(".download-state button").getBoundingClientRect().right<=innerWidth'));
    }
    const before = browser.files();
    held.get(jobPath(first))();
    assert.ok(await until(async()=>held.has(jobPath(fourth)) && (await list()).some(j=>j.id===four[0].id && j.state==='done')));
    assert.ok((await list()).some(j=>j.id===four[3].id && j.state==='downloading'));
    assert.equal(retryGets,1,'retried job waits behind the fourth submission');
    const last = await command('start',{request:request('after failed retry','/job/last.m3u8')});
    assert.equal(last.state,'queued');
    await command('cancel',{id:four[1].id});
    assert.ok(await until(()=>held.has('/retry.mp4')));
    held.get('/retry.mp4')();
    assert.ok(await until(()=>held.has('/job/last.m3u8')),'a failure also releases the next FIFO slot');
    await command('cancel',{id:last.id});
    held.get(jobPath(fourth))();
    assert.ok(await until(async()=>(await list()).some(j=>j.id===four[3].id && j.state==='done')), 'fourth saved');
    const files = browser.files().filter(name=>!before.includes(name));
    assert.ok(files.includes(fourth+'.mp4'));
    checkFastStart(require('node:fs').readFileSync(require('node:path').join(browser.downloads,fourth+'.mp4')),
        {width:160,height:90,frames:20,fps:10,seconds:2});
    assert.ok(!site.log.slice(requestsSince).some(r=>r.path===jobPath(third) || r.path==='/cleared.mp4'));
    assert.ok(!(await dirIds()).includes(four[3].id));
    await command('clear',{id:old.id});
    await panel.close(); await page.close();
    t.check('批量四个任务只启动两个，排队去重、取消和清除均不发请求；完成、取消和失败依次放行 FIFO 队首，第四个任务保存为可播放 MP4',true);
}

test('分片进度、有限重试和离屏任务清理',async t => {
    const source = fixture('segment.ts'), packets = source.length/188;
    const boundary = i => Math.floor(i*packets/116)*188;
    const parts = Array.from({length:116},(_,i) => Buffer.concat([source.subarray(boundary(i),boundary(i+1)),
        segment(i).subarray(source.length)])); // Unique TS packets in media order, with harmless per-part null padding.
    const expected = {width:160,height:90,frames:20,fps:10,seconds:2};
    const playlist = Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:1\n'+parts.map((_,i)=>'#EXTINF:1,\n/p/'+i+'.ts\n').join('')+'#EXT-X-ENDLIST\n');
    let phase = 'ordered', active = 0, peak = 0;
    const held = new Map(), attempts = new Map();
    const trackActive = {audio:0,video:0}, trackPeak = {audio:0,video:0};
    const site = await serve((req,res,url) => {
        if (url.pathname === '/watch') return html(res,'<script>fetch("/vod.m3u8").then(r=>r.text())</script>');
        if (url.pathname === '/chunked-watch') return html(res,'<script>fetch("/chunked.m3u8").then(r=>r.text())</script>');
        if (url.pathname === '/chunked.m3u8') {
            res.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl','Transfer-Encoding':'chunked'}); res.end(playlist);
            return true;
        }
        if (url.pathname === '/vod.m3u8') {
            const fresh = '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n/reissued.ts?token=fresh\n#EXT-X-ENDLIST';
            send(req,res,phase === 'refreshed' ? Buffer.from(fresh) : playlist,'application/vnd.apple.mpegurl');
            return true;
        }
        if (req.url === '/reissued.ts?token=fresh') { send(req,res,source,'video/mp2t'); return true; }
        if (url.pathname === '/pair.m3u8') {
            send(req,res,Buffer.from('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Main",DEFAULT=YES,URI="/pair/audio.m3u8"\n'+
                '#EXT-X-STREAM-INF:BANDWIDTH=100000,AUDIO="a"\n/pair/video.m3u8'),'application/vnd.apple.mpegurl');
            return true;
        }
        const pair = /^\/pair\/(audio|video)(?:\.m3u8|\/(\d+)\.ts)$/.exec(url.pathname);
        if (pair) {
            const [,kind,index] = pair;
            if (index == null) {
                const media = parts.slice(0,8).map((_,i)=>'#EXTINF:1,\n/pair/'+kind+'/'+i+'.ts\n').join('');
                send(req,res,Buffer.from('#EXTM3U\n'+media+'#EXT-X-ENDLIST'), 'application/vnd.apple.mpegurl');
            } else {
                trackPeak[kind] = Math.max(trackPeak[kind],++trackActive[kind]);
                const key = kind+index;
                res.once('close',()=>{ trackActive[kind]--; held.delete(key); });
                held.set(key,() => {
                    if (key === 'video0') { res.writeHead(410); res.end(); }
                    else send(req,res,parts[Number(index)],'video/mp2t');
                });
            }
            return true;
        }
        const match = /^\/p\/(\d+)\.ts$/.exec(url.pathname);
        if (!match) return;
        const i = Number(match[1]), attempt = (attempts.get(i) || 0)+1;
        attempts.set(i,attempt); peak = Math.max(peak,++active);
        res.once('close',() => { active--; held.delete(i); });
        const deliver = () => send(req,res,parts[i],'video/mp2t');
        if (i < 8) held.set(i,() => {
            if (phase === 'gone' && i === 2) { res.writeHead(410); res.end(); } else deliver();
        });
        else if (phase === 'ordered' && i === 8 && attempt <= 2) {
            res.writeHead(attempt === 1 ? 503 : 429,{'Retry-After':'0'}); res.end();
        } else if (phase === 'ordered' && i === 9 && attempt === 1) {
            res.writeHead(200,{'Content-Type':'video/mp2t','Content-Length':parts[i].length});
            res.write(parts[i].subarray(0,100)); setTimeout(()=>res.destroy(),15);
        } else deliver();
        return true;
    });
    t.defer(site.close);
    const b = await launch(); t.defer(b.close);
    await b.open(site.origin+'/watch');
    const tab = await b.tabId('/watch'), regularPanel = await b.open(b.url('sidebar.html?tabId='+tab));
    let panel = regularPanel;
    const card = 'document.querySelector("#cards .resource")', button = card+'.querySelector(".download")';
    const start = async () => {
        assert.ok(await until(()=>panel.eval(button+' && !'+button+'.disabled')));
        attempts.clear(); await panel.eval(button+'.click()');
        assert.ok(await until(()=>held.has(0) && held.has(1) && held.has(2) && held.has(3)),'first concurrent window');
    };
    const dirs = () => panel.eval('(async()=>Array.fromAsync((await (await navigator.storage.getDirectory()).getDirectoryHandle("snag-media-v1")).keys()))()');
    const rules = () => b.sw.eval('chrome.declarativeNetRequest.getSessionRules().then(rs=>rs.filter(r=>r.condition.tabIds?.includes(-1) && isMediaRuleId(r.id)).map(r=>r.id))');
    const before = b.files();
    await start();
    const liveRules = await rules();
    assert.ok(liveRules.length,'offscreen rules on four pending requests');
    await b.sw.eval('chrome.declarativeNetRequest.updateSessionRules({addRules:[{id:987654321,action:{type:"allow"},condition:{tabIds:[987654321],resourceTypes:["image"]}}]}).then(()=>clearRedundant())');
    assert.ok(await until(()=>b.sw.eval('chrome.declarativeNetRequest.getSessionRules().then(rs=>!rs.some(r=>r.id===987654321))')));
    assert.deepEqual((await rules()).sort(),liveRules.sort());
    t.check('清理已关闭标签页的规则时保留了正在传输任务的真实离屏规则',true);
    for (const i of [3,2,1]) held.get(i)();
    assert.ok(await until(()=>held.has(4),3000),'request 4 must start while request 0 is still blocked');
    assert.ok(await until(()=>held.has(5),3000));
    assert.ok(held.has(0));
    assert.ok(await until(()=>panel.eval('mediaJobs.some(j=>j.completedParts===0 && j.bytes==='+[1,2,3].reduce((n,i)=>n+parts[i].length,0)+')')),
        'staged bytes are visible while the first segment still blocks ordered completion');
    const staged = await panel.eval('(async()=>{const root=await (await navigator.storage.getDirectory()).getDirectoryHandle("snag-media-v1");'+
        'const [job]=await Array.fromAsync(root.values());const dir=await job.getDirectoryHandle("parts-0");return Array.fromAsync(dir.keys())})()');
    // Chromium can expose the transactional .crswap backing file of an open OPFS writer alongside its empty target.
    for (const file of staged) assert.match(file,/^[0-5](?:\.crswap)?$/,'outside the uncommitted window');
    assert.deepEqual(staged.filter(file=>/^\d+$/.test(file)).sort(),['0','1','2','3','4','5']);
    assert.ok(!attempts.has(6));
    held.get(0)();
    assert.ok(await until(()=>held.has(7)));
    const progress = await until(async () => (await panel.eval('mediaJobs')).find(j=>j.completedParts===4));
    assert.ok(progress && progress.totalParts===116 && progress.total===0 && progress.bytes>playlist.length);
    for (const width of [320,740]) {
        await panel.send('Emulation.setDeviceMetricsOverride',{width,height:700,deviceScaleFactor:1,mobile:false});
        assert.ok(await until(()=>panel.eval(button+'.textContent.includes("4/116") && '+button+'.textContent.includes("3%") && '+
            card+'.querySelector(".download-state").textContent.includes(bytes('+progress.bytes+')) && '+
            'document.documentElement.scrollWidth<=innerWidth && '+button+'.getBoundingClientRect().right<=innerWidth')));
        await panel.eval('selectFilter("image")');
        assert.ok(await panel.eval('document.querySelector("#media-tasks .task-item").textContent.includes(bytes('+progress.bytes+')) && '+
            'document.documentElement.scrollWidth<=innerWidth'));
        await panel.eval('selectFilter("video")');
    }
    for (const i of [6,5,4,7]) held.get(i)();
    const ordered = await b.download(before,35000);
    checkFastStart(ordered,expected);
    assert.ok(b.files().some(name=>!before.includes(name) && name.endsWith('.mp4')));
    assert.equal(peak,4); assert.equal(attempts.get(8),3); assert.equal(attempts.get(9),2);
    assert.ok(await until(async () => !(await dirs()).length && !(await rules()).length));
    t.check('第 0 片等待第 4 片发出，116 片经过乱序响应、503、429 和半片断流后保存完整音画',true);

    phase = 'chunked';
    await b.open(site.origin+'/chunked-watch');
    panel = await b.open(b.url('sidebar.html?tabId='+await b.tabId('/chunked-watch')));
    await start();
    assert.ok(await panel.eval('groups.some(g=>g.tracks.some(t=>t.record.url.endsWith("/chunked.m3u8") && !t.record.size))'));
    for (const i of [0,1,2,3]) held.get(i)();
    assert.ok(await until(()=>held.has(7) && panel.eval(button+'.textContent.includes("4/116")')));
    await panel.eval('mediaCommand("list").then(js=>mediaCommand("cancel",{id:js.find(j=>activeJob(j)).id}))');
    assert.ok(await until(async () => active===0 && !(await dirs()).length && !(await rules()).length));
    t.check('没有清单 Content-Length 时使用相同的进度，取消会终止在途请求并释放 OPFS 文件',true);
    phase = 'gone';
    panel = regularPanel;
    const savedFiles = b.files();
    await start(); held.get(2)();
    const failed = await until(async () => (await panel.eval('mediaJobs')).find(j=>j.state==='failed'));
    assert.equal(failed?.sourceFailure?.status,410);
    assert.ok(await until(async () => active===0 && !(await dirs()).length && !(await rules()).length));
    assert.equal(attempts.get(2),1); assert.equal(attempts.size,4);
    assert.deepEqual(b.files(),savedFiles);
    t.check('分片 410 只请求一次，其他在途分片停止，失败卡片保留状态码且没有不完整的成品',true);
    phase = 'refreshed';
    await panel.eval('mediaCommand("retry",{id:'+JSON.stringify(failed.id)+'})');
    const reference = await b.download(savedFiles,15000);
    checkFastStart(reference,expected);
    assert.deepEqual(ordered,reference,'all 116 chunks must remux to the same bytes as the original ordered TS');
    assert.ok(await until(async () => !(await dirs()).length && !(await rules()).length));
    t.check('其他任务重试会重读原清单，完整样片与 116 片顺序提交后的 MP4 逐字节一致',true);

    const pair = {tabId:tab,key:'paired-slots',mode:'full',title:'Paired slots',
        files:[{kind:'video',playlist:'hls',url:site.origin+'/pair.m3u8'}]};
    const job = await panel.eval('mediaCommand("start",{request:'+JSON.stringify(pair)+'})');
    assert.ok(await until(()=>['audio0','audio1','video0','video1'].every(key=>held.has(key))));
    held.get('audio1')(); held.get('video1')();
    assert.ok(await until(()=>held.has('video2') && held.has('audio2')),'both tracks slide independently');
    held.get('video0')();
    assert.ok(await until(()=>panel.eval('mediaJobs.some(j=>j.id==='+JSON.stringify(job.id)+' && j.state==="failed" && j.sourceFailure?.status===410)')));
    assert.deepEqual(trackPeak,{video:2,audio:2});
    assert.ok(await until(async()=>held.size===0 && !(await dirs()).length && !(await rules()).length));
    t.check('双轨各用两个并发槽独立补位，画轨失败会中止两轨在途请求并清空暂存',true);
    await checkEncryptedDownloads(b,t,source,parts,reference);
    await checkDownloadQueue(b,t,source);
});
