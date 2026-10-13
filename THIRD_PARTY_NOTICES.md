# 第三方来源、许可证与素材

原创代码采用 [MIT 许可证](LICENSE)。本文件记录依赖、配置数据与素材的来源及各自许可。

## JavaScript 依赖

| 组件 | 来源与版本 | 许可、用途与声明位置 |
| --- | --- | --- |
| Three.js | 0.186.1，[官方项目](https://github.com/mrdoob/three.js) | MIT，© 2010–2026 three.js authors。用于预览、模型加载、材质和 GLTFExporter；`npm ci` 后原全文位于 `node_modules/three/LICENSE`。 |
| fflate | Three.js 随附 0.8.2，[官方项目](https://github.com/101arrowz/fflate) | MIT，用于 3MF / ZIP 解析与封包。随 Three.js 安装的模块保留原许可声明。 |
| meshoptimizer / MeshoptSimplifier | Three.js 随附 1.1，[官方项目](https://github.com/zeux/meshoptimizer) | MIT，© 2016–2026 Arseny Kapoulkine。用于模型显示层级的简化计算；源模型仍保留。原模块头部声明位于 `node_modules/three/examples/jsm/libs/meshopt_simplifier.module.js`。 |

依赖版本锁定在 `package-lock.json`，使用 `npm ci` 安装。

## 仅发行构建使用的依赖

`javascript-obfuscator` 固定为 5.9.0，来源为 [官方项目](https://github.com/javascript-obfuscator/javascript-obfuscator)，采用 BSD-2-Clause。仅在维护者构建官方运行包时执行，不安装到用户运行版，不调用在线混淆服务。许可原文保留在 `vendor/licenses/javascript-obfuscator.LICENSE.txt`。原创代码与第三方组件原许可不因轻量处理改变。

## 仅测试使用的依赖

`vendor/test-dom/worker.mjs` 来自 [LinkeDOM](https://github.com/WebReflection/linkedom/tree/3fcf145cd95ac9a2f0a1b7db62dbf7c5737b410e)，commit `3fcf145cd95ac9a2f0a1b7db62dbf7c5737b410e`。采用 ISC 许可，© 2021 Andrea Giammarchi, @WebReflection，用于 Node 测试中的 DOMParser。原许可见 `vendor/test-dom/LICENSE`，URL 与 SHA256 见同目录 `manifest.json`。

## 随公开版保留的配置数据

`vendor/slicer-profiles/bambu-v02.07.01.57/` 含运行需要的最小 Bambu Studio 参数资料，来源为 [Bambu Studio v02.07.01.57](https://github.com/bambulab/BambuStudio/tree/3f126b717ed1f10fee0f32f05ed9731808d0c8bb)，固定 commit `3f126b717ed1f10fee0f32f05ed9731808d0c8bb`。

这些数据采用 **AGPL-3.0**，原全文见该目录 `LICENSE`，逐文件来源与 SHA256 见 `SOURCES.json`。

## 用户自行安装的外部程序

| 程序 | 用途与许可范围 |
| --- | --- |
| Bambu Studio / OrcaSlicer / Flash Studio | 本机切片；许可与随附库声明见各自安装包。 |
| FFmpeg | MP4 / MOV 编码；LGPL / GPL 等条款取决于构建，可用 `ffmpeg -L` 查看。 |
| Blender 4.5 LTS / Cycles | 写实渲染；Blender 为 GPL，独立 Cycles 核心为 Apache-2.0，随附库按各自许可。 |
| OpenCV / opencv-python-headless | 照片线段检测；验证版本 4.12.0 / wheel 4.12.0.88。OpenCV 为 Apache-2.0，Python 包装代码为 MIT，wheel 随附库按各自许可。 |
| NumPy | OpenCV 运算依赖；验证版本 2.2.6，BSD-3-Clause，随附库按各自许可。 |

软件和包的来源：[FFmpeg](https://ffmpeg.org/)、[Blender 4.5 LTS](https://www.blender.org/releases/4-5/)、[Cycles](https://github.com/blender/cycles)、[OpenCV 4.12.0](https://github.com/opencv/opencv/tree/4.12.0)、[NumPy](https://numpy.org/)。

## 示例模型

`examples/测试2.3mf` 的原 metadata 记录：设计者 **张大山l**，标题“河狸变身计划 蜥蜴-汤姆【可动弹簧分件版无需ams】”，许可标记 **Standard Digital File License**。模型沿用该许可。来源、文件校验值与处理记录见 [examples/SOURCE.json](examples/SOURCE.json)。

## 背景素材

| 文件 | 原项目记录的来源 |
| --- | --- |
| `assets/backgrounds/h2c.jpg` | 用户提供的 H2C 实拍照片 |
| `assets/backgrounds/p1s.jpg` | 用户提供的 P1S 实拍照片 |
| `assets/backgrounds/a1.jpg` | 用户提供的 A1 实拍照片 |
| `assets/backgrounds/pastel-rug.png` | 用户选定的生成图片原图，彩绒台面；原生成流程使用过参考图片 |
| `assets/backgrounds/blue-grey.png` | 用户选定的生成图片原图，蓝灰摄影棚；原生成流程使用过参考图片 |
| `assets/backgrounds/teal-room.png` | 用户选定的生成图片原图，青绿室内；原生成流程使用过参考图片 |

图片许可记录：现有项目资料未提供独立许可证，未纳入代码 MIT 许可。

新增组件或素材时，在此补充用途、固定来源与原许可，并保留对应版权声明。
