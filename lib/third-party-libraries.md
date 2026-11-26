# Snag 会连接哪里

**侧栏的下载、音画合并和音轨提取都在你的电脑上完成。** Snag 从网页提供的媒体地址取得内容，用插件随附的固定版 FFmpeg 处理。旧版解析器、录制工具和下载器的 FFmpeg 入口也使用这份引擎。[侧栏下载流程](../js/media-jobs.js) · [本地处理代码](../js/media-worker.js)

核对日期为 2026 年 11 月 23 日。下列默认值来自全新安装的代码。你曾经改过、导入过或从浏览器账号同步过的设置可能不同。

## 日常使用与可选功能

| 你的操作 | 什么时候会连接或共享 | 对方能接触到什么 |
| --- | --- | --- |
| 打开侧栏、预览、普通下载 | 扩展在浏览器中识别并保存抓取记录。显示缩略图、试听或下载时会访问网页提供的文件地址，包括网站使用的媒体服务器。 | 文件来源能看到相应请求。部分下载需要附上来源页或原请求所需的标头。 |
| 在 B 站看画质和分集 | 普通视频页和列表播放页在内存中保留播放器已收到的最近 4 个分 P 的音画清单，离开文档后释放。侧栏用当前播放的分 P 编号匹配清单。信息不足时查询该视频的公开资料、画质或剧集目录。点「切换网页画质」时，由正在看的网页按当前账号的播放权限切换。 | Snag 向 `api.bilibili.com` 查询公开信息时省略账号 Cookie。播放器切换使用网站自己的会话。预览和下载另外访问媒体来源。 |
| 在 YouTube 看视频 | 打开侧栏会读取当前播放器列出的版本。有主播放清单时，侧栏向 `googlevideo.com` 读取清单，取得各画质的编码和码率，省略 Cookie。点下载后才从文件或清单取媒体。需要播放器继续加载分段时，临时用静音后台标签页打开同一视频，任务结束后关闭。 | YouTube 及其媒体服务器会收到这些请求。后台播放沿用浏览器的登录状态，也可能计入观看记录。分段和音画合并均在本机处理。 |
| 下载完整视频、仅音频、无声视频 | 侧栏按所选模式下载需要的轨道。需要合并或提取时，在扩展自己的后台文档中启动本地引擎。 | 媒体来源收到请求，独立第三方合并站、镜像和代码分发站均不参与。成品通过浏览器下载管理器保存。 |
| 「边下边存」、HLS 直播录制 | 从媒体来源分段读取，连续写入扩展的本机临时目录，完成时交给浏览器保存。实验性的「直接写入文件」使用浏览器文件选择器。 | 媒体只在本机暂存。完成或取消时释放，关闭任务或重启浏览器后也会检查遗留文件。 |
| 「发送到本地」、aria2 下载 | 两项默认关闭。前者可设置手动或每次捕获自动发送，初始地址为本机 `127.0.0.1:8000`。aria2 初始地址为本机 `localhost:6800`。两者均可改到别的机器。 | 配置的接收端会得到下载链接。记录或选定标头可能包含带签名的链接、来源页、Cookie 或授权信息。 |
| MQTT 消息转发 | 默认关闭，服务器地址留空。填写自己的服务器并启用后，执行转发时才建立连接。 | 指定服务器及该主题的订阅方可收到选定记录，可能包含标题、下载链接或请求标头。 |
| 浏览器账号同步 | 许多设置使用浏览器的同步存储。是否跨设备同步取决于浏览器及账号设置。抓取记录写入会话或本机存储。 | 进入同步存储的设置包括用户填写的 aria2 令牌、MQTT 密码和自定义请求标头。 |
| 外部播放器、下载程序、分享、文档 | 启用配置或点相应入口才调用，例如 N_m3u8DL、自定义播放器、系统分享、GitHub 和使用文档。 | 外部程序或自定义网址按配置取得链接及模板里选的字段。自定义地址与样式还能引入自己的网络连接。 |

对应实现见[默认开关与服务地址](../js/init.js)、[侧栏查询](../js/sidebar.js)、[本机流式保存](../js/local-stream.js)、[网络捕获与转发](../js/background.js)、[下载及分享选项](../js/popup-utils.js)和[设置存储](../js/options.js)。浏览器授予读取普通网页请求的权限，具体范围见 [Edge / Chrome 清单](../manifest.json)和 [Firefox 清单](../manifest.firefox.json)。

## 仓库里的旧名称

安装欢迎页和使用指南中的「关于」打开扩展自己的设置页。「Snag · GitHub」通往 Snag 仓库，另有单独的链接致谢原作者。少量旧标识用于导入旧设置、恢复网页的捕获偏好、沿用早期用户的消息订阅，或清理旧版留下的临时文件。打包检查会拦住旧服务地址和旧商店标识。测试文件和 Git 历史保存在源码仓库。

## 内置 FFmpeg 与临时文件

Snag 随包分发 `@ffmpeg/core` 单线程版 0.12.6。程序和计算内核均从扩展目录加载。浏览器后台文档用于在侧栏关闭时继续工作。扩展页面的脚本策略允许本地 WebAssembly。日常下载无需单独安装 FFmpeg。

保存采用标准 AES-128 的 HLS 点播时，浏览器按清单的密钥 URI 读取 16 字节密钥，并使用原生 Web Crypto 解密。密钥按轨道暂存在内存中。页面发现的媒体缺少来源标头时，侧栏按所在文档的策略使用来源域，跨域、降级及不同来源帧分别核对。[分片读取与解密](../js/media-jobs.js) · [来源标头处理](../js/media-panel.js)

- 官方 npm 发布包的 SHA-512（Base64）为 `PrjWBTfGn2WVn9T7wGnzfFwChbqWeZc7tM9vvJZVRadYFUDakfzy7W0LpYC0cvvK0xT82qlBsk38lQhJ/Hps5A==`。校验后原样提取 `package/dist/umd/ffmpeg-core.js` 和 `package/dist/umd/ffmpeg-core.wasm`。两份文件和许可证的散列在[依赖记录](../tools/dependency-baseline.json)。[官方包记录](https://registry.npmjs.org/@ffmpeg%2fcore/0.12.6) · [对应源码和构建脚本](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/e0d4c62a229ba58ea0c6e6b881e289f2fefe97c4)
- JavaScript 封装沿用上游 MIT 许可。编译后的引擎包含 FFmpeg 5.1.4 及第三方编解码库，各组件按其许可分发。仓库随附 [MIT](ffmpeg/LICENSE-MIT.txt)、[GPL](ffmpeg/LICENSE-GPLv2.txt) 和 [LGPL](ffmpeg/LICENSE-LGPLv2.1.txt) 原文。[上游许可说明](https://ffmpegwasm.netlify.app/docs/faq/) · [构建使用的组件与版本](https://github.com/ffmpegwasm/ffmpeg.wasm/blob/e0d4c62a229ba58ea0c6e6b881e289f2fefe97c4/Dockerfile)
- 下载中间文件在扩展专用临时目录。保存完成或取消后清理。可重试的故障最多保留十分钟，侧栏显示占用和到期时间，点「立即清理」可提前释放。浏览器被强行关闭后，下次启动会清理遗留任务目录。清理只作用于本扩展创建的临时任务。[清理与重试代码](../js/media-jobs.js)

## 随插件一起分发的代码

下表中的文件均在 `lib/`。前七项已与对应发布文件逐一比对，统一文本换行后内容相同。表末两项由本仓库随上游保留。点击来源只用于复核。

| 本地文件 | 版本与用途 | 许可证与可复核来源 |
| --- | --- | --- |
| `jquery.min.js` | jQuery 4.0.0，界面操作 | MIT · [发布文件](https://code.jquery.com/jquery-4.0.0.min.js) |
| `hls.min.js` | hls.js 1.7.3，HLS 播放 | Apache-2.0 · [发布文件](https://cdn.jsdelivr.net/npm/hls.js@1.7.3/dist/hls.min.js) |
| `mpd-parser.min.js` | mpd-parser 1.4.0，解析 DASH 清单 | Apache-2.0 · [发布文件](https://cdn.jsdelivr.net/npm/mpd-parser@1.4.0/dist/mpd-parser.min.js) |
| `mux.min.js` | mux.js 7.1.0，媒体封装 | Apache-2.0 · [发布文件](https://cdn.jsdelivr.net/npm/mux.js@7.1.0/dist/mux.min.js) |
| `mqtt.min.js` | MQTT.js 5.16.1，消息客户端 | MIT · [发布文件](https://cdn.jsdelivr.net/npm/mqtt@5.16.1/dist/mqtt.min.js) |
| `jquery.qrcode.min.js` | jquery-qrcode 1.0，生成二维码 | MIT · [标签中的文件](https://raw.githubusercontent.com/jeromeetienne/jquery-qrcode/v1.0/jquery.qrcode.min.js) |
| `jquery.json-viewer.js` | jquery.json-viewer 1.5.0，显示 JSON | MIT · [标签中的文件](https://raw.githubusercontent.com/abodelot/jquery.json-viewer/v1.5.0/json-viewer/jquery.json-viewer.js) |
| `m3u8-decrypt.js` | 源自 hls.js 的 AES 辅助代码，上游未标独立版本 | Apache-2.0 · [来源](https://github.com/video-dev/hls.js/blob/master/src/crypt/aes-decryptor.ts) |
| `base64.js` | 猫抓保留的编码辅助函数，使用浏览器原生接口 | [仓库中的实现](base64.js) · [项目许可证](../LICENSE) |

运行扩展所需的脚本和 FFmpeg 已随包分发。开发测试使用 Node.js。普通打包使用 Python 3 标准库与本机 Node.js。可选 CRX 签名需要自己提供 crx3 和已有私钥。[打包脚本](../tools/package.py)

## 以后怎样发现变化

在仓库中运行 `node tools/check-dependencies.js`，或正常执行 `just validate` 和打包。它会对照[保存的记录](../tools/dependency-baseline.json)，报告随包库内容、根目录包清单、代码中写明的域名、页面中直接引用的外部资源、扩展标识及权限的变化，并核对页面入口和本地文案。检查在本机进行，可离线使用。维护者可用 `node tools/check-dependencies.js --print` 查看当前值，对照差异、查清来源后再更新记录和本页。[检查脚本](../tools/check-dependencies.js)

媒体服务器地址由正在浏览的网站提供。自定义转发和播放器地址由使用者填写，固定域名清单无法预先列出这些地址。
