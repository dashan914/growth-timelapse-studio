# 开发说明

## 结构

| 路径 | 内容 |
| --- | --- |
| `index.html`、`src/` | 浏览器工作台、Three.js 预览与导出封包 |
| `server.mjs`、根目录 `.mjs` 模块 | 本机 HTTP 服务、切片与渲染任务 |
| `scripts/` | Python 工程准备、Cycles 渲染与照片线段检测 |
| `assets/backgrounds/` | 六套正式背景 |
| `vendor/slicer-profiles/bambu-v02.07.01.57/` | 最小 Bambu 参数数据、原许可与来源清单 |
| `vendor/test-dom/` | 仅测试使用的 LinkeDOM 与原 ISC 许可 |
| `examples/测试2.3mf` | 用户指定的多色案例，保留模型原许可 |
| `docs/media/` | 指定案例的工作台截图与短演示 |
| `tests/` | 公开版中可独立执行的测试 |
| `exports/` | 运行时生成的作品，不提交到仓库 |

公开版不带 `research/`、历史 `samples/`、非发布内容的私人素材、已有导出作品、`node_modules/` 或外部软件二进制。原有测试已迁移到公开版；需要模型的测试使用 `tests/fixtures/` 中自行生成的小型几何数据，不依赖历史研究样片。

## 安装与启动

推荐 Node.js 24 LTS，最低 22。Python 3 与兼容切片器用于模型导入；视频编码需要 FFmpeg。Blender 4.5 LTS 与 OpenCV 是可选组件。

```sh
npm ci
npm run doctor
npm start
```

浏览器访问服务显示的本机地址。服务绑定 `127.0.0.1`，默认端口 4317；需要其他端口时设置 `PORT`。使用期间保持服务运行，在启动终端按 `Ctrl+C` 结束。

## 外部程序配置

默认尝试标准安装位置和适用的 `PATH` 命令。设置变量后重新运行服务与 `doctor`。程序路径由启动环境配置，不从网页请求接受。

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

此例使用原项目已验证的版本，安装产生的库不进入源码仓库。Windows 的虚拟环境路径与命令不同；完整流程尚未验证。

## 验证

依赖安装后运行公开版自动测试：

```sh
npm test
```

本机真实切片测试另行开启，需要兼容切片器与 Python：

```sh
npm run test:native-slicing
```

涉及 Blender / Metal 的测试或人工渲染应串行执行，避免争用 GPU。公开测试不包含历史研究目录；通过逻辑测试也不等于已通过整片画面审核。

修改制作流程后，用有权使用的模型进行短视频检查：导入、取消与重试、背景切换、模型摆放、首帧与末帧、实际填充/支撑、颜色、输出尺寸与时长。修改透明导出时，还应在合成软件里核对透明边缘。新增平台支持需实际验证安装、切片和导出后再更新平台声明。

## 生成源码包

使用发布脚本从明确的文件清单生成源码 ZIP、逐文件 manifest 和 SHA256 校验值：

```sh
python3 scripts/package-release.py
```

结果写到 `release/`。包内不包含依赖、外部二进制或制作成品，这是源码包，用户解压后仍需安装依赖。发布前在新目录重新检查，详见 [发布清单](RELEASE.md)。

附带多色案例的清理范围、来源和许可见 [案例说明](../examples/README.md)，原文件与公开副本校验值见 `examples/SOURCE.json`。案例模型的许可独立于代码 MIT 许可。

## 本机数据与贡献

浏览器中的素材缓存与设置独立于源码，服务还可能生成 `exports/`、`.slice-jobs/`、`.slice-diagnostics/` 和 `.support-jobs/`。这些目录被 `.gitignore` 排除，但导出的模型、素材、日志仍需在分享前检查。

提交修改时说明问题、复现输入和验证结果；新素材需同时提供来源与许可。原创代码的许可见 [LICENSE](../LICENSE)，第三方配置和依赖说明见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。
