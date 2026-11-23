'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file));
const text = file => read(file).toString('utf8').replace(/\r\n/g, '\n');

function filesIn(directory) {
    return fs.readdirSync(path.join(root, directory), {withFileTypes: true}).flatMap(entry => {
        const file = directory + '/' + entry.name;
        return entry.isDirectory() ? filesIn(file) : [file];
    }).sort();
}

function digest(file) {
    // Git checks out text with different line endings on Windows and Unix.
    const data = /\.(?:[cm]?js|css|json|html|map|ya?ml|lock)$/i.test(file) ? text(file) : read(file);
    return createHash('sha256').update(data).digest('hex');
}

const libraries = Object.fromEntries(filesIn('lib').filter(file => !/\.md$/i.test(file)).map(file => [file, digest(file)]));
const rootFiles = fs.readdirSync(root, {withFileTypes: true}).filter(entry => entry.isFile()).map(entry => entry.name).sort();
const packages = Object.fromEntries(rootFiles.filter(file =>
    /^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(file)
).map(file => [file, digest(file)]));

const manifests = ['manifest.json', 'manifest.firefox.json'];
const errors = [];
const translations = JSON.parse(text('_locales/en/messages.json'));
for (const file of filesIn('_locales').filter(name => name.endsWith('/messages.json'))) {
    const messages = JSON.parse(text(file));
    if (messages.extensionName?.message !== 'Snag') errors.push(file + ' -> extensionName');
    for (const [key,entry] of Object.entries(messages)) {
        if (/拾[帧幀]|frame[ -]?pick/i.test(entry.message)) errors.push(file + ' -> ' + key);
        if (key !== 'upstreamCredit' && /猫抓|貓抓|笨猫猫|\bcat[ -]?catch(?:er)?\b/i.test(entry.message)) errors.push(file + ' -> ' + key);
    }
}
function checkFile(from, reference) {
    if (!reference || /^(?:[a-z][\w+.-]*:|\/\/|#|\?)/i.test(reference)) return;
    const file = reference.split(/[?#]/,1)[0].replace(/^\//,'');
    if (!fs.existsSync(path.join(root,file))) errors.push(from + ' -> ' + reference);
}
const packagedText = [
    ...rootFiles.filter(file => /\.(?:html|[cm]?js|css)$/i.test(file)), ...manifests,
    ...['js', 'catch-script', 'css', 'img', '_locales'].flatMap(filesIn).filter(file => /\.(?:[cm]?js|json|html|css|svg)$/i.test(file))
];
const hostReferences = {};
const externalEmbeds = {};
const retiredPublisher = /\b(?:94cat\.com|bmmmd\.com|o2bmm\.gitbook\.io|jfedfbgedapdagkghmgibemcoggfppbb|oohmdefbjalncfplafanlagojlakmjci|xifangczy@gmail\.com)\b/i;
const upstreamRepository = /(?:github\.com|raw\.githubusercontent\.com)\/xifangczy\/cat-catch\b/i;
for (const file of packagedText.sort()) {
    // Include links in examples and comments. Skip XML declarations and JS regex delimiters.
    const source = text(file).replace(/\bxmlns(?::[\w-]+)?\s*=\s*(["'])[^"']*\1|<!doctype[^>]*>/gi, '');
    // Only the attribution link in About points to the upstream repository.
    const outsideCredit = file === 'options.html'
        ? source.replace(/<a\b[^>]*\bdata-i18n="upstreamCredit"[^>]*>/i,
            tag => tag.replace('href="https://github.com/xifangczy/cat-catch"', ''))
        : source;
    if (retiredPublisher.test(source) || upstreamRepository.test(outsideCredit)) errors.push(file + ' -> 旧项目链接或标识');
    const hosts = new Set();
    for (const match of source.matchAll(/(?<!\\)(?:\b(?:https?|wss?):)?\/\/(localhost\b|(?:[a-z0-9-]+\.)+[a-z0-9-]+|\[[a-f0-9:]+\])/gi)) {
        hosts.add(match[1].toLowerCase());
    }
    // The MQTT client builds its address from separate settings.
    for (const match of source.matchAll(/\bmqttBroker\s*:\s*["']([^"']+)["']/g)) hosts.add(match[1].toLowerCase());
    if (hosts.size) hostReferences[file] = [...hosts].sort();
    if (/\.(?:html|svg)$/i.test(file)) {
        const loads = new Set();
        if (file.endsWith('.html')) {
            const html = source.replace(/<!--[\s\S]*?-->/g, '');
            for (const match of html.matchAll(/<(?:script|link|iframe|img|a|source|video|audio)\b[^>]*?\s(?:src|href|poster)=["']([^"']*)["']/gi)) checkFile(file,match[1]);
            for (const match of html.matchAll(/(?:data-i18n(?:-[\w-]+)?|data-copy)="(\w+)"|<i18n>(\w+)<\/i18n>/g)) {
                const key = match[1] || match[2];
                if (!translations[key]?.message) errors.push(file + ' -> ' + key);
            }
        }
        for (const tag of source.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(?:script|iframe|link|img|image|audio|video|source|use|embed|object)\b[^>]*>/gi)) {
            for (const attr of tag[0].matchAll(/\b(?:src|href|data|poster)\s*=\s*["']((?:https?:)?\/\/[^"']+)["']/gi)) loads.add(attr[1]);
        }
        if (loads.size) externalEmbeds[file] = [...loads].sort();
    }
}

const browserAccess = {};
const releaseVersion = JSON.parse(text('manifest.json')).version;
for (const file of manifests) {
    const manifest = JSON.parse(text(file));
    if (manifest.version !== releaseVersion) {
        errors.push(file + ' -> version');
    }
    const icons = [manifest.action?.default_icon, manifest.sidebar_action?.default_icon, manifest.icons]
        .flatMap(value => typeof value === 'string' ? [value] : Object.values(value || {}));
    for (const reference of [manifest.background?.service_worker, ...(manifest.background?.scripts || []),
        manifest.action?.default_popup, manifest.options_ui?.page, manifest.side_panel?.default_path, manifest.sidebar_action?.default_panel,
        ...icons, ...manifest.content_scripts.flatMap(entry => [...(entry.js || []), ...(entry.css || [])])]) {
        checkFile(file,reference);
    }
    for (const match of text(file).matchAll(/__MSG_(\w+?)__/g)) {
        if (!translations[match[1]]?.message) errors.push(file + ' -> ' + match[1]);
    }
    const access = {};
    for (const key of ['permissions', 'optional_permissions', 'host_permissions', 'optional_host_permissions']) {
        if (manifest[key]) access[key] = [...manifest[key]].sort();
    }
    for (const key of ['content_security_policy', 'externally_connectable', 'update_url']) {
        if (manifest[key]) access[key] = manifest[key];
    }
    access.contentScriptMatches = [...new Set((manifest.content_scripts || []).flatMap(entry => entry.matches))].sort();
    access.identity = {name:manifest.name, shortName:manifest.short_name, homepage:manifest.homepage_url};
    if (manifest.browser_specific_settings?.gecko?.id) access.identity.geckoId = manifest.browser_specific_settings.gecko.id;
    browserAccess[file] = access;
}

for (const error of errors) console.error('扩展检查未通过：' + error);
if (errors.length) process.exitCode = 1;
const current = {libraries, packages, hostReferences, externalEmbeds, browserAccess};
if (process.argv.includes('--print')) {
    console.log(JSON.stringify(current, null, 2));
} else {
    const expected = JSON.parse(text('tools/dependency-baseline.json'));
    for (const [section, entries] of Object.entries(current)) {
        for (const key of new Set([...Object.keys(entries), ...Object.keys(expected[section])])) {
            const before = expected[section][key], after = entries[key];
            if (JSON.stringify(before) === JSON.stringify(after)) continue;
            console.error(section + ' / ' + key, '\n  原记录', before ?? '（无）', '\n  当前', after ?? '（无）');
            process.exitCode = 1;
        }
    }
    if (process.exitCode) console.error('请核对来源及使用场景，并把实际变化记入项目的依赖清单。');
    else console.log('检查通过。页面入口、随包库、固定域名、扩展标识和权限均已核对。');
}
