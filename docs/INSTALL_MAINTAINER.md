# 安装维护历史参考

以下完整保留此前的安装指南正文，作为历史维护参考；相对链接已适配本文件所在目录。它包含当时的维护、保护、发布、授权和长提示词说明，不作为新用户安装入口。

当前新安装指南：[INSTALL_AGENT.md](../INSTALL_AGENT.md)。固定 beta.5 标签、Release 附件和运行 ZIP 保持不变，本次只更新 main 分支文档。

---

# 使用 AI 安装打印延时一键生成

把下面完整提示词复制给任何能操作本机终端、文件和网络的 AI：

```text
请帮我在这台电脑安装并启动“打印延时一键生成”v1.2.0-beta.5。

先读取固定版本安装指南：
https://github.com/dashan914/growth-timelapse-studio/blob/v1.2.0-beta.5/INSTALL_AGENT.md

官方运行包：
https://github.com/dashan914/growth-timelapse-studio/releases/download/v1.2.0-beta.5/growth-timelapse-studio-1.2.0-beta.5-runtime.zip

外部安装清单：
https://github.com/dashan914/growth-timelapse-studio/releases/download/v1.2.0-beta.5/install-manifest.json

检测系统、CPU与已有Node.js、Python、切片器和FFmpeg，只补齐缺失依赖。核对外部清单的release.published为true、固定tag为v1.2.0-beta.5、ZIP对应版本为1.2.0-beta.5，并验证ZIP的SHA256；不要用仓库或ZIP里的published:false模板替代外部清单，也不要改用main/latest或未经核验的旧包。该固定版本未发布、下载失败或校验不符时停止并说明原因。

保留已有作品、工程、设置、订单与授权，不删除或覆盖用户数据目录。按指南执行安装器、npm依赖安装、doctor及启动检查；打开工作台，用随包小型案例或本机合成小模型完成一次真实切片导入与预览，确认没有报错，不替我付款、兑换星光或输出兑换码。

完成后告诉我实际工作台地址、用户数据位置、日志位置、重新启动入口和停止方法。系统安装器、权限、许可、首次打开及管理员密码均由我本人确认；不要代输入密码、关闭系统安全检查或绕过校验。
```

安装 AI 必须能够访问这台电脑的终端、文件和网络；纯对话 AI 无法完成本机安装。按上述提示词核验固定下载资产，不可用或校验失败时停止。

当前固定版本为 1.2.0-beta.5。下载入口：[v1.2.0-beta.5](https://github.com/dashan914/growth-timelapse-studio/releases/tag/v1.2.0-beta.5) · [外部安装清单](https://github.com/dashan914/growth-timelapse-studio/releases/download/v1.2.0-beta.5/install-manifest.json)。官方资产名为 `growth-timelapse-studio-1.2.0-beta.5-runtime.zip`。新版公开下载与校验通过后清理已知旧 Release 和旧 tag 下载标记，commit 源码历史与已有用户数据、授权保留。

官方运行包对本项目原创 JavaScript 采用轻量压缩与混淆，不附 source map、测试或开发构建脚本；操作指南、演示媒体、第三方 vendor 文件及许可保留，`RUNTIME_MANIFEST.json` 记录实际运行文件哈希。公开 MIT 源码和开发打包仍保留。此举只提高直接阅读和修改运行文件的成本，源码公开使其门槛有限，不构成防破解保证。已保存的旧 `-source.zip` 继续支持，既有授权和离线逻辑不变。

Windows 用户的依赖分类、手动路径配置和本机验收步骤见 [Windows 配置说明](WINDOWS_SETUP.md)。本地兼容修改属于派生源码，仍须保留固定发行包与外部清单；安装修改后的源码使用 `-Source`，不能把派生包冒充原始 Release。

## Agent 执行步骤

1. 读取本文件与 [install-manifest.json](../install-manifest.json)，检测操作系统和 CPU。入口支持 macOS Apple Silicon / Intel、Windows x64；Windows 和 Intel Mac 完整流程仍需实机验证。
2. 从维护者明确提供的固定 tag 的 GitHub Release 资产下载**外部 `install-manifest.json`**，不要使用 ZIP 内或仓库内的模板。外部清单的 `release.published` 必须为 `true`；仓库必须为 `dashan914/growth-timelapse-studio-beta` 或 `dashan914/growth-timelapse-studio`；URL 必须固定到指定 `release.tag`，SHA256 必须完整。不要用 `main` 或 `latest` 源码替代发行包，不要自行猜测下载地址。若指定版本尚未公开发布，维护者先完成发行；本地源码可按下文 `--source` 方式验证。
3. 按外部清单下载指定 ZIP：beta.5 官方安装使用 `-runtime.zip`，已保存的旧版本清单与 `-source.zip` 仍兼容。核对 SHA256，再解压并阅读安装脚本。建议把校验通过的 ZIP 保存到用户数据根目录的 `cache/<release.tag>.zip`，安装器会复用同一文件。ZIP 内的安装清单保持未发布模板，实际安装以外部清单为准。不要把下载脚本直接通过管道交给 shell。
4. 在解压目录执行：macOS `bash scripts/install.sh --manifest "/外部清单完整路径/install-manifest.json"`；Windows `powershell -File .\scripts\install.ps1 -Manifest "C:\外部清单完整路径\install-manifest.json"`。脚本优先复用 Node.js 24+、Python 3、FFmpeg 和兼容的切片器；缺失 Node 使用官方固定版 24.19.0，缺失切片器使用官方 Bambu Studio 2.7.1.57。
5. Python 与 FFmpeg 在 macOS 通过 Homebrew、Windows 通过 WinGet 安装。没有 Homebrew 时使用固定 commit 的官方安装脚本并验 SHA256；没有 WinGet 时请用户通过 Microsoft App Installer 安装。权限、许可、系统工具与首次打开提示由用户本人确认，不能代输入密码、关闭系统检查或忽略校验失败。
6. 安装器执行 `npm ci` 和 `doctor`，成功后创建启动入口并打开本机工作台。Blender、OpenCV 和 NumPy 为后续可选项。
7. 打开工作台，确认无需兑换码即可导入、编辑和进行无水印实时预览，只有免费 MP4 导出成片烙入动态水印；已解锁用户的成片无水印。无水印视频、预览图片、透明 MOV 与 PNG 序列需解锁；由使用者选择软件内扫码购买或输入已有兑换码。安装流程不自动付款或兑换星光，也不记录或输出兑换码。

软件内购买为一年 ¥19.90（365 天）或永久 ¥39.90，绑定一台设备；激活后可离线使用，换机前先在旧软件解除绑定并保存兑换码。学员入口通往山地造物原星光兑换页面，沿用原星光与设备规则；安装和升级保留已有激活记录。

支付二维码显示时学员入口仍可使用。未付款可返回套餐选择，切换一年（YEAR）或永久（LIFETIME）；原二维码在有效期内仍可付款，不要两笔都支付。原订单凭证保留在本机用户数据目录，付款结果未知时先查询原订单；安装 Agent 不代替使用者选择或支付订单。

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

安装版本放在独立 `releases/` 目录；重复安装同一版本会复用它，仍重新检查运行环境。官方运行包与本地源码安装都使用独立用户数据目录，升级保留旧版本、导出与激活记录。失败后完成终端提示并重试即可；不要删除整个用户数据目录。安装过程被强行终止时，确认没有安装进程后再删除 `.install.lock`。

启动器在后台运行本机服务，关闭 Agent 对话后服务继续运行；重复启动会复用同一版本的已运行实例。端口默认为 4317；被其他程序占用时尝试后续 9 个端口。终端输出实际地址、日志与进程号。需要停止时，确认输出的进程仍是本程序后结束该进程。

维护者先生成并验证官方运行包，再生成放在 ZIP 旁边的外部发行清单：

```sh
node scripts/finalize-install-manifest.mjs --archive "/完整路径/growth-timelapse-studio-1.2.0-beta.5-runtime.zip" --repository dashan914/growth-timelapse-studio
```

该命令不会发布 GitHub Release。把官方运行 ZIP、外部清单与安装指南上传到同一个固定 tag 的 Release 后，才能向学员提供可执行的公开安装链接。旧源码包仍按各自外部清单核验，不将运行包的 SHA256 用于源码包。仓库内模板仍保持 `published: false`；不要把 ZIP 的 SHA256 回填到 ZIP 内文件并重打包，以免哈希自我引用。源码开发打包命令继续保留在 [发布维护](RELEASE.md)，软件与依赖的来源和许可见 [第三方记录](../THIRD_PARTY_NOTICES.md)。
