# 安装打印延时一键生成

复制下面这句话给能操作本机的 AI：

```text
请读取 https://raw.githubusercontent.com/dashan914/growth-timelapse-studio/v1.2.0-beta.6/INSTALL_AGENT.md，安装 1.2.0-beta.6。有旧版时按“老用户升级”使用原安装目录；没有旧版时，Windows 安装前先询问我安装到哪个盘。自动检查环境、补齐缺失依赖并安装启动，确认模型导入和预览正常，告诉我下次如何打开。
```

## 安装 AI 执行步骤

1. 检测系统与 CPU：macOS Apple Silicon / Intel 或 Windows x64。
2. 先检查已有安装；检测到本软件的 `installation.json` 或原启动入口时，转到下方“老用户升级”，继续使用原目录。没有已有安装且用户未指定目录时，Windows 安装前列出本机实际存在的本地磁盘、可用空间和建议安装目录，询问用户“你希望安装到哪个盘？也可以指定完整文件夹路径。”等待用户回答后再执行安装。默认位置作为一个可选项展示：`%LOCALAPPDATA%\GrowthTimelapseStudio`；其他盘可建议 `D:\GrowthTimelapseStudio` 等对应目录。用户已经明确指定安装盘或目录时，直接遵循，无需重复询问。确定目录后，检查该盘存在且目录可写，将完整路径记录为 `$growthInstallRoot`。
3. 检查必需依赖是否存在：Node.js 24+、Python 3、FFmpeg，以及 Bambu Studio / OrcaSlicer / Flash Studio 中的一种切片器。缺失项由第 5 步安装器补齐。Blender、OpenCV、NumPy 为可选项，不自动安装。
4. 下载官方固定版本文件并核验：

   - [外部安装清单](https://github.com/dashan914/growth-timelapse-studio/releases/download/v1.2.0-beta.6/install-manifest.json)
   - [运行包 ZIP](https://github.com/dashan914/growth-timelapse-studio/releases/download/v1.2.0-beta.6/growth-timelapse-studio-1.2.0-beta.6-runtime.zip)

   外部清单须满足 `release.published=true`、`release.version=1.2.0-beta.6`、`release.tag=v1.2.0-beta.6`、仓库为 `dashan914/growth-timelapse-studio`，下载 URL 固定到同一 tag。ZIP 的 SHA256 必须与 `release.sha256` 一致。仓库或 ZIP 内的 `published:false` 模板不能替代外部清单；文件不可用或校验失败时停止。

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

打开终端显示的本机地址，在独立测试会话中导入随包案例或一个小型 STL，确认本机切片完成并可播放预览。在“运镜与音效”勾选“使用默认音效”，确认预览随时间线播放参考原声；未导入自定义文件时，取消勾选应静音。可用本机临时合成的短音频额外检查自定义导入：导入后默认音效自动取消，预览改用自定义文件，移除后静音。不要替换用户当前工程、覆盖用户音频或将用户素材用于测试。完成后告诉用户实际工作台地址和再次启动入口。

| 系统 | 再次启动 |
| --- | --- |
| macOS | 双击 `~/Library/Application Support/GrowthTimelapseStudio/打开打印延时.command` |
| Windows | 双击用户所选安装目录中的 `打开打印延时.cmd`，例如 `D:\GrowthTimelapseStudio\打开打印延时.cmd` |

实际安装位置以安装器输出为准。

## 老用户升级

复制下面这段给能操作本机的 Agent：

```text
请按 https://raw.githubusercontent.com/dashan914/growth-timelapse-studio/v1.2.0-beta.6/INSTALL_AGENT.md 的“老用户升级”，把“打印延时一键生成”升级到 1.2.0-beta.6。先找到原安装目录，保留授权、订单和导出作品；核验固定版本的外部安装清单与运行 ZIP 的 SHA256，再用平台安装器安装到原目录。确认旧服务属于这个安装后再停止，不要删除整个安装目录、解除绑定或重新激活。完成后检查版本、原付费解锁状态及模型预览，告诉我软件地址和原启动入口。只有找不到已有安装时才询问安装目录。
```

Agent 按以下步骤执行：

1. **找到原安装目录。** 优先检查用户提供的路径、`GROWTH_DATA_DIR`、现有启动入口及正在运行的软件进程；然后检查 macOS 的 `~/Library/Application Support/GrowthTimelapseStudio` 或 Windows 的 `%LOCALAPPDATA%\GrowthTimelapseStudio`。以根目录 `installation.json` 中 `application=growth-timelapse-studio`、`releaseDirectory` 和启动入口中的 `--install-root` 交叉确认。不要把 `releases/` 中某个版本文件夹当作根目录。已找到原安装时直接复用；只有找不到时才询问安装目录，多个有效安装且无法确认当前使用哪一个时请用户选择。
2. **保存并核对数据。** 确认当前工程已保存且导出已完成；记录旧版本和启动入口。旧服务运行时，从本机 `/api/beta/status` 仅提取 `activated` 与 `expiresAt` 作为升级前的解锁状态及到期时间。仅在本机为 `beta/`、根目录 `installation.json` 和启动入口建立备份，记录已有 `exports/` 文件清单；保持备份的私有权限。不要输出或上传兑换码、签名授权内容、订单凭证或设备标识。整个 `beta/` 必须保留，其中包括本机授权、订单及订单历史；`exports/` 作品目录也必须保留。
3. **停止确认属于此安装的服务。** 检查根目录 `service.json` 中的 PID、source、URL，并与操作系统该 PID 的启动命令及 `/api/health` 的 `app`、`version`、`pid` 核对。确认命令指向此安装的 `releases/.../server.mjs` 后，只停止这个 PID；记录过期或 PID 已被其他程序使用时，不得据此停止进程。仅关闭浏览器不会停止后台服务。
4. **下载并校验固定 beta.6 文件。** 使用上方 `v1.2.0-beta.6` 的外部清单和运行 ZIP，核对仓库、版本、tag、`published=true` 及 ZIP SHA256，再解压到临时目录。清单缺失或校验失败时停止，保留原安装。不要下载 `main` 源码代替运行包，也不要使用 ZIP 内的未发布清单模板。
5. **用原根目录安装。** 在已核验 ZIP 解压后的 `growth-timelapse-studio` 文件夹中执行下列对应命令，将示例路径替换为实际绝对路径。保留已存在的运行依赖，由安装器检查缺失项并执行 `doctor`。不要删除根目录、`beta/`、`exports/` 或旧 `releases/`，也不要调用激活、购买或解除绑定接口。

macOS：

```sh
bash scripts/install.sh --manifest "/下载目录/install-manifest.json" --install-root "/原安装目录"
```

Windows PowerShell：

```powershell
$growthInstallRoot = "D:\GrowthTimelapseStudio" # 替换为检测到的原根目录
powershell -File .\scripts\install.ps1 -Manifest "C:\下载目录\install-manifest.json" -InstallRoot $growthInstallRoot
```

6. **检查升级结果。** 从原根目录的 `打开打印延时.command` 或 `打开打印延时.cmd` 启动；以新服务 `/api/health` 确认 `version=1.2.0-beta.6`，并检查原授权状态及到期时间、订单和导出文件仍在。使用独立测试会话，导入小型 STL 或随包案例完成切片和预览；检查“运镜与音效”入口及“使用默认音效”勾选时播放、未导入自定义文件且取消勾选时静音。可用本机临时合成的短音频检查自定义导入后取消默认音效、预览与成片使用该文件、移除后静音；不替换用户实际工程或音频。不要为检查解锁发起新付款或重激活。向用户报告实际版本、工作台地址、原启动入口及数据核对结果。

安装器把新版放入独立的 `releases/` 子目录，通过依赖安装和 `doctor` 检查后才切换启动入口，保留旧版本、导出作品、本机订单和授权记录。准备阶段检查失败时不会切换已选版本；启动失败时先查看原目录 `logs/server.log`，保留数据和备份，修复后用原启动入口重试。

同一台设备、同一用户数据目录且授权仍有效时，升级后无需再次付款或激活。年付授权的到期时间不会因升级延长；永久授权继续有效。换电脑或改用新的安装目录需要另行处理授权，不能保证直接继承。

若升级后原付费权限未恢复，先保留 `beta/` 中的原设备身份和订单，不重复购买。用户可在“导出解锁 → 已有兑换码 / 授权恢复码”输入已保存购买凭据中的恢复码联网恢复；Agent 应报告异常，由用户确认恢复操作。购买凭据可以从“导出已解锁”复制或保存，离线缓存凭据本身不会授予导出权限。

当前没有软件内自动更新功能。GitHub `main` 分支更新源码不会自动更新用户已安装的版本，也不会改变固定 Release 的运行 ZIP；升级使用固定版本的运行包和对应外部清单。上述下载链接固定到 `v1.2.0-beta.6`。
