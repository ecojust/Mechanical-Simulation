import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { Part } from "../types";
import { createBayonetVisual } from "./bayonetVisual";

const steel = "#a8b5bf";
const dark = "#253c4b";
export function material(color: string, metalness = 0.35, roughness = 0.36) {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness });
}
function addMesh(
  group: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  color: string,
  position: number[] = [0, 0, 0],
  metalness = 0.35,
) {
  const mesh = new THREE.Mesh(geometry, material(color, metalness));
  mesh.position.set(position[0], position[1], position[2]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}
function box(
  group: THREE.Object3D,
  size: number[],
  color: string,
  position: number[] = [0, 0, 0],
  radius = 0,
) {
  const geometry = radius
    ? new RoundedBoxGeometry(
        size[0],
        size[1],
        size[2],
        3,
        Math.min(radius, ...size.map((v) => v / 3)),
      )
    : new THREE.BoxGeometry(...(size as [number, number, number]));
  const mesh = addMesh(group, geometry, color, position);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry, 30),
    new THREE.LineBasicMaterial({
      color: "#0c2233",
      transparent: true,
      opacity: 0.12,
    }),
  );
  mesh.add(edges);
  return mesh;
}
function cylinder(
  group: THREE.Object3D,
  radius: number,
  height: number,
  color: string,
  position: number[] = [0, 0, 0],
  radiusTop = radius,
) {
  return addMesh(
    group,
    new THREE.CylinderGeometry(radiusTop, radius, height, 48),
    color,
    position,
  );
}
function screw(
  group: THREE.Object3D,
  x: number,
  y: number,
  z: number,
  radius = 1.15,
) {
  cylinder(group, radius * 1.4, 0.14, "#415665", [x, y, z]);
  cylinder(group, radius, 0.35, steel, [x, y + 0.13, z]);
  box(group, [radius * 1.3, 0.1, 0.25], "#475764", [x, y + 0.32, z]);
  box(group, [0.25, 0.1, radius * 1.3], "#475764", [x, y + 0.32, z]);
}
function tube(
  group: THREE.Object3D,
  outer: number,
  inner: number,
  height: number,
  color: string,
) {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outer, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, inner, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: false,
    curveSegments: 32,
    steps: 1,
  });
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, height / 2, 0);
  return addMesh(group, geometry, color);
}
export function labelSprite(text: string, color = "#607381", background = "") {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  if (background) {
    ctx.fillStyle = background;
    ctx.roundRect(0, 0, 512, 128, 20);
    ctx.fill();
  }
  ctx.fillStyle = color;
  ctx.font = "500 64px Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 256, 67);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      depthTest: false,
      transparent: true,
    }),
  );
  sprite.scale.set(16, 4, 1);
  sprite.renderOrder = 10;
  return sprite;
}
class Helix extends THREE.Curve<THREE.Vector3> {
  constructor(
    private radius: number,
    private height: number,
    private turns = 7,
  ) {
    super();
  }
  getPoint(t: number) {
    const a = t * Math.PI * 2 * this.turns;
    return new THREE.Vector3(
      Math.cos(a) * this.radius,
      t * this.height - this.height / 2,
      Math.sin(a) * this.radius,
    );
  }
}
function spring(
  group: THREE.Object3D,
  radius: number,
  height: number,
  wireRadius: number,
  color: string,
) {
  const coil = addMesh(
    group,
    new THREE.TubeGeometry(
      new Helix(radius, height - wireRadius * 2),
      256,
      wireRadius,
      8,
      false,
    ),
    color,
    [0, 0, 0],
    0.8,
  );
  coil.name = "spring";
  coil.userData.height = height;
  return coil;
}
export function createPartVisual(part: Part) {
  const group = new THREE.Group();
  const [w, h, d] = part.size;
  const color = part.color;
  switch (part.kind) {
    case "bayonet-pin":
    case "bayonet-socket": {
      group.add(createBayonetVisual(part));
      if (part.kind === "bayonet-socket") {
        // Floating datum labels are annotations, never a cap over the insertion slots.
        const entry = labelSprite("0° ↓", "#416977");
        entry.scale.set(24, 6, 1);
        entry.position.set(0, h / 2 + 3, d / 2 + 4);
        group.add(entry);
        const lock = labelSprite("+45°", "#806a45");
        lock.scale.set(24, 6, 1);
        const radial = Math.max(w, d) / 2 + 4;
        lock.position.set(
          radial * Math.SQRT1_2,
          h / 2 + 3,
          radial * Math.SQRT1_2,
        );
        group.add(lock);
      }
      break;
    }
    case "base": {
      box(group, [w, h, d], color, [0, 0, 0], 0.65);
      const countX = Math.max(2, Math.floor(w / 12));
      const countZ = Math.max(2, Math.floor(d / 12));
      for (let x = 0; x < countX; x++)
        for (let z = 0; z < countZ; z++) {
          const cx = (x / (countX - 1) - 0.5) * (w - 10);
          const cz = (z / (countZ - 1) - 0.5) * (d - 10);
          const ring = new THREE.Mesh(
            new THREE.RingGeometry(0.48, 0.66, 16),
            material("#6c8492", 0.4),
          );
          ring.rotation.x = -Math.PI / 2;
          ring.position.set(cx, h / 2 + 0.025, cz);
          group.add(ring);
        }
      for (const x of [-1, 1])
        for (const z of [-1, 1])
          screw(group, x * (w / 2 - 3), h / 2, z * (d / 2 - 3), 1.05);
      break;
    }
    case "mortise": {
      const iw = Number(part.params.innerWidth ?? w * 0.52),
        id = Number(part.params.innerDepth ?? d * 0.52);
      const tw = Math.max(0.1, (w - iw) / 2),
        td = Math.max(0.1, (d - id) / 2);
      box(group, [tw, h, d], color, [-(w + iw) / 4, 0, 0]);
      box(group, [tw, h, d], color, [(w + iw) / 4, 0, 0]);
      box(group, [iw, h, td], color, [0, 0, -(d + id) / 4]);
      box(group, [iw, h, td], color, [0, 0, (d + id) / 4]);
      // Fine datum marks on the front face leave the central opening unobstructed.
      for (const x of [-1, 1])
        box(group, [1.2, h * 0.45, 0.025], "#b5c7d0", [
          (x * (w + iw)) / 4,
          0,
          d / 2 + 0.02,
        ]);
      break;
    }
    case "tenon": {
      box(group, [w, h, d], color);
      for (let i = 1; i <= 4; i++)
        box(group, [w * 0.3, 0.1, 0.025], "#d8e7eb", [
          w * 0.3,
          -h / 2 + (i * h) / 5,
          d / 2 + 0.02,
        ]);
      break;
    }
    case "pin": {
      cylinder(group, w / 2, h, color);
      const top = new THREE.Mesh(
        new THREE.RingGeometry(w * 0.31, w * 0.34, 48),
        material("#6a8290"),
      );
      top.rotation.x = -Math.PI / 2;
      top.position.y = h / 2 + 0.02;
      group.add(top);
      break;
    }
    case "sleeve":
      tube(
        group,
        w / 2,
        Number(part.params.holeDiameter ?? w * 0.6) / 2,
        h,
        color,
      );
      break;
    case "spring":
      spring(group, Math.min(w, d) / 2 - 0.6, h, 0.6, color);
      break;
    case "button": {
      const baseH = h * 0.28,
        capH = h * 0.22;
      box(group, [w, baseH, d], dark, [0, -h / 2 + baseH / 2, 0], 0.45);
      const coil = spring(
        group,
        Math.min(w, d) * 0.2,
        h * 0.45,
        Math.min(w, d) * 0.035,
        steel,
      );
      coil.position.y = -h * 0.02;
      const actuator = new THREE.Group();
      actuator.name = "actuator";
      actuator.userData.restY = 0;
      cylinder(actuator, Math.min(w, d) * 0.12, h * 0.52, "#dce3e4", [
        0,
        h * 0.1,
        0,
      ]);
      box(
        actuator,
        [w * 0.88, capH, d * 0.88],
        color,
        [0, h / 2 - capH / 2, 0],
        0.8,
      );
      group.add(actuator);
      for (const x of [-1, 1])
        screw(group, x * w * 0.36, -h / 2 + baseH, d * 0.31, 0.6);
      break;
    }
    case "battery": {
      box(group, [w, h, d], color, [0, 0, 0], 1);
      box(
        group,
        [w * 0.94, h * 0.14, d * 0.94],
        "#243e50",
        [0, h * 0.38, 0],
        0.5,
      );
      const text = labelSprite(`${part.params.voltage ?? 5} V`, "#e2f1f4");
      text.position.set(0, h * 0.04, d / 2 + 0.03);
      text.scale.set(w * 0.8, w * 0.2, 1);
      group.add(text);
      break;
    }
    case "lamp": {
      cylinder(group, Math.min(w, d) / 2, h * 0.28, "#4c6473", [
        0,
        -h / 2 + h * 0.14,
        0,
      ]);
      cylinder(group, Math.min(w, d) * 0.34, h * 0.19, steel, [
        0,
        -h * 0.12,
        0,
      ]);
      const bulb = addMesh(
        group,
        new THREE.SphereGeometry(1, 40, 24, 0, Math.PI * 2, 0, Math.PI),
        "#dfede8",
        [0, h * 0.15, 0],
        0.05,
      );
      bulb.scale.set(w * 0.41, h * 0.35, d * 0.41);
      bulb.name = "bulb";
      const mat = bulb.material as THREE.MeshStandardMaterial;
      mat.roughness = 0.16;
      mat.emissive.set("#ffcc45");
      mat.emissiveIntensity = 0;
      const light = new THREE.PointLight("#ffcf61", 0, 42, 1.4);
      light.position.set(0, h * 0.2, 0);
      light.name = "lampLight";
      group.add(light);
      break;
    }
    case "resistor": {
      box(group, [w, h * 0.28, d * 0.25], steel);
      const body = cylinder(group, Math.min(h, d) * 0.42, w * 0.64, color);
      body.rotation.z = Math.PI / 2;
      for (let i = 0; i < 4; i++) {
        const band = cylinder(
          group,
          Math.min(h, d) * 0.425,
          w * 0.045,
          ["#9d5029", "#252e35", "#a74b32", "#bc9a4b"][i],
          [(i - 1.5) * w * 0.13, 0, 0],
        );
        band.rotation.z = Math.PI / 2;
      }
      break;
    }
    case "asset":
      box(group, [w, h, d], color);
      break;
  }
  if (["battery", "lamp", "button", "resistor"].includes(part.kind)) {
    for (const terminal of [0, 1]) {
      const p = terminalLocal(part, terminal);
      const pin = cylinder(
        group,
        0.7,
        0.8,
        terminal === 0 ? "#dc7055" : "#526877",
        p.toArray(),
      );
      pin.userData.terminal = terminal;
      if (part.kind === "battery") {
        const text = labelSprite(
          terminal === 0 ? "+" : "−",
          terminal === 0 ? "#e27861" : "#b6cad3",
        );
        text.scale.set(3, 0.75, 1);
        text.position.copy(p).add(new THREE.Vector3(0, 1, 0));
        group.add(text);
      }
    }
  }
  return group;
}
export function terminalLocal(part: Part, terminal: number) {
  return new THREE.Vector3(
    (terminal === 0 ? -1 : 1) * part.size[0] * 0.34,
    part.size[1] / 2 + 0.6,
    part.size[2] * 0.31,
  );
}
export function disposeObject(object: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>(),
    materials = new Set<THREE.Material>(),
    textures = new Set<THREE.Texture>();
  object.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    if (mesh.material)
      (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(
        (mat) => materials.add(mat),
      );
  });
  materials.forEach((mat) => {
    for (const value of Object.values(mat))
      if (value instanceof THREE.Texture) textures.add(value);
    mat.dispose();
  });
  geometries.forEach((geometry) => geometry.dispose());
  textures.forEach((texture) => texture.dispose());
}
