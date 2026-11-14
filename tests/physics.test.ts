import { describe, expect, it } from "vitest";
import {
  solveCircuit,
  stepSpring,
  validateAssembly,
  validateMotion,
} from "../src/engine/physics";
import type { Part, Wire } from "../src/types";

const part = (
  id: string,
  kind: Part["kind"],
  overrides: Partial<Part> = {},
): Part => ({
  id,
  name: id,
  kind,
  position: [0, 10, 0],
  rotation: [0, 0, 0],
  size: [10, 10, 10],
  color: "#aaa",
  fixed: false,
  visible: true,
  params: {},
  ...overrides,
});
const mortise = part("socket", "mortise", {
  position: [-18, 13, 0],
  size: [24, 18, 24],
  params: { innerWidth: 12.4, innerDepth: 12.4, tolerance: 0.05 },
});
const tenon = part("peg", "tenon", {
  position: [-18, 35, 0],
  size: [12, 26, 12],
  params: { tolerance: 0.05 },
});
const base = part("base", "base", {
  position: [0, 2, 0],
  size: [86, 4, 64],
  fixed: true,
});
const wire = (
  id: string,
  a: string,
  ta: 0 | 1,
  b: string,
  tb: 0 | 1,
): Wire => ({
  id,
  from: { partId: a, terminal: ta },
  to: { partId: b, terminal: tb },
  color: "#555",
});

describe("geometry and complete movement paths", () => {
  it("allows a tenon to enter the actual mortise void", () => {
    const next = {
      ...tenon,
      position: [-18, 23, 0] as [number, number, number],
    };
    expect(validateMotion([base, mortise, tenon], tenon.id, next).allowed).toBe(
      true,
    );
    const result = validateAssembly([base, mortise, next]);
    expect(result.collisionPairs).toEqual([]);
    expect(result.minClearance).toBeCloseTo(0.15);
    expect(result.issues.some((i) => i.title === "插入配合")).toBe(true);
  });
  it("rejects a lateral movement through the wall after insertion", () => {
    const inserted = {
      ...tenon,
      position: [-18, 23, 0] as [number, number, number],
    };
    expect(
      validateMotion([base, mortise, inserted], inserted.id, {
        ...inserted,
        position: [30, 23, 0],
      }).allowed,
    ).toBe(false);
  });
  it("checks intermediate positions even when both endpoints are clear", () => {
    const obstacle = part("wall", "base", { size: [0.5, 20, 30] });
    const moving = part("moving", "tenon", {
      position: [-10, 10, 0],
      size: [2, 2, 2],
    });
    expect(
      validateMotion([obstacle, moving], moving.id, {
        ...moving,
        position: [10, 10, 0],
      }).allowed,
    ).toBe(false);
  });
  it("rejects rotational interference in the mortise", () => {
    const inserted = {
      ...tenon,
      position: [-18, 23, 0] as [number, number, number],
    };
    expect(
      validateMotion([mortise, inserted], inserted.id, {
        ...inserted,
        rotation: [0, 45, 0],
      }).allowed,
    ).toBe(false);
  });
  it("uses rotated solids rather than axis-aligned bounds", () => {
    const a = part("a", "base", {
      position: [0, 10, 0],
      size: [20, 2, 2],
      rotation: [0, 45, 0],
    });
    const b = part("b", "base", {
      position: [0, 10, 4],
      size: [20, 2, 2],
      rotation: [0, 45, 0],
    });
    expect(validateAssembly([a, b]).collisionPairs).toEqual([]);
  });
  it("counts touching faces as contact, not penetration", () => {
    const a = part("a", "base");
    const b = part("b", "base", { position: [10, 10, 0] });
    expect(validateAssembly([a, b]).collisionPairs).toEqual([]);
  });
  it("checks hidden objects as physical solids", () => {
    expect(
      validateAssembly([
        part("a", "base"),
        part("b", "base", { visible: false }),
      ]).collisionPairs,
    ).toEqual([["a", "b"]]);
  });
  it("blocks movement of fixed parts and passage through the floor", () => {
    expect(
      validateMotion([base], base.id, { ...base, position: [2, 2, 0] }).allowed,
    ).toBe(false);
    expect(
      validateMotion([tenon], tenon.id, { ...tenon, position: [-18, 1, 0] })
        .allowed,
    ).toBe(false);
  });
  it("rejects nominal fits which fail worst-case tolerance", () => {
    const tight = {
      ...mortise,
      params: { innerWidth: 12.05, innerDepth: 12.05, tolerance: 0.05 },
    };
    const inserted = {
      ...tenon,
      position: [-18, 23, 0] as [number, number, number],
    };
    const result = validateAssembly([tight, inserted]);
    expect(result.collisionPairs).toEqual([]);
    expect(
      result.issues.some((i) => i.category === "fit" && i.severity === "error"),
    ).toBe(true);
  });
  it("allows coaxial round pin insertion without a square-envelope false positive", () => {
    const sleeve = part("s", "sleeve", {
      position: [0, 10, 0],
      size: [14, 20, 14],
      params: { holeDiameter: 10.4 },
    });
    const peg = part("p", "pin", { position: [0, 20, 0], size: [10, 20, 10] });
    expect(validateAssembly([sleeve, peg]).collisionPairs).toEqual([]);
    expect(
      validateMotion([sleeve, peg], peg.id, { ...peg, position: [0, 10, 0] })
        .allowed,
    ).toBe(true);
    expect(
      validateMotion([sleeve, peg], peg.id, { ...peg, position: [3, 20, 0] })
        .allowed,
    ).toBe(false);
  });
  it("does not mislabel intersecting repository envelopes as confirmed collision", () => {
    const result = validateAssembly([part("a", "asset"), part("b", "asset")]);
    expect(result.collisionPairs).toEqual([]);
    expect(
      result.issues.some(
        (i) => i.id === "proxy-a-b" && i.severity === "warning",
      ),
    ).toBe(true);
  });
  it("rejects nonfinite input and holes larger than their outer bodies", () => {
    expect(
      validateAssembly([
        part("a", "base", { position: [NaN, 0, 0] }),
      ]).issues.some((i) => i.severity === "error"),
    ).toBe(true);
    expect(
      validateAssembly([
        { ...mortise, params: { innerWidth: 40, innerDepth: 12 } },
      ]).issues.some((i) => i.id === "hole-socket"),
    ).toBe(true);
  });
});

describe("DC electrical graph", () => {
  const battery = part("battery", "battery", { params: { voltage: 6 } });
  const lamp = part("lamp", "lamp", {
    params: { resistance: 120, voltage: 6 },
  });
  it("requires a complete return path", () => {
    const result = solveCircuit(
      [battery, lamp],
      [wire("w1", "battery", 0, "lamp", 0)],
      [],
    );
    expect(result.poweredLampIds).toEqual([]);
    expect(result.current).toBe(0);
  });
  it("solves current from actual load resistance", () => {
    const result = solveCircuit(
      [battery, lamp],
      [
        wire("w1", "battery", 0, "lamp", 0),
        wire("w2", "lamp", 1, "battery", 1),
      ],
      [],
    );
    expect(result.poweredLampIds).toEqual(["lamp"]);
    expect(result.current).toBeCloseTo(0.05);
  });
  it("calculates a series resistor and closed switch, and opens on release", () => {
    const resistor = part("resistor", "resistor", {
      params: { resistance: 80 },
    });
    const button = part("button", "button");
    const wires = [
      wire("w1", "battery", 0, "button", 0),
      wire("w2", "button", 1, "resistor", 0),
      wire("w3", "resistor", 1, "lamp", 0),
      wire("w4", "lamp", 1, "battery", 1),
    ];
    expect(
      solveCircuit([battery, lamp, resistor, button], wires, []).poweredLampIds,
    ).toEqual([]);
    expect(
      solveCircuit([battery, lamp, resistor, button], wires, ["button"])
        .current,
    ).toBeCloseTo(0.03);
  });
  it("calculates parallel branches without confusing any connected lamp with a powered one", () => {
    const other = part("other", "lamp", { params: { resistance: 120 } });
    const wires = [
      wire("a", "battery", 0, "lamp", 0),
      wire("b", "lamp", 1, "battery", 1),
      wire("c", "battery", 0, "other", 0),
      wire("d", "other", 1, "battery", 1),
    ];
    expect(solveCircuit([battery, lamp, other], wires, []).current).toBeCloseTo(
      0.1,
    );
    expect(
      solveCircuit([battery, lamp, other], wires.slice(0, 3), [])
        .poweredLampIds,
    ).toEqual(["lamp"]);
  });
  it("detects direct and switched shorts and never lights a bypassed lamp", () => {
    const wires = [
      wire("a", "battery", 0, "lamp", 0),
      wire("b", "lamp", 1, "battery", 1),
      wire("short", "battery", 0, "battery", 1),
    ];
    const result = solveCircuit([battery, lamp], wires, []);
    expect(result.shortCircuit).toBe(true);
    expect(result.poweredLampIds).toEqual([]);
    const button = part("button", "button");
    const switched = [
      wire("a", "battery", 0, "button", 0),
      wire("b", "button", 1, "battery", 1),
    ];
    expect(solveCircuit([battery, button], switched, []).shortCircuit).toBe(
      false,
    );
    expect(
      solveCircuit([battery, button], switched, ["button"]).shortCircuit,
    ).toBe(true);
  });
  it("reports dangling or non-electrical terminals", () => {
    const result = solveCircuit(
      [battery],
      [wire("bad", "battery", 0, "deleted", 1)],
      [],
    );
    expect(result.issues.some((i) => i.id === "wire-bad")).toBe(true);
  });
  it("supports two series voltage sources", () => {
    const second = part("second", "battery", { params: { voltage: 6 } });
    const result = solveCircuit(
      [battery, second, lamp],
      [
        wire("a", "battery", 1, "second", 0),
        wire("b", "battery", 0, "lamp", 0),
        wire("c", "lamp", 1, "second", 1),
      ],
      [],
    );
    expect(result.current).toBeCloseTo(0.2); // Two source branches each supply 0.1 A.
    expect(result.poweredLampIds).toEqual(["lamp"]);
    expect(result.issues.some((i) => i.id === "overvoltage-lamp")).toBe(true);
  });
});

describe("spring dynamics", () => {
  const params = {
    stiffness: 1,
    damping: 0.8,
    mass: 0.02,
    travel: 3,
    force: 1,
  };
  it("converges to F/k with N/mm and kg units", () => {
    let state = { displacement: 0, velocity: 0, force: 0 };
    for (let i = 0; i < 240; i++) state = stepSpring(state, 1 / 60, params);
    expect(state.displacement).toBeCloseTo(1, 4);
    expect(state.force).toBeCloseTo(1, 4);
  });
  it("returns after release and does not cross either travel limit", () => {
    let state = stepSpring({ displacement: 0, velocity: 0, force: 0 }, 1, {
      ...params,
      force: 100,
    });
    expect(state.displacement).toBe(3);
    for (let i = 0; i < 180; i++)
      state = stepSpring(state, 1 / 60, { ...params, force: 0 });
    expect(state.displacement).toBeCloseTo(0, 6);
    expect(state.velocity).toBeCloseTo(0, 6);
  });
  it("remains finite with stiff springs and a delayed frame", () => {
    const state = stepSpring({ displacement: 1, velocity: 30, force: 0 }, 0.5, {
      ...params,
      stiffness: 10000,
      mass: 0.0001,
    });
    expect(Number.isFinite(state.displacement)).toBe(true);
    expect(state.displacement).toBeGreaterThanOrEqual(0);
    expect(state.displacement).toBeLessThanOrEqual(3);
  });
  it("does not corrupt the state for invalid parameters", () => {
    const state = { displacement: 1, velocity: 0, force: 1 };
    expect(stepSpring(state, 0.016, { ...params, mass: 0 })).toEqual(state);
  });
});

it("rejects inconsistent cylindrical width/depth instead of claiming a valid dimension check", () => {
  for (const kind of ["pin", "sleeve"] as const) {
    const result = validateAssembly([
      part("cylinder", kind, {
        size: [10, 10, 8],
        params: { holeDiameter: 6 },
      }),
    ]);
    expect(
      result.issues.some(
        (i) => i.id === "diameter-cylinder" && i.severity === "error",
      ),
    ).toBe(true);
  }
});
