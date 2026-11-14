import * as THREE from "three";
import type { Part } from "./types";

type Appearance = Pick<Part, "color" | "material">;
const transferable = [
  "name",
  "map",
  "alphaMap",
  "normalMap",
  "normalMapType",
  "normalScale",
  "bumpMap",
  "bumpScale",
  "displacementMap",
  "displacementScale",
  "displacementBias",
  "aoMap",
  "aoMapIntensity",
  "lightMap",
  "lightMapIntensity",
  "emissive",
  "emissiveMap",
  "emissiveIntensity",
  "envMap",
  "envMapIntensity",
  "opacity",
  "transparent",
  "alphaTest",
  "alphaHash",
  "side",
  "depthTest",
  "depthWrite",
  "colorWrite",
  "vertexColors",
  "flatShading",
  "blending",
  "blendSrc",
  "blendDst",
  "blendEquation",
  "premultipliedAlpha",
  "dithering",
  "toneMapped",
  "visible",
] as const;

/** Convert mesh surfaces to PBR while preserving compatible imported maps and opacity. */
function pbrMaterial(
  source: THREE.Material,
  cloneMaterials: boolean,
): THREE.MeshStandardMaterial {
  let result: THREE.MeshStandardMaterial;
  if (source instanceof THREE.MeshStandardMaterial) {
    // MeshPhysicalMaterial is already PBR and retains its transmission/clearcoat settings.
    result = cloneMaterials ? source.clone() : source;
  } else {
    result = new THREE.MeshStandardMaterial({
      metalness: 0.15,
      roughness: 0.5,
    });
    const from = source as unknown as Record<string, unknown>;
    const to = result as unknown as Record<string, unknown>;
    if (from.color instanceof THREE.Color) result.color.copy(from.color);
    for (const key of transferable) {
      const value = from[key];
      if (value === undefined) continue;
      if (value instanceof THREE.Color || value instanceof THREE.Vector2)
        to[key] = value.clone();
      else to[key] = value;
    }
    result.userData = { ...source.userData };
    if (!cloneMaterials) source.dispose();
  }
  if (cloneMaterials) {
    // Material/texture ownership belongs to this displayed instance; source images remain shared.
    for (const key of Object.keys(result)) {
      const value = (result as unknown as Record<string, unknown>)[key];
      if (value instanceof THREE.Texture)
        (result as unknown as Record<string, unknown>)[key] = value.clone();
    }
  }
  return result;
}

/**
 * Apply an appearance only to physical Mesh surfaces. Lines, wire guides, sprites and
 * explicitly marked editor overlays are untouched. The default isolates shared source
 * materials; a freshly constructed/cloned viewport instance may opt out of cloning.
 */
export function applyPartMaterial(
  object: THREE.Object3D,
  appearance: Appearance,
  { cloneMaterials = true }: { cloneMaterials?: boolean } = {},
): void {
  const converted = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || child.userData.editorOverlay) return;
    const apply = (source: THREE.Material) => {
      const cached = converted.get(source);
      if (cached) return cached;
      const material = pbrMaterial(source, cloneMaterials);
      const sourceColor =
        material.userData.sourceColor ?? material.color.clone();
      material.userData.sourceColor = sourceColor;
      if (appearance.material) {
        material.metalness = appearance.material.metalness;
        material.roughness = appearance.material.roughness;
        if (appearance.material.useSourceColor === true)
          material.color.copy(sourceColor);
        else material.color.set(appearance.color);
      }
      material.userData.baseColor = material.color.clone();
      material.userData.baseOpacity = material.opacity;
      material.userData.baseTransparent = material.transparent;
      material.userData.baseDepthWrite = material.depthWrite;
      material.needsUpdate = true;
      converted.set(source, material);
      return material;
    };
    child.material = Array.isArray(child.material)
      ? child.material.map(apply)
      : apply(child.material);
  });
}
