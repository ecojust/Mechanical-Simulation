import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { ContactMarkerLayer } from "../src/contactMarkers";

describe("mechanism contact editor overlays", () => {
  it("moves the striker through actual world coordinates while keeping the fixed trigger point stationary", () => {
    const layer = new ContactMarkerLayer();
    layer.update([
      {
        id: "switch",
        striker: [10, 14, 8],
        target: [10, 10, 8],
        contact: false,
      },
    ]);
    const striker = layer.group.getObjectByName(
      "mechanismStrikerMarker",
    ) as THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
    const target = layer.group.getObjectByName(
      "mechanismTargetMarker",
    ) as THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
    const geometry = striker.geometry,
      material = striker.material;
    expect(striker.material.color.equals(target.material.color)).toBe(false);
    layer.update([
      {
        id: "switch",
        striker: [10, 10, 8],
        target: [10, 10, 8],
        contact: true,
      },
    ]);
    expect(layer.poses()).toEqual({
      switch: { striker: [10, 10, 8], target: [10, 10, 8], contact: true },
    });
    expect(striker.material.color.equals(target.material.color)).toBe(true);
    expect(striker.geometry).toBe(geometry);
    expect(striker.material).toBe(material);
    expect(striker.userData.editorOverlay).toBe(true);
    expect(striker.material.depthTest).toBe(false);
  });
  it("reports renderer object positions instead of echoing the supplied marker definitions", () => {
    const layer = new ContactMarkerLayer();
    layer.update([
      { id: "switch", striker: [1, 2, 3], target: [4, 5, 6], contact: false },
    ]);
    layer.group
      .getObjectByName("mechanismStrikerMarker")!
      .position.set(7, 8, 9);
    expect(layer.poses().switch.striker).toEqual([7, 8, 9]);
  });
  it("removes deselected or invalid markers and disposes their display resources", () => {
    const layer = new ContactMarkerLayer();
    layer.update([
      { id: "switch", striker: [1, 2, 3], target: [4, 5, 6], contact: false },
    ]);
    const striker = layer.group.getObjectByName(
      "mechanismStrikerMarker",
    ) as THREE.Mesh;
    let disposed = false;
    striker.geometry.addEventListener("dispose", () => {
      disposed = true;
    });
    layer.update([
      {
        id: "switch",
        striker: [Number.NaN, 2, 3],
        target: [4, 5, 6],
        contact: false,
      },
    ]);
    expect(layer.group.children).toHaveLength(0);
    expect(layer.poses()).toEqual({});
    expect(disposed).toBe(true);
  });
});
