'use strict';

const channel = new BroadcastChannel('snag-media-tool-v1');
const pending = new Map();
const picker = document.getElementById('files'), label = document.getElementById('feedback');
const actions = document.getElementById('tool-actions');
let ownTabId;
chrome.tabs.getCurrent().then(tab => { ownTabId = tab?.id; });
let imported = [], activeId, expiry;
const stateKeys = {downloading:'sideDownloading',processing:'mediaMerging',saving:'mediaSaving',done:'downloaded'};
function buttons() {
    const count = imported.length || picker.files.length;
    for (const b of actions.querySelectorAll('button')) b.disabled = !count || count > 2 || (count === 2 && b.dataset.action !== 'merge');
}
picker.onchange = () => { clearTimeout(expiry); imported = []; label.textContent = ''; buttons(); };
buttons();
async function submit(request) {
    const ready = await chrome.runtime.sendMessage({mediaTarget:'bridge',op:'warm'});
    if (!ready?.ok) throw new Error('mediaUnavailable');
    const id = crypto.randomUUID();
    const received = new Promise((resolve,reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('mediaUnavailable')); },30000);
        pending.set(id,{resolve,reject,timer});
    });
    channel.postMessage({op:'localInput',id,request});
    return received;
}
channel.onmessage = ({data}) => {
    const ack = pending.get(data.reply);
    if (!ack) return;
    pending.delete(data.reply); clearTimeout(ack.timer);
    if (data.error) ack.reject(new Error(data.error)); else ack.resolve(data.value);
};
async function run(data) {
    const task = await submit(data);
    if (task) { activeId = task.id; clearTimeout(expiry); imported = []; picker.value = ''; buttons(); label.textContent = i18n.sideDownloading; }
}
function showError(e) { label.textContent = i18n[e.message] || i18n.mediaBadFile; }
async function importFiles(files) {
    const next = [];
    for (const f of files) {
        let data = f.data;
        if (typeof data === 'string' && data.startsWith('blob:' + location.origin + '/')) {
            const url = data;
            try { data = await (await fetch(url)).blob(); } finally { URL.revokeObjectURL(url); }
        }
        if (!(data instanceof Blob)) throw new Error('mediaBadFile');
        next.push({...f,data});
    }
    imported = next;
    clearTimeout(expiry); expiry = setTimeout(() => { imported = []; label.textContent = ''; buttons(); },600000);
    label.textContent = next.map(f => f.name).join(' · '); buttons();
}
for (const b of actions.querySelectorAll('button')) b.onclick = () => {
    const files = imported.length ? imported : [...picker.files].map((data,index) => ({data,name:data.name,index}));
    run({action:b.dataset.action,files,quantity:files.length,title:files[0]?.name}).catch(showError);
};
window.addEventListener('message',e => {
    if (parent === self || e.source !== parent || e.origin !== location.origin || !e.data?.action) return;
    if (e.data.action === 'addFile') {
        importFiles([{data:e.data.data,name:e.data.name || e.data.title}]).catch(showError); return;
    }
    run(e.data).catch(showError);
});
chrome.runtime.onMessage.addListener((m,sender,reply) => {
    if (m.mediaTarget === 'sidebar') {
        const current = m.jobs.find(j => j.id === activeId);
        if (current) label.textContent = i18n[current.error || stateKeys[current.state]] || '';
    }
    if (m.mediaTarget === 'manualInput' && m.targetTab === ownTabId && sender.id === chrome.runtime.id && !sender.tab) {
        importFiles(m.files).then(() => reply({ok:true}),() => reply(null));
        return true;
    }
});
