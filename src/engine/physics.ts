import {
  bayonetSolids,
  bayonetParameterIssues,
  DEFAULT_BAYONET,
} from "./bayonet";
import type {
  Part,
  Vec3,
  Issue,
  Validation,
  MotionResult,
  Wire,
  CircuitResult,
  SpringState,
} from "../types";

const EPS = 1e-6;
const RAD = Math.PI / 180;
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (a: Vec3) => Math.sqrt(dot(a, a));
const num = (p: Part, key: string, fallback: number) =>
  typeof p.params[key] === "number" ? (p.params[key] as number) : fallback;
const issue = (
  id: string,
  severity: Issue["severity"],
  title: string,
  detail: string,
  partIds: string[],
  category: Issue["category"] = "geometry",
): Issue => ({ id, severity, title, detail, partIds, category });

/** Matches THREE.Euler's XYZ convention. All public geometry uses millimetres. */
function axes(rotation: Vec3): Vec3[] {
  const [x, y, z] = rotation.map((v) => v * RAD);
  const a = Math.cos(x),
    b = Math.sin(x),
    c = Math.cos(y),
    d = Math.sin(y),
    e = Math.cos(z),
    f = Math.sin(z);
  return [
    [c * e, a * f + b * e * d, b * f - a * e * d],
    [-c * f, a * e - b * f * d, b * e + a * f * d],
    [d, -b * c, a * c],
  ];
}
function transform(v: Vec3, basis: Vec3[]): Vec3 {
  return add(
    add(scale(basis[0], v[0]), scale(basis[1], v[1])),
    scale(basis[2], v[2]),
  );
}
interface Convex {
  center: Vec3;
  vertices: Vec3[];
  normals: Vec3[];
  edges: Vec3[];
  radius: number;
  bounds?: { min: Vec3; max: Vec3 };
}
function box(
  p: Part,
  offset: Vec3 = [0, 0, 0],
  size: Vec3 = p.size,
  localYaw = 0,
): Convex {
  const base = axes(p.rotation),
    center = add(p.position, transform(offset, base));
  const local = axes([0, localYaw, 0]);
  const basis = local.map((v) => transform(v, base));
  const vertices: Vec3[] = [];
  for (const x of [-1, 1])
    for (const y of [-1, 1])
      for (const z of [-1, 1])
        vertices.push(
          add(
            center,
            transform(
              [(x * size[0]) / 2, (y * size[1]) / 2, (z * size[2]) / 2],
              basis,
            ),
          ),
        );
  return {
    center,
    vertices,
    normals: basis,
    edges: basis,
    radius: length(size) / 2,
  };
}
const SIDES = 16;
function pin(p: Part): Convex {
  const basis = axes(p.rotation),
    radius = p.size[0] / 2 / Math.cos(Math.PI / SIDES),
    vertices: Vec3[] = [],
    normals: Vec3[] = [basis[1]],
    edges: Vec3[] = [basis[1]];
  for (let i = 0; i < SIDES; i++) {
    const a = ((i + 0.5) * Math.PI * 2) / SIDES;
    for (const y of [-p.size[1] / 2, p.size[1] / 2])
      vertices.push(
        add(
          p.position,
          transform([radius * Math.cos(a), y, radius * Math.sin(a)], basis),
        ),
      );
    if (i < SIDES / 2) {
      const n = (i * Math.PI * 2) / SIDES;
      normals.push(transform([Math.cos(n), 0, Math.sin(n)], basis));
      edges.push(transform([-Math.sin(n), 0, Math.cos(n)], basis));
    }
  }
  return {
    center: p.position,
    vertices,
    normals,
    edges,
    radius: Math.hypot(radius, p.size[1] / 2),
  };
}
const bayonetLocalCache = new Map<string, Convex[]>();
function bayonetConvex(p: Part): Convex[] {
  const signature = JSON.stringify([p.kind, p.size, p.params.holeDiameter]);
  let local = bayonetLocalCache.get(signature);
  if (!local) {
    local = bayonetSolids(p).map((solid) => {
      const vertices = solid.vertices;
      const center = scale(
        vertices.reduce((sum, v) => add(sum, v), [0, 0, 0] as Vec3),
        1 / vertices.length,
      );
      const normals: Vec3[] = [],
        edges: Vec3[] = [];
      const unique = (collection: Vec3[], v: Vec3) => {
        const norm = length(v);
        if (norm < EPS) return;
        const axis = scale(v, 1 / norm);
        if (!collection.some((e) => Math.abs(dot(e, axis)) > 1 - EPS))
          collection.push(axis);
      };
      for (const face of solid.faces) {
        unique(
          normals,
          cross(
            sub(vertices[face[1]], vertices[face[0]]),
            sub(vertices[face[2]], vertices[face[0]]),
          ),
        );
        for (let i = 0; i < face.length; i++)
          unique(
            edges,
            sub(vertices[face[(i + 1) % face.length]], vertices[face[i]]),
          );
      }
      return {
        center,
        vertices,
        normals,
        edges,
        radius: Math.max(...vertices.map((v) => length(sub(v, center)))),
      };
    });
    if (bayonetLocalCache.size > 100) bayonetLocalCache.clear();
    bayonetLocalCache.set(signature, local);
  }
  const basis = axes(p.rotation);
  return local.map((shape) => ({
    center: add(p.position, transform(shape.center, basis)),
    vertices: shape.vertices.map((v) => add(p.position, transform(v, basis))),
    normals: shape.normals.map((v) => transform(v, basis)),
    edges: shape.edges.map((v) => transform(v, basis)),
    radius: shape.radius,
  }));
}
function solids(p: Part): Convex[] {
  if (p.kind === "bayonet-pin" || p.kind === "bayonet-socket")
    return bayonetConvex(p);
  const [w, h, d] = p.size;
  if (p.kind === "mortise") {
    const iw = num(p, "innerWidth", w * 0.52),
      id = num(p, "innerDepth", d * 0.52);
    return [
      box(p, [-(w + iw) / 4, 0, 0], [(w - iw) / 2, h, d]),
      box(p, [(w + iw) / 4, 0, 0], [(w - iw) / 2, h, d]),
      box(p, [0, 0, -(d + id) / 4], [iw, h, (d - id) / 2]),
      box(p, [0, 0, (d + id) / 4], [iw, h, (d - id) / 2]),
    ];
  }
  if (p.kind === "sleeve") {
    // Shrink the proxy hole to an inscribed polygon, so tilted contact is conservative.
    const ri =
        (num(p, "holeDiameter", w * 0.6) / 2) * Math.cos(Math.PI / SIDES),
      ro = w / 2 / Math.cos(Math.PI / SIDES);
    return Array.from({ length: SIDES }, (_, i) => {
      const a = (i * 2 * Math.PI) / SIDES;
      return box(
        p,
        [(Math.sin(a) * (ro + ri)) / 2, 0, (Math.cos(a) * (ro + ri)) / 2],
        [2 * ro * Math.tan(Math.PI / SIDES), h, ro - ri],
        (i * 360) / SIDES,
      );
    });
  }
  return [p.kind === "pin" ? pin(p) : box(p)];
}
/** Bayonet parts use their real shared vertices; other kinds keep existing conservative envelopes. */
function floorHeight(p: Part, knownSolids?: Convex[]): number {
  if (p.kind !== "bayonet-pin" && p.kind !== "bayonet-socket")
    return Math.min(...box(p).vertices.map((v) => v[1]));
  let lowest = Infinity;
  for (const shape of knownSolids ?? solids(p))
    for (const vertex of shape.vertices) lowest = Math.min(lowest, vertex[1]);
  return lowest;
}
function separatingGap(a: Convex, b: Convex): number {
  const bounds = (shape: Convex) =>
    (shape.bounds ??= {
      min: [0, 1, 2].map((i) =>
        Math.min(...shape.vertices.map((v) => v[i])),
      ) as Vec3,
      max: [0, 1, 2].map((i) =>
        Math.max(...shape.vertices.map((v) => v[i])),
      ) as Vec3,
    });
  const ab = bounds(a),
    bb = bounds(b);
  for (let i = 0; i < 3; i++) {
    const gap = Math.max(bb.min[i] - ab.max[i], ab.min[i] - bb.max[i]);
    if (gap > EPS) return gap;
  }

  const boundingGap = length(sub(a.center, b.center)) - a.radius - b.radius;
  if (boundingGap > 0.5) return boundingGap;
  let largest = -Infinity;
  const seen: Vec3[] = [];
  const testAxis = (candidate: Vec3): boolean => {
    const norm = length(candidate);
    if (norm < EPS) return false;
    const axis = scale(candidate, 1 / norm);
    if (seen.some((v) => Math.abs(dot(v, axis)) > 1 - EPS)) return false;
    seen.push(axis);
    let amin = Infinity,
      amax = -Infinity,
      bmin = Infinity,
      bmax = -Infinity;
    for (const v of a.vertices) {
      const projection = dot(v, axis);
      amin = Math.min(amin, projection);
      amax = Math.max(amax, projection);
    }
    for (const v of b.vertices) {
      const projection = dot(v, axis);
      bmin = Math.min(bmin, projection);
      bmax = Math.max(bmax, projection);
    }
    largest = Math.max(largest, bmin - amax, amin - bmax);
    return largest > EPS;
  };
  // Face axes usually separate ring sectors from a shaft; defer expensive edge products.
  const faces =
    a.normals.length <= b.normals.length
      ? [a.normals, b.normals]
      : [b.normals, a.normals];
  for (const collection of faces)
    for (const normal of collection) if (testAxis(normal)) return largest;
  for (const x of a.edges)
    for (const y of b.edges) if (testAxis(cross(x, y))) return largest;
  return largest;
}
function cylindricalFitClearance(a: Part, b: Part): number | null {
  const peg = a.kind === "pin" ? a : b.kind === "pin" ? b : null;
  const socket = a.kind === "sleeve" ? a : b.kind === "sleeve" ? b : null;
  if (!peg || !socket) return null;
  const basis = axes(socket.rotation);
  if (Math.abs(dot(axes(peg.rotation)[1], basis[1])) < 1 - 1e-8) return null;
  const delta = sub(peg.position, socket.position);
  const offset = Math.hypot(dot(delta, basis[0]), dot(delta, basis[2]));
  return (
    (num(socket, "holeDiameter", socket.size[0] * 0.6) - peg.size[0]) / 2 -
    offset
  );
}
function collision(
  a: Part,
  b: Part,
  aSolids: Convex[],
  bSolids: Convex[],
): boolean {
  if (
    a.kind === "asset" ||
    b.kind === "asset" ||
    a.kind === "spring" ||
    b.kind === "spring"
  )
    return false;
  // Exact coaxial circular clearance avoids the polygon proxy rejecting a valid sliding fit.
  const circular = cylindricalFitClearance(a, b);
  if (circular !== null && circular >= -EPS) return false;
  return aSolids.some((x) => bSolids.some((y) => separatingGap(x, y) < -EPS));
}
function invalid(p: Part): boolean {
  return (
    ![...p.size, ...p.position, ...p.rotation].every(Number.isFinite) ||
    p.size.some((s) => s <= 0) ||
    !Object.values(p.params).every(
      (v) => typeof v !== "number" || Number.isFinite(v),
    )
  );
}
function fitIssues(parts: Part[]): {
  issues: Issue[];
  clearance: number | null;
} {
  const issues: Issue[] = [];
  let clearance: number | null = null;
  for (const socket of parts.filter(
    (p) => p.kind === "mortise" || p.kind === "sleeve",
  )) {
    const kind = socket.kind === "mortise" ? "tenon" : "pin",
      basis = axes(socket.rotation);
    for (const peg of parts.filter((p) => p.kind === kind)) {
      const delta = sub(peg.position, socket.position),
        local = basis.map((a) => dot(delta, a));
      const pegAxes = axes(peg.rotation);
      const extent = basis.map((a) =>
        peg.size.reduce(
          (s, v, i) => s + (Math.abs(dot(pegAxes[i], a)) * v) / 2,
          0,
        ),
      );
      const depth =
        Math.min(socket.size[1] / 2, local[1] + extent[1]) -
        Math.max(-socket.size[1] / 2, local[1] - extent[1]);
      if (
        depth < -EPS ||
        Math.abs(local[0]) > socket.size[0] / 2 + extent[0] ||
        Math.abs(local[2]) > socket.size[2] / 2 + extent[2]
      )
        continue;
      const tol =
        Math.max(0, num(socket, "tolerance", 0.05)) +
        Math.max(0, num(peg, "tolerance", 0.05));
      const circular = cylindricalFitClearance(peg, socket);
      const gap =
        socket.kind === "sleeve"
          ? circular === null
            ? -1
            : circular - tol / 2
          : Math.min(
              num(socket, "innerWidth", socket.size[0] * 0.52) / 2 -
                Math.abs(local[0]) -
                extent[0],
              num(socket, "innerDepth", socket.size[2] * 0.52) / 2 -
                Math.abs(local[2]) -
                extent[2],
            ) -
            tol / 2;
      const aligned =
        Math.abs(dot(pegAxes[1], basis[1])) >= Math.cos(0.5 * RAD);
      clearance = clearance === null ? gap : Math.min(clearance, gap);
      issues.push(
        issue(
          `fit-${socket.id}-${peg.id}`,
          gap < -EPS ? "error" : aligned ? "pass" : "warning",
          gap < -EPS ? "配合余隙不足" : depth > EPS ? "插入配合" : "孔口对齐",
          `${peg.name} → ${socket.name}；最不利单侧余隙 ${gap.toFixed(3)} mm，插入深度 ${Math.max(0, depth).toFixed(2)} mm；尺寸公差合计 ±${tol.toFixed(2)} mm${aligned ? "" : "；轴线偏斜"}`,
          [socket.id, peg.id],
          "fit",
        ),
      );
    }
  }
  for (const socket of parts.filter((p) => p.kind === "bayonet-socket"))
    for (const peg of parts.filter((p) => p.kind === "bayonet-pin")) {
      const basis = axes(socket.rotation),
        pegBasis = axes(peg.rotation),
        delta = sub(peg.position, socket.position);
      const local = basis.map((a) => dot(delta, a));
      if (
        Math.hypot(local[0], local[2]) > socket.size[0] / 2 + peg.size[0] / 2 ||
        Math.abs(local[1]) > socket.size[1] / 2 + peg.size[1] / 2
      )
        continue;
      const aligned = dot(pegBasis[1], basis[1]) >= Math.cos(0.1 * RAD);
      const relativeYaw =
        Math.atan2(dot(pegBasis[2], basis[0]), dot(pegBasis[2], basis[2])) /
        RAD;
      const yaw = ((((relativeYaw + 90) % 180) + 180) % 180) - 90;
      const ps = peg.size[0] / 16,
        py = peg.size[1] / 24,
        ss = socket.size[0] / 24,
        sy = socket.size[1] / 18;
      const tolerance =
        (Math.max(0, num(peg, "tolerance", 0.1)) +
          Math.max(0, num(socket, "tolerance", 0.1))) /
        2;
      const radial =
        (num(socket, "holeDiameter", DEFAULT_BAYONET.holeDiameter * ss) / 2) *
          Math.cos(2.5 * RAD) -
        (DEFAULT_BAYONET.stemDiameter * ps) / 2 -
        Math.hypot(local[0], local[2]) -
        tolerance;
      const lugCenter = local[1] + DEFAULT_BAYONET.lugCenterY * py;
      const channelCenter =
        ((DEFAULT_BAYONET.slotBottom + DEFAULT_BAYONET.slotTop) / 2) * sy;
      const axial =
        ((DEFAULT_BAYONET.slotTop - DEFAULT_BAYONET.slotBottom) * sy) / 2 -
        (DEFAULT_BAYONET.lugHeight * py) / 2 -
        Math.abs(lugCenter - channelCenter) -
        tolerance;
      const seated = Math.abs(lugCenter - channelCenter) <= 0.3 * sy;
      const lock = seated && Math.abs(yaw - DEFAULT_BAYONET.lockAngle) <= 1;
      const lugHalfWidth = (DEFAULT_BAYONET.lugWidth * ps) / 2;
      const boreApothem =
        (num(socket, "holeDiameter", DEFAULT_BAYONET.holeDiameter * ss) / 2) *
        Math.cos(2.5 * RAD);
      const effectiveRoot = Math.max(
        DEFAULT_BAYONET.lugRootRadius * ps,
        Math.sqrt(
          Math.max(0, boreApothem * boreApothem - lugHalfWidth * lugHalfWidth),
        ),
      );
      const angularMargin =
        (seated
          ? Math.min(
              yaw + DEFAULT_BAYONET.entryHalfAngle,
              DEFAULT_BAYONET.slotEndAngle - yaw,
            )
          : DEFAULT_BAYONET.entryHalfAngle - Math.abs(yaw)) * RAD;
      const tangential =
        effectiveRoot * Math.sin(angularMargin) -
        lugHalfWidth * Math.cos(angularMargin) -
        Math.hypot(local[0], local[2]) -
        tolerance;
      const engaged =
        lugCenter - (DEFAULT_BAYONET.lugHeight * py) / 2 <
        socket.size[1] / 2 - EPS;
      const retention =
        DEFAULT_BAYONET.lugOuterRadius * ps -
        num(socket, "holeDiameter", DEFAULT_BAYONET.holeDiameter * ss) / 2 -
        tolerance;
      const entryMargin =
        (DEFAULT_BAYONET.entryHalfAngle - Math.abs(yaw)) * RAD;
      const entryClearance =
        effectiveRoot * Math.sin(entryMargin) -
        lugHalfWidth * Math.cos(entryMargin) -
        Math.hypot(local[0], local[2]) -
        tolerance;
      // The full-height entrance remains open axially; its lugs need not fit the horizontal track yet.
      const inEntryCorridor = entryClearance >= -EPS;
      const gap = Math.min(
        radial,
        seated && !inEntryCorridor ? axial : Infinity,
        engaged ? tangential : Infinity,
        retention,
      );
      clearance = clearance === null ? gap : Math.min(clearance, gap);
      issues.push(
        issue(
          `bayonet-fit-${socket.id}-${peg.id}`,
          gap < -EPS ? "error" : aligned ? "pass" : "warning",
          gap < -EPS
            ? "旋锁最坏公差不足"
            : lock
              ? "旋锁已进入保持区"
              : seated
                ? "旋锁已到转动槽"
                : "旋锁入口对齐检查",
          `${peg.name} → ${socket.name}；相对转角 ${yaw.toFixed(2)}°；轴孔最坏单侧余隙 ${radial.toFixed(3)} mm${seated ? `，槽高最坏单侧余隙 ${axial.toFixed(3)} mm` : ""}${engaged ? `，入口/槽端保守余隙 ${tangential.toFixed(3)} mm` : ""}。${lock ? "名义45°保持姿态；上拔由槽顶实体阻挡，不含弹性防松。" : "先沿Y插到底，再绕局部Y旋转+45°。"}${aligned ? "" : "轴线偏斜，请重新对齐。"}`,
          [socket.id, peg.id],
          "fit",
        ),
      );
    }
  return { issues, clearance };
}

export function validateAssembly(parts: Part[]): Validation {
  const issues: Issue[] = [],
    collisionPairs: [string, string][] = [];
  const valid = parts.filter((p) => !invalid(p));
  for (const p of parts) {
    if (invalid(p)) {
      issues.push(
        issue(
          `invalid-${p.id}`,
          "error",
          "无效尺寸或坐标",
          `${p.name} 的尺寸须为正数，所有数值须有限。`,
          [p.id],
        ),
      );
      continue;
    }
    issues.push(...bayonetParameterIssues(p));
    if (num(p, "tolerance", 0.05) < 0)
      issues.push(
        issue(
          `tolerance-${p.id}`,
          "error",
          "尺寸公差无效",
          "尺寸的 ± 公差必须为非负数。",
          [p.id],
          "fit",
        ),
      );
    if (
      p.kind === "mortise" &&
      (num(p, "innerWidth", p.size[0] * 0.52) <= 0 ||
        num(p, "innerWidth", p.size[0] * 0.52) >= p.size[0] ||
        num(p, "innerDepth", p.size[2] * 0.52) <= 0 ||
        num(p, "innerDepth", p.size[2] * 0.52) >= p.size[2])
    )
      issues.push(
        issue(
          `hole-${p.id}`,
          "error",
          "孔尺寸超出实体",
          "贯穿孔尺寸必须大于零且小于外轮廓。",
          [p.id],
        ),
      );
    if (
      p.kind === "sleeve" &&
      (num(p, "holeDiameter", p.size[0] * 0.6) <= 0 ||
        num(p, "holeDiameter", p.size[0] * 0.6) >= p.size[0])
    )
      issues.push(
        issue(
          `hole-${p.id}`,
          "error",
          "孔径超出实体",
          "内孔直径必须大于零且小于外径。",
          [p.id],
        ),
      );
    if (
      ["pin", "sleeve"].includes(p.kind) &&
      Math.abs(p.size[0] - p.size[2]) > EPS
    ) {
      issues.push(
        issue(
          `diameter-${p.id}`,
          "error",
          "圆柱外径不一致",
          `${p.name} 的宽度和深度必须相等，均表示外径。`,
          [p.id],
        ),
      );
    }
    const minY = floorHeight(p);
    if (minY < -EPS)
      issues.push(
        issue(
          `floor-${p.id}`,
          "error",
          "穿入工作台",
          `${p.name} 低于工作台 ${(-minY).toFixed(3)} mm。`,
          [p.id],
        ),
      );
    if (p.kind === "spring" || p.kind === "button") {
      const travel = num(p, "travel", 1),
        compression = num(p, "compression", 0),
        stiffness = num(p, "stiffness", 1),
        free = num(p, "freeLength", p.size[1]),
        solid = num(p, "solidLength", 0);
      if (
        travel <= 0 ||
        stiffness <= 0 ||
        num(p, "mass", 0.02) <= 0 ||
        num(p, "damping", 0.8) < 0 ||
        free <= solid ||
        compression < 0 ||
        compression > travel ||
        travel > free - solid ||
        num(p, "trigger", 0.6) > travel
      )
        issues.push(
          issue(
            `spring-${p.id}`,
            "error",
            "行程或弹簧参数无效",
            `${p.name}：检查触发行程、压缩量、并圈高度、质量和刚度。`,
            [p.id],
            "physics",
          ),
        );
      if (p.kind === "spring")
        issues.push(
          issue(
            `spring-contact-${p.id}`,
            "warning",
            "弹簧接触待实物校验",
            "按轴向线性弹簧求解；未计算簧圈接触、侧向屈曲和疲劳。独立弹簧未参与实体碰撞判定。",
            [p.id],
            "physics",
          ),
        );
    }
  }
  const allSolids = new Map(valid.map((p) => [p.id, solids(p)]));
  for (let i = 0; i < valid.length; i++)
    for (let j = i + 1; j < valid.length; j++) {
      const a = valid[i],
        b = valid[j];
      if (a.kind === "asset" || b.kind === "asset") {
        if (separatingGap(box(a), box(b)) < -EPS)
          issues.push(
            issue(
              `proxy-${a.id}-${b.id}`,
              "warning",
              "原始模型包围盒相交",
              `${a.name} / ${b.name}：可能为正常嵌套；需网格精检，不能据此判为实体干涉。`,
              [a.id, b.id],
            ),
          );
      } else if (collision(a, b, allSolids.get(a.id)!, allSolids.get(b.id)!)) {
        collisionPairs.push([a.id, b.id]);
        issues.push(
          issue(
            `collision-${a.id}-${b.id}`,
            "error",
            "实体干涉",
            `${a.name} 与 ${b.name} 相交。方体使用旋转 SAT，圆形异轴接触使用 16 边保守代理。`,
            [a.id, b.id],
          ),
        );
      }
    }
  if (parts.some((p) => p.kind === "asset"))
    issues.push(
      issue(
        "asset-accuracy",
        "warning",
        "原始资产仅作包围盒预检",
        "导入模型未经过精确网格碰撞、材料与关节标定；当前结果不能作为制造通过结论。",
        parts.filter((p) => p.kind === "asset").map((p) => p.id),
      ),
    );
  const fit = fitIssues(valid);
  issues.push(...fit.issues);
  if (!issues.some((i) => i.category === "geometry" && i.severity === "error"))
    issues.push(
      issue(
        "geometry-pass",
        "pass",
        "参数化实体无干涉",
        "已检查工作台与参数化刚体；圆形异轴接触为保守近似，资产与独立弹簧详见提示。",
        [],
        "geometry",
      ),
    );
  return { issues, collisionPairs, minClearance: fit.clearance };
}

/** Samples the full edit path at <=0.25 mm maximum vertex travel; this is not continuous CCD. */
export function validateMotion(
  parts: Part[],
  id: string,
  next: Part,
): MotionResult {
  const current = parts.find((p) => p.id === id);
  if (!current)
    return {
      allowed: false,
      issues: [
        issue("missing-part", "error", "零件不存在", "请重新选择零件。", [id]),
      ],
    };
  if (current.fixed)
    return {
      allowed: false,
      issues: [
        issue(
          `fixed-${id}`,
          "error",
          "零件已固定",
          "先解除固定再进行移动或旋转。",
          [id],
        ),
      ],
    };
  if (invalid(next))
    return {
      allowed: false,
      issues: [
        issue(
          `invalid-${id}`,
          "error",
          "无效尺寸或坐标",
          "尺寸须为有限正数，位置与旋转须为有限数。",
          [id],
        ),
      ],
    };
  const distance = length(sub(next.position, current.position));
  const angleTravel =
    (next.rotation.reduce(
      (s, v, i) => s + Math.abs(v - current.rotation[i]) * RAD,
      0,
    ) *
      Math.max(length(next.size), length(current.size))) /
    2;
  const sizeTravel = length(sub(next.size, current.size)) / 2;
  const count = Math.max(
    1,
    Math.ceil((distance + angleTravel + sizeTravel) / 0.25),
  );
  if (count > 20000)
    return {
      allowed: false,
      issues: [
        issue(
          "motion-too-large",
          "error",
          "单次操作范围过大",
          "请减小移动或旋转步长以完成路径校验。",
          [id],
        ),
      ],
    };
  const others = parts.filter((p) => p.id !== id && !invalid(p));
  const othersSolids = new Map(others.map((p) => [p.id, solids(p)]));
  const initialCollisions = new Set(
    others
      .filter((p) =>
        collision(current, p, solids(current), othersSolids.get(p.id)!),
      )
      .map((p) => p.id),
  );
  const initialFloor = floorHeight(current);
  for (let i = 1; i <= count; i++) {
    const t = i / count;
    const candidate: Part = {
      ...next,
      position: current.position.map(
        (v, k) => v + (next.position[k] - v) * t,
      ) as Vec3,
      rotation: current.rotation.map(
        (v, k) => v + (next.rotation[k] - v) * t,
      ) as Vec3,
      size: current.size.map((v, k) => v + (next.size[k] - v) * t) as Vec3,
    };
    const candidateSolids = solids(candidate);
    const minY = floorHeight(candidate, candidateSolids);
    if (minY < Math.min(0, initialFloor) - EPS)
      return {
        allowed: false,
        issues: [
          issue(
            `floor-${id}`,
            "error",
            "移动受阻：工作台",
            "操作路径将穿入工作台。",
            [id],
          ),
        ],
      };
    for (const other of others) {
      const hits = collision(
        candidate,
        other,
        candidateSolids,
        othersSolids.get(other.id)!,
      );
      // Let an already invalid assembly be separated, but never re-enter a contact once cleared.
      if (!hits) initialCollisions.delete(other.id);
      if (hits && (!initialCollisions.has(other.id) || i === count))
        return {
          allowed: false,
          issues: [
            issue(
              `blocked-${id}-${other.id}`,
              "error",
              "移动受阻：实体干涉",
              `${other.name} 阻挡操作路径（路径 ${(t * 100).toFixed(0)}%，采样 ≤0.25 mm）。`,
              [id, other.id],
            ),
          ],
        };
    }
  }
  const final = validateAssembly(parts.map((p) => (p.id === id ? next : p)));
  const blocking = final.issues.filter(
    (i) => i.severity === "error" && i.partIds.includes(id),
  );
  return {
    allowed: blocking.length === 0,
    issues: blocking.length
      ? blocking
      : final.issues.filter(
          (i) => i.partIds.includes(id) && i.severity !== "pass",
        ),
  };
}

function linearSolve(matrix: number[][], rhs: number[]): number[] | null {
  const a = matrix.map((row, i) => [...row, rhs[i]]),
    n = rhs.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++)
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const value = a[col][col];
    for (let k = col; k <= n; k++) a[col][k] /= value;
    for (let row = 0; row < n; row++)
      if (row !== col) {
        const factor = a[row][col];
        for (let k = col; k <= n; k++) a[row][k] -= factor * a[col][k];
      }
  }
  return a.map((row) => row[n]);
}

/** DC modified nodal analysis: ideal wires/switches/sources, resistive lamps and resistors. */
export function solveCircuit(
  parts: Part[],
  wires: Wire[],
  pressedIds: string[],
): CircuitResult {
  const issues: Issue[] = [],
    poweredLampIds: string[] = [];
  const electrical = parts.filter((p) =>
    ["battery", "lamp", "resistor", "button"].includes(p.kind),
  );
  const byId = new Map(electrical.map((p) => [p.id, p]));
  const parent = new Map<string, string>();
  const key = (id: string, terminal: number) => `${id}:${terminal}`;
  for (const p of electrical)
    for (const t of [0, 1]) parent.set(key(p.id, t), key(p.id, t));
  const root = (v: string): string => {
    let r = v;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const union = (a: string, b: string) => parent.set(root(a), root(b));
  for (const wire of wires) {
    if (
      !byId.has(wire.from.partId) ||
      !byId.has(wire.to.partId) ||
      ![0, 1].includes(wire.from.terminal) ||
      ![0, 1].includes(wire.to.terminal)
    ) {
      issues.push(
        issue(
          `wire-${wire.id}`,
          "error",
          "导线端点无效",
          "导线必须接到电源、开关、灯或电阻的有效端子。",
          [wire.from.partId, wire.to.partId],
          "circuit",
        ),
      );
      continue;
    }
    union(
      key(wire.from.partId, wire.from.terminal),
      key(wire.to.partId, wire.to.terminal),
    );
  }
  for (const p of electrical.filter(
    (p) => p.kind === "button" && pressedIds.includes(p.id),
  ))
    union(key(p.id, 0), key(p.id, 1));
  const endpoints = (p: Part) => [root(key(p.id, 0)), root(key(p.id, 1))];
  const sources = electrical.filter((p) => p.kind === "battery");
  const loads = electrical
    .filter((p) => p.kind === "lamp" || p.kind === "resistor")
    .filter((p) => {
      const resistance = num(p, "resistance", p.kind === "lamp" ? 100 : 220);
      if (!Number.isFinite(resistance) || resistance <= 0) {
        issues.push(
          issue(
            `resistance-${p.id}`,
            "error",
            "负载阻值无效",
            "直流阻性负载的电阻必须大于零。",
            [p.id],
            "circuit",
          ),
        );
        return false;
      }
      return true;
    });
  let shortCircuit = false,
    current = 0;
  for (const source of sources)
    if (endpoints(source)[0] === endpoints(source)[1]) {
      shortCircuit = true;
      issues.push(
        issue(
          `short-${source.id}`,
          "error",
          "电源短路",
          `${source.name} 的正负端通过理想导线或闭合开关直接连通。`,
          [source.id],
          "circuit",
        ),
      );
    }
  const voltage = sources.length ? num(sources[0], "voltage", 5) : 0;
  if (!sources.length)
    issues.push(
      issue(
        "no-source",
        "warning",
        "尚未接入电源",
        "添加电源并把正负端接入负载回路。",
        [],
        "circuit",
      ),
    );
  const adjacency = new Map<string, Set<string>>();
  for (const p of [...sources, ...loads]) {
    const [a, b] = endpoints(p);
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a)!.add(b);
    adjacency.get(b)!.add(a);
  }
  const visited = new Set<string>();
  for (const first of sources) {
    const start = endpoints(first)[0];
    if (visited.has(start)) continue;
    const component = new Set<string>(),
      queue = [start];
    while (queue.length) {
      const node = queue.pop()!;
      if (component.has(node)) continue;
      component.add(node);
      visited.add(node);
      queue.push(...(adjacency.get(node) ?? []));
    }
    const batteries = sources.filter((p) => component.has(endpoints(p)[0]));
    if (batteries.some((p) => endpoints(p)[0] === endpoints(p)[1])) continue;
    if (
      batteries.some(
        (p) =>
          !Number.isFinite(num(p, "voltage", 5)) || num(p, "voltage", 5) <= 0,
      )
    ) {
      issues.push(
        issue(
          "source-voltage",
          "error",
          "电源电压无效",
          "电压必须是有限正数。",
          batteries.map((p) => p.id),
          "circuit",
        ),
      );
      continue;
    }
    const ground = endpoints(batteries[0])[1],
      nodes = [...component].filter((n) => n !== ground),
      indices = new Map(nodes.map((n, i) => [n, i]));
    const n = nodes.length,
      total = n + batteries.length;
    const matrix = Array.from(
        { length: total },
        () => Array(total).fill(0) as number[],
      ),
      rhs = Array(total).fill(0) as number[];
    const activeLoads = loads.filter((p) => component.has(endpoints(p)[0]));
    for (const p of activeLoads) {
      const [a, b] = endpoints(p),
        ia = indices.get(a),
        ib = indices.get(b),
        g = 1 / num(p, "resistance", p.kind === "lamp" ? 100 : 220);
      if (ia !== undefined) matrix[ia][ia] += g;
      if (ib !== undefined) matrix[ib][ib] += g;
      if (ia !== undefined && ib !== undefined) {
        matrix[ia][ib] -= g;
        matrix[ib][ia] -= g;
      }
    }
    batteries.forEach((p, i) => {
      const [a, b] = endpoints(p),
        ia = indices.get(a),
        ib = indices.get(b);
      if (ia !== undefined) {
        matrix[ia][n + i] += 1;
        matrix[n + i][ia] += 1;
      }
      if (ib !== undefined) {
        matrix[ib][n + i] -= 1;
        matrix[n + i][ib] -= 1;
      }
      rhs[n + i] = num(p, "voltage", 5);
    });
    const solution = linearSolve(matrix, rhs);
    if (!solution) {
      issues.push(
        issue(
          `unsolved-${first.id}`,
          "error",
          "电源连接约束冲突",
          "理想电源并联或回路约束无法唯一求解；请检查电源方向与连接。",
          batteries.map((p) => p.id),
          "circuit",
        ),
      );
      continue;
    }
    const componentCurrent = batteries.reduce(
      (sum, _, i) => sum + Math.abs(solution[n + i]),
      0,
    );
    current += componentCurrent;
    const potential = (node: string) =>
      node === ground ? 0 : solution[indices.get(node)!];
    for (const p of activeLoads.filter((p) => p.kind === "lamp")) {
      const [a, b] = endpoints(p),
        across = Math.abs(potential(a) - potential(b));
      if (across > 1e-4) poweredLampIds.push(p.id);
      if (across > num(p, "voltage", 6) * 1.1)
        issues.push(
          issue(
            `overvoltage-${p.id}`,
            "warning",
            "灯具超过额定电压",
            `${p.name} 两端 ${across.toFixed(2)} V，额定 ${num(p, "voltage", 6).toFixed(2)} V。`,
            [p.id],
            "circuit",
          ),
        );
    }
    if (componentCurrent < 1e-7)
      issues.push(
        issue(
          `open-${first.id}`,
          "warning",
          "回路断开 / 无负载电流",
          "检查负载两端、回路线与开关状态。",
          batteries.map((p) => p.id),
          "circuit",
        ),
      );
    else
      issues.push(
        issue(
          `circuit-${first.id}`,
          "pass",
          "直流回路导通",
          `总电源支路电流 ${(componentCurrent * 1000).toFixed(2)} mA；灯按阻性负载求解。`,
          batteries.map((p) => p.id),
          "circuit",
        ),
      );
  }
  return { poweredLampIds, current, voltage, shortCircuit, issues };
}

/** Implicit Euler; x in mm, velocity mm/s, k N/mm, c N·s/m, mass kg. */
export function stepSpring(
  state: SpringState,
  dt: number,
  params: {
    stiffness: number;
    damping: number;
    mass: number;
    travel: number;
    force: number;
  },
): SpringState {
  const { stiffness: k, damping: c, mass: m, travel, force } = params;
  if (
    ![dt, k, c, m, travel, force, state.displacement, state.velocity].every(
      Number.isFinite,
    ) ||
    dt <= 0 ||
    k <= 0 ||
    c < 0 ||
    m <= 0 ||
    travel < 0
  )
    return { ...state };
  const steps = Math.max(1, Math.min(2400, Math.ceil(dt * 240))),
    h = dt / steps;
  let x = Math.max(0, Math.min(travel, state.displacement)),
    v = state.velocity;
  for (let i = 0; i < steps; i++) {
    const next =
      (x * (1 + (h * c) / m) + h * v + (h * h * force * 1000) / m) /
      (1 + (h * c) / m + (h * h * k * 1000) / m);
    v = (next - x) / h;
    x = next;
    if (x <= 0) {
      x = 0;
      v = Math.max(0, v);
    }
    if (x >= travel) {
      x = travel;
      v = Math.min(0, v);
    }
  }
  return { displacement: x, velocity: v, force: k * x };
}
