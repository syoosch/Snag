# Snag 仓库约定

Snag 是基于猫抓开发的 Manifest V3 浏览器扩展。侧栏可以识别、预览和保存网页上的视频、音频、图片与 PDF，音画合并在本机完成。主要支持桌面 Edge，Chrome 共用 `manifest.json` 和同一个安装包。使用方式见[项目首页](README.md)，代码入口和测试索引见[开发指南](CONTRIBUTING.md)。

## 本机开发目录与发布基准

| 目录 | 用途 |
| --- | --- |
| `E:\Codex\Download\Snag` | 开发仓库。在这里改代码、改文档、运行测试，从这里加载开发版扩展。 |
| `E:\Codex\Download\Snag\dist` | 本地构建产物。这里可以有尚未发布的 ZIP。验证安装包时解压到临时目录。 |
| `E:\Codex\Download\Snag-release` | 用户保留的 GitHub 最新正式发布版，用于和开发版并排比较。日常开发、打包和测试只读这个目录。 |

- 手工验证开发版时，在扩展管理页按加载路径选中 `Snag` 并重新加载。对比两个版本时，在同一网页上执行相同的步骤。
- 只有用户明确要求更新发布基准时，才更新 `Snag-release`。从正式 Release 的 Assets 取 ZIP，核对版本、SHA-256 和解压后的文件。[GitHub 最新正式版](https://github.com/syoosch/Snag/releases/latest)

## 代码入口

- `js/background.js` 记录网络资源，`js/sidebar-page.js` 在页面和 iframe 中识别播放器，`js/sidebar-catalog.js` 把资源与页面元素组合成卡片。
- B 站入口是 `js/sidebar-bili.js`，YouTube 播放器识别从 `js/sidebar-player.js` 进入。通用 HLS、DASH 匹配在 `js/sidebar-streams.js`，下载用的清单解析在 `js/media-sources.js`。改通用流程时检查两个站点的既有行为。
- `js/media-panel.js` 接收侧栏下载操作，`js/media-jobs.js` 负责任务、重试与临时文件，`js/media-worker.js` 使用内置 FFmpeg 合并或提取音轨。

## 修改与验证

- 从[开发指南的测试索引](CONTRIBUTING.md#按改动选择测试)选择相关脚本。浏览器测试使用本地样片和独立临时配置。打包运行 `python tools/package.py`，它会先执行依赖检查，再输出 ZIP 到 `dist`。
- 侧栏卡片区分「网页播放的画质」与「用户选定的下载画质」。大小估算保留「约」，只有可用版本才提供下载。调整卡片时，用窄栏和宽栏检查文字与菜单。
- 音画合并和提取使用 `lib/ffmpeg/` 的本地引擎。改动下载流程时，检查完整视频、仅音频、无声视频和相应临时文件的清理，并核对保存的成品。
- 界面文字沿用 `_locales/` 中的消息。新增文案要有默认英语消息，并核对简体中文界面。旧设置名和临时文件名有迁移用途，修改前参照 `tests/upgrade.js`。
- 修改权限、依赖或固定域名时，核对 `node tools/check-dependencies.js` 的差异及[依赖说明](lib/third-party-libraries.md)。
