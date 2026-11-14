import * as THREE from "three";
import type { Vec3 } from "./types";

export interface ContactMarker {
  id: string;
  /** Current world-space tip and fixed switch target from the mechanism contact solver. */
  striker: Vec3;
  target: Vec3;
  contact: boolean;
}
interface MarkerEntry {
  group: THREE.Group;
  striker: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  target: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  line: THREE.Line<THREE.BufferGeometry, THREE.LineDashedMaterial>;
  contact: boolean;
}
const strikerColor = "#f29b38",
  targetColor = "#248dcd",
  contactColor = "#20a66b";
function validPoint(point: Vec3): boolean {
  return point.length === 3 && point.every(Number.isFinite);
}
function createEntry(): MarkerEntry {
  const group = new THREE.Group();
  const striker = new THREE.Mesh(
    new THREE.SphereGeometry(0.65, 12, 8),
    new THREE.MeshBasicMaterial({
      color: strikerColor,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  const target = new THREE.Mesh(
    new THREE.SphereGeometry(1.05, 12, 8),
    new THREE.MeshBasicMaterial({
      color: targetColor,
      wireframe: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  const line = new THREE.Line(
    new THREE.BufferGeometry().setAttribute(
      "position",
      new THREE.Float32BufferAttribute(new Float32Array(6), 3),
    ),
    new THREE.LineDashedMaterial({
      color: targetColor,
      dashSize: 0.8,
      gapSize: 0.55,
      transparent: true,
      opacity: 0.7,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  striker.name = "mechanismStrikerMarker";
  target.name = "mechanismTargetMarker";
  striker.renderOrder = target.renderOrder = 12;
  line.renderOrder = 11;
  group.add(striker, target, line);
  group.traverse((object) => {
    object.userData.editorOverlay = true;
  });
  return { group, striker, target, line, contact: false };
}
function disposeEntry(entry: MarkerEntry): void {
  for (const object of [entry.striker, entry.target, entry.line]) {
    object.geometry.dispose();
    object.material.dispose();
  }
}

/** Reusable editor overlays; no component geometry, physical state or PBR material is touched. */
export class ContactMarkerLayer {
  readonly group = new THREE.Group();
  private readonly entries = new Map<string, MarkerEntry>();
  constructor() {
    this.group.name = "mechanismContactMarkers";
    this.group.userData.editorOverlay = true;
  }
  update(markers: readonly ContactMarker[]): void {
    const ids = new Set<string>();
    for (const marker of markers) {
      if (!validPoint(marker.striker) || !validPoint(marker.target)) continue;
      ids.add(marker.id);
      let entry = this.entries.get(marker.id);
      if (!entry) {
        entry = createEntry();
        this.entries.set(marker.id, entry);
        this.group.add(entry.group);
      }
      entry.striker.position.fromArray(marker.striker);
      entry.target.position.fromArray(marker.target);
      entry.striker.material.color.set(
        marker.contact ? contactColor : strikerColor,
      );
      entry.target.material.color.set(
        marker.contact ? contactColor : targetColor,
      );
      entry.line.material.color.set(
        marker.contact ? contactColor : targetColor,
      );
      entry.contact = marker.contact;
      const positions = entry.line.geometry.getAttribute(
        "position",
      ) as THREE.BufferAttribute;
      positions.setXYZ(0, ...marker.striker);
      positions.setXYZ(1, ...marker.target);
      positions.needsUpdate = true;
      entry.line.geometry.computeBoundingSphere();
      entry.line.computeLineDistances();
    }
    for (const [id, entry] of this.entries)
      if (!ids.has(id)) {
        this.group.remove(entry.group);
        disposeEntry(entry);
        this.entries.delete(id);
      }
  }
  /** Read actual marker objects for renderer diagnostics/E2E, rather than echoing input props. */
  poses(): Record<string, { striker: Vec3; target: Vec3; contact: boolean }> {
    return Object.fromEntries(
      [...this.entries].map(([id, entry]) => [
        id,
        {
          striker: entry.striker.position.toArray() as Vec3,
          target: entry.target.position.toArray() as Vec3,
          contact: entry.contact,
        },
      ]),
    );
  }
}
