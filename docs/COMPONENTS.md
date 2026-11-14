# 组件类型、上传与交互定义

每个零件的 `kind` 决定功能、端子、按压行为和配合检查。`model.id` 只引用显示模型，不会覆盖功能类型。内置参数化件已有明确类型；仓库来源名明确的上插销、下套筒、回位弹簧和轻触开关分别标为候选 `pin`、`sleeve`、`spring`、`button`。这些候选都带 `interaction.status = "unconfigured"`，没有套用内置参数，必须先人工标定。其他结构、PCB、排针和线束保持 `asset`（结构件 / 仅预检）。

## 原始素材拆分与分组

原始手柄项目按当前 183 个源对象加载（八个上定位环并入键帽，确认开关补两个独立焊脚），每个对象可独立选择、改色和配置；保留共享装配坐标，只整体抬升至工作台。一个源对象内的一体式键帽和上插销保持一体，不把互不相连的源对象合并成刚体。

`AssetNode.group = { id, name }` 记录已知配套关系：每个按键的键帽插销与下套筒是一个公母小组，弹簧与定位环、开关与按杆焊脚分别另组。确认键帽与按压导向座单独成组；座外锁耳与上盖构成另一实际安装副；底板固定件、两排针座、每对 GPIO/GND 线也按其实际关系分开。没有已知关联的对象保持独立，不将整个方向键当成一个分组。

实例上的关系保存为 `Part.assemblyGroup = { id, name }`。[`createRepositoryParts()`](../src/repository.ts) 保留每个节点的中心坐标与 `assetNode`，同次加入共用命名空间，不同次加入的组标识彼此隔离。分类规则在 [`repository_metadata.mjs`](../scripts/repository_metadata.mjs)，依据素材说明与 manifest 的明确来源名；`typeBasis` 记录候选类型依据。暂存的 `axis=[0,1,0]`、`anchor=[0,0,0]` 和源包围盒尺寸仅是编辑起点，不是测量结果。确认键源旋锁尤其不能视为已经符合内置标准双耳代理。

## 颜色与 PBR 材质

每个零件都有 `color`；可选 `material = { metalness, roughness, useSourceColor }` 定义 PBR 材质，金属度和粗糙度都在 `[0,1]`。原始和上传网格保留真实几何；`useSourceColor=true` 保留源模型配色，关闭后使用零件颜色。材质随项目及自定义组件一起保存，不改变碰撞尺寸或材料力学参数。

## 上传和保存

在“我的组件”上传静态 `.glb` 或 `.stl`，选择原文件单位（mm、cm、m），再填写类型和参数。显示尺寸换算为毫米；GLB 材质保留，STL 使用统一材质。文件须包含三角网格，不能有骨骼、动画、外部资源、Draco / Meshopt 压缩或稀疏访问器。

- 单个文件最多 12 MiB、200,000 个显示三角形；GLB 最多 2,048 个节点，层级最多 64 层。
- 内嵌图片只接受 PNG / JPEG，单边最多 4,096 像素，总像素最多 32 Mi。
- 上传界面接受各方向 0.001 至 10,000 mm 的模型；模型和代理必须有有限、正的三维尺寸。
- 项目内模型总计最多 64 MiB，JSON 最多 96 MiB。模型以 base64 保存在 `Project.models`，带 SHA-256 和字节长度；导出项目可独立恢复上传素材，不依赖本机路径或远程 URL。

参数尚未填写完时，可保存“仅预览”组件。此时允许查看、放入项目和导出，但运动验证、功能仿真不会把它判为通过。选择“配置完成”前，界面和 MCP 使用同一套参数验证。

## 类型参数

所有自定义组件都要声明 `interaction.axis`、`anchor`、`proxySize`。表中长度单位为 mm，角度为度。公母配合类型还必须填写非空的 `mateFamily`、非负的尺寸公差 `params.tolerance`、正的 `interaction.insertionDepth` 和非负的 `interaction.minClearance`。

| `kind` | 功能 | 额外必填参数 |
| --- | --- | --- |
| `base` | 固定结构，长方体代理 | 无 |
| `tenon` | 方榫公件 | 方榫尺寸由 `proxySize` 声明 |
| `mortise` | 贯穿方孔母件 | `innerWidth`、`innerDepth`，必须小于外轮廓 |
| `pin` | 圆插销公件 | `pinDiameter`，等于代理宽、深 |
| `sleeve` | 圆孔套筒母件 | `holeDiameter`，小于代理外径 |
| `bayonet-pin` | 标准双耳旋锁公件 | `interaction.lockAngle = 45` |
| `bayonet-socket` | 标准 L 槽旋锁母件 | `holeDiameter`、`interaction.lockAngle = 45` |
| `spring` | 轴向线性弹簧 | `stiffness`（N/mm）、`mass`（kg）、`damping`（N·s/m）、`travel`、`freeLength`、`solidLength` |
| `button` | 回弹按压开关，两个电端子 | `stiffness`、`mass`、`damping`、`travel`、`trigger` |
| `battery` | 理想直流电源，两个电端子 | `voltage`（V） |
| `lamp` | 阻性灯负载，两个电端子 | `resistance`（Ω） |
| `resistor` | 线性电阻，两个电端子 | `resistance`（Ω） |
| `asset` | 结构件，仅包围盒预检 | 无；不会自动推断铰链、插销或电路 |

刚度、质量、电压和电阻须为正，阻尼可为零。弹簧行程不能超过自由长度减并圈高度；开关触发行程不能超过最大行程。动态字段、范围及能力清单由 [`getComponentTypeSchemas()`](../src/componentRegistry.ts) 提供，也通过 MCP 暴露。

## 代理坐标与配合

上传模型按其包围盒中心归零，显示尺寸为零件的 `size`。功能代理单独使用毫米定义：`anchor` 是相对于该可视中心的偏移，`axis` 是模型局部坐标中的单位向量。代理本身沿局部 Y 建模，再旋转到 `axis`，随后应用零件的 XYZ 旋转与世界位置。`proxySize` 是代理自身方向上的宽、高、深；高度沿插入或按压轴。改变可视尺寸不会自动修改代理，须重新核对两者。

例如 6 mm 圆插销：

```json
{
  "kind": "pin",
  "params": { "pinDiameter": 6, "tolerance": 0.1 },
  "interaction": {
    "version": 1,
    "status": "configured",
    "axis": [0, 1, 0],
    "anchor": [0, 0, 0],
    "proxySize": [6, 10, 6],
    "mateFamily": "pin-6mm",
    "insertionDepth": 10,
    "minClearance": 0.05
  }
}
```

公母件须使用相同配合族。`minClearance` 是扣除双方公差后的最小单侧余隙；`insertionDepth` 是允许的插入上限，不能超过代理轴向长度。直插件按轴向重叠长度检查，旋锁按从入口位置向内的行程检查。移动和旋转会逐步校验代理实体、余隙及插深；路径采用最大顶点位移 ≤0.25 mm 的采样，不是连续碰撞保证。

## 旋锁与验证边界

自定义旋锁目前仅接受与内置结构一致的标准双耳代理：公件 `16 × 24 × 16 mm`，母件 `24 × 18 × 24 mm`，锁定角 45°。按入口对齐、轴向插入、正转 45°、反转回入口、退出的次序验证；锁定后直接拔出应被槽顶阻挡。任意耳形、槽形或角度不能通过改几个参数获得精确认证，应先扩展共享几何与验证器。

上传模型始终显示真实网格，接触和功能计算使用用户声明的代理。当前不会证明代理与网格一致；结构总成、独立弹簧及材料接触仍有额外限制，报告会保留提示。具体求解范围见 [验证说明](VALIDATION.md)，MCP 调用见 [MCP 文档](MCP.md)。
