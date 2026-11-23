// url 参数解析
const params = new URL(location.href).searchParams;
const _requestId = params.get("requestId") ? params.get("requestId").split(",") : [];   // 要下载得资源ID
const _JSON = params.get("JSON") ? JSON.parse(params.get("JSON")) : null;   // 直接传递数据的参数
const _ffmpeg = params.get("ffmpeg");   // 启用本机 FFmpeg
const transferKey = /^sidebarTransfer-[a-f\d-]{36}$/.test(params.get("transfer") || "") ? params.get("transfer") : null;
const sidebarMerge = _ffmpeg === "merge" && !!transferKey;
let _downStream = params.get("downStream"); // 启用边下边存 流式下载
const _autoClose = params.get("autoClose"); // 下载完成后自动关闭页面
const _data = [];   // 通过_requestId获取得到得数据
const _taskId = Date.parse(new Date()); // 配合ffmpeg使用的任务ID 以便本机 FFmpeg 通过ID知道文件属于哪些任务
let _tabId = null;  // 当前页面tab id
let _index = null;  // 当前页面 tab index

// 是否表单提交下载 表单提交 不使用自定义文件名
const downloadData = localStorage.getItem('downloadData') ? JSON.parse(localStorage.getItem('downloadData')) : [];

let iframeFFmpeg = null; // iframe FFmpeg窗口对象
let iframeFFmpegReady = false; // iframe FFmpeg是否准备就绪
function mergeStatus(text) {
    const status = document.getElementById("merge-status");
    status.hidden = false;
    status.textContent = text;
}

if (_JSON) {
    _data.push(_JSON);
}

awaitG(() => {
    loadCSS();
    // 获取当前标签信息
    chrome.tabs.getCurrent(async function (tabs) {
        _tabId = tabs.id;
        _index = tabs.index;

        if (transferKey) {
            const store = chrome.storage.session ?? chrome.storage.local;
            const saved = sessionStorage.getItem(transferKey);
            const records = saved ? JSON.parse(saved) : (await store.get(transferKey))[transferKey];
            if (sidebarMerge && (!Array.isArray(records) || records.length !== 2 || records.some(file => !file?.url))) {
                mergeStatus(i18n.mergeMissingFiles);
                $("#stopDownload").hide();
                return;
            }
            if (Array.isArray(records) && records.length) {
                sessionStorage.setItem(transferKey, JSON.stringify(records));
                await store.remove(transferKey);
                _data.push(...records);
                setHeaders(_data, start, _tabId, sidebarMerge ? () => mergeStatus(i18n.mergeSetupFailed) : undefined);
                return;
            }
        }

        // 如果没有requestId 显示 提交表单
        if (!_requestId.length && !_JSON) {
            $("#downStream").prop("checked", G.downStream);
            $("#getURL, .newDownload").toggle();
            $("#getURL_btn").click(function () {
                const data = [{
                    url: $("#getURL #url").val().trim(),
                    requestId: 1,
                }];

                // 处理请求头 如果是url直接放入referer 支持json格式
                const referer = $("#getURL #referer").val().trim();
                if (referer) {
                    if (referer.startsWith("http")) {
                        data[0].requestHeaders = { referer: referer };
                    } else {
                        data[0].requestHeaders = JSONparse(referer);
                    }
                }

                _downStream = $("#downStream").prop("checked");
                _data.push(...data);
                setHeaders(data, start, _tabId);
                $("#getURL, .newDownload").toggle();
            });
            return;
        }

        // 优先从downloadData 提取任务数据
        for (let item of downloadData) {
            if (_requestId.includes(item.requestId)) {
                _data.push(item);
                _requestId.splice(_requestId.indexOf(item.requestId), 1);
            }
        }
        if (!_requestId.length) {
            setHeaders(_data, start, _tabId);
            return;
        }

        // downloadData 不存在 从后台获取数据
        chrome.runtime.sendMessage({ Message: "getData", requestId: _requestId }, function (data) {
            if (data == "error" || !Array.isArray(data) || chrome.runtime.lastError || data.length == 0) {
                alert(i18n.dataFetchFailed);
                return;
            }
            _data.push(...data);
            setHeaders(data, start, _tabId);
        });
    });
});

const createIframeFFmpeg = (callback) => {
    if (!iframeFFmpeg) {
        iframeFFmpeg = document.createElement('iframe');
        iframeFFmpeg.addEventListener("load",function () {
            iframeFFmpegReady = true;
            callback && callback();
        },{once:true});
        iframeFFmpeg.src = G.ffmpegConfig.url + '?_=iframe';
        document.querySelector("#iframeBox").appendChild(iframeFFmpeg);
    }
    return iframeFFmpeg;
}

function start() {
    // 提前打开ffmpeg页面
    if (_ffmpeg && G.iframeFFmpeg && !sidebarMerge) {
        createIframeFFmpeg();
    }

    $("#autoClose").prop("checked", _autoClose || G.downAutoClose);

    const $downBox = $("#downBox"); // 下载列表容器
    const down = new Downloader(_data);  // 创建下载器 
    const itemDOM = new Map();  // 提前储存需要平凡操作的dom对象 提高效率
    const receipts = new Set();
    let receiptTimer, mergeFinished = false;
    const retryMerge = document.getElementById("retry-merge");
    if (sidebarMerge) {
        $("#downfile h1").text(_data[0].title || i18n.sideMerge);
        mergeStatus(i18n.mergePreparing);
    }

    // Keep both original buffers until the tool acknowledges the pair. A failed handoff can be retried without downloading again.
    function submitPair() {
        clearTimeout(receiptTimer);
        receipts.clear();
        retryMerge.hidden = true;
        mergeStatus(i18n.mergeSending);
        const title = stringModify(_data[0].title) || "video";
        const files = down.fragments.map(file => {
            const blob = ArrayBufferToBlob(down.buffer[file.index],{type:file.contentType});
            return {index:file.index,type:file.trackKind || (file.index ? "audio" : "video"),name:getUrlFileName(file.url),
                data:G.isFirefox ? blob : URL.createObjectURL(blob)};
        });
        chrome.runtime.sendMessage({Message:"snagFFmpeg",action:"merge",taskId:crypto.randomUUID(),
            tabId:_tabId,quantity:files.length,files,title}).then(reply => {
            if (reply !== "ok") { mergeStatus(i18n.mediaBadFile); retryMerge.hidden = false; }
        }).finally(() => { for (const f of files) if (typeof f.data === "string") URL.revokeObjectURL(f.data); });
        receiptTimer = setTimeout(() => {
            if (receipts.size === down.total) return;
            mergeStatus(i18n.mergeUnconfirmed);
            retryMerge.hidden = false;
        },25000);
    }
    retryMerge.onclick = () => { if (!retryMerge.hidden) submitPair(); };

    function watchForData(fragment) {
        if (!sidebarMerge) return;
        const item = itemDOM.get(fragment.index);
        clearTimeout(item.idleTimer);
        item.idleTimer = setTimeout(() => {
            down.stop(fragment.index);
            item.downFileProgress(i18n.mergeNoProgress);
            item.button.text(i18n.retryDownload).data("action","start").show();
            mergeStatus(i18n.mergeDownloadFailed);
        },30000);
    }

    // 添加html
    const addHtml = (fragment) => {
        if (!fragment.downFileName) {
            fragment.downFileName = getUrlFileName(fragment.url);
        }
        const html = $(`<div class="downItem">
                            <div class="explain"></div>
                            <div class="down-file-progress"></div>
                            <div class="progress-container">
                            <div class="progress-wrapper">
                                <div class="progress-bar">
                                <div class="progress"></div>
                                <span class="progress-text" data-text="0%">0%</span>
                                </div>
                            </div>
                            <button class="cancel-btn">${i18n.stopDownload}</button>
                            </div>
                        </div>`);

        const role = fragment.trackKind || (fragment.index ? "audio" : "video");
        html.find(".explain").text(sidebarMerge ? i18n(role) + " · " + fragment.downFileName : fragment.downFileName);
        const $button = html.find("button");
        $button.data("action", "stop");

        // 操作对象放入itemDOM 提高效率
        itemDOM.set(fragment.index, {
            _downFileProgress: html.find(".down-file-progress"),
            _progressBar: html.find(".progress-bar"),
            _progressText: html.find(".progress-text"),
            downFileProgress(text) {
                this._downFileProgress.text(text);
                return this;
            },
            progress(progress) {
                const percentage = `${progress}%`;
                this._progressBar.css("--progress", percentage);
                this._progressText
                    .text(percentage)
                    .attr("data-text", percentage);
                return this;
            },
            button: $button
        });

        $button.click(function () {
            const action = $(this).data("action");
            if (action == "stop") {
                clearTimeout(itemDOM.get(fragment.index).idleTimer);
                down.stop(fragment.index);
                $(this).html(i18n.retryDownload).data("action", "start");
                abortStream(fragment);
            } else if (action == "start") {
                down.state = "waiting";
                if (sidebarMerge) {
                    delete fragment.retry;
                    mergeStatus(i18n.mergePreparing);
                }
                down.downloader(fragment);
                $(this).html(i18n.stopDownload).data("action", "stop");
            }
        });
        $downBox.append(html);

        fragment.streamToDisk = (_downStream || G.downStream) && !_ffmpeg;
    }
    function abortStream(fragment) {
        const writer = fragment.fileStream;
        fragment.fileStream = null;
        writer?.abort().catch(() => {});
    }

    // 下载列表添加对应html
    down.fragments.forEach(addHtml);

    // 文件进程事件
    down.on('itemProgress', function (fragment, state, receivedLength, contentLength, value) {
        const $dom = itemDOM.get(fragment.index);
        if (!state && Date.now() - ($dom.lastEmitted || 0) >= 100) {
            watchForData(fragment);
            const received = byteToSize(receivedLength) || receivedLength + " B";
            const text = contentLength ?
                `${received} / ${byteToSize(contentLength) || contentLength + " B"}` : received;
            if (contentLength) $dom.progress((receivedLength / contentLength * 100).toFixed(2));
            else $dom._progressText.text(text).attr("data-text",text);
            $dom.downFileProgress(text);
            if (down.total == 1) { document.title = text; }
            $dom.lastEmitted = Date.now();
        }
    });

    // 单文件下载完成事件
    down.on('completed', function (buffer, fragment) {
        const $dom = itemDOM.get(fragment.index);
        clearTimeout($dom.idleTimer);
        $dom.progress(100).downFileProgress(i18n.downloadComplete);
        $dom.button.html(i18n.sendFfmpeg).data("action", "sendFfmpeg");
        document.title = `${down.success}/${down.total}`;
        $dom.button.hide();

        // 是流式下载 停止写入
        if (fragment.streamToDisk) {
            fragment.fileStream = null;
            return;
        }

        if (sidebarMerge) {
            $dom.downFileProgress(i18n.mergeFileReady);
            return;
        }
        // 转为blob
        const blob = ArrayBufferToBlob(buffer, { type: fragment.contentType });

        // 发送到ffmpeg
        if (_ffmpeg) {
            sendFile(_ffmpeg, blob, fragment);
            $dom.downFileProgress(i18n.sendFfmpeg);
            return;
        }

        $dom.downFileProgress(i18n.saving);
        // 直接下载
        chrome.downloads.download({
            url: URL.createObjectURL(blob),
            filename: fragment.downFileName,
            saveAs: G.saveAs
        }, function (downloadId) {
            fragment.downId = downloadId;
        });
    });

    // 全部下载完成事件
    down.on('allCompleted', function (buffer) {
        $("#stopDownload").hide();
        if (sidebarMerge) {
            submitPair();
            return;
        }

        // 检查 down.fragments 是否都为边下边存 检查自动关闭
        if (down.fragments.every(item => item.streamToDisk) && $("#autoClose").prop("checked")) {
            setTimeout(() => {
                closeTab();
            }, Math.ceil(Math.random() * 999));
        }
    });

    // 错误处理
    down.on('downloadError', function (fragment, error) {
        abortStream(fragment);
        clearTimeout(itemDOM.get(fragment.index).idleTimer);
        // 添加range请求头 重新尝试下载
        if (!fragment.retry?.Range && error?.cause == "HTTPError") {
            fragment.retry = { "Range": "bytes=0-" };
            down.stop(fragment.index);
            down.downloader(fragment);
            return;
        }
        // 添加sec-fetch 再次尝试下载
        if (!sidebarMerge && !fragment.retry?.sec && error?.cause == "HTTPError") {
            fragment.retry.sec = true;
            if (!fragment.requestHeaders) { fragment.requestHeaders = {}; }
            fragment.requestHeaders = { ...fragment.requestHeaders, "sec-fetch-mode": "no-cors", "sec-fetch-site": "same-site" };
            setHeaders(fragment, () => { down.stop(fragment.index); down.downloader(fragment); }, _tabId);
            return;
        }
        const item = itemDOM.get(fragment.index);
        item.downFileProgress(String(error));
        item.button.text(i18n.retryDownload).data("action","start").show();
        if (sidebarMerge) {
            mergeStatus(i18n.mergeDownloadFailed);
            return;
        }
        chrome.tabs.highlight({ tabs: _index });
    });

    // 开始下载事件 如果存在range重下标记 则添加 range 请求头
    down.on('start', function (fragment, options) {
        if (fragment.streamToDisk) fragment.fileStream = SnagStream.open(fragment.downFileName,G.saveAs);
        watchForData(fragment);
        if (fragment.retry) {
            options.headers = {Range:fragment.retry.Range};
            options.cache = "no-cache";
        }
    });

    // 全部停止下载按钮
    $("#stopDownload").click(function () {
        down.stop();
        // 更新对应的按钮状态
        itemDOM.forEach((item, index) => {
            clearTimeout(item.idleTimer);
            if (item.button.data("action") == "stop") {
                item.button.html(i18n.retryDownload).data("action", "start");
                abortStream(down.fragments[index]);
            }
        });
    });

    // 打开下载目录
    $(".openDir").click(function () {
        if (down.fragments[0].downId) {
            chrome.downloads.show(down.fragments[0].downId);
            return;
        }
        chrome.downloads.showDefaultFolder();
    });

    // 监听事件
    chrome.runtime.onMessage.addListener(function (Message, sender, sendResponse) {
        if (!Message.Message) { return; }

        // 外部添加下载任务
        if (Message.Message == "openDownloader" && Message.data && Array.isArray(Message.data)) {
            // ffmpeg任务的下载器 不允许添加新任务
            if (_ffmpeg) {
                sendResponse({ message: "FFmpeg", tabId: _tabId });
                return;
            }
            setHeaders(Message.data, () => {
                for (let fragment of Message.data) {
                    // 检查fragment是否已经存在
                    if (down.fragments.find(item => item.requestId == fragment.requestId)) {
                        continue;
                    }

                    _data.push(fragment);
                    down.push(fragment);
                    addHtml(fragment);

                    // 修改url requestId 参数
                    const url = new URL(location.href);
                    url.searchParams.set("requestId", down.fragments.map(item => item.requestId).join(","));
                    history.replaceState(null, null, url);

                    // 数据储存到localStorage
                    downloadData.push(fragment);
                    localStorage.setItem('downloadData', JSON.stringify(downloadData));

                    // 正在运行的下载任务小于线程数 则开始下载
                    if (down.running < down.thread) {
                        // down.downloader(fragment.index);
                        down.downloader();
                    }
                };
            }, _tabId);
            sendResponse({ message: "OK", tabId: _tabId });
            return;
        }

        // 以下为本机 FFmpeg 返回结果
        if (Message.Message != "snagFFmpegResult" || _tabId == 0 || Message.tabId != _tabId) { return; }
        if (sidebarMerge) {
            if (sender.url !== chrome.runtime.getURL("media-host.html")) return;
            if (mergeFinished) return;
            if (Message.state === "ok" && itemDOM.has(Message.index)) {
                receipts.add(Message.index);
                itemDOM.get(Message.index).downFileProgress(i18n.hasSent);
                if (receipts.size === down.total) {
                    clearTimeout(receiptTimer);
                    retryMerge.hidden = true;
                    down.buffer.length = 0;
                    mergeStatus(i18n.mergeProcessing);
                }
            }
            if (Message.state === "done") {
                mergeFinished = true;
                clearTimeout(receiptTimer);
                retryMerge.hidden = true;
                down.buffer.length = 0;
                mergeStatus(i18n.mergeFinished);
                document.title = i18n.mergeFinished;
                if ($("#autoClose").prop("checked")) setTimeout(closeTab,1000);
            }
            return;
        }

        // 发送状态提示
        if (Message.state == "ok") {
            const $dom = itemDOM.get(Message.index);
            $dom && $dom.downFileProgress(i18n.hasSent);
            down.buffer[Message.index] = null; //清空buffer
        }

        // 全部发送完成 检查自动关闭
        if (down.success == down.total && Message.state == "done") {
            if ($("#autoClose").prop("checked")) {
                setTimeout(() => {
                    closeTab();
                }, 1000);
            }
        }
    });

    // 监听下载事件 下载完成 关闭窗口
    chrome.downloads.onChanged.addListener(function (downloadDelta) {
        if (!downloadDelta.state || downloadDelta.state.current != "complete") { return; }

        // 检查id是否本页面提交的下载
        const fragment = down.fragments.find(item => item.downId == downloadDelta.id);
        if (!fragment) { return; }

        down.buffer[fragment.index] = null; //清空buffer

        // 更新下载状态
        itemDOM.get(fragment.index).downFileProgress(i18n.downloadComplete);

        // 完成下载 检查自动关闭
        if (down.success == down.total) {
            document.title = i18n.downloadComplete;
            if ($("#autoClose").prop("checked")) {
                setTimeout(() => {
                    closeTab();
                }, 1000);
            }
        }
    });

    // 关闭页面 检查关闭所有未完成的下载流
    window.addEventListener('beforeunload', function (e) {
        const fileStream = down.fragments.filter(item => item.fileStream);
        if (fileStream.length) {
            e.preventDefault();
        }
    });
    window.addEventListener('pagehide', () => down.fragments.forEach(abortStream));

    document.title = `${down.success}/${down.total}`;
    down.start();
}

/**
 * 发送数据到本机 FFmpeg
 * @param {String} action 发送类型
 * @param {ArrayBuffer|Blob} data 数据内容
 * @param {Object} fragment 数据对象
 */
function sendFile(action, data, fragment) {
    // 转 blob
    if (data instanceof ArrayBuffer) {
        data = ArrayBufferToBlob(data, { type: fragment.contentType });
    }

    // 嵌套本机 FFmpeg 模式
    if (G.iframeFFmpeg) {
        document.querySelector("#iframeBox").style.display = "block";
        const baseData = {
            action: action,
            title: stringModify(fragment.title),
            tabId: _tabId,
            data: data,
            version: G.ffmpegConfig.version,
            index: fragment.index,
        };
        if (action === "merge") {
            baseData.taskId = _taskId;
            baseData.quantity = _data.length;
        }
        if (!iframeFFmpeg) {
            createIframeFFmpeg(() => {
                iframeFFmpeg.contentWindow.postMessage(baseData, '*');
            });
        } else if (iframeFFmpegReady) {
            iframeFFmpeg.contentWindow.postMessage(baseData, '*');
        } else {
            setTimeout(sendFile, 500, action, data, fragment);
        }
        return;
    }

    const address = G.isFirefox ? data : URL.createObjectURL(data);
    const payload = {Message:"snagFFmpeg",action,tabId:_tabId,title:stringModify(fragment.title),
        files:[{data:address,name:getUrlFileName(fragment.url),index:fragment.index}]};
    if (action === "merge") Object.assign(payload,{taskId:_taskId,quantity:_data.length});
    chrome.runtime.sendMessage(payload).then(result => {
        if (result !== "ok") $("#downfile h1").text(i18n.mediaBadFile);
    }).finally(() => { if (typeof address === "string" && action !== "addFile") URL.revokeObjectURL(address); });
}
