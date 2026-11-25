'use strict';

const assert = require('node:assert/strict');
const {launch,serve,send,html,segment,until,test} = require('./lib/harness');

test('分片进度、有限重试和离屏任务清理',async t => {
    const parts = Array.from({length:116},(_,i) => segment(i));
    const playlist = Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:1\n'+parts.map((_,i)=>'#EXTINF:1,\n/p/'+i+'.ts\n').join('')+'#EXT-X-ENDLIST\n');
    let phase = 'ordered', active = 0, peak = 0;
    const held = new Map(), attempts = new Map();
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
        if (req.url === '/reissued.ts?token=fresh') { send(req,res,parts[2],'video/mp2t'); return true; }
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
    for (const i of [3,2,1,0]) held.get(i)();
    assert.ok(await until(()=>held.has(7)));
    const progress = await until(async () => (await panel.eval('mediaJobs')).find(j=>j.completedParts===4));
    assert.ok(progress && progress.totalParts===116 && progress.total===0 && progress.bytes>playlist.length);
    for (const width of [320,740]) {
        await panel.send('Emulation.setDeviceMetricsOverride',{width,height:700,deviceScaleFactor:1,mobile:false});
        assert.ok(await until(()=>panel.eval(button+'.textContent.includes("4/116") && '+button+'.textContent.includes("3%") && '+
            'document.documentElement.scrollWidth<=innerWidth && '+button+'.getBoundingClientRect().right<=innerWidth')));
    }
    for (const i of [6,5,4,7]) held.get(i)();
    assert.deepEqual(await b.download(before,35000),Buffer.concat(parts));
    assert.equal(peak,4); assert.equal(attempts.get(8),3); assert.equal(attempts.get(9),2);
    assert.ok(await until(async () => !(await dirs()).length && !(await rules()).length));
    t.check('116 片按完成数显示真实进度，四路乱序到达、503、429 及半片断流后成品仍逐字节一致',true);

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
    assert.deepEqual(await b.download(savedFiles,10000),parts[2]);
    t.check('手动重试重新读取原清单并使用其新声明的分片地址，保存结果与新版本一致',true);
});
