# 发布维护

当前候选目标：软件 **1.2.0-beta.4**，固定 tag **v1.2.0-beta.4**，本地验证已完成；公开发行与旧包清理按下述顺序执行。山地造物网站 **1.15.1** 已部署，软件 **1.2.0-beta.3** 已公开预发布并完成公开 ZIP 校验；本文件列出 beta.4 官方运行包的完成条件，公开发布结果另记在发行记录中。

公开仓库继续保留 MIT 源码、测试和开发打包流程。官方 ZIP 改为 `growth-timelapse-studio-1.2.0-beta.4-runtime.zip`：本项目原创 JavaScript 轻量压缩与混淆，第三方 vendor 文件及许可原样保留；运行包不附 source map、测试或开发构建脚本，新增 `RUNTIME_MANIFEST.json` 记录实际运行文件哈希。保持运行路径与参数、授权、价格、星光和离线逻辑。这只是有限的阅读和修改门槛，不宣称闭源、加密安全或防破解，不采用重度反调试。旧 `-source.zip` 安装兼容保留。

1. 更新版本号、README、操作指南与演示素材；新增依赖或素材时同步 [第三方来源记录](../THIRD_PARTY_NOTICES.md)。核对 `package.json`、锁文件、`APP_VERSION`、`beta-config.json` 与安装清单版本一致；保留现有 `growth-timelapse-beta` 产品及可信公钥。
2. 执行 `npm ci`、`npm run doctor` 和 `npm test`，制作流程有改动时再运行 `npm run test:native-slicing`。
3. 在原源码完成回归，记录结果后再验证官方运行包功能等价。导入案例，检查背景、摆放、镜头设置、无水印实时预览和短视频导出；免费 MP4 成片烙水印，已解锁成片无水印。验证旧兑换码、支付恢复、设备绑定、原星光兑换和离线凭证，确认运行参数与原来一致。beta.3 已有测试结果不能替代本轮压缩、混淆后的运行包验证，将实际结果写入 [验证记录](VERIFICATION.md)。
4. 构建官方运行包，发行目录示例：

```sh
node scripts/build-runtime-release.mjs --output "release/runtime-1.2.0-beta.4"
```

公开源码的开发打包命令继续保留，生成独立 `-source.zip`：

```sh
python3 scripts/package-release.py
```

5. 在新目录解压官方运行 ZIP，核对 `RUNTIME_MANIFEST.json` 的实际运行文件哈希，检查无 source map、测试和开发构建资料，第三方文件与许可保留；执行安装、doctor 和启动验证。未激活可导入、编辑并进行无水印实时预览，选择免费 MP4 后只在导出成片写入动态水印；无水印视频、透明 MOV、PNG 序列与预览图片需激活。验证实时与写实免费成片水印、已解锁成片无水印、学员原星光兑换、软件内购买和已有兑换码。购买价格仍为一年 ¥19.90（365 天）或永久 ¥39.90，仅绑定一台设备，换机先解绑；安装升级保留作品、订单和授权。新官方运行包与旧源码包各使用对应 ZIP 的清单、哈希和安装入口，不将一种包的校验值用于另一种。
6. 对已完成的 ZIP 生成外部安装清单，ZIP 内模板保持 `published: false`：

```sh
node scripts/finalize-install-manifest.mjs --archive "release/runtime-1.2.0-beta.4/growth-timelapse-studio-1.2.0-beta.4-runtime.zip" --repository dashan914/growth-timelapse-studio
```

7. 将官方运行 ZIP、`SHA256SUMS.txt`、外部 `install-manifest.json` 和 `INSTALL_AGENT.md` 上传到固定 `v1.2.0-beta.4` 的 GitHub Release，待新版匿名下载、清单与 SHA256 验证通过后，删除四个已知旧版本的官方安装 ZIP 附件；保留版本标签、源码历史和 Release 记录，旧记录增加新版入口。核对 ZIP 内 `RUNTIME_MANIFEST.json` 和运行文件对应，公开源码提交与运行包构建来源对应。源码开发包继续使用 `SOURCE_MANIFEST.json`，不把它冒充运行文件哈希。公开后以未登录身份访问指南、下载 ZIP 并核对 SHA256；不要向使用者提供本机地址。
8. 山地造物购买服务 1.15.1 已部署；beta.4 运行资产验证后，网站安装指南设置再更新为固定链接 `https://github.com/dashan914/growth-timelapse-studio/blob/v1.2.0-beta.4/INSTALL_AGENT.md`，外部清单为 `https://github.com/dashan914/growth-timelapse-studio/releases/download/v1.2.0-beta.4/install-manifest.json`。网站配置更新按自己的 `AGENTS.md` 执行，原课程支付保持关闭。支付宝与微信的未付款下单均返回 201，用户尚未实际付款，不将下单成功视为真实扣款或签名回调验收；完整授权与部署说明见 [软件购买](SOFTWARE_PURCHASE.md)。

已发布 beta.3 的本地验收：完整软件测试 892 项，874 通过、18 跳过、0 失败；拓竹 14 个机型 × 4 种喷嘴共 56 个组合的真实切片与路径解析继续作为历史兼容性记录。矩阵未覆盖逐台实体打印。beta.4 已完成 897 项自动测试：879 通过、18 环境检查跳过、0 失败，独立目录安装、doctor、启动及实际切片导入通过。结果与历史验收见 [验证记录](VERIFICATION.md) 和 [兼容性报告](BAMBU_PRINTER_COMPATIBILITY.md)。

公开源码仓库保留源码、案例、文档、背景和测试；官方运行包保留运行文件、使用文档、演示媒体与许可，压缩与混淆仅提高阅读改动成本。依赖仍通过 `npm ci` 安装，本机切片器与编码器按 [快速开始](QUICK_START.md) 准备。运行缓存和用户导出文件由 `.gitignore` 排除。

本次固定 `v1.2.0-beta.4` 标签拟按仓库发布流程构建并发布官方运行资产；先核对版本、运行文件清单与外部 ZIP 校验值，在资产全部上传后公开预发布版本。先用 `scripts/cleanup-old-release-assets.py --dry-run` 查看旧 ZIP 清理计划；只有新版公开下载与校验通过才执行 `--apply`。历史代码与标签不改写。
