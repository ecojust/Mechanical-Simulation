/** Reproduce entry, rotation, axial retention and removal against the shared physical solids. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  bayonetFixture,
  DEFAULT_BAYONET,
  BAYONET_POSES,
} from "../src/engine/bayonet";
import { bayonetDemoProject } from "../src/catalog";
import { validateAssembly, validateMotion } from "../src/engine/physics";
import type { Part, Vec3 } from "../src/types";
const { pin, socket } = bayonetFixture();
const seated: Part = { ...pin, position: [0, 18, 0] },
  locked: Part = { ...seated, rotation: [0, 45, 0] };
function motion(
  name: string,
  from: Part,
  to: Part,
  expectedAllowed: boolean,
  others: Part[] = [socket],
) {
  const start = performance.now();
  const result = validateMotion([...others, from], from.id, to);
  return {
    name,
    expectedAllowed,
    allowed: result.allowed,
    passed: result.allowed === expectedAllowed,
    elapsedMilliseconds: Number((performance.now() - start).toFixed(3)),
    from: { position: from.position, rotation: from.rotation },
    to: { position: to.position, rotation: to.rotation },
    issues: result.issues,
  };
}
const checks = [
  motion("沿入口轴向插到底", pin, seated, true),
  motion("到底后正向旋转45°", seated, locked, true),
  motion(
    "锁住后上拔1mm必须受阻",
    locked,
    { ...locked, position: [0, 19, 0] },
    false,
  ),
  motion("反向旋回入口0°", locked, seated, true),
  motion(
    "对齐入口后完全退出（轴尖离孔口1mm）",
    seated,
    {
      ...pin,
      position: [0, socket.position[1] + BAYONET_POSES.withdrawnOffset, 0],
    },
    true,
  ),
  motion(
    "未插到底不能旋转45°",
    { ...pin, position: [0, 25, 0] },
    { ...pin, position: [0, 25, 0], rotation: [0, 45, 0] },
    false,
  ),
  motion(
    "错开45°不能轴向插入",
    { ...pin, rotation: [0, 45, 0] },
    locked,
    false,
  ),
  motion(
    "到底后不能反向旋到-45°",
    seated,
    { ...seated, rotation: [0, -45, 0] },
    false,
  ),
  motion(
    "超过槽末端不能旋到70°",
    locked,
    { ...locked, rotation: [0, 70, 0] },
    false,
  ),
];
const lockedValidation = validateAssembly([socket, locked]);
if (lockedValidation.issues.some((i) => i.severity === "error"))
  throw Error("Locked pose has validation errors");
if (
  lockedValidation.minClearance === null ||
  lockedValidation.minClearance < 0.19
)
  throw Error("Nominal worst-case clearance below expected 0.19 mm");
const project = bayonetDemoProject();
const demoPin = project.parts.find((p) => p.kind === "bayonet-pin")!;
const demoSocket = project.parts.find((p) => p.kind === "bayonet-socket")!;
const demoSeated = {
  ...demoPin,
  position: [
    demoSocket.position[0],
    demoSocket.position[1] + BAYONET_POSES.seatedOffset,
    demoSocket.position[2],
  ] as Vec3,
};
const performanceCheck = motion(
  "完整默认装配中的插入路径",
  demoPin,
  demoSeated,
  true,
  project.parts.filter((p) => p.id !== demoPin.id),
);
let geometrySha256: string | null = null;
try {
  geometrySha256 = createHash("sha256")
    .update(readFileSync("assets/bayonet/geometry.json"))
    .digest("hex");
} catch {
  /* Geometry export is independently reproducible. */
}
const output = {
  version: 1,
  generatedAt: new Date().toISOString(),
  scope:
    "Parameterized two-lug bayonet only; does not certify the old pureTV controller meshes.",
  units: { length: "mm", rotation: "degrees" },
  geometrySha256,
  nominal: DEFAULT_BAYONET,
  poses: BAYONET_POSES,
  fixture: { pin, socket },
  methods: {
    geometry:
      "Shared faceted convex solids (166 socket prisms, 4 pin solids); rendering and collision use the same vertices.",
    collision:
      "Full separating-axis theorem with face normals and edge cross products; no bayonet-pair collision exemption.",
    path: "All intermediate poses sampled with maximum estimated vertex travel <=0.25 mm; finite sampling is not a continuous-collision proof.",
    tolerance:
      "Each dimensional ±0.1 mm tolerance is combined on full widths and halved for one-sided fit. Faceted bore uses its inscribed apothem for conservative radial clearance; clipped lug corners also bound entry/channel-end tangential clearance.",
  },
  results: {
    passed: checks.filter((c) => c.passed).length,
    total: checks.length,
    allPassed: checks.every((c) => c.passed) && performanceCheck.passed,
    minWorstCaseOneSidedClearanceMm: lockedValidation.minClearance,
    checks,
    lockedValidation,
    performanceCheck,
  },
  limitations: [
    "45° is a nominal axial-retention position. A few degrees of rotational clearance remain; no friction detent or elastic anti-loosening latch is simulated.",
    "Check printer/material shrinkage, actual force, wear and repeated insertion on a physical sample before manufacture.",
    "No finite element stress, friction contact, deformation, surface roughness or fatigue analysis.",
    "Sampled path checks cannot guarantee detection of arbitrary sub-0.25 mm obstacles.",
  ],
};
mkdirSync("docs", { recursive: true });
writeFileSync(
  "docs/bayonet-verification.json",
  JSON.stringify(output, null, 2) + "\n",
);
console.log(
  `Bayonet verification: ${output.results.passed}/${checks.length} passed; one-sided worst-case clearance ${lockedValidation.minClearance.toFixed(6)} mm; full-scene insertion ${performanceCheck.elapsedMilliseconds} ms.`,
);
if (!output.results.allPassed) throw Error("Bayonet verification failed");
