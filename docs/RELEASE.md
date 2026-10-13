# 发布维护

当前发布目标：软件 **1.2.0-beta.2**，固定 tag **v1.2.0-beta.2**，本轮待发行。山地造物网站 **1.15.1** 已部署，软件 **1.2.0-beta.1** 已公开预发布；本文件列出 beta.2 的完成条件，不代表新版本发行步骤已经执行。

1. 更新版本号、README、操作指南与演示素材；新增依赖或素材时同步 [第三方来源记录](../THIRD_PARTY_NOTICES.md)。核对 `package.json`、锁文件、`APP_VERSION`、`beta-config.json` 与安装清单版本一致；保留现有 `growth-timelapse-beta` 产品及可信公钥。
2. 执行 `npm ci`、`npm run doctor` 和 `npm test`，制作流程有改动时再运行 `npm run test:native-slicing`。
3. 导入附带案例，检查背景、摆放、时间线与短视频导出；确认背景按钮为“自定义导入图片背景”，预设标题为“选择背景预设”，底板按钮为“调整底板，矫正透视”，辅助照片按钮为“导入成品照片辅助对齐（可选）”。新增工具栏入口为“阴影调节”“色彩匹配”“镜头虚化”，原“颜色与光线”参数移到独立“色彩匹配”面板；须检查分别打开面板、修改参数及关闭重开后保留设置。免费水印采用按文字收紧的底框，左右各 10 px 等距留白，画面宽 16%、上限 170 px、额外 alpha 0.38，在中部缓慢双轴移动；分别检查预览、实时 FFmpeg 和写实导出的一致性。将实际检查结果写入 [验证记录](VERIFICATION.md)，上一批 881 项测试不能替代最新面板拆分的回归。
4. 执行源码打包：

```sh
python3 scripts/package-release.py
```

5. 在新目录解压并检查启动：未激活可导入、编辑、预览和选择免费动态水印 MP4；无水印视频、透明 MOV、PNG 序列与预览图片需激活。验证实时与写实两路水印、学员原星光兑换、软件内购买和已有兑换码；购买为一年 ¥19.90（365 天）或永久 ¥39.90，仅绑定一台设备，换机先解绑，学员原设备规则保持不变。重点检查扫码时学员入口仍保留，未付款能返回选择 YEAR/LIFETIME，原订单凭证在本地存档，并明确原二维码在有效期内仍有效、只支付一笔。检查取消、联网失败和凭证过期仍可编辑并选择免费 MP4，已激活凭证可在有效期内离线使用。
6. 对已完成的 ZIP 生成外部安装清单，ZIP 内模板保持 `published: false`：

```sh
node scripts/finalize-install-manifest.mjs --archive "release/growth-timelapse-studio-1.2.0-beta.2-source.zip" --repository dashan914/growth-timelapse-studio
```

7. 将源码 ZIP、`SHA256SUMS.txt`、外部 `install-manifest.json` 和 `INSTALL_AGENT.md` 上传到固定 `v1.2.0-beta.2` 的 GitHub Release，保留旧版本资产。将本次新生成的 `SOURCE_MANIFEST.json` 同步至发行提交，并确认 ZIP 中的源码与该提交对应。公开仓库和 Release 后，以未登录身份访问指南、下载 ZIP，并核对 SHA256；不要向使用者提供本机地址。
8. 山地造物购买服务 1.15.1 已部署；beta.2 发行资产验证后，网站安装指南设置再更新为固定链接 `https://github.com/dashan914/growth-timelapse-studio/blob/v1.2.0-beta.2/INSTALL_AGENT.md`，外部清单为 `https://github.com/dashan914/growth-timelapse-studio/releases/download/v1.2.0-beta.2/install-manifest.json`。网站配置更新按自己的 `AGENTS.md` 执行，原课程支付保持关闭。支付宝与微信的未付款下单均返回 201，用户尚未实际付款，不将下单成功视为真实扣款或签名回调验收；完整授权与部署说明见 [软件购买](SOFTWARE_PURCHASE.md)。

上一版已记录的本地验收：完整软件测试 869 项，851 通过、18 跳过、0 失败；拓竹 14 个机型 × 4 种喷嘴共 56 个组合的真实切片与路径解析全部通过。矩阵未覆盖逐台实体打印。beta.2 的新增返回套餐、学员入口与订单存档验收结果须在发行前补录。结果与历史验收见 [验证记录](VERIFICATION.md) 和 [兼容性报告](BAMBU_PRINTER_COMPATIBILITY.md)。

仓库保留源码、案例、文档、背景和测试。依赖通过 `npm ci` 安装，本机切片器与编码器按 [快速开始](QUICK_START.md) 准备。运行缓存和用户导出文件由 `.gitignore` 排除。

本次固定 `v1.2.0-beta.2` 标签拟通过仓库的 `source-release.yml` 在 GitHub 构建并发布；工作流先核对版本和校验文件，在资产全部上传后公开预发布版本。记录实际完成状态前保持“待发行”，旧版本不覆盖。
