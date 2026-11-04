# 版本演进与快速回溯索引 (CHANGELOG)

## v1.3.1 (2026-11-04 23:05) — `perf(render-export)`
- **变更摘要**：解锁画质下拉框写实自然光影选项，移除多余按钮并实现导出全链路硬件加速大幅提速
- **定位文件**：`index.html`, `scripts/render-cycles.py`, `server.mjs`, `src/app.js`, `src/studio.js`, `src/style.css`
- **回溯上一版**：`git checkout v1.3.0` ｜ **撤回本次**：`git revert v1.3.1`

## v1.3.0 (2026-11-04 22:38) — `feat(studio)`
- **变更摘要**：开放写实渲染独立按钮、优化实时与Cycles导出渲染速度、支持多版本Blender跨平台发现及Win系统与拓竹全机型3MF导入兼容
- **定位文件**：`bambu-engine.mjs`, `index.html`, `realistic-render.mjs`, `runtime-paths.mjs`, `scripts/prepare-slice-project.py`, `scripts/prepare-support-project.py`, `scripts/render-cycles.py`, `scripts/windows-runtime.mjs` 等 19 个文件
- **回溯上一版**：`git checkout v1.2.0-beta.7` ｜ **撤回本次**：`git revert v1.3.0`

