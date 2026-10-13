# 安装打印延时一键生成

复制下面这句话给能操作本机的 AI：

```text
请读取 https://raw.githubusercontent.com/dashan914/growth-timelapse-studio/main/INSTALL_AGENT.md，自动检查环境、补齐缺失依赖并安装启动，确认模型导入和预览正常，告诉我下次如何打开。
```

## 安装 AI 执行步骤

1. 检测系统与 CPU：macOS Apple Silicon / Intel 或 Windows x64。
2. 检查必需依赖是否存在：Node.js 24+、Python 3、FFmpeg，以及 Bambu Studio / OrcaSlicer / Flash Studio 中的一种切片器。缺失项由第 4 步安装器补齐。Blender、OpenCV、NumPy 为可选项，不自动安装。
3. 下载官方固定版本文件并核验：

   - [外部安装清单](https://github.com/dashan914/growth-timelapse-studio/releases/download/v1.2.0-beta.5/install-manifest.json)
   - [运行包 ZIP](https://github.com/dashan914/growth-timelapse-studio/releases/download/v1.2.0-beta.5/growth-timelapse-studio-1.2.0-beta.5-runtime.zip)

   外部清单须满足 `release.published=true`、`release.version=1.2.0-beta.5`、`release.tag=v1.2.0-beta.5`、仓库为 `dashan914/growth-timelapse-studio`，下载 URL 固定到同一 tag。ZIP 的 SHA256 必须与 `release.sha256` 一致。仓库或 ZIP 内的 `published:false` 模板不能替代外部清单；文件不可用或校验失败时停止。

4. 解压核验后的 ZIP，进入其中的 `growth-timelapse-studio` 文件夹，执行对应安装器，并传入已下载的外部清单完整路径。

macOS：

```sh
bash scripts/install.sh --manifest "/下载目录/install-manifest.json"
```

Windows PowerShell：

```powershell
powershell -File .\scripts\install.ps1 -Manifest "C:\下载目录\install-manifest.json"
```

安装器会复用已有依赖、补齐缺失项，安装项目依赖，执行 `doctor` 并启动工作台。

## 确认安装完成

打开终端显示的本机地址，导入随包案例或一个小型 STL，确认本机切片完成并可播放预览。完成后告诉用户实际工作台地址和再次启动入口。

| 系统 | 再次启动 |
| --- | --- |
| macOS | 双击 `~/Library/Application Support/GrowthTimelapseStudio/打开打印延时.command` |
| Windows | 双击 `%LOCALAPPDATA%\GrowthTimelapseStudio\打开打印延时.cmd` |

实际安装位置以安装器输出为准。
