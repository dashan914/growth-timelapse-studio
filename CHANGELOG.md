# 版本演进与快速回溯索引 (CHANGELOG)

## v1.5.0 (2026-11-05 00:49) — `feat(update-push)`
- **变更摘要**：向已安装客户端推送 v1.2.0-beta.8 正式更新清单与校验指纹
- **定位文件**：`SOURCE_MANIFEST.json`, `install-manifest.json`
- **回溯上一版**：`git checkout v1.4.0` ｜ **撤回本次**：`git revert v1.5.0`

## v1.4.0 (2026-11-05 00:43) — `feat(release)`
- **变更摘要**：发布 1.2.0-beta.8 发行配置、写实自然光影与硬件加速导出版本说明
- **定位文件**：`.github/workflows/source-release.yml`, `INSTALL_AGENT.md`, `README.md`, `SOURCE_MANIFEST.json`, `beta-activation.mjs`, `beta-config.json`, `docs/RELEASE.md`, `docs/SOFTWARE_PURCHASE.md` 等 15 个文件
- **回溯上一版**：`git checkout v1.3.4` ｜ **撤回本次**：`git revert v1.4.0`

## v1.3.4 (2026-11-04 23:56) — `fix(realistic-preview)`
- **变更摘要**：修复写实自然光影预览被切片支撑与背景视频拦截的问题并强化预览加载反馈
- **定位文件**：`src/app.js`, `src/studio.js`, `src/style.css`, `tests/scene-package.test.mjs`
- **回溯上一版**：`git checkout v1.3.3` ｜ **撤回本次**：`git revert v1.3.4`

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

