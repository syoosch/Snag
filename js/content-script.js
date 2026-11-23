(function () {
    var _key = new Set();
    var m3u8Text = new Map();
    const recordings = new Map();
    function release(token) {
        const item = recordings.get(token);
        if (item) { clearTimeout(item.timer); recordings.delete(token); }
    }
    function touch(token,item) {
        clearTimeout(item.timer);
        item.timer = setTimeout(() => release(token),600000);
    }
    async function shareRecording(data) {
        if (!['transcode','catchMerge'].includes(data.use) || !Array.isArray(data.files) || !data.files.length || data.files.length > 2) return;
        const allowed = await chrome.runtime.sendMessage({mediaTarget:'bridge',op:'recordingAllowed'});
        if (!allowed?.value) return;
        const files = [];
        for (const f of data.files) {
            let blob = f.data;
            if (typeof blob === 'string' && blob.startsWith('blob:' + location.origin + '/')) {
                const url = blob;
                try { blob = await (await fetch(url)).blob(); } finally { URL.revokeObjectURL(url); }
            }
            if (!(blob instanceof Blob) || !blob.size) return;
            const token = crypto.randomUUID(), item = {blob};
            recordings.set(token,item); touch(token,item);
            files.push({token,size:blob.size,type:f.type});
        }
        const sent = await chrome.runtime.sendMessage({Message:'snagFFmpeg',action:data.use,files,title:data.title || document.title});
        if (sent !== 'ok') for (const f of files) release(f.token);
    }
    chrome.runtime.onMessage.addListener(function (Message, sender, sendResponse) {
        if (chrome.runtime.lastError) { return; }
        if (Message.Message == "getKey") {
            sendResponse(Array.from(_key));
            return true;
        }
        if (Message.Message === "recordingRead" || Message.Message === "recordingRelease") {
            if (sender.id !== chrome.runtime.id || sender.tab) return;
            const item = recordings.get(Message.token);
            if (!item) { sendResponse(null); return; }
            if (Message.Message === "recordingRelease") { release(Message.token); sendResponse(true); return; }
            const offset = Message.offset;
            if (!Number.isSafeInteger(offset) || offset < 0 || offset >= item.blob.size) { sendResponse(null); return; }
            touch(Message.token,item);
            const reader = new FileReader();
            reader.onload = () => sendResponse(reader.result.split(",")[1]);
            reader.onerror = () => sendResponse(null);
            reader.readAsDataURL(item.blob.slice(offset,offset + 512 * 1024));
            return true;
        }
        if (Message.Message == "getPage") {
            if (Message.find) {
                const DOM = document.querySelector(Message.find);
                DOM ? sendResponse(DOM.innerHTML) : sendResponse("");
                return true;
            }
            sendResponse(document.documentElement.outerHTML);
            return true;
        }
        if (Message.Message == "getM3u8Text") {
            if (Message.url && m3u8Text.has(Message.url)) {
                sendResponse(m3u8Text.get(Message.url));
                return true;
            }
            sendResponse("");
            return true;
        }
        if (Message.Message == "getM3u8Cache") {
            fetch(Message.url, { method: "GET", cache: "force-cache" })
                .then(response => response.text())
                .then(text => sendResponse({ success: true, data: text }))
                .catch(() => sendResponse({ success: false, error: "Failed to fetch" }));
            return true;
        }
    });

    // Heart Beat
    var Port;
    function connect() {
        Port = chrome.runtime.connect(chrome.runtime.id, { name: "HeartBeat" });
        Port.postMessage("HeartBeat");
        Port.onMessage.addListener(function (message, Port) { return true; });
        Port.onDisconnect.addListener(connect);
    }
    connect();

    const isFirefox = navigator.userAgent.includes('Firefox');
    const sendAddMedia = (data) => {
        chrome.runtime.sendMessage({
            Message: "addMedia",
            url: data.url,
            href: data.href ?? location.href,
            extraExt: data.ext,
            mime: data.mime,
            requestHeaders: { referer: data.referer },
            requestId: data.requestId
        });
    };
    window.addEventListener("message", (event) => {
        const action = ["snagAddMedia", "snagAddKey", "snagFFmpeg", "snagCloseScript"];
        if (!event.data || !event.data.action || event.origin !== window.location.origin || !action.includes(event.data.action)) { return; }
        event.stopPropagation();
        event.stopImmediatePropagation();

        if (event.data.action == "snagAddMedia") {
            if (!event.data.url) { return; }

            /*
             * firefox 不允许直接下载跨域blob内容
             * fetch获取文本内容并缓存到m3u8Text中，供 m3u8.html调用获取。
             */
            if (event.data.url.startsWith("blob:") && isFirefox) {
                fetch(event.data.url)
                    .then(response => response.text())
                    .then(text => {
                        m3u8Text.set(event.data.url, text);
                        sendAddMedia(event.data);
                    });
                return;
            }
            sendAddMedia(event.data);
        }
        if (event.data.action == "snagAddKey") {
            let key = event.data.key;
            if (key instanceof ArrayBuffer || key instanceof Array) {
                key = ArrayToBase64(key);
            }
            if (_key.has(key)) { return; }
            _key.add(key);
            chrome.runtime.sendMessage({
                Message: "send2local",
                action: "addKey",
                data: key,
            });
            chrome.runtime.sendMessage({
                Message: "popupAddKey",
                data: key,
                url: event.data.url,
            });
        }
        if (event.data.action === "snagFFmpeg" && event.source === window) {
            shareRecording(event.data).catch(() => {});
        }
        if (event.data.action == "snagCloseScript") {
            if (!event.data.script || !event.isTrusted) { return; }
            chrome.runtime.sendMessage({ Message: "closeScript", ...event.data });
        }

    }, { capture: true });

    function ArrayToBase64(data) {
        try {
            let bytes = new Uint8Array(data);
            let binary = "";
            for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            if (typeof _btoa == "function") {
                return _btoa(binary);
            }
            return btoa(binary);
        } catch (e) {
            return false;
        }
    }
})();
