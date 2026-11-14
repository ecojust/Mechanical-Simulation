# 客户端交付检查记录

## v0.3.0 Tauri、组件上传与组合机构

迁移到 Tauri 2 / WKWebView，最低 macOS 13，仅发布 Apple Silicon。删除 Electron 和捆绑 Node；MCP stdio 模式复用同一原生可执行文件。

本地验证覆盖：

- 180 项单元测试：严格GLB/STL输入、类型/代理/尺寸、PBR、子件分组、几何运动、回弹、电路、撞针接触、机制与MCP命令。
- 11 组浏览器操作：上传/参数配置、IndexedDB恢复、工程导出、颜色/PBR、189原始子件、公母分组、实际Three对象联动、真实接触点灯、弹簧回弹、旋锁入槽与拒绝拔出。
- TypeScript与生产构建、15组源GLB重载、方榫9项/旋锁9项数值验证。
- Rust MCP 6项测试、macOS ARM64跨编检查；官方MCP SDK验证17工具、38次鉴权调用、超过16 MiB上传和分页导出完整恢复。

组合按钮回归使用键帽、弹簧、基座及固定开关：源开关故意保留旧压缩值与很小的行程阈值，仍必须等撞针接触声明触发区域才点灯；脱离后断电。检查真实渲染的活动件位置、弹簧压缩及固定件不动，并验证轴向显示长度与自由长度一致、任意旋转下弹簧固定端不漂移。组合旋锁回归覆盖路径阻挡、45°锁定、禁止直接拔出、逆旋与退出，及非零姿态编辑不能绕开运动校验。

2026-11-14，[发布流水线 43588610970](https://github.com/ecojust/Mechanical-Simulation/actions/runs/43588610970) 全部通过：在macOS启动实际打包APP，经MCP检查WKWebView/WebGL、上传STL、PBR、原始子件分组、组合按钮的接触点灯/回弹断电和旋锁全路径，渲染器未报告错误。DMG/ZIP的arm64架构、ad-hoc签名、包内容及SHA-256检查通过；打包程序与官方MCP SDK的17工具、38次鉴权调用、大模型上传和分页导出互通通过。

[v0.3.0 已公开发布](https://github.com/ecojust/Mechanical-Simulation/releases/tag/v0.3.0)，并重新下载公开附件核对SHA-256：

| 包 | 实际字节数 | 十进制 MB |
| --- | ---: | ---: |
| Tauri v0.3.0 DMG | 7,719,980 | 7.72 |
| Tauri v0.3.0 ZIP | 7,644,753 | 7.64 |
| Electron v0.2.0 DMG（对照） | 123,059,862 | 123.06 |

DMG相较上一版减少93.7%。安装要求为macOS 13及以上、Apple Silicon；本版未做Apple Developer ID签名或公证。

这些结果覆盖声明的参数化代理和指定测试机构，不证明任意源网格接触、摩擦、材料变形或制造精度；见 [组合功能机构](MECHANISMS.md)、[组件定义](COMPONENTS.md)、[MCP](MCP.md) 与 [验证边界](VALIDATION.md)。

## v0.2.0 旋锁与 macOS arm64

同步上游 `dcded14` 的 0.56 mm 线束与公共接地点模型，保留原机械改动；当前素材清单为 15 个集合、189 个对象。

本轮本地检查：77 项单元测试、5 组浏览器操作测试全部通过；旋锁 9/9 路径检查通过，原方榫示例 9/9 通过，15 组 GLB 重载校验通过。

新增同源双耳旋锁：完整插入、45°保持、锁后上拔阻挡、逆旋及完全拆出。公母每件均为闭合单连通实体，边界与非流形边均为零；STL重载尺寸无偏差。数值验证见 [旋锁报告](bayonet-verification.json)，实际网格和哈希见 [资产清单](../assets/bayonet/manifest.json)。

发布流水线仅构建macOS arm64 DMG/ZIP，校验所有Mach-O架构、签名和包内容后，再启动打包客户端实际执行旋锁装入/锁定/解锁/退出。实际构建状态与下载见 [GitHub Actions](https://github.com/ecojust/Mechanical-Simulation/actions/workflows/release.yml) 及 [Releases](https://github.com/ecojust/Mechanical-Simulation/releases)。签名为ad-hoc，未进行Apple Developer ID签名或公证。

## v0.1.0 初版检查（历史）

检查日期：2026-11-14。环境：Linux x64、Node.js 24.22.1、Electron 37.10.3、Three.js 0.180.0。

| 检查 | 结果 |
| --- | --- |
| TypeScript 与生产构建 | 通过 |
| 物理规则回归 | 24 / 24 通过 |
| 工程导入与数据边界 | 41 / 41 通过 |
| 浏览器操作 | 4 组通过：插入与阻挡、按压点灯、保存导入与分件、原手柄15总成加载 |
| 默认装配数值验证 | 9 / 9 通过；见 [原始计算报告](demo-verification.json) |
| 素材导出与重载 | 15 / 15 集合通过，187 个独立源对象；源文件 SHA-256 全部匹配 |
| Linux Electron 目录包 | 实际启动、WebGL、阻挡检查、GLB、JSON 保存导入通过；渲染器无错误 |

默认示例：方榫 12 mm，方孔 12.4 mm，双方尺寸公差均为 ±0.1 mm，最不利单侧余隙 0.100 mm。插入到 Y=23 mm 可达；穿壁横移与孔内旋转被拒绝。5 V 电源与 100 Ω 指示灯在开关闭合时为 50 mA；未按压及释放后断电。一秒施力、四秒释放的试验最终回到零位。

默认示例可以用 `npm run verify:demo` 重现，计算报告中包含完整输入参数和采样结果。浏览器操作用 `npm run test:e2e` 重现，物理及导入用 `npm test` 重现。

Linux 目录包中的前端和桌面入口已逐字节核对最终构建。圆销宽深尺寸联动也已在最终打包客户端中验证，深度改为 8 mm 时保存的尺寸为 `[8, 24, 8]`。其他系统的安装包、系统签名和图形驱动兼容性尚未验证；相应构建配置和说明见 [README](../README.md)。

这些结果验证的是客户端实现和指定参数化示例。原始手柄的复杂网格只作保守包围盒预检，未完成原件的接触、摩擦、材料变形、线束净空或制造认证。显示副本最大整体包围盒偏差为 0.012 mm，这不是局部榫卯尺寸精度承诺。完整限制见 [验证方法](VALIDATION.md)。
