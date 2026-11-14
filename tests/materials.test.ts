import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { applyPartMaterial } from "../src/materials";
import { demoProject, parseProject } from "../src/catalog";
import {
  createPartFromComponent,
  sha256Bytes,
  validateComponentDefinition,
} from "../src/componentRegistry";
import { binaryStlTriangle } from "./model-fixtures";

const appearance = {
  color: "#bf603a",
  material: { metalness: 0.8, roughness: 0.25, useSourceColor: false },
};
function instance(material: THREE.Material | THREE.Material[]) {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  group.add(mesh);
  return { group, mesh };
}
describe("per-part physically based appearance", () => {
  it("converts non-PBR source meshes while preserving textures, normals and transparency", () => {
    const map = new THREE.Texture(),
      normal = new THREE.Texture();
    const source = new THREE.MeshPhongMaterial({
      color: "#aabbcc",
      map,
      normalMap: normal,
      opacity: 0.4,
      transparent: true,
      side: THREE.DoubleSide,
    });
    const { group, mesh } = instance(source);
    applyPartMaterial(group, { color: "#000000" });
    const material = mesh.material as THREE.MeshStandardMaterial;
    expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(material.color.getHexString()).toBe("aabbcc");
    expect(material.map).not.toBe(map);
    expect(material.map?.source).toBe(map.source);
    expect(material.normalMap?.source).toBe(normal.source);
    expect(material.opacity).toBe(0.4);
    expect(material.transparent).toBe(true);
    expect(material.side).toBe(THREE.DoubleSide);
    expect(source.color.getHexString()).toBe("aabbcc");
  });
  it("applies color and PBR parameters to every submesh and material slot", () => {
    const { group, mesh } = instance([
      new THREE.MeshBasicMaterial({ color: "red" }),
      new THREE.MeshStandardMaterial({ color: "blue" }),
    ]);
    const nested = instance(new THREE.MeshPhysicalMaterial({ clearcoat: 0.9 }));
    group.add(nested.group);
    applyPartMaterial(group, appearance);
    const materials = [
      ...(mesh.material as THREE.Material[]),
      nested.mesh.material as THREE.Material,
    ];
    for (const material of materials as THREE.MeshStandardMaterial[]) {
      expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
      expect(material.color.getHexString()).toBe("bf603a");
      expect(material.metalness).toBe(0.8);
      expect(material.roughness).toBe(0.25);
    }
    expect((nested.mesh.material as THREE.MeshPhysicalMaterial).clearcoat).toBe(
      0.9,
    );
  });
  it("preserves source colors on request while changing metalness and roughness", () => {
    const { group, mesh } = instance(
      new THREE.MeshStandardMaterial({ color: "#235987" }),
    );
    applyPartMaterial(group, {
      ...appearance,
      material: { ...appearance.material, useSourceColor: true },
    });
    expect(
      (mesh.material as THREE.MeshStandardMaterial).color.getHexString(),
    ).toBe("235987");
    expect((mesh.material as THREE.MeshStandardMaterial).metalness).toBe(0.8);
  });
  it("isolates two instances that originally share source materials", () => {
    const shared = new THREE.MeshStandardMaterial({
      color: "#114477",
      roughness: 0.7,
    });
    const first = instance(shared),
      second = instance(shared);
    applyPartMaterial(first.group, appearance);
    applyPartMaterial(second.group, { color: "#000000" });
    expect(
      (first.mesh.material as THREE.MeshStandardMaterial).color.getHexString(),
    ).toBe("bf603a");
    expect(
      (second.mesh.material as THREE.MeshStandardMaterial).color.getHexString(),
    ).toBe("114477");
    expect((second.mesh.material as THREE.MeshStandardMaterial).roughness).toBe(
      0.7,
    );
    expect(shared.color.getHexString()).toBe("114477");
    expect(first.mesh.material).not.toBe(second.mesh.material);
  });
  it("leaves wire guides, labels and explicitly marked editor overlays alone", () => {
    const group = new THREE.Group();
    const line = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: "blue" }),
    );
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial());
    const overlay = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshBasicMaterial(),
    );
    overlay.userData.editorOverlay = true;
    const originals = [line.material, sprite.material, overlay.material];
    group.add(line, sprite, overlay);
    applyPartMaterial(group, appearance);
    expect([line.material, sprite.material, overlay.material]).toEqual(
      originals,
    );
  });
});
describe("material project and component persistence", () => {
  it("round-trips editable appearance without changing functional properties", () => {
    const project = demoProject();
    project.parts[0].material = { ...appearance.material };
    expect(parseProject(JSON.stringify(project))).toEqual(project);
  });
  it.each([
    { metalness: -0.1, roughness: 0.5 },
    { metalness: 0.5, roughness: 1.1 },
    { metalness: "0.5", roughness: 0.5 },
    { metalness: 0.5 },
    { metalness: 0.5, roughness: 0.5, useSourceColor: "yes" },
  ])("rejects invalid imported material %j", (material) => {
    const project = demoProject();
    (project.parts[0] as unknown as Record<string, unknown>).material =
      material;
    expect(() => parseProject(JSON.stringify(project))).toThrow();
  });
  it("preserves component material through validation and creates independent instance data", () => {
    const bytes = binaryStlTriangle();
    const definition = validateComponentDefinition({
      version: 1,
      id: "material-component",
      name: "PBR 自定义件",
      kind: "asset",
      size: [2, 3, 4],
      ...appearance,
      params: {},
      interaction: {
        version: 1,
        status: "configured",
        axis: [0, 1, 0],
        anchor: [0, 0, 0],
        proxySize: [2, 3, 4],
      },
      model: {
        id: "material-model",
        name: "triangle.stl",
        format: "stl",
        data: Buffer.from(bytes).toString("base64"),
        sha256: sha256Bytes(bytes),
        bytes: bytes.length,
        size: [2, 3, 4],
        center: [2, 3.5, 5],
      },
    });
    expect(definition.material).toEqual(appearance.material);
    const part = createPartFromComponent(definition);
    expect(part.material).toEqual(appearance.material);
    expect(part.material).not.toBe(definition.material);
    const restored = parseProject(
      JSON.stringify({
        version: 1,
        name: "材质",
        parts: [part],
        wires: [],
        models: [definition.model],
      }),
    );
    expect(restored.parts[0].material).toEqual(appearance.material);
  });
});
