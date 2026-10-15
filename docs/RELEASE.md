# 发布维护

本轮目标为软件 **1.2.0-beta.7**，固定 tag **v1.2.0-beta.7**，官方运行包为 `growth-timelapse-studio-1.2.0-beta.7-runtime.zip`。本轮修复拓竹 P1S/X1 系列机型硬件喷头偏移（extruder_offset）导致的切片与 3D CAD 模型错位、额头台阶、外凸与表面条纹干涉问题，并内置软件更新检测与提示弹窗。

新用户安装与老用户升级共用 [安装指南](../INSTALL_AGENT.md)。beta.7 的固定 AI 读取入口为 `https://raw.githubusercontent.com/dashan914/growth-timelapse-studio/v1.2.0-beta.7/INSTALL_AGENT.md`；持续维护入口仍为 `https://raw.githubusercontent.com/dashan914/growth-timelapse-studio/main/INSTALL_AGENT.md`。老用户使用原安装目录，保留 `beta/` 中的设备授权、订单、订单历史以及 `exports/` 作品；年付到期时间不变，永久授权继续有效。软件没有自动更新器。

公开仓库继续保留 MIT 源码、测试和开发打包流程。官方运行包延续轻量压缩与混淆、第三方许可和 `RUNTIME_MANIFEST.json`，不改变原签名产品 `growth-timelapse-beta`、可信公钥、购买价格、星光兑换及离线授权逻辑。

## 发布步骤

1. 核对 `package.json`、锁文件、`APP_VERSION`、`beta-config.json`、安装清单模板和当前下载文档均为 beta.7；保留产品 ID、可信公钥和本机数据路径。新增依赖或素材同步 [第三方来源记录](../THIRD_PARTY_NOTICES.md)。
2. 执行 `npm ci`、`npm run doctor` 和 `npm test`，核对安装器保留授权、订单与作品的升级回归，以及运行包内音效存在、可供浏览器和 FFmpeg 使用。需要时运行 `npm run test:native-slicing`。本轮实际结果写入 [验证记录](VERIFICATION.md)。
3. 构建官方运行包：

```sh
node scripts/build-runtime-release.mjs --output "release/runtime-1.2.0-beta.7"
```

源码开发包仍可独立生成，使用自己的 `SOURCE_MANIFEST.json`：

```sh
python3 scripts/package-release.py
```

4. 在独立目录解压运行 ZIP，核对 `RUNTIME_MANIFEST.json` 的实际文件哈希，确认不含 source map、测试、用户数据及开发构建资料。检查安装、doctor、启动与实际模型导入。
5. 回归原授权与水印流程：工作台实时预览无水印；免费 MP4 成片具有动态水印，已解锁成片无水印；无水印视频、透明 MOV、PNG 序列及预览图片保持解锁限制。
6. 为冻结的 ZIP 生成外部安装清单，源码和 ZIP 内模板保持 `published: false`：

```sh
node scripts/finalize-install-manifest.mjs --archive "release/runtime-1.2.0-beta.7/growth-timelapse-studio-1.2.0-beta.7-runtime.zip" --repository dashan914/growth-timelapse-studio
```

7. 发布独立 `v1.2.0-beta.7` GitHub 预发布，将官方运行 ZIP、`SHA256SUMS.txt`、外部 `install-manifest.json` 和 `INSTALL_AGENT.md` 作为附件。

固定下载地址：

- [beta.7 Release](https://github.com/dashan914/growth-timelapse-studio/releases/tag/v1.2.0-beta.7)
- [运行 ZIP](https://github.com/dashan914/growth-timelapse-studio/releases/download/v1.2.0-beta.7/growth-timelapse-studio-1.2.0-beta.7-runtime.zip)
- [外部安装清单](https://github.com/dashan914/growth-timelapse-studio/releases/download/v1.2.0-beta.7/install-manifest.json)

安装器在同一根目录的 `releases/` 下准备新版本，检查通过后才切换 `installation.json` 和启动入口。准备阶段失败时保留已选旧版本；升级时不得删除整个根目录、重建 `beta/`、解除设备绑定或要求重新付款。启动服务前后以 `/api/health` 和本机解锁状态检查实际选中的版本，PID 停止流程见安装指南。

beta.5 及更早的实测记录保留在 [验证记录](VERIFICATION.md)。56 项拓竹矩阵属于历史软件验证，未逐台实体打印，范围见 [兼容性报告](BAMBU_PRINTER_COMPATIBILITY.md)。Windows x64 与 Intel Mac 的完整安装仍须按对应实机结果记录。课程网站是独立项目；本轮软件发行不修改网站、价格或支付配置。
