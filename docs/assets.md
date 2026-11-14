# 原有 Blender 素材与客户端显示副本

客户端的「仓库素材」来自 `assets/puretv-controller/` 的 15 个集合。`manifest.json` 中的 SHA-256 在转换前逐项核对。当前源清单包含 **183 个对象**：原 189 件中的八个上弹簧定位环已与对应键帽合并为闭合的一体打印件，并新增确认开关的两个独立金属焊脚。键帽、弹簧、套筒、开关和壳体仍独立。源尺寸修正、前后证据与物理参数假设见 [源几何说明](puretv-geometry.md)；导出脚本本身只读源文件。

## 重新生成

源文件使用 Blender 5.2 的文件格式；Blender 4.3 无法读取，报错 `incomplete header, may be from a newer version of Blender`。请使用 [Blender 5.2.2 或更新版本](https://download.blender.org/release/Blender5.2/)，在项目根目录执行：

```sh
blender -b --python scripts/export_assets.py
node scripts/index_asset_nodes.mjs
node scripts/verify_assets.mjs
```

仅更新一个源集合时，可以使用增量导出；它保留其他集合的 GLB、目录和诊断，且会检查未选中源文件是否仍与已导出版本一致：

```sh
blender -b --python scripts/export_assets.py -- --only electronics/harness.blend
node scripts/index_asset_nodes.mjs
node scripts/verify_assets.mjs
```

安装 Node 依赖后可运行 `node scripts/verify_assets.mjs`，使用客户端同款 Three.js GLTFLoader 重新加载每个 GLB，核对可见网格数量、导出哈希、毫米尺寸和装配中心。该检查允许减面副本的整体包围盒相对源模型有小于 0.5 mm 的差异，仅验证导入比例和位置，不是局部尺寸验收。

首次导出使用官方 Blender 5.2.2 Linux x64，发行包 SHA-256 为 `84098912789dc450e95697c4184fb8a90acbe5111c2ba4aede3fecb57806a168`，与官方 `.sha256` 文件核对一致。构建和运行客户端不依赖 Blender；生成的 GLB 已随项目提供。

脚本只在内存里追加集合、求值修改器并生成显示副本，不调用保存源文件操作。每个对象超过 16,000 三角形时才进行减面，上下壳的预算为每个对象 48,000 三角形；材质保留基础颜色和金属度，移除纹理依赖。

产物：

- `public/models/catalog.json`：库条目、原文件路径、GLB 地址、源求值几何的整体尺寸与装配中心、对象数和显示三角形数。`nodes` 列出每个可拆分源对象的客户端实际节点名、显示名、世界尺寸和中心。
- `public/models/puretv-assembly.json`：可直接导入客户端的手柄工程。运行节点索引脚本后，183 个子件按共享装配坐标恢复，用同一整体位移放到工作台。原始线束保持显示模型；真实 MCP 装配脚本另外声明九个接触机构并连接九路指示灯。
- `public/models/*.glb`：客户端显示用模型，保留源对象名及 `sourceName`、`sourceFile`、`previewOnly` 自定义属性。
- `public/models/diagnostics.json`：源文件和显示文件 SHA-256、源对象边界边/非流形边数量、减面前后三角形数量和装配矩阵。

## 单位与装配位置

源坐标中 1 Blender 单位对应 1 mm。GLB 中保留原数值尺寸，坐标由 Blender 的 Z 向上转换为客户端的 Y 向上：`(x, y, z) → (x, z, -y)`。`catalog.json` 的 `size` 和 `center` 已完成同样的转换。导出时不会把所有集合各自挪到原点，所以仍可利用 `center` 恢复原始整机装配。

客户端添加一个集合时，可以将显示模型整体包围盒居中后放到选定位置；这种放置不改变内部零件相对坐标。把所有 `Part.position` 设置为各集合 `center`，保留 `size` 和零旋转，可恢复共享坐标下的装配；如果需要把整机移至工作台，应给所有集合加上同一个位移。

选择一个原始总成后，可利用 `nodes` 分拆为独立零件。节点名使用 Three.js 加载后的实际值（它会替换原名中的部分空白和标点），`displayName` 保留中文原名。分拆时应保留该节点世界变换，再对中心和尺寸进行归一，不能只取 mesh 的局部 transform。

## 校验范围

这里的显示模型和包围盒只用于浏览、布置和保守空间预检。减面可能改变局部圆弧、卡耳、薄壁和孔边，因此不能用显示三角形证明打印公差、榫卯余隙或旋锁路径正确。诊断是在减面前的求值网格上统计边界边和非流形边；它没有验证自相交、对象间最小距离、装配路径、弹簧力或实体强度。边界边/非流形边为零，也不等于已通过这些验证。

线束已跟随上游 `dcded14` 更新为 0.56 mm 名义外径：九根地线汇入公共接地点，再经公共地线回板，共 20 个线束对象。上游记录的合壳与 0、0.25、0.50、0.75、1.00 mm 离散按压位置检查未发现键帽碰线；右键套筒内最紧处的名义线间净距约为 0.049 mm。这些是上游源模型的离散检查结果，不是客户端动态仿真或实际制造公差认证。线径、弯曲半径、焊点、绝缘、排针顺序，以及电子件、弹簧和开关的实际规格仍需试装与测量。程序化零件的尺寸校验与原始资产浏览应分别理解。原始手柄投入打印前仍应按 `AGENTS.md` 的顺序，从单键静止、触发、到底和回弹测试开始，随后核对偏心按压、四键底座、合壳、布线和实际试印。

## 素材署名

方向键帽、ABXY 键面和部分上盖参考或改编自 **Taohid Animation — [PS5 Controller](https://sketchfab.com/3d-models/ps5-controller-b7bb9c5102a04cb0b1966c6d02bad7d6)**，采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。pureTV 项目修改了尺寸、布局并增加机械结构，本次新增 GLB 格式转换、显示减面和材质简化。原素材及其改编部分继续保留原署名和许可。
