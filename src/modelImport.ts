import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { validateUploadedModel } from "./componentRegistry";
import type { UploadedModel, Vec3 } from "./types";

import {
  inspectModelBytes,
  MODEL_LIMIT_BYTES,
  MODEL_TRIANGLE_LIMIT,
} from "./modelSafety";
export {
  inspectModelBytes,
  MODEL_LIMIT_BYTES,
  MODEL_TRIANGLE_LIMIT,
} from "./modelSafety";
export type ModelUnit = "mm" | "cm" | "m";
const units: Record<ModelUnit, number> = { mm: 1, cm: 10, m: 1000 };
function fail(message: string): never {
  throw Error(message);
}
export function bytesToBase64(bytes: Uint8Array): string {
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 32768)
    text += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(text);
}
export function base64ToBytes(value: string): Uint8Array {
  if (value.length > Math.ceil(MODEL_LIMIT_BYTES / 3) * 4 + 4)
    fail("模型超过 12 MiB 上限。");
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw Error("模型编码无效。");
  }
  return Uint8Array.from(decoded, (c) => c.charCodeAt(0));
}
function disposeImported(scene: THREE.Object3D) {
  scene.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      for (const material of Array.isArray(child.material)
        ? child.material
        : [child.material]) {
        for (const value of Object.values(material))
          if (value instanceof THREE.Texture) value.dispose();
        material.dispose();
      }
    }
  });
}
export async function parseModelScene(
  bytes: Uint8Array,
  format: "glb" | "stl",
): Promise<THREE.Group> {
  inspectModelBytes(bytes, format);
  const buffer = bytes.slice().buffer;
  let scene: THREE.Group;
  if (format === "stl") {
    const geometry = new STLLoader().parse(buffer);
    geometry.computeVertexNormals();
    scene = new THREE.Group();
    scene.add(
      new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
          color: "#839ead",
          roughness: 0.5,
          metalness: 0.15,
        }),
      ),
    );
  } else {
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
      if (!url.startsWith("blob:")) fail("模型不允许请求外部资源。");
      return url;
    });
    scene = (await new GLTFLoader(manager).parseAsync(buffer, "")).scene;
  }
  try {
    scene.updateMatrixWorld(true);
    let triangles = 0,
      meshes = 0;
    scene.traverse((object) => {
      if (!object.matrixWorld.elements.every(Number.isFinite))
        fail("模型变换含无效数值。");
      if (!(object instanceof THREE.Mesh)) return;
      meshes++;
      const position = object.geometry.getAttribute("position");
      if (!position) fail("模型缺少顶点。");
      triangles += (object.geometry.index?.count ?? position.count) / 3;
      if (triangles > MODEL_TRIANGLE_LIMIT)
        fail("显示模型超过 200,000 个三角形，请先简化。");
      for (let i = 0; i < position.count; i++)
        if (
          ![position.getX(i), position.getY(i), position.getZ(i)].every(
            (v) => Number.isFinite(v) && Math.abs(v) < 1e8,
          )
        )
          fail("模型包含非有限或过大的坐标。");
      object.castShadow = true;
      object.receiveShadow = true;
    });
    if (!meshes) fail("模型中没有可显示的三角网格。");
    const box = new THREE.Box3().setFromObject(scene, true);
    if (
      box.isEmpty() ||
      ![...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite)
    )
      fail("无法测量模型尺寸。");
    return scene;
  } catch (error) {
    disposeImported(scene);
    throw error;
  }
}
export async function importModelFile(
  file: File,
  unit: ModelUnit = "mm",
): Promise<UploadedModel> {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension !== "glb" && extension !== "stl")
    fail("请选择 .glb 或 .stl 模型文件。");
  if (file.size > MODEL_LIMIT_BYTES) fail("模型文件不能超过 12 MiB。");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const scene = await parseModelScene(bytes, extension);
  try {
    const box = new THREE.Box3().setFromObject(scene, true);
    const factor = units[unit];
    const size = box
      .getSize(new THREE.Vector3())
      .multiplyScalar(factor)
      .toArray() as Vec3;
    const center = box
      .getCenter(new THREE.Vector3())
      .multiplyScalar(factor)
      .toArray() as Vec3;
    if (size.some((v) => v < 0.001 || v > 10000))
      fail(
        "模型每个方向的尺寸须在 0.001 至 10,000 mm 之间，请检查单位或实体厚度。",
      );
    const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
    const sha256 = Array.from(new Uint8Array(digest), (v) =>
      v.toString(16).padStart(2, "0"),
    ).join("");
    return validateUploadedModel({
      id: `model-${sha256.slice(0, 40)}-${unit}`,
      name: file.name.slice(0, 200),
      format: extension,
      data: bytesToBase64(bytes),
      sha256,
      bytes: bytes.length,
      size,
      center,
    });
  } finally {
    disposeImported(scene);
  }
}
const sourceScenes = new Map<string, Promise<THREE.Group>>();
/** Cached sources stay immutable; callers clone before adding them to a viewport. */
export function loadImportedModelScene(
  model: UploadedModel,
): Promise<THREE.Group> {
  const valid = validateUploadedModel(model);
  const key = `${valid.id}:${valid.sha256}`;
  let pending = sourceScenes.get(key);
  if (!pending) {
    pending = parseModelScene(base64ToBytes(valid.data), valid.format);
    sourceScenes.set(key, pending);
    pending.catch(() => sourceScenes.delete(key));
    if (sourceScenes.size > 8) {
      const oldest = sourceScenes.keys().next().value;
      if (oldest && oldest !== key) {
        const removed = sourceScenes.get(oldest);
        sourceScenes.delete(oldest);
        void removed?.then(disposeImported).catch(() => {});
      }
    }
  }
  return pending;
}
