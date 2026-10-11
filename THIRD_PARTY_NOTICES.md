# 第三方来源、许可证与素材

此文件记录精简公开版实际包含或调用的组件。许可证全文和各组件原声明仍适用；本项目的 MIT 许可仅覆盖原创代码，不统一替换第三方、外部软件或素材的条款。

## JavaScript 依赖

| 组件 | 来源与版本 | 许可、用途与声明位置 |
| --- | --- | --- |
| Three.js | 0.186.1，[官方项目](https://github.com/mrdoob/three.js) | MIT，© 2010–2026 three.js authors。用于预览、模型加载、材质和 GLTFExporter；`npm ci` 后原全文位于 `node_modules/three/LICENSE`。 |
| fflate | Three.js 随附 0.8.2，[官方项目](https://github.com/101arrowz/fflate) | MIT，用于 3MF / ZIP 解析与封包。随 Three.js 安装的模块保留原许可声明。 |
| meshoptimizer / MeshoptSimplifier | Three.js 随附 1.1，[官方项目](https://github.com/zeux/meshoptimizer) | MIT，© 2016–2026 Arseny Kapoulkine。用于模型显示层级的简化计算；源模型仍保留。原模块头部声明位于 `node_modules/three/examples/jsm/libs/meshopt_simplifier.module.js`。 |

依赖版本锁定在 `package-lock.json`。源码包不附带 `node_modules/`，安装后应保留原包的许可证与版权声明。

## 仅测试使用的依赖

`vendor/test-dom/worker.mjs` 是 [LinkeDOM](https://github.com/WebReflection/linkedom/tree/3fcf145cd95ac9a2f0a1b7db62dbf7c5737b410e) 的固定源码，commit `3fcf145cd95ac9a2f0a1b7db62dbf7c5737b410e`，采用 ISC 许可，© 2021 Andrea Giammarchi, @WebReflection。用于 Node 测试中的 DOMParser，不是浏览器正式运行依赖。该目录保留原 `LICENSE` 和逐文件 URL / SHA256 的 `manifest.json`。

## 随公开版保留的配置数据

`vendor/slicer-profiles/bambu-v02.07.01.57/` 含运行需要的最小 Bambu Studio 参数资料，来源为 [Bambu Studio v02.07.01.57](https://github.com/bambulab/BambuStudio/tree/3f126b717ed1f10fee0f32f05ed9731808d0c8bb)，固定 commit `3f126b717ed1f10fee0f32f05ed9731808d0c8bb`。

这些第三方数据保留 **AGPL-3.0** 许可，原全文见该目录 `LICENSE`，逐文件来源与 SHA256 见该目录来源清单。公开版未将下载的 Bambu C++ 源码或切片器二进制打包进应用。处理或再分发这些数据时须遵守它们自己的条款，不能改称 MIT。

## 用户自行安装的外部程序

| 程序 | 用途与许可范围 |
| --- | --- |
| Bambu Studio / OrcaSlicer / Flash Studio | 通过本机独立进程生成真实切片。公开版不附带这些软件；其许可证、版权和随附库声明由各自安装包提供。 |
| FFmpeg | 编码 MP4 / MOV。FFmpeg 的 LGPL / GPL 及其他条款取决于实际构建；可用 `ffmpeg -L` 查看。公开版不附带 FFmpeg 二进制。 |
| Blender 4.5 LTS / Cycles | 可选本机写实渲染。Blender 及其附带库按安装包许可处理；独立 Cycles 核心的 Apache-2.0 许可不能代替整个 Blender 的 GPL 与其他随附声明。公开版不附带 Blender。 |
| OpenCV / opencv-python-headless | 可选照片线段候选检测。原项目验证版本为 OpenCV 4.12.0 / wheel 4.12.0.88。OpenCV 为 Apache-2.0，Python 包装代码为 MIT，wheel 内其他库按各自许可处理。公开版不附带 wheel。 |
| NumPy | OpenCV 相关运算依赖，原项目验证版本 2.2.6。BSD-3-Clause 及附带库许可；公开版不附带该包。 |

软件和包的来源：[FFmpeg](https://ffmpeg.org/)、[Blender 4.5 LTS](https://www.blender.org/releases/4-5/)、[Cycles](https://github.com/blender/cycles)、[OpenCV 4.12.0](https://github.com/opencv/opencv/tree/4.12.0)、[NumPy](https://numpy.org/)。

## 示例模型的独立许可

`examples/测试2.3mf` 是用户指定的公开案例，其原 metadata 记录设计者为 **张大山l**、标题为“河狸变身计划 蜥蜴-汤姆【可动弹簧分件版无需ams】”、许可标记为 **Standard Digital File License**。

公开副本保留模型几何、涂色与原许可标记，移除了附带杂图和部分非功能元数据。原始与公开文件的 SHA256、清理范围见 [examples/SOURCE.json](examples/SOURCE.json)。该模型不受本项目代码的 MIT 许可授权；使用或再分发应遵循模型原许可，本文件不另行授予或解释商业使用权。

## 背景素材与品牌

| 文件 | 原项目记录的来源 |
| --- | --- |
| `assets/backgrounds/h2c.jpg` | 用户提供的 H2C 实拍照片 |
| `assets/backgrounds/p1s.jpg` | 用户提供的 P1S 实拍照片 |
| `assets/backgrounds/a1.jpg` | 用户提供的 A1 实拍照片 |
| `assets/backgrounds/pastel-rug.png` | 用户选定的生成图片原图，彩绒台面；原生成流程使用过参考图片 |
| `assets/backgrounds/blue-grey.png` | 用户选定的生成图片原图，蓝灰摄影棚；原生成流程使用过参考图片 |
| `assets/backgrounds/teal-room.png` | 用户选定的生成图片原图，青绿室内；原生成流程使用过参考图片 |

现有项目记录未提供这些图片的独立再分发许可，代码 MIT 许可不自动覆盖它们。发布者应在公开上传前确认图片可公开再分发；需要可明确复用的素材时，可替换为自己拥有相关权益的背景并更新此表。

Bambu Lab、H2C、P1S、A1 及各软件名称仅用于描述兼容功能或图片内容。相关商标与品牌权益属于各自权利人；本项目不声明对其拥有权利，也不表示得到其官方认可。

## 未纳入公开版的研究内容

原项目历史研究快照、比较样片、第三方研究源码与运行时未随公开版分发；它们不是正式依赖。新增组件或素材时，请同时补充实际用途、固定来源与原许可。
