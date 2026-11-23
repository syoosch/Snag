// 使用独立浏览器配置加载扩展并驱动测试页面。
// 只依赖 Node 自带的模块 不需要 npm install
'use strict';
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// 被测的扩展目录 默认是仓库根目录
const EXT = path.resolve(process.env.SNAG_EXT || path.join(__dirname, '..', '..'));
const FIXTURES = path.join(__dirname, '..', 'fixtures');
// 浏览器的界面语言 扩展的文字跟着它走 测试里的判断不要依赖某一种语言
const LANG = process.env.SNAG_LANG || 'zh-CN';

function findBrowser() {
    if (process.env.CHROME) { return process.env.CHROME; }
    let candidates;
    if (process.platform === 'win32') {
        const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
        const executables = ['Google/Chrome/Application/chrome.exe'];
        // Edge on Windows uses a WebSocket. Older Node versions can still test Chrome through a pipe.
        if (typeof WebSocket === 'function') executables.unshift('Microsoft/Edge/Application/msedge.exe');
        candidates = executables.flatMap(exe => roots.map(root => path.join(root,exe)));
    } else if (process.platform === 'darwin') {
        candidates = ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
    } else {
        candidates = ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge',
            '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];
    }
    const found = candidates.find(file => fs.existsSync(file));
    if (!found) throw new Error('找不到可用于测试的 Edge 或 Chrome。可以通过 CHROME 指定浏览器路径。');
    return found;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 反复执行 fn 直到返回真值或超时 返回最后一次的结果
async function until(fn, timeout = 8000, step = 200) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
        try { last = await fn(); if (last) { return last; } } catch (e) { last = undefined; }
        await sleep(step);
    }
    return last;
}
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

class CDP {
    constructor(proc,socket) {
        this.id = 0;
        this.pending = new Map();
        this.handlers = new Set();
        const receive = text => {
            const msg = JSON.parse(text);
            if (msg.id && this.pending.has(msg.id)) {
                const {resolve,reject,method} = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) reject(new Error(method + ': ' + msg.error.message));
                else resolve(msg.result);
            } else for (const handler of this.handlers) handler(msg);
        };
        const closed = () => {
            this.disconnected = true;
            for (const {reject} of this.pending.values()) reject(new Error('Test browser disconnected'));
            this.pending.clear();
        };
        if (socket) {
            this.write = text => socket.send(text);
            socket.onmessage = e => receive(e.data);
            socket.onclose = closed;
        } else {
            this.write = text => proc.stdio[3].write(text + '\0');
            let chunks = [];
            proc.stdio[3].on('error',closed);
            proc.stdio[4].on('error',closed);
            proc.stdio[4].on('end',closed);
            proc.stdio[4].on('data',chunk => {
                let start = 0;
                for (let i=0;i<chunk.length;i++) {
                    if (chunk[i] !== 0) continue;
                    chunks.push(chunk.subarray(start,i));
                    receive(Buffer.concat(chunks).toString('utf8'));
                    chunks = []; start = i+1;
                }
                if (start < chunk.length) chunks.push(chunk.subarray(start));
            });
        }
    }
    send(method, params = {}, sessionId) {
        if (this.disconnected) return Promise.reject(new Error('Test browser disconnected'));
        const id = ++this.id;
        const msg = { id, method, params };
        if (sessionId) { msg.sessionId = sessionId; }
        return new Promise((resolve,reject) => {
            this.pending.set(id,{resolve,reject,method});
            try { this.write(JSON.stringify(msg)); } catch (error) { this.pending.delete(id); reject(error); }
        });
    }
}
// 一个页面 / Service Worker
class Session {
    constructor(cdp, sessionId, targetId) {
        this.cdp = cdp;
        this.sessionId = sessionId;
        this.targetId = targetId;
        this.contexts = new Map();
        this.errors = [];   // 页面里没有捕获的异常
        cdp.handlers.add((msg) => {
            if (msg.sessionId !== sessionId) { return; }
            if (msg.method === 'Runtime.executionContextCreated') { this.contexts.set(msg.params.context.id, msg.params.context); }
            if (msg.method === 'Runtime.executionContextDestroyed') { this.contexts.delete(msg.params.executionContextId); }
            if (msg.method === 'Runtime.executionContextsCleared') { this.contexts.clear(); }
            if (msg.method === 'Runtime.exceptionThrown') { this.errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text); }
        });
    }
    send(method, params) { return this.cdp.send(method, params, this.sessionId); }
    async init(page = true, width = 1320, height = 900) {
        if (page) {
            await this.send('Page.enable');
            await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
            await this.send('Emulation.setFocusEmulationEnabled', { enabled: true });
            const { frameTree } = await this.send('Page.getFrameTree');
            this.mainFrame = frameTree.frame.id;
        }
        await this.send('Runtime.enable');
        return this;
    }
    // 在页面里执行表达式 返回它的值 (Promise 会等待) contextId 不指定时是页面自己的环境
    async eval(expression, contextId) {
        const params = { expression, returnByValue: true, awaitPromise: true };
        if (contextId) { params.contextId = contextId; }
        const result = await this.send('Runtime.evaluate', params);
        if (result.exceptionDetails) { throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); }
        return result.result.value;
    }
    // 扩展的 content-script 在主框架里的隔离环境
    isolated(extId) {
        for (const context of this.contexts.values()) {
            if (context.auxData?.type === 'isolated' && (context.origin || '').includes(extId) && context.auxData.frameId === this.mainFrame) { return context.id; }
        }
        return undefined;
    }
    async click(x, y) {
        await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
        await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    }
    close() { return this.cdp.send('Target.closeTarget', { targetId: this.targetId }).catch(() => { }); }
}

/**
 * 启动浏览器并加载扩展
 * @param {Object} options { profile: 用户资料目录 (不指定时用临时目录 结束后删除), headed: 显示窗口 }
 */
async function launch(options = {}) {
    const exe = findBrowser();
    const edgeSocket = process.platform === 'win32' && path.basename(exe).toLowerCase() === 'msedge.exe';
    if (edgeSocket && typeof WebSocket !== 'function') throw new Error('在 Windows 上测试 Edge 请使用 Node.js 22 或更高版本。');
    const profile = options.profile || fs.mkdtempSync(path.join(os.tmpdir(), 'snag-test-'));
    const downloads = path.join(profile, 'downloads');
    fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
    fs.mkdirSync(downloads, { recursive: true });
    const preferences = path.join(profile, 'Default', 'Preferences');
    fs.existsSync(preferences) || fs.writeFileSync(preferences, JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }));
    // On Windows Edge can relaunch and lose its inherited pipes. Only connect
    // to the loopback endpoint recorded in this test's isolated profile.
    const args = [
        `--user-data-dir=${profile}`, ...(edgeSocket ? ['--remote-debugging-address=127.0.0.1','--remote-debugging-port=0'] : ['--remote-debugging-pipe']), '--enable-unsafe-extension-debugging',
        '--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen',
        `--lang=${LANG}`, '--window-size=1320,1000',
        '--disable-features=Translate,OptimizationHints,MediaRouter', '--disable-sync', '--disable-component-update',
        // 测试不访问扩展的在线服务
        '--host-resolver-rules=MAP ffmpeg.bmmmd.com 127.0.0.1, MAP ffmpeg.94cat.com 127.0.0.1, MAP stream.bmmmd.com 127.0.0.1',
    ];
    if (!options.requireGesture) { args.push('--autoplay-policy=no-user-gesture-required'); }
    if (!options.headed) { args.push('--headless=new'); }
    // CI 的容器里没有沙箱需要的权限
    if (process.env.CI || (process.getuid && process.getuid() === 0)) { args.push('--no-sandbox', '--disable-dev-shm-usage'); }
    args.push('about:blank');
    // Linux 上界面语言由环境变量决定
    const proc = spawn(exe, args, { windowsHide:true,stdio:edgeSocket ? ['ignore','ignore','pipe'] : ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], env: { ...process.env, LANGUAGE: LANG.replace('-', '_') } });
    const exited = new Promise((resolve) => proc.on('exit', resolve));
    let startupLog = '';
    if (edgeSocket) proc.stderr.on('data',chunk => { startupLog = (startupLog + chunk).slice(-1600); });
    let socket;
    if (edgeSocket) {
        socket = await until(async () => {
            const [port,route] = fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').trim().split(/\r?\n/);
            if (!/^\d+$/.test(port) || !route.startsWith('/devtools/browser/')) return;
            const ws = new WebSocket('ws://127.0.0.1:' + port + route);
            return new Promise(resolve => { ws.onopen = () => resolve(ws); ws.onerror = () => resolve(null); });
        },10000);
        if (!socket) { proc.kill(); throw new Error('Edge test connection failed: ' + startupLog); }
    }
    const cdp = new CDP(proc,socket);
    const attach = async (targetId, page = true, width, height) => {
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
        return new Session(cdp, sessionId, targetId).init(page, width, height);
    };
    const open = async (url, width, height) => attach((await cdp.send('Target.createTarget', { url })).targetId, true, width, height);
    const targets = async () => (await cdp.send('Target.getTargets')).targetInfos;
    const remove = () => { options.profile || fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); };
    // 正常关闭
    const close = async () => {
        try { await Promise.race([cdp.send('Browser.close'), sleep(3000)]); } catch (e) { }
        await Promise.race([exited, sleep(3000)]);
        try { proc.kill(); } catch (e) { }
        try { remove(); } catch (e) { }
    };
    // 直接结束进程 模拟浏览器崩溃
    const kill = async () => {
        if (socket) {
            const {processInfo} = await cdp.send('SystemInfo.getProcessInfo');
            const main = processInfo.find(item => item.type === 'browser');
            if (!Number.isInteger(main?.id) || main.id <= 0) throw new Error('Missing isolated test browser PID');
            process.kill(main.id,'SIGKILL');
            await until(() => { try { process.kill(main.id,0); return false; } catch { return true; } },5000);
        } else proc.kill('SIGKILL');
        await Promise.race([exited, sleep(5000)]);
        await sleep(500);
    };
    // The "allow" DevTools override names Blob downloads after the URL UUID and
    // bypasses the extension's filename. Use the normal profile download path.
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true }).catch(() => { });
    const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: options.extensionPath || EXT });
    const worker = await until(async () => (await targets()).find((t) => t.type === 'service_worker' && t.url.includes(extId)), 10000);
    if (!worker) { throw new Error('扩展的后台没有启动'); }
    const sw = await attach(worker.targetId, false);
    await until(() => sw.eval('G.initSyncComplete && G.initLocalComplete'), 8000);
    const browser = { cdp, extId, sw, attach, open, targets, close, kill, downloads, profile };
    browser.url = (page) => `chrome-extension://${extId}/${page}`;
    // 等待打开符合条件的新页面 known 是之前已有的页面
    browser.waitPage = (test, known = [], timeout = 8000) => until(async () => (await targets()).find((t) => t.type == 'page' && test.test(t.url) && !known.includes(t.targetId)), timeout);
    browser.pages = async (test) => (await targets()).filter((t) => t.type == 'page' && test.test(t.url)).map((t) => t.targetId);
    // 等待下载目录里出现新文件 返回它的内容
    browser.download = async (before, timeout = 30000) => {
        const name = await until(() => fs.readdirSync(downloads).find((n) => !before.includes(n) && !n.endsWith('.crdownload') && !n.endsWith('.tmp')), timeout, 200);
        return name ? fs.readFileSync(path.join(downloads, name)) : null;
    };
    browser.files = () => fs.readdirSync(downloads);
    // 页面所在标签的 tabId (页面刚打开时地址还没更新 等一下)
    browser.tabId = (part) => until(() => sw.eval(`chrome.tabs.query({}).then(tabs => (tabs.find(tab => (tab.url || '').includes(${JSON.stringify(part)})) || {}).id)`), 5000);
    return browser;
}

/**
 * 本地测试站点
 * @param {Function} handler (req, res, url) 自己处理了返回 true 否则按 tests/fixtures 里的文件处理
 * @returns {Promise<{ origin, log, close }>} log 是收到的请求 [{ method, path, headers }]
 */
async function serve(handler) {
    const log = [];
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mp4': 'video/mp4', '.ts': 'video/mp2t', '.m3u8': 'application/vnd.apple.mpegurl', '.mpd': 'application/dash+xml' };
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        log.push({ method: req.method, path: url.pathname + url.search, headers: req.headers });
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.setHeader('Cache-Control', 'no-store');
        if (req.method == 'OPTIONS') { res.writeHead(204); res.end(); return; }
        try {
            if (handler && await handler(req, res, url)) { return; }
        } catch (e) { res.writeHead(500); res.end(String(e)); return; }
        const file = path.join(FIXTURES, path.basename(url.pathname));
        if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
        send(req, res, fs.readFileSync(file), types[path.extname(file)] || 'application/octet-stream');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { origin: `http://127.0.0.1:${server.address().port}`, log, close: () => server.close() };
}
// 返回数据 支持 Range (video 标签需要)
function send(req, res, data, type, headers = {}) {
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (range) {
        const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
        res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1, ...headers });
        res.end(data.subarray(start, end + 1));
        return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': data.length, ...headers });
    res.end(data);
}
const html = (res, text) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Snag test</title></head><body style="margin:0">${text}</body></html>`); return true; };
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name));

/**
 * 生成一个内容各不相同的 ts 切片: 真实的 ts 片段 + 若干空包 (PID 0x1FFF 解码器会忽略) 空包里写着编号
 * @param {Number} index 编号
 * @param {Number} size 追加的空包的大致字节数
 * @param {String} tag 区分不同资源的标记
 */
function segment(index, size = 1880, tag = '') {
    const count = Math.max(1, Math.round(size / 188));
    const packets = Buffer.alloc(count * 188, 0xff);
    for (let i = 0; i < count; i++) {
        packets.set([0x47, 0x1f, 0xff, 0x10], i * 188);
        packets.write(`${tag}#${index}#${i}`, i * 188 + 4, 'latin1');
    }
    return Buffer.concat([fixture('segment.ts'), packets]);
}

/**
 * 运行一组测试 负责启动和清理 输出结果 设置退出码
 * @param {String} name 名称
 * @param {Function} fn async (c) c.check(名称, 是否通过, 失败时输出的细节) c.skip(原因) c.defer(清理函数)
 */
async function test(name, fn) {
    const c = { total: 0, failed: 0, skipped: false, cleanup: [] };
    c.check = (title, ok, detail) => {
        c.total++;
        ok || c.failed++;
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${title}${!ok && detail !== undefined ? '\n      ' + JSON.stringify(detail).slice(0, 1500) : ''}`);
    };
    c.skip = (reason) => { c.skipped = true; console.log(`SKIP  ${reason}`); };
    c.defer = (fn) => { c.cleanup.push(fn); };
    console.log(`== ${name} ==`);
    try {
        await fn(c);
    } catch (e) {
        c.check('运行没有异常', false, String(e.stack || e));
    }
    for (const fn of c.cleanup.reverse()) { try { await fn(); } catch (e) { } }
    console.log(c.skipped && !c.total ? '已跳过' : `${c.total - c.failed}/${c.total} 通过`);
    // 整组都跳过时退出码是 77 run.js 据此统计
    process.exit(c.failed ? 1 : (c.skipped && !c.total ? 77 : 0));
}

// Fulfil test requests with fixtures inside this browser target, including official-domain routes.
async function intercept(session, patterns, response) {
    session.cdp.handlers.add(message => {
        if (message.sessionId !== session.sessionId || message.method !== 'Fetch.requestPaused') return;
        const {requestId,request} = message.params;
        const [type,body,status = 200] = response(new URL(request.url),request);
        session.send('Fetch.fulfillRequest',{requestId,responseCode:status,
            responseHeaders:[{name:'Content-Type',value:type},{name:'Access-Control-Allow-Origin',value:'*'},
                {name:'Content-Length',value:String(Buffer.byteLength(body))}],
            body:Buffer.from(body).toString('base64')}).catch(() => {});
    });
    await session.send('Fetch.enable',{patterns:patterns.map(urlPattern => ({urlPattern}))});
}

module.exports = { EXT, launch, serve, send, html, fixture, segment, test, sleep, until, sha256, intercept };
