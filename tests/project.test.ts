import { describe, expect, it } from "vitest";
import { demoProject, parseProject } from "../src/catalog";
import type { Project } from "../src/types";

const serialize = (edit: (project: Project) => void) => {
  const p = demoProject();
  edit(p);
  return JSON.stringify(p);
};
const withParam = (key: string, value: number | string) =>
  serialize((p) => {
    p.parts[3].params[key] = value;
  });

describe("untrusted project files", () => {
  it("round-trips the baseline with its dimensions, poses, parameters and wire endpoints", () => {
    const project = demoProject();
    expect(parseProject(JSON.stringify(project))).toEqual(project);
  });
  it.each(["null", "[]", "123", '"project"', '{"version":1}', "{broken"])(
    "rejects malformed root %s",
    (text) => {
      expect(() => parseProject(text)).toThrow();
    },
  );
  it("accepts an empty project and Unicode display names", () => {
    const p: Project = {
      version: 1,
      name: "未命名装配 · 测试",
      parts: [],
      wires: [],
    };
    expect(parseProject(JSON.stringify(p))).toEqual(p);
  });
  it("rejects duplicate part and wire identifiers", () => {
    expect(() =>
      parseProject(
        serialize((p) => {
          p.parts[1].id = p.parts[0].id;
        }),
      ),
    ).toThrow();
    expect(() =>
      parseProject(
        serialize((p) => {
          p.wires[1].id = p.wires[0].id;
        }),
      ),
    ).toThrow();
  });
  it.each([
    "a:b",
    "__proto__",
    "constructor",
    "toString",
    "prototype",
    "",
    "id with space",
  ])("rejects unsafe state or terminal key %s", (id) => {
    expect(() =>
      parseProject(
        serialize((p) => {
          p.parts[0].id = id;
        }),
      ),
    ).toThrow();
  });
  it("rejects missing, mechanical, and out-of-range electrical endpoints", () => {
    expect(() =>
      parseProject(
        serialize((p) => {
          p.wires[0].from.partId = "missing";
        }),
      ),
    ).toThrow();
    expect(() =>
      parseProject(
        serialize((p) => {
          p.wires[0].from.partId = p.parts[0].id;
        }),
      ),
    ).toThrow();
    expect(() =>
      parseProject(
        serialize((p) => {
          p.wires[0].from.terminal = 2 as 0;
        }),
      ),
    ).toThrow();
  });
  it.each([
    "damping",
    "trigger",
    "compression",
    "tolerance",
    "freeLength",
    "solidLength",
    "stiffness",
    "voltage",
    "customProperty",
  ])("rejects string-valued numeric parameter %s", (key) => {
    expect(() => parseProject(withParam(key, "NaN"))).toThrow();
    expect(() => parseProject(withParam(key, "0.2"))).toThrow();
  });
  it("rejects negative physical parameters and keeps valid numeric extensions", () => {
    for (const key of [
      "damping",
      "trigger",
      "compression",
      "tolerance",
      "solidLength",
      "mass",
      "stiffness",
    ])
      expect(() => parseProject(withParam(key, -1))).toThrow();
    expect(
      parseProject(withParam("customCalibration", -1)).parts[3].params
        .customCalibration,
    ).toBe(-1);
    expect(parseProject(withParam("damping", 0)).parts[3].params.damping).toBe(
      0,
    );
  });
  it("rejects infinities expressed by JSON exponents and oversized numbers", () => {
    const text = withParam("mass", 42).replace('"mass":42', '"mass":1e999');
    expect(() => parseProject(text)).toThrow();
    expect(() => parseProject(withParam("mass", 1e9))).toThrow();
    expect(() => parseProject(withParam("mass", 1e-300))).toThrow();
  });
  it("rejects invalid geometry arrays and nonpositive dimensions", () => {
    expect(() =>
      parseProject(
        serialize((p) => {
          p.parts[0].size[1] = 0;
        }),
      ),
    ).toThrow();
    expect(() =>
      parseProject(
        serialize((p) => {
          p.parts[0].position = [0, 0] as unknown as [number, number, number];
        }),
      ),
    ).toThrow();
    expect(() =>
      parseProject(
        serialize((p) => {
          p.parts[0].rotation[0] = 1e6;
        }),
      ),
    ).toThrow();
  });
  it("keeps insufficient-clearance projects importable for engineering review", () => {
    const text = serialize((p) => {
      p.parts[1].params.innerWidth = 11;
    });
    expect(parseProject(text).parts[1].params.innerWidth).toBe(11);
  });
  it("accepts bundled GLB paths and Unicode node identifiers", () => {
    const text = serialize((p) => {
      p.parts[0].kind = "asset";
      p.parts[0].params = {
        assetUrl: "./models/buttons-left.glb",
        assetNode: "左 · PS5 键帽.003",
      };
    });
    expect(parseProject(text).parts[0].params.assetNode).toBe(
      "左 · PS5 键帽.003",
    );
  });
  it.each([
    "https://example.com/model.glb",
    "//example.com/model.glb",
    "file:///etc/passwd",
    "./models/../../secrets.glb",
    "./models/%2e%2e.glb",
    "data:application/json,{}",
    "./models/a.glb?url=https://example.com",
  ])("rejects nonbundled model URL %s", (assetUrl) => {
    expect(() =>
      parseProject(
        serialize((p) => {
          p.parts[0].kind = "asset";
          p.parts[0].params = { assetUrl };
        }),
      ),
    ).toThrow();
  });
  it("does not merge prototype-like parameter names into application state", () => {
    const text = withParam("customCalibration", 1).replace(
      '"customCalibration":1',
      '"__proto__":1',
    );
    expect(() => parseProject(text)).toThrow();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
  it("drops unsupported top-level properties rather than persisting them", () => {
    const p = demoProject();
    const text = JSON.stringify({ ...p, privileged: { shell: true } });
    expect(parseProject(text)).toEqual(p);
  });
  it("limits file size and object count before constructing a scene", () => {
    expect(() => parseProject(" ".repeat(5_000_001))).toThrow();
    expect(() =>
      parseProject(
        serialize((p) => {
          p.parts = Array.from({ length: 501 }, (_, i) => ({
            ...p.parts[0],
            id: `part-${i}`,
          }));
        }),
      ),
    ).toThrow();
    expect(() =>
      parseProject(
        serialize((p) => {
          p.wires = Array.from({ length: 2001 }, (_, i) => ({
            ...p.wires[0],
            id: `wire-${i}`,
          }));
        }),
      ),
    ).toThrow();
  });
});
