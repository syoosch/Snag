(function () {
    console.log("recorder2.js Start");
    if (document.getElementById("snagRecorder2")) {
        return;
    }
    if (!navigator.mediaDevices) {
        alert("当前网页不支持屏幕分享");
        return;
    }

    // 添加style
    const style = document.createElement("style");
    style.innerHTML = `
        @keyframes color-change{
            0% { outline: 4px solid rgb(26, 115, 232); }
            50% { outline: 4px solid red; }
            100% { outline: 4px solid rgb(26, 115, 232); }
        }
        #snagRecorder2 {
            font-weight: bold;
            position: absolute;
            cursor: move;
            z-index: 999999999;
            outline: 4px solid rgb(26, 115, 232);
            resize: both;
            overflow: hidden;
            height: 720px;
            width: 1024px;
            top: 30%;
            left: 30%;
            pointer-events: none;
            font-size: 10px;
        }
        #snagRecorderHeader {
            background: rgb(26, 115, 232);
            color: white;
            text-align: center;
            height: 20px;
            cursor: pointer;
            display: flex;
            justify-content: space-evenly;
            align-items: center;
            pointer-events: auto;
        }
        #snagRecorderTitle {
            cursor: move;
            user-select: none;
            width: 45%;
        }
        #snagRecorderinnerCropArea {
            height: calc(100% - 20px);
            width: 100%;
        }
        .animation {
            animation: color-change 5s infinite;
        }
        .input-group {
            display: flex;
            align-items: center;
        }
        .input-group label {
            margin-right: 5px;
        }
        #videoBitrate, #audioBitrate {
            width: 4rem;
        }
        .input-group label{
            width: 5rem;
        }`;

    // 添加div
    const recorderPanel = document.createElement("div");
    recorderPanel.setAttribute("id", "snagRecorder2");
    recorderPanel.innerHTML = `<div id="snagRecorderinnerCropArea"></div>
        <div id="snagRecorderHeader">
            <div class="input-group">
                <select id="videoBits">
                    <option value="2500000" data-i18n="videoBits">视频码率</option>
                    <option value="2500000">2.5 Mbps</option>
                    <option value="5000000">5 Mbps</option>
                    <option value="8000000">8 Mbps</option>
                    <option value="16000000">16 Mbps</option>
                </select>
            </div>
            <div class="input-group">
                <select id="audioBits">
                    <option value="128000" data-i18n="audioBits">视频码率</option>
                    <option value="128000">128 kbps</option>
                    <option value="256000">256 kbps</option>
                </select>
            </div>
            <div id="snagRecorderStart" data-i18n="startRecording">开始录制</div>
            <div id="snagRecorderTitle" data-i18n="dragWindow">拖动窗口</div>
            <div id="snagRecorderClose" data-i18n="close">关闭</div>
        </div>`;

    // 创建 Shadow DOM 放入Snag
    const divShadow = document.createElement('div');
    const shadowRoot = divShadow.attachShadow({ mode: 'closed' });
    shadowRoot.appendChild(recorderPanel);
    shadowRoot.appendChild(style);
    document.getElementsByTagName('html')[0].appendChild(divShadow);

    // 事件绑定
    const snagRecorderStart = recorderPanel.querySelector("#snagRecorderStart");
    snagRecorderStart.onclick = function () {
        if (recorder) {
            recorder.stop();
            return;
        }
        try { startRecording(); } catch (e) { console.log(e); return; }
    }
    recorderPanel.querySelector("#snagRecorderClose").onclick = function () {
        recorder && recorder.stop();
        recorderPanel.remove();
        window.postMessage({ action: "snagCloseScript", script: "recorder2.js" });
    }

    // 拖动div
    const snagRecorderinnerCropArea = recorderPanel.querySelector("#snagRecorderinnerCropArea");
    recorderPanel.querySelector("#snagRecorderTitle").onpointerdown = (e) => {
        let pos1, pos2, pos3, pos4;
        pos3 = e.clientX;
        pos4 = e.clientY;
        if (pos3 - recorderPanel.offsetWidth - recorderPanel.offsetLeft > - 20 &&
            pos4 - recorderPanel.offsetHeight - recorderPanel.offsetTop > - 20) {
            return;
        }
        document.onpointermove = (e) => {
            pos1 = pos3 - e.clientX;
            pos2 = pos4 - e.clientY;
            pos3 = e.clientX;
            pos4 = e.clientY;
            recorderPanel.style.top = recorderPanel.offsetTop - pos2 + "px";
            recorderPanel.style.left = recorderPanel.offsetLeft - pos1 + "px";
        }
        document.onpointerup = () => {
            document.onpointerup = null;
            document.onpointermove = null;
        }
    }

    // 初始化位置
    const video = document.querySelector("video");
    if (video) {
        // 调整和video一样大小
        if (video.clientHeight >= 0 && video.clientWidth >= 0) {
            recorderPanel.style.height = video.clientHeight + 20 + "px";
            recorderPanel.style.width = video.clientWidth + "px";
        }
        // 调整到video的位置
        const videoOffset = getElementOffset(video);
        if (videoOffset.top >= 0 && videoOffset.left >= 0) {
            recorderPanel.style.top = videoOffset.top + "px";
            recorderPanel.style.left = videoOffset.left + "px";
        }
        // 防止遮挡菜单
        const panelBounds = recorderPanel.getBoundingClientRect();
        if (document.documentElement.scrollTop + panelBounds.bottom > document.documentElement.scrollTop + window.innerHeight) {
            recorderPanel.style.top = document.documentElement.scrollTop + window.innerHeight - panelBounds.height + "px";
        }
    }

    // 录制
    var recorder;
    async function startRecording() {
        const buffer = [];
        let option = {
            mimeType: 'video/webm;codecs=vp8,opus',
            videoBitsPerSecond: +recorderPanel.querySelector("#videoBits").value,
            audioBitsPerSecond: +recorderPanel.querySelector("#audioBits").value
        };

        if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')) {
            option.mimeType = 'video/webm;codecs=vp9,opus';
        } else if (MediaRecorder.isTypeSupported('video/webm;codecs=h264')) {
            option.mimeType = 'video/webm;codecs=h264';
        }
        const cropTarget = await CropTarget.fromElement(snagRecorderinnerCropArea);
        const stream = await navigator.mediaDevices
            .getDisplayMedia({
                preferCurrentTab: true,
                video: {
                    cursor: "never"
                },
                audio: {
                    sampleRate: 48000,
                    sampleSize: 16,
                    channelCount: 2
                }
            });
        const [track] = stream.getVideoTracks();
        await track.cropTo(cropTarget);
        recorder = new MediaRecorder(stream, option);
        recorder.start();
        recorder.onstart = function (e) {
            buffer.slice(0);
            snagRecorderStart.innerHTML = i18n("stopRecording", "停止录制");
            recorderPanel.classList.add("animation");
        }
        recorder.ondataavailable = function (e) {
            buffer.push(e.data);
        }
        recorder.onstop = function () {
            const fileBlob = new Blob(buffer, { type: option });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(fileBlob);
            a.download = `${document.title}.webm`;
            a.click();
            a.remove();
            buffer.slice(0);
            stream.getTracks().forEach(track => track.stop());
            recorder = undefined;
            snagRecorderStart.innerHTML = i18n("startRecording", "开始录制");
            recorderPanel.classList.remove("animation");
        }
    }
    function getElementOffset(el) {
        const rect = el.getBoundingClientRect();
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
        return {
            top: rect.top + scrollTop,
            left: rect.left + scrollLeft
        };
    }

    // i18n
    if (window.SnagI18n && recorderPanel) {
        recorderPanel.querySelectorAll('[data-i18n]').forEach(function (element) {
            element.innerHTML = window.SnagI18n[element.dataset.i18n] || element.innerHTML;
        });
        recorderPanel.querySelectorAll('[data-i18n-outer]').forEach(function (element) {
            element.outerHTML = window.SnagI18n[element.dataset.i18nOuter] || element.outerHTML;
        });
    }
    function i18n(key, original = "") {
        if (!window.SnagI18n || !recorderPanel) { return original };
        return window.SnagI18n[key] || original;
    }
})();