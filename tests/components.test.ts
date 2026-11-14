import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  getComponentTypeSchemas,
  validateComponentDefinition,
  validateUploadedModel,
  validateInteractionProfile,
  sha256Bytes,
  createPartFromComponent,
  componentDefinitionIssues,
} from "../src/componentRegistry";
import { parseProject } from "../src/catalog";
import {
  validateAssembly,
  validateMotion,
  solveCircuit,
} from "../src/engine/physics";
import { bayonetFixture } from "../src/engine/bayonet";
import type {
  ComponentDefinition,
  Part,
  Project,
  UploadedModel,
} from "../src/types";
function fixtureModel(): UploadedModel {
  const bytes = new Uint8Array(134),
    view = new DataView(bytes.buffer);
  view.setUint32(80, 1, true);
  [
    [0, 0, 1],
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 1],
  ]
    .flat()
    .forEach((v, i) => view.setFloat32(84 + i * 4, v, true));
  return {
    id: "user-model",
    name: "triangle.stl",
    format: "stl",
    data: Buffer.from(bytes).toString("base64"),
    sha256: sha256Bytes(bytes),
    bytes: bytes.length,
    size: [1, 1, 1],
    center: [0.5, 0.5, 0.5],
  };
}
function definition(kind: Part["kind"] = "pin"): ComponentDefinition {
  return {
    version: 1,
    id: "custom-pin",
    name: "用户插销",
    kind,
    size: [6, 10, 6],
    color: "#6288a8",
    params: { pinDiameter: 6, tolerance: 0.1 },
    interaction: {
      version: 1,
      status: "configured",
      axis: [0, 1, 0],
      anchor: [0, 0, 0],
      proxySize: [6, 10, 6],
      mateFamily: "m6",
      insertionDepth: 10,
      minClearance: 0.05,
    },
    model: fixtureModel(),
  };
}
function pair() {
  const a = definition(),
    b = definition("sleeve");
  b.id = "custom-sleeve";
  b.params = { holeDiameter: 6.4, tolerance: 0.1 };
  b.size = [10, 10, 10];
  b.interaction.proxySize = [10, 10, 10];
  const pin = createPartFromComponent(a, [0, 20, 0]),
    socket = createPartFromComponent(b, [0, 20, 0]);
  return { pin, socket };
}
describe("typed custom components", () => {
  it("publishes distinct parameters and capabilities for all supported component types", () => {
    const schemas = getComponentTypeSchemas();
    expect(schemas).toHaveLength(13);
    expect(schemas.find((s) => s.kind === "pin")?.role).toBe("male");
    expect(schemas.find((s) => s.kind === "button")?.supportsElectrical).toBe(
      true,
    );
    expect(
      schemas
        .find((s) => s.kind === "spring")
        ?.fields.some((f) => f.key === "stiffness"),
    ).toBe(true);
  });
  it("matches standard SHA-256 vectors and independent native crypto", () => {
    for (const text of ["", "abc", "hello 模型", "abcdef".repeat(2000)]) {
      const bytes = new TextEncoder().encode(text);
      expect(sha256Bytes(bytes)).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
    }
  });
  it("round-trips model, semantic type and profile inside a portable project", () => {
    const def = validateComponentDefinition(definition());
    const part = createPartFromComponent(def, [0, 20, 0]);
    const project: Project = {
      version: 1,
      name: "用户组件",
      parts: [part],
      wires: [],
      models: [def.model],
    };
    expect(parseProject(JSON.stringify(project))).toEqual(project);
  });
  it("checks bytes even when an attacker reuses a previously verified model id/hash", () => {
    const valid = fixtureModel();
    validateUploadedModel(valid);
    const bytes = Buffer.from(valid.data, "base64");
    bytes[10] ^= 255;
    expect(() =>
      validateUploadedModel({ ...valid, data: bytes.toString("base64") }),
    ).toThrow(/SHA/);
    expect(() => validateUploadedModel({ ...valid, bytes: 135 })).toThrow();
  });
  it("rejects dangling models, corrupted profiles and executable parameter strings", () => {
    const p = createPartFromComponent(definition());
    expect(() =>
      parseProject(
        JSON.stringify({ version: 1, name: "x", parts: [p], wires: [] }),
      ),
    ).toThrow(/引用/);
    expect(() =>
      validateInteractionProfile({ ...p.interaction, axis: [0, 2, 0] }),
    ).toThrow(/单位向量/);
    expect(() =>
      validateComponentDefinition({
        ...definition(),
        params: { stiffness: "fetch(url)" },
      }),
    ).toThrow();
  });
  it("lets incomplete models be saved as previews but never claims functional validation", () => {
    const d = definition();
    d.interaction.status = "unconfigured";
    delete d.params.pinDiameter;
    const p = createPartFromComponent(
      validateComponentDefinition(d),
      [0, 20, 0],
    );
    expect(
      componentDefinitionIssues(d).filter((i) => i.severity === "error").length,
    ).toBeGreaterThan(1);
    const result = validateAssembly([p]);
    expect(result.issues.some((i) => i.id === "geometry-pass")).toBe(false);
    expect(
      validateMotion([p], p.id, { ...p, position: [1, 20, 0] }).allowed,
    ).toBe(false);
  });
  it("uses declared proxy dimensions instead of treating the visual bounds as solid geometry", () => {
    const { pin, socket } = pair();
    pin.size = [80, 80, 80];
    socket.size = [80, 80, 80];
    const result = validateAssembly([pin, socket]);
    expect(result.collisionPairs).toEqual([]);
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(result.issues.some((i) => i.id.startsWith("component-proxy-"))).toBe(
      true,
    );
  });
  it("applies the supplied local anchor and arbitrary mating axis", () => {
    const { pin, socket } = pair();
    for (const p of [pin, socket]) {
      p.interaction!.axis = [0, 0, 1];
      p.interaction!.anchor = [2, 3, 0];
    }
    pin.position = [0, 20, 11];
    expect(
      validateMotion([pin, socket], pin.id, { ...pin, position: [0, 20, 1] })
        .allowed,
    ).toBe(true);
    const above = { ...pin, position: [0, 0, 0] as [number, number, number] };
    above.interaction = { ...above.interaction!, anchor: [0, 4, 0] };
    expect(
      validateAssembly([above]).issues.some((i) => i.id.startsWith("floor-")),
    ).toBe(false);
  });
  it("rejects incompatible mating families and insufficient user-required clearance", () => {
    const { pin, socket } = pair();
    socket.interaction!.mateFamily = "different";
    expect(
      validateAssembly([pin, socket]).issues.some(
        (i) => i.id.startsWith("family-") && i.severity === "error",
      ),
    ).toBe(true);
    socket.interaction!.mateFamily = "m6";
    socket.interaction!.minClearance = 0.2;
    expect(
      validateAssembly([pin, socket]).issues.some(
        (i) => i.category === "fit" && i.severity === "error",
      ),
    ).toBe(true);
  });
  it("blocks over-insertion anywhere along the motion path, even when the endpoint exits the far side", () => {
    const { pin, socket } = pair();
    pin.interaction!.axis = [0, 0, 1];
    socket.interaction!.axis = [0, 0, 1];
    pin.interaction!.insertionDepth = 2;
    socket.interaction!.insertionDepth = 2;
    pin.position = [0, 20, 11];
    const result = validateMotion([pin, socket], pin.id, {
      ...pin,
      position: [0, 20, -11],
    });
    expect(result.allowed).toBe(false);
    expect(result.issues.some((i) => i.id.startsWith("depth-"))).toBe(true);
  });
  it("does not energize electrical types with missing declared behavior parameters", () => {
    const d = definition("battery");
    d.params = {};
    const part = createPartFromComponent(d, [0, 20, 0]);
    const result = solveCircuit([part], [], []);
    expect(result.voltage).toBe(0);
    expect(result.issues.some((i) => i.severity === "error")).toBe(true);
  });
  it("does not accept arbitrary user bayonet dimensions as the certified nominal mechanism", () => {
    const d = definition("bayonet-pin");
    d.interaction.proxySize = [20, 24, 20];
    d.interaction.lockAngle = 90;
    const result = componentDefinitionIssues(d);
    expect(
      result.some((i) => i.id.endsWith("-bayonet") && i.severity === "error"),
    ).toBe(true);
  });
  it("validates the uploaded nominal bayonet insertion, rotation and retained extraction", () => {
    const { pin, socket } = bayonetFixture();
    for (const part of [pin, socket]) {
      part.model = { id: fixtureModel().id };
      part.interaction = {
        version: 1,
        status: "configured",
        axis: [0, 1, 0],
        anchor: [0, 0, 0],
        proxySize: [...part.size],
        mateFamily: "nominal-bayonet",
        insertionDepth: 18,
        minClearance: 0.05,
        lockAngle: 45,
      };
    }
    const seated: Part = { ...pin, position: [0, 18, 0] };
    expect(validateMotion([pin, socket], pin.id, seated).allowed).toBe(true);
    const locked: Part = { ...seated, rotation: [0, 45, 0] };
    expect(validateMotion([seated, socket], pin.id, locked).allowed).toBe(true);
    expect(
      validateMotion([locked, socket], pin.id, {
        ...locked,
        position: [0, 19, 0],
      }).allowed,
    ).toBe(false);
  });
  it("requires physically feasible hole and spring dimensions before configuration is complete", () => {
    const sleeve = definition("sleeve");
    sleeve.params.holeDiameter = 8;
    expect(
      componentDefinitionIssues(sleeve).some((issue) =>
        issue.id.endsWith("-hole"),
      ),
    ).toBe(true);
    const spring = definition("spring");
    spring.params = {
      stiffness: 1,
      mass: 0.02,
      damping: 0.8,
      freeLength: 10,
      solidLength: 6,
      travel: 5,
    };
    expect(
      componentDefinitionIssues(spring).some((issue) =>
        issue.id.endsWith("-stroke"),
      ),
    ).toBe(true);
  });
});
