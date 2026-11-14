import { describe, expect, it } from "vitest";
import { inspectModelBytes, MODEL_LIMIT_BYTES } from "../src/modelSafety";
import {
  asciiStlTriangle,
  binaryStlTriangle,
  glbTriangle,
} from "./model-fixtures";

const inspectGlb = (mutate?: Parameters<typeof glbTriangle>[0]) =>
  inspectModelBytes(glbTriangle(mutate), "glb");

describe("untrusted GLB bytes before any loader allocation or network access", () => {
  it("accepts a complete embedded indexed triangle", () => {
    expect(() => inspectGlb()).not.toThrow();
  });
  it("rejects external buffers and images before loading", () => {
    expect(() =>
      inspectGlb((doc) => {
        doc.buffers[0].uri = "https://example.invalid/model.bin";
      }),
    ).toThrow();
    expect(() =>
      inspectGlb((doc) => {
        doc.images = [{ uri: "file:///private/image.png" }];
      }),
    ).toThrow();
  });
  it("rejects NaN coordinates in the binary POSITION payload", () => {
    expect(() =>
      inspectGlb((_doc, data) =>
        new DataView(data.buffer).setFloat32(0, Number.NaN, true),
      ),
    ).toThrow();
  });
  it("rejects a bufferView extending beyond the actual BIN chunk", () => {
    expect(() =>
      inspectGlb((doc) => {
        doc.bufferViews[0].byteLength = 1000;
      }),
    ).toThrow();
  });
  it("rejects sparse accessors instead of allocating attacker-controlled patches", () => {
    expect(() =>
      inspectGlb((doc) => {
        doc.accessors[0].sparse = {
          count: 1,
          indices: { bufferView: 1, componentType: 5123 },
          values: { bufferView: 0 },
        };
      }),
    ).toThrow();
  });
  it("rejects huge vertex counts independently of the file byte cap", () => {
    expect(() =>
      inspectGlb((doc) => {
        doc.accessors[0].count = 2 ** 31;
      }),
    ).toThrow();
  });
  it("rejects cyclic and multiply-parented node graphs", () => {
    expect(() =>
      inspectGlb((doc) => {
        doc.nodes[0].children = [0];
      }),
    ).toThrow();
    expect(() =>
      inspectGlb((doc) => {
        doc.nodes = [{ children: [2] }, { children: [2] }, { mesh: 0 }];
      }),
    ).toThrow();
  });
  it("rejects excessive depth even when children precede parents", () => {
    expect(() =>
      inspectGlb((doc) => {
        doc.nodes = Array.from({ length: 66 }, (_, index) =>
          index === 0 ? { mesh: 0 } : { children: [index - 1] },
        );
        doc.scenes[0].nodes = [65];
      }),
    ).toThrow(/层级/);
  });
  it("rejects missing or empty default scenes before accepting MCP/project model data", () => {
    for (const mutate of [
      (doc: any) => { delete doc.scenes; },
      (doc: any) => { doc.scene = 3; },
      (doc: any) => { doc.scenes[0].nodes = []; },
    ]) expect(() => inspectGlb(mutate)).toThrow(/场景/);
    expect(() => inspectGlb((doc) => { delete doc.scene; })).not.toThrow();
  });
  it("rejects node transforms that the loader would turn into invalid dimensions", () => {
    for (const transform of [
      { translation: [1, 2] },
      { scale: [1, "1", 1] },
      { rotation: [0, 0, 0, 0] },
      { matrix: [1, 0, 0] },
      { translation: [0, 0, 0], matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    ]) expect(() => inspectGlb((doc) => Object.assign(doc.nodes[0], transform))).toThrow(/变换|四元数|矩阵/);
    expect(() => inspectGlb((doc) => {
      doc.nodes[0].translation = [1, 2, 3];
      doc.nodes[0].rotation = [0, 0, 0, 1];
      doc.nodes[0].scale = [-1, 2, 3];
    })).not.toThrow();
  });
  it("rejects compressed mesh extensions without attempting a decoder download", () => {
    expect(() =>
      inspectGlb((doc) => {
        doc.extensionsUsed = ["KHR_draco_mesh_compression"];
      }),
    ).toThrow();
    expect(() =>
      inspectGlb((doc) => {
        doc.meshes[0].primitives[0].extensions = {
          KHR_draco_mesh_compression: {},
        };
      }),
    ).toThrow();
  });
  it("rejects triangle indices outside the POSITION range", () => {
    expect(() =>
      inspectGlb((_doc, data) =>
        new DataView(data.buffer).setUint16(40, 3, true),
      ),
    ).toThrow();
  });
  it("rejects truncated GLB and oversized input", () => {
    expect(() =>
      inspectModelBytes(glbTriangle().slice(0, -4), "glb"),
    ).toThrow();
    expect(() =>
      inspectModelBytes(new Uint8Array(MODEL_LIMIT_BYTES + 1), "glb"),
    ).toThrow();
  });
});

describe("STL byte validation", () => {
  it("accepts finite binary and ASCII STL triangles", () => {
    expect(() => inspectModelBytes(binaryStlTriangle(), "stl")).not.toThrow();
    expect(() =>
      inspectModelBytes(new TextEncoder().encode(asciiStlTriangle), "stl"),
    ).not.toThrow();
  });
  it("rejects non-finite binary vertices", () => {
    const bytes = binaryStlTriangle();
    new DataView(bytes.buffer).setFloat32(96, Number.POSITIVE_INFINITY, true);
    expect(() => inspectModelBytes(bytes, "stl")).toThrow();
  });
  it("rejects incomplete ASCII facets and non-finite ASCII vertices", () => {
    expect(() =>
      inspectModelBytes(
        new TextEncoder().encode(
          asciiStlTriangle.replace("vertex 1 5 7\n", ""),
        ),
        "stl",
      ),
    ).toThrow();
    expect(() =>
      inspectModelBytes(
        new TextEncoder().encode(
          asciiStlTriangle.replace("vertex 1 5 7", "vertex NaN 5 7"),
        ),
        "stl",
      ),
    ).toThrow();
  });
});
