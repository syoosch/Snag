'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EXT, launch, serve, html, test, until } = require('./lib/harness');

async function click(page, selector) {
    const point = await page.eval(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        element.scrollIntoView({ block: 'center' });
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await page.click(point.x, point.y);
}

test('Snag · 安装欢迎页与使用指南', async t => {
    const browser = await launch();
    t.defer(browser.close);
    const first = await browser.waitPage(/\/install\.html$/);
    assert.ok(first, '首次安装应自动打开欢迎页');
    const welcome = await browser.attach(first.targetId);
    const site = await serve((req, res, url) => {
        if (url.pathname === '/watch') return html(res, '<video aria-label="Garden film" src="/video.mp4" preload="auto" controls></video>');
    });
    t.defer(site.close);
    const original = (await browser.targets()).find(target => target.type === 'page' && target.url === 'about:blank');
    assert.ok(original);
    const webPage = await browser.attach(original.targetId);
    await webPage.send('Page.navigate', { url: site.origin + '/watch' });
    assert.ok(await until(() => welcome.eval("document.querySelector('#headline')?.textContent")));
    const meta = await browser.sw.eval(`Promise.all([
        chrome.runtime.getManifest().name, chrome.runtime.getManifest().short_name,
        chrome.action.getTitle({}), chrome.i18n.getMessage('extensionName')
    ])`);
    t.check('浏览器的扩展名、图标提示、欢迎页品牌一致', new Set(meta).size === 1
        && meta[0] === 'Snag'
        && await welcome.eval("document.querySelector('.wordmark').innerText") === meta[0], meta);
    t.check('首次安装只打开一个欢迎页', (await browser.pages(/\/install\.html$/)).length === 1);
    assert.equal(await welcome.eval("document.querySelector('footer [data-copy=about]').href"), browser.url('options.html#anchorAbout'));
    assert.ok(await welcome.eval("[...document.links].every(link => link.origin === location.origin)"), '欢迎页的入口均在扩展内');

    for (const [locale, heading] of [['en', 'Snag is installed.'], ['zh_TW', 'Snag 已安裝'], ['zh_CN', 'Snag 已安装']]) {
        await welcome.eval(`(() => {
            const select = document.querySelector('#language');
            select.value = ${JSON.stringify(locale)};
            select.dispatchEvent(new Event('change'));
        })()`);
        const correct = await until(() => welcome.eval(`document.title === ${JSON.stringify(heading)}
            && document.querySelector('#headline').textContent === document.title
            && document.documentElement.lang === ${JSON.stringify(locale.replace('_', '-'))}
            && [...document.querySelectorAll('[data-copy]')].every(node => node.textContent.trim())`));
        t.check('欢迎页本地切换语言 ' + locale, !!correct);
    }
    await welcome.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 680, deviceScaleFactor: 1, mobile: false });
    t.check('窄屏下没有横向溢出，试存按钮可见', await welcome.eval(`
        document.documentElement.scrollWidth <= document.documentElement.clientWidth
        && document.querySelector('.sample-save').getBoundingClientRect().width > 0`));
    await click(welcome, '.fine-print summary');
    t.check('按需展开隐私与使用说明', await welcome.eval("document.querySelector('.fine-print').open && document.querySelector('[data-copy=welcomePrivacy]').offsetHeight > 0"));
    const before = browser.files();
    await click(welcome, '.sample-save');
    assert.deepEqual(await browser.download(before, 10000), fs.readFileSync(path.join(EXT, 'img/icon128.png')));
    assert.ok(browser.files().includes('Snag.png'));
    t.check('试存按钮保存了界面所展示的 PNG 图片', true);
    await click(welcome, '#agreeBtn');
    assert.ok(await until(async () => !(await browser.pages(/\/install\.html$/)).length));
    const native = await until(async () => (await browser.targets()).find(target => target.url === browser.url('sidebar.html')));
    assert.ok(native, '欢迎页按钮应打开这个窗口的原生侧栏');
    const panel = await browser.attach(native.targetId, false);
    assert.ok(await until(() => panel.eval("Array.from(document.querySelectorAll('.resource h3')).some(el => el.textContent === 'Garden film')")));
    t.check('点开始后关闭欢迎页，原网页的视频直接出现在原生侧栏', true);
    t.check('原生侧栏内的页面标题与浏览器登记的全名、简称一致', await panel.eval('document.title') === meta[0]);
    await click(panel, '#more summary');
    await click(panel, '#more a');
    const reopened = await browser.waitPage(/\/install\.html\?guide$/);
    assert.ok(reopened, '侧栏菜单应打开使用指南');
    const guide = await browser.attach(reopened.targetId);
    assert.ok(await until(() => guide.eval("document.querySelector('#headline')?.textContent")));
    t.check('已安装用户重看指南时直接显示使用步骤', await guide.eval(`
        document.querySelector('#headline').textContent === chrome.i18n.getMessage('welcomeGuideHeading')
        && document.querySelector('#agreement').hidden
        && document.querySelector('#agreeBtn').innerText === chrome.i18n.getMessage('welcomeClose')`));
    const onlyTabWindow = await browser.sw.eval("chrome.windows.create({url:chrome.runtime.getURL('install.html')}).then(win => win.id)");
    const standalone = await browser.waitPage(/\/install\.html$/);
    const retry = await browser.attach(standalone.targetId);
    assert.ok(await until(() => retry.eval("document.querySelector('#agreeBtn span')?.textContent")));
    await retry.eval("chrome.sidePanel.open = async () => { throw new Error('Unavailable in this window'); }");
    await click(retry, '#agreeBtn');
    assert.ok(await until(() => retry.eval("!document.querySelector('#panel-error').hidden && !document.querySelector('#agreeBtn').disabled && document.querySelector('#agreeBtn span').textContent === chrome.i18n.getMessage('welcomeAgree')")));
    t.check('浏览器拒绝打开侧栏时仍提供手动打开步骤', true);
    await click(retry, '#agreeBtn');
    assert.ok(await until(async () => !(await browser.pages(/\/install\.html$/)).length));
    t.check('欢迎页是窗口内最后一个标签时仍保留该窗口',
        await browser.sw.eval(`chrome.tabs.query({windowId:${onlyTabWindow}}).then(tabs => tabs.length === 1)`));
    await guide.send('Page.bringToFront');
    await click(guide, 'footer [data-copy=about]');
    const about = await browser.waitPage(/\/options\.html#anchorAbout$/);
    assert.ok(about, '使用指南打开本地关于页面');
    const options = await browser.attach(about.targetId);
    assert.ok(await until(() => options.eval("document.querySelector('#anchorAbout.active #version')?.textContent === 'Snag v' + chrome.runtime.getManifest().version")));
    const links = await options.eval(`({
        home:document.querySelector('#anchorAbout #project-home').href,
        manifest:chrome.runtime.getManifest().homepage_url,
        credit:document.querySelector('#anchorAbout [data-i18n=upstreamCredit]').href
    })`);
    assert.equal(links.home, 'https://github.com/syoosch/Snag');
    assert.equal(links.manifest, links.home);
    assert.equal(links.credit, 'https://github.com/xifangczy/cat-catch');
    t.check('关于页分别列出 Snag 的主页和上游署名', true);
    await browser.sw.eval("chrome.storage.sync.set({mqttTopic:'test/collection',onlineServiceAddress:'obsolete'})");
    const previousFiles = browser.files();
    await click(options, '.settings-nav a[href="#anchorOperation"]');
    await click(options, '#exportOptions');
    const backup = await browser.download(previousFiles, 10000);
    assert.ok(backup);
    const version = await browser.sw.eval('chrome.runtime.getManifest().version');
    const settings = JSON.parse(Buffer.from(backup.toString(), 'base64').toString('utf8'));
    assert.equal(settings.mqttTopic, 'test/collection');
    assert.ok(!Object.hasOwn(settings,'onlineServiceAddress'));
    const beforeImport = await options.eval('performance.timeOrigin');
    await options.eval(`(() => {
        window.alert = () => {};
        const data = new DataTransfer();
        data.items.add(new File([JSON.stringify({catDownload:true,mqttTopic:"restored/topic",onlineServiceAddress:"discard"})],'settings.txt'));
        const input = document.getElementById('importOptionsFile');
        input.files = data.files;
        input.dispatchEvent(new Event('change'));
    })()`);
    assert.ok(await until(() => browser.sw.eval('chrome.storage.sync.get(null).then(s => s.disableInternalDownloader === true && s.mqttTopic === "restored/topic" && s.onlineServiceAddress === "obsolete")')));
    // Import reloads settings after saving. Wait for that navigation before opening the help link.
    assert.ok(await until(() => options.eval(`performance.timeOrigin !== ${beforeImport} && document.readyState === 'complete'`)));
    t.check('旧设置文件可恢复下载偏好，导出与导入只包含现有功能',true);
    await options.send('Page.navigate',{url:browser.url('options.html#tag-help')});
    assert.ok(await until(() => options.eval("document.querySelector('#tag-help')?.open && document.querySelector('#tag-help').offsetHeight > 0")));
    t.check('设置中的模板帮助可直接在本地打开',true);
    const exported = browser.files().filter(file => !previousFiles.includes(file));
    t.check('导出的设置文件带有品牌名和版本', exported.some(file => file.startsWith('Snag-' + version + '-') && file.endsWith('.txt')), exported);
    t.check('欢迎页、指南和侧栏无未处理的脚本错误',
        ![...welcome.errors, ...guide.errors, ...retry.errors, ...panel.errors, ...options.errors].length, [...welcome.errors, ...guide.errors, ...retry.errors, ...panel.errors, ...options.errors]);
});
