import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { bayonetSolids } from "../engine/bayonet";
import type { Part } from "../types";

/** Render the same convex vertices used by motion validation, including the open L slots. */
export function createBayonetVisual(part: Part): THREE.Group {
  const group = new THREE.Group();
  const byRole = new Map<string, THREE.BufferGeometry[]>();
  for (const solid of bayonetSolids(part)) {
    const geometry = new ConvexGeometry(
      solid.vertices.map((v) => new THREE.Vector3(...v)),
    );
    const list = byRole.get(solid.role) ?? [];
    list.push(geometry);
    byRole.set(solid.role, list);
  }
  for (const [role, geometries] of byRole) {
    const merged = mergeGeometries(geometries);
    for (const geometry of geometries) geometry.dispose();
    if (!merged) continue;
    const color = new THREE.Color(part.color);
    if (role === "lug") color.lerp(new THREE.Color("#d7e5e7"), 0.17);
    const mesh = new THREE.Mesh(
      merged,
      new THREE.MeshStandardMaterial({
        color,
        metalness: 0.38,
        roughness: 0.34,
      }),
    );
    mesh.name = `bayonet-${role}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}
