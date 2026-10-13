# 安装打印延时一键生成

复制下面这句话给能操作本机的 AI：

```text
请读取 https://raw.githubusercontent.com/dashan914/growth-timelapse-studio/main/INSTALL_AGENT.md，Windows 安装前先询问我安装到哪个盘，再按我的选择自动检查环境、补齐缺失依赖并安装启动，确认模型导入和预览正常，告诉我下次如何打开。
```

## 安装 AI 执行步骤

1. 检测系统与 CPU：macOS Apple Silicon / Intel 或 Windows x64。
2. Windows 安装前，列出本机实际存在的本地磁盘、可用空间和建议安装目录，询问用户“你希望安装到哪个盘？也可以指定完整文件夹路径。”等待用户回答后再执行安装。默认位置作为一个可选项展示：`%LOCALAPPDATA%\GrowthTimelapseStudio`；其他盘可建议 `D:\GrowthTimelapseStudio` 等对应目录。本机已有安装时，把原位置也列为选项。用户已经明确指定安装盘或目录时，直接遵循，无需重复询问。确定目录后，检查该盘存在且目录可写，将完整路径记录为 `$growthInstallRoot`。
3. 检查必需依赖是否存在：Node.js 24+、Python 3、FFmpeg，以及 Bambu Studio / OrcaSlicer / Flash Studio 中的一种切片器。缺失项由第 5 步安装器补齐。Blender、OpenCV、NumPy 为可选项，不自动安装。
4. 下载官方固定版本文件并核验：

   - [外部安装清单](https://github.com/dashan914/growth-timelapse-studio/releases/download/v1.2.0-beta.5/install-manifest.json)
   - [运行包 ZIP](https://github.com/dashan914/growth-timelapse-studio/releases/download/v1.2.0-beta.5/growth-timelapse-studio-1.2.0-beta.5-runtime.zip)

   外部清单须满足 `release.published=true`、`release.version=1.2.0-beta.5`、`release.tag=v1.2.0-beta.5`、仓库为 `dashan914/growth-timelapse-studio`，下载 URL 固定到同一 tag。ZIP 的 SHA256 必须与 `release.sha256` 一致。仓库或 ZIP 内的 `published:false` 模板不能替代外部清单；文件不可用或校验失败时停止。

5. 解压核验后的 ZIP，进入其中的 `growth-timelapse-studio` 文件夹，执行对应安装器，并传入已下载的外部清单完整路径。Windows 还须传入用户选择的完整安装目录。

macOS：

```sh
bash scripts/install.sh --manifest "/下载目录/install-manifest.json"
```

Windows PowerShell（以下以用户选择 D 盘为例，替换为用户实际选择的目录和清单路径）：

```powershell
$growthInstallRoot = "D:\GrowthTimelapseStudio"
powershell -File .\scripts\install.ps1 -Manifest "C:\下载目录\install-manifest.json" -InstallRoot $growthInstallRoot
```

安装器会复用已有依赖、补齐缺失项，安装项目依赖，执行 `doctor` 并启动工作台。

Windows 所选目录用于软件、导出文件和本机授权数据；Python、FFmpeg 等系统依赖可能使用各自的安装位置。

## 确认安装完成

打开终端显示的本机地址，导入随包案例或一个小型 STL，确认本机切片完成并可播放预览。完成后告诉用户实际工作台地址和再次启动入口。

| 系统 | 再次启动 |
| --- | --- |
| macOS | 双击 `~/Library/Application Support/GrowthTimelapseStudio/打开打印延时.command` |
| Windows | 双击用户所选安装目录中的 `打开打印延时.cmd`，例如 `D:\GrowthTimelapseStudio\打开打印延时.cmd` |

实际安装位置以安装器输出为准。
