import { inspectModelBytes } from "./modelSafety";
export { inspectModelBytes } from "./modelSafety";
import type {
  ComponentDefinition,
  ComponentParameterField,
  ComponentTypeSchema,
  InteractionProfile,
  Issue,
  Part,
  PartKind,
  PartMaterial,
  UploadedModel,
  Vec3,
} from "./types";

export const MAX_MODEL_BYTES = 12 * 1024 * 1024;
export const MAX_PROJECT_MODEL_BYTES = 64 * 1024 * 1024;
export const MAX_PROJECT_JSON_BYTES = 96 * 1024 * 1024;
export const componentKinds: PartKind[] = [
  "base",
  "tenon",
  "mortise",
  "pin",
  "sleeve",
  "bayonet-pin",
  "bayonet-socket",
  "spring",
  "button",
  "battery",
  "lamp",
  "resistor",
  "asset",
];
const pairKinds: PartKind[] = [
  "tenon",
  "mortise",
  "pin",
  "sleeve",
  "bayonet-pin",
  "bayonet-socket",
];
const electricalKinds: PartKind[] = ["battery", "lamp", "resistor", "button"];
const labels: Record<PartKind, [string, string]> = {
  base: ["固定结构件", "使用声明的长方体代理检查外部空间。"],
  tenon: ["方榫公件", "按方榫代理、配合族、插入深度与余隙验证。"],
  mortise: ["方孔母件", "按贯穿方孔代理检查插入和侧壁碰撞。"],
  pin: ["圆插销公件", "按声明的圆径与插入轴检查配合。"],
  sleeve: ["圆孔套筒母件", "按外径、孔径、配合轴和深度检查。"],
  "bayonet-pin": [
    "旋锁公件",
    "目前仅支持内置双耳45°卡口代理；上传外观需实物核对。",
  ],
  "bayonet-socket": ["旋锁母件", "目前仅支持内置双入口L槽45°卡口代理。"],
  spring: ["压缩弹簧", "按刚度、质量、阻尼和行程计算轴向回弹。"],
  button: ["按压开关", "行程达到触发点后闭合端子，松开回弹。"],
  battery: ["直流电源", "理想直流电压源，提供正负端子。"],
  lamp: ["指示灯", "阻性灯负载，形成回路后点亮。"],
  resistor: ["电阻", "提供两端子的线性电阻。"],
  asset: [
    "结构件 / 仅预检",
    "保留可视模型，只做保守包围盒预检，不自动获得机构功能。",
  ],
};
const field = (
  key: string,
  label: string,
  unit: string,
  min = 0,
  group: "params" | "interaction" = "params",
): ComponentParameterField => ({
  key,
  label,
  unit,
  min,
  max: 1e6,
  required: true,
  group,
});
export function getComponentTypeSchemas(): ComponentTypeSchema[] {
  return componentKinds.map((kind) => {
    const fields: ComponentParameterField[] = [];
    if (pairKinds.includes(kind)) {
      fields.push(
        field("tolerance", "尺寸公差 ±", "mm"),
        field("insertionDepth", "允许插入深度", "mm", 0.001, "interaction"),
        field("minClearance", "要求的最小单侧余隙", "mm", 0, "interaction"),
      );
    }
    if (kind === "pin")
      fields.push(field("pinDiameter", "插销直径", "mm", 0.001));
    if (kind === "sleeve" || kind === "bayonet-socket")
      fields.push(field("holeDiameter", "配合孔径", "mm", 0.001));
    if (kind === "mortise")
      fields.push(
        field("innerWidth", "孔宽", "mm", 0.001),
        field("innerDepth", "孔深", "mm", 0.001),
      );
    if (kind.startsWith("bayonet-"))
      fields.push({
        ...field("lockAngle", "锁定角（当前仅45°）", "°", 45, "interaction"),
        max: 45,
      });
    if (kind === "spring" || kind === "button") {
      fields.push(
        field("stiffness", "弹簧刚度", "N/mm", 0.001),
        field("mass", "运动质量", "kg", 0.000001),
        field("damping", "阻尼系数", "N·s/m"),
        field("travel", "最大行程", "mm", 0.001),
      );
      if (kind === "spring")
        fields.push(
          field("freeLength", "自由长度", "mm", 0.001),
          field("solidLength", "并圈高度", "mm"),
        );
      else fields.push(field("trigger", "触发行程", "mm", 0.001));
    }
    if (kind === "battery") fields.push(field("voltage", "电压", "V", 0.001));
    if (kind === "lamp" || kind === "resistor")
      fields.push(field("resistance", "电阻", "Ω", 0.001));
    const props = Object.fromEntries(
      fields.map((f) => [
        f.key,
        {
          type: "number",
          minimum: f.min,
          maximum: f.max,
          description: `${f.label} (${f.unit})`,
        },
      ]),
    );
    return {
      kind,
      label: labels[kind][0],
      description: labels[kind][1],
      ...(pairKinds.includes(kind)
        ? {
            role: (["mortise", "sleeve", "bayonet-socket"].includes(kind)
              ? "female"
              : "male") as "male" | "female",
          }
        : {}),
      fields,
      requiresMating: pairKinds.includes(kind),
      supportsElectrical: electricalKinds.includes(kind),
      supportsPress: kind === "spring" || kind === "button",
      jsonSchema: {
        type: "object",
        properties: props,
        required: fields.map((f) => f.key),
        additionalProperties: false,
      },
    };
  });
}
export function componentTypeLabel(kind: PartKind) {
  return labels[kind][0];
}
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const reserved = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  "prototype",
]);
export const validComponentId = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[a-z0-9][a-z0-9_-]{0,99}$/i.test(v) &&
  !reserved.has(v);
const vector = (v: unknown, positive = false): v is Vec3 =>
  Array.isArray(v) &&
  v.length === 3 &&
  v.every(
    (n) =>
      typeof n === "number" &&
      Number.isFinite(n) &&
      Math.abs(n) <= 100_000 &&
      (!positive || n > 0),
  );
export function validateInteractionProfile(raw: unknown): InteractionProfile {
  if (
    !object(raw) ||
    raw.version !== 1 ||
    !["configured", "unconfigured"].includes(String(raw.status)) ||
    !vector(raw.axis) ||
    !vector(raw.anchor) ||
    !vector(raw.proxySize, true)
  )
    throw Error("交互定义必须包含有效状态、方向、锚点和代理尺寸。");
  if (Math.abs(Math.hypot(...raw.axis) - 1) > 1e-5)
    throw Error("配合方向必须是单位向量。");
  const p: InteractionProfile = {
    version: 1,
    status: raw.status as InteractionProfile["status"],
    axis: [...raw.axis],
    anchor: [...raw.anchor],
    proxySize: [...raw.proxySize],
  };
  if (raw.mateFamily !== undefined) {
    if (typeof raw.mateFamily !== "string" || raw.mateFamily.length > 100)
      throw Error("配合族名称无效。");
    p.mateFamily = raw.mateFamily.trim();
  }
  for (const key of ["insertionDepth", "minClearance", "lockAngle"] as const) {
    if (raw[key] !== undefined) {
      const v = raw[key];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100000)
        throw Error("交互参数须为有限非负数。");
      p[key] = v;
    }
  }
  return p;
}
export function decodeModelData(data: string): Uint8Array {
  const binary = atob(data);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
// Synchronous SHA-256 keeps import validation shared by browsers, tests and MCP.
export function sha256Bytes(bytes: Uint8Array): string {
  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const data = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  data.set(bytes);
  data[bytes.length] = 128;
  new DataView(data.buffer).setUint32(data.length - 4, bytes.length * 8);
  new DataView(data.buffer).setUint32(
    data.length - 8,
    Math.floor(bytes.length / 0x20000000),
  );
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Uint32Array(64),
    r = (v: number, n: number) => (v >>> n) | (v << (32 - n));
  const view = new DataView(data.buffer);
  for (let offset = 0; offset < data.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15],
        b = w[i - 2];
      w[i] =
        (w[i - 16] +
          (r(a, 7) ^ r(a, 18) ^ (a >>> 3)) +
          w[i - 7] +
          (r(b, 17) ^ r(b, 19) ^ (b >>> 10))) >>>
        0;
    }
    let [a, b, c, d, e, f, g, z] = h;
    for (let i = 0; i < 64; i++) {
      const t1 =
        (z +
          (r(e, 6) ^ r(e, 11) ^ r(e, 25)) +
          ((e & f) ^ (~e & g)) +
          k[i] +
          w[i]) >>>
        0;
      const t2 =
        ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      z = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, z].forEach((v, i) => (h[i] = (h[i] + v) >>> 0));
  }
  return h.map((v) => v.toString(16).padStart(8, "0")).join("");
}
const verifiedModels = new Map<
  string,
  { data: string; format: string; bytes: number }
>();
export function validateUploadedModel(raw: unknown): UploadedModel {
  if (
    !object(raw) ||
    !validComponentId(raw.id) ||
    typeof raw.name !== "string" ||
    raw.name.length > 200 ||
    !["glb", "stl"].includes(String(raw.format)) ||
    typeof raw.data !== "string" ||
    raw.data.length > Math.ceil(MAX_MODEL_BYTES / 3) * 4 ||
    !raw.data.length ||
    raw.data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(raw.data) ||
    typeof raw.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw.sha256) ||
    typeof raw.bytes !== "number" ||
    !Number.isInteger(raw.bytes) ||
    raw.bytes <= 0 ||
    raw.bytes > MAX_MODEL_BYTES ||
    !vector(raw.size, true) ||
    !vector(raw.center)
  )
    throw Error("上传模型数据无效，或超过12 MiB。");
  const cached = verifiedModels.get(raw.sha256);
  if (
    !cached ||
    cached.data !== raw.data ||
    cached.format !== raw.format ||
    cached.bytes !== raw.bytes
  ) {
    const bytes = decodeModelData(raw.data);
    if (bytes.length !== raw.bytes || sha256Bytes(bytes) !== raw.sha256)
      throw Error("模型长度或SHA-256校验不匹配。");
    inspectModelBytes(bytes, raw.format as "glb" | "stl");
    if (verifiedModels.size >= 8)
      verifiedModels.delete(verifiedModels.keys().next().value!);
    verifiedModels.set(raw.sha256, {
      data: raw.data,
      format: raw.format as string,
      bytes: raw.bytes,
    });
  }
  return {
    id: raw.id,
    name: raw.name,
    format: raw.format as "glb" | "stl",
    data: raw.data,
    sha256: raw.sha256,
    bytes: raw.bytes,
    size: [...raw.size],
    center: [...raw.center],
  };
}
export function validatePartMaterial(raw: unknown): PartMaterial {
  if (
    !object(raw) ||
    typeof raw.metalness !== "number" ||
    !Number.isFinite(raw.metalness) ||
    raw.metalness < 0 ||
    raw.metalness > 1 ||
    typeof raw.roughness !== "number" ||
    !Number.isFinite(raw.roughness) ||
    raw.roughness < 0 ||
    raw.roughness > 1 ||
    (raw.useSourceColor !== undefined &&
      typeof raw.useSourceColor !== "boolean")
  ) {
    throw Error(
      "PBR 材质金属度与粗糙度必须是 0 至 1 的有限数值，原色开关须为布尔值。",
    );
  }
  return {
    metalness: raw.metalness,
    roughness: raw.roughness,
    ...(raw.useSourceColor !== undefined
      ? { useSourceColor: raw.useSourceColor }
      : {}),
  };
}
export function validateComponentDefinition(raw: unknown): ComponentDefinition {
  if (
    !object(raw) ||
    raw.version !== 1 ||
    !validComponentId(raw.id) ||
    typeof raw.name !== "string" ||
    !raw.name.trim() ||
    raw.name.length > 200 ||
    !componentKinds.includes(raw.kind as PartKind) ||
    !vector(raw.size, true) ||
    typeof raw.color !== "string" ||
    !/^#[a-f0-9]{6}$/i.test(raw.color) ||
    !object(raw.params) ||
    Object.keys(raw.params).length > 64
  )
    throw Error("组件须包含名称、明确类型、模型与有效尺寸。");
  const params: Part["params"] = {};
  for (const [key, value] of Object.entries(raw.params)) {
    if (
      !/^[a-z][a-z0-9_]{0,63}$/i.test(key) ||
      reserved.has(key) ||
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      Math.abs(value) > 1e8
    )
      throw Error("自定义组件功能参数只能是有限数值。");
    params[key] = value;
  }
  return {
    version: 1,
    id: raw.id,
    name: raw.name.trim(),
    kind: raw.kind as PartKind,
    size: [...raw.size],
    color: raw.color,
    ...(raw.material !== undefined
      ? { material: validatePartMaterial(raw.material) }
      : {}),
    params,
    interaction: validateInteractionProfile(raw.interaction),
    model: validateUploadedModel(raw.model),
  };
}
export function componentPartIssues(part: Part): Issue[] {
  if (
    !part.model &&
    !part.interaction &&
    !(part.params.assetUrl && part.kind !== "asset")
  )
    return [];
  const result: Issue[] = [];
  const p = part.interaction;
  const schema = getComponentTypeSchemas().find((s) => s.kind === part.kind)!;
  const problem = (key: string, detail: string) =>
    result.push({
      id: `component-${part.id}-${key}`,
      severity: "error",
      title: "组件交互参数未完成",
      detail: `${part.name}：${detail}`,
      partIds: [part.id],
      category: "physics",
    });
  if (!p) {
    problem("profile", "必须提供交互定义，不能根据外观推断功能。");
    return result;
  }
  if (p.status !== "configured")
    problem("status", "当前仅供预览，请填写该类型的全部参数后标记配置完成。");
  if (schema.requiresMating && !p.mateFamily?.trim())
    problem("family", "请填写配合族，只与同族的公母组件配对。");
  for (const f of schema.fields) {
    const value =
      f.group === "params"
        ? part.params[f.key]
        : (p as unknown as Record<string, unknown>)[f.key];
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < f.min ||
      value > (f.max ?? Infinity)
    )
      problem(f.key, `请填写有效的${f.label}（${f.unit}）。`);
  }
  if (
    part.kind.startsWith("bayonet-") &&
    (p.lockAngle !== 45 ||
      p.proxySize.some(
        (v, i) =>
          Math.abs(
            v - (part.kind === "bayonet-pin" ? [16, 24, 16] : [24, 18, 24])[i],
          ) > 1e-6,
      ))
  )
    problem(
      "bayonet",
      "当前仅支持45°标准双耳旋锁代理（公16×24×16、母24×18×24 mm）；任意卡扣几何尚不能自动推断。",
    );
  if (
    ["pin", "sleeve"].includes(part.kind) &&
    Math.abs(p.proxySize[0] - p.proxySize[2]) > 1e-6
  )
    problem("diameter", "圆柱代理的宽深必须相等。");
  if (
    part.kind === "pin" &&
    typeof part.params.pinDiameter === "number" &&
    Math.abs(part.params.pinDiameter - p.proxySize[0]) > 1e-6
  )
    problem("diameter-match", "插销直径须与圆柱代理宽深一致。");
  if (typeof p.insertionDepth === "number" && p.insertionDepth > p.proxySize[1])
    problem("depth", "插入深度不能超过功能代理的轴向长度。");
  if (
    part.kind === "mortise" &&
    ((typeof part.params.innerWidth === "number" &&
      part.params.innerWidth >= p.proxySize[0]) ||
      (typeof part.params.innerDepth === "number" &&
        part.params.innerDepth >= p.proxySize[2]))
  )
    problem("hole", "方孔的宽深必须小于功能代理的外轮廓，保留实体侧壁。");
  if (
    ["sleeve", "bayonet-socket"].includes(part.kind) &&
    typeof part.params.holeDiameter === "number" &&
    part.params.holeDiameter >= p.proxySize[0]
  )
    problem("hole", "内孔直径必须小于功能代理的外径。");
  if (part.kind === "spring" || part.kind === "button") {
    const free =
      part.kind === "spring" ? part.params.freeLength : p.proxySize[1];
    const solid = part.kind === "spring" ? part.params.solidLength : 0;
    const travel = part.params.travel;
    if (
      typeof free === "number" &&
      typeof solid === "number" &&
      typeof travel === "number" &&
      (free <= solid || travel > free - solid)
    )
      problem(
        "stroke",
        "最大行程不能超过自由长度与并圈高度之差（按压开关按功能代理高度计算）。",
      );
    if (
      typeof travel === "number" &&
      typeof part.params.trigger === "number" &&
      part.params.trigger > travel
    )
      problem("trigger-travel", "触发行程不能超过最大行程。");
    if (
      typeof part.params.compression === "number" &&
      typeof travel === "number" &&
      (part.params.compression < 0 || part.params.compression > travel)
    )
      problem("compression", "当前压缩量必须在零和最大行程之间。");
  }
  result.push({
    id: `component-proxy-${part.id}`,
    severity: "warning",
    title: result.some((entry) => entry.severity === "error")
      ? "功能代理待标定"
      : "自定义模型使用声明的功能代理",
    detail: result.some((entry) => entry.severity === "error")
      ? "当前模型仅供预览与外观包围盒预检；代理参数完成前，不据此确认实体接触或配合。"
      : "类型决定操作和求解；接触按用户提供的尺寸、锚点、方向及参数计算，尚未证明代理与上传网格一致。",
    partIds: [part.id],
    category: "geometry",
  });
  return result;
}
export function componentDefinitionIssues(def: ComponentDefinition): Issue[] {
  return componentPartIssues({ ...createPartFromComponent(def), id: def.id });
}
export function createPartFromComponent(
  def: ComponentDefinition,
  position?: Vec3,
): Part {
  return {
    id: crypto.randomUUID(),
    name: def.name,
    kind: def.kind,
    position: position ?? [0, def.size[1] / 2, 0],
    rotation: [0, 0, 0],
    size: [...def.size],
    color: def.color,
    ...(def.material ? { material: { ...def.material } } : {}),
    fixed: def.kind === "base",
    visible: true,
    params: { ...def.params },
    model: { id: def.model.id },
    componentId: def.id,
    interaction: structuredClone(def.interaction),
  };
}
