import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  applyVisualDeformation,
  deformationMatrix,
} from "../src/visualDeformation";

function fixture() {
  const source = new THREE.Mesh(
    new THREE.BoxGeometry(4, 10, 6),
    new THREE.MeshStandardMaterial({
      color: "#678ba4",
      metalness: 0.7,
      roughness: 0.2,
    }),
  );
  const first = new THREE.Group(),
    second = new THREE.Group();
  first.add(source.clone());
  second.add(source.clone());
  return { source, first, second };
}
function expectVector(actual: THREE.Vector3, expected: number[]) {
  actual
    .toArray()
    .forEach((value, index) => expect(value).toBeCloseTo(expected[index], 8));
}
describe("visual deformation of assembled mechanisms", () => {
  it("compresses the local spring axis while retaining cross-section dimensions", () => {
    const { first } = fixture();
    applyVisualDeformation(first, { axis: [0, 1, 0], ratio: 0.4 });
    expectVector(
      new THREE.Box3().setFromObject(first).getSize(new THREE.Vector3()),
      [4, 4, 6],
    );
    expectVector(
      new THREE.Box3().setFromObject(first).getCenter(new THREE.Vector3()),
      [0, 0, 0],
    );
  });
  it("compresses an arbitrary axis and leaves both perpendicular directions unchanged", () => {
    const matrix = deformationMatrix({ axis: [0.6, 0.8, 0], ratio: 0.3 });
    expectVector(
      new THREE.Vector3(6, 8, 0).applyMatrix4(matrix),
      [1.8, 2.4, 0],
    );
    expectVector(new THREE.Vector3(-8, 6, 0).applyMatrix4(matrix), [-8, 6, 0]);
    expectVector(new THREE.Vector3(0, 0, 10).applyMatrix4(matrix), [0, 0, 10]);
    expect(matrix.determinant()).toBeCloseTo(0.3);
  });
  it("moves contact points and selection frames through the same local deformation and world pose", () => {
    const world = new THREE.Group(),
      wrapper = new THREE.Group();
    world.position.set(12, 7, 3);
    world.rotation.z = Math.PI / 2;
    world.add(wrapper);
    applyVisualDeformation(wrapper, { axis: [0, 1, 0], ratio: 0.5 });
    expectVector(wrapper.localToWorld(new THREE.Vector3(0, 5, 0)), [9.5, 7, 3]);
    const selectedFrame = new THREE.Group();
    applyVisualDeformation(selectedFrame, { axis: [0, 1, 0], ratio: 0.5 });
    expect(selectedFrame.matrix.elements).toEqual(wrapper.matrix.elements);
  });
  it("animates and restores without rebuilding geometry or mutating another instance/source PBR material", () => {
    const { source, first, second } = fixture();
    const mesh = first.children[0] as THREE.Mesh;
    const vertices = Array.from(source.geometry.attributes.position.array);
    const geometry = mesh.geometry,
      material = mesh.material;
    for (let index = 0; index < 100; index++)
      applyVisualDeformation(first, {
        axis: [0, 1, 0],
        ratio: 1 - index / 200,
      });
    expect(mesh.geometry).toBe(geometry);
    expect(mesh.material).toBe(material);
    expect(Array.from(source.geometry.attributes.position.array)).toEqual(
      vertices,
    );
    expectVector(
      new THREE.Box3().setFromObject(second).getSize(new THREE.Vector3()),
      [4, 10, 6],
    );
    expect(
      (source.material as THREE.MeshStandardMaterial).color.getHexString(),
    ).toBe("678ba4");
    expect((source.material as THREE.MeshStandardMaterial).metalness).toBe(0.7);
    applyVisualDeformation(first, undefined);
    expectVector(
      new THREE.Box3().setFromObject(first).getSize(new THREE.Vector3()),
      [4, 10, 6],
    );
  });
  it("keeps a reusable finite, invertible display matrix for collapsed or invalid preview data", () => {
    const target = new THREE.Matrix4();
    expect(deformationMatrix({ axis: [0, 1, 0], ratio: 0 }, target)).toBe(
      target,
    );
    expect(target.determinant()).toBeGreaterThan(0);
    expect(
      deformationMatrix({ axis: [0, 0, 0], ratio: Number.NaN }, target)
        .elements,
    ).toEqual(new THREE.Matrix4().elements);
  });
});
