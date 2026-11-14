import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import type { Mechanism, Part, Vec3 } from "./types";

export interface MechanismPreviewMember {
  original: Part;
  preview: Part;
  role: string;
  axialPosition: number;
  projectedHeight: number;
}

function memberRole(mechanism: Mechanism, id: string) {
  if (mechanism.springPartIds.includes(id)) return "弹簧";
  if (mechanism.contact?.strikerPartId === id) return "撞针 · 活动件";
  if (mechanism.contact?.actuatorPartIds?.includes(id)) return "随动触头";
  if (mechanism.switchPartId === id) return "电气开关";
  if (mechanism.contact?.targetPartId === id) return "触发面";
  if (mechanism.movingPartIds.includes(id)) return "活动件";
  return "固定件";
}

/** Display-only copies: rotate the world mechanism axis upright, then separate its member bounds. */
export function buildMechanismPreview(
  mechanism: Mechanism,
  parts: Part[],
  layered: boolean,
): { members: MechanismPreviewMember[]; gap: number; missingCount: number } {
  const radians = Math.PI / 180;
  const frameRotation = new Quaternion().setFromEuler(
    new Euler(...mechanism.frame.rotation.map((value) => value * radians) as Vec3, "XYZ"),
  );
  const worldAxis = new Vector3(...mechanism.axis).applyQuaternion(frameRotation).normalize();
  if (worldAxis.lengthSq() < 1e-12) worldAxis.set(0, 1, 0);
  const upright = new Quaternion().setFromUnitVectors(worldAxis, new Vector3(0, 1, 0));
  const origin = new Vector3(...mechanism.frame.position);
  const byId = new Map(parts.map((part) => [part.id, part]));
  const members = mechanism.partIds.flatMap((id) => {
    const original = byId.get(id);
    if (!original) return [];
    const position = new Vector3(...original.position).sub(origin).applyQuaternion(upright);
    const rotation = new Quaternion().setFromEuler(
      new Euler(...original.rotation.map((value) => value * radians) as Vec3, "XYZ"),
    ).premultiply(upright);
    const matrix = new Matrix4().makeRotationFromQuaternion(rotation).elements;
    // The uploaded/source meshes are normalized to Part.size by Viewport. Project
    // the complete rotated box, not just size[1], so tilted members cannot overlap.
    const projectedHeight = Math.abs(matrix[1]) * original.size[0]
      + Math.abs(matrix[5]) * original.size[1] + Math.abs(matrix[9]) * original.size[2];
    const euler = new Euler().setFromQuaternion(rotation, "XYZ");
    return [{
      original,
      preview: {
        ...original,
        position: position.toArray() as Vec3,
        rotation: [euler.x / radians, euler.y / radians, euler.z / radians] as Vec3,
        visible: true,
      },
      role: memberRole(mechanism, id),
      axialPosition: position.y,
      projectedHeight,
    }];
  }).sort((a, b) => b.axialPosition - a.axialPosition);
  const gap = Math.max(2, Math.min(8,
    Math.max(0, ...members.flatMap(({ original }) => original.size)) * 0.12,
  ));
  if (layered) {
    let floor = 2;
    for (const member of [...members].reverse()) {
      member.preview.position[1] = floor + member.projectedHeight / 2;
      floor += member.projectedHeight + gap;
    }
  } else {
    const bottom = Math.min(0, ...members.map((member) =>
      member.preview.position[1] - member.projectedHeight / 2,
    ));
    for (const member of members) member.preview.position[1] += 2 - bottom;
  }
  return { members, gap, missingCount: mechanism.partIds.length - members.length };
}
