# Tauri 2：macOS Apple Silicon 发布

当前仅发布 **macOS arm64**，适用于 M 系列芯片与 macOS 13 或更新版本。客户端改用 Tauri 2 和系统 WKWebView，不再包含 Electron、Chromium 或 Node.js 运行时。MCP 标准输入输出模式复用同一个原生可执行文件，不额外捆绑 Node 服务。

产物为 DMG、包含 `.app` 的 ZIP 和 `SHA256SUMS.txt`。模型资源仍随应用提供，因此最终包大小取决于模型总量；以发布附件和构建日志中的实测值为准。

## 自动发布

[release.yml](../.github/workflows/release.yml) 使用原生 `macos-15` ARM64 runner。更新 package.json、package-lock.json、src-tauri/Cargo.toml 和 src-tauri/tauri.conf.json 中的版本，重新生成 Cargo.lock，提交后推送同版本标签，例如 `v0.4.2`。

也可在 Actions 的 **Release macOS Apple Silicon → Run workflow** 中指定已经存在的版本标签。工作流检出该标签，核对版本及提交，不能将当前分支冒充为旧版本。

发布检查依次包含：

1. 确认操作系统、Node 和编译目标为 arm64，使用锁定的 npm 与 Cargo 依赖。
2. 运行组件、物理规则、项目数据、旋锁路径、源模型与显示校准校验、完整源证据绑定重算及原生 MCP 单元测试。
3. 编译 Rust + 前端，以 `aarch64-apple-darwin` 目标构建 Tauri APP/DMG，再从同一 APP 生成 ZIP。
4. 核对每个 Mach-O 文件均为 arm64，检查签名、挂载 DMG、展开 ZIP 并比对可执行文件；确认未残留 Electron 运行时。
5. 使用官方 MCP SDK 验证实际原生程序的协议互通，再启动打包后的 WKWebView 客户端，通过 MCP 检查 WebGL、GLB 加载和完整旋锁流程，再实际装配 pureTV 手柄，逐一验证九键接触点灯、松手断电及真实渲染件运动；源证据必须匹配且通过。SDK 与 Node.js 只用于开发和 CI，不随应用打包。
6. 将实际打包应用的 `puretv-macos-mcp-verification.json` 作为独立 Actions 验证附件保存。计算 DMG/ZIP 的 SHA-256，只上传这两个包和校验清单。单独的发布任务再次验证后创建草稿，附件上传完成才公开 Release。

已公开的版本不能静默覆盖；修复需递增版本号。中断的草稿可以重试。工作流使用 Actions 自带的 `GITHUB_TOKEN`，不存放个人令牌。

## 签名和安装

当前为 **ad-hoc 本地签名**，未使用 Apple Developer ID，也未进行 Apple 公证。首次打开可能需要在「系统设置 → 隐私与安全性」中批准这个已核对来源的应用。不要关闭全局 Gatekeeper。

DMG 打开后，将 Mechanical Studio 拖到 Applications；ZIP 解压后同样将 `.app` 移到 Applications。两者包含相同的 arm64 客户端。

若以后接入 Developer ID 和公证，应更新原生配置、CI 凭据与发布说明。当前 `src-tauri/tauri.conf.json` 明确使用 `signingIdentity: "-"`，工作流不会声明 Apple 认证。

## 本地构建

M 系列 Mac 需要 Node.js 22+、Rust stable、Xcode Command Line Tools（`xcode-select --install`）。运行：

```bash
npm ci
npm test
npm run verify:demo
npm run verify:bayonet
npm run assets:verify
npm run verify:puretv-calibration
npm run verify:puretv-evidence
cargo test --locked --manifest-path src-tauri/Cargo.toml --no-default-features
npm run release:mac
npm run release:mac:verify
npm run release:mac:smoke
```

APP 位于 `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/`；发布文件位于 `release/Mechanical-Studio-0.4.2-macos-arm64.dmg` 和同名 ZIP。构建使用已提交的 GLB，不需要 Blender。

打包应用冒烟测试设置独立的 `MECHANICAL_STUDIO_DATA_DIR`。该变量同时启用不持久化的 WebView 存储并隔离单实例检查；测试不会读取或修改正常客户端中保存的工程。日常启动不要设置此测试变量，应用默认继续保存本地工程和组件库。

浏览器开发使用 `npm run dev`，原生开发使用 `npm run desktop`，仅编译本机可执行文件使用 `npm run desktop:pack`。Linux 原生开发还需要 Tauri 的 GTK/WebKitGTK 开发库；浏览器开发不需要 Rust 或这些库。本地开发不触发公开发布。

## 从 Electron 版本迁移

从 v0.2.x 升级前，在旧客户端点击“保存项目”导出 JSON，再用 Tauri 版本导入。两种桌面运行时使用不同的本地存储，不会自动搬迁旧版工程。工程 JSON 与仓库 Blender 源文件可继续使用；新版上传模型、分组和 PBR 外观均随工程导出。

## v0.4 原手柄素材更新

本版修改了原手柄源几何：八个上定位环并入键帽，确认开关补两个独立金属焊脚，源对象数变为183。旧工程中的仓库模型引用会使用安装版本随包的素材，不能据此重现旧版几何；缺失的旧定位环节点会显示错误，不会自动删除工程成员。需要精确保留旧模型时使用对应旧版应用与源文件。新设计可从「pureTV 九键试验」或当前原始素材重新建立，旧工程不能继承新装配的尺寸通过结论。用户上传的自包含 GLB/STL 不受这次仓库素材更新影响。

## 长期保存实际 Mac 验收报告

发布成功后，可手动运行 [Archive packaged macOS verification](../.github/workflows/archive-macos-verification.yml)，输入版本标签及对应成功发布流水线ID，例如：

```sh
gh workflow run archive-macos-verification.yml --ref master -f release_tag=v0.4.1 -f run_id=43596336457
```

此工作流核对仓库、发布工作流、成功状态、标签提交、校准哈希和原生九键结果，从原artifact读取报告并按原始字节保存至`docs/releases/<tag>/`，附来源与SHA-256。已有记录内容不同时拒绝覆盖；只向master提交归档文档，不修改已发布标签或安装包。若master并发前进导致push失败，可重跑。完整逐操作报告不是工程导出，无法单凭报告复算其工程哈希。

v0.4.1的[完整原生记录](releases/v0.4.1/puretv-macos-mcp-verification.json)与[来源](releases/v0.4.1/provenance.json)已归档，可在原Actions附件过期后继续查看。
