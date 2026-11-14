import { Box3, Euler, Quaternion, Vector3 } from "three";
import { componentPartIssues, validComponentId } from "./componentRegistry";
import { stepSpring, validateAssembly, validateMotion } from "./engine/physics";
import type {
  Issue,
  Mechanism,
  MechanismContact,
  MechanismDeformation,
  MechanismFrame,
  MechanismProxy,
  MechanismProxyKind,
  MechanismStates,
  Part,
  Project,
  SpringState,
  Validation,
  Vec3,
} from "./types";

const RAD = Math.PI / 180;
const proxyKinds: MechanismProxyKind[] = [
  "base",
  "tenon",
  "mortise",
  "pin",
  "sleeve",
  "bayonet-pin",
  "bayonet-socket",
];
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const vec = (value: unknown, positive = false): value is Vec3 =>
  Array.isArray(value) &&
  value.length === 3 &&
  value.every(
    (n) =>
      typeof n === "number" &&
      Number.isFinite(n) &&
      Math.abs(n) <= 100000 &&
      (!positive || n > 0),
  );
const quat = (rotation: Vec3) =>
  new Quaternion().setFromEuler(
    new Euler(...(rotation.map((v) => v * RAD) as Vec3)),
  );
const angles = (q: Quaternion): Vec3 => {
  const e = new Euler().setFromQuaternion(q, "XYZ");
  return [e.x / RAD, e.y / RAD, e.z / RAD];
};
const frameAxis = (m: Mechanism) =>
  new Vector3(...m.axis).applyQuaternion(quat(m.frame.rotation));
const vector = (value: Vector3) => value.toArray() as Vec3;
const fixedIds = (m: Mechanism) =>
  m.partIds.filter(
    (id) => !m.movingPartIds.includes(id) && !m.springPartIds.includes(id),
  );
const proxyId = (m: Mechanism, moving: boolean) =>
  `mechanism-${m.id}-${moving ? "moving" : "fixed"}`;
const issue = (
  m: Mechanism,
  suffix: string,
  detail: string,
  severity: Issue["severity"] = "error",
): Issue => ({
  id: `mechanism-${m.id}-${suffix}`,
  severity,
  title:
    severity === "error"
      ? "功能组件配置或运动无效"
      : "组合组件使用声明的功能代理",
  detail: `${m.name}：${detail}`,
  partIds: [...m.partIds],
  category: "physics",
});
function numericParams(raw: unknown): Record<string, number> {
  if (!record(raw) || Object.keys(raw).length > 64)
    throw Error("组件参数必须是数值字典。");
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (
      !/^[a-z][a-z0-9_]{0,63}$/i.test(key) ||
      !validComponentId(key) ||
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      Math.abs(value) > 1e8
    )
      throw Error("功能组件参数必须是有限数值。");
    result[key] = value;
  }
  return result;
}
function parseFrame(raw: unknown): MechanismFrame {
  if (!record(raw) || !vec(raw.position) || !vec(raw.rotation))
    throw Error("组件坐标框架无效。");
  return { position: [...raw.position], rotation: [...raw.rotation] };
}
function parseProxy(raw: unknown): MechanismProxy {
  if (
    !record(raw) ||
    !proxyKinds.includes(raw.kind as MechanismProxyKind) ||
    !vec(raw.size, true)
  )
    throw Error("功能组件代理的类型或尺寸无效。");
  return {
    ...parseFrame(raw),
    kind: raw.kind as MechanismProxyKind,
    size: [...raw.size],
    params: numericParams(raw.params),
  };
}
/** Structural parsing permits pending calibration, but never dangling or overlapping roles. */
export function validateMechanismDefinition(
  raw: unknown,
  parts: Part[],
): Mechanism {
  if (
    !record(raw) ||
    raw.version !== 1 ||
    !validComponentId(raw.id) ||
    raw.id.length > 64 ||
    typeof raw.name !== "string" ||
    !raw.name.trim() ||
    raw.name.length > 200 ||
    !["press", "mating"].includes(String(raw.kind)) ||
    !["configured", "unconfigured"].includes(String(raw.status)) ||
    !vec(raw.axis) ||
    Math.abs(Math.hypot(...raw.axis) - 1) > 1e-5 ||
    !record(raw.pose) ||
    typeof raw.pose.offset !== "number" ||
    typeof raw.pose.angle !== "number" ||
    !Number.isFinite(raw.pose.offset) ||
    !Number.isFinite(raw.pose.angle) ||
    Math.abs(raw.pose.offset) > 100000 ||
    Math.abs(raw.pose.angle) > 100000
  )
    throw Error("功能组件定义、单位轴或姿态无效。");
  const available = new Set(parts.map((p) => p.id));
  const ids = (value: unknown): string[] => {
    if (
      !Array.isArray(value) ||
      value.length > 500 ||
      value.some((id) => !validComponentId(id) || !available.has(id)) ||
      new Set(value).size !== value.length
    )
      throw Error("功能组件成员引用无效或重复。");
    return [...value];
  };
  const partIds = ids(raw.partIds),
    movingPartIds = ids(raw.movingPartIds),
    springPartIds = ids(raw.springPartIds);
  if (
    [...movingPartIds, ...springPartIds].some((id) => !partIds.includes(id)) ||
    movingPartIds.some((id) => springPartIds.includes(id))
  )
    throw Error("活动件、弹簧必须是不同的组件成员。");
  if (
    raw.switchPartId !== undefined &&
    (typeof raw.switchPartId !== "string" ||
      !partIds.includes(raw.switchPartId) ||
      movingPartIds.includes(raw.switchPartId) ||
      springPartIds.includes(raw.switchPartId))
  )
    throw Error("开关必须引用固定成员。");
  let contact: MechanismContact | undefined;
  if (raw.contact !== undefined) {
    const c = raw.contact;
    if (
      !record(c) ||
      typeof c.strikerPartId !== "string" ||
      !movingPartIds.includes(c.strikerPartId) ||
      !vec(c.strikerPoint) ||
      !vec(c.switchPoint) ||
      !vec(c.switchNormal) ||
      Math.abs(Math.hypot(...c.switchNormal) - 1) > 1e-5 ||
      typeof c.radius !== "number" ||
      !Number.isFinite(c.radius) ||
      c.radius <= 0 ||
      c.radius > 100000 ||
      typeof c.maxOvertravel !== "number" ||
      !Number.isFinite(c.maxOvertravel) ||
      c.maxOvertravel < 0 ||
      c.maxOvertravel > 100000
    )
      throw Error(
        "接触定义需要活动撞针成员、有效局部点、单位法向、触发半径和允许压入量。",
      );
    if (
      c.targetPartId !== undefined &&
      (typeof c.targetPartId !== "string" ||
        !partIds.includes(c.targetPartId) ||
        movingPartIds.includes(c.targetPartId) ||
        springPartIds.includes(c.targetPartId))
    )
      throw Error("触发面必须引用固定角色成员。");
    contact = {
      strikerPartId: c.strikerPartId,
      ...(c.targetPartId !== undefined
        ? { targetPartId: c.targetPartId as string }
        : {}),
      strikerPoint: [...c.strikerPoint],
      switchPoint: [...c.switchPoint],
      switchNormal: [...c.switchNormal],
      radius: c.radius,
      maxOvertravel: c.maxOvertravel,
    };
    if (c.actuatorPartIds !== undefined) {
      const actuatorPartIds = ids(c.actuatorPartIds);
      const targetPartId = c.targetPartId ?? raw.switchPartId;
      if (
        !actuatorPartIds.length ||
        typeof targetPartId !== "string" ||
        !actuatorPartIds.includes(targetPartId) ||
        actuatorPartIds.some(
          (id) =>
            !partIds.includes(id) ||
            movingPartIds.includes(id) ||
            springPartIds.includes(id),
        )
      )
        throw Error(
          "随动触头必须是不同的固定角色成员，并包含实际触发面所属子件。",
        );
      contact.actuatorPartIds = actuatorPartIds;
    }
  }
  return {
    version: 1,
    id: raw.id,
    name: raw.name.trim(),
    kind: raw.kind as Mechanism["kind"],
    status: raw.status as Mechanism["status"],
    partIds,
    movingPartIds,
    springPartIds,
    ...(raw.switchPartId ? { switchPartId: raw.switchPartId as string } : {}),
    frame: parseFrame(raw.frame),
    axis: [...raw.axis],
    pose: { offset: raw.pose.offset, angle: raw.pose.angle },
    params: numericParams(raw.params),
    movingProxy: parseProxy(raw.movingProxy),
    fixedProxy: parseProxy(raw.fixedProxy),
    ...(contact ? { contact } : {}),
  };
}
/** Configuration edits cannot move only a proxy while leaving its visible member rig behind. */
export function validateMechanismUpdate(
  project: Project,
  raw: unknown,
): Mechanism {
  const candidate = validateMechanismDefinition(raw, project.parts);
  const current = project.mechanisms?.find((m) => m.id === candidate.id);
  if (
    project.mechanisms?.some(
      (m) =>
        m.id !== candidate.id &&
        m.partIds.some((id) => candidate.partIds.includes(id)),
    )
  )
    throw Error("子零件已属于其他功能组件，请先调整原组件成员。");
  if (!current) {
    if (candidate.pose.offset !== 0 || candidate.pose.angle !== 0)
      throw Error("新建组件的活动姿态必须归零，后续通过受检运动调整。");
    return candidate;
  }
  const sameVector = (a: Vec3, b: Vec3) =>
    a.every((value, i) => Math.abs(value - b[i]) < 1e-8);
  if (
    !sameVector(current.frame.position, candidate.frame.position) ||
    !sameVector(current.frame.rotation, candidate.frame.rotation) ||
    Math.abs(current.pose.offset - candidate.pose.offset) > 1e-8 ||
    Math.abs(current.pose.angle - candidate.pose.angle) > 1e-8
  )
    throw Error("现有组件的 frame / pose 只能通过受检移动或旋转修改。");
  if (
    current.kind === "mating" &&
    (Math.abs(current.pose.offset) > 1e-8 ||
      Math.abs(current.pose.angle) > 1e-8)
  ) {
    const canonical = (value: unknown): string =>
      JSON.stringify(value, (_key, item) =>
        record(item)
          ? Object.fromEntries(
              Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
            )
          : item,
      );
    if (
      canonical({ ...current, name: "", status: "" }) !==
      canonical({ ...candidate, name: "", status: "" })
    )
      throw Error(
        "配合组件尚未回到零位；请先受检退回后再更改成员、轴或代理参数。",
      );
  }
  return candidate;
}

function bounds(parts: Part[]) {
  const box = new Box3();
  for (const p of parts)
    for (const x of [-1, 1])
      for (const y of [-1, 1])
        for (const z of [-1, 1])
          box.expandByPoint(
            new Vector3(
              (p.size[0] * x) / 2,
              (p.size[1] * y) / 2,
              (p.size[2] * z) / 2,
            )
              .applyQuaternion(quat(p.rotation))
              .add(new Vector3(...p.position)),
          );
  if (box.isEmpty()) box.set(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
  return {
    center: vector(box.getCenter(new Vector3())),
    size: vector(box.getSize(new Vector3())),
  };
}
export function createMechanism(
  kind: Mechanism["kind"],
  parts: Part[],
): Mechanism {
  const whole = bounds(parts),
    moving = parts.slice(0, 1),
    fixed = parts.slice(1);
  const proxy = (members: Part[], type: MechanismProxyKind): MechanismProxy => {
    const b = bounds(members);
    return {
      kind: type,
      position: b.center.map((v, i) => v - whole.center[i]) as Vec3,
      rotation: [0, 0, 0],
      size: b.size,
      params: {},
    };
  };
  return {
    version: 1,
    id: crypto.randomUUID(),
    name: kind === "press" ? "按压回弹组件" : "插销配合组件",
    kind,
    status: "unconfigured",
    partIds: parts.map((p) => p.id),
    movingPartIds: moving.map((p) => p.id),
    springPartIds: [],
    frame: { position: whole.center, rotation: [0, 0, 0] },
    axis: [0, 1, 0],
    pose: { offset: 0, angle: 0 },
    params: {},
    movingProxy: proxy(moving, kind === "mating" ? "tenon" : "base"),
    fixedProxy: proxy(fixed, kind === "mating" ? "mortise" : "base"),
  };
}
export function partMechanism(
  project: Project,
  partId: string,
): Mechanism | undefined {
  return project.mechanisms?.find((m) => m.partIds.includes(partId));
}

function proxyPart(m: Mechanism, moving: boolean, displacement = 0): Part {
  const source = moving ? m.movingProxy : m.fixedProxy;
  const frameQ = quat(m.frame.rotation),
    turn = new Quaternion().setFromAxisAngle(
      new Vector3(...m.axis),
      moving ? m.pose.angle * RAD : 0,
    );
  const localPosition = new Vector3(...source.position).applyQuaternion(turn);
  if (moving)
    localPosition.addScaledVector(
      new Vector3(...m.axis),
      m.pose.offset - displacement,
    );
  const paired = source.kind !== "base";
  return {
    id: proxyId(m, moving),
    name: `${m.name} · ${moving ? "活动" : "固定"}代理`,
    kind: source.kind,
    position: vector(
      localPosition
        .applyQuaternion(frameQ)
        .add(new Vector3(...m.frame.position)),
    ),
    rotation: angles(
      frameQ.clone().multiply(turn).multiply(quat(source.rotation)),
    ),
    size: [...source.size],
    color: "#7f9eae",
    fixed: !moving,
    visible: false,
    params: { ...source.params },
    ...(paired
      ? {
          interaction: {
            version: 1 as const,
            status: "configured" as const,
            axis: [0, 1, 0] as Vec3,
            anchor: [0, 0, 0] as Vec3,
            proxySize: [...source.size] as Vec3,
            mateFamily: m.id,
            insertionDepth: m.params.insertionDepth,
            minClearance: m.params.minClearance,
            ...(m.params.lockAngle === undefined
              ? {}
              : { lockAngle: m.params.lockAngle }),
          },
        }
      : {}),
  };
}
export interface MechanismContactState {
  /** Gap to the stationary trigger plane; it remains negative during overtravel. */
  gap: number;
  /** Gap to the visible, possibly following plunger surface. */
  surfaceGap: number;
  /** Unclamped axial penetration after the first contact. */
  overtravel: number;
  actuatorTravel: number;
  radial: number;
  triggerTravel: number;
  axisAlignment: number;
  radius: number;
  maxOvertravel: number;
  pressed: boolean;
  touching: boolean;
  strikerWorld: Vec3;
  switchWorld: Vec3;
  restSwitchWorld: Vec3;
  normalWorld: Vec3;
}
/** Measures the declared points on the actual member poses, never a scalar trigger threshold. */
export function mechanismContact(
  project: Project,
  m: Mechanism,
  states: MechanismStates = {},
): MechanismContactState | undefined {
  const c = m.contact;
  if (!c || !m.switchPartId) return undefined;
  const striker = project.parts.find((part) => part.id === c.strikerPartId),
    target = project.parts.find(
      (part) => part.id === (c.targetPartId ?? m.switchPartId),
    );
  if (
    !striker ||
    !target ||
    !vec(c.strikerPoint) ||
    !vec(c.switchPoint) ||
    !vec(c.switchNormal)
  )
    return undefined;
  const worldPoint = (part: Part, point: Vec3) =>
    new Vector3(...point)
      .applyQuaternion(quat(part.rotation))
      .add(new Vector3(...part.position));
  const normal = new Vector3(...c.switchNormal)
      .applyQuaternion(quat(target.rotation))
      .normalize(),
    axis = frameAxis(m).normalize();
  const rest = worldPoint(striker, c.strikerPoint),
    switchPoint = worldPoint(target, c.switchPoint);
  const alignment = axis.dot(normal),
    restGap = rest.clone().sub(switchPoint).dot(normal);
  const displacement = states[m.id]?.displacement ?? 0;
  const position = rest.clone().addScaledVector(axis, -displacement),
    relative = position.clone().sub(switchPoint);
  const gap = relative.dot(normal),
    radial = relative.addScaledVector(normal, -gap).length();
  const touching = gap <= 1e-6 && radial <= c.radius + 1e-6;
  const triggerTravel =
    alignment > 1e-8 ? Math.max(0, restGap / alignment) : Infinity;
  const overtravel = Math.max(0, displacement - triggerTravel);
  const aligned = alignment >= Math.cos(0.5 * RAD);
  const hasActuator = Boolean(c.actuatorPartIds?.length);
  const actuatorTravel =
    hasActuator && touching && aligned
      ? Math.min(c.maxOvertravel, overtravel)
      : 0;
  const currentSwitchPoint = switchPoint
    .clone()
    .addScaledVector(axis, -actuatorTravel);
  return {
    gap,
    surfaceGap: position.clone().sub(currentSwitchPoint).dot(normal),
    overtravel,
    actuatorTravel,
    radial,
    triggerTravel,
    axisAlignment: alignment,
    radius: c.radius,
    maxOvertravel: c.maxOvertravel,
    touching,
    pressed:
      touching &&
      gap >= -c.maxOvertravel - 1e-6 &&
      (!hasActuator || overtravel <= c.maxOvertravel + 1e-6) &&
      aligned,
    strikerWorld: vector(position),
    switchWorld: vector(currentSwitchPoint),
    restSwitchWorld: vector(switchPoint),
    normalWorld: vector(normal),
  };
}
export function mechanismDefinitionIssues(
  m: Mechanism,
  parts: Part[],
): Issue[] {
  const issues: Issue[] = [];
  try {
    validateMechanismDefinition(m, parts);
  } catch (error) {
    return [
      issue(
        m,
        "definition",
        error instanceof Error ? error.message : "定义无效",
      ),
    ];
  }
  const fail = (key: string, detail: string) =>
    issues.push(issue(m, key, detail));
  if (m.status !== "configured")
    fail("status", "仅供预览，请标定角色、轴和功能代理后完成配置。");
  if (m.partIds.length < 2 || !m.movingPartIds.length || !fixedIds(m).length)
    fail("roles", "至少需要一个活动成员和一个固定成员。");
  if (parts.some((part) => m.movingPartIds.includes(part.id) && part.fixed))
    fail("fixed", "活动成员仍被固定，请先解除该成员的固定状态。");
  if (
    parts.some(
      (part) => m.contact?.actuatorPartIds?.includes(part.id) && part.fixed,
    )
  )
    fail("actuator-fixed", "随动触头仍被固定，请先解除该触头子件的固定状态。");
  if (
    parts.some(
      (part) =>
        part.id === m.switchPartId &&
        ["battery", "lamp", "resistor"].includes(part.kind),
    )
  )
    fail(
      "switch-role",
      "电源、灯或电阻不能同时作为开关触点，请选择独立开关成员。",
    );
  if (m.kind === "press") {
    const labels: Record<string, string> = {
      mass: "运动质量",
      stiffness: "弹簧刚度",
      travel: "最大行程",
      trigger: "触发行程",
      freeLength: "自由长度",
      damping: "阻尼系数",
      solidLength: "并圈高度",
    };
    for (const key of ["mass", "stiffness", "travel", "freeLength"] as const)
      if (!(m.params[key] > 0)) fail(key, `请填写大于零的${labels[key]}。`);
    for (const key of ["damping", "solidLength"] as const)
      if (!(m.params[key] >= 0)) fail(key, `请填写非负的${labels[key]}。`);
    if (
      m.params.freeLength <= m.params.solidLength ||
      m.params.travel > m.params.freeLength - m.params.solidLength
    )
      fail("travel", "行程不能超过自由长度减并圈高度。");
    if (m.params.freeLength > 0) {
      const axis = frameAxis(m).normalize();
      for (const id of m.springPartIds) {
        const spring = parts.find((part) => part.id === id)!;
        const localAxis = axis
          .clone()
          .applyQuaternion(quat(spring.rotation).invert())
          .toArray();
        const actualLength = spring.size.reduce(
          (sum, size, index) => sum + Math.abs(localAxis[index]) * size,
          0,
        );
        const tolerance = Math.max(0.001, m.params.freeLength * 1e-5);
        if (
          !Number.isFinite(actualLength) ||
          Math.abs(actualLength - m.params.freeLength) > tolerance
        )
          fail(
            `spring-length-${id}`,
            `${spring.name} 沿组件轴的显示包络长度为 ${actualLength.toFixed(4)} mm，与自由长度 ${m.params.freeLength.toFixed(4)} mm 不符（容差 ${tolerance.toFixed(4)} mm）；请校准尺寸，避免压缩时固定端漂移。`,
          );
      }
    }
    if (m.pose.offset !== 0 || m.pose.angle !== 0)
      fail("rest", "按压组件使用静止成员姿态；偏移和角度须为零。");
    if (m.switchPartId) {
      if (!m.contact)
        fail(
          "contact",
          "请指定活动撞针上的端点与固定开关上的触发点，不能仅按行程阈值导通。",
        );
      else {
        const metrics = mechanismContact(
          { version: 1, name: "contact", parts, wires: [] },
          m,
        )!;
        const striker = parts.find(
            (part) => part.id === m.contact!.strikerPartId,
          )!,
          target = parts.find(
            (part) => part.id === (m.contact!.targetPartId ?? m.switchPartId),
          )!;
        if (
          m.contact.strikerPoint.some(
            (v, i) => Math.abs(v) > striker.size[i] / 2 + 1e-4,
          ) ||
          m.contact.switchPoint.some(
            (v, i) => Math.abs(v) > target.size[i] / 2 + 1e-4,
          )
        )
          fail(
            "contact-point",
            "撞针端点与开关触发点必须位于各自子件的局部尺寸包络内。",
          );
        if (
          m.contact.switchPoint.some(
            (v, i) =>
              Math.abs(v) +
                m.contact!.radius *
                  Math.sqrt(Math.max(0, 1 - m.contact!.switchNormal[i] ** 2)) >
              target.size[i] / 2 + 1e-4,
          )
        )
          fail(
            "contact-area",
            "有效触发圆盘超出开关子件的尺寸包络，请缩小半径或重新定位触发点。",
          );
        if (metrics.axisAlignment < Math.cos(0.5 * RAD))
          fail(
            "contact-axis",
            "开关触发面法向必须与按压操作轴同向，压下时撞针才会靠近触点。",
          );
        if (metrics.gap < -1e-6)
          fail(
            "contact-rest",
            "静止撞针已经穿入开关触发面，请先校准静止位置。",
          );
        if (
          !Number.isFinite(metrics.triggerTravel) ||
          metrics.triggerTravel > m.params.travel + 1e-6
        )
          fail("contact-reach", "开关触发点不在允许按压行程内。");
        if (Number.isFinite(metrics.triggerTravel)) {
          const atContact = mechanismContact(
            { version: 1, name: "contact", parts, wires: [] },
            m,
            {
              [m.id]: {
                displacement: metrics.triggerTravel,
                velocity: 0,
                force: 0,
              },
            },
          )!;
          if (atContact.radial > m.contact.radius + 1e-6)
            fail(
              "contact-radius",
              "撞针路径错开了开关有效触发区域，请调整横向对齐或触点定义。",
            );
        }
        if (
          m.params.travel * metrics.axisAlignment >
            metrics.gap + m.contact.maxOvertravel + 1e-6 ||
          (m.contact.actuatorPartIds?.length &&
            m.params.travel >
              metrics.triggerTravel + m.contact.maxOvertravel + 1e-6)
        )
          fail(
            "contact-overtravel",
            "最大行程超过触点间隙与允许压入量之和，会让撞针穿入开关。",
          );
      }
    } else if (m.contact)
      fail("contact-switch", "接触定义必须绑定固定开关成员。");
  } else {
    const expected = {
      tenon: "mortise",
      pin: "sleeve",
      "bayonet-pin": "bayonet-socket",
    }[m.movingProxy.kind as "tenon" | "pin" | "bayonet-pin"];
    if (!expected || m.fixedProxy.kind !== expected)
      fail(
        "pair",
        "配合组件需声明方榫/方孔、圆销/套筒或标准双耳旋锁公母代理。",
      );
    if (m.springPartIds.length || m.switchPartId)
      fail("roles", "配合组件仅使用固定与活动角色；回弹开关请建立按压组件。");
    if (m.contact) fail("contact-kind", "撞针触发点只用于按压组件。");
  }
  for (const [moving, proxy] of [
    [true, m.movingProxy],
    [false, m.fixedProxy],
  ] as const) {
    if (proxy.kind !== "base") {
      const direction = new Vector3(0, 1, 0).applyQuaternion(
        quat(proxy.rotation),
      );
      if (direction.dot(new Vector3(...m.axis)) < Math.cos(0.5 * RAD))
        fail(`axis-${moving}`, "操作轴必须与公母代理的局部 Y 轴同向。");
    }
    for (const entry of componentPartIssues(proxyPart(m, moving)))
      if (entry.severity === "error")
        fail(`proxy-${moving}-${entry.id}`, entry.detail);
  }
  issues.push(
    issue(
      m,
      "accuracy",
      "功能由用户声明的活动/固定代理、质量、弹簧与行程求解；子件保留真实显示网格，但尚未证明代理与网格一致，未计算摩擦、变形或有限元。",
      "warning",
    ),
  );
  return issues;
}
export function mechanismIssues(project: Project): Issue[] {
  const issues: Issue[] = [],
    occupied = new Set<string>(),
    ids = new Set<string>();
  for (const m of project.mechanisms ?? []) {
    issues.push(...mechanismDefinitionIssues(m, project.parts));
    if (
      project.parts.some(
        (part) =>
          m.partIds.includes(part.id) &&
          part.kind === "button" &&
          part.id !== m.switchPartId &&
          project.wires.some(
            (wire) =>
              wire.from.partId === part.id || wire.to.partId === part.id,
          ),
      )
    )
      issues.push(
        issue(
          m,
          "wired-switch",
          "带导线的开关成员必须设为该组件的开关角色，或从组件中移出以保留独立行为。",
        ),
      );
    if (ids.has(m.id)) issues.push(issue(m, "duplicate", "功能组件标识重复。"));
    ids.add(m.id);
    for (const id of m.partIds) {
      if (occupied.has(id))
        issues.push(issue(m, "overlap", "一个子件只能属于一个功能组件。"));
      occupied.add(id);
    }
  }
  return issues;
}
interface MechanismAnalysis {
  issues: Issue[];
  active: Mechanism[];
  errorsById: Map<string, Issue[]>;
}
/** Reused only within one synchronous operation; callers may mutate projects between calls. */
function analyzeMechanisms(project: Project): MechanismAnalysis {
  const issues = mechanismIssues(project);
  const errorsById = new Map(
    (project.mechanisms ?? []).map((m) => [
      m.id,
      issues.filter(
        (entry) =>
          entry.severity === "error" &&
          entry.id.startsWith(`mechanism-${m.id}-`),
      ),
    ]),
  );
  return {
    issues,
    errorsById,
    active: (project.mechanisms ?? []).filter(
      (m) => !errorsById.get(m.id)!.length,
    ),
  };
}
export interface MechanismScene {
  renderParts: Part[];
  physicsParts: Part[];
  circuitParts: Part[];
  deformations: Record<string, MechanismDeformation>;
  pressedIds: string[];
  contacts: Record<string, MechanismContactState>;
  issues: Issue[];
}
export function mechanismScene(
  project: Project,
  states: MechanismStates = {},
): MechanismScene {
  return sceneWithAnalysis(project, states, analyzeMechanisms(project));
}
function sceneWithAnalysis(
  project: Project,
  states: MechanismStates,
  analysis: MechanismAnalysis,
): MechanismScene {
  const issues = [...analysis.issues],
    render = new Map(project.parts.map((p) => [p.id, p]));
  const active = analysis.active;
  const memberIds = new Set(active.flatMap((m) => m.partIds));
  const physicsParts = project.parts.filter((p) => !memberIds.has(p.id));
  const circuitParts = project.parts.filter(
    (p) =>
      !memberIds.has(p.id) || ["battery", "lamp", "resistor"].includes(p.kind),
  );
  const deformations: Record<string, MechanismDeformation> = {},
    pressedIds: string[] = [],
    contacts: Record<string, MechanismContactState> = {};
  for (const m of active) {
    const state = states[m.id],
      validState =
        !state ||
        ([state.displacement, state.velocity, state.force].every(
          Number.isFinite,
        ) &&
          state.displacement >= 0 &&
          state.displacement <= m.params.travel);
    if (!validState) issues.push(issue(m, "state", "按压状态必须是有限数值。"));
    const displacement =
      m.kind === "press" && state && validState
        ? Math.max(0, Math.min(m.params.travel, state.displacement))
        : 0;
    physicsParts.push(proxyPart(m, false), proxyPart(m, true, displacement));
    if (m.kind !== "press") continue;
    const axis = frameAxis(m);
    for (const id of m.movingPartIds) {
      const p = render.get(id)!;
      render.set(id, {
        ...p,
        position: vector(
          new Vector3(...p.position).addScaledVector(axis, -displacement),
        ),
      });
    }
    for (const id of m.springPartIds) {
      const p = render.get(id)!;
      render.set(id, {
        ...p,
        position: vector(
          new Vector3(...p.position).addScaledVector(axis, -displacement / 2),
        ),
      });
      deformations[id] = {
        axis: vector(axis.clone().applyQuaternion(quat(p.rotation).invert())),
        ratio: (m.params.freeLength - displacement) / m.params.freeLength,
      };
    }
    if (m.switchPartId) {
      const contact = mechanismContact(project, m, {
        [m.id]: {
          displacement,
          velocity: state?.velocity ?? 0,
          force: state?.force ?? 0,
        },
      })!;
      contacts[m.id] = contact;
      for (const id of m.contact?.actuatorPartIds ?? []) {
        const part = render.get(id)!;
        render.set(id, {
          ...part,
          position: vector(
            new Vector3(...part.position).addScaledVector(
              axis,
              -contact.actuatorTravel,
            ),
          ),
        });
      }
      const source = render.get(m.switchPartId)!;
      circuitParts.push({
        ...source,
        kind: "button",
        model: undefined,
        interaction: undefined,
        params: {
          ...m.params,
          trigger: contact.triggerTravel,
          compression: displacement,
        },
      });
      if (contact.pressed) pressedIds.push(source.id);
    }
  }
  return {
    renderParts: project.parts.map((p) => render.get(p.id)!),
    physicsParts,
    circuitParts,
    deformations,
    pressedIds,
    contacts,
    issues,
  };
}
function originalIds(project: Project, id: string): string[] {
  for (const m of project.mechanisms ?? []) {
    if (id === proxyId(m, true)) return m.movingPartIds;
    if (id === proxyId(m, false)) return fixedIds(m);
  }
  return [id];
}
const mapIssues = (project: Project, issues: Issue[]) =>
  issues.map((entry) => ({
    ...entry,
    partIds: [
      ...new Set(entry.partIds.flatMap((id) => originalIds(project, id))),
    ],
  }));
export function validateMechanismProject(
  project: Project,
  states: MechanismStates = {},
): Validation {
  const scene = mechanismScene(project, states),
    validation = validateAssembly(scene.physicsParts);
  const issues = [...scene.issues, ...mapIssues(project, validation.issues)];
  return {
    issues: issues.some((i) => i.severity === "error")
      ? issues.filter((i) => i.id !== "geometry-pass")
      : issues,
    minClearance: validation.minClearance,
    collisionPairs: validation.collisionPairs.flatMap(([a, b]) =>
      originalIds(project, a).flatMap((x) =>
        originalIds(project, b).map((y) => [x, y] as [string, string]),
      ),
    ),
  };
}
export function stepMechanisms(
  project: Project,
  states: MechanismStates,
  dt: number,
  heldIds: string[],
): { states: MechanismStates; issues: Issue[] } {
  const next = { ...states },
    issues: Issue[] = [];
  if (!Number.isFinite(dt) || dt <= 0 || dt > 10)
    return {
      states: next,
      issues: [
        {
          id: "mechanism-timestep",
          severity: "error",
          title: "仿真步长无效",
          detail: "时间步长须在 0 至 10 秒之间。",
          partIds: [],
          category: "physics",
        },
      ],
    };
  const analysis = analyzeMechanisms(project);
  const held = new Set(heldIds);
  let physicsParts: Part[] | undefined;
  for (const m of project.mechanisms ?? []) {
    if (m.kind !== "press") continue;
    const configuration = analysis.errorsById.get(m.id)!;
    if (configuration.length) {
      issues.push(...configuration);
      continue;
    }
    const previous: SpringState = next[m.id] ?? {
      displacement: 0,
      velocity: 0,
      force: 0,
    };
    if (
      ![previous.displacement, previous.velocity, previous.force].every(
        Number.isFinite,
      ) ||
      previous.displacement < 0 ||
      previous.displacement > m.params.travel
    ) {
      issues.push(issue(m, "state", "压缩状态须在有效行程范围内。"));
      continue;
    }
    // Idle keys still pass definition/state checks, but need no swept-motion query.
    if (
      !held.has(m.id) &&
      previous.displacement === 0 &&
      previous.velocity === 0
    ) {
      next[m.id] = { displacement: 0, velocity: 0, force: 0 };
      continue;
    }
    const candidate = stepSpring(previous, dt, {
      stiffness: m.params.stiffness,
      mass: m.params.mass,
      damping: m.params.damping,
      travel: m.params.travel,
      force: held.has(m.id) ? m.params.stiffness * m.params.travel * 1.1 : 0,
    });
    // All keys see prior accepted moves in this same step; no state is cached across calls.
    physicsParts ??= sceneWithAnalysis(project, next, analysis).physicsParts;
    const moved = proxyPart(m, true, candidate.displacement);
    const check = validateMotion(physicsParts, moved.id, moved);
    if (!check.allowed) {
      next[m.id] = { ...previous, velocity: 0 };
      issues.push(...mapIssues(project, check.issues));
    } else {
      next[m.id] = candidate;
      const index = physicsParts.findIndex((part) => part.id === moved.id);
      physicsParts[index] = moved;
    }
  }
  return { states: next, issues };
}
export interface MechanismMotionResult {
  project: Project;
  allowed: boolean;
  issues: Issue[];
}
function failMotion(
  project: Project,
  m: Mechanism | undefined,
  detail: string,
): MechanismMotionResult {
  return {
    project,
    allowed: false,
    issues: [
      m
        ? issue(m, "motion", detail)
        : {
            id: "mechanism-missing",
            severity: "error",
            title: "功能组件不存在",
            detail,
            partIds: [],
            category: "physics",
          },
    ],
  };
}
function replaceMechanism(project: Project, m: Mechanism): Project {
  return {
    ...project,
    mechanisms: project.mechanisms!.map((current) =>
      current.id === m.id ? m : current,
    ),
  };
}
export function moveMechanism(
  project: Project,
  id: string,
  delta: { distance?: number; angle?: number },
): MechanismMotionResult {
  const m = project.mechanisms?.find((item) => item.id === id);
  if (!m || m.kind !== "mating")
    return failMotion(project, m, "沿轴插入与旋入仅用于配合组件。");
  const errors = mechanismIssues(project).filter(
    (i) => i.severity === "error" && i.id.startsWith(`mechanism-${m.id}-`),
  );
  if (errors.length) return { project, allowed: false, issues: errors };
  const distance = delta.distance ?? 0,
    angle = delta.angle ?? 0;
  if (![distance, angle].every(Number.isFinite))
    return failMotion(project, m, "位移与角度必须是有限数值。");
  const radius =
    new Vector3(...m.movingProxy.position).length() +
    new Vector3(...m.movingProxy.size).length() / 2;
  const samples = Math.max(
    1,
    Math.ceil((Math.abs(distance) + Math.abs(angle) * RAD * radius) / 0.25),
  );
  if (samples > 20000)
    return failMotion(project, m, "单次组件操作范围过大，请减小步长。");
  let previous = mechanismScene(project).physicsParts;
  for (let index = 1; index <= samples; index++) {
    const t = index / samples;
    const candidate: Mechanism = {
      ...m,
      pose: {
        offset: m.pose.offset + distance * t,
        angle: m.pose.angle + angle * t,
      },
    };
    const nextParts = mechanismScene(
      replaceMechanism(project, candidate),
    ).physicsParts;
    const next = nextParts.find((p) => p.id === proxyId(m, true))!;
    const check = validateMotion(previous, next.id, next);
    if (!check.allowed)
      return {
        project,
        allowed: false,
        issues: mapIssues(project, check.issues),
      };
    previous = nextParts;
  }
  const axis = frameAxis(m),
    turn = new Quaternion().setFromAxisAngle(axis, angle * RAD),
    origin = new Vector3(...m.frame.position);
  const updated = replaceMechanism(project, {
    ...m,
    pose: { offset: m.pose.offset + distance, angle: m.pose.angle + angle },
  });
  updated.parts = project.parts.map((p) =>
    m.movingPartIds.includes(p.id)
      ? {
          ...p,
          position: vector(
            new Vector3(...p.position)
              .sub(origin)
              .applyQuaternion(turn)
              .add(origin)
              .addScaledVector(axis, distance),
          ),
          rotation: angles(turn.clone().multiply(quat(p.rotation))),
        }
      : p,
  );
  return {
    project: updated,
    allowed: true,
    issues: mapIssues(
      updated,
      validateAssembly(previous).issues.filter(
        (i) => i.partIds.includes(proxyId(m, true)) && i.severity !== "pass",
      ),
    ),
  };
}
export function transformMechanismFrame(
  project: Project,
  id: string,
  frame: MechanismFrame,
): MechanismMotionResult {
  const m = project.mechanisms?.find((item) => item.id === id);
  if (!m) return failMotion(project, m, "请重新选择功能组件。");
  if (project.parts.some((part) => m.partIds.includes(part.id) && part.fixed))
    return failMotion(
      project,
      m,
      "组件包含已固定的成员，不能移动整体坐标框架。",
    );
  try {
    parseFrame(frame);
  } catch {
    return failMotion(project, m, "组件目标坐标无效。");
  }
  const errors = mechanismIssues(project).filter(
    (i) => i.severity === "error" && i.id.startsWith(`mechanism-${m.id}-`),
  );
  if (errors.length) return { project, allowed: false, issues: errors };
  const distance = new Vector3(...frame.position).distanceTo(
    new Vector3(...m.frame.position),
  );
  const radius =
    Math.max(
      ...[m.movingProxy, m.fixedProxy].map(
        (proxy) =>
          new Vector3(...proxy.position).length() +
          new Vector3(...proxy.size).length() / 2,
      ),
    ) + Math.abs(m.pose.offset);
  const angularTravel =
    frame.rotation.reduce(
      (sum, v, i) => sum + Math.abs(v - m.frame.rotation[i]) * RAD,
      0,
    ) * radius;
  const samples = Math.max(1, Math.ceil((distance + angularTravel) / 0.25));
  if (samples > 20000)
    return failMotion(project, m, "单次组件操作范围过大，请减小步长。");
  for (let index = 1; index <= samples; index++) {
    const t = index / samples;
    const candidate = {
      ...m,
      frame: {
        position: m.frame.position.map(
          (v, i) => v + (frame.position[i] - v) * t,
        ) as Vec3,
        rotation: m.frame.rotation.map(
          (v, i) => v + (frame.rotation[i] - v) * t,
        ) as Vec3,
      },
    };
    const check = validateAssembly(
      mechanismScene(replaceMechanism(project, candidate)).physicsParts,
    );
    const blocking = check.issues.filter(
      (entry) =>
        entry.severity === "error" &&
        [proxyId(m, true), proxyId(m, false)].some((proxy) =>
          entry.partIds.includes(proxy),
        ),
    );
    if (blocking.length)
      return { project, allowed: false, issues: mapIssues(project, blocking) };
  }
  const rotation = quat(frame.rotation).multiply(
    quat(m.frame.rotation).invert(),
  );
  const updated = replaceMechanism(project, {
    ...m,
    frame: structuredClone(frame),
  });
  updated.parts = project.parts.map((p) =>
    m.partIds.includes(p.id)
      ? {
          ...p,
          position: vector(
            new Vector3(...p.position)
              .sub(new Vector3(...m.frame.position))
              .applyQuaternion(rotation)
              .add(new Vector3(...frame.position)),
          ),
          rotation: angles(rotation.clone().multiply(quat(p.rotation))),
        }
      : p,
  );
  return { project: updated, allowed: true, issues: [] };
}
