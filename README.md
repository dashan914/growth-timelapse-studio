# 打印延时一键生成

把单盘 3MF / STL 模型变成从底部逐层生长的视频。导入模型后，工具调用本机切片器生成真实打印路径，再结合背景、模型摆放、光影和材质完成画面。

![新版工作台与模型生长预览](docs/media/current-workbench.gif)

工作台展示模型、背景、时间线与当前工具栏。

这 4 个 GIF 来自本次当前工作台的实际操作录制。

[查看清晰 MP4](docs/media/demo-model.mp4) · [下载案例模型](examples/测试2.3mf) · [安装指南](https://github.com/dashan914/growth-timelapse-studio/blob/v1.2.0-beta.5/INSTALL_AGENT.md)

## 可以做什么

- **逐层生长动画**：按实际切片路径展示模型生长，可调整生长时间、完成停留和帧率。
- **多色模型与材质**：保留 3MF 的涂色分区，修改耗材颜色，比较 PLA、哑光、丝绸和 PETG 等表面质感。
- **打印机或摄影背景**：选择内置背景，或导入自己的照片、固定机位视频；照片可用底板四角和竖直参考线校正透视。
- **摆放与画面调整**：移动、旋转、缩放模型，分别调整阴影、色彩、镜头焦段和虚化。
- **时间线预览**：播放、循环、拖动进度，检查模型和支撑在不同层高的状态。
- **多种输出**：生成 MP4、透明 MOV 或 PNG 序列，适合直接分享或后期合成。

制作流程：**导入模型 → 选择背景 → 调整摆放和画面 → 预览 → 导出**。

## 背景与构图

![新版工作台切换打印机与摄影背景](docs/media/current-backgrounds.gif)

在“或直接使用背景预设”中选择场景，自动应用对应构图；自己的照片使用“自定义导入图片背景”。需要对齐照片时，点击“调整底板，矫正透视”。

## 模型移动与缩放

![新版工作台调整模型摆放](docs/media/current-transform.gif)

点击“移动”（W）、“旋转”（E）或“缩放”（R），拖动手柄调整模型；点击“锁定”或按 Esc 结束。阴影、色彩与镜头分别在“阴影调节”“色彩匹配”“镜头设置”中调整。

## 色彩与镜头设置

![新版色彩匹配与镜头设置](docs/media/current-color-lens.gif)

“色彩匹配”调整模型亮度、色温、对比度和饱和度；“镜头设置”调整焦段、虚化强度与焦点位置。多色工程还可以修改耗材分区颜色，或使用统一颜色。

[完整操作指南](docs/UI_GUIDE.md)

## 快速安装

当前固定版本为 **v1.2.0-beta.5**，官方安装文件为 `growth-timelapse-studio-1.2.0-beta.5-runtime.zip`。下载运行包和同版本外部安装清单，核对 SHA256 后安装。

[固定版本下载](https://github.com/dashan914/growth-timelapse-studio/releases/tag/v1.2.0-beta.5) · [直接下载官方运行包](https://github.com/dashan914/growth-timelapse-studio/releases/download/v1.2.0-beta.5/growth-timelapse-studio-1.2.0-beta.5-runtime.zip) · [Agent 安装指南](https://github.com/dashan914/growth-timelapse-studio/blob/v1.2.0-beta.5/INSTALL_AGENT.md)

可以把安装指南交给能操作本机终端的 Agent，按固定版本检查依赖、核对 SHA256、安装并启动。Windows x64 的依赖与首次检查见 [Windows 配置说明](docs/WINDOWS_SETUP.md)。

手动启动需准备 Node.js 24 LTS（最低 22）、Python 3，以及 Bambu Studio、OrcaSlicer 或 Flash Studio 中的一种。MP4 / MOV 编码需要 FFmpeg；Blender 和 OpenCV / NumPy 为可选扩展。

在解压目录执行：

```sh
npm ci
npm run doctor
npm start
```

打开终端显示的地址，默认 `http://127.0.0.1:4317`。macOS 也可双击 `start.command`。安装器会生成独立启动入口，并保留用户数据目录中的作品和设置。

更多配置与排查见 [快速开始](docs/QUICK_START.md)。

## 输出格式

| 格式 | 用途 |
| --- | --- |
| MP4 | 包含背景、模型与投影的完整视频 |
| MOV · ProRes 4444 | 带透明通道的视频，用于剪辑合成 |
| PNG 序列 ZIP | 透明逐帧图片，用于后期合成 |

支持原图比例、横屏、竖屏或裁剪，以及 720p、1080p、4K 输出。生长用时与完成停留共同决定总时长，成片可从完成窗口下载。

## 开发与许可

仓库保持 [MIT 开源](LICENSE)，官方运行包用于安装，源码仓库保留开发与测试流程。依赖、配置与素材来源见 [第三方记录](THIRD_PARTY_NOTICES.md)；版本与验证范围见 [验证记录](docs/VERIFICATION.md)。
