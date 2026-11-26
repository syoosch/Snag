'use strict';

const mediaRuleBase = 1620000000, mediaRuleCount = 1000000;
function isMediaRuleId(id) { return id >= mediaRuleBase && id < mediaRuleBase + mediaRuleCount; }

// Privileged browser calls live here. The offscreen document owns OPFS, workers
// and blob URLs; opening or closing a sidebar never takes ownership of a file.
(() => {
    const hostUrl = chrome.runtime.getURL('media-host.html');
    const panelUrl = chrome.runtime.getURL('sidebar.html');
    const toolUrl = chrome.runtime.getURL('media-tool.html');
    const prefix = new URL(hostUrl).hostname;
    let creating;
    let nextRule = 0;
    const localRule = rule => isMediaRuleId(rule.id) &&
        rule.condition.initiatorDomains?.includes(prefix) && rule.condition.tabIds?.includes(-1);
    const send = body => chrome.runtime.sendMessage({mediaTarget:'host', ...body});
    const helperStore = chrome.storage.local;
    const helperKey = /^(?:snag|framepick)-youtube-(job-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/;
    function matchesHelper(address,expected) {
        try {
            const url = new URL(address), original = new URL(expected);
            return url.origin === original.origin && url.pathname === original.pathname &&
                url.searchParams.get('v') === original.searchParams.get('v') && url.hash === original.hash;
        } catch { return false; }
    }
    async function closeHelper(key) {
        const helper = (await helperStore.get(key))[key];
        if (!helper) return;
        const tab = await chrome.tabs.get(helper.tabId).catch(() => null);
        const address = tab?.pendingUrl || tab?.url;
        let owned = matchesHelper(address,helper.url) || address != null && address === helper.blank;
        if (tab && !owned && address?.startsWith('https://www.youtube.com/watch')) {
            const result = await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',args:[helperKey.exec(key)[1], key.startsWith('snag-')],
                func:(job,current) => (current ? window.__snagPullSegments : window.__framepickPullSegments)?.job === job}).catch(()=>[]);
            owned = result[0]?.result;
        }
        if (tab && owned) await chrome.tabs.remove(tab.id);
        else {
            // Browser session restore may assign a different tab ID.
            const tabs = await chrome.tabs.query({url:'https://www.youtube.com/watch*'});
            for (const other of tabs) if (matchesHelper(other.pendingUrl || other.url,helper.url)) await chrome.tabs.remove(other.id);
        }
        await helperStore.remove(key);
    }
    async function segmentHelper(m) {
        if (!/^job-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(m.job) || !/^[\w-]{11}$/.test(m.quality?.videoId)) throw new Error('mediaBadFile');
        const key = 'snag-youtube-' + m.job;
        if (m.op === 'segmentsClose') return closeHelper(key);
        if (m.op === 'segmentsOpen') {
            await closeHelper(key);
            const url = new URL('https://www.youtube.com/watch');
            url.searchParams.set('v',m.quality.videoId);
            url.searchParams.set('t','0s');
            url.hash = 'snag-segments=' + m.job;
            const blank = 'about:blank' + url.hash;
            const tab = await chrome.tabs.create({active:false,url:blank,windowId:m.windowId});
            try {
                await helperStore.set({[key]:{tabId:tab.id,url:url.href,blank}});
                await chrome.tabs.update(tab.id,{muted:true,url:url.href});
            } catch (error) { await chrome.tabs.remove(tab.id).catch(()=>{}); await helperStore.remove(key); throw error; }
            return;
        }
        const helper = (await helperStore.get(key))[key];
        if (!helper) throw new Error('mediaSegmentIncomplete');
        const tab = await chrome.tabs.get(helper.tabId).catch(() => null);
        if (!tab) throw new Error('mediaSegmentIncomplete');
        if (tab.url === helper.blank || !tab.url) return {waiting:true};
        const page = new URL(tab.url);
        if (page.origin !== 'https://www.youtube.com' || page.searchParams.get('v') !== m.quality.videoId) throw new Error('mediaSegmentUnavailable');
        const [reply] = await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},world:'MAIN',
            func:(job,quality,mode) => window.__snagPullSegments?.(job,quality,mode) || {waiting:true},args:[m.job,m.quality,m.mode]});
        return reply?.result || {waiting:true};
    }

    async function hasHost() {
        if (typeof document !== 'undefined') return !!document.getElementById('snag-media-host');
        if (chrome.runtime.getContexts) return !!(await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[hostUrl]})).length;
        return (await self.clients.matchAll({includeUncontrolled:true})).some(client => client.url === hostUrl);
    }
    async function ensureHost() {
        if (creating) return creating;
        creating = (async () => {
            if (!await hasHost()) {
                if (typeof document !== 'undefined') {
                    const frame = document.createElement('iframe');
                    frame.hidden = true; frame.id = 'snag-media-host'; frame.src = hostUrl;
                    document.documentElement.append(frame);
                } else {
                    await chrome.offscreen.createDocument({url:'media-host.html',reasons:['BLOBS'],justification:'Save and combine selected media locally while the sidebar is closed.'});
                }
            }
            for (let i = 0; i < 80; i++) {
                if ((await send({op:'ping'}).catch(() => null))?.ok) return;
                await new Promise(resolve => setTimeout(resolve,50));
            }
            throw new Error('mediaUnavailable');
        })().finally(() => { creating = null; });
        return creating;
    }
    async function headerRule(url, values) {
        const media = new URL(url);
        if (!/^https?:$/.test(media.protocol)) throw new Error('mediaSourceFailed');
        media.hash = '';
        const headers = Object.entries(values || {}).filter(([k,v]) => ['referer','origin','user-agent'].includes(k) && typeof v === 'string');
        if (!headers.length) return null;
        const rules = await chrome.declarativeNetRequest.getSessionRules();
        const used = new Set(rules.map(rule => rule.id));
        let id;
        do {
            id = mediaRuleBase + nextRule;
            nextRule = (nextRule + 1) % mediaRuleCount;
        } while (used.has(id));
        const match = /[|*^]/.test(media.href) ? {regexFilter:'^' + media.href.replace(/[.*+?^$(){}|[\]\\]/g,'\\$&') + '$'} :
            {urlFilter:'|' + media.href + '|'};
        await chrome.declarativeNetRequest.updateSessionRules({addRules:[{id,priority:2,
            condition:{...match,isUrlFilterCaseSensitive:true,initiatorDomains:[prefix],tabIds:[-1],resourceTypes:['xmlhttprequest']},
            action:{type:'modifyHeaders',requestHeaders:headers.map(([header,value]) => ({header,value,operation:'set'}))}
        }]}).catch(() => { throw new Error('mediaSourceFailed'); });
        return id;
    }
    async function bridge(m,sender) {
        const page = sender.url?.split(/[?#]/)[0];
        if (m.op === 'recordingAllowed') return ['catch.js','recorder.js'].some(name => G.scriptList.get(name)?.tabId.has(sender.tab?.id));
        if (page === hostUrl && !sender.tab) {
            switch (m.op) {
                case 'admit': return true;
                case 'dirty': await chrome.storage.local.set({snagMediaUsed:true}); return;
                case 'segmentsOpen':
                case 'segmentsPull':
                case 'segmentsClose': return segmentHelper(m);
                case 'clearRules': {
                    const keys = helperStore.getKeys ? await helperStore.getKeys() : Object.keys(await helperStore.get(null));
                    for (const key of keys) if (helperKey.test(key)) await closeHelper(key);
                    const rules = (await chrome.declarativeNetRequest.getSessionRules()).filter(localRule);
                    if (rules.length) await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:rules.map(r => r.id)});
                    return;
                }
                case 'headers': return headerRule(m.url,m.headers);
                case 'release':
                    if (isMediaRuleId(m.id))
                        await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[m.id]});
                    return;
                case 'save': {
                    if (!m.url.startsWith('blob:' + new URL(hostUrl).protocol + '//' + prefix + '/')) throw new Error('mediaSaveFailed');
                    return chrome.downloads.download({url:m.url,filename:m.name,saveAs:!!m.saveAs,conflictAction:'uniquify'});
                }
                case 'downloadState': {
                    const [item] = await chrome.downloads.search({id:m.id});
                    return item && {state:item.state,error:item.error};
                }
                case 'cancelSave': await chrome.downloads.cancel(m.id); return;
                case 'recordingRead':
                case 'recordingRelease': {
                    const {tabId,frameId,token} = m.source;
                    return chrome.tabs.sendMessage(tabId,{Message:m.op,token,offset:m.offset},{frameId});
                }
            }
        }
        if (page === toolUrl && m.op === 'warm') { await ensureHost(); return; }
        if (page !== panelUrl) throw new Error('mediaUnavailable');
        if (!['start','list','cancel','retry','clear'].includes(m.op)) throw new Error('mediaUnavailable');
        if (m.op === 'list' && !await hasHost() && !creating) return [];
        await ensureHost();
        const command = {op:m.op,id:m.id};
        if (m.op === 'start' || m.op === 'retry') command.request = m.request;
        const result = await send(command);
        if (!result?.ok) throw new Error(result?.error || 'mediaUnavailable');
        return result.value;
    }
    chrome.runtime.onMessage.addListener((m,sender,reply) => {
        if (m.Message === 'snagFFmpeg') {
            legacy(m,sender).then(() => reply('ok'),() => reply('error'));
            return true;
        }
        if (m.mediaTarget !== 'bridge') return;
        bridge(m,sender).then(value => reply({ok:true,value}), error => reply({ok:false,error:error.message}));
        return true;
    });
    async function legacy(m,sender) {
        if (m.action === 'openFFmpeg') return;
        const internal = sender.url?.startsWith(chrome.runtime.getURL(''));
        let files = m.files || [];
        if (!internal) {
            const id = sender.tab?.id;
            if (!id || !['catch.js','recorder.js'].some(name => G.scriptList.get(name)?.tabId.has(id))) throw new Error('mediaUnavailable');
            if (!['transcode','catchMerge'].includes(m.action) || files.length > 2) throw new Error('mediaBadFile');
            files = files.map(f => {
                if (!/^[\da-f-]{36}$/.test(f.token) || !Number.isSafeInteger(f.size) || f.size < 1) throw new Error('mediaBadFile');
                return {type:f.type,recording:{tabId:id,frameId:sender.frameId,token:f.token,size:f.size}};
            });
        }
        if (internal && m.action === 'addFile') {
            const tab = await chrome.tabs.create({url:toolUrl});
            for (let i=0; i<80; i++) {
                const ack = await chrome.runtime.sendMessage({mediaTarget:'manualInput',targetTab:tab.id,files}).catch(() => null);
                if (ack?.ok) return;
                await new Promise(resolve => setTimeout(resolve,50));
            }
            throw new Error('mediaUnavailable');
        }
        await ensureHost();
        const data = {action:m.action,quantity:m.quantity,taskId:m.taskId,files,title:m.title,output:m.output,
            tabId:internal ? m.tabId ?? sender.tab?.id : sender.tab.id,windowId:sender.tab?.windowId,saveAs:G.saveAs};
        const result = await send({op:'legacy',data});
        if (!result?.ok) throw new Error(result?.error || 'mediaUnavailable');
    }
    chrome.downloads.onChanged.addListener(event => {
        if (['complete','interrupted'].includes(event.state?.current)) send({op:'saved',id:event.id,state:event.state.current,error:event.error?.current}).catch(() => {});
    });
    const sweep = async () => {
        const flags = await helperStore.get(['snagMediaUsed','framepickMediaUsed']);
        if (flags.framepickMediaUsed) {
            await helperStore.set({snagMediaUsed:true});
            await helperStore.remove('framepickMediaUsed');
        }
        if ((flags.snagMediaUsed || flags.framepickMediaUsed) && !await hasHost()) await ensureHost();
    };
    chrome.runtime.onStartup.addListener(() => sweep().catch(console.warn));
    chrome.runtime.onInstalled.addListener(() => sweep().catch(console.warn));
    sweep().catch(console.warn);
})();
