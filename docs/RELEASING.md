# macOS Apple Silicon 发布

当前仅发布 **macOS arm64**，适用于 Apple M 系列芯片，最低系统版本为 macOS 12。产物为 DMG、包含 `.app` 的 ZIP，以及 `SHA256SUMS.txt`。工作流不构建或发布 Intel Mac、Windows 或 Linux 安装包。

## 自动发布

工作流位于 [release.yml](../.github/workflows/release.yml)。发布前更新 `package.json` 和 `package-lock.json` 的版本，提交全部源码、验证脚本和 `public/models/` 显示资产，然后为同一个提交创建版本标签：

```bash
npm version 0.2.0 --no-git-tag-version
# 检查并提交本次修改后：
git tag v0.2.0
git push origin master
git push origin v0.2.0
```

版本标签必须是 `vX.Y.Z`，并与两个 package 文件的版本一致。标签推送会触发构建并发布 GitHub Release。也可在 Actions 的 **Release macOS Apple Silicon → Run workflow** 中输入已经存在的版本标签；手动触发会检出标签对应提交，而不是把当前分支误当成该版本。

工作流顺序：

1. 使用 `macos-15` Apple Silicon runner，检查操作系统与 Node.js 均为 arm64，检查检出提交、Git 标签及 package 版本一致。
2. `npm ci` 安装锁定依赖，执行单元测试、默认装配和旋锁装配数值验证、全部素材导入校验。
3. 构建客户端，再运行 `electron-builder --mac dmg zip --arm64 --publish never`。构建阶段不获得 Release 写权限。
4. 核对 `.app` 中每个 Mach-O 文件均只有 arm64 架构，校验应用签名，分别展开 ZIP、挂载 DMG并比对实际应用内容。
5. 启动打包后的应用，验证 WebGL、渲染器隔离、15 组素材目录以及真实 GLB 加载。
6. 上传通过验证的 DMG、ZIP 和 SHA-256 清单；单独的发布任务重新验证清单，只使用这些文件创建 Release。

发布首先建立草稿，附件全部上传成功后才公开；附件上传中断时不会把半成品公开。重试可以恢复草稿，已经公开的版本不会被静默覆盖，需要用新版本号发布修复。`GITHUB_TOKEN` 来自 Actions 自身，不需要存放个人令牌。

官方 runner 架构说明见 [actions/runner-images](https://github.com/actions/runner-images#available-images)：`macos-15` 为 arm64，`macos-15-intel` 才是 x64。工作流也在运行时验证，避免标签语义变化时误发架构。所有第三方 action 实际均为 GitHub 官方 `actions/*`，并固定到已核对的提交 SHA。

## 签名与首次打开

目前使用 **ad-hoc 本地签名**，保证 Apple Silicon 应用代码可验证；没有 Apple Developer ID 身份签名，也没有 Apple 公证。发布说明会明确这一点，不会把 ad-hoc 签名称为 Apple 认证。

下载后先核对发布来源与 SHA-256。如果首次打开被 macOS 阻止，可在「系统设置 → 隐私与安全性」中对这一个应用批准打开。不要关闭系统全局 Gatekeeper，也不要对来源未知的应用绕过检查。

安装 DMG 后将 Mechanical Studio 拖到 Applications。ZIP 解压后同样将 `.app` 移到 Applications。两者为相同 arm64 应用；ZIP 主要用于便携下载或工具化分发。

若以后需要 Developer ID 签名和公证，应作为独立发布配置接入 Apple 凭据，并同步调整工作流和发布说明。目前配置明确 `identity: "-"`、`notarize: false`，不会因为机器上碰巧存在证书或环境变量而改变发布身份。

## 在 M 系列 Mac 上本地构建

```bash
npm ci
npm test
npm run verify:demo
npm run verify:bayonet
npm run assets:verify
npm run release:mac
npm run release:mac:verify
npm run release:mac:smoke
```

安装包位于 `release/Mechanical-Studio-0.2.0-macos-arm64.dmg` 和同名 `.zip`。资源构建使用已提交的 GLB，不要求构建机器安装 Blender。原始模型的重新导出需要 Blender 5.2.2，见 [素材说明](assets.md)。

本地普通开发仍可使用 `npm run desktop` 或 `npm run desktop:pack`，它们不触发公开发布。只有上述 Actions 工作流负责 Release，且附件采用明确允许列表。
