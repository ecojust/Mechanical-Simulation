import * as THREE from "three";
import type { Vec3 } from "./types";

/** Axis is expressed in the part's local coordinates; ratio is current/rest length. */
export interface VisualDeformation {
  axis: Vec3;
  ratio: number;
}
export type VisualDeformations = Record<string, VisualDeformation>;

/** Q · diag(1, ratio, 1) · Q⁻¹, expressed directly as I + (ratio − 1) aaᵀ. */
export function deformationMatrix(
  deformation: VisualDeformation | undefined,
  target = new THREE.Matrix4(),
): THREE.Matrix4 {
  if (!deformation) return target.identity();
  const [ax, ay, az] = deformation.axis;
  const length = Math.hypot(ax, ay, az);
  if (
    !Number.isFinite(length) ||
    length < 1e-12 ||
    !Number.isFinite(deformation.ratio)
  )
    return target.identity();
  const x = ax / length,
    y = ay / length,
    z = az / length;
  // Keep normal matrices invertible even at an invalid/fully collapsed preview pose.
  const delta = Math.min(100, Math.max(0.0001, deformation.ratio)) - 1;
  return target.set(
    1 + delta * x * x,
    delta * x * y,
    delta * x * z,
    0,
    delta * x * y,
    1 + delta * y * y,
    delta * y * z,
    0,
    delta * x * z,
    delta * y * z,
    1 + delta * z * z,
    0,
    0,
    0,
    0,
    1,
  );
}

/** Changes only the display wrapper, never geometry buffers, cached sources or materials. */
export function applyVisualDeformation(
  wrapper: THREE.Object3D,
  deformation: VisualDeformation | undefined,
): void {
  wrapper.matrixAutoUpdate = false;
  deformationMatrix(deformation, wrapper.matrix);
  wrapper.matrixWorldNeedsUpdate = true;
}
