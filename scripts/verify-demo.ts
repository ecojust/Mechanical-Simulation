/** Reproduce the delivered parameterized assembly checks: npx vite-node scripts/verify-demo.ts */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { demoProject } from "../src/catalog";
import {
  solveCircuit,
  stepSpring,
  validateAssembly,
  validateMotion,
} from "../src/engine/physics";
import type { Part, SpringState, Vec3 } from "../src/types";

const project = demoProject();
const stableIds = new Map(project.parts.map((p) => [p.id, `demo-${p.kind}`]));
project.parts = project.parts.map((p) => ({ ...p, id: stableIds.get(p.id)! }));
project.wires = project.wires.map((w, i) => ({
  ...w,
  id: `demo-wire-${i + 1}`,
  from: { ...w.from, partId: stableIds.get(w.from.partId)! },
  to: { ...w.to, partId: stableIds.get(w.to.partId)! },
}));
const tenon = project.parts.find((p) => p.kind === "tenon")!;
const button = project.parts.find((p) => p.kind === "button")!;
const lamp = project.parts.find((p) => p.kind === "lamp")!;
const staticValidation = validateAssembly(project.parts);
const inserted: Part = { ...tenon, position: [-18, 23, 0] };
const insertMotion = validateMotion(project.parts, tenon.id, inserted);
const insertedParts = project.parts.map((p) =>
  p.id === tenon.id ? inserted : p,
);
const insertedValidation = validateAssembly(insertedParts);
const lateralTarget: Vec3 = [30, 23, 0];
const lateralMotion = validateMotion(insertedParts, tenon.id, {
  ...inserted,
  position: lateralTarget,
});
const rotationTarget: Vec3 = [0, 45, 0];
const rotationalMotion = validateMotion(insertedParts, tenon.id, {
  ...inserted,
  rotation: rotationTarget,
});
const openCircuit = solveCircuit(project.parts, project.wires, []);
const closedCircuit = solveCircuit(project.parts, project.wires, [button.id]);

const springParameters = {
  stiffness: Number(button.params.stiffness),
  damping: Number(button.params.damping),
  mass: Number(button.params.mass),
  travel: Number(button.params.travel),
};
const trigger = Number(button.params.trigger),
  pressForce = springParameters.stiffness * springParameters.travel * 1.1;
let state: SpringState = { displacement: 0, velocity: 0, force: 0 };
let peak = 0,
  firstTriggerTime: number | null = null,
  firstReleasedTime: number | null = null;
const samples: {
  timeSeconds: number;
  appliedForceN: number;
  displacementMm: number;
  velocityMmPerS: number;
  restoringForceN: number;
  switchClosed: boolean;
  lampPowered: boolean;
  currentA: number;
}[] = [];
const sampleSteps = new Set([1, 12, 24, 120, 240, 252, 264, 480, 1200]);
for (let i = 1; i <= 1200; i++) {
  const appliedForce = i <= 240 ? pressForce : 0;
  state = stepSpring(state, 1 / 240, {
    ...springParameters,
    force: appliedForce,
  });
  peak = Math.max(peak, state.displacement);
  const closed = state.displacement >= trigger;
  if (closed && firstTriggerTime === null) firstTriggerTime = i / 240;
  if (i > 240 && !closed && firstReleasedTime === null)
    firstReleasedTime = i / 240;
  if (sampleSteps.has(i)) {
    const circuit = solveCircuit(
      project.parts,
      project.wires,
      closed ? [button.id] : [],
    );
    samples.push({
      timeSeconds: i / 240,
      appliedForceN: appliedForce,
      displacementMm: state.displacement,
      velocityMmPerS: state.velocity,
      restoringForceN: state.force,
      switchClosed: closed,
      lampPowered: circuit.poweredLampIds.includes(lamp.id),
      currentA: circuit.current,
    });
  }
}
const finalCircuit = solveCircuit(
  project.parts,
  project.wires,
  state.displacement >= trigger ? [button.id] : [],
);
const checks = [
  {
    id: "static-assembly",
    passed: !staticValidation.issues.some((i) => i.severity === "error"),
    expected:
      "No solid interference or invalid dimensions in the default parameterized assembly.",
  },
  {
    id: "tolerance-clearance",
    passed: Math.abs((insertedValidation.minClearance ?? NaN) - 0.1) < 1e-9,
    expected:
      "Worst-case single-side clearance = (12.4 - 0.1 - 12 - 0.1) / 2 = 0.1 mm.",
  },
  {
    id: "insert-tenon",
    passed: insertMotion.allowed,
    expected:
      "Tenon center moves from Y=35 mm to Y=23 mm through the mortise void.",
  },
  {
    id: "reject-through-wall",
    passed: !lateralMotion.allowed,
    expected:
      "The complete lateral path intersects the mortise wall and must be rejected.",
  },
  {
    id: "reject-rotation",
    passed: !rotationalMotion.allowed,
    expected: "A 45 degree turn of the inserted square tenon must be rejected.",
  },
  {
    id: "open-circuit",
    passed:
      openCircuit.current === 0 && openCircuit.poweredLampIds.length === 0,
    expected: "Released switch: zero current and lamp off.",
  },
  {
    id: "closed-circuit",
    passed:
      !closedCircuit.shortCircuit &&
      Math.abs(closedCircuit.current - 0.05) < 1e-9 &&
      closedCircuit.poweredLampIds.includes(lamp.id),
    expected: "Closed switch: 5 V / 100 ohm = 0.05 A and lamp powered.",
  },
  {
    id: "press-trigger",
    passed:
      firstTriggerTime !== null &&
      peak >= trigger &&
      peak <= springParameters.travel,
    expected:
      "Press exceeds the 0.6 mm trigger while respecting the 1 mm travel stop.",
  },
  {
    id: "release-return",
    passed:
      Math.abs(state.displacement) < 0.01 &&
      Math.abs(state.velocity) < 0.01 &&
      finalCircuit.poweredLampIds.length === 0,
    expected:
      "After four seconds released: residual travel <0.01 mm, speed <0.01 mm/s, lamp off.",
  },
];

const report = {
  generatedAt: new Date().toISOString(),
  command: "npx vite-node scripts/verify-demo.ts",
  scope:
    "Default parameterized tenon / mortise / spring-button / DC lamp demo only. This does not validate the original pureTV controller geometry.",
  overallPassed: checks.every((check) => check.passed),
  units: {
    length: "mm",
    angle: "degree",
    stiffness: "N/mm",
    damping: "N·s/m",
    mass: "kg",
    force: "N",
    current: "A",
    voltage: "V",
  },
  methods: {
    geometry:
      "Compound solid boxes, Euler XYZ rotation, separating-axis test; touching faces are contact, not penetration.",
    movement:
      "Discrete path samples at at most 0.25 mm estimated maximum vertex travel. This is not continuous collision detection.",
    clearance:
      "Worst-case single-side fit clearance after both components’ ± dimensional tolerances and lateral offset.",
    dynamics:
      "Implicit Euler, dt=1/240 s, linear spring and damper, hard axial travel limits. 1 s applied press force followed by 4 s release.",
    circuit:
      "Modified nodal analysis of ideal DC sources/wires/switches and resistive loads.",
  },
  limitations: [
    "Nominal spring, switch, tolerance and load parameters have not been calibrated against hardware.",
    "No gravity-driven rigid-body motion, finite elements, friction, deformable contact, spring-coil contact, lateral buckling or fatigue.",
    "Motion sampling may miss features smaller than the sampling interval. Round off-axis contacts use conservative polygon proxies.",
    "Imported Blender assets receive bounding-box prechecks only; nested boxes do not prove an actual solid collision.",
    "Wire diameter, insulation clearance, bend radius, routing interference and solder geometry are not checked.",
    "Lamp is a resistive load; LED nonlinearity, source internal resistance, thermal effects and resistor power limits are not modeled.",
    "Numerical checks are assembly/function prechecks and are not a manufacturing certification.",
  ],
  project,
  checks,
  staticValidation,
  motion: {
    insertion: {
      from: tenon.position,
      to: inserted.position,
      result: insertMotion,
    },
    lateral: {
      from: inserted.position,
      to: lateralTarget,
      result: lateralMotion,
    },
    rotation: {
      from: inserted.rotation,
      to: rotationTarget,
      result: rotationalMotion,
    },
  },
  insertedValidation,
  circuit: {
    released: openCircuit,
    pressed: closedCircuit,
    afterReturn: finalCircuit,
  },
  pressCycle: {
    durationSeconds: 5,
    pressDurationSeconds: 1,
    dtSeconds: 1 / 240,
    parameters: springParameters,
    triggerMm: trigger,
    appliedPressForceN: pressForce,
    maximumCompressionMm: peak,
    firstTriggerSeconds: firstTriggerTime,
    firstReleasedSeconds: firstReleasedTime,
    finalState: state,
    samples,
  },
};
const directory = fileURLToPath(new URL("../docs/", import.meta.url));
mkdirSync(directory, { recursive: true });
writeFileSync(
  `${directory}demo-verification.json`,
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  `Default assembly verification: ${checks.filter((c) => c.passed).length}/${checks.length} passed. Report: docs/demo-verification.json`,
);
if (!report.overallPassed) process.exitCode = 1;
