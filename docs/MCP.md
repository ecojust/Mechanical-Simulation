# MCP：操作正在运行的桌面工作台

Mechanical Studio 的 macOS 应用本身就是 MCP stdio 服务。应用不包含 Node.js 或 Electron。先打开桌面应用，在顶部 MCP 面板复制客户端配置；MCP 修改的是该窗口内的工程，结果立即进入相同的撤销历史与自动保存流程。

安装到 Applications 后的配置示例：

```json
{
  "mcpServers": {
    "mechanical-studio": {
      "command": "/Applications/Mechanical Studio.app/Contents/MacOS/mechanical-studio",
      "args": ["--mcp"]
    }
  }
}
```

客户端若把应用安装在其他位置，应使用 MCP 面板显示的实际路径。没有打开工作台、工作台未就绪或面板内停用 MCP 时，工具返回明确错误。桌面默认启用本机桥接，可以在 MCP 面板关闭；协议发现与工具列表仍可读取，但工作台命令被拒绝。

## 工具

| 工具                   | 用途                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `get_runtime_status`   | 读取真实 WebView 的就绪状态、WebGL 和素材加载状态                                                              |
| `list_component_types` | 读取共享类型注册表：功能、必需参数、单位、范围及交互要求                                                       |
| `list_components`      | 列出内置组件、189 个原始子零件所在集合与用户组件库，不含模型字节                                               |
| `get_project`          | 当前工程、零件和 revision；模型只返回元数据                                                                    |
| `import_component`     | 上传 GLB/STL 的 base64 内容与明确类型、尺寸、功能和交互定义                                                    |
| `add_part`             | 用内置 kind 或用户 componentId 实例化零件                                                                      |
| `add_repository_parts` | 按 assetId 和可选 nodeNames 加入原始独立子零件；省略 nodeNames 加入整个集合，offset 为源位置偏移；同组关系保留 |
| `configure_part`       | 设置类型、功能参数、交互定义、固定状态、名称、颜色和 PBR 材质                                                  |
| `transform_part`       | 按与右侧控制面板相同的路径碰撞、配合、固定状态和旋锁检查移动/旋转                                              |
| `connect_wire`         | 连接两个电气零件端子，返回电路检查                                                                             |
| `remove_part`          | 移除零件及关联导线                                                                                             |
| `validate_project`     | 校验装配与电路；pressedIds 只可指定独立按压开关，机制开关由接触决定                                            |
| `export_project`       | 导出可移植工程，包含上传模型；大工程使用分块                                                                   |
| `configure_mechanism`  | 新建或替换复合按压/配合定义，绑定已有成员角色、功能参数和代理几何                                              |
| `delete_mechanism`     | 移除功能定义，保留所有子零件                                                                                   |
| `transform_mechanism`  | 受检移动/旋转活动子组，或整体变换组件坐标系                                                                    |
| `press_mechanism`      | 推进当前工作台的按压/释放仿真，返回弹簧状态、成员位置及电路状态                                                |

资源 `mechanical://project` 和 `mechanical://component-types` 提供只读工程元数据与类型注册表。

所有写入工具都要求 `expectedRevision`。先读取 `get_project`，再携带返回的 revision。成功写入后 revision 增加 1；失败不会修改工程。若用户同时在界面操作，旧 revision 被拒绝，应重新读取工程再决定动作。桥接串行执行，异步校验结束时界面还会重新核对 revision。

例如将零件移动到 `[10, 20, 0]` mm：

```json
{
  "name": "transform_part",
  "arguments": {
    "expectedRevision": 12,
    "partId": "实际零件ID",
    "position": [10, 20, 0],
    "rotation": [0, 45, 0]
  }
}
```

修改颜色可传 `color: "#cc8844"`，同时传 `material: {"metalness":0.8,"roughness":0.2}`。金属度与粗糙度必须在 0–1 之间；指定新颜色会关闭原模型颜色。只传材质且指定 `useSourceColor:true` 可重新保留源模型颜色。

## 上传与功能校验

`import_component` 的输入 schema 完整公开 ComponentDefinition、模型与交互字段。模型必须由客户端读取并编码为 base64，附带实际 SHA-256、字节数、尺寸和中心；不接受任意本地文件路径、外部模型 URL、GLB 外部资源或可执行脚本。

先调用 `list_component_types` 获取所选 kind 的参数，按字段 `group` 分别写入 `params` 或 `interaction`。交互定义包含 version、status、axis、anchor 和 proxySize；插销与榫卯还需要配合族、插入深度、余隙等，旋锁需支持的锁定角。参数不全时可以保存和预览，仿真明确报未配置；原始来源名推断出的功能类型同样不自动获得物理参数。更改类型后旧功能参数会清空，必须重新配置。

组件单个模型上限 12 MiB；组件库最多 500 个组件、模型共 64 MiB。工程模型合计最多 64 MiB、序列化 JSON 最多 96 MiB。尺寸、哈希和 GLB/STL 内容由与上传界面相同的校验器验证。网格外观与声明的碰撞代理不同：当前验证是代理几何、名义机械参数与简化电路模型，不代表任意网格的接触分析或制造认证。

## 复合功能组件

先在当前工程加入所需子零件，再用 `configure_mechanism` 建立定义。`partIds` 保留原始子零件身份；`movingPartIds` 是一起运动的活动子组，`springPartIds` 是压缩变形的弹簧成员，其余成员固定在组件局部框架。每个零件只能属于一个功能组件，角色不能重叠。按压组件可把 `switchPartId` 绑定到一个固定成员，作为电路中的两端开关。绑定后必须提供 `contact`：`strikerPartId` 选一个活动成员，`strikerPoint` 与 `switchPoint` 分别是撞针和开关子件包络中心坐标系中的毫米接触点，`switchNormal` 是开关局部单位法向；`radius` 给出允许的横向触点半径，`maxOvertravel` 给出允许的轴向过行程。接触点必须位于相应子件的尺寸包络内，随真实子件位置和旋转变换，不能用悬空坐标替代实际摆放。

`frame` 定义组件世界位置与 XYZ 旋转，`axis` 是组件局部单位操作轴；`movingProxy` 和 `fixedProxy` 分别声明局部碰撞/配合代理。`press` 类型须给出 mass、stiffness、damping、travel、freeLength、solidLength；legacy `trigger` 不再决定机制开关的通断。`mating` 类型须声明受支持的方榫/方孔、圆销/套筒或标准旋锁公母代理，参数遵从相应组件类型。参数不全可保存为 unconfigured，不能通过功能仿真。

`transform_mechanism` 可传 `distance`（沿操作轴的相对毫米量）和/或 `angle`（相对角度）驱动配合组件的活动子组，或者传完整 `frame:{position,rotation}` 对整个组件做刚体变换；两种模式不能混用。成员不能再通过 `transform_part` 单独移动，也不能直接删除；需要先移除机制定义以解除约束。已有定义的 frame/pose 不能通过配置工具直接改动；首次定义的 pose 必须为零。配合组件仍处于非零运动姿态时只能修改名称或配置状态，修改角色、操作轴或代理校准前须先用运动工具恢复 pose 零位。

例如让复合按钮按住 0.5 秒：

```json
{
  "name": "press_mechanism",
  "arguments": {
    "expectedRevision": 12,
    "mechanismId": "按钮组件ID",
    "held": true,
    "duration": 0.5
  }
}
```

用 `held:false` 调用同一工具释放，弹簧在当前仿真中回弹。`duration` 在 0.001–5 秒之间，使用共享求解器按不大于 1/120 秒的步长推进。只有撞针世界坐标到达开关接触面、横向偏差落在半径内且未超过过行程时才导通。达到某个压缩量但尚未碰到触点不会点亮灯，`pressedIds` 也不能强制闭合机制开关。`press_mechanism` 和 `validate_project` 的 `contacts` 返回各机制的 gap、radial、triggerTravel、axisAlignment、pressed、touching 以及两个世界接触点和法向，便于校准。返回的 state/成员位置是当前桌面实际使用的临时仿真态，工程保留静止几何；成功操作仍推进 revision。工作台之后继续按照 held 状态运行，`get_runtime_status` 可查询当前 mechanismStates，`validate_project` 同时检查其代理位置、开关触发和电路。

复合功能仍基于明确声明的代理几何与名义机械参数，保存了分组和真实显示网格不意味着自动获得任意接触面、摩擦或材料变形求解。

## 大工程导出

标准官方 MCP SDK 的 stdio 缓冲默认只有 10 MiB。服务将协议消息限制在 9 MiB，避免客户端因大响应断开；默认小工程直接返回 `project`。大工程的 `export_project` 返回 `mode:"chunked"`、`chunkCount`、`revision` 等元数据。

依次调用：

```json
{
  "name": "export_project",
  "arguments": { "chunkIndex": 0, "expectedRevision": 12 }
}
```

每次返回 `mode:"chunk"`、`chunkIndex`、`chunkCount` 和 `data`。按序拼接所有 `data` 字符串，再 `JSON.parse` 得到完整工程。块大小约 512 Ki 个 UTF-16 字符，并保持 Unicode 代理对完整。所有请求都携带第一次导出的 revision；工程发生修改时停止拼接并从第 0 块重新开始。也可始终显式请求第 0 块，再依其 chunkCount 继续，小工程同样支持。

本机桥接输入上限 24 MiB，足够传递 12 MiB 模型的 base64 与元数据；内部完整响应上限 128 MiB。协议响应超过 9 MiB 会返回明确错误，不截断内容。

## 本机连接与测试

stdio 只输出 JSON-RPC，诊断走 stderr。桌面桥仅绑定 `127.0.0.1` 动态端口，使用每次启动生成的随机令牌；拒绝不匹配的 Host、Origin、重复 HTTP 头和 Transfer-Encoding。发现文件位于应用数据目录，macOS 上目录权限 0700、文件 0600，不向局域网开放。令牌不会出现在 MCP 配置或日志里。工具不提供 shell、eval、任意路径读取或文件写入。

`MECHANICAL_STUDIO_DATA_DIR` 可以覆盖发现目录；macOS 发布烟测为 GUI 与 stdio 进程使用同一临时目录，避免碰到用户连接。工作台无响应会在 40 秒左右返回超时；客户端应重新查询工程 revision，确认实际状态后再提交下一步。

开发验证需要 Node.js，发布应用不需要：

```sh
npm ci
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features
cargo build --manifest-path src-tauri/Cargo.toml --no-default-features
npm run mcp:test-protocol
```

第三条命令用于生成二进制，`cargo test` 本身不会生成脚本默认使用的 `src-tauri/target/debug/mechanical-studio`。也可以设置 `MCP_TEST_BINARY` 指向实际应用可执行文件或自定义 Cargo target-dir 下的二进制。

`scripts/test-mcp-protocol.mjs` 使用官方 `@modelcontextprotocol/sdk` 客户端验证原生 stdio、协议协商、17 个工具、资源、错误、鉴权转发、大于 16 MiB 的上传和分块导出重组；这里的 HTTP 工作台是隔离的协议测试夹具。`tests/mcp.test.ts` 则执行真实共享仿真命令。macOS Actions 另外运行 `scripts/smoke-macos.mjs`，启动实际打包应用的 WKWebView，再经 MCP 验证模型加载、旋锁操作、真实 STL 上传/实例化、颜色与 PBR、工程导出、原始子件同组关系以及复合按压/回弹与撞针接触开关。
