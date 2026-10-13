# Windows 下载后的环境配置与验收

适用 Windows x64。基础实时模式使用 Node.js、Python 和本机切片器；写实渲染和照片立柱检测是可选扩展。普通 Windows 用户要完成依赖检查与首次验收，只有自动发现失败或程序安装在特殊位置时才需要手动配置路径。

## 1. 必须、条件必需与可选依赖

| 组件 | 要求 | 使用范围 |
|---|---|---|
| Node.js 与 npm | 工作台最低 Node 22，平台安装器需要 Node 24+，推荐 24 LTS | 必需 |
| Python 3 | 真实解释器，避免只有 Microsoft Store 的启动占位入口 | 必需；切片工程准备及 PNG 打包使用标准库 |
| Bambu Studio / OrcaSlicer / Flash Studio | 至少一种，具有工作台所需 CLI 参数和配套配置资源 | 必需；程序能打开不等于 CLI 检测通过 |
| 当前桌面浏览器 | WebGL 可用 | 必需；预览需实际检查 |
| FFmpeg | MP4 的 H.264；透明 MOV 需 ProRes 4444 与 alpha 支持 | 视频输出条件必需；PNG 序列不需要 |
| Blender | 上游使用 4.5 LTS；本次兼容分支在 Windows 5.2.2 LTS 做过小模型实测 | 写实模式可选 |
| OpenCV / NumPy | 可在独立 Python 环境使用 opencv-python-headless 4.12.0.88 与 numpy 2.2.6 | 自动找照片立柱可选，手动标记无需安装 |

使用 Windows 原生程序即可。源码下载不会自动包含 node_modules、切片器、FFmpeg 或 Blender。

左侧“切片目标机型”独立提供 14 款拓竹 0.4 mm 配置；H2C、P1S、A1 背景照片仍只用于画面。STL 与未保存机型信息的 3MF 使用所选目标，保留机型信息的 3MF 优先使用源工程。机型配置从所选本机切片器的 resources/profiles 读取；旧版配置目录缺少所选机型时，请更新 Bambu Studio / OrcaSlicer 的机型配置后再试。完整机型表见 `src/printer-presets.json`。

## 2. 首次下载后必做

1. 选择明确版本，优先使用固定 Release 的源码 ZIP 和外部安装清单，并核对 SHA256。仓库内 `published:false` 是发行模板，不表示已经发布的外部清单不可用。
2. 解压到独立目录，先阅读 INSTALL_AGENT.md；让环境检查确认真实解释器、切片器 CLI 和资源目录。
3. 安装 npm 锁定依赖，运行 doctor，启动本机工作台。保留终端错误与 doctor 输出供排查。
4. 导入仓库示例或一个单盘工程，确认真实切片完成、多色与时间线正常。再检查一次关闭、重启和项目恢复。
5. 如果要验证不同目标机型，请在“切片目标机型”选择对应机型，再导入一个小型 STL 并确认切片完成；单盘 3MF 有完整机型信息时不会被下拉选项改写。导出时由使用者自行输入兑换码。技术环境通过不替代授权、画面质量或透明边缘验收。

已安装依赖时，在源码目录用 PowerShell：

```powershell
npm.cmd ci
npm.cmd run doctor
.\start.cmd
```

需要安装器统一管理版本和用户数据时，按 INSTALL_AGENT.md 使用固定 Release 外部清单。持有明确版本源码，也可指定 `-Source`。数据目录应与源码分离，例如：

```powershell
powershell -NoProfile -File .\scripts\install.ps1 `
  -Source "$PWD" -InstallRoot "D:\GrowthTimelapseStudioData" -NoRuntimeInstall
```

`-NoRuntimeInstall` 适用于复用现有软件的验证：缺失依赖即停止。希望安装器补齐依赖时按安装指南执行，系统安装界面由本人处理。

## 3. 条件必做：绑定自动发现不到的程序

本兼容分支会检查 PATH、Windows 已登记的应用、Python Launcher 和项目 `.venv`，能发现部分自定义安装目录与 Steam Blender。未登记的便携程序仍需显式指定。已有显式路径无效时保持报错，避免悄悄更换软件。

在启动该项目的 PowerShell 会话或本项目启动脚本设置变量，无需修改全局 PATH：

```powershell
$env:PYTHON_PATH = 'D:\Tools\Python\python.exe'
$env:BAMBU_STUDIO_PATH = 'D:\Tools\Bambu Studio\bambu-studio.exe'
$env:BAMBU_STUDIO_RESOURCES = 'D:\Tools\Bambu Studio\resources'
$env:FFMPEG_PATH = 'D:\Tools\ffmpeg\bin\ffmpeg.exe'
$env:BLENDER_PATH = 'D:\Tools\Blender\blender.exe'
npm.cmd run doctor
```

变量需指向实际可执行文件。只安装一种切片器即可；使用 Orca/Flash 时改用其对应变量，不填写未安装程序的占位路径。运行安装器时，成功识别的路径和可选渲染/视觉配置会保存在该安装的数据目录，双击启动可以复用。

若需要独立视觉环境，先用真实 Python 创建 `.venv`，再在其中安装包。仓库记录的 NumPy 2.2.6 建议配合 Python 3.11–3.13；选更高版本时先检查对应 wheel，避免源码编译。

```powershell
& 'D:\Tools\Python\python.exe' -m venv .venv
.\.venv\Scripts\python.exe -m pip install opencv-python-headless==4.12.0.88 numpy==2.2.6
$env:PHOTO_CALIBRATION_PYTHON = "$PWD\.venv\Scripts\python.exe"
```

## 4. Windows 专属兼容点

- Bambu 的 Windows GUI 启动器可能把 stdout/stderr 重定向到控制台，使普通 Node 管道得到空帮助文本。本分支用无控制台辅助进程读取真实帮助，仍验证版本、软件身份与全部必需参数。
- Windows PowerShell 5.1 调用原生程序时会处理内联 JavaScript 的引号；本分支直接读取 `node --version`，避免已有 Node 24 被误判为缺失。
- PNG 序列使用 Python 标准库打包，不要求安装 `/usr/bin/zip` 或 Unix 工具。
- Python 工程准备输出统一 UTF-8，避免中文错误被错误解码后变成泛化提示。
- Windows 临时目录可能有长路径/8.3 别名，比较前统一解析；POSIX mode 位检查不作为 Windows ACL 验收。
- 原生切片测试入口由 Node 设置环境变量，PowerShell/cmd 均可调用 `npm.cmd run test:native-slicing`。

## 5. 可选写实渲染

自动设备选择优先尝试 OptiX、CUDA、Metal、HIP、oneAPI，未发现适合设备时明确使用 CPU。可以在本项目环境设置 `GROWTH_CYCLES_DEVICE=OPTIX`、`CUDA`、`METAL`、`HIP`、`ONEAPI` 或 `CPU`；显式指定的 GPU 不可用时应报错。

本分支分别处理 Blender 4.x 的场景合成器和 5.x 的合成器节点组、输出节点、alpha 转换、数学/混色节点与照片缩放接口。保留原几何、材质区域与完整帧数检查。

本机已完成 Windows / Blender 5.2.2 / RTX 5060 OptiX 三帧小立方体检查。Blender 4.5、macOS/其他 GPU 的原生回归、复杂模型长视频和最终视觉效果仍应由对应设备验收。驱动和 GPU 偏好不由本项目全局修改。

参考：[Blender 5.0 合成器迁移](https://developer.blender.org/docs/release_notes/5.0/migration/compositor_migration/) · [Cycles 设备](https://developer.blender.org/docs/features/cycles/devices/)。
