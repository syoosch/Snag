'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EXT, launch, serve, html, test, until} = require('./lib/harness');

async function enableDeveloperMode(browser) {
    const edge = await browser.sw.eval("navigator.userAgent.includes('Edg/')");
    const page = await browser.open(edge ? 'edge://extensions/' : 'chrome://extensions/');
    const pathToSwitch = edge
        ? ['root-app','side-nav-pane','profile-toggles','developer-mode-switch','#dev-switch']
        : ['extensions-manager','extensions-toolbar','#devMode'];
    const toggle = `${JSON.stringify(pathToSwitch)}.reduce((node, selector) =>
        (node?.shadowRoot || node)?.querySelector(selector), document)`;
    try {
        assert.ok(await until(() => page.eval(`Boolean(${toggle})`)), 'developer mode switch is visible');
        await page.eval(`(() => { const control = ${toggle}; if (!control.checked) control.click(); })()`);
        assert.ok(await until(() => page.eval(`Boolean((${toggle}).checked)`)), 'developer mode is on');
    } finally {
        await page.close();
    }
}

async function checkUpgrade(t, coldStart) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'snag-upgrade-'));
    const profile = path.join(temp,'profile'), extensionPath = path.join(temp,'extension');
    const options = {profile, extensionPath};
    t.defer(() => {
        if (path.dirname(temp) === os.tmpdir() && path.basename(temp).startsWith('snag-upgrade-')) {
            fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:300});
        }
    });
    fs.mkdirSync(extensionPath);
    const manifest = JSON.parse(fs.readFileSync(path.join(EXT,'manifest.json'),'utf8'));
    // The browser owns the identity and update event. Use the old release number
    // and persisted data in a small fixture, then load the actual current files.
    fs.writeFileSync(path.join(extensionPath,'manifest.json'),JSON.stringify({
        manifest_version:3, name:'Framepick', version:'2.7.4.21',
        permissions:manifest.permissions, host_permissions:manifest.host_permissions,
        background:{service_worker:'seed.js'}
    }));
    fs.writeFileSync(path.join(extensionPath,'seed.js'),
        'const G = {initSyncComplete:true,initLocalComplete:true}; chrome.runtime.onInstalled.addListener(() => {});');
    let browser = await launch(options);
    t.defer(() => browser?.close());
    // Match the GitHub installation steps before reloading or restarting an unpacked extension.
    await enableDeveloperMode(browser);
    const originalId = browser.extId;
    const job = 'job-409dd36b-514b-4e5f-aed6-93d951328774';
    const helper = 'framepick-youtube-' + job;
    await browser.sw.eval('chrome.storage.sync.set({mqttEnable:true,mqttTopic:"archive/custom",catDownload:true})');
    await browser.sw.eval('chrome.storage.local.set(' + JSON.stringify({
        framepickMediaUsed:true,
        [helper]:{tabId:123456789,url:'https://www.youtube.com/watch?v=AAAAAAAAAAA#framepick-segments=' + job},
        customValue:42
    }) + ')');
    await browser.sw.eval(`(async () => {
        const root = await navigator.storage.getDirectory();
        for (const [folder,prefix] of [['framepick-media-v1','job-'],['framepick-streams-v1','part-']]) {
            const dir = await root.getDirectoryHandle(folder,{create:true});
            await dir.getFileHandle('keep-this',{create:true});
            const abandoned = await dir.getDirectoryHandle(prefix + crypto.randomUUID(),{create:true});
            await abandoned.getFileHandle('unfinished',{create:true});
        }
    })()`);
    if (coldStart) {
        await browser.close();
        browser = null;
    }
    for (const dir of ['_locales','css','img','js','catch-script','lib']) {
        fs.cpSync(path.join(EXT,dir),path.join(extensionPath,dir),{recursive:true});
    }
    for (const file of fs.readdirSync(EXT).filter(name => name.endsWith('.html') || name === 'manifest.json')) {
        fs.copyFileSync(path.join(EXT,file),path.join(extensionPath,file));
    }
    fs.unlinkSync(path.join(extensionPath,'seed.js'));
    if (coldStart) {
        browser = await launch(options);
    } else {
        const previousWorker = browser.sw.targetId;
        await browser.sw.eval('setTimeout(() => chrome.runtime.reload(),50); true');
        const next = await until(async () => (await browser.targets()).find(target =>
            target.type === 'service_worker' && target.targetId !== previousWorker
            && target.url === browser.url('js/background.js')),12000);
        assert.ok(next,'the new service worker started after a developer reload');
        browser.sw = await browser.attach(next.targetId,false);
    }
    assert.equal(await browser.sw.eval('chrome.runtime.id'),originalId);
    assert.deepEqual(await browser.sw.eval('[chrome.runtime.getManifest().name,chrome.runtime.getManifest().version]'),
        ['Snag',manifest.version]);
    const migrated = await until(() => browser.sw.eval(`chrome.storage.sync.get(null).then(prefs =>
        prefs.mqttClientId === 'framepick-client' && prefs.mqttTopic === 'archive/custom'
        && prefs.disableInternalDownloader === true && !('catDownload' in prefs))`),10000);
    assert.ok(migrated,'saved preferences after reload: ' + JSON.stringify(await browser.sw.eval('chrome.storage.sync.get(null)')));
    t.check((coldStart ? '重新启动浏览器' : '重新加载扩展') + '后，扩展标识、下载和订阅设置均保留',true);

    const cleaned = await until(() => browser.sw.eval(`(async () => {
        const prefs = await chrome.storage.local.get(null);
        if (!prefs.snagMediaUsed || prefs.framepickMediaUsed || prefs[${JSON.stringify(helper)}] || prefs.customValue !== 42) return false;
        const storage = await navigator.storage.getDirectory();
        for (const folder of ['framepick-media-v1','framepick-streams-v1']) {
            const dir = await storage.getDirectoryHandle(folder);
            const names = await Array.fromAsync(dir.keys());
            if (names.length !== 1 || names[0] !== 'keep-this') return false;
        }
        return true;
    })()`),12000);
    assert.ok(cleaned,'temporary media, streams and background tab records from the previous build are cleared');
    t.check('旧版任务的临时文件已回收，只保留了无关文件',true);
    if (coldStart) return;

    const site = await serve((req,res) => html(res,'<title>Upgrade</title>'));
    t.defer(site.close);
    const pageUrl = site.origin + '/upgrade';
    const page = await browser.open(pageUrl);
    assert.ok(await until(() => page.eval('location.href === '+JSON.stringify(pageUrl)+' && document.readyState === "complete"')),
        'the local upgrade page committed before seeding its origin storage');
    await page.eval(`localStorage.setItem('framepickCapture_selector','#movie');
        localStorage.setItem('framepickCapture_migrated','1');
        localStorage.setItem('CatCatchCatch_ffmpeg','checked');
        localStorage.setItem('snagCapture_autoDown','');
        localStorage.setItem('framepickCapture_autoDown','checked');`);
    const tabId = await browser.sw.eval('chrome.tabs.query({}).then(tabs => tabs.find(tab => tab.url?.endsWith("/upgrade")).id)');
    await browser.sw.eval('chrome.scripting.executeScript({target:{tabId:' + tabId +
        '},world:"MAIN",files:["catch-script/i18n.js","catch-script/catch.js"]})');
    assert.deepEqual(await page.eval(`['selector','ffmpeg','autoDown'].map(key => localStorage.getItem('snagCapture_' + key))`),
        ['#movie',null,'']);
    t.check('旧版网页捕获设置被继承，手动关闭和已清除的偏好按原样保留',true);
    await browser.close();
    browser = null;
}

test('从开发版升级到 Snag',async t => {
    await checkUpgrade(t,false);
    await checkUpgrade(t,true);
});
