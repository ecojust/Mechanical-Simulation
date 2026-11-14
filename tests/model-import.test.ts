import { describe, expect, it } from "vitest";
import { importModelFile } from "../src/modelImport";
import { binaryStlTriangle, glbTriangle } from "./model-fixtures";

function file(bytes: Uint8Array, name: string): File {
  return new File([bytes.slice().buffer], name);
}

describe("component model import uses explicit millimetre conversion", () => {
  it("retains model bytes while scaling STL dimensions and center from cm", async () => {
    const source = binaryStlTriangle();
    const model = await importModelFile(file(source, "triangle.stl"), "cm");
    expect(model.size).toEqual([20, 30, 40]);
    expect(model.center).toEqual([20, 35, 50]);
    expect(model.bytes).toBe(source.length);
    expect(model.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(atob(model.data).length).toBe(source.length);
  });
  it("computes GLB dimensions from geometry rather than accessor min/max claims", async () => {
    const source = glbTriangle((doc) => {
      doc.accessors[0].min = [0, 0, 0];
      doc.accessors[0].max = [99, 99, 99];
    });
    const model = await importModelFile(file(source, "triangle.glb"), "mm");
    expect(model.size).toEqual([2, 3, 4]);
    expect(model.center).toEqual([2, 3.5, 5]);
  });
  it("distinguishes units in model ids while preserving the content digest", async () => {
    const source = binaryStlTriangle();
    const millimetres = await importModelFile(
      file(source, "triangle.stl"),
      "mm",
    );
    const centimetres = await importModelFile(
      file(source, "triangle.stl"),
      "cm",
    );
    expect(millimetres.sha256).toBe(centimetres.sha256);
    expect(millimetres.id).not.toBe(centimetres.id);
    expect(centimetres.size).toEqual(
      millimetres.size.map((value) => value * 10),
    );
  });
  it("rejects unsupported filename extensions without parsing payloads", async () => {
    await expect(
      importModelFile(file(binaryStlTriangle(), "arbitrary.blend")),
    ).rejects.toThrow();
  });
});
