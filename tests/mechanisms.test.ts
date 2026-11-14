import { describe, expect, it } from "vitest";
import { Euler, Quaternion, Vector3 } from "three";
import { deformationMatrix } from "../src/visualDeformation";
import { parseProject, makePart } from "../src/catalog";
import { bayonetFixture } from "../src/engine/bayonet";
import { solveCircuit } from "../src/engine/physics";
import {
  createMechanism,
  mechanismScene,
  mechanismContact,
  mechanismDefinitionIssues,
  validateMechanismProject,
  validateMechanismUpdate,
  moveMechanism,
  stepMechanisms,
  transformMechanismFrame,
} from "../src/mechanisms";
import type {
  Mechanism,
  MechanismStates,
  Part,
  Project,
  Vec3,
} from "../src/types";

function visual(
  id: string,
  kind: Part["kind"],
  position: Vec3,
  size: Vec3,
): Part {
  return {
    id,
    kind,
    name: id,
    position,
    rotation: [0, 0, 0],
    size,
    color: "#8899aa",
    fixed: false,
    visible: true,
    params: { assetUrl: "./models/buttons-left.glb", assetNode: id },
    ...(kind !== "asset"
      ? {
          interaction: {
            version: 1,
            status: "unconfigured",
            axis: [0, 1, 0],
            anchor: [0, 0, 0],
            proxySize: size,
          },
        }
      : {}),
  };
}
function pressProject(): Project {
  const parts = [
    visual("cap", "pin", [0, 24, 0], [8, 2, 8]),
    visual("stem", "asset", [0, 22, 0], [2, 2, 2]),
    visual("housing", "sleeve", [0, 10, 0], [12, 6, 12]),
    visual("coil", "spring", [0, 18, 0], [4, 10, 4]),
    visual("contact", "asset", [0, 19.4, 0], [2, 2, 2]),
  ];
  const mechanism: Mechanism = {
    ...createMechanism("press", parts),
    id: "press",
    name: "多件回弹组件",
    status: "configured",
    movingPartIds: ["cap", "stem"],
    springPartIds: ["coil"],
    switchPartId: "contact",
    contact: {
      strikerPartId: "stem",
      strikerPoint: [0, -1, 0],
      switchPoint: [0, 1, 0],
      switchNormal: [0, 1, 0],
      radius: 0.5,
      maxOvertravel: 1.4,
    },
    frame: { position: [0, 20, 0], rotation: [0, 0, 0] },
    params: {
      stiffness: 1,
      mass: 0.02,
      damping: 0.8,
      travel: 2,
      trigger: 0.6,
      freeLength: 10,
      solidLength: 5,
    },
    movingProxy: {
      kind: "base",
      position: [0, 4, 0],
      rotation: [0, 0, 0],
      size: [8, 2, 8],
      params: {},
    },
    fixedProxy: {
      kind: "base",
      position: [0, -10, 0],
      rotation: [0, 0, 0],
      size: [12, 6, 12],
      params: {},
    },
  };
  return {
    version: 1,
    name: "press",
    parts,
    wires: [],
    mechanisms: [mechanism],
  };
}
function matingProject(): Project {
  const fixture = bayonetFixture();
  const cap = visual("cap", "asset", fixture.pin.position, [16, 24, 16]);
  const label = visual("label", "asset", [1, 42, 0], [2, 1, 2]);
  const housing = visual(
    "housing",
    "asset",
    fixture.socket.position,
    [24, 18, 24],
  );
  const parts = [cap, label, housing];
  const mechanism: Mechanism = {
    ...createMechanism("mating", parts),
    id: "joint",
    status: "configured",
    movingPartIds: [cap.id, label.id],
    frame: { position: fixture.socket.position, rotation: [0, 0, 0] },
    params: { insertionDepth: 18, minClearance: 0.05, lockAngle: 45 },
    movingProxy: {
      kind: "bayonet-pin",
      position: [0, 19, 0],
      rotation: [0, 0, 0],
      size: [16, 24, 16],
      params: { tolerance: 0.1 },
    },
    fixedProxy: {
      kind: "bayonet-socket",
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      size: [24, 18, 24],
      params: { tolerance: 0.1, holeDiameter: 9.6 },
    },
  };
  return {
    version: 1,
    name: "joint",
    parts,
    wires: [],
    mechanisms: [mechanism],
  };
}

describe("compound functional mechanisms", () => {
  it("persists mechanism roles and permits its declared switch to own circuit terminals", () => {
    const project = pressProject();
    const lamp = makePart("lamp", [30, 10, 0]);
    project.parts.push(lamp);
    project.wires.push({
      id: "wire",
      from: { partId: "contact", terminal: 0 },
      to: { partId: lamp.id, terminal: 0 },
      color: "#aa5500",
    });
    expect(parseProject(JSON.stringify(project))).toEqual(project);
    const dangling = structuredClone(project);
    dangling.mechanisms![0].movingPartIds.push("missing");
    expect(() => parseProject(JSON.stringify(dangling))).toThrow(/成员/);
    const duplicate = structuredClone(project);
    duplicate.mechanisms!.push({
      ...duplicate.mechanisms![0],
      id: "duplicate",
    });
    expect(() => parseProject(JSON.stringify(duplicate))).toThrow(
      /多个功能组件/,
    );
  });
  it("uses one configured compound behavior while retaining unconfigured child meshes only for display", () => {
    const project = pressProject(),
      result = validateMechanismProject(project),
      scene = mechanismScene(project);
    expect(result.issues.filter((issue) => issue.severity === "error")).toEqual(
      [],
    );
    expect(scene.physicsParts).toHaveLength(2);
    expect(scene.renderParts).toEqual(project.parts);
    expect(
      result.issues.some((issue) => issue.id === "mechanism-press-accuracy"),
    ).toBe(true);
    project.mechanisms![0].status = "unconfigured";
    expect(
      validateMechanismProject(project).issues.some(
        (issue) => issue.severity === "error",
      ),
    ).toBe(true);
    expect(
      stepMechanisms(project, {}, 1 / 60, ["press"]).states.press,
    ).toBeUndefined();
  });
  it("moves all active members together, compresses only the spring and rebounds after release", () => {
    const project = pressProject();
    let states: MechanismStates = {};
    for (let i = 0; i < 90; i++) {
      const step = stepMechanisms(project, states, 1 / 240, ["press"]);
      expect(step.issues).toEqual([]);
      states = step.states;
    }
    expect(states.press.displacement).toBeCloseTo(2, 5);
    const scene = mechanismScene(project, states);
    expect(
      scene.renderParts.find((part) => part.id === "cap")!.position,
    ).toEqual([0, 22, 0]);
    expect(
      scene.renderParts.find((part) => part.id === "stem")!.position,
    ).toEqual([0, 20, 0]);
    expect(
      scene.renderParts.find((part) => part.id === "housing")!.position,
    ).toEqual([0, 10, 0]);
    expect(
      scene.renderParts.find((part) => part.id === "coil")!.position,
    ).toEqual([0, 17, 0]);
    expect(scene.renderParts.find((part) => part.id === "coil")!.size).toEqual([
      4, 10, 4,
    ]);
    expect(scene.deformations.coil).toEqual({ axis: [0, 1, 0], ratio: 0.8 });
    expect(scene.pressedIds).toEqual(["contact"]);
    expect(project.parts[0].position).toEqual([0, 24, 0]);
    for (let i = 0; i < 120; i++)
      states = stepMechanisms(project, states, 1 / 240, []).states;
    expect(states.press.displacement).toBeLessThan(0.001);
    expect(mechanismScene(project, states).pressedIds).toEqual([]);
  });
  it("closes and reopens a real DC circuit through the declared switch child", () => {
    const project = pressProject(),
      battery = makePart("battery", [30, 10, 0]),
      lamp = makePart("lamp", [50, 10, 0]);
    project.parts.push(battery, lamp);
    project.wires = [
      {
        id: "one",
        from: { partId: battery.id, terminal: 0 },
        to: { partId: "contact", terminal: 0 },
        color: "#ff0000",
      },
      {
        id: "two",
        from: { partId: "contact", terminal: 1 },
        to: { partId: lamp.id, terminal: 0 },
        color: "#ff0000",
      },
      {
        id: "three",
        from: { partId: lamp.id, terminal: 1 },
        to: { partId: battery.id, terminal: 1 },
        color: "#000000",
      },
    ];
    const open = mechanismScene(project),
      closed = mechanismScene(project, {
        press: { displacement: 1, velocity: 0, force: 1 },
      });
    expect(
      solveCircuit(open.circuitParts, project.wires, open.pressedIds)
        .poweredLampIds,
    ).toEqual([]);
    expect(
      solveCircuit(closed.circuitParts, project.wires, closed.pressedIds)
        .poweredLampIds,
    ).toEqual([lamp.id]);
  });
  it("stops compound actuation when its swept proxy reaches an external neighbor", () => {
    const project = pressProject(),
      obstacle = makePart("base", [0, 21.5, 0]);
    obstacle.size = [10, 1, 10];
    project.parts.push(obstacle);
    let states: MechanismStates = {},
      blocked = false;
    for (let i = 0; i < 60; i++) {
      const result = stepMechanisms(project, states, 1 / 240, ["press"]);
      states = result.states;
      blocked ||= result.issues.some((issue) => issue.severity === "error");
    }
    expect(blocked).toBe(true);
    expect(states.press.displacement).toBeLessThanOrEqual(1.000001);
  });
  it("rotates the entire frame and applies press deformation along the transformed axis", () => {
    const project = pressProject();
    const move = transformMechanismFrame(project, "press", {
      position: [0, 30, 0],
      rotation: [0, 0, 90],
    });
    expect(move.allowed).toBe(true);
    const rest = mechanismScene(move.project),
      compressed = mechanismScene(move.project, {
        press: { displacement: 2, velocity: 0, force: 2 },
      });
    const before = rest.renderParts[0].position,
      after = compressed.renderParts[0].position;
    expect(after[0] - before[0]).toBeCloseTo(2);
    expect(after[1] - before[1]).toBeCloseTo(0);
    expect(compressed.deformations.coil.axis[1]).toBeCloseTo(1);
  });
  it("inserts and rotates a multi-part bayonet male assembly while its socket stays fixed", () => {
    const project = matingProject();
    expect(
      mechanismDefinitionIssues(project.mechanisms![0], project.parts).filter(
        (issue) => issue.severity === "error",
      ),
    ).toEqual([]);
    const inserted = moveMechanism(project, "joint", { distance: -14 });
    expect(inserted.allowed, JSON.stringify(inserted.issues)).toBe(true);
    expect(inserted.project.parts[0].position[1]).toBeCloseTo(18);
    expect(inserted.project.parts[1].position[1]).toBeCloseTo(28);
    expect(inserted.project.parts[2].position).toEqual(
      project.parts[2].position,
    );
    const locked = moveMechanism(inserted.project, "joint", { angle: 45 });
    expect(locked.allowed).toBe(true);
    expect(locked.project.parts[1].position[0]).toBeCloseTo(Math.SQRT1_2);
    expect(locked.project.parts[1].position[2]).toBeCloseTo(-Math.SQRT1_2);
    expect(
      moveMechanism(locked.project, "joint", { distance: 1 }).allowed,
    ).toBe(false);
    const unlocked = moveMechanism(locked.project, "joint", { angle: -45 });
    expect(unlocked.allowed).toBe(true);
    expect(
      moveMechanism(unlocked.project, "joint", { distance: 14 }).allowed,
    ).toBe(true);
  });
  it("cannot rotate before a bayonet reaches its slot or pass a neighboring rigid body", () => {
    const project = matingProject();
    const partial = moveMechanism(project, "joint", { distance: -7 });
    expect(partial.allowed, JSON.stringify(partial.issues)).toBe(true);
    expect(moveMechanism(partial.project, "joint", { angle: 45 }).allowed).toBe(
      false,
    );
    const obstacle = makePart("base", [0, 42, 0]);
    obstacle.size = [20, 2, 20];
    project.parts.push(obstacle);
    expect(
      transformMechanismFrame(project, "joint", {
        position: [20, 13, 0],
        rotation: [0, 0, 0],
      }).allowed,
    ).toBe(false);
  });
  it("preserves fixed-member locks and rejects overlapping roles and missing physical parameters", () => {
    const project = pressProject();
    project.parts[0].fixed = true;
    expect(
      stepMechanisms(project, {}, 1 / 60, ["press"]).issues.some((issue) =>
        issue.id.endsWith("fixed"),
      ),
    ).toBe(true);
    expect(
      transformMechanismFrame(project, "press", {
        position: [0, 40, 0],
        rotation: [0, 0, 0],
      }).allowed,
    ).toBe(false);
    project.parts[0].fixed = false;
    delete project.mechanisms![0].params.mass;
    expect(
      mechanismDefinitionIssues(project.mechanisms![0], project.parts).some(
        (issue) => issue.id.endsWith("mass"),
      ),
    ).toBe(true);
    project.mechanisms![0].springPartIds.push("cap");
    expect(() => parseProject(JSON.stringify(project))).toThrow(/不同/);
  });
  it("preserves independent electrical members and rejects a wired button without a switch role", () => {
    const project = pressProject(),
      battery = makePart("battery", [30, 20, 0]),
      lamp = makePart("lamp", [50, 20, 0]);
    project.parts.push(battery, lamp);
    project.mechanisms![0].partIds.push(battery.id, lamp.id);
    expect(mechanismScene(project).circuitParts.map((p) => p.id)).toEqual(
      expect.arrayContaining([battery.id, lamp.id, "contact"]),
    );
    const button = makePart("button", [70, 20, 0]);
    project.parts.push(button);
    project.mechanisms![0].partIds.push(button.id);
    project.wires.push({
      id: "connected-button",
      from: { partId: battery.id, terminal: 0 },
      to: { partId: button.id, terminal: 0 },
      color: "#223344",
    });
    expect(
      validateMechanismProject(project).issues.some((issue) =>
        issue.id.endsWith("wired-switch"),
      ),
    ).toBe(true);
    expect(
      stepMechanisms(project, {}, 1 / 60, ["press"]).issues.some((issue) =>
        issue.id.endsWith("wired-switch"),
      ),
    ).toBe(true);
  });
  it("does not allow configuration changes to bypass rig transforms or recalibrate an inserted joint", () => {
    const project = matingProject(),
      mechanism = project.mechanisms![0];
    expect(() =>
      validateMechanismUpdate(project, {
        ...mechanism,
        frame: { position: [0, 50, 0], rotation: [0, 0, 0] },
      }),
    ).toThrow(/受检/);
    expect(() =>
      validateMechanismUpdate(
        { ...project, mechanisms: [] },
        { ...mechanism, pose: { offset: -1, angle: 0 } },
      ),
    ).toThrow(/归零/);
    const inserted = moveMechanism(project, "joint", { distance: -1 }).project,
      current = inserted.mechanisms![0];
    expect(
      validateMechanismUpdate(inserted, { ...current, name: "renamed" }).name,
    ).toBe("renamed");
    expect(() =>
      validateMechanismUpdate(inserted, {
        ...current,
        params: { ...current.params, minClearance: 0 },
      }),
    ).toThrow(/零位/);
  });
  it("operates a bayonet away from the socket origin and still unlocks after a rejected pull", () => {
    let project = matingProject();
    project.mechanisms![0].frame.position = [0, 0, 0];
    project.mechanisms![0].movingProxy.position = [0, 31, 0];
    project.mechanisms![0].fixedProxy.position = [0, 9, 0];
    project.mechanisms![0].params.minClearance = 0.1;
    for (const delta of [{ distance: -10 }, { distance: -7 }, { angle: 45 }]) {
      const step = moveMechanism(project, "joint", delta);
      expect(step.allowed, JSON.stringify(step.issues)).toBe(true);
      project = step.project;
    }
    const blocked = moveMechanism(project, "joint", { distance: 17 });
    expect(blocked.allowed).toBe(false);
    expect(blocked.project).toBe(project);
    const unlocked = moveMechanism(project, "joint", { angle: -45 });
    expect(unlocked.allowed, JSON.stringify(unlocked.issues)).toBe(true);
    expect(unlocked.project.mechanisms![0].pose.angle).toBe(0);
  });
  it("inserts and locks around an arbitrary world axis after rotating the compound frame", () => {
    const rotated = transformMechanismFrame(matingProject(), "joint", {
      position: [0, 30, 0],
      rotation: [0, 0, 90],
    });
    expect(rotated.allowed, JSON.stringify(rotated.issues)).toBe(true);
    const inserted = moveMechanism(rotated.project, "joint", { distance: -14 });
    expect(inserted.allowed, JSON.stringify(inserted.issues)).toBe(true);
    expect(
      inserted.project.parts[0].position[0] -
        rotated.project.parts[0].position[0],
    ).toBeCloseTo(14);
    const locked = moveMechanism(inserted.project, "joint", { angle: 45 });
    expect(locked.allowed, JSON.stringify(locked.issues)).toBe(true);
    expect(
      moveMechanism(locked.project, "joint", { distance: 1 }).allowed,
    ).toBe(false);
  });
  it("uses actual striker contact instead of the legacy trigger scalar to close the switch", () => {
    const project = pressProject();
    project.mechanisms![0].params.trigger = 0.01;
    const before = mechanismScene(project, {
      press: { displacement: 0.1, velocity: 0, force: 0.1 },
    });
    expect(before.pressedIds).toEqual([]);
    expect(before.contacts.press.gap).toBeCloseTo(0.5);
    const reached = mechanismScene(project, {
      press: { displacement: 0.6, velocity: 0, force: 0.6 },
    });
    expect(reached.pressedIds).toEqual(["contact"]);
    expect(reached.contacts.press.strikerWorld).toEqual(
      expect.arrayContaining([0]),
    );
    expect(reached.contacts.press.gap).toBeCloseTo(0);
    expect(reached.contacts.press.triggerTravel).toBeCloseTo(0.6);
  });
  it("rejects missed, unreachable, inverted or overdriven switch geometry", () => {
    for (const edit of [
      (m: Mechanism) => {
        delete m.contact;
      },
      (m: Mechanism) => {
        m.contact!.strikerPoint[0] = 0.8;
        m.contact!.radius = 0.1;
      },
      (m: Mechanism) => {
        m.contact!.switchNormal = [0, -1, 0];
      },
      (m: Mechanism) => {
        m.contact!.maxOvertravel = 0.1;
      },
      (m: Mechanism) => {
        m.contact!.radius = 5;
      },
      (m: Mechanism) => {
        m.contact!.strikerPoint[1] = -20;
      },
      (m: Mechanism) => {
        m.params.travel = 0.3;
      },
    ]) {
      const project = pressProject();
      edit(project.mechanisms![0]);
      expect(
        mechanismDefinitionIssues(project.mechanisms![0], project.parts).some(
          (issue) => issue.severity === "error",
        ),
      ).toBe(true);
      expect(
        mechanismScene(project, {
          press: { displacement: 1, velocity: 0, force: 1 },
        }).pressedIds,
      ).toEqual([]);
      expect(
        stepMechanisms(project, {}, 1 / 60, ["press"]).issues.some(
          (issue) => issue.severity === "error",
        ),
      ).toBe(true);
    }
  });
  it("transforms both declared contact points and the switch normal with the real member rig", () => {
    const project = pressProject(),
      m = project.mechanisms![0];
    const before = mechanismContact(project, m)!;
    const moved = transformMechanismFrame(project, m.id, {
      position: [12, 40, 6],
      rotation: [0, 0, 90],
    });
    expect(moved.allowed).toBe(true);
    const after = mechanismContact(
      moved.project,
      moved.project.mechanisms![0],
    )!;
    expect(after.triggerTravel).toBeCloseTo(before.triggerTravel);
    expect(after.normalWorld[0]).toBeCloseTo(-1);
    expect(after.normalWorld[1]).toBeCloseTo(0);
    const pressed = mechanismScene(moved.project, {
      press: { displacement: 1, velocity: 0, force: 1 },
    });
    expect(pressed.contacts.press.pressed).toBe(true);
    expect(
      pressed.contacts.press.strikerWorld[0] - after.strikerWorld[0],
    ).toBeCloseTo(1);
  });
  it("permits a plain spring mechanism without a switch or trigger field", () => {
    const project = pressProject();
    delete project.mechanisms![0].switchPartId;
    delete project.mechanisms![0].contact;
    delete project.mechanisms![0].params.trigger;
    expect(
      mechanismDefinitionIssues(project.mechanisms![0], project.parts).filter(
        (issue) => issue.severity === "error",
      ),
    ).toEqual([]);
    expect(
      stepMechanisms(project, {}, 1 / 60, ["press"]).states.press.displacement,
    ).toBeGreaterThan(0);
  });
  it("checks fixed-base contact while pressing and checks an upper obstacle while returning", () => {
    const down = pressProject();
    delete down.mechanisms![0].switchPartId;
    delete down.mechanisms![0].contact;
    down.mechanisms![0].fixedProxy.position = [0, 1, 0];
    down.mechanisms![0].fixedProxy.size = [10, 3, 10];
    let states: MechanismStates = {},
      blockedDown = false;
    for (let i = 0; i < 60; i++) {
      const step = stepMechanisms(down, states, 1 / 240, ["press"]);
      states = step.states;
      blockedDown ||= step.issues.some((issue) => issue.severity === "error");
    }
    expect(blockedDown).toBe(true);
    expect(states.press.displacement).toBeLessThanOrEqual(0.500001);
    const up = pressProject(),
      ceiling = makePart("base", [0, 25.5, 0]);
    ceiling.size = [10, 2, 10];
    up.parts.push(ceiling);
    states = { press: { displacement: 2, velocity: 0, force: 2 } };
    let blockedUp = false;
    for (let i = 0; i < 60; i++) {
      const step = stepMechanisms(up, states, 1 / 240, []);
      states = step.states;
      blockedUp ||= step.issues.some((issue) => issue.severity === "error");
    }
    expect(blockedUp).toBe(true);
    expect(states.press.displacement).toBeGreaterThanOrEqual(0.499999);
  });
  it("strictly parses contact frames, role references and finite contact limits", () => {
    const project = pressProject();
    expect(
      parseProject(JSON.stringify(project)).mechanisms![0].contact,
    ).toEqual(project.mechanisms![0].contact);
    for (const contact of [
      { ...project.mechanisms![0].contact!, switchNormal: [0, 0, 0] },
      { ...project.mechanisms![0].contact!, strikerPartId: "housing" },
      { ...project.mechanisms![0].contact!, radius: -1 },
      { ...project.mechanisms![0].contact!, maxOvertravel: -1 },
      { ...project.mechanisms![0].contact!, switchPoint: [0, null, 0] },
    ])
      expect(() =>
        parseProject(
          JSON.stringify({
            ...project,
            mechanisms: [{ ...project.mechanisms![0], contact }],
          }),
        ),
      ).toThrow(/接触/);
  });
  it("rejects a spring visual whose true axial envelope disagrees with its declared free length", () => {
    const project = pressProject();
    project.parts.find((part) => part.id === "coil")!.size[1] = 1;
    expect(
      mechanismDefinitionIssues(project.mechanisms![0], project.parts).some(
        (entry) =>
          entry.id.endsWith("spring-length-coil") && entry.severity === "error",
      ),
    ).toBe(true);
    expect(
      stepMechanisms(project, {}, 1 / 60, ["press"]).states.press,
    ).toBeUndefined();
  });
  it("keeps the fixed spring endpoint unchanged under compression for arbitrary local and world axes", () => {
    for (const axis of [
      [0, 1, 0],
      [0.6, 0.8, 0],
    ] as Vec3[]) {
      let project = pressProject();
      const m = project.mechanisms![0];
      delete m.switchPartId;
      delete m.contact;
      m.axis = axis;
      m.params.freeLength = Math.abs(axis[0]) * 4 + Math.abs(axis[1]) * 10;
      const transformed = transformMechanismFrame(project, m.id, {
        position: [30, 60, 0],
        rotation: [30, 45, 60],
      });
      expect(transformed.allowed, JSON.stringify(transformed.issues)).toBe(
        true,
      );
      project = transformed.project;
      const rest = mechanismScene(project),
        compressed = mechanismScene(project, {
          press: { displacement: 2, velocity: 0, force: 2 },
        });
      const before = rest.renderParts.find((part) => part.id === "coil")!,
        after = compressed.renderParts.find((part) => part.id === "coil")!;
      const fixedPoint = new Vector3(
        ...(before.size.map(
          (size, i) => (-Math.sign(axis[i]) * size) / 2,
        ) as Vec3),
      );
      const orientation = new Quaternion().setFromEuler(
        new Euler(...(before.rotation.map((v) => (v * Math.PI) / 180) as Vec3)),
      );
      const worldBefore = fixedPoint
        .clone()
        .applyQuaternion(orientation)
        .add(new Vector3(...before.position));
      const worldAfter = fixedPoint
        .clone()
        .applyMatrix4(deformationMatrix(compressed.deformations.coil))
        .applyQuaternion(orientation)
        .add(new Vector3(...after.position));
      expect(worldAfter.distanceTo(worldBefore)).toBeLessThan(1e-8);
    }
  });
});
