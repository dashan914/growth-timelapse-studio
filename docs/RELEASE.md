# 发布维护

1. 更新版本号、README、操作指南与演示素材；新增依赖或素材时同步 [第三方来源记录](../THIRD_PARTY_NOTICES.md)。
2. 执行 `npm ci`、`npm run doctor` 和 `npm test`，制作流程有改动时再运行 `npm run test:native-slicing`。
3. 导入附带案例，检查背景、摆放、时间线与短视频导出；将检查结果写入 [验证记录](VERIFICATION.md)。
4. 执行源码打包：

```sh
python3 scripts/package-release.py
```

5. 在新目录解压并检查启动，再把 `release/` 中的 ZIP 与 SHA256 校验文件上传到对应版本的 GitHub Release。

仓库保留源码、案例、文档、背景和测试。依赖通过 `npm ci` 安装，本机切片器与编码器按 [快速开始](QUICK_START.md) 准备。运行缓存和用户导出文件由 `.gitignore` 排除。
