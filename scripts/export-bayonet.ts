/** Export the exact shared collision/render solids for an editable, reproducible CAD source. */
import { mkdirSync, writeFileSync } from "node:fs";
import {
  bayonetFixture,
  bayonetSolids,
  DEFAULT_BAYONET,
  BAYONET_POSES,
} from "../src/engine/bayonet";
const { pin, socket } = bayonetFixture();
const project = {
  version: 1,
  units: "mm",
  upAxis: "Y",
  rotationUnits: "degrees",
  rotationOrder: "XYZ",
  description:
    "Two-lug insertion-and-twist bayonet; each part is the union of the listed convex solids. Slots are actual empty space.",
  nominal: DEFAULT_BAYONET,
  parts: [socket, pin].map((part) => ({
    ...part,
    solids: bayonetSolids(part),
  })),
  poses: {
    entry: { pin: pin.position, socket: socket.position, rotation: [0, 0, 0] },
    seated: {
      pin: [0, socket.position[1] + BAYONET_POSES.seatedOffset, 0],
      socket: socket.position,
      rotation: [0, 0, 0],
    },
    locked: { pin: [0, 18, 0], socket: socket.position, rotation: [0, 45, 0] },
  },
  meshChecks: [
    {
      name: "entry",
      a: { kind: pin.kind, position: pin.position, rotation: [0, 0, 0] },
      b: { kind: socket.kind, position: socket.position, rotation: [0, 0, 0] },
      expectIntersection: false,
    },
    {
      name: "seated",
      a: { kind: pin.kind, position: [0, 18, 0], rotation: [0, 0, 0] },
      b: { kind: socket.kind, position: socket.position, rotation: [0, 0, 0] },
      expectIntersection: false,
    },
    {
      name: "locked45",
      a: { kind: pin.kind, position: [0, 18, 0], rotation: [0, 45, 0] },
      b: { kind: socket.kind, position: socket.position, rotation: [0, 0, 0] },
      expectIntersection: false,
    },
    {
      name: "locked-pull-1mm",
      a: { kind: pin.kind, position: [0, 19, 0], rotation: [0, 45, 0] },
      b: { kind: socket.kind, position: socket.position, rotation: [0, 0, 0] },
      expectIntersection: true,
    },
    {
      name: "rotate-before-seated",
      a: { kind: pin.kind, position: [0, 25, 0], rotation: [0, 45, 0] },
      b: { kind: socket.kind, position: socket.position, rotation: [0, 0, 0] },
      expectIntersection: true,
    },
  ],
  limitations: [
    "Nominal engineering geometry only; real printed tolerances require calibration.",
    "45° is the target axial retention pose, not a friction detent or anti-loosening certification.",
    "Convex segments must be unioned per part for a watertight manufacturing mesh.",
  ],
};
mkdirSync("assets/bayonet", { recursive: true });
writeFileSync(
  "assets/bayonet/geometry.json",
  JSON.stringify(project, null, 2) + "\n",
);
console.log(
  `Exported shared bayonet geometry: ${project.parts.map((p) => `${p.name}: ${p.solids.length} convex solids`).join("; ")}`,
);
