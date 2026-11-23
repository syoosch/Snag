'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const {launch, fixture, intercept, until, test} = require('./lib/harness');

const {boxes, videoCodec, pictureInfo} = require('./lib/mp4');

// Split real fragmented MP4s at their advertised box lengths, just as a player
// can pass initialization and media chunks to separate MSE buffers.
function fragments(bytes) {
    const parts = [];
    for (const box of boxes(bytes)) {
        if (box.name === 'mfra') break;
        if (!parts.length || box.name === 'moof') parts.push([]);
        parts.at(-1).push(box.data);
    }
    return parts.map(group => Buffer.concat(group));
}
// This fixture uses the browser's real player and SourceBuffer APIs. Its
// controlled HTTP responses stand in for the site's normal playback traffic.
function playerPage(id,scenario) {
    const adaptive = {itag:299,mimeType:'video/mp4; codecs="avc1.4d402a"',height:1080,fps:60,qualityLabel:'1080p60'};
    const duration = scenario.startsWith('long') ? 12 : 3;
    const response = {playabilityStatus:{status:'OK'},videoDetails:{videoId:id,lengthSeconds:String(duration)},
        streamingData:{formats:[{url:'https://test.googlevideo.com/videoplayback?file=low',qualityLabel:'360p',height:360,fps:30,
            mimeType:'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',audioQuality:'AUDIO_QUALITY_LOW'}],adaptiveFormats:[adaptive,
            {itag:140,mimeType:'audio/mp4; codecs="mp4a.40.2"'}]}};
    if (scenario === 'original') delete response.streamingData.adaptiveFormats;
    return '<!doctype html><meta charset="utf-8"><title>高清动态测试片</title><div id="movie_player"><video muted class="html5-main-video"></video>'+
        '<div class="ytp-settings-menu"><div class="ytp-menuitem"><span class="ytp-menuitem-label">Quality</span>'+
        '<span class="ytp-menuitem-content">1080p60 HD</span></div></div></div><script>('+fixturePlayer+')('+
        JSON.stringify(response)+','+JSON.stringify(scenario)+');</script>';
}

// Executed in the simulated watch page, never in the extension.
function fixturePlayer(response,scenario) {
    const player = document.querySelector('#movie_player'), video = player.querySelector('video'), source = new MediaSource();
    player.getPlayerResponse = () => response;
    player.getVideoData = () => ({video_id:response.videoDetails.videoId});
    player.setPlaybackQualityRange = q => { window.requested = q; };
    const webm = scenario === 'webm';
    const chosenTier = webm ? new Promise(resolve => {
        const button = document.createElement('button'), menu = player.querySelector('.ytp-settings-menu');
        button.className = 'ytp-settings-button';
        button.setAttribute('aria-expanded','false');
        player.append(button);
        menu.hidden = true;
        button.onclick = () => { button.setAttribute('aria-expanded','true'); menu.hidden = false; };
        menu.querySelector('.ytp-menuitem').onclick = () => {
            menu.classList.add('ytp-quality-menu');
            menu.innerHTML = '<button class="ytp-menuitem"><span class="ytp-menuitem-label">1080p</span></button>'+
                '<button class="ytp-menuitem"><span class="ytp-menuitem-label">1080p<sup>60</sup> HD</span></button>';
            menu.lastElementChild.onclick = () => { menu.hidden = true; resolve(); };
        };
    }) : Promise.resolve();
    async function appendTrack(kind,type) {
        const buffer = source.addSourceBuffer(type);
        async function load(query) {
            const parts = await fetch('/parts/'+kind+query).then(r=>r.json());
            for (const str of parts) {
                const bytes = Uint8Array.from(atob(str),c=>c.charCodeAt(0));
                await new Promise((resolve,reject) => {
                    buffer.addEventListener('updateend',resolve,{once:true});
                    buffer.addEventListener('error',reject,{once:true});
                    buffer.appendBuffer(bytes);
                });
            }
        }
        await load('');
        if (scenario === 'long') {
            if (video.currentTime<4) await new Promise(resolve=>video.addEventListener('seeked',resolve,{once:true}));
            await load('?next');
        }
    }
    source.onsourceopen = async () => {
        try {
            source.duration = Number(response.videoDetails.lengthSeconds);
            await chosenTier;
            const tracks = [appendTrack('video',webm ? 'video/webm; codecs="vp9"' : 'video/mp4; codecs="avc1.4d402a"')];
            if (scenario !== 'missing-audio') tracks.push(appendTrack('audio',webm ? 'audio/webm; codecs="opus"' : 'audio/mp4; codecs="mp4a.40.2"'));
            await Promise.all(tracks);
            if (scenario !== 'pending') source.endOfStream();
        } catch (error) { window.fixtureError = String(error); }
    };
    video.src = URL.createObjectURL(source);
}

test('YouTube 高清分段、原声与清理',async t => {
    const id = 'segmented01';
    const fullPicture = fragments(fixture('youtube-picture.m4s')), fullSound = fragments(fixture('youtube-sound.m4s'));
    const picture = fullPicture.slice(0,7), sound = fullSound.slice(0,7);
    const slow = fragments(fixture('youtube-30.m4s'));
    function clusters(name) {
        const bytes = fixture(name), mark = Buffer.from([0x1f,0x43,0xb6,0x75]), positions = [0];
        for (let at=bytes.indexOf(mark); at>=0; at=bytes.indexOf(mark,at+4)) positions.push(at);
        positions.push(bytes.length);
        return positions.slice(1).map((end,i)=>bytes.subarray(positions[i],end));
    }
    const webmPicture = clusters('youtube-picture.webm'), webmSound = clusters('youtube-sound.webm');
    assert.ok(picture.length > 4 && sound.length > 4);
    const b = await launch(); t.defer(b.close);
    const page = await b.open('about:blank');
    const lowRequests = [], nextRequests = new Set();
    const response = scenario => u => {
        if (u.pathname === '/watch') return ['text/html',playerPage(id,scenario)];
        if (u.pathname.startsWith('/parts/')) {
            let parts = u.pathname.endsWith('audio') ? sound : picture;
            if (scenario.startsWith('long')) {
                parts = parts === picture ? fullPicture : fullSound;
                if (scenario === 'long') {
                    if (u.searchParams.has('next')) nextRequests.add(u.pathname);
                    parts = u.searchParams.has('next') ? parts.slice(16) : parts.slice(0,16);
                }
            }
            if (scenario === 'wrong-rate' && parts === picture) parts = slow;
            if (scenario === 'webm') parts = parts === picture ? webmPicture : webmSound;
            if (scenario === 'pending' || scenario === 'truncated') parts = parts.slice(0,3);
            return ['application/json',JSON.stringify(parts.map(data=>data.toString('base64')))];
        }
        if (u.searchParams.has('file')) lowRequests.push(u.href);
        return ['text/plain','',404];
    };
    let originalScenario = 'original';
    await intercept(page,['*'],u=>response(originalScenario)(u));
    await page.send('Page.navigate',{url:'https://www.youtube.com/watch?v='+id});
    assert.ok(await until(()=>page.eval('document.querySelector("video")?.videoHeight === 1080')),'fixture HD playback');
    const original = await b.tabId('watch?v='+id);
    const panel = await b.open(b.url('sidebar.html?tabId='+original));
    const card = 'document.querySelector("#cards .resource")';
    const selectable = await until(()=>panel.eval(card+'?.querySelector(".download")?.textContent.includes("1080p60")'));
    assert.ok(selectable,JSON.stringify([await panel.eval('document.body.innerText'),panel.errors]));
    assert.ok(await panel.eval('[...'+card+'.querySelector(".quality-tier").options].some(o=>o.value==="1080p60"&&!o.disabled)'));
    const field = selector => card+'.querySelector('+JSON.stringify(selector)+')';
    assert.deepEqual(await panel.eval('['+field('.file-format')+'.textContent,'+field('.file-size')+'.textContent,'+field('.codec-value')+'.textContent]'),['MP4','—','—']);
    const descriptions = [
        {height:1080,fps:60,itag:299,qualityLabel:'1080p60',mimeType:'video/mp4; codecs="avc1.4d402a"',contentLength:'1048576'},
        {height:1080,fps:60,itag:303,qualityLabel:'1080p60',mimeType:'video/webm; codecs="vp09.00.41.08"',contentLength:'2097152'},
        {itag:140,mimeType:'audio/mp4; codecs="mp4a.40.2"',contentLength:'1024'}
    ];
    await page.eval('movie_player.getPlayerResponse().streamingData.adaptiveFormats='+JSON.stringify(descriptions)+';document.dispatchEvent(new Event("yt-navigate-finish"))');
    assert.ok(await until(()=>panel.eval(field('.file-size')+'.textContent===i18n("sideEstimatedSize","1–2 MB")')));
    assert.ok(await panel.eval(field('.encoding-options')+'.hidden && '+field('.codec-value')+'.textContent==="—"'));
    await page.eval('delete movie_player.getPlayerResponse().streamingData.adaptiveFormats;document.dispatchEvent(new Event("yt-navigate-finish"))');
    t.check('只有播放器提供版本说明时可显示大小范围，不能指定的编码不会出现选择箭头',true);
    t.check('仅有 360p 整文件时，侧栏自动选中可下载的 1080p60 分段',true);
    await page.eval('document.querySelector(".ytp-menuitem-content").textContent="720p"');
    assert.ok(await until(()=>panel.eval(card+'?.querySelector(".download")?.textContent.includes("720p") && '+
        card+'?.querySelector(".playback-quality")?.textContent.includes("1080p")')));
    await page.eval('document.querySelector(".ytp-menuitem-content").textContent="1080p60 HD"');
    assert.ok(await until(()=>panel.eval(card+'?.querySelector(".download")?.textContent.includes("1080p60")')));
    t.check('网页刚切档时，下载按钮跟随所选版本，播放标签保留当前已解码的分辨率',true);

    // Hold navigation only until CDP has installed the isolated test responses.
    await b.sw.eval('globalThis.nativeUpdate=chrome.tabs.update.bind(chrome.tabs);chrome.tabs.update=async(id,opts)=>{'+
        'if(opts.url?.includes("#snag-segments="))await new Promise(ok=>{globalThis.heldHelper=id;globalThis.releaseHelper=ok});return nativeUpdate(id,opts)}');
    const jobs = () => panel.eval('mediaCommand("list")');
    async function begin(scenario) {
        for (const job of await jobs()) if (job.state === 'done') await panel.eval('mediaCommand("clear",{id:'+JSON.stringify(job.id)+'})');
        assert.ok(await until(()=>panel.eval(card+'?.querySelector(".download")?.textContent.includes("1080p60")')));
        await b.sw.eval('globalThis.heldHelper=null');
        const before = await b.pages(/.*/), active = await b.sw.eval('chrome.tabs.query({active:true,lastFocusedWindow:true}).then(a=>a[0]?.id)');
        await panel.eval(card+'.querySelector(".download").click()');
        const helperId = await until(()=>b.sw.eval('globalThis.heldHelper'));
        assert.ok(helperId,JSON.stringify(await jobs()));
        const tab = await b.sw.eval('chrome.tabs.get('+helperId+')');
        assert.equal(tab.active,false);
        assert.equal(await b.sw.eval('chrome.tabs.query({active:true,lastFocusedWindow:true}).then(a=>a[0]?.id)'),active);
        const target = await b.waitPage(/^about:blank#snag-segments=/,before);
        assert.ok(target);
        const helper = await b.attach(target.targetId);
        await intercept(helper,['*'],response(scenario));
        await b.sw.eval('releaseHelper()');
        return {helperId,helper};
    }
    async function cleaned(helperId) {
        assert.ok(await until(()=>b.sw.eval('chrome.tabs.get('+helperId+').then(()=>false,()=>true)')),'temporary tab closed');
        assert.ok(await until(()=>b.sw.eval('chrome.storage.local.get(null).then(v=>!Object.keys(v).some(k=>k.startsWith("snag-youtube-job-")))')),'temporary tab record removed');
        assert.ok(await until(()=>panel.eval('(async()=>{const root=await navigator.storage.getDirectory();for await(const [n,d] of root.entries())'+
            '{if(d.kind==="directory" && n.startsWith("snag"))for await(const k of d.keys())if(k.startsWith("job-"))return false;}return true;})()')),'temporary files removed');
    }
    const before = b.files(), {helperId} = await begin('normal');
    const saved = await b.download(before,20000);
    assert.ok(saved,JSON.stringify([await jobs(),panel.errors]));
    assert.deepEqual(pictureInfo(saved),{frames:180,fps:60,seconds:3});
    const decoded = await page.eval('(async()=>{const bytes=Uint8Array.from(atob('+JSON.stringify(saved.toString('base64'))+'),c=>c.charCodeAt(0));'+
        'const url=URL.createObjectURL(new Blob([bytes],{type:"video/mp4"}));const v=document.createElement("video");'+
        'try {const ready=new Promise((ok,fail)=>{v.onloadedmetadata=ok;v.onerror=fail});v.src=url;await ready;'+
        'const ctx=new OfflineAudioContext(1,48000,48000);const a=(await ctx.decodeAudioData(bytes.buffer)).getChannelData(0);let peaks=0;'+
        'let energy=0;for(let i=4801;i<52801;i++){energy+=a[i]*a[i];if(a[i-1]<=0&&a[i]>0)peaks++;}return [v.videoWidth,v.videoHeight,peaks,energy];}finally{URL.revokeObjectURL(url);}})()');
    assert.deepEqual(decoded.slice(0,2),[1920,1080]);
    assert.ok(await until(()=>panel.eval(field('.file-size')+'.textContent===bytes('+saved.length+') && '+field('.codec-value')+'.textContent==="H.264"')));
    assert.ok(Math.abs(decoded[2]-440)<=2 && decoded[3]>1,JSON.stringify(decoded));
    assert.equal(await page.eval('document.querySelector("video").currentTime'),0);
    assert.deepEqual(lowRequests,[]);
    await cleaned(helperId);
    t.check('保存文件实际解码为 1920×1080、180 帧 / 3 秒，有可解码的测试音，原页播放位置未动',true);
    await page.eval('document.querySelector(".ytp-settings-menu").remove();document.dispatchEvent(new Event("yt-navigate-finish"))');
    const beforeWebm = b.files(), webm = await begin('webm');
    const webmFile = await b.download(beforeWebm,16000);
    assert.ok(webmFile,JSON.stringify(await jobs()));
    const webmInfo = pictureInfo(webmFile);
    assert.equal(webmInfo.frames,180);
    assert.ok(Math.abs(webmInfo.fps-60)<0.1);
    await cleaned(webm.helperId);
    t.check('关闭网页画质菜单后仍选中 1080p60，分段的 VP9 画面与 Opus 音轨也能合并',true);
    for (const scenario of ['missing-audio','truncated','wrong-rate','pending']) {
        const before = b.files(), {helperId} = await begin(scenario);
        if (scenario === 'pending') {
            const job = await until(async()=>(await jobs()).find(j=>j.segmentProgress>0 && j.state==='downloading'));
            assert.ok(job,JSON.stringify(await jobs()));
            await panel.eval('mediaCommand("cancel",{id:'+JSON.stringify(job.id)+'})');
        } else {
            const job = await until(async()=>(await jobs()).findLast(j=>j.state==='failed'),9000);
            const expected = {'missing-audio':'mediaNoAudio',truncated:'mediaSegmentIncomplete','wrong-rate':'mediaSegmentQuality'};
            assert.equal(job?.error,expected[scenario],JSON.stringify(await jobs()));
            await panel.eval('mediaCommand("clear",{id:'+JSON.stringify(job.id)+'})');
        }
        await cleaned(helperId);
        assert.deepEqual(b.files(),before);
        t.check(scenario+' 未留下成品、分段或临时标签页',true);
    }
    const host = await b.attach((await b.targets()).find(target=>target.url===b.url('media-host.html')).targetId);
    const origin = 'https://manifest.googlevideo.com', fetched = [];
    const lists = {video:picture,audio:sound,vp9:webmPicture};
    const webmSet = '<AdaptationSet mimeType="video/webm" contentType="video"><Representation id="vp9" width="1920" height="1080" frameRate="60" codecs="vp09.00.41.08" bandwidth="54000">'+
        '<SegmentList timescale="2" duration="1"><Initialization sourceURL="/vp9/0"/>'+
        webmPicture.slice(1).map((_,i)=>'<SegmentURL media="/vp9/'+(i+1)+'"/>').join('')+'</SegmentList></Representation></AdaptationSet>';
    const mpd = '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT3S" minBufferTime="PT1S"><Period>'+
        ['video','audio'].map(kind=>'<AdaptationSet mimeType="'+kind+'/mp4" contentType="'+kind+'">'+
            (kind==='video'?'<Representation id="thirty" bandwidth="9999999" width="1920" height="1080" frameRate="30" codecs="avc1.4d402a"><SegmentList duration="3"><SegmentURL media="/wrong"/></SegmentList></Representation>':'')+
            '<Representation id="'+kind+'" bandwidth="64000" '+(kind==='video'?'width="1920" height="1080" frameRate="60" codecs="avc1.4d402a"':'codecs="mp4a.40.2"')+'>'+
            '<SegmentList timescale="2" duration="1"><Initialization sourceURL="/'+kind+'/0"/>'+
            lists[kind].slice(1).map((_,i)=>'<SegmentURL media="/'+kind+'/'+(i+1)+'"/>').join('')+
            '</SegmentList></Representation></AdaptationSet>').join('')+webmSet+'</Period></MPD>';
    const fromManifest = u=>{
        if (u.pathname === '/master.mpd') return ['application/dash+xml',mpd];
        if (u.pathname === '/master.m3u8') return ['application/vnd.apple.mpegurl',[
            '#EXTM3U','#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="main",NAME="Sound",DEFAULT=YES,URI="/audio.m3u8"',
            '#EXT-X-STREAM-INF:BANDWIDTH=9999999,RESOLUTION=1920x1080,FRAME-RATE=30,AUDIO="main"','/wrong',
            '#EXT-X-STREAM-INF:BANDWIDTH=97000,RESOLUTION=1920x1080,FRAME-RATE=60,CODECS="vp09.00.41.08,mp4a.40.2",AUDIO="main"','/video.m3u8?declared=vp9',
            '#EXT-X-STREAM-INF:BANDWIDTH=70000,RESOLUTION=1920x1080,FRAME-RATE=60,CODECS="avc1.4d402a,mp4a.40.2",AUDIO="main"','/video.m3u8'].join('\n')];
        const name = u.pathname.slice(1).split(/[./]/)[0], parts = lists[name];
        if (parts && u.pathname.endsWith('.m3u8')) return ['application/vnd.apple.mpegurl',[
            '#EXTM3U','#EXT-X-TARGETDURATION:1','#EXT-X-MAP:URI="/'+name+'/0"',
            ...parts.slice(1).map((_,i)=>'#EXTINF:0.5,\n/'+name+'/'+(i+1)),'#EXT-X-ENDLIST'].join('\n')];
        return parts ? ['application/octet-stream',parts[Number(u.pathname.split('/').pop())]] : ['text/plain','',404];
    };
    const inspected = [];
    await intercept(panel,[origin+'/*'],u=>{inspected.push(u.pathname); return fromManifest(u);});
    await intercept(host,[origin+'/*'],u=>{fetched.push(u.pathname+u.search); return fromManifest(u);});
    const chooseCodec = codec => panel.eval('(()=>{const s='+field('.encoding')+';s.value=[...s.options].find(o=>o.value.endsWith(":"+'+JSON.stringify(codec)+')).value;s.dispatchEvent(new Event("change"));})()');
    for (const type of ['hls','dash']) {
        const url = origin+(type==='hls'?'/master.m3u8':'/master.mpd');
        await page.eval('(()=>{const p=document.getElementById("movie_player"),r=p.getPlayerResponse();'+
            'delete r.streamingData.hlsManifestUrl;delete r.streamingData.dashManifestUrl;r.streamingData.'+type+'ManifestUrl='+JSON.stringify(url)+
            ';p.getPlayerResponse=()=>r;document.dispatchEvent(new Event("yt-navigate-finish"));})()');
        assert.ok(await until(()=>panel.eval('[...rows.values()].some(r=>!r.group.playerOnly&&choice(r.group).segments?.manifests?.[0]?.playlist==='+JSON.stringify(type)+')')));
        assert.ok(await until(()=>panel.eval('!'+field('.encoding-options')+'.hidden && [...'+field('.encoding')+'.options].some(o=>o.value.endsWith(":VP9"))')));
        assert.ok(inspected.every(p=>p.startsWith('/master.')),'catalog must only read master playlists');
        const codec = type==='hls' ? 'H.264' : 'VP9';
        await chooseCodec(codec);
        assert.equal(await panel.eval(field('.encoding-current')+'.textContent'),codec);
        assert.ok(await panel.eval(field('.file-size')+'.textContent.includes(i18n("sideEstimatedSize","").trim()) && '+field('.file-size')+'.textContent!=="—"'));
        assert.ok(await panel.eval(field('.quality-tier')+'.selectedOptions[0].text.includes('+field('.file-size')+'.textContent) && '+
            field('.quality-tier')+'.selectedOptions[0].text.includes("MP4")'));
        for (const [width,theme] of [[280,'dark'],[430,'light']]) {
            await panel.send('Emulation.setDeviceMetricsOverride',{width,height:520,deviceScaleFactor:1,mobile:false});
            await panel.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});
            assert.ok(await panel.eval('(()=>{const s='+field('.encoding')+';s.focus();return document.activeElement===s && s.getBoundingClientRect().height>0 && '+
                'document.documentElement.scrollWidth<=document.documentElement.clientWidth && [...'+card+'.querySelectorAll("dd")].every(d=>d.scrollWidth<=d.clientWidth)})()'));
            const layout = await panel.eval('(()=>{const specs='+field('.file-specs')+';return {height:specs.getBoundingClientRect().height,'+
                'stacked:[...specs.children].every(cell=>cell.querySelector("dd").getBoundingClientRect().top>=cell.querySelector("dt").getBoundingClientRect().bottom-1),'+
                'hit:'+field('.encoding')+'.getBoundingClientRect().height,'+
                'belowLabel:'+field('.encoding')+'.getBoundingClientRect().top>='+field('.codec-label')+'.getBoundingClientRect().bottom-1}})()');
            assert.ok(layout.stacked && layout.hit>=24 && layout.belowLabel,JSON.stringify({width,layout}));
            if (width===430) assert.ok(layout.height<=43 && layout.height>=36,JSON.stringify(layout));
            await panel.eval(field('.encoding')+'.blur()');
        }
        if (process.env.SNAG_PREVIEW && type==='hls') {
            await panel.eval('document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))');
            const image = await panel.send('Page.captureScreenshot',{format:'png'});
            fs.writeFileSync(process.env.SNAG_PREVIEW,Buffer.from(image.data,'base64'));
        }
        fetched.length=0;
        const before = b.files();
        await panel.eval(card+'.querySelector(".download").click()');
        const output = await b.download(before,12000);
        assert.ok(output,JSON.stringify([type,await jobs(),fetched]));
        const info = pictureInfo(output);
        assert.ok(info.frames===180 && Math.abs(info.fps-60)<0.1,JSON.stringify({type,info,fetched}));
        assert.equal(videoCodec(output),type==='hls'?'avc1':'vp09');
        assert.ok(fetched.includes('/audio/1') && fetched.includes(type==='hls'?'/video/1':'/vp9/1') &&
            !fetched.includes('/video.m3u8?declared=vp9') && !fetched.includes('/wrong'));
        const job = await until(async()=>(await jobs()).find(j=>j.state==='done'));
        assert.deepEqual(job.result,{size:output.length,ext:'mp4',codec});
        await panel.eval('mediaCommand("clear",{id:'+JSON.stringify(job.id)+'})');
        t.check(type+' 按选定编码和 60 帧下载，成品的编码、声音和字节数均已核对',true);
        if (type==='hls') {
            await chooseCodec('VP9');
            const beforeMismatch = b.files();
            await panel.eval(field('.download')+'.click()');
            const failure = await until(async()=>(await jobs()).find(j=>j.state==='failed'));
            assert.equal(failure?.error,'mediaCodecUnavailable');
            assert.deepEqual(b.files(),beforeMismatch);
            await panel.eval('mediaCommand("clear",{id:'+JSON.stringify(failure.id)+'})');
            t.check('清单错报编码时没有保存错误版本',true);
        }
    }
    originalScenario = 'long-original';
    await page.send('Page.reload');
    assert.ok(await until(()=>panel.eval('[...rows.values()].some(r=>!r.group.playerOnly&&choice(r.group).segments?.duration>11)')));
    const beforeLong = b.files(), longer = await begin('long');
    const entire = await b.download(beforeLong,22000);
    assert.ok(entire,JSON.stringify(await jobs()));
    assert.deepEqual(pictureInfo(entire),{frames:720,fps:60,seconds:12});
    assert.deepEqual([...nextRequests].sort(),['/parts/audio','/parts/video']);
    assert.equal(await page.eval('document.querySelector("video").currentTime'),0);
    await cleaned(longer.helperId);
    t.check('按需加载的后续分段同样被保存，12 秒样片有完整的 720 帧和音轨',true);
});
