import {
  MAX_PROJECT_JSON_BYTES,
  MAX_PROJECT_MODEL_BYTES,
  validateUploadedModel,
  validatePartMaterial,
  validateInteractionProfile,
  validComponentId,
} from "./componentRegistry";
import type { Part, PartKind, Project, Vec3 } from "./types";
import { validateMechanismDefinition } from "./mechanisms";
import {
  BAYONET_PIN_SIZE,
  BAYONET_SOCKET_SIZE,
  BAYONET_POSES,
} from "./engine/bayonet";
export const definitions: {
  kind: PartKind;
  name: string;
  subtitle: string;
  category: "mechanical" | "electrical";
  size: Vec3;
  color: string;
  params: Part["params"];
}[] = [
  {
    kind: "bayonet-pin",
    name: "旋锁插销 · 公件",
    subtitle: "两耳卡口 · 旋入45°",
    category: "mechanical",
    size: [...BAYONET_PIN_SIZE],
    color: "#6288a8",
    params: { tolerance: 0.1 },
  },
  {
    kind: "bayonet-socket",
    name: "旋锁套座 · 母件",
    subtitle: "轴向入口 + 周向锁槽",
    category: "mechanical",
    size: [...BAYONET_SOCKET_SIZE],
    color: "#c69961",
    params: { tolerance: 0.1 },
  },
  {
    kind: "mortise",
    name: "方孔榫卯座",
    subtitle: "贯穿方孔 · 间隙配合",
    category: "mechanical",
    size: [24, 18, 24],
    color: "#c69961",
    params: { innerWidth: 12.4, innerDepth: 12.4, tolerance: 0.1 },
  },
  {
    kind: "tenon",
    name: "方榫插接件",
    subtitle: "12 × 26 × 12 mm",
    category: "mechanical",
    size: [12, 26, 12],
    color: "#6288a8",
    params: { tolerance: 0.1 },
  },
  {
    kind: "pin",
    name: "定位插销",
    subtitle: "Ø 6 mm · 钢",
    category: "mechanical",
    size: [6, 24, 6],
    color: "#a0afbd",
    params: { tolerance: 0.05, pinDiameter: 6 },
  },
  {
    kind: "sleeve",
    name: "导向套筒",
    subtitle: "Ø 6.4 mm · 内孔",
    category: "mechanical",
    size: [12, 16, 12],
    color: "#c79c61",
    params: {
      holeDiameter: 6.4,
      innerWidth: 6.4,
      innerDepth: 6.4,
      tolerance: 0.1,
    },
  },
  {
    kind: "spring",
    name: "压缩弹簧",
    subtitle: "0.8 N/mm · 回位",
    category: "mechanical",
    size: [9, 20, 9],
    color: "#a3adbc",
    params: {
      stiffness: 0.8,
      damping: 1.2,
      mass: 0.03,
      travel: 12,
      freeLength: 20,
      solidLength: 8,
      compression: 0,
    },
  },
  {
    kind: "button",
    name: "自复位按压开关",
    subtitle: "按压 / 触发 / 回弹",
    category: "mechanical",
    size: [16, 20, 16],
    color: "#5c82a3",
    params: {
      stiffness: 0.8,
      damping: 1.2,
      mass: 0.03,
      travel: 1,
      trigger: 0.6,
      compression: 0,
    },
  },
  {
    kind: "base",
    name: "安装底板",
    subtitle: "86 × 4 × 64 mm",
    category: "mechanical",
    size: [86, 4, 64],
    color: "#465e70",
    params: { tolerance: 0.1 },
  },
  {
    kind: "battery",
    name: "直流电源",
    subtitle: "5 V · 理想电压源",
    category: "electrical",
    size: [20, 12, 13],
    color: "#58788f",
    params: { voltage: 5 },
  },
  {
    kind: "lamp",
    name: "指示灯",
    subtitle: "100 Ω · 电阻性负载",
    category: "electrical",
    size: [10, 16, 10],
    color: "#d4aa55",
    params: { resistance: 100 },
  },
  {
    kind: "resistor",
    name: "限流电阻",
    subtitle: "220 Ω · 额定 0.25 W",
    category: "electrical",
    size: [14, 6, 6],
    color: "#c6b78e",
    params: { resistance: 220 },
  },
];
export const newId = () => crypto.randomUUID();
export function makePart(kind: PartKind, position?: Vec3): Part {
  const d = definitions.find((d) => d.kind === kind)!;
  return {
    id: newId(),
    name: d.name,
    kind,
    position: position ?? [0, d.size[1] / 2, 0],
    rotation: [0, 0, 0],
    size: [...d.size],
    color: d.color,
    fixed: kind === "base",
    visible: true,
    params: { ...d.params },
  };
}
export function demoProject(): Project {
  const base = makePart("base", [0, 2, 0]);
  const socket = makePart("mortise", [-18, 13, 0]);
  const tenon = makePart("tenon", [-18, 35, 0]);
  const button = makePart("button", [18, 14, 0]);
  const battery = makePart("battery", [-25, 10, 22]);
  const lamp = makePart("lamp", [25, 12, 22]);
  base.name = "01 · 精密安装底板";
  socket.name = "02 · 方孔榫卯座";
  tenon.name = "03 · 方榫插接件";
  button.name = "04 · 弹簧按压开关";
  battery.name = "05 · 5V 直流电源";
  lamp.name = "06 · 指示灯";
  return {
    version: 1,
    name: "榫卯与按压机构",
    parts: [base, socket, tenon, button, battery, lamp],
    wires: [
      {
        id: newId(),
        from: { partId: battery.id, terminal: 0 },
        to: { partId: button.id, terminal: 0 },
        color: "#c97b63",
      },
      {
        id: newId(),
        from: { partId: button.id, terminal: 1 },
        to: { partId: lamp.id, terminal: 0 },
        color: "#c97b63",
      },
      {
        id: newId(),
        from: { partId: lamp.id, terminal: 1 },
        to: { partId: battery.id, terminal: 1 },
        color: "#4f6c82",
      },
    ],
  };
}
export function bayonetDemoProject(): Project {
  const p = demoProject();
  p.name = "旋锁插销与按压机构";
  const socket = makePart("bayonet-socket", [-18, 13, 0]);
  socket.name = "02 · 旋锁套座（母）";
  const pin = makePart("bayonet-pin", [-18, 13 + BAYONET_POSES.entryOffset, 0]);
  pin.name = "03 · 旋锁插销（公）";
  p.parts = p.parts.map((part) =>
    part.kind === "mortise" ? socket : part.kind === "tenon" ? pin : part,
  );
  return p;
}
/** Validate untrusted JSON before it reaches the renderer, physics, or asset loader. */
export function parseProject(text: string): Project {
  if (text.length > MAX_PROJECT_JSON_BYTES)
    throw Error("项目文件不能超过 96 MiB。");
  const raw: unknown = JSON.parse(text);
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const reserved = new Set([
    ...Object.getOwnPropertyNames(Object.prototype),
    "prototype",
  ]);
  const identifier = (value: unknown): value is string =>
    typeof value === "string" &&
    /^[a-z0-9][a-z0-9_-]{0,99}$/i.test(value) &&
    !reserved.has(value);
  const name = (value: unknown): value is string =>
    typeof value === "string" && value.length <= 200;
  const color = (value: unknown): value is string =>
    typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
  const vec = (value: unknown, positive = false): value is Vec3 =>
    Array.isArray(value) &&
    value.length === 3 &&
    value.every(
      (n) =>
        typeof n === "number" &&
        Number.isFinite(n) &&
        Math.abs(n) <= 100_000 &&
        (!positive || n > 0),
    );
  const kinds = new Set<unknown>([...definitions.map((d) => d.kind), "asset"]);
  if (
    !record(raw) ||
    raw.version !== 1 ||
    !name(raw.name) ||
    !Array.isArray(raw.parts) ||
    !Array.isArray(raw.wires) ||
    raw.parts.length > 500 ||
    raw.wires.length > 2000
  )
    throw Error(
      "不是有效的 v1 装配项目，或超出 500 个零件 / 2000 根导线限制。",
    );
  const models =
    raw.models === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(raw.models) || raw.models.length > 100)
            throw Error("工程最多包含100个自定义模型。");
          const ids = new Set<string>();
          let bytes = 0;
          return raw.models.map((value) => {
            const model = validateUploadedModel(value);
            if (ids.has(model.id)) throw Error("模型标识重复。");
            ids.add(model.id);
            bytes += model.bytes;
            if (bytes > MAX_PROJECT_MODEL_BYTES)
              throw Error("工程模型合计不能超过64 MiB。");
            return model;
          });
        })();
  const modelIds = new Set(models?.map((model) => model.id));
  const positive = new Set([
    "mass",
    "stiffness",
    "resistance",
    "voltage",
    "travel",
    "innerWidth",
    "innerDepth",
    "holeDiameter",
    "pinDiameter",
    "freeLength",
  ]);
  const nonnegative = new Set([
    "damping",
    "trigger",
    "compression",
    "tolerance",
    "clearance",
    "solidLength",
  ]);
  const ids = new Set<string>();
  const electricalIds = new Set<string>();
  const assemblyGroups = new Map<string, string>();
  const parts: Part[] = [];
  for (const value of raw.parts) {
    if (
      !record(value) ||
      !identifier(value.id) ||
      ids.has(value.id) ||
      !name(value.name) ||
      !kinds.has(value.kind) ||
      !vec(value.position) ||
      !vec(value.rotation) ||
      !vec(value.size, true) ||
      !color(value.color) ||
      typeof value.fixed !== "boolean" ||
      typeof value.visible !== "boolean" ||
      !record(value.params) ||
      Object.keys(value.params).length > 64
    )
      throw Error(
        "零件数据无效：检查尺寸、坐标和唯一标识；标识仅支持字母、数字、下划线与短横线。",
      );
    const params: Part["params"] = {};
    for (const [key, val] of Object.entries(value.params)) {
      if (!/^[a-z][a-z0-9_]{0,63}$/i.test(key) || reserved.has(key))
        throw Error("物理参数名称无效。");
      if (key === "assetUrl") {
        if (
          typeof val !== "string" ||
          !/^\.\/models\/[a-z0-9_-]+\.glb$/i.test(val)
        )
          throw Error("仅允许加载随客户端提供的模型资源。");
      } else if (key === "assetNode") {
        if (typeof val !== "string" || !val.length || val.length > 300)
          throw Error("模型节点名称无效。");
      } else {
        if (
          typeof val !== "number" ||
          !Number.isFinite(val) ||
          Math.abs(val) > 1e8
        )
          throw Error(
            "物理参数必须是有限数值；字符串只用于模型路径和节点名称。",
          );
        if (positive.has(key) && val < 1e-6)
          throw Error("尺寸、质量和电学参数必须大于零（最小 0.000001）。");
        if (nonnegative.has(key) && val < 0)
          throw Error("阻尼、行程、公差和压缩量不能为负数。");
      }
      params[key] = val;
    }
    let model: Part["model"];
    if (value.model !== undefined) {
      if (
        !record(value.model) ||
        !validComponentId(value.model.id) ||
        !modelIds.has(value.model.id)
      )
        throw Error("自定义模型引用不存在。");
      model = { id: value.model.id };
    }
    const interaction =
      value.interaction === undefined
        ? undefined
        : validateInteractionProfile(value.interaction);
    if ((model || (params.assetUrl && value.kind !== "asset")) && !interaction)
      throw Error("具有功能类型的模型必须包含明确的交互定义（可标记待配置）。");
    if (value.componentId !== undefined && !validComponentId(value.componentId))
      throw Error("组件来源标识无效。");
    let assemblyGroup: Part["assemblyGroup"];
    if (value.assemblyGroup !== undefined) {
      const group = value.assemblyGroup;
      if (
        !record(group) ||
        !identifier(group.id) ||
        !name(group.name) ||
        !group.name.trim()
      )
        throw Error("装配分组须包含有效的唯一标识和名称。");
      if (
        assemblyGroups.has(group.id) &&
        assemblyGroups.get(group.id) !== group.name
      )
        throw Error("同一装配分组标识不能对应不同名称。");
      assemblyGroups.set(group.id, group.name);
      assemblyGroup = { id: group.id, name: group.name };
    }
    if (value.kind === "asset" && !model && typeof params.assetUrl !== "string")
      throw Error("原始资产缺少客户端模型路径。");
    ids.add(value.id);
    if (
      ["battery", "lamp", "resistor", "button"].includes(value.kind as string)
    )
      electricalIds.add(value.id);
    // Keep physical inconsistencies such as insufficient clearance reviewable in the engine.
    // Only supported top-level fields survive import; unrelated input is never merged into state.
    parts.push({
      id: value.id,
      name: value.name,
      kind: value.kind as PartKind,
      position: value.position,
      rotation: value.rotation,
      size: value.size,
      color: value.color,
      ...(value.material !== undefined
        ? { material: validatePartMaterial(value.material) }
        : {}),
      fixed: value.fixed,
      visible: value.visible,
      params,
      ...(model ? { model } : {}),
      ...(interaction ? { interaction } : {}),
      ...(assemblyGroup ? { assemblyGroup } : {}),
      ...(value.componentId
        ? { componentId: value.componentId as string }
        : {}),
    });
  }
  const mechanisms =
    raw.mechanisms === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(raw.mechanisms) || raw.mechanisms.length > 100)
            throw Error("工程最多包含 100 个功能组件。");
          const mechanismIds = new Set<string>(),
            memberIds = new Set<string>();
          return raw.mechanisms.map((value) => {
            const mechanism = validateMechanismDefinition(value, parts);
            if (mechanismIds.has(mechanism.id))
              throw Error("功能组件标识重复。");
            mechanismIds.add(mechanism.id);
            for (const id of mechanism.partIds) {
              if (memberIds.has(id))
                throw Error("同一子零件不能同时属于多个功能组件。");
              memberIds.add(id);
            }
            if (mechanism.kind === "press" && mechanism.switchPartId)
              electricalIds.add(mechanism.switchPartId);
            return mechanism;
          });
        })();
  const wireIds = new Set<string>();
  const wires: Project["wires"] = [];
  for (const value of raw.wires) {
    if (
      !record(value) ||
      !identifier(value.id) ||
      wireIds.has(value.id) ||
      !record(value.from) ||
      !record(value.to) ||
      typeof value.from.partId !== "string" ||
      typeof value.to.partId !== "string" ||
      !electricalIds.has(value.from.partId) ||
      !electricalIds.has(value.to.partId) ||
      ![0, 1].includes(value.from.terminal as number) ||
      ![0, 1].includes(value.to.terminal as number) ||
      !color(value.color)
    )
      throw Error("导线端点或标识无效；导线必须连接当前项目中的电气零件。");
    wireIds.add(value.id);
    wires.push({
      id: value.id,
      from: {
        partId: value.from.partId,
        terminal: value.from.terminal as 0 | 1,
      },
      to: { partId: value.to.partId, terminal: value.to.terminal as 0 | 1 },
      color: value.color,
    });
  }
  return {
    version: 1,
    name: raw.name,
    parts,
    wires,
    ...(models ? { models } : {}),
    ...(mechanisms ? { mechanisms } : {}),
  };
}
