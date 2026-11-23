(function () {
    console.log("webrtc.js Start");
    if (document.getElementById("snagWebRTC")) { return; }

    const buttonStyle = 'style="border:solid 1px #000;margin:2px;padding:2px;background:#fff;border-radius:4px;border:solid 1px #c7c7c780;color:#000;"';
    const checkboxStyle = 'style="-webkit-appearance: auto;"';
    const Snag = document.createElement("div");
    Snag.innerHTML = `<img alt="" width="20" height="20" src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij48cmVjdCB4PSIxIiB5PSIxIiB3aWR0aD0iNjIiIGhlaWdodD0iNjIiIHJ4PSIxNSIgZmlsbD0iIzM4Mzg3OCIgc3Ryb2tlPSIjNTY1NjkzIi8+PHBhdGggZD0iTTE0IDI3di05YTQgNCAwIDAgMSA0LTRoOW0yMyAyM3Y5YTQgNCAwIDAgMS00IDRoLTkiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2ZmZmFmNCIgc3Ryb2tlLXdpZHRoPSI0LjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjxnIHRyYW5zZm9ybT0icm90YXRlKC0xMiAzMiAzMikiPjxyZWN0IHg9IjE5IiB5PSIyMiIgd2lkdGg9IjI2IiBoZWlnaHQ9IjIwIiByeD0iMyIgZmlsbD0iI2ZmY2E5NCIvPjxwYXRoIGQ9Im0yMiAzOCA3LTggNCA0IDQtNSA1IDl6IiBmaWxsPSIjNzA0OTYxIi8+PC9nPjwvc3ZnPg==" style="-webkit-user-drag: none;width: 20px;">
    <div id="snagWebRTC" style="display: flex; flex-direction: column; align-items: flex-start;">
        <div id="tips" data-i18n="waiting">正在等待视频流..."</div>
        <div id="time"></div>
        ${i18n("selectVideo", "选择视频")}:
            <select id="videoTrack">
                <option value="-1">${i18n("selectVideo", "选择视频")}</option>
            </select>
        ${i18n("selectAudio", "选择音频")}:
            <select id="audioTrack">
                <option value="-1">${i18n("selectAudio", "选择音频")}</option>
            </select>
        ${i18n("recordEncoding", "录制编码")}: <select id="mimeTypeList" style="max-width: 200px;"></select>
        <label><input type="checkbox" id="autoSave1"} ${checkboxStyle} ><span data-i18n="save1hour">1小时保存一次</span></label>
        <label>
            <select id="videoBits">
                <option value="2500000" data-i18n="videoBits">视频码率</option>
                <option value="2500000">2.5 Mbps</option>
                <option value="5000000">5 Mbps</option>
                <option value="8000000">8 Mbps</option>
                <option value="16000000">16 Mbps</option>
            </select>
            <select id="audioBits">
                <option value="128000" data-i18n="audioBits">音频码率</option>
                <option value="128000">128 kbps</option>
                <option value="256000">256 kbps</option>
            </select>
        </label>
        <div>
            <button id="start" ${buttonStyle} data-i18n="startRecording">开始录制</button>
            <button id="stop" ${buttonStyle} data-i18n="stopRecording">停止录制</button>
            <button id="save" ${buttonStyle} data-i18n="save">保存</button>
            <button id="hide" ${buttonStyle} data-i18n="hide">隐藏</button>
            <button id="close" ${buttonStyle} data-i18n="close">关闭</button>
        </div>
    </div>
    `;
    Snag.style = `
        position: fixed;
        z-index: 999999;
        top: 10%;
        left: 80%;
        background: rgb(255 255 255 / 85%);
        border: solid 1px #c7c7c7;
        border-radius: 4px;
        color: rgb(26, 115, 232);
        padding: 5px 5px 5px 5px;
        font-size: 12px;
        font-family: "Microsoft YaHei", "Helvetica", "Arial", sans-serif;
        user-select: none;
        display: flex;
        align-items: flex-start;
        justify-content: space-evenly;
        flex-direction: column;
        line-height: 20px;`;

    // 创建 Shadow DOM 放入Snag
    const divShadow = document.createElement('div');
    const shadowRoot = divShadow.attachShadow({ mode: 'closed' });
    shadowRoot.appendChild(Snag);
    // 页面插入Shadow DOM
    document.getElementsByTagName('html')[0].appendChild(divShadow);

    // 提示
    const $tips = Snag.querySelector("#tips");
    const tips = (text) => {
        $tips.innerHTML = text;
    }

    // 开始 结束 按钮切换
    const $start = Snag.querySelector("#start");
    const $stop = Snag.querySelector("#stop");
    const buttonState = (state = true) => {
        $start.style.display = state ? 'inline' : 'none';
        $stop.style.display = state ? 'none' : 'inline';
    }
    $start.style.display = 'inline';
    $stop.style.display = 'none';

    // 关闭
    Snag.querySelector("#close").addEventListener('click', function (event) {
        recorder?.state && recorder.stop();
        Snag.style.display = "none";
        window.postMessage({ action: "snagCloseScript", script: "webrtc.js" });
    });

    // 隐藏
    Snag.querySelector("#hide").addEventListener('click', function (event) {
        // Snag.style.display = "none";
        const content = Snag.querySelector("#snagWebRTC").style;
        if (content.display === "none") {
            content.display = "flex";
            Snag.style.opacity = "";
        } else {
            content.display = "none";
            Snag.style.opacity = "0.5";
        }
    });
    Snag.querySelector("img").addEventListener('click', function (event) {
        Snag.querySelector("#hide").click();
    });

    const tracks = { video: [], audio: [] };
    const $tracks = { video: Snag.querySelector('#videoTrack'), audio: Snag.querySelector('#audioTrack') };

    /* 核心变量 */
    let recorder = null;    // 录制器
    let autoSave1Timer = null;    // 1小时保存一次

    // #region 编码选择
    let option = { mimeType: 'video/webm;codecs=vp9,opus' };
    function getSupportedMimeTypes(media, types, codecs) {
        const supported = [];
        types.forEach((type) => {
            const mimeType = `${media}/${type}`;
            codecs.forEach((codec) => [`${mimeType};codecs=${codec}`].forEach(variation => {
                if (MediaRecorder.isTypeSupported(variation)) {
                    supported.push(variation);
                }
            }));
            if (MediaRecorder.isTypeSupported(mimeType)) {
                supported.push(mimeType);
            }
        });
        return supported;
    };
    const $mimeTypeList = Snag.querySelector("#mimeTypeList");
    const videoTypes = ["webm", "ogg", "mp4", "x-matroska"];
    const codecs = ["should-not-be-supported", "vp9", "vp8", "avc1", "av1", "h265", "h.265", "h264", "h.264", "opus", "pcm", "aac", "mpeg", "mp4a"];
    const supportedVideos = getSupportedMimeTypes("video", videoTypes, codecs);
    supportedVideos.forEach(function (type) {
        $mimeTypeList.options.add(new Option(type, type));
    });
    option.mimeType = supportedVideos[0];
    $mimeTypeList.addEventListener('change', function (event) {
        if (recorder && recorder.state && recorder.state === 'recording') {
            tips(i18n("recordingChangeEncoding", "录制中不能更改编码"));
            return;
        }
        if (MediaRecorder.isTypeSupported(event.target.value)) {
            option.mimeType = event.target.value;
            tips(`${i18n("recordEncoding", "录制编码")}:` + event.target.value);
        } else {
            tips(i18n("formatNotSupported", "不支持此格式"));
        }
    });
    // #endregion 编码选择

    // 录制
    $time = Snag.querySelector("#time");
    Snag.querySelector("#start").addEventListener('click', function () {
        if (!tracks.video.length && !tracks.audio.length) {
            tips(i18n("streamEmpty", "媒体流为空"));
            return;
        }
        let recorderTime = 0;
        let recorderTimeer = undefined;
        let chunks = [];

        // 音频 视频 选择
        const videoTrack = +Snag.querySelector("#videoTrack").value;
        const audioTrack = +Snag.querySelector("#audioTrack").value;
        const streamTrack = [];
        if (videoTrack !== -1 && tracks.video[videoTrack]) {
            streamTrack.push(tracks.video[videoTrack]);
        }
        if (audioTrack !== -1 && tracks.audio[audioTrack]) {
            streamTrack.push(tracks.audio[audioTrack]);
        }

        // 码率
        option.audioBitsPerSecond = +Snag.querySelector("#audioBits").value;
        option.videoBitsPerSecond = +Snag.querySelector("#videoBits").value;

        const mediaStream = new MediaStream(streamTrack);
        recorder = new MediaRecorder(mediaStream, option);
        recorder.ondataavailable = event => {
            chunks.push(event.data)
        };
        recorder.onstop = () => {
            recorderTime = 0;
            clearInterval(recorderTimeer);
            clearInterval(autoSave1Timer);
            $time.innerHTML = "";
            tips(i18n("stopRecording", "已停止录制!"));
            download(chunks);
            buttonState();
        }
        recorder.onstart = () => {
            chunks = [];
            tips(i18n("recording", "视频录制中"));
            $time.innerHTML = "00:00";
            recorderTimeer = setInterval(function () {
                recorderTime++;
                $time.innerHTML = secToTime(recorderTime);
            }, 1000);
            buttonState(false);
        }
        recorder.onerror = (msg) => {
            console.error(msg);
        }
        recorder.start(60000);
    });
    // 停止录制
    Snag.querySelector("#stop").addEventListener('click', function () {
        if (recorder) {
            recorder.stop();
            recorder = undefined;
        }
    });
    // 保存
    Snag.querySelector("#save").addEventListener('click', function () {
        if (recorder) {
            recorder.stop();
            recorder.start();
        }
    });
    // 每1小时 保存一次
    Snag.querySelector("#autoSave1").addEventListener('click', function () {
        clearInterval(autoSave1Timer);
        if (Snag.querySelector("#autoSave1").checked) {
            autoSave1Timer = setInterval(function () {
                if (recorder) {
                    recorder.stop();
                    recorder.start();
                }
            }, 3600000);
        }
    });

    // 获取webRTC流
    window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
        construct(target, args) {
            const pc = new target(...args);
            pc.addEventListener('track', (event) => {
                const track = event.track;
                if (track.kind === 'video' || track.kind === 'audio') {
                    tips(`${track.kind} ${i18n("streamAdded", "流已添加")}`);
                    $tracks[track.kind].appendChild(new Option(track.label, tracks[track.kind].length));
                    $tracks[track.kind].value = tracks[track.kind].length;
                    tracks[track.kind].push(track);
                    if (tracks.video.length && tracks.audio.length) {
                        tips(i18n("videoAndAudio", "已包含音频和视频流"));
                    }
                }
            });
            pc.addEventListener('iceconnectionstatechange', (event) => {
                if (pc.iceConnectionState === 'disconnected' && recorder?.state === 'recording') {
                    recorder.stop();
                    tips(i18n("stopRecording", "连接已断开，录制已停止"));
                }
            });
            return pc;
        }
    });

    // #region 移动逻辑
    let x, y;
    const move = (event) => {
        Snag.style.left = event.pageX - x + 'px';
        Snag.style.top = event.pageY - y + 'px';
    }
    Snag.addEventListener('mousedown', function (event) {
        x = event.pageX - Snag.offsetLeft;
        y = event.pageY - Snag.offsetTop;
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', function () {
            document.removeEventListener('mousemove', move);
        });
    });
    // #endregion 移动逻辑

    function download(chunks) {
        const blob = new Blob(chunks, { type: option.mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = 'recorded-video.mp4';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
    }

    // 秒转换成时间
    function secToTime(sec) {
        let hour = (sec / 3600) | 0;
        let min = ((sec % 3600) / 60) | 0;
        sec = (sec % 60) | 0;
        let time = hour > 0 ? hour + ":" : "";
        time += min.toString().padStart(2, '0') + ":";
        time += sec.toString().padStart(2, '0');
        return time;
    }

    // 防止网页意外关闭跳转
    window.addEventListener('beforeunload', function (e) {
        recorder && recorder.stop();
        return true;
    });

    // i18n
    if (window.SnagI18n && Snag) {
        Snag.querySelectorAll('[data-i18n]').forEach(function (element) {
            element.innerHTML = window.SnagI18n[element.dataset.i18n] || element.innerHTML;
        });
        Snag.querySelectorAll('[data-i18n-outer]').forEach(function (element) {
            element.outerHTML = window.SnagI18n[element.dataset.i18nOuter] || element.outerHTML;
        });
    }
    function i18n(key, original = "") {
        if (!window.SnagI18n || !Snag) { return original };
        return window.SnagI18n[key] || original;
    }
})();
