'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EXT, launch, serve, send, html, fixture, test, until } = require('./lib/harness');

test('新版侧栏：识别、预览、点选、定位与下载', async t => {
    const picture = fs.readFileSync(path.join(EXT, 'img/icon.png'));
    const movie = fixture('video.mp4');
    function movieWithTag(tag) {
        const box = Buffer.alloc(12);
        box.writeUInt32BE(box.length);
        box.write('free',4); box.write(tag,8);
        return Buffer.concat([movie,box]);
    }
    const secondMovie = movieWithTag('full'), smallMovie = movieWithTag('lite');
    const embedded = await serve((req, res, url) => {
        if (url.pathname === '/embed') return html(res, '<img id="cover" alt="Frame image" src="/frame-photo">');
        if (url.pathname === '/frame-photo') { send(req,res,picture,'image/png'); return true; }
    });
    t.defer(embedded.close);
    const site = await serve((req,res,url) => {
        if (url.pathname === '/watch') {
            return html(res, `<style>figure{margin:12px}video{width:280px;height:150px}img{width:75px}iframe{width:240px;height:100px;border:0}</style>
                <figure><video id="first" poster="/photo" preload="auto" src="/a.mp4" aria-label="First movie"></video></figure>
                <img id="photo" src="/photo" alt="Lake photo"><audio src="/recording" preload="auto" controls></audio>
                <div style="height:1000px"></div><video id="second" preload="auto" aria-label="Second movie"><source src="/b.mp4" label="HD"><source src="/c.mp4" label="Small"></video>
                <iframe src="${embedded.origin}/embed"></iframe><video id="pending" controls title="Waiting movie"></video>`);
        }
        if (/^\/[abc]\.mp4$/.test(url.pathname)) {
            send(req,res,{'/a.mp4':movie,'/b.mp4':secondMovie,'/c.mp4':smallMovie}[url.pathname],'video/mp4'); return true;
        }
        if (url.pathname === '/photo' || url.pathname === '/old-image') { send(req,res,picture,'image/png'); return true; }
        if (url.pathname === '/recording') {
            const wav = Buffer.alloc(44 + 800);
            wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8,4); wav.write('WAVEfmt ',8);
            wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22); wav.writeUInt32LE(8000,24);
            wav.writeUInt32LE(8000,28); wav.writeUInt16LE(1,32); wav.writeUInt16LE(8,34); wav.write('data',36); wav.writeUInt32LE(800,40);
            send(req,res,wav,'audio/wav'); return true;
        }
        if (url.pathname === '/guide') { send(req,res,Buffer.from('%PDF-1.4\n%%EOF'),'application/pdf'); return true; }
        if (url.pathname === '/playlist') {
            send(req,res,Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n'),'application/vnd.apple.mpegurl'); return true;
        }
        if (url.pathname === '/loose.m4s') { send(req,res,movie,'application/m4s'); return true; }
        if (url.pathname === '/next') return html(res,'<img src="/photo" alt="Next page photo">');
        if (url.pathname === '/protected.png') {
            if (req.headers.referer !== site.origin + '/watch') { res.writeHead(403); res.end(); return true; }
            send(req,res,picture,'image/png'); return true;
        }
        return false;
    });
    t.defer(site.close);
    const browser = await launch();
    t.defer(browser.close);
    const page = await browser.open(site.origin + '/watch');
    const tabId = await browser.tabId('/watch');
    await page.eval("Promise.all(['/guide','/playlist','/loose.m4s','/c.mp4'].map(url => fetch(url).then(r => r.arrayBuffer())))");
    const panel = await browser.open(browser.url('sidebar.html?tabId=' + tabId),460);
    const row = name => `Array.from(document.querySelectorAll('.resource')).find(node => node.querySelector('h3').textContent === ${JSON.stringify(name)})`;
    const wait = async (expression, detail) => {
        const ok = await until(() => panel.eval(expression));
        assert.ok(ok, detail + ' | ' + (await panel.eval('document.body.innerText')).slice(0,1000) + ' | ' + panel.errors.join(','));
    };
    const filter = async type => { await panel.eval(`document.querySelector('[data-filter="${type}"]').click()`); };
    const selectFromPage = async selector => {
        await panel.eval("document.querySelector('#pick').click()");
        await wait("document.querySelector('#pick').getAttribute('aria-pressed')==='true'",'picker not armed');
        const {x,y} = await page.eval(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); node.scrollIntoView({block:'center'}); const r=node.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
        await page.click(x,y);
    };
    await wait(`${row('First movie')} && ${row('Second movie')}`,'page titles and videos');
    t.check('扩展图标默认使用新版侧栏', await browser.sw.eval(`Promise.all([chrome.sidePanel.getPanelBehavior(),chrome.sidePanel.getOptions({tabId:${tabId}}),chrome.action.getPopup({})]).then(([b,o,p])=>b.openPanelOnActionClick && o.path==='sidebar.html' && !p)`));
    await wait(`${row('First movie')}.querySelector('.thumb img')?.naturalWidth > 0`,'real poster');
    t.check('宽栏左右排列', await panel.eval(`getComputedStyle(${row('First movie')}.querySelector('.card-body')).gridTemplateColumns.split(' ').length===2`));
    const resizePanel = (width, height) => panel.send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor:1, mobile:false
    });
    const filterLayout = () => panel.eval(`(() => {
        const root = document.documentElement;
        const card = ${row('First movie')}.querySelector('.card-body');
        const thumb = card.querySelector('.thumb').getBoundingClientRect();
        const multi = document.querySelector('#multi');
        return {
            scrolls:root.scrollHeight > root.clientHeight,
            fits:root.scrollWidth <= root.clientWidth,
            widescreen:Math.abs(thumb.width * 9 / 16 - thumb.height) < 1,
            columns:getComputedStyle(card).gridTemplateColumns.split(' '),
            multi:[multi.offsetLeft,multi.offsetTop]
        };
    })()`);
    for (const width of [380,379,320,390,460,380]) {
        await resizePanel(width,2400);
        // Size the viewport to fit Video so only All needs vertical scrolling.
        const videoHeight = await panel.eval('document.body.offsetHeight + 24');
        await resizePanel(width,videoHeight);
        const video = await filterLayout();
        await filter('all');
        const all = await filterLayout();
        await filter('video');
        const back = await filterLayout();
        assert.ok(!video.scrolls && all.scrolls && video.fits && all.fits,'expected only vertical scrolling in All at ' + width);
        assert.ok(video.widescreen && all.widescreen,'preview aspect ratio changed at ' + width);
        assert.equal(video.columns.length,width >= 380 ? 2 : 1,'card layout at ' + width);
        assert.deepEqual(all.columns,video.columns,'switching filters moved the preview at ' + width);
        assert.deepEqual(all.multi,video.multi,'switching filters moved the multi-select button at ' + width);
        assert.deepEqual(back,video,'returning to Video changed the layout at ' + width);
    }
    t.check('拉宽再收窄时，同一宽度下切换长短列表，预览和多选按钮的位置一致',true);
    await resizePanel(290,900);
    const narrow = await panel.eval(`({columns:getComputedStyle(${row('First movie')}.querySelector('.card-body')).gridTemplateColumns, content:document.documentElement.scrollWidth, viewport:document.documentElement.clientWidth})`);
    t.check('窄栏改为上下排列且无横向溢出',narrow.columns.split(' ').length === 1 && narrow.content <= narrow.viewport,narrow);
    await panel.eval(`${row('Second movie')}.querySelector('.toggle-details').click()`);
    t.check('详情内有播放器和原地址',await panel.eval(`!!${row('Second movie')}.querySelector('.details video') && ${row('Second movie')}.querySelector('.details a').href.endsWith('/b.mp4')`));
    await panel.eval(`${row('Second movie')}.querySelector('.toggle-details').click()`);
    await panel.eval("document.querySelector('#status').textContent = 'Previous notice'");
    await panel.eval(`${row('Second movie')}.querySelector('.locate').click()`);
    assert.ok(await until(()=>page.eval("(() => {const mark=document.querySelector('[data-snag-outline]');return !!mark && Math.abs(mark.getBoundingClientRect().top-document.querySelector('#second').getBoundingClientRect().top)<2 && scrollY>0;})()")),'located different element');
    t.check('网页滚到第二个视频并框选准确',true);
    await wait("!document.querySelector('#status').textContent && document.querySelector('#status').getClientRects().length === 0", 'successful locate must leave no notice or empty band');
    t.check('成功定位后侧栏没有提示条或空白占位', true);
    await selectFromPage('#second');
    await wait(`!document.querySelector('#selection-tools').hidden && document.querySelectorAll('.resource').length===1 && !!${row('Second movie')}`,'picked second video');
    t.check('同一播放器的两个已捕获版本合为一条，可选择版本',await panel.eval(`${row('Second movie')}.querySelector('.quality').options.length===2`));
    const before = browser.files();
    await panel.eval(`${row('Second movie')}.querySelector('.download').click()`);
    assert.deepEqual(await browser.download(before,10000),secondMovie);
    await wait(`!!${row('Second movie')}.querySelector('.download-state button')`,'saved file action');
    t.check('侧栏选中视频后保存的 MP4 与原文件逐字节一致',true);
    await panel.eval(`(() => {const select=${row('Second movie')}.querySelector('.quality');select.selectedIndex=Array.from(select.options).findIndex(o=>o.textContent.includes('Small'));select.dispatchEvent(new Event('change'));})()`);
    const beforeVariant = browser.files();
    await panel.eval(`${row('Second movie')}.querySelector('.download').click()`);
    assert.deepEqual(await browser.download(beforeVariant,10000),smallMovie);
    t.check('切换版本后实际保存的是选中版本的内容',true);
    await selectFromPage('#photo');
    await wait(`!document.querySelector('#selection-tools').hidden && !!${row('Lake photo')} && document.querySelector('[data-filter=image]').getAttribute('aria-pressed')==='true'`,'picked photo across filters');
    const beforePhoto = browser.files();
    await panel.eval(`${row('Lake photo')}.querySelector('.download').click()`);
    assert.deepEqual(await browser.download(beforePhoto,10000),picture);
    assert.ok(browser.files().some(name => name === 'photo.png'),'file without suffix must open as PNG');
    await wait(`${row('Lake photo')}?.querySelector('.format-label').textContent===i18n.sideSavedFormat`,'saved image receipt');
    assert.ok(await panel.eval(`${row('Lake photo')}?.querySelector('.file-format').textContent==='PNG' &&
        ${row('Lake photo')}?.querySelector('.file-size').textContent===bytes(${picture.length}) && ${row('Lake photo')}?.querySelector('.codec-field').hidden`));
    t.check('点选无后缀图片会切换筛选，并保存正确的 PNG 内容',true);
    await filter('image');
    await wait(`!!${row('Frame image')} && !${row('Frame image')}.querySelector('.locate').disabled`,'iframe match');
    await panel.eval(`${row('Frame image')}.querySelector('.locate').click()`);
    const frameTree = await page.send('Page.getFrameTree');
    const frameId = frameTree.frameTree.childFrames[0].frame.id;
    const { executionContextId } = await page.send('Page.createIsolatedWorld',{ frameId,worldName:'sidebar-test' });
    assert.ok(await until(()=>page.eval("!!document.querySelector('[data-snag-outline]')",executionContextId)));
    t.check('嵌入网页中的图片可以精确定位',true);
    await panel.eval("document.querySelector('#multi').click(); document.querySelector('#select-all').click()");
    const beforeBatch = await browser.sw.eval("chrome.downloads.search({}).then(items=>items.map(item=>item.id))");
    await panel.eval("document.querySelector('#save-selected').click()");
    const newFiles = await until(async () => {
        const items = await browser.sw.eval("chrome.downloads.search({state:'complete'})");
        const names = items.filter(item => !beforeBatch.includes(item.id)).map(item => item.filename);
        return names.length === 2 && names;
    });
    assert.ok(newFiles && newFiles.every(name=>fs.readFileSync(name).equals(picture)),JSON.stringify({
        files:browser.files(), selected:await panel.eval("document.querySelector('#save-selected').textContent"),
        jobs:await browser.sw.eval("chrome.downloads.search({}).then(items=>items.map(i=>[i.filename,i.state,i.error]))")
    }));
    t.check('多选只下载当前筛选的两张图片',true);
    await page.eval("(() => {const img=new Image();img.alt='Original page required';img.src='/protected.png';document.body.append(img);})()");
    await wait(`!!${row('Original page required')}`,'image with a site referer');
    const beforeProtected = browser.files();
    await panel.eval(`${row('Original page required')}.querySelector('.download').click()`);
    assert.deepEqual(await browser.download(beforeProtected,15000),picture);
    t.check('需原网页来源的图片可交由内置下载器保存',true);
    await filter('audio');
    t.check('音频单独筛选',await panel.eval("document.querySelector('.resource')?.dataset.kind==='audio'"));
    assert.ok(await panel.eval("document.querySelector('.file-format').textContent==='WAV' && document.querySelector('.file-size').textContent===bytes(844)"));
    await filter('other');
    await wait("document.querySelector('.resource')?.dataset.kind==='other'",'PDF');
    t.check('后台下载的 PDF 出现在其他分类，定位按钮显示不可用',await panel.eval("document.querySelector('.resource .locate').disabled"));
    assert.ok(await panel.eval("document.querySelector('.resource-context').textContent===i18n.sideDocument && document.querySelector('.file-format').textContent==='PDF' && document.querySelector('.file-size').textContent===bytes(14)"));
    t.check('图片、音频与文档在相同位置显示格式和实测大小，图片及文档没有编码控件',true);
    assert.deepEqual(await panel.eval("["+
        "{type:'image/avif',name:'frame.jpg@180w.avif'}, {type:'audio/mp4',ext:'m4s'}, "+
        "{type:'application/octet-stream',name:'Paper',url:'https://example.test/guide.pdf?v=1'}, "+
        "{type:'application/octet-stream',url:'https://example.test/view.php'}].map(SnagFormat.extension)"),['avif','m4s','pdf','']);
    await filter('video');
    t.check('无后缀 HLS 清单在视频分类中，无法归属的分片收起', await panel.eval("Array.from(document.querySelectorAll('.meta')).some(el=>el.textContent.includes('HLS')) && !document.querySelector('#segments').hidden && !document.querySelector('#segments').open"));
    assert.ok(await panel.eval("[...document.querySelectorAll('.resource')].find(r=>r.querySelector('.file-format')?.textContent==='HLS').querySelector('.file-size').textContent==='—'"));
    const groups = await panel.eval(`(() => {
        const items = ['43690036223-1-30032','43690036223-1-30251','43689250482-1-30033','unlinked'];
        const records = new Map(items.map(name=>[name,{url:'https://test.bilivideo.com/'+name+'.m4s',ext:'m4s'}]));
        return sidebarGroups(records,new Map(),null).map(group=>[group.biliId || null,group.rawSegment,group.tracks.map(track=>track.kind)]);
    })()`);
    assert.deepEqual(groups,[['43690036223',false,['video','audio']],['43690036223',false,['audio']],['43689250482',false,['video']],[null,true,['video']]]);
    t.check('按样本文件名识别同一 B 站内容的音画，其他内容与孤立片段单独保留',true);
    const beforeHls = browser.files();
    await panel.eval(`${row('playlist')}.querySelector('.download').click()`);
    const hlsFile = await browser.download(beforeHls,15000);
    require('./lib/mp4').checkFastStart(hlsFile,{width:160,height:90,frames:20,fps:10,seconds:2});
    assert.ok(browser.files().some(name=>!beforeHls.includes(name) && name.endsWith('.mp4')));
    t.check('从无后缀 HLS 清单保存含画面与声音的可寻址 MP4',true);
    await selectFromPage('#pending');
    await wait("!document.querySelector('#selection-tools').hidden && !document.querySelector('#empty').hidden",'unloaded element');
    await page.eval("document.querySelector('#pending').src='/b.mp4?pending=1'");
    await wait(`!!${row('Waiting movie')}`,'matching request arrived later');
    t.check('点选尚未加载的视频后，文件到达时列表自动更新',true);
    await panel.eval("document.querySelector('#pick').click()");
    await wait("document.querySelector('#pick').getAttribute('aria-pressed')==='true'",'arm Escape');
    await page.send('Input.dispatchKeyEvent',{ type:'keyDown',key:'Escape',code:'Escape' });
    await wait("document.querySelector('#pick').getAttribute('aria-pressed')==='false'",'Escape');
    t.check('按 Esc 退出点选',true);
    await page.send('Page.navigate',{ url:site.origin+'/next' });
    await filter('image');
    await wait(`!!${row('Next page photo')} && !${row('Lake photo')}`,'navigated to next page');
    t.check('原标签页导航后清理旧列表并重新定位',true);
    await browser.sw.eval("chrome.storage.sync.set({enable:false})");
    await wait("!loading && !enabled && document.querySelector('#rescan').disabled", 'scan disabled while capture is paused');
    await page.eval("new Promise(ok=>{const img=new Image();img.id='preloaded';img.alt='Earlier image';img.onload=ok;img.src='/old-image?preloaded';document.body.append(img);})");
    await page.eval(`new Promise(ok=>{const frame=document.createElement('iframe');frame.onload=ok;frame.src=${JSON.stringify(embedded.origin + '/embed')};document.body.append(frame);})`);
    await page.eval("fetch('/loose.m4s?before-capture').then(r=>r.arrayBuffer())");
    await page.eval("new Promise(ok=>{const v=document.createElement('video');v.id='playing';v.muted=true;v.loop=true;v.src='/a.mp4?before-capture';document.body.append(v);v.play().then(ok);})");
    await browser.sw.eval("chrome.storage.sync.set({enable:true})");
    await wait("!loading && enabled && !document.querySelector('#pick').disabled",'resumed');
    assert.ok(!(await browser.sw.eval(`(cacheData[${tabId}] || []).some(item=>item.url.includes('preloaded'))`)));
    await selectFromPage('#preloaded');
    await wait(`!!${row('Earlier image')}`,'direct file from an existing page');
    const beforeDirect = browser.files();
    await panel.eval(`${row('Earlier image')}.querySelector('.download').click()`);
    assert.deepEqual(await browser.download(beforeDirect,10000),picture);
    t.check('安装前已加载的直链图片也可手动点选并保存',true);
    await panel.eval("document.querySelector('#back').click()");
    await filter('image');
    await wait(`!!${row('Next page photo')} && !${row('Earlier image')} && !${row('Frame image')}`, 'missed items should require a rescan');
    await panel.eval(`${row('Next page photo')}.querySelector('.toggle-details').click(); document.querySelector('#multi').click(); ${row('Next page photo')}.querySelector('.check').click()`);
    const pageStart = await page.eval('performance.timeOrigin');
    const streamRequests = () => site.log.filter(request => request.path === '/loose.m4s?before-capture').length;
    const requestsBeforeScan = streamRequests();
    await panel.eval("document.querySelector('#rescan').click()");
    await wait(`!!${row('Earlier image')} && !!${row('Frame image')} && document.querySelector('#rescan').textContent===i18n.sideScanned`, 'rescan found files in both frames');
    t.check('刷新抓取补回当前页和内嵌页已加载的图片，同时保留筛选、详情和勾选',
        await panel.eval(`document.querySelector('[data-filter=image]').getAttribute('aria-pressed')==='true' && ${row('Next page photo')}.querySelector('.check').checked && !${row('Next page photo')}.querySelector('.details').hidden`));
    assert.equal(await page.eval('performance.timeOrigin'),pageStart);
    assert.ok(await page.eval("!document.querySelector('#playing').paused"));
    assert.equal(streamRequests(),requestsBeforeScan);
    t.check('普通刷新抓取不重载网页，不打断播放，也不重取视频分片',true);
    await panel.eval("document.querySelector('#rescan').click()");
    await wait("document.querySelector('#rescan').textContent===i18n.sideScanned", 'repeat rescan');
    t.check('重复抓取不会重复添加卡片',await panel.eval("Array.from(document.querySelectorAll('.resource h3')).filter(el=>el.textContent==='Earlier image').length===1"));
    const previousDownloads = await browser.sw.eval("chrome.downloads.search({}).then(items=>items.map(item=>item.id))");
    await panel.eval(`${row('Earlier image')}.querySelector('.download').click()`);
    const recovered = await until(async () => (await browser.sw.eval("chrome.downloads.search({state:'complete'})"))
        .find(item => !previousDownloads.includes(item.id) && item.url.endsWith('/old-image?preloaded')));
    assert.ok(recovered, 'download of recovered image should complete');
    assert.deepEqual(fs.readFileSync(recovered.filename),picture);
    t.check('补抓的图片能保存，内容与原图一致',true);
    await filter('video');
    await panel.eval("document.querySelector('#segments').open=true");
    await wait("Array.from(document.querySelectorAll('#segment-cards h3')).some(el=>el.textContent==='loose.m4s')", 'network-only segment recovered from the document');
    t.check('没有网页元素的已加载视频分片也可以补抓',true);
    const classic = await browser.open(browser.url('popup.html?tabId=' + tabId));
    const opener = await until(()=>classic.eval("(() => {const el=document.querySelector('#openSidebar');if(!el?.offsetWidth)return; el.scrollIntoView();const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()"));
    assert.ok(opener,'classic popup sidebar entry');
    await classic.click(opener.x,opener.y);
    const nativeTarget = await until(async () => (await browser.targets()).find(target => target.url === browser.url('sidebar.html')));
    assert.ok(nativeTarget,'native side panel did not open');
    const native = await browser.attach(nativeTarget.targetId,false);
    await browser.sw.eval(`chrome.tabs.update(${tabId},{active:true})`);
    assert.ok(await until(()=>native.eval("!!document.querySelector('[data-filter=image]') && document.querySelector('#pick')?.disabled===false")),'native panel readiness: ' + (await native.eval("document.body?.innerText")) + native.errors.join(','));
    await native.eval("document.querySelector('[data-filter=image]').click()");
    assert.ok(await until(()=>native.eval(`!!${row('Next page photo')}`)),'native sidebar did not bind to active tab');
    assert.ok(await until(()=>native.eval(`!!${row('Earlier image')}`)),'last rescan should survive reopening the sidebar');
    const other = await browser.open(site.origin+'/watch?other');
    await until(()=>other.eval("document.querySelector('#first')?.readyState>0"));
    await native.eval("document.querySelector('[data-filter=video]').click()");
    assert.ok(await until(()=>native.eval(`!!${row('First movie')}`)),'native sidebar did not follow the new tab');
    t.check('浏览器原生侧栏能打开，并随当前标签页切换',true);
    const otherId = await browser.tabId('/watch?other');
    await other.eval("Promise.all(Array.from({length:105},(_,i)=>fetch('/photo?gallery='+i).then(r=>r.arrayBuffer())))");
    assert.ok(await until(()=>browser.sw.eval(`chrome.storage.session.get('MediaData').then(({MediaData})=>{
        const list=MediaData?.[${otherId}] || []; return list.filter(row=>row.url.includes('gallery=')).length===105 && list.some(row=>row.url.endsWith('/b.mp4'));
    })`),12000),'missing stored captures on image-heavy page');
    t.check('超过一百张图片的网页仍能保存图片与视频的抓取记录',true);
    const otherStart = await other.eval('performance.timeOrigin');
    assert.ok(await panel.eval("!!document.querySelector('.command-row #reload-page')?.getClientRects().length"),'page reload is visible next to rescan');
    await panel.eval("document.querySelector('#reload-page').click()");
    assert.ok(await until(async () => (await page.eval('performance.timeOrigin')) !== pageStart && await page.eval("document.readyState==='complete'")));
    await filter('image');
    await wait(`!!${row('Next page photo')} && !${row('Earlier image')}`, 'full reload clears old document discoveries');
    t.check('手动选择刷新网页时只重载侧栏指向的网页',await other.eval('performance.timeOrigin')===otherStart);
    assert.deepEqual(panel.errors,[]);
    assert.deepEqual(native.errors,[]);
});
