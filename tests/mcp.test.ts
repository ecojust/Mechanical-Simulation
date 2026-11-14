import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { bayonetDemoProject, makePart } from "../src/catalog";
import {
  dispatchWorkbenchCommand,
  workbenchTools,
  sliceJsonChunk,
} from "../src/mcp/workbench";
import type {
  AssetEntry,
  ComponentDefinition,
  Project,
  Mechanism,
  MechanismStates,
} from "../src/types";
const context = { revision: 3, components: [], assets: [] };
function component(triangles = 1): ComponentDefinition {
  const bytes = Buffer.alloc(84 + triangles * 50);
  bytes.writeUInt32LE(triangles, 80);
  for (let triangle = 0; triangle < triangles; triangle++)
    [0, 0, 0, 1, 0, 1, 0, 1, 1].forEach((v, i) =>
      bytes.writeFloatLE(v, 96 + triangle * 50 + i * 4),
    );
  return {
    version: 1,
    id: "custom-pin",
    name: "Own pin",
    kind: "pin",
    size: [1, 1, 1],
    color: "#abcdef",
    params: {},
    interaction: {
      version: 1,
      status: "unconfigured",
      axis: [0, 1, 0],
      anchor: [0, 0, 0],
      proxySize: [1, 1, 1],
    },
    model: {
      id: "model-pin",
      name: "pin.stl",
      format: "stl",
      data: bytes.toString("base64"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      size: [1, 1, 1],
      center: [0.5, 0.5, 0.5],
    },
  };
}
function pressFixture(): { project: Project; mechanism: Mechanism } {
  const base = {
    ...makePart("base", [100, 1, 0]),
    id: "mechanism-base",
    size: [8, 2, 8] as [number, number, number],
    fixed: false,
  };
  const cap = {
    ...makePart("button", [100, 15, 0]),
    id: "mechanism-cap",
    size: [2, 2, 2] as [number, number, number],
    fixed: false,
  };
  const spring = {
    ...makePart("spring", [100, 7, 0]),
    id: "mechanism-spring",
    size: [2, 8, 2] as [number, number, number],
    fixed: false,
  };
  const contact = {
    ...makePart("base", [100, 11.5, 0]),
    id: "mechanism-contact",
    size: [0.8, 1, 0.8] as [number, number, number],
    fixed: false,
  };
  const mechanism: Mechanism = {
    version: 1,
    id: "compound-press",
    name: "Compound button",
    kind: "press",
    status: "configured",
    partIds: [base.id, cap.id, spring.id, contact.id],
    movingPartIds: [cap.id],
    springPartIds: [spring.id],
    switchPartId: contact.id,
    contact: {
      strikerPartId: cap.id,
      strikerPoint: [0, -1, 0],
      switchPoint: [0, 0.5, 0],
      switchNormal: [0, 1, 0],
      radius: 0.35,
      maxOvertravel: 0.25,
    },
    frame: { position: [100, 0, 0], rotation: [0, 0, 0] },
    axis: [0, 1, 0],
    pose: { offset: 0, angle: 0 },
    params: {
      mass: 0.02,
      stiffness: 1,
      damping: 0.3,
      travel: 2,
      trigger: 1,
      freeLength: 8,
      solidLength: 2,
    },
    movingProxy: {
      kind: "base",
      position: [0, 15, 0],
      rotation: [0, 0, 0],
      size: [2, 2, 2],
      params: {},
    },
    fixedProxy: {
      kind: "base",
      position: [0, 6, 0],
      rotation: [0, 0, 0],
      size: [8, 12, 8],
      params: {},
    },
  };
  return {
    project: {
      version: 1,
      name: "Compound fixture",
      parts: [base, cap, spring, contact],
      wires: [],
    },
    mechanism,
  };
}
describe("MCP commands share the active workbench rules", () => {
  it("rejects an external edit that would collide when the press simulation resets", async () => {
    const fixture = pressFixture();
    const external = {
      ...makePart("base", [105, 15.5, 0]),
      size: [0.5, 0.5, 0.5] as [number, number, number],
      fixed: false,
    };
    const project = {
      ...fixture.project,
      parts: [...fixture.project.parts, external],
      mechanisms: [fixture.mechanism],
    };
    const mechanismStates = {
      [fixture.mechanism.id]: { displacement: 2, velocity: 0, force: 2 },
    };
    await expect(
      dispatchWorkbenchCommand(
        project,
        {
          method: "transform_part",
          args: {
            expectedRevision: 3,
            partId: external.id,
            position: [100, 15.5, 0],
          },
        },
        { ...context, mechanismStates },
      ),
    ).rejects.toThrow("受阻");
    expect(project.parts.at(-1)!.position).toEqual([105, 15.5, 0]);
  });
  it("wires a declared fixed switch member and validates the live compound circuit", async () => {
    const fixture = pressFixture();
    const battery = makePart("battery", [140, 8, 0]),
      lamp = makePart("lamp", [170, 8, 0]);
    let project: Project = {
      ...fixture.project,
      parts: [...fixture.project.parts, battery, lamp],
      mechanisms: [fixture.mechanism],
    };
    let revision = 3;
    const contact = fixture.mechanism.switchPartId!;
    for (const [from, to] of [
      [
        { partId: battery.id, terminal: 0 },
        { partId: contact, terminal: 0 },
      ],
      [
        { partId: contact, terminal: 1 },
        { partId: lamp.id, terminal: 0 },
      ],
      [
        { partId: lamp.id, terminal: 1 },
        { partId: battery.id, terminal: 1 },
      ],
    ] as const) {
      const wired = await dispatchWorkbenchCommand(
        project,
        {
          method: "connect_wire",
          args: { expectedRevision: revision, from, to },
        },
        { ...context, revision },
      );
      project = wired.project!;
      revision++;
    }
    const near = await dispatchWorkbenchCommand(
      project,
      { method: "validate_project" },
      {
        ...context,
        revision,
        mechanismStates: {
          [fixture.mechanism.id]: {
            displacement: 1.5,
            velocity: 0,
            force: 1.5,
          },
        },
      },
    );
    expect(
      (near.result.circuit as { poweredLampIds: string[] }).poweredLampIds,
    ).not.toContain(lamp.id);
    expect(
      (
        near.result.contacts as Record<
          string,
          { pressed: boolean; gap: number }
        >
      )[fixture.mechanism.id],
    ).toMatchObject({ pressed: false, gap: 0.5 });
    await expect(
      dispatchWorkbenchCommand(
        project,
        { method: "validate_project", args: { pressedIds: [contact] } },
        { ...context, revision },
      ),
    ).rejects.toThrow("撞针接触");
    const pressed = await dispatchWorkbenchCommand(
      project,
      {
        method: "press_mechanism",
        args: {
          expectedRevision: revision,
          mechanismId: fixture.mechanism.id,
          held: true,
          duration: 0.5,
        },
      },
      { ...context, revision },
    );
    expect(
      (pressed.result.circuit as { poweredLampIds: string[] }).poweredLampIds,
    ).toContain(lamp.id);
    expect(
      (pressed.result.contacts as Record<string, { pressed: boolean }>)[
        fixture.mechanism.id
      ].pressed,
    ).toBe(true);
    const validation = await dispatchWorkbenchCommand(
      project,
      { method: "validate_project" },
      {
        ...context,
        revision: revision + 1,
        mechanismStates: pressed.mechanismStates,
      },
    );
    expect(
      (validation.result.circuit as { poweredLampIds: string[] })
        .poweredLampIds,
    ).toContain(lamp.id);
  });
  it("creates/removes functional assemblies and prevents independent member motion/deletion", async () => {
    const { project, mechanism } = pressFixture();
    const created = await dispatchWorkbenchCommand(
      project,
      {
        method: "configure_mechanism",
        args: { expectedRevision: 3, mechanism },
      },
      context,
    );
    expect(created.project?.mechanisms?.[0].id).toBe(mechanism.id);
    expect(created.project?.mechanisms?.[0].contact).toEqual(mechanism.contact);
    const next = created.project!;
    await expect(
      dispatchWorkbenchCommand(
        next,
        {
          method: "configure_mechanism",
          args: {
            expectedRevision: 4,
            mechanism: {
              ...mechanism,
              frame: { position: [300, 0, 0], rotation: [0, 0, 0] },
            },
          },
        },
        { ...context, revision: 4 },
      ),
    ).rejects.toThrow("受检");
    await expect(
      dispatchWorkbenchCommand(
        next,
        {
          method: "transform_part",
          args: {
            expectedRevision: 4,
            partId: mechanism.movingPartIds[0],
            position: [100, 14, 0],
          },
        },
        { ...context, revision: 4 },
      ),
    ).rejects.toThrow("transform_mechanism");
    await expect(
      dispatchWorkbenchCommand(
        next,
        {
          method: "remove_part",
          args: { expectedRevision: 4, partId: mechanism.movingPartIds[0] },
        },
        { ...context, revision: 4 },
      ),
    ).rejects.toThrow("delete_mechanism");
    const removed = await dispatchWorkbenchCommand(
      next,
      {
        method: "delete_mechanism",
        args: { expectedRevision: 4, mechanismId: mechanism.id },
      },
      { ...context, revision: 4 },
    );
    expect(removed.project?.mechanisms).toHaveLength(0);
    expect(removed.project?.parts).toHaveLength(4);
  });
  it("presses and releases the shared simulation state without editing rest geometry", async () => {
    const fixture = pressFixture(),
      project = { ...fixture.project, mechanisms: [fixture.mechanism] };
    const before = JSON.stringify(project);
    const pressed = await dispatchWorkbenchCommand(
      project,
      {
        method: "press_mechanism",
        args: {
          expectedRevision: 3,
          mechanismId: fixture.mechanism.id,
          held: true,
          duration: 0.5,
        },
      },
      context,
    );
    const states = pressed.mechanismStates as MechanismStates;
    expect(states[fixture.mechanism.id].displacement).toBeGreaterThan(1);
    expect(pressed.result.pressedIds).toContain(fixture.mechanism.switchPartId);
    expect(pressed.project).toBeUndefined();
    expect(pressed.actuation).toEqual({
      mechanismId: fixture.mechanism.id,
      held: true,
    });
    expect(pressed.result.revision).toBe(4);
    const released = await dispatchWorkbenchCommand(
      project,
      {
        method: "press_mechanism",
        args: {
          expectedRevision: 4,
          mechanismId: fixture.mechanism.id,
          held: false,
          duration: 1,
        },
      },
      { ...context, revision: 4, mechanismStates: states },
    );
    expect(
      released.mechanismStates![fixture.mechanism.id].displacement,
    ).toBeLessThan(0.1);
    expect(released.result.pressedIds).not.toContain(
      fixture.mechanism.switchPartId,
    );
    expect(JSON.stringify(project)).toBe(before);
    const fixed = {
      ...project,
      parts: project.parts.map((part) =>
        part.id === fixture.mechanism.movingPartIds[0]
          ? { ...part, fixed: true }
          : part,
      ),
    };
    await expect(
      dispatchWorkbenchCommand(
        fixed,
        {
          method: "press_mechanism",
          args: {
            expectedRevision: 3,
            mechanismId: fixture.mechanism.id,
            held: true,
            duration: 0.1,
          },
        },
        context,
      ),
    ).rejects.toThrow("固定");
  });
  it("moves an entire mechanism with frame constraints and rejects mixed transform modes", async () => {
    const fixture = pressFixture(),
      project = { ...fixture.project, mechanisms: [fixture.mechanism] };
    const moved = await dispatchWorkbenchCommand(
      project,
      {
        method: "transform_mechanism",
        args: {
          expectedRevision: 3,
          mechanismId: fixture.mechanism.id,
          frame: { position: [110, 0, 0], rotation: [0, 0, 0] },
        },
      },
      context,
    );
    expect(
      moved.project!.parts.find((part) => part.id === "mechanism-cap")!
        .position[0],
    ).toBe(110);
    await expect(
      dispatchWorkbenchCommand(
        project,
        {
          method: "transform_mechanism",
          args: {
            expectedRevision: 3,
            mechanismId: fixture.mechanism.id,
            distance: 1,
            frame: { position: [110, 0, 0], rotation: [0, 0, 0] },
          },
        },
        context,
      ),
    ).rejects.toThrow("不能混用");
  });
  it("round-trips a real large model through bounded export chunks", async () => {
    const model = component(55000).model;
    const project = { ...bayonetDemoProject(), models: [model] };
    const metadata = await dispatchWorkbenchCommand(
      project,
      { method: "export_project" },
      context,
    );
    expect(metadata.result.mode).toBe("chunked");
    const chunks: string[] = [];
    for (
      let chunkIndex = 0;
      chunkIndex < Number(metadata.result.chunkCount);
      chunkIndex++
    ) {
      const chunk = await dispatchWorkbenchCommand(
        project,
        { method: "export_project", args: { chunkIndex, expectedRevision: 3 } },
        context,
      );
      chunks.push(chunk.result.data as string);
    }
    expect((JSON.parse(chunks.join("")) as Project).models?.[0].data).toBe(
      model.data,
    );
  });
  it("publishes typed schemas and preserves read-only revision", async () => {
    const p = bayonetDemoProject();
    const r = await dispatchWorkbenchCommand(
      p,
      { method: "list_component_types" },
      context,
    );
    expect(r.result.revision).toBe(3);
    expect(r.result.types).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "pin", requiresMating: true }),
      ]),
    );
    expect(r.project).toBeUndefined();
    expect(workbenchTools.some((t) => t.name === "get_runtime_status")).toBe(
      true,
    );
  });
  it("rejects stale revisions and unknown fields without touching state", async () => {
    const p = bayonetDemoProject(),
      before = JSON.stringify(p);
    await expect(
      dispatchWorkbenchCommand(
        p,
        {
          method: "remove_part",
          args: { partId: p.parts[2].id, expectedRevision: 2 },
        },
        context,
      ),
    ).rejects.toThrow("revision=3");
    await expect(
      dispatchWorkbenchCommand(
        p,
        { method: "get_project", args: { script: "evil" } },
        context,
      ),
    ).rejects.toThrow("不支持");
    expect(JSON.stringify(p)).toBe(before);
  });
  it("enforces insertion and locked withdrawal with the same physics engine", async () => {
    let p = bayonetDemoProject();
    const pin = p.parts.find((p) => p.kind === "bayonet-pin")!;
    let revision = 3;
    const call = async (position?: number[], rotation?: number[]) => {
      const r = await dispatchWorkbenchCommand(
        p,
        {
          method: "transform_part",
          args: {
            partId: pin.id,
            expectedRevision: revision,
            ...(position ? { position } : {}),
            ...(rotation ? { rotation } : {}),
          },
        },
        { ...context, revision },
      );
      p = r.project!;
      revision = Number(r.result.revision);
    };
    await call([-18, 18, 0]);
    await call(undefined, [0, 45, 0]);
    expect(revision).toBe(5);
    const before = JSON.stringify(p);
    await expect(call([-18, 35, 0])).rejects.toThrow("受阻");
    expect(JSON.stringify(p)).toBe(before);
    await call(undefined, [0, 0, 0]);
    await call([-18, 35, 0]);
    expect(p.parts.find((p) => p.id === pin.id)?.position[1]).toBe(35);
  });
  it("does not move fixed parts", async () => {
    const p = bayonetDemoProject();
    await expect(
      dispatchWorkbenchCommand(
        p,
        {
          method: "transform_part",
          args: {
            expectedRevision: 3,
            partId: p.parts[0].id,
            position: [1, 2, 0],
          },
        },
        context,
      ),
    ).rejects.toThrow();
  });
  it("keeps a parameter-incomplete upload explicitly unverified", async () => {
    const c = component();
    const imported = await dispatchWorkbenchCommand(
      bayonetDemoProject(),
      {
        method: "import_component",
        args: { expectedRevision: 3, component: c },
      },
      context,
    );
    expect(imported.component?.kind).toBe("pin");
    expect(imported.result.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: "error" })]),
    );
    expect(imported.result.revision).toBe(4);
    expect(imported.project).toBeUndefined();
  });
  it("embeds a user component in project export but omits bytes from metadata", async () => {
    const c = component();
    const r = await dispatchWorkbenchCommand(
      bayonetDemoProject(),
      {
        method: "add_part",
        args: { expectedRevision: 3, componentId: c.id, position: [80, 1, 0] },
      },
      { ...context, components: [c] },
    );
    const project = r.project!;
    expect(project.models?.[0].data).toBe(c.model.data);
    const view = await dispatchWorkbenchCommand(
      project,
      { method: "get_project" },
      context,
    );
    expect((view.result.project as Project).models?.[0].data).toBeUndefined();
    const full = await dispatchWorkbenchCommand(
      project,
      { method: "export_project" },
      context,
    );
    expect((full.result.project as Project).models?.[0].data).toBe(
      c.model.data,
    );
  });
  it("rejects mechanical wire endpoints and malformed transforms", async () => {
    const p = bayonetDemoProject();
    await expect(
      dispatchWorkbenchCommand(
        p,
        {
          method: "connect_wire",
          args: {
            expectedRevision: 3,
            from: { partId: p.parts[0].id, terminal: 0 },
            to: { partId: p.parts[1].id, terminal: 1 },
          },
        },
        context,
      ),
    ).rejects.toThrow();
    await expect(
      dispatchWorkbenchCommand(
        p,
        {
          method: "transform_part",
          args: {
            expectedRevision: 3,
            partId: p.parts[2].id,
            position: [Infinity, 0, 0],
          },
        },
        context,
      ),
    ).rejects.toThrow("有限");
  });
  it("removes attached wires with a part and leaves original data unchanged", async () => {
    const p = bayonetDemoProject();
    const battery = p.parts.find((p) => p.kind === "battery")!;
    const r = await dispatchWorkbenchCommand(
      p,
      {
        method: "remove_part",
        args: { expectedRevision: 3, partId: battery.id },
      },
      context,
    );
    expect(r.project?.parts).toHaveLength(5);
    expect(r.project?.wires).toHaveLength(1);
    expect(p.parts).toHaveLength(6);
    expect(p.wires).toHaveLength(3);
  });
  it("requires explicit reconfiguration after changing a trusted built-in type", async () => {
    const p = bayonetDemoProject(),
      base = p.parts[0];
    const r = await dispatchWorkbenchCommand(
      p,
      {
        method: "configure_part",
        args: { expectedRevision: 3, partId: base.id, kind: "battery" },
      },
      context,
    );
    const next = r.project!.parts[0];
    expect(next.kind).toBe("battery");
    expect(next.params).toEqual({});
    expect(next.interaction?.status).toBe("unconfigured");
    expect(r.result.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: "error" })]),
    );
  });
  it("checks library capacity before emitting an import outcome", async () => {
    const c = component();
    const existing = {
      ...c,
      id: "existing",
      model: { ...c.model, bytes: 64 * 1024 * 1024 },
    };
    await expect(
      dispatchWorkbenchCommand(
        bayonetDemoProject(),
        {
          method: "import_component",
          args: { expectedRevision: 3, component: c },
        },
        { ...context, components: [existing] },
      ),
    ).rejects.toThrow("64 MiB");
  });
  it("rejects incorrect optional argument types instead of ignoring them", async () => {
    await expect(
      dispatchWorkbenchCommand(
        bayonetDemoProject(),
        {
          method: "add_part",
          args: {
            expectedRevision: 3,
            kind: 42,
            componentId: "example",
            position: [0, 5, 0],
          },
        },
        context,
      ),
    ).rejects.toThrow("字符串");
  });
  it("preserves repository node group relationships and marks inferred functions unconfigured", async () => {
    const asset: AssetEntry = {
      id: "pins",
      name: "Pins",
      file: "pins.glb",
      url: "./models/pins.glb",
      size: [3, 3, 3],
      center: [0, 0, 0],
      objects: 2,
      triangles: 12,
      nodes: [
        {
          name: "male",
          size: [1, 2, 1],
          center: [0, 1, 0],
          kind: "pin",
          group: { id: "pair", name: "Pair" },
        },
        {
          name: "female",
          size: [2, 2, 2],
          center: [3, 1, 0],
          kind: "sleeve",
          group: { id: "pair", name: "Pair" },
        },
      ],
    };
    const r = await dispatchWorkbenchCommand(
      bayonetDemoProject(),
      {
        method: "add_repository_parts",
        args: { expectedRevision: 3, assetId: "pins", offset: [100, 0, 0] },
      },
      { ...context, assets: [asset] },
    );
    const added = r.project!.parts.slice(-2);
    expect(added[0].assemblyGroup).toEqual(added[1].assemblyGroup);
    expect(added[0].interaction?.status).toBe("unconfigured");
    expect(added[0].position).toEqual([100, 1, 0]);
    expect(added[1].params.assetNode).toBe("female");
    await expect(
      dispatchWorkbenchCommand(
        bayonetDemoProject(),
        {
          method: "add_repository_parts",
          args: {
            expectedRevision: 3,
            assetId: "pins",
            nodeNames: ["missing"],
          },
        },
        { ...context, assets: [asset] },
      ),
    ).rejects.toThrow("不存在");
  });
  it("configures bounded PBR and per-part color through the same project parser", async () => {
    const p = bayonetDemoProject(),
      part = p.parts[2];
    const r = await dispatchWorkbenchCommand(
      p,
      {
        method: "configure_part",
        args: {
          expectedRevision: 3,
          partId: part.id,
          color: "#aabbcc",
          material: { metalness: 0.8, roughness: 0.2, useSourceColor: true },
        },
      },
      context,
    );
    expect(r.project!.parts[2].material).toEqual({
      metalness: 0.8,
      roughness: 0.2,
      useSourceColor: false,
    });
    expect(r.project!.parts[2].color).toBe("#aabbcc");
    await expect(
      dispatchWorkbenchCommand(
        p,
        {
          method: "configure_part",
          args: {
            expectedRevision: 3,
            partId: part.id,
            material: { metalness: 2, roughness: 0.5 },
          },
        },
        context,
      ),
    ).rejects.toThrow();
    expect(part.color).not.toBe("#aabbcc");
  });
  it("exports revision-checked chunks and never splits a Unicode surrogate pair", async () => {
    const p = bayonetDemoProject();
    const r = await dispatchWorkbenchCommand(
      p,
      {
        method: "export_project",
        args: { chunkIndex: 0, expectedRevision: 3 },
      },
      context,
    );
    expect(JSON.parse(r.result.data as string)).toEqual(p);
    await expect(
      dispatchWorkbenchCommand(
        p,
        {
          method: "export_project",
          args: { chunkIndex: 0, expectedRevision: 2 },
        },
        context,
      ),
    ).rejects.toThrow("重新导出");
    const text = "123😀45😀67";
    const chunks = Array.from(
      { length: Math.ceil(text.length / 4) },
      (_, index) => sliceJsonChunk(text, index, 4),
    );
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) expect(chunk.isWellFormed()).toBe(true);
  });
});
