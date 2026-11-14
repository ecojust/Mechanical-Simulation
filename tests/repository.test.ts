import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRepositoryParts } from "../src/repository";
import { parseProject } from "../src/catalog";
import { componentPartIssues } from "../src/componentRegistry";
import { validateAssembly, validateMotion } from "../src/engine/physics";
import type { AssetEntry, Project, Vec3 } from "../src/types";

const catalog: AssetEntry[] = JSON.parse(
  readFileSync("public/models/catalog.json", "utf8"),
);
const source = catalog.find((asset) => asset.id === "buttons-left")!;
const pair = source.nodes!.filter(
  (node) => node.group?.id === "buttons-left-pin-sleeve",
);

describe("independent source objects and mating groups", () => {
  it("keeps the explicit male/female pair separate from the spring and switch groups", () => {
    expect(pair).toHaveLength(2);
    expect(pair.map((node) => node.kind).sort()).toEqual(["pin", "sleeve"]);
    expect(pair.map((node) => node.role).sort()).toEqual(["female", "male"]);
    expect(
      source.nodes!.find((node) => node.kind === "spring")?.group?.id,
    ).not.toBe(pair[0].group?.id);
    expect(
      source.nodes!.find((node) => node.kind === "button")?.group?.id,
    ).not.toBe(pair[0].group?.id);
  });
  it("retains relative source coordinates and isolates repeated group instances", () => {
    const offset: Vec3 = [10, 20, 30];
    const first = createRepositoryParts(source, pair, offset);
    const second = createRepositoryParts(source, pair, offset);
    expect(first[0].assemblyGroup).toEqual(first[1].assemblyGroup);
    expect(first[0].assemblyGroup?.id).not.toBe(second[0].assemblyGroup?.id);
    for (let index = 0; index < pair.length; index++) {
      expect(first[index].position).toEqual(
        pair[index].center.map((v, axis) => v + offset[axis]),
      );
      expect(first[index].params).toEqual({
        assetUrl: source.url,
        assetNode: pair[index].name,
      });
      expect(first[index].interaction?.status).toBe("unconfigured");
      expect(
        componentPartIssues(first[index]).some(
          (issue) => issue.severity === "error",
        ),
      ).toBe(true);
    }
  });
  it("loads all 189 source objects independently at their original relative positions", () => {
    const project = parseProject(
      readFileSync("public/models/puretv-assembly.json", "utf8"),
    );
    expect(project.parts).toHaveLength(189);
    expect(
      new Set(
        project.parts.map(
          (part) => `${part.params.assetUrl}:${part.params.assetNode}`,
        ),
      ).size,
    ).toBe(189);
    const groundShift = -Math.min(
      ...catalog.map((asset) => asset.center[1] - asset.size[1] / 2),
    );
    for (const asset of catalog)
      for (const node of asset.nodes!) {
        const part = project.parts.find(
          (p) =>
            p.params.assetUrl === asset.url && p.params.assetNode === node.name,
        )!;
        expect(part.size).toEqual(node.size);
        expect(part.position[0]).toBe(node.center[0]);
        expect(part.position[1]).toBeCloseTo(node.center[1] + groundShift, 5);
        expect(part.position[2]).toBe(node.center[2]);
        expect(part.kind).toBe(node.kind);
        if (part.kind !== "asset")
          expect(part.interaction?.status).toBe("unconfigured");
      }
  });
  it("round-trips group metadata and rejects unsafe or contradictory group identifiers", () => {
    const project: Project = {
      version: 1,
      name: "group",
      parts: createRepositoryParts(source, pair),
      wires: [],
    };
    expect(parseProject(JSON.stringify(project))).toEqual(project);
    const invalid = structuredClone(project);
    invalid.parts[0].assemblyGroup!.id = "__proto__";
    expect(() => parseProject(JSON.stringify(invalid))).toThrow(/分组/);
    invalid.parts[0].assemblyGroup = {
      ...project.parts[0].assemblyGroup!,
      name: "different",
    };
    expect(() => parseProject(JSON.stringify(invalid))).toThrow(/不同名称/);
  });
  it("cannot bypass a source model's pending calibration by deleting its profile", () => {
    const parts = createRepositoryParts(source, pair);
    delete parts[0].interaction;
    expect(() =>
      parseProject(JSON.stringify({ version: 1, name: "x", parts, wires: [] })),
    ).toThrow(/交互定义/);
    expect(
      componentPartIssues(parts[0]).some((issue) => issue.severity === "error"),
    ).toBe(true);
  });
  it.each(["unconfigured", "missing", "invalid"])(
    "shows %s source pair proxies as previews without confirmed collision or fit",
    (mode) => {
      const parts = createRepositoryParts(source, pair);
      if (mode === "missing") for (const part of parts) delete part.interaction;
      if (mode === "invalid")
        for (const part of parts) part.interaction!.status = "configured";
      const result = validateAssembly(parts);
      expect(result.collisionPairs).toEqual([]);
      expect(result.minClearance).toBeNull();
      expect(result.issues.some((issue) => issue.category === "fit")).toBe(
        false,
      );
      expect(result.issues.some((issue) => issue.id === "geometry-pass")).toBe(
        false,
      );
      expect(
        result.issues.some(
          (issue) =>
            issue.severity === "error" && issue.id.startsWith("component-"),
        ),
      ).toBe(true);
      expect(
        result.issues.some(
          (issue) =>
            issue.severity === "warning" &&
            issue.id.startsWith("preview-bounds-"),
        ),
      ).toBe(true);
      expect(
        validateMotion(parts, parts[0].id, {
          ...parts[0],
          position: [0, 30, 0],
        }).allowed,
      ).toBe(false);
    },
  );
});
