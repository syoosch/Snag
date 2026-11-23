'use strict';

// Stream to private browser storage, then let the download manager save the
// completed file. Each writer owns a Web Lock until the download has finished.
const SnagStream = (() => {
    const folder = 'snag-streams-v1';
    const owned = /^part-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/;
    const lockName = (name,owner = folder) => owner + '/' + name;
    async function directory(create,owner = folder) {
        return (await navigator.storage.getDirectory()).getDirectoryHandle(owner,{create});
    }
    async function sweep() {
        if (!navigator.storage?.getDirectory || !navigator.locks) return;
        for (const owner of [folder,'framepick-streams-v1']) {
            let dir;
            try { dir = await directory(false,owner); }
            catch (e) { if (e.name === 'NotFoundError' || e.name === 'TypeMismatchError') continue; throw e; }
            for await (const name of dir.keys()) {
                if (!owned.test(name)) continue;
                await navigator.locks.request(lockName(name,owner),{ifAvailable:true},async lock => {
                    if (lock) await dir.removeEntry(name,{recursive:true}).catch(e => { if (e.name !== 'NotFoundError') throw e; });
                });
            }
        }
    }
    async function download(file,filename,saveAs,signal) {
        if (signal.aborted) throw signal.reason;
        const url = URL.createObjectURL(file);
        let listener, cancel;
        try {
            const id = await chrome.downloads.download({url,filename,saveAs,conflictAction:'uniquify'});
            await new Promise((resolve,reject) => {
                cancel = () => {
                    chrome.downloads.cancel(id).catch(() => {});
                    reject(signal.reason);
                };
                if (signal.aborted) { cancel(); return; }
                signal.addEventListener('abort',cancel,{once:true});
                const update = state => {
                    if (state === 'complete') resolve();
                    if (state === 'interrupted' || !state) reject(new Error('mediaSaveFailed'));
                };
                listener = change => { if (change.id === id && change.state) update(change.state.current); };
                chrome.downloads.onChanged.addListener(listener);
                chrome.downloads.search({id}).then(items => update(items[0]?.state),reject);
            });
        } finally {
            if (cancel) signal.removeEventListener('abort',cancel);
            if (listener) chrome.downloads.onChanged.removeListener(listener);
            URL.revokeObjectURL(url);
        }
    }
    function open(filename,saveAs = false) {
        const name = 'part-' + crypto.randomUUID();
        const cancellation = new AbortController();
        let ready, fail, release, file, out;
        const created = new Promise((resolve,reject) => { ready = resolve; fail = reject; });
        const finished = new Promise(resolve => { release = resolve; });
        const owner = navigator.locks.request(lockName(name),async () => {
            const dir = await directory(true);
            // Browsers can leave a writable file's swap file behind after a crash.
            // Keep both inside this writer's uniquely named directory.
            const work = await dir.getDirectoryHandle(name,{create:true});
            try {
                file = await work.getFileHandle('content',{create:true});
                out = await file.createWritable();
                ready();
                await finished;
            } finally {
                if (out) await out.abort().catch(() => {});
                await dir.removeEntry(name,{recursive:true});
            }
        });
        owner.catch(fail);
        async function dispose() { release(); await owner; }
        const writer = new WritableStream({
            start() { return created; },
            async write(chunk) {
                try { await out.write(chunk); }
                catch (error) { await dispose(); throw error; }
            },
            async close() {
                try {
                    await out.close();
                    out = null;
                    await download(await file.getFile(),filename,saveAs,cancellation.signal);
                } finally { await dispose(); }
            },
            abort:dispose
        }).getWriter();
        return {
            write: chunk => writer.write(chunk),
            close: () => writer.close(),
            abort() {
                cancellation.abort();
                return writer.abort();
            }
        };
    }
    return {open,sweep};
})();
