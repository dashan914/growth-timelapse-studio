# 使用 Agent 安装打印延时内测版

学员可复制给有本机终端执行能力的 Agent：

> 请按照这个项目的 INSTALL_AGENT.md，在我的电脑安装并启动“打印延时一键生成”。检测系统和现有依赖，只补齐缺失项；使用文档指定的固定发行包并核对 SHA256；保留已有项目、导出作品与授权。完成检查后打开工作台，告诉我如何再次启动。导入、编辑和预览免费使用；需要导出时由我自己输入兑换码。系统安装器和权限提示由我确认。

与这句话一起提供本文件的可访问链接或本地路径。安装 Agent 需要访问电脑的终端、文件和网络；纯对话 Agent 无法安装本机程序。

固定版本入口：[v1.1.0-beta.1](https://github.com/dashan914/growth-timelapse-studio/releases/tag/v1.1.0-beta.1) · [外部安装清单](https://github.com/dashan914/growth-timelapse-studio/releases/download/v1.1.0-beta.1/install-manifest.json)。

Windows 用户的依赖分类、手动路径配置和本机验收步骤见 [Windows 配置说明](docs/WINDOWS_SETUP.md)。本地兼容修改属于派生源码，仍须保留固定发行包与外部清单；安装修改后的源码使用 `-Source`，不能把派生包冒充原始 Release。

## Agent 执行步骤

1. 读取本文件与 [install-manifest.json](install-manifest.json)，检测操作系统和 CPU。入口支持 macOS Apple Silicon / Intel、Windows x64；Windows 和 Intel Mac 完整流程仍需实机验证。
2. 从维护者明确提供的固定 tag 的 GitHub Release 资产下载**外部 `install-manifest.json`**，不要使用 ZIP 内或仓库内的模板。外部清单的 `release.published` 必须为 `true`；仓库必须为 `dashan914/growth-timelapse-studio-beta` 或 `dashan914/growth-timelapse-studio`；URL 必须固定到指定 `release.tag`，SHA256 必须完整。不要用 `main` 或 `latest` 源码替代发行包，不要自行猜测下载地址。若指定版本尚未公开发布，维护者先完成发行；本地源码可按下文 `--source` 方式验证。
3. 按外部清单下载源码 ZIP，核对 SHA256，再解压并阅读脚本。建议把校验通过的 ZIP 保存到用户数据根目录的 `cache/<release.tag>.zip`，安装器会复用同一文件。源码 ZIP 内的安装清单保持未发布模板，实际安装以外部清单为准。不要把下载脚本直接通过管道交给 shell。
4. 在解压目录执行：macOS `bash scripts/install.sh --manifest "/外部清单完整路径/install-manifest.json"`；Windows `powershell -File .\scripts\install.ps1 -Manifest "C:\外部清单完整路径\install-manifest.json"`。脚本优先复用 Node.js 24+、Python 3、FFmpeg 和兼容的切片器；缺失 Node 使用官方固定版 24.19.0，缺失切片器使用官方 Bambu Studio 2.7.1.57。
5. Python 与 FFmpeg 在 macOS 通过 Homebrew、Windows 通过 WinGet 安装。没有 Homebrew 时使用固定 commit 的官方安装脚本并验 SHA256；没有 WinGet 时请用户通过 Microsoft App Installer 安装。权限、许可、系统工具与首次打开提示由用户本人确认，不能代输入密码、关闭系统检查或忽略校验失败。
6. 安装器执行 `npm ci` 和 `doctor`，成功后创建启动入口并打开本机工作台。Blender、OpenCV 和 NumPy 为后续可选项。
7. 打开工作台，确认无需兑换码即可导入、编辑和预览。所有导出操作需要解锁；由使用者在导出时输入山地造物星光商城领取的兑换码。安装流程不自动兑换星光，也不记录或输出兑换码。

## 本地源码验证

固定版本发行包尚未发布时，持有源码的使用者可以执行：

```sh
bash scripts/install.sh --source "/完整路径/growth-timelapse-studio" --dry-run
bash scripts/install.sh --source "/完整路径/growth-timelapse-studio"
```

Windows：

```powershell
powershell -File .\scripts\install.ps1 -Source "C:\完整路径\growth-timelapse-studio" -DryRun
powershell -File .\scripts\install.ps1 -Source "C:\完整路径\growth-timelapse-studio"
```

`--dry-run` / `-DryRun` 只显示计划，不安装、下载或写入数据；`--no-launch` / `-NoLaunch` 完成安装后暂不打开软件。`--install-root` / `-InstallRoot` 可指定独立验证目录。维护验证可加 `--no-runtime-install` / `-NoRuntimeInstall`：只使用已有运行时，缺少依赖立即停止，保留本机环境。

## 文件位置与重试

| 内容 | macOS | Windows |
| --- | --- | --- |
| 用户数据根目录 | `~/Library/Application Support/GrowthTimelapseStudio` | `%LOCALAPPDATA%\GrowthTimelapseStudio` |
| 启动入口 | 根目录内 `打开打印延时.command` | 根目录内 `打开打印延时.cmd` |
| 作品 | 根目录内 `exports/` | 根目录内 `exports\` |
| 激活记录 | 根目录内 `beta/` | 根目录内 `beta\` |
| 日志 | 根目录内 `logs/server.log` | 根目录内 `logs\server.log` |

源码版本放在独立 `releases/` 目录；重复安装同一版本会复用它，仍重新检查运行环境。升级保留旧版本、导出与激活记录。失败后完成终端提示并重试即可；不要删除整个用户数据目录。安装过程被强行终止时，确认没有安装进程后再删除 `.install.lock`。

启动器在后台运行本机服务，关闭 Agent 对话后服务继续运行；重复启动会复用同一版本的已运行实例。端口默认为 4317；被其他程序占用时尝试后续 9 个端口。终端输出实际地址、日志与进程号。需要停止时，确认输出的进程仍是本程序后结束该进程。

维护者先生成实际源码包，再生成放在 ZIP 旁边的外部发行清单：

```sh
node scripts/finalize-install-manifest.mjs --archive "/完整路径/growth-timelapse-studio-1.1.0-beta.1-source.zip"
```

该命令不会发布 GitHub Release。把源码 ZIP、外部清单与安装指南上传到同一个固定 tag 的 Release 后，才能向学员提供可执行的公开安装链接。仓库内模板仍保持 `published: false`；不要把 ZIP 的 SHA256 回填到 ZIP 内文件并重打包，以免哈希自我引用。具体发布步骤见 [发布维护](docs/RELEASE.md)，软件与依赖的来源和许可见 [第三方记录](THIRD_PARTY_NOTICES.md)。
