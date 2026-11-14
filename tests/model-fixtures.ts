/** Small in-memory interchange models; no renderer or network is needed. */
export function glbTriangle(
  mutate?: (document: any, binary: Uint8Array) => void,
): Uint8Array {
  const binary = new Uint8Array(44);
  const view = new DataView(binary.buffer);
  [1, 2, 3, 3, 2, 3, 1, 5, 7].forEach((n, i) =>
    view.setFloat32(i * 4, n, true),
  );
  [0, 1, 2].forEach((n, i) => view.setUint16(36 + i * 2, n, true));
  const document = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] },
    ],
    buffers: [{ byteLength: 42 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [1, 2, 3],
        max: [3, 5, 7],
      },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
    ],
  };
  mutate?.(document, binary);
  const encoded = new TextEncoder().encode(JSON.stringify(document));
  const json = new Uint8Array(Math.ceil(encoded.length / 4) * 4).fill(32);
  json.set(encoded);
  const result = new Uint8Array(12 + 8 + json.length + 8 + binary.length);
  const header = new DataView(result.buffer);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, result.length, true);
  header.setUint32(12, json.length, true);
  header.setUint32(16, 0x4e4f534a, true);
  result.set(json, 20);
  header.setUint32(20 + json.length, binary.length, true);
  header.setUint32(24 + json.length, 0x004e4942, true);
  result.set(binary, 28 + json.length);
  return result;
}

export function binaryStlTriangle(): Uint8Array {
  const result = new Uint8Array(134);
  const view = new DataView(result.buffer);
  view.setUint32(80, 1, true);
  // Normal followed by vertices, all three dimensions span a non-zero range.
  [0, 0, 1, 1, 2, 3, 3, 2, 3, 1, 5, 7].forEach((n, i) =>
    view.setFloat32(84 + i * 4, n, true),
  );
  return result;
}

export const asciiStlTriangle = `solid triangle
facet normal 0 0 1
outer loop
vertex 1 2 3
vertex 3 2 3
vertex 1 5 7
endloop
endfacet
endsolid triangle\n`;
