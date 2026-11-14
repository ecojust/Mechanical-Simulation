import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { applyVisualDeformation } from "../src/visualDeformation";
import {
  encodeModelSnapshot,
  exportVisibleModel,
  MAX_MODEL_EXPORT_BYTES,
  snapshotVisibleModel,
} from "../src/modelExport";
import type { VisibleModelSource } from "../src/modelExport";

// GLTFExporter reads the Blob it constructs; browsers provide FileReader natively.
class BlobReader {
  result: ArrayBuffer | string | null = null;
  onloadend: (() => void) | null = null;
  readAsArrayBuffer(blob: Blob) {
    void blob.arrayBuffer().then((result) => {
      this.result = result;
      this.onloadend?.();
    });
  }
}
afterEach(() => vi.unstubAllGlobals());

function mesh(name = "surface") {
  const result = new THREE.Mesh(
    new THREE.BoxGeometry(4, 10, 6),
    new THREE.MeshStandardMaterial({
      color: "#3b91af",
      metalness: 0.7,
      roughness: 0.23,
    }),
  );
  result.name = name;
  return result;
}
function fixture() {
  const scene = new THREE.Scene();
  scene.add(
    new THREE.GridHelper(),
    mesh("ground"),
    new THREE.DirectionalLight(),
  );
  const object = new THREE.Group();
  object.name = "source-root";
  object.position.set(17, 31, -8); // Includes the current exploded/animated offset.
  object.rotation.set(0.2, -0.3, 0.4);
  const deformation = new THREE.Group();
  deformation.name = "spring-compression";
  applyVisualDeformation(deformation, { axis: [0.6, 0.8, 0], ratio: 0.35 });
  const surface = mesh();
  surface.position.set(1, -2, 3);
  deformation.add(surface);
  object.add(deformation);
  const invisibleParent = new THREE.Group();
  invisibleParent.visible = false;
  invisibleParent.add(mesh("hidden-descendant"));
  const overlay = mesh("editor-contact");
  overlay.userData.editorOverlay = true;
  object.add(
    invisibleParent,
    overlay,
    new THREE.LineSegments(new THREE.EdgesGeometry(surface.geometry)),
    new THREE.Sprite(),
    new THREE.PointLight(),
  );
  scene.add(object);
  const wires = new THREE.Group();
  const wire = mesh("wire-circuit-1");
  wire.userData.wireId = "circuit-1";
  wire.position.set(-10, 4, 3);
  wires.add(wire);
  scene.add(wires);
  scene.updateMatrixWorld(true);
  const source: VisibleModelSource = {
    parts: [
      {
        id: "spring-part",
        name: "压缩弹簧",
        visible: true,
        loaded: true,
        object,
      },
    ],
    wires,
  };
  return { scene, object, surface, deformation, wires, wire, source };
}
function expectBounds(actual: THREE.Box3, expected: THREE.Box3, digits = 5) {
  for (const key of ["min", "max"] as const)
    actual[key]
      .toArray()
      .forEach((value, index) =>
        expect(value).toBeCloseTo(expected[key].toArray()[index], digits),
      );
}
function surfaceBounds(...objects: THREE.Mesh[]) {
  const bounds = new THREE.Box3();
  for (const object of objects) {
    object.updateWorldMatrix(true, false);
    const position = object.geometry.getAttribute("position");
    for (let index = 0; index < position.count; index++)
      bounds.expandByPoint(
        new THREE.Vector3()
          .fromBufferAttribute(position, index)
          .applyMatrix4(object.matrixWorld),
      );
  }
  return bounds;
}

describe("visible model export", () => {
  it("captures current world vertices, arbitrary-axis compression and only visible model surfaces", () => {
    const f = fixture();
    const snapshot = snapshotVisibleModel(f.source);
    expect(snapshot).toMatchObject({
      partCount: 1,
      wireCount: 1,
      meshCount: 2,
      triangleCount: 24,
    });
    expectBounds(
      new THREE.Box3().setFromObject(snapshot.scene, true),
      surfaceBounds(f.surface, f.wire),
    );
    const part = snapshot.scene.getObjectByName("压缩弹簧")!;
    expect(part.userData.partId).toBe("spring-part");
    expect(part.getObjectByName("spring-compression")!.children[0].name).toBe(
      "surface",
    );
    expect(
      snapshot.scene.getObjectByName("wire-circuit-1")!.userData.wireId,
    ).toBe("circuit-1");
    for (const name of ["hidden-descendant", "ground", "editor-contact"])
      expect(snapshot.scene.getObjectByName(name)).toBeUndefined();
    snapshot.scene.traverse((object) =>
      expect(
        object instanceof THREE.Mesh || object instanceof THREE.Group,
      ).toBe(true),
    );
    snapshot.dispose();
  });

  it("round-trips binary GLB in meters with part hierarchy and PBR, and binary STL in millimeters", async () => {
    vi.stubGlobal("FileReader", BlobReader);
    const f = fixture();
    const expected = surfaceBounds(f.surface, f.wire);
    const snapshot = snapshotVisibleModel(f.source);
    const glb = await encodeModelSnapshot(snapshot, "glb");
    expect(new DataView(glb.data).getUint32(0, true)).toBe(0x46546c67);
    expect(glb).toMatchObject({
      units: "m",
      mimeType: "model/gltf-binary",
      partCount: 1,
      wireCount: 1,
    });
    const parsed = await new GLTFLoader().parseAsync(glb.data, "");
    const root = parsed.scene.children[0];
    expect(root.userData).toMatchObject({
      sourceUnits: "mm",
      units: "m",
      bakedWorldTransforms: true,
    });
    const scaled = expected.clone();
    scaled.min.multiplyScalar(0.001);
    scaled.max.multiplyScalar(0.001);
    expectBounds(new THREE.Box3().setFromObject(parsed.scene, true), scaled, 7);
    const material = (parsed.scene.getObjectByName("surface") as THREE.Mesh)
      .material as THREE.MeshStandardMaterial;
    expect(material.color.toArray()).toEqual(
      f.surface.material.color.toArray(),
    );
    expect(material.metalness).toBe(0.7);
    expect(material.roughness).toBe(0.23);
    const ids: string[] = [];
    parsed.scene.traverse((object) => {
      if (object.userData.partId) ids.push(object.userData.partId);
    });
    expect(ids).toEqual(["spring-part"]);
    const stl = await encodeModelSnapshot(snapshot, "stl");
    expect(stl).toMatchObject({
      units: "mm",
      mimeType: "model/stl",
      triangleCount: 24,
    });
    expect(stl.data.byteLength).toBe(84 + 24 * 50);
    expect(new DataView(stl.data).getUint32(80, true)).toBe(24);
    expect(new TextDecoder().decode(stl.data.slice(0, 80))).toContain(
      "millimeters",
    );
    const geometry = new STLLoader().parse(stl.data);
    geometry.computeBoundingBox();
    expectBounds(geometry.boundingBox!, expected);
    snapshot.dispose();
  });

  it("freezes before async encoding and never disposes or edits live geometry/materials", async () => {
    vi.stubGlobal("FileReader", BlobReader);
    const f = fixture();
    const expected = surfaceBounds(f.surface, f.wire);
    const original = Array.from(f.surface.geometry.attributes.position.array);
    const geometryDisposed = vi.fn(),
      materialDisposed = vi.fn();
    f.surface.geometry.addEventListener("dispose", geometryDisposed);
    f.surface.material.addEventListener("dispose", materialDisposed);
    const pending = exportVisibleModel(f.source, "glb");
    expect(Array.from(f.surface.geometry.attributes.position.array)).toEqual(
      original,
    );
    f.surface.geometry.translate(500, 0, 0);
    f.surface.material.color.set("red");
    f.object.position.set(1000, 1000, 1000);
    const result = await pending;
    const parsed = await new GLTFLoader().parseAsync(result.data, "");
    expected.min.multiplyScalar(0.001);
    expected.max.multiplyScalar(0.001);
    expectBounds(
      new THREE.Box3().setFromObject(parsed.scene, true),
      expected,
      7,
    );
    expect(
      (
        parsed.scene.getObjectByName("surface") as THREE.Mesh<
          THREE.BufferGeometry,
          THREE.MeshStandardMaterial
        >
      ).material.color.getHexString(),
    ).toBe("3b91af");
    expect(geometryDisposed).not.toHaveBeenCalled();
    expect(materialDisposed).not.toHaveBeenCalled();
  });

  it("copies texture data and owns only its cloned texture/resources", () => {
    const f = fixture();
    const texture = new THREE.DataTexture(
      new Uint8Array([5, 17, 29, 255]),
      1,
      1,
    );
    f.surface.material.map = texture;
    f.wire.material.map = texture.clone();
    const disposed = vi.fn();
    texture.addEventListener("dispose", disposed);
    const snapshot = snapshotVisibleModel(f.source);
    const material = (snapshot.scene.getObjectByName("surface") as THREE.Mesh)
      .material as THREE.MeshStandardMaterial;
    expect(material.map).not.toBe(texture);
    expect(material.map!.source).not.toBe(texture.source);
    const wireMaterial = (
      snapshot.scene.getObjectByName("wire-circuit-1") as THREE.Mesh
    ).material as THREE.MeshStandardMaterial;
    expect(wireMaterial.map!.source).toBe(material.map!.source);
    texture.image.data[0] = 99;
    expect(material.map!.image.data[0]).toBe(5);
    snapshot.dispose();
    expect(disposed).not.toHaveBeenCalled();
  });

  it("restores source/user PBR in the clone instead of exporting collision red and X-ray overlays", () => {
    const f = fixture();
    const material = f.surface.material;
    material.userData.baseColor = material.color.clone();
    material.userData.baseTransparent = true;
    material.userData.baseOpacity = 0.72;
    material.userData.baseDepthWrite = true;
    material.color.set("#dd6658");
    material.transparent = true;
    material.opacity = 0.34;
    material.depthWrite = false;
    const snapshot = snapshotVisibleModel(f.source);
    const exported = (snapshot.scene.getObjectByName("surface") as THREE.Mesh)
      .material as THREE.MeshStandardMaterial;
    expect(exported.color.getHexString()).toBe("3b91af");
    expect(exported).toMatchObject({
      transparent: true,
      opacity: 0.72,
      depthWrite: true,
      metalness: 0.7,
      roughness: 0.23,
    });
    expect(material.color.getHexString()).toBe("dd6658");
    expect(material).toMatchObject({ opacity: 0.34, depthWrite: false });
    snapshot.dispose();
  });

  it("honors drawRange and hidden materials without exporting their unused vertices", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [
          0, 0, 0, 1, 0, 0, 0, 1, 0, 100, 0, 0, 101, 0, 0, 100, 1, 0, 200, 0, 0,
          201, 0, 0, 200, 1, 0,
        ],
        3,
      ),
    );
    geometry.addGroup(0, 3, 0);
    geometry.addGroup(3, 3, 1);
    geometry.addGroup(6, 3, 0);
    geometry.setDrawRange(0, 6);
    const hidden = new THREE.MeshStandardMaterial();
    hidden.visible = false;
    const object = new THREE.Mesh(geometry, [
      new THREE.MeshStandardMaterial(),
      hidden,
    ]);
    const snapshot = snapshotVisibleModel({
      parts: [
        { id: "range", name: "range", object, visible: true, loaded: true },
      ],
      wires: new THREE.Group(),
    });
    expect(snapshot.triangleCount).toBe(1);
    const exported = snapshot.scene.getObjectByName("range") as THREE.Mesh;
    expect(exported.geometry.getAttribute("position").count).toBe(3);
    expect((exported.material as THREE.Material[]).length).toBe(1);
    expect(
      new THREE.Box3().setFromObject(snapshot.scene).max.toArray(),
    ).toEqual([1, 1, 0]);
    snapshot.dispose();
  });

  it("rejects visible loading/failed assets, ignores hidden missing assets and omits hidden wires", () => {
    const f = fixture();
    expect(() =>
      snapshotVisibleModel({
        ...f.source,
        parts: [{ ...f.source.parts[0], loaded: false }],
      }),
    ).toThrow(/占位模型/);
    expect(() =>
      snapshotVisibleModel({
        ...f.source,
        parts: [{ ...f.source.parts[0], object: undefined }],
      }),
    ).toThrow(/占位模型/);
    f.wires.visible = false;
    const snapshot = snapshotVisibleModel({
      ...f.source,
      parts: [
        ...f.source.parts,
        { id: "hidden", name: "hidden", visible: false, loaded: false },
      ],
    });
    expect(snapshot).toMatchObject({
      partCount: 1,
      wireCount: 0,
      meshCount: 1,
    });
    snapshot.dispose();
    expect(() => snapshotVisibleModel({ parts: [], wires: f.wires })).toThrow(
      /没有可见/,
    );
  });

  it("retains outward STL winding after mirrored world transforms", async () => {
    const object = mesh();
    object.scale.x = -2;
    const exported = await exportVisibleModel(
      {
        parts: [
          { id: "mirror", name: "mirror", object, visible: true, loaded: true },
        ],
        wires: new THREE.Group(),
      },
      "stl",
    );
    const geometry = new STLLoader().parse(exported.data);
    const positions = geometry.getAttribute("position"),
      normals = geometry.getAttribute("normal");
    for (let index = 0; index < positions.count; index += 3) {
      const centroid = new THREE.Vector3();
      for (let vertex = 0; vertex < 3; vertex++)
        centroid.add(
          new THREE.Vector3().fromBufferAttribute(positions, index + vertex),
        );
      expect(
        centroid.dot(new THREE.Vector3().fromBufferAttribute(normals, index)),
      ).toBeGreaterThan(0);
    }
  });

  it("rejects oversize STL before allocating the output", async () => {
    const snapshot = snapshotVisibleModel(fixture().source);
    snapshot.triangleCount = Math.ceil(MAX_MODEL_EXPORT_BYTES / 50);
    await expect(encodeModelSnapshot(snapshot, "stl")).rejects.toThrow(
      /256 MiB/,
    );
    snapshot.dispose();
  });
});
