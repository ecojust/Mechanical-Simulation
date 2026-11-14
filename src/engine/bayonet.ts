import type { Issue, Part, Vec3 } from "../types";

/** All coordinates are mm, Y is the insertion axis, and positive yaw moves +Z toward +X. */
export const DEFAULT_BAYONET = Object.freeze({
  stemDiameter: 9,
  holeDiameter: 9.6,
  lugWidth: 2.6,
  lugHeight: 2,
  lugRootRadius: 4.1,
  lugOuterRadius: 8,
  lugCenterY: -8,
  slotBottom: -4.3,
  slotTop: -1.7,
  entryHalfAngle: 20,
  slotEndAngle: 65,
  lockAngle: 45,
  tolerance: 0.1,
  angularSegment: 5,
});
export const BAYONET_PIN_SIZE: Vec3 = [16, 24, 16];
export const BAYONET_SOCKET_SIZE: Vec3 = [24, 18, 24];
export const BAYONET_POSES = Object.freeze({
  entryOffset: 19,
  withdrawnOffset: 22,
  seatedOffset: 5,
  lockAngle: 45,
});
export interface BayonetSolid {
  vertices: Vec3[];
  faces: number[][];
  role: "stem" | "lug" | "socket";
}
const DEG = Math.PI / 180;
function prism(
  polygon: [number, number][],
  bottom: number,
  top: number,
  role: BayonetSolid["role"],
): BayonetSolid {
  const n = polygon.length;
  const vertices: Vec3[] = [
    ...polygon.map(([x, z]): Vec3 => [x, bottom, z]),
    ...polygon.map(([x, z]): Vec3 => [x, top, z]),
  ];
  const faces = [
    Array.from({ length: n }, (_, i) => n - 1 - i),
    Array.from({ length: n }, (_, i) => n + i),
  ];
  for (let i = 0; i < n; i++)
    faces.push([i, (i + 1) % n, ((i + 1) % n) + n, i + n]);
  return { vertices, faces, role };
}
function circle(radius: number, sides = 32): [number, number][] {
  return Array.from({ length: sides }, (_, i) => [
    Math.sin((i * 2 * Math.PI) / sides) * radius,
    Math.cos((i * 2 * Math.PI) / sides) * radius,
  ]);
}
function annulusSegment(
  inner: number,
  outer: number,
  start: number,
  end: number,
  bottom: number,
  top: number,
): BayonetSolid {
  const a = start * DEG,
    b = end * DEG;
  return prism(
    [
      [inner * Math.sin(a), inner * Math.cos(a)],
      [outer * Math.sin(a), outer * Math.cos(a)],
      [outer * Math.sin(b), outer * Math.cos(b)],
      [inner * Math.sin(b), inner * Math.cos(b)],
    ],
    bottom,
    top,
    "socket",
  );
}
function leadInStem(radius: number): BayonetSolid {
  const polygon = circle(radius),
    n = polygon.length;
  const vertices: Vec3[] = [-12, -10, 12].flatMap((y, index) =>
    polygon.map(([x, z]): Vec3 => [
      x * (index === 0 ? 0.88 : 1),
      y,
      z * (index === 0 ? 0.88 : 1),
    ]),
  );
  const faces = [
    Array.from({ length: n }, (_, i) => n - 1 - i),
    Array.from({ length: n }, (_, i) => 2 * n + i),
  ];
  for (let ring = 0; ring < 2; ring++)
    for (let i = 0; i < n; i++)
      faces.push([
        ring * n + i,
        ring * n + ((i + 1) % n),
        (ring + 1) * n + ((i + 1) % n),
        (ring + 1) * n + i,
      ]);
  return { vertices, faces, role: "stem" };
}
/** These are the actual faceted solids, shared by rendering, SAT and the source/STL exporter. */
export function bayonetSolids(part: Part): BayonetSolid[] {
  const pin = part.kind === "bayonet-pin";
  const nominal = pin ? BAYONET_PIN_SIZE : BAYONET_SOCKET_SIZE;
  const scale = part.size.map((v, i) => v / nominal[i]);
  const solids: BayonetSolid[] = [];
  if (pin) {
    solids.push(leadInStem(DEFAULT_BAYONET.stemDiameter / 2));
    solids.push(prism(circle(8), 10, 12, "stem")); // twist grip; also makes size the actual outer envelope
    for (const sign of [-1, 1]) {
      const lo = sign === 1 ? 4.1 : -8,
        hi = sign === 1 ? 8 : -4.1;
      solids.push(
        prism(
          [
            [-1.3, lo],
            [-1.3, hi],
            [1.3, hi],
            [1.3, lo],
          ],
          -9,
          -7,
          "lug",
        ),
      );
    }
  } else {
    const hole =
      typeof part.params.holeDiameter === "number"
        ? part.params.holeDiameter / scale[0]
        : DEFAULT_BAYONET.holeDiameter;
    const inner = Math.max(0.01, Math.min(11.99, hole / 2));
    const layers: [number, number, number, number][] = [
      [-9, -4.3, 0, 0],
      [-4.3, -1.7, -20, 65],
      [-1.7, 9, -20, 20],
    ];
    for (const [bottom, top, gapStart, gapEnd] of layers)
      for (let angle = -20; angle < 340; angle += 5) {
        const local = ((angle + 20) % 180) - 20;
        if (gapStart !== gapEnd && local >= gapStart && local < gapEnd)
          continue;
        solids.push(annulusSegment(inner, 12, angle, angle + 5, bottom, top));
      }
  }
  return solids.map((s) => ({
    ...s,
    vertices: s.vertices.map((v) => v.map((n, i) => n * scale[i]) as Vec3),
  }));
}
export function bayonetParameterIssues(part: Part): Issue[] {
  if (!["bayonet-pin", "bayonet-socket"].includes(part.kind)) return [];
  const nominal =
    part.kind === "bayonet-pin" ? BAYONET_PIN_SIZE : BAYONET_SOCKET_SIZE;
  const ratio = part.size.map((v, i) => v / nominal[i]);
  const issues: Issue[] = [];
  if (Math.abs(ratio[0] - ratio[2]) > 1e-6)
    issues.push({
      id: `bayonet-round-${part.id}`,
      severity: "error",
      title: "旋锁径向尺寸不一致",
      detail:
        "旋锁件宽、深必须相等；整体缩放可改变配合，请重新运行插入与旋转路径检查。",
      category: "geometry",
      partIds: [part.id],
    });
  const hole =
    typeof part.params.holeDiameter === "number"
      ? part.params.holeDiameter
      : DEFAULT_BAYONET.holeDiameter * ratio[0];
  if (part.kind === "bayonet-socket" && (hole <= 0 || hole >= part.size[0]))
    issues.push({
      id: `bayonet-hole-${part.id}`,
      severity: "error",
      title: "旋锁孔径无效",
      detail: "母件孔径必须大于零且小于外径。",
      category: "geometry",
      partIds: [part.id],
    });
  return issues;
}
/** Stable fixture used by the UI, report generator, and CAD export. */
export function bayonetFixture(): { pin: Part; socket: Part } {
  const common = {
    rotation: [0, 0, 0] as Vec3,
    visible: true,
    params: { tolerance: DEFAULT_BAYONET.tolerance },
  };
  return {
    socket: {
      ...common,
      id: "bayonet-socket",
      name: "母件 · L 槽旋锁座",
      kind: "bayonet-socket",
      position: [0, 13, 0],
      size: [...BAYONET_SOCKET_SIZE],
      fixed: true,
      color: "#c69961",
      params: { ...common.params, holeDiameter: DEFAULT_BAYONET.holeDiameter },
    },
    pin: {
      ...common,
      id: "bayonet-pin",
      name: "公件 · 双耳旋锁销",
      kind: "bayonet-pin",
      position: [0, 32, 0],
      size: [...BAYONET_PIN_SIZE],
      fixed: false,
      color: "#6288a8",
    },
  };
}
