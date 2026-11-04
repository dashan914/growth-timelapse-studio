# 版本演进与快速回溯索引 (CHANGELOG)

## v1.3.3 (2026-11-04 23:21) — `fix(studio-export)`
- **变更摘要**：修复卡在1%的Fixed jitter报错并启用WebGL画布零拷贝GPU直绘缩放极速导出
- **定位文件**：`src/export-quality.js`, `src/spatial-sampling.js`, `src/studio.js`
- **回溯上一版**：`git checkout v1.3.2` ｜ **撤回本次**：`git revert v1.3.3`

## v1.3.2 (2026-11-04 23:13) — `perf(background-video)`
- **变更摘要**：大幅提升带背景视频MP4导出速度：优化视频Seek步进容差并打通运镜硬件加速流式管道
- **定位文件**：`src/app.js`, `src/camera-motion.js`, `src/studio.js`
- **回溯上一版**：`git checkout v1.3.1` ｜ **撤回本次**：`git revert v1.3.2`

## v1.3.1 (2026-11-04 23:05) — `perf(render-export)`
- **变更摘要**：解锁画质下拉框写实自然光影选项，移除多余按钮并实现导出全链路硬件加速大幅提速
- **定位文件**：`index.html`, `scripts/render-cycles.py`, `server.mjs`, `src/app.js`, `src/studio.js`, `src/style.css`
- **回溯上一版**：`git checkout v1.3.0` ｜ **撤回本次**：`git revert v1.3.1`

## v1.3.0 (2026-11-04 22:38) — `feat(studio)`
- **变更摘要**：开放写实渲染独立按钮、优化实时与Cycles导出渲染速度、支持多版本Blender跨平台发现及Win系统与拓竹全机型3MF导入兼容
- **定位文件**：`bambu-engine.mjs`, `index.html`, `realistic-render.mjs`, `runtime-paths.mjs`, `scripts/prepare-slice-project.py`, `scripts/prepare-support-project.py`, `scripts/render-cycles.py`, `scripts/windows-runtime.mjs` 等 19 个文件
- **回溯上一版**：`git checkout v1.2.0-beta.7` ｜ **撤回本次**：`git revert v1.3.0`

