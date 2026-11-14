import { describe, it, expect } from "vitest";
import { bayonetFixture, bayonetSolids } from "../src/engine/bayonet";
import { validateAssembly, validateMotion } from "../src/engine/physics";
import type { Part, Vec3 } from "../src/types";
const { pin, socket } = bayonetFixture();
const seated: Part = { ...pin, position: [0, 18, 0] };
const locked: Part = { ...seated, rotation: [0, 45, 0] };
const move = (from: Part, next: Partial<Part>, others: Part[] = [socket]) =>
  validateMotion([...others, from], from.id, { ...from, ...next });
describe("two-lug bayonet with real L slots", () => {
  it("uses connected socket walls and real open spaces", () => {
    expect(bayonetSolids(socket).length).toBeGreaterThan(100);
    expect(bayonetSolids(pin).filter((s) => s.role === "lug")).toHaveLength(2);
    expect(validateAssembly([socket, pin]).collisionPairs).toHaveLength(0);
  });
  it("inserts through the axial openings without disabling collisions", () => {
    expect(move(pin, { position: seated.position }).allowed).toBe(true);
  });
  it("rotates 45 degrees only after fully inserted", () => {
    expect(move(seated, { rotation: locked.rotation }).allowed).toBe(true);
    expect(
      move({ ...pin, position: [0, 25, 0] }, { rotation: [0, 45, 0] }).allowed,
    ).toBe(false);
  });
  it("blocks pulling the locked lugs through the retaining roof", () => {
    expect(move(locked, { position: [0, 19, 0] }).allowed).toBe(false);
    expect(move(locked, { position: pin.position }).allowed).toBe(false);
  });
  it("can reverse to entry then withdraw along the real path", () => {
    expect(move(locked, { rotation: [0, 0, 0] }).allowed).toBe(true);
    expect(move(seated, { position: pin.position }).allowed).toBe(true);
  });
  it("rejects misaligned entry and wrong direction or excessive rotation", () => {
    expect(
      move({ ...pin, rotation: [0, 45, 0] }, { position: seated.position })
        .allowed,
    ).toBe(false);
    expect(move(seated, { rotation: [0, -45, 0] }).allowed).toBe(false);
    expect(move(locked, { rotation: [0, 70, 0] }).allowed).toBe(false);
  });
  it("reports conservative dimensional clearance at the locked position", () => {
    const result = validateAssembly([socket, locked]);
    expect(result.collisionPairs).toHaveLength(0);
    expect(result.minClearance).toBeGreaterThan(0.19);
    expect(
      result.issues.some(
        (i) => i.title === "旋锁已进入保持区" && i.severity === "pass",
      ),
    ).toBe(true);
  });
  it("rejects tight holes and excessive full-width tolerances", () => {
    expect(
      move(pin, { position: seated.position }, [
        { ...socket, params: { ...socket.params, holeDiameter: 8.8 } },
      ]).allowed,
    ).toBe(false);
    const result = validateAssembly([
      { ...socket, params: { ...socket.params, tolerance: 0.5 } },
      { ...locked, params: { tolerance: 0.5 } },
    ]);
    expect(
      result.issues.some(
        (i) => i.title === "旋锁最坏公差不足" && i.severity === "error",
      ),
    ).toBe(true);
  });
  it("checks collisions with external neighbors during the rotation", () => {
    const obstacle: Part = {
      ...pin,
      id: "obstacle",
      kind: "tenon",
      position: [5.5, 10, 5.5],
      size: [1, 2, 1],
      rotation: [0, 0, 0],
    };
    expect(
      move(seated, { rotation: locked.rotation }, [socket, obstacle]).allowed,
    ).toBe(false);
  });
  it("supports a rotated insertion axis rather than relying on world-Y exceptions", () => {
    const rotate = (v: Vec3): Vec3 => [v[0], -v[2] + 40, v[1]];
    const tiltedSocket = {
      ...socket,
      position: rotate(socket.position),
      rotation: [90, 0, 0] as Vec3,
    };
    const tiltedPin = {
      ...pin,
      position: rotate(pin.position),
      rotation: [90, 0, 0] as Vec3,
    };
    expect(
      move(tiltedPin, { position: rotate(seated.position) }, [tiltedSocket])
        .allowed,
    ).toBe(true);
    expect(
      move(
        { ...tiltedPin, position: rotate(seated.position) },
        { rotation: [90, 45, 0] },
        [tiltedSocket],
      ).allowed,
    ).toBe(true);
  });
});

it("fully withdraws and allows fine axial steps inside the vertical entrance", () => {
  expect(move(seated, { position: [0, 35, 0] }).allowed).toBe(true);
  expect(35 - pin.size[1] / 2).toBeGreaterThan(
    socket.position[1] + socket.size[1] / 2,
  );
  expect(move(seated, { position: [0, 18.25, 0] }).allowed).toBe(true);
});

it("uses the real tilted bayonet for floor clearance and blocks actual floor penetration", () => {
  const tilted: Part = { ...pin, position: [0, 13, 0], rotation: [0, 0, 45] };
  const actualMinimum = Math.min(
    ...bayonetSolids(tilted).flatMap((shape) =>
      shape.vertices.map((v) => (v[0] + v[1]) / Math.SQRT2 + 13),
    ),
  );
  expect(actualMinimum).toBeCloseTo(1.71457577, 6);
  expect(
    validateAssembly([tilted]).issues.some(
      (i) => i.id === `floor-${tilted.id}`,
    ),
  ).toBe(false);
  expect(
    move({ ...tilted, position: [0, 14, 0] }, { position: tilted.position }, [])
      .allowed,
  ).toBe(true);
  expect(move(tilted, { position: [0, 12, 0] }, []).allowed).toBe(true);
  const blocked = move(tilted, { position: [0, 11, 0] }, []);
  expect(blocked.allowed).toBe(false);
  expect(blocked.issues.some((i) => i.id === `floor-${tilted.id}`)).toBe(true);
  expect(
    validateAssembly([{ ...tilted, position: [0, 11, 0] }]).issues.some(
      (i) => i.id === `floor-${tilted.id}` && i.severity === "error",
    ),
  ).toBe(true);
});
