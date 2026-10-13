# 开发说明

本文件中的测试和打包命令适用于源码仓库；官方运行包保留操作文档与演示媒体，不包含测试或开发构建脚本。

## 结构

| 路径 | 内容 |
| --- | --- |
| `index.html`、`src/` | 浏览器工作台、Three.js 预览与导出封包 |
| `server.mjs`、根目录 `.mjs` 模块 | 本机 HTTP 服务、切片与渲染任务 |
| `scripts/` | Python 工程准备、Cycles 渲染与照片线段检测 |
| `assets/backgrounds/` | 六套正式背景 |
| `vendor/slicer-profiles/bambu-v02.07.01.57/` | 最小 Bambu 参数数据、原许可与来源清单 |
| `vendor/test-dom/` | 仅测试使用的 LinkeDOM 与原 ISC 许可 |
| `examples/测试2.3mf` | 多色演示案例 |
| `docs/media/` | 界面截图、操作动图与案例演示 |
| `tests/` | 自动测试与自行生成的小型几何数据 |
| `exports/` | 运行时生成的作品，不提交到仓库 |

## 安装与启动

推荐 Node.js 24 LTS，最低 22。Python 3 与兼容切片器用于模型导入；视频编码需要 FFmpeg。Blender 4.5 LTS 与 OpenCV 是可选组件。

```sh
npm ci
npm run doctor
npm start
```

浏览器访问服务显示的本机地址。服务绑定 `127.0.0.1`，默认端口 4317；需要其他端口时设置 `PORT`。使用期间保持服务运行，在启动终端按 `Ctrl+C` 结束。

## 外部程序配置

默认尝试标准安装位置和 `PATH` 命令。设置变量后重新运行服务与 `doctor`。

| 环境变量 | 指向 |
| --- | --- |
| `PYTHON_PATH` | 准备切片工程所用 Python 3 可执行文件 |
| `FFMPEG_PATH` | FFmpeg 可执行文件 |
| `BLENDER_PATH` | Blender 可执行文件 |
| `BAMBU_STUDIO_PATH` | Bambu Studio 可执行文件 |
| `ORCA_SLICER_PATH` | OrcaSlicer 可执行文件 |
| `FLASH_STUDIO_PATH` | Flash Studio / Orca-Flashforge 可执行文件 |
| `PHOTO_CALIBRATION_PYTHON` | 可选，已安装 `cv2`、`numpy` 的独立 Python 3 |
| `OPENCV_PYTHONPATH` | 可选，OpenCV / NumPy 所在模块目录 |
| `PORT` | 本机服务端口，默认 4317 |

macOS 例子（按实际安装位置调整）：

```sh
export BAMBU_STUDIO_PATH='/Applications/BambuStudio.app/Contents/MacOS/BambuStudio'
export BLENDER_PATH='/Applications/Blender.app/Contents/MacOS/Blender'
npm run doctor
npm start
```

变量值应指向可执行文件，而非安装包或 `.app` 文件夹。切片器安装包里的配置目录也必须存在；非标准目录可用 `BAMBU_STUDIO_RESOURCES`、`ORCA_SLICER_RESOURCES` 或 `FLASH_STUDIO_RESOURCES` 指定资源目录。

可选 OpenCV 环境可以在项目内独立准备：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install opencv-python-headless==4.12.0.88 numpy==2.2.6
export PHOTO_CALIBRATION_PYTHON="$PWD/.venv/bin/python"
npm run doctor
npm start
```

## 验证

依赖安装后运行自动测试：

```sh
npm test
```

本机真实切片测试另行开启，需要兼容切片器与 Python：

```sh
npm run test:native-slicing
```

涉及 Blender / Metal 的测试或人工渲染串行执行，避免争用 GPU。修改制作流程后检查导入、取消与重试、背景切换、模型摆放、首末帧、填充与支撑、颜色、输出尺寸与时长。修改透明导出时，在合成软件中核对透明边缘；新增平台支持时补充安装、切片与导出检查。

## 生成源码包

使用发布脚本从明确的文件清单生成源码 ZIP、逐文件 manifest 和 SHA256 校验值：

```sh
python3 scripts/package-release.py
```

结果写到 `release/`。源码包包含运行代码、背景、案例、文档与测试；解压后执行 `npm ci` 安装依赖。发布维护步骤见 [发布说明](RELEASE.md)。

## 本机数据与贡献

浏览器保存素材缓存与设置。服务生成的 `exports/`、`.slice-jobs/`、`.slice-diagnostics/` 和 `.support-jobs/` 由 `.gitignore` 排除。

提交修改时说明问题、复现步骤和验证结果；新增素材补充来源与许可。许可记录见 [LICENSE](../LICENSE) 与 [第三方声明](../THIRD_PARTY_NOTICES.md)。
