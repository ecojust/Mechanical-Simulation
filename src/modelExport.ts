import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";

export type ModelExportFormat = "glb" | "stl";
export interface ModelExportResult {
  data: ArrayBuffer;
  format: ModelExportFormat;
  extension: ModelExportFormat;
  mimeType: string;
  units: "m" | "mm";
  partCount: number;
  wireCount: number;
  meshCount: number;
  triangleCount: number;
}
export interface ViewportExportHandle {
  exportModel(format: ModelExportFormat): Promise<ModelExportResult>;
}
export interface VisibleModelSource {
  parts: readonly {
    id: string;
    name: string;
    visible: boolean;
    loaded: boolean;
    object?: THREE.Object3D;
  }[];
  wires: THREE.Object3D;
}
export interface ModelSnapshot {
  scene: THREE.Group;
  partCount: number;
  wireCount: number;
  meshCount: number;
  triangleCount: number;
  dispose(): void;
}
export const MAX_MODEL_EXPORT_BYTES = 256 * 1024 * 1024;

function visibleInHierarchy(object: THREE.Object3D) {
  for (
    let current: THREE.Object3D | null = object;
    current;
    current = current.parent
  )
    if (!current.visible || current.userData.editorOverlay) return false;
  return true;
}

function visibleMaterial(material: THREE.Material | undefined) {
  return (
    material?.visible &&
    !(
      (material.userData.baseTransparent ?? material.transparent) &&
      (material.userData.baseOpacity ?? material.opacity) === 0
    )
  );
}

/** A texture clone must also freeze mutable canvas/data pixels before async encoding. */
function cloneTexture(
  texture: THREE.Texture,
  pixels: WeakMap<object, THREE.Source>,
) {
  const clone = texture.clone();
  const original = texture.image;
  if (!original)
    throw new Error("模型纹理尚未就绪，请等待加载完成后重试导出。");
  const cached = pixels.get(original);
  if (cached) {
    clone.source = cached;
    return clone;
  }
  if (original?.data && ArrayBuffer.isView(original.data)) {
    clone.source = new THREE.Source({
      ...original,
      data: original.data.slice(),
    });
  } else if (original) {
    const width =
      original.naturalWidth || original.videoWidth || original.width;
    const height =
      original.naturalHeight || original.videoHeight || original.height;
    if (!width || !height || typeof document === "undefined")
      throw new Error("无法保存模型纹理的当前像素，请等待纹理加载完成后重试。");
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建模型纹理快照。");
    context.drawImage(original, 0, 0, width, height);
    clone.source = new THREE.Source(canvas);
  }
  pixels.set(original, clone.source);
  return clone;
}

/** Snapshot only rendered triangle ranges, including material visibility. */
function visibleGeometry(mesh: THREE.Mesh) {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute("position");
  if (!position) return null;
  const count = geometry.index?.count ?? position.count;
  const drawStart = Math.max(0, geometry.drawRange.start);
  const drawEnd = Math.min(count, drawStart + geometry.drawRange.count);
  const materials = Array.isArray(mesh.material)
    ? mesh.material
    : [mesh.material];
  const groups = Array.isArray(mesh.material)
    ? geometry.groups
    : [{ start: 0, count, materialIndex: 0 }];
  const indices: number[] = [];
  const visibleGroups: {
    start: number;
    count: number;
    materialIndex: number;
  }[] = [];
  for (const group of groups) {
    const materialIndex = group.materialIndex ?? 0;
    if (!visibleMaterial(materials[materialIndex])) continue;
    const start = Math.max(drawStart, group.start);
    const end = Math.min(drawEnd, group.start + group.count);
    const offset = indices.length;
    for (let index = start; index + 2 < end; index += 3)
      for (let vertex = 0; vertex < 3; vertex++)
        indices.push(geometry.index?.getX(index + vertex) ?? index + vertex);
    if (indices.length > offset)
      visibleGroups.push({
        start: offset,
        count: indices.length - offset,
        materialIndex,
      });
  }
  if (!indices.length) return null;
  const clone = new THREE.BufferGeometry();
  const vertices: number[] = [];
  const remap = new Map<number, number>();
  const compactIndices = indices.map((original) => {
    let compact = remap.get(original);
    if (compact === undefined) {
      compact = vertices.length;
      remap.set(original, compact);
      vertices.push(original);
    }
    return compact;
  });
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    const ArrayType = attribute.array.constructor as {
      new (length: number): typeof attribute.array;
    };
    const copied = new THREE.BufferAttribute(
      new ArrayType(vertices.length * attribute.itemSize),
      attribute.itemSize,
      attribute.normalized,
    );
    vertices.forEach((original, target) => {
      for (let component = 0; component < attribute.itemSize; component++)
        copied.setComponent(
          target,
          component,
          attribute.getComponent(original, component),
        );
    });
    clone.setAttribute(name, copied);
  }
  // Baking world-space vertices also preserves arbitrary-axis spring compression.
  // GLTF nodes must be decomposable TRS; a compressed rotated axis need not be.
  clone.setIndex(compactIndices);
  visibleGroups.forEach((group) =>
    clone.addGroup(group.start, group.count, group.materialIndex),
  );
  clone.setDrawRange(0, indices.length);
  clone.applyMatrix4(mesh.matrixWorld);
  if (mesh.matrixWorld.determinant() < 0) {
    const index = clone.index!;
    for (let i = 0; i < index.count; i += 3) {
      const second = index.getX(i + 1);
      index.setX(i + 1, index.getX(i + 2));
      index.setX(i + 2, second);
    }
    const tangent = clone.getAttribute("tangent");
    if (tangent)
      for (let i = 0; i < tangent.count; i++) tangent.setW(i, -tangent.getW(i));
  }
  return clone;
}

/** Capture synchronously. No geometry, material, texture or mutable pixels are shared with the live view. */
export function snapshotVisibleModel(
  source: VisibleModelSource,
): ModelSnapshot {
  const unavailable = source.parts.filter(
    (part) => part.visible && (!part.object || !part.loaded),
  );
  if (unavailable.length)
    throw new Error(
      `以下可见素材仍在载入或载入失败，不能导出占位模型：${unavailable.map((part) => part.name).join("、")}`,
    );
  const scene = new THREE.Group();
  scene.name = "Visible assembly";
  scene.userData = {
    sourceUnits: "mm",
    snapshot: "visible-model",
    bakedWorldTransforms: true,
  };
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  // Different material instances often share one large source image. Copy its pixels once.
  const pixels = new WeakMap<object, THREE.Source>();
  const snapshot: ModelSnapshot = {
    scene,
    partCount: 0,
    wireCount: 0,
    meshCount: 0,
    triangleCount: 0,
    dispose() {
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      textures.forEach((texture) => texture.dispose());
      geometries.clear();
      materials.clear();
      textures.clear();
    },
  };
  const copyMaterial = (original: THREE.Material) => {
    const clone = original.clone();
    materials.add(clone);
    // Collision red and X-ray transparency are editor feedback, not the part's PBR.
    if (
      clone instanceof THREE.MeshStandardMaterial &&
      original.userData.baseColor
    )
      clone.color.copy(original.userData.baseColor);
    if (typeof original.userData.baseTransparent === "boolean")
      clone.transparent = original.userData.baseTransparent;
    if (typeof original.userData.baseOpacity === "number")
      clone.opacity = original.userData.baseOpacity;
    if (typeof original.userData.baseDepthWrite === "boolean")
      clone.depthWrite = original.userData.baseDepthWrite;
    for (const [key, value] of Object.entries(original)) {
      if (!(value instanceof THREE.Texture)) continue;
      const texture = cloneTexture(value, pixels);
      textures.add(texture);
      (clone as unknown as Record<string, unknown>)[key] = texture;
    }
    return clone;
  };
  const copyBranch = (original: THREE.Object3D): THREE.Object3D | null => {
    if (!visibleInHierarchy(original)) return null;
    // Labels, edge accents, lights and editor helpers are not model surfaces.
    if (
      original instanceof THREE.Sprite ||
      original instanceof THREE.Line ||
      original instanceof THREE.Points ||
      original instanceof THREE.Light ||
      original instanceof THREE.Camera
    )
      return null;
    let clone: THREE.Object3D;
    if (original instanceof THREE.Mesh) {
      if (
        original instanceof THREE.SkinnedMesh ||
        original instanceof THREE.InstancedMesh ||
        original.morphTargetInfluences?.some((value) => value !== 0)
      )
        throw new Error(
          "当前模型包含尚不支持快照导出的骨骼、实例或变形目标，请先烘焙为静态网格。",
        );
      const geometry = visibleGeometry(original);
      if (geometry) {
        geometries.add(geometry);
        let material: THREE.Material | THREE.Material[];
        if (Array.isArray(original.material)) {
          const used = [
            ...new Set(
              geometry.groups.map((group) => group.materialIndex ?? 0),
            ),
          ];
          material = used.map((index) =>
            copyMaterial(original.material[index]),
          );
          geometry.groups.forEach((group) => {
            group.materialIndex = used.indexOf(group.materialIndex ?? 0);
          });
        } else material = copyMaterial(original.material);
        clone = new THREE.Mesh(geometry, material);
        snapshot.meshCount++;
        snapshot.triangleCount += geometry.index!.count / 3;
      } else clone = new THREE.Group();
    } else clone = new THREE.Group();
    clone.name = original.name;
    clone.userData = JSON.parse(JSON.stringify(original.userData));
    for (const child of original.children) {
      const copied = copyBranch(child);
      if (copied) clone.add(copied);
    }
    return clone instanceof THREE.Mesh || clone.children.length ? clone : null;
  };
  try {
    for (const part of source.parts) {
      if (!part.visible || !part.object || !visibleInHierarchy(part.object))
        continue;
      part.object.updateWorldMatrix(true, true);
      const copied = copyBranch(part.object);
      if (!copied) continue;
      copied.name = part.name;
      copied.userData.partId = part.id;
      scene.add(copied);
      snapshot.partCount++;
    }
    source.wires.updateWorldMatrix(true, true);
    const wires = new THREE.Group();
    wires.name = "Logical wires";
    for (const wire of source.wires.children) {
      const copied = copyBranch(wire);
      if (!copied) continue;
      wires.add(copied);
      snapshot.wireCount++;
    }
    if (wires.children.length) scene.add(wires);
    if (!snapshot.triangleCount)
      throw new Error("当前没有可见的模型表面可供导出。");
    scene.updateMatrixWorld(true);
    return snapshot;
  } catch (error) {
    snapshot.dispose();
    throw error;
  }
}

export async function encodeModelSnapshot(
  snapshot: ModelSnapshot,
  format: ModelExportFormat,
): Promise<ModelExportResult> {
  if (format !== "glb" && format !== "stl")
    throw new Error("不支持的模型导出格式。");
  const units = format === "glb" ? "m" : "mm";
  // Only the node graph is copied here; its resources already belong to the frozen snapshot.
  const scene = snapshot.scene.clone(true);
  scene.userData.units = units;
  scene.scale.setScalar(format === "glb" ? 0.001 : 1);
  scene.updateMatrixWorld(true);
  let data: ArrayBuffer;
  if (format === "stl") {
    if (84 + snapshot.triangleCount * 50 > MAX_MODEL_EXPORT_BYTES)
      throw new Error("导出文件超过 256 MiB，请隐藏部分零件后重试。");
    const binary = new STLExporter().parse(scene, { binary: true });
    data = binary.buffer.slice(
      binary.byteOffset,
      binary.byteOffset + binary.byteLength,
    ) as ArrayBuffer;
    new Uint8Array(data, 0, 80).set(
      new TextEncoder().encode(
        "Mechanical Simulation | visible model | units: millimeters (mm)",
      ),
    );
  } else {
    const binary = await new GLTFExporter().parseAsync(scene, {
      binary: true,
      onlyVisible: true,
      trs: false,
    });
    if (!(binary instanceof ArrayBuffer))
      throw new Error("GLB 编码未返回二进制模型。");
    data = binary;
  }
  if (data.byteLength > MAX_MODEL_EXPORT_BYTES)
    throw new Error("导出文件超过 256 MiB，请隐藏部分零件后重试。");
  return {
    data,
    format,
    extension: format,
    units,
    mimeType: format === "glb" ? "model/gltf-binary" : "model/stl",
    partCount: snapshot.partCount,
    wireCount: snapshot.wireCount,
    meshCount: snapshot.meshCount,
    triangleCount: snapshot.triangleCount,
  };
}

export async function exportVisibleModel(
  source: VisibleModelSource,
  format: ModelExportFormat,
): Promise<ModelExportResult> {
  const snapshot = snapshotVisibleModel(source);
  try {
    return await encodeModelSnapshot(snapshot, format);
  } finally {
    snapshot.dispose();
  }
}
