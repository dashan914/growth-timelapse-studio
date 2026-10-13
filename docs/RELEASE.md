# 发布维护

当前固定目标：软件 **1.2.0-beta.5**，tag **v1.2.0-beta.5**。本轮 4 个新版 UI GIF 已完成实际录制与媒体核验；完整软件测试 897 项（879 通过、18 环境跳过、0 失败）、运行包回归和旧下载清理脚本 7 项测试通过，公开发行与外部清理结果待实际执行后记录。山地造物网站 **1.15.1** 已部署。

公开仓库继续保留 MIT 源码、测试和开发打包流程。官方 ZIP 为 `growth-timelapse-studio-1.2.0-beta.5-runtime.zip`，延续轻量压缩与混淆、第三方许可和 `RUNTIME_MANIFEST.json`。本轮只更新当前 UI 的实际操作媒体与固定安装文档，不改变授权、价格、星光和离线逻辑。已保存的旧源码 ZIP 与清单仍兼容，旧下载入口按下面顺序清理。

1. 更新版本号、README、操作指南与演示素材；新增依赖或素材时同步 [第三方来源记录](../THIRD_PARTY_NOTICES.md)。核对 `package.json`、锁文件、`APP_VERSION`、`beta-config.json` 与安装清单版本一致；保留现有 `growth-timelapse-beta` 产品及可信公钥。
2. 执行 `npm ci`、`npm run doctor` 和 `npm test`，制作流程有改动时再运行 `npm run test:native-slicing`。
3. 使用当前版本实际录制工作台、背景、摆放、色彩与镜头操作，生成 `current-workbench.gif`、`current-backgrounds.gif`、`current-transform.gif` 和 `current-color-lens.gif`；检查动图完整帧、时长、真实按钮与操作对应，README 和 UI 指南不得引用旧布局 GIF。录屏完成后再记录实际验证结果。在原源码和独立运行包完成回归、doctor、启动与真实小案例切片检查，历史计数不替代本轮结果。
4. 构建官方运行包，发行目录示例：

```sh
node scripts/build-runtime-release.mjs --output "release/runtime-1.2.0-beta.5"
```

公开源码的开发打包命令继续保留，生成独立 `-source.zip`：

```sh
python3 scripts/package-release.py
```

5. 在新目录解压官方运行 ZIP，核对 `RUNTIME_MANIFEST.json` 的实际运行文件哈希，检查无 source map、测试和开发构建资料，第三方文件与许可保留；执行安装、doctor 和启动验证。未激活可导入、编辑并进行无水印实时预览，选择免费 MP4 后只在导出成片写入动态水印；无水印视频、透明 MOV、PNG 序列与预览图片需激活。验证实时与写实免费成片水印、已解锁成片无水印、学员原星光兑换、软件内购买和已有兑换码。购买价格仍为一年 ¥19.90（365 天）或永久 ¥39.90，仅绑定一台设备，换机先解绑；安装升级保留作品、订单和授权。新官方运行包与旧源码包各使用对应 ZIP 的清单、哈希和安装入口，不将一种包的校验值用于另一种。
6. 对已完成的 ZIP 生成外部安装清单，ZIP 内模板保持 `published: false`：

```sh
node scripts/finalize-install-manifest.mjs --archive "release/runtime-1.2.0-beta.5/growth-timelapse-studio-1.2.0-beta.5-runtime.zip" --repository dashan914/growth-timelapse-studio
```

7. 将官方运行 ZIP、`SHA256SUMS.txt`、外部 `install-manifest.json` 和 `INSTALL_AGENT.md` 上传到固定 `v1.2.0-beta.5` 的 GitHub Release。先验证新版匿名下载、外部清单、ZIP SHA256、包内媒体和 `RUNTIME_MANIFEST.json`；只有通过后，按用户最新授权清理已知旧 Release、旧包附件和旧 tag refs（包括 1.1 下载标记），保留 commit 源码历史，不重写提交。记录实际删除对象和结果，不提前宣称清理完成。源码开发包继续使用自己的 `SOURCE_MANIFEST.json`，不混用两类哈希。
8. 网站安装指南在 beta.5 公开校验完成后更新为固定链接 `https://github.com/dashan914/growth-timelapse-studio/blob/v1.2.0-beta.5/INSTALL_AGENT.md`，外部清单为 `https://github.com/dashan914/growth-timelapse-studio/releases/download/v1.2.0-beta.5/install-manifest.json`。网站配置更新按自己的 `AGENTS.md` 执行，原课程支付保持关闭。原支付、签名与星光逻辑不变，详情见 [软件购买](SOFTWARE_PURCHASE.md)。

beta.3 与 beta.4 的历史结果保留在 [验证记录](VERIFICATION.md)，beta.5 的录屏、本地完整测试与运行包回归结果已记录；最终公开 ZIP、SHA256、外部清单和旧下载标记清理结果仍需在执行后补录。56 项拓竹矩阵为历史软件验证，未逐台实体打印，范围见 [兼容性报告](BAMBU_PRINTER_COMPATIBILITY.md)。

公开源码仓库保留源码、案例、文档、背景和测试；官方运行包保留运行文件、使用文档、演示媒体与许可，压缩与混淆仅提高阅读改动成本。依赖仍通过 `npm ci` 安装，本机切片器与编码器按 [快速开始](QUICK_START.md) 准备。运行缓存和用户导出文件由 `.gitignore` 排除。

本次固定 `v1.2.0-beta.5` 先完成新版实际录屏与本地运行验证，再构建、发布和公开校验。清理旧下载标记前先核对计划，严格限于用户已授权的旧 Release、附件和 tag refs；commit 源码历史不改写。仓库与包内安装模板保持 `published: false`，实际安装使用发布后的外部清单。
