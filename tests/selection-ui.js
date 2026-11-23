'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const {launch, serve, html, test, until} = require('./lib/harness');

async function clickElement(page, selector) {
    const point = await until(() => page.eval(`(async () => {
        const item = document.querySelector(${JSON.stringify(selector)});
        if (!item) return;
        item.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
        await new Promise(requestAnimationFrame);
        const r = item.getBoundingClientRect();
        const x=r.x+r.width/2, y=r.y+r.height/2;
        if (r.width && r.height && item.contains(document.elementFromPoint(x,y))) return [x,y];
    })()`));
    assert.ok(point,selector+' has a visible click target');
    await page.click(...point);
}

async function key(page, key, code, keyCode) {
    const params = {key,code,windowsVirtualKeyCode:keyCode};
    const text = key==='Enter' ? '\r' : key===' ' ? ' ' : '';
    await page.send('Input.dispatchKeyEvent',{...params,type:text ? 'keyDown' : 'rawKeyDown',text});
    await page.send('Input.dispatchKeyEvent',{...params,type:'keyUp'});
}

async function openMenu(page, selector, optionSelector = 'option:checked') {
    await clickElement(page,selector);
    const select = 'document.querySelector('+JSON.stringify(selector)+')';
    assert.ok(await until(() => page.eval(select+'.matches(":open")')),selector+' opens');
    const row = await page.eval(`(() => {
        const s = ${select}, o = s.querySelector(${JSON.stringify(optionSelector)});
        o.scrollIntoView({block:'nearest'});
        const r = o.getBoundingClientRect(), shadow = getComputedStyle(s.closest('.select-shell') || s);
        return {outline:shadow.outlineStyle, left:r.left,right:r.right,width:r.width,viewport:innerWidth,
            visible:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('option')===o};
    })()`);
    assert.equal(row.outline,'none',selector+' has no extra frame');
    assert.ok(row.visible && row.width>0 && row.left>=0 && row.right<=row.viewport,selector+' popup hit area '+JSON.stringify(row));
}

test('选择菜单与文件选中状态',async t => {
    const site = await serve((req,res,url) => {
        if (url.pathname==='/parts.m3u8') {
            res.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl'});
            res.end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n');
            return true;
        }
        if (url.pathname==='/other') return html(res,'<script>document.title="这是一个很长的网页标题".repeat(12)</script>');
        if (url.pathname==='/watch') return html(res,`<script>document.title="高清动态测试片"</script>
            <video aria-label="高清动态测试片" muted autoplay loop>
                <source src="/quality-1080p60.mp4" label="1080p60" type='video/mp4; codecs="avc1.64002a"'>
                <source src="/youtube-picture.webm" label="1080p60" type='video/webm; codecs="vp9"'>
                <source src="/quality-360.mp4" label="360p" type='video/mp4; codecs="avc1.42c01e"'>
                <source src="/quality-360.mp4?alternate" label="360p" type='video/mp4; codecs="avc1.42c01e"'>
            </video>`);
    });
    t.defer(site.close);
    const browser = await launch();
    t.defer(browser.close);
    await browser.open(site.origin+'/other');
    const other = await browser.tabId('/other');
    await browser.open(site.origin+'/watch');
    const tab = await browser.tabId('/watch');
    const panel = await browser.open(browser.url('sidebar.html?tabId='+tab),440,610);
    const tier = '#cards .quality-tier', codec = '#cards .encoding';
    const wait = (p,code,why) => until(()=>p.eval(code)).then(ok=>assert.ok(ok,why));
    await wait(panel,'document.querySelector(".encoding-options")?.offsetWidth && document.querySelector(".tier-current")?.textContent==="1080p60"','two codecs and two qualities');
    if (!await panel.eval('CSS.supports("appearance","base-select") && CSS.supports("selector(::picker(select))")')) {
        t.skip('此浏览器使用系统选择菜单');
        return;
    }
    await openMenu(panel,tier);
    if (process.env.SNAG_FOCUS_PREVIEW) {
        const {data} = await panel.send('Page.captureScreenshot',{format:'png'});
        fs.writeFileSync(process.env.SNAG_FOCUS_PREVIEW,Buffer.from(data,'base64'));
    }
    await clickElement(panel,tier+' option[value="360p"]');
    await wait(panel,'document.querySelector(".download").textContent.includes("360p")','clicked quality used for download');
    const version = '#cards .quality';
    await openMenu(panel,version);
    const otherVersion = await panel.eval('document.querySelector(".quality option:not(:checked)").value');
    await clickElement(panel,version+' option:not(:checked)');
    await wait(panel,'document.querySelector(".quality").value==='+JSON.stringify(otherVersion),'clicked file version');
    await openMenu(panel,tier);
    await clickElement(panel,tier+' option[value="1080p60"]');
    await wait(panel,'!document.querySelector(".encoding-options").hidden','codec picker restored');
    const outsideCodec = async () => {
        const points = await panel.eval(`(() => {
            const cell=document.querySelector(".codec-field"), label=cell.querySelector("dt").getBoundingClientRect();
            const value=cell.querySelector(".encoding").getBoundingClientRect(), right=cell.getBoundingClientRect().right-2;
            return [[label.left+3,label.top+label.height/2],[right,value.top+value.height/2]];
        })()`);
        for (const point of points) {
            await panel.click(...point);
            assert.equal(await panel.eval('document.querySelector(".encoding").matches(":open")'),false,'codec label and empty space are inert');
        }
    };
    const checkCodecLayout = async () => {
        const layout = await panel.eval(`(() => {
            const s=document.querySelector(".encoding"), trigger=s.getBoundingClientRect();
            const box=s.selectedOptions[0].getBoundingClientRect();
            return {width:box.width,right:box.right,triggerRight:trigger.right,triggerWidth:trigger.width,
                cellWidth:s.closest("dd").offsetWidth,rows:[...s.options].every(o=>{
                    const name=o.querySelector(".encoding-name").getBoundingClientRect(), size=o.querySelector(".encoding-size");
                    if(!size) return name.width>0;
                    const rect=size.getBoundingClientRect();
                    return Math.abs(rect.top-name.top)<3 && rect.left>=name.right;
                })};
        })()`);
        assert.ok(layout.width>=180 && layout.right<=layout.triggerRight+4 && layout.triggerWidth<layout.cellWidth && layout.rows,
            'codec options have room and the trigger fits its value: '+JSON.stringify(layout));
    };
    await outsideCodec();
    const arrow = await panel.eval('(()=>{const r=document.querySelector(".encoding-options").getBoundingClientRect();return [r.right-4,r.top+r.height/2]})()');
    await panel.click(...arrow);
    await wait(panel,'document.querySelector(".encoding").matches(":open")','the codec arrow opens its menu');
    await key(panel,'Escape','Escape',27);
    await openMenu(panel,codec);
    await checkCodecLayout();
    await clickElement(panel,codec+' option:not(:checked)');
    await wait(panel,'document.querySelector(".encoding-current").textContent==="VP9"','clicked second codec');
    t.check('直接点选画质、文件版本和编码，下载选项即时更新',true);

    await panel.send('Emulation.setDeviceMetricsOverride',{width:300,height:650,deviceScaleFactor:1,mobile:false});
    await panel.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]});
    await outsideCodec();
    await openMenu(panel,codec);
    await checkCodecLayout();
    await key(panel,'Escape','Escape',27);
    await wait(panel,'!document.querySelector(".encoding").matches(":open")','Escape dismisses menu');
    await key(panel,'Tab','Tab',9);
    await wait(panel,'document.activeElement.matches(".quality-tier:focus-visible")','Tab to the quality selector');
    assert.equal(await panel.eval('getComputedStyle(document.activeElement.closest(".select-shell")).textDecorationLine'),'underline');
    await key(panel,' ','Space',32);
    await wait(panel,'document.querySelector(".quality-tier").matches(":open")','keyboard opens quality menu');
    await key(panel,'ArrowDown','ArrowDown',40);
    await key(panel,'Enter','Enter',13);
    await wait(panel,'document.querySelector(".tier-current").textContent==="360p"','keyboard selects quality');
    t.check('窄栏和深色下的菜单可见，键盘可以打开、选择和退出',true);

    await openMenu(panel,'#scope','option[value="'+other+'"]');
    await clickElement(panel,'#scope option[value="'+other+'"]');
    await wait(panel,'document.getElementById("scope").value==='+JSON.stringify(String(other)),'changed source tab');
    assert.ok(await panel.eval('document.getElementById("scope").offsetHeight<=38 && document.documentElement.scrollWidth<=innerWidth'),'long page title fits the closed 300px sidebar header');
    assert.ok(await panel.eval(`(() => {
        const scope = document.getElementById('scope'), heading = scope.parentElement;
        return scope.labels[0]?.textContent.trim() && !heading.querySelector('img')
            && Math.abs(scope.getBoundingClientRect().left - heading.getBoundingClientRect().left) <= 1;
    })()`),'page selector starts at the left edge and retains its accessible label');
    const settings = await browser.open(browser.url('options.html'),320,660);
    await wait(settings,'document.querySelector("#settings-jump")?.options.length>1','settings navigation');
    await openMenu(settings,'#settings-jump');
    await clickElement(settings,'#settings-jump option[value="#anchorType"]');
    await wait(settings,'document.querySelector(".settings-pane > .active")?.id==="anchorType"','settings category changed');
    await settings.send('Emulation.setEmulatedMedia',{features:[{name:'forced-colors',value:'active'}]});
    await openMenu(settings,'#settings-jump');
    await key(settings,'ArrowDown','ArrowDown',40);
    assert.ok(await settings.eval('document.activeElement.matches("option:focus-visible") && getComputedStyle(document.activeElement).color!==getComputedStyle(document.activeElement).backgroundColor'),'keyboard position in high contrast');
    await key(settings,'Escape','Escape',27);
    t.check('顶部换网页和设置分类均可从菜单直接选择',true);

    const preview = await browser.open(browser.url('preview.html?tabId='+tab));
    await wait(preview,'document.querySelector(".file-name")?.offsetWidth','captured file in preview');
    await clickElement(preview,'.file-name');
    assert.ok(await preview.eval('getComputedStyle(document.querySelector(".file-item.selected .file-name"),"::before").content.includes("✓")'));
    await clickElement(preview,'.file-name');
    assert.equal(await preview.eval('document.querySelector(".file-item").classList.contains("selected")'),false);

    const parts = await browser.open(browser.url('m3u8.html?'+new URLSearchParams({url:site.origin+'/parts.m3u8',tabId:tab})));
    await wait(parts,'document.querySelector("#mediaList .media-item.selected")','parsed local segment list');
    if (!await parts.eval('document.querySelector("#textarea details").open')) await clickElement(parts,'#textarea summary');
    await wait(parts,'document.querySelector(".media-item .url-text")?.offsetHeight && !document.querySelector("#mergeTs").disabled','segment can be selected');
    assert.ok(await parts.eval('getComputedStyle(document.querySelector(".media-item.selected"),"::before").content.includes("✓")'));
    await clickElement(parts,'.media-item .url-text');
    assert.equal(await parts.eval('document.querySelector(".media-item").classList.contains("selected")'),false);
    assert.ok(await parts.eval('parseTs(hls.levels[0].details); !_fragments[0].selected && !document.querySelector(".media-item").classList.contains("selected")'));
    t.check('文件预览与切片列表可以勾选和取消，当前选择有小勾',true);
    assert.deepEqual([...panel.errors,...settings.errors,...preview.errors,...parts.errors],[]);
});
