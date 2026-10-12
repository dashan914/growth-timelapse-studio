# 发布维护

1. 更新版本号、README、操作指南与演示素材；新增依赖或素材时同步 [第三方来源记录](../THIRD_PARTY_NOTICES.md)。
2. 执行 `npm ci`、`npm run doctor` 和 `npm test`，制作流程有改动时再运行 `npm run test:native-slicing`。
3. 导入附带案例，检查背景、摆放、时间线与短视频导出；将检查结果写入 [验证记录](VERIFICATION.md)。
4. 执行源码打包：

```sh
python3 scripts/package-release.py
```

5. 在新目录解压并检查启动：未激活可导入、编辑和预览，视频、透明序列和预览图片导出会弹出解锁窗口；有效兑换码解锁后可导出。检查取消解锁、联网失败和凭证过期仍可继续编辑。
6. 对已完成的 ZIP 生成外部安装清单，ZIP 内模板保持 `published: false`：

```sh
node scripts/finalize-install-manifest.mjs --archive "release/growth-timelapse-studio-1.1.0-beta.1-source.zip" --repository dashan914/growth-timelapse-studio
```

7. 将源码 ZIP、`SHA256SUMS.txt`、外部 `install-manifest.json` 和 `INSTALL_AGENT.md` 上传到固定 `v1.1.0-beta.1` 的 GitHub Release。公开仓库和 Release 后，以未登录身份访问指南、下载 ZIP，并核对 SHA256；不要向使用者提供本机地址。
8. 山地造物的安装指南设置填写已验证可访问的固定链接 `https://github.com/dashan914/growth-timelapse-studio/blob/v1.1.0-beta.1/INSTALL_AGENT.md`。该网站仍按自己的 `AGENTS.md` 完成本地验收、上线确认、生产备份与部署。

仓库保留源码、案例、文档、背景和测试。依赖通过 `npm ci` 安装，本机切片器与编码器按 [快速开始](QUICK_START.md) 准备。运行缓存和用户导出文件由 `.gitignore` 排除。
