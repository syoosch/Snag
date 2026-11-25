# 开发与测试

Snag 是一个采用 Manifest V3 的浏览器扩展。仓库根目录就是可以加载的扩展目录，脚本、样式和 FFmpeg 都已随源码提供。桌面 Edge 是主要验证环境，Chrome 使用同一份 Chromium 清单。[浏览器清单](manifest.json) · [本地依赖与来源](lib/third-party-libraries.md)

## 从一次下载看代码

| 用户动作 | 从这里读起 |
| --- | --- |
| 网页开始播放 | [后台脚本](js/background.js)记录符合规则的网络请求。[页面扫描脚本](js/sidebar-page.js)查找播放器和可定位的页面元素，补充标题、预览和位置。 |
| 普通播放器使用 HLS 或 DASH | [通用清单匹配](js/sidebar-streams.js)在同一 iframe 文档中核对媒体标识、播放时长和实际分片，再沿清单里的引用找回主清单。[清单解析](js/media-sources.js)负责读取资源引用和制定下载顺序。 |
| 用户打开侧栏 | [侧栏入口](sidebar.html)加载界面。[侧栏主脚本](js/sidebar.js)更新当前标签页的数据，[资源目录](js/sidebar-catalog.js)将抓取记录和页面结果组合成卡片。 |
| 选择画质或编码 | [画质选择](js/sidebar-quality.js)处理下载选项，[卡片信息](js/sidebar-metadata.js)显示格式和大小。B 站和 YouTube 的播放器适配分别在 [B 站适配](js/sidebar-bili.js)和[播放器识别](js/sidebar-player.js)中。 |
| 保存视频或音轨 | [下载按钮](js/media-panel.js)提交完整、仅音频或仅画面任务。[后台桥接](js/media-bridge.js)连接浏览器下载接口与[后台处理页面](media-host.html)。 |
| 合并、保存与清理 | [任务管理](js/media-jobs.js)负责进度、重试和临时文件。[处理线程](js/media-worker.js)调用内置 FFmpeg。普通图片等直接下载的文件走侧栏的保存逻辑。 |

设置从 [options.html](options.html) 进入，对应 [js/options.js](js/options.js)。首次安装和使用指南共用 [install.html](install.html)。界面文本在 [_locales/](_locales/) 中，英语是浏览器清单的默认语言。

## 在本机运行

1. 克隆仓库，在 Edge 的 `edge://extensions` 打开开发人员模式，选择 **加载解压缩的扩展**，指向仓库根目录。Chrome 的入口是 `chrome://extensions`。
2. 修改代码后，在扩展管理页重新加载 Snag。修改注入网页的脚本时，还要刷新对应的测试网页。
3. 检查和打包使用 **Node.js 22 或更高版本**，打包另需 **Python 3**。从仓库根目录运行以下命令。

```sh
node tools/check-dependencies.js
node tests/welcome.js
python tools/package.py
```

依赖检查会核对随包库、固定域名、权限、扩展标识和页面引用。打包脚本先运行这项检查，再把运行所需的文件写入 `dist/snag-<版本>.zip`。本机验证发行包时，解压 ZIP，把 `SNAG_EXT` 指向解压目录，再运行浏览器测试。

## 按改动选择测试

| 改动位置 | 适合先跑的测试 |
| --- | --- |
| 安装、设置、升级 | `node tests/welcome.js`、`node tests/controls-settings.js`、`node tests/upgrade.js` |
| 资源列表、网页定位、画质和编码选择 | `node tests/sidebar.js`、`node tests/sidebar-quality.js`、`node tests/selection-ui.js` |
| B 站换片、番剧、YouTube 分段 | `node tests/bili-autoplay.js`、`node tests/bili-episodes.js`、`node tests/youtube-segments.js` |
| 动态播放器、签名清单和透明遮罩 | `node tests/generic-streams.js`、`node tests/player-discovery.js` |
| 多分片下载进度、重试、取消与离屏请求规则 | `node tests/stream-parts.js` |
| 合并和音轨提取、保存与清理 | `node tests/local-media.js`、`node tests/stream-save.js`、`node tests/media-cleanup.js` |

运行全部浏览器测试可使用以下命令。测试使用本地媒体样本和独立的临时浏览器配置，默认无头运行。可以用 `CHROME` 环境变量指定 Edge 或 Chrome 可执行文件的位置。[测试驱动](tests/lib/harness.js) · [测试样本](tests/fixtures/) · [上游测试框架与部分媒体样本来源](https://github.com/xifangczy/cat-catch/tree/33b21ba98995d01602cd289f082754fa00ccf042/tests)

```sh
node --test --test-concurrency=1 "tests/*.js"
```

## 提交反馈或改动

反馈时写明浏览器、复现步骤、预期结果和实际结果。有公开的示例网页时可以附上页面链接。修复识别或下载问题时，可以参照现有测试，用小型本地样本重现。涉及画质或音轨的改动，可以直接核对最终保存的媒体文件。[问题反馈](https://github.com/syoosch/Snag/issues)

变更库、固定联网地址或权限时，在[依赖与联网说明](lib/third-party-libraries.md)记录用途，并核对[依赖基线](tools/dependency-baseline.json)。两个浏览器清单共用项目版本号，发布记录见[更新说明](CHANGELOG.md)。仓库对 AI 开发助手的具体约定写在 [AGENTS.md](AGENTS.md)。
