/** Allocation-free structural checks shared by browser uploads, project import and MCP. */
export const MODEL_LIMIT_BYTES = 12 * 1024 * 1024;
export const MODEL_TRIANGLE_LIMIT = 200_000;
const VERTEX_LIMIT = MODEL_TRIANGLE_LIMIT * 3;
const COORDINATE_LIMIT = 1e8;
function fail(message: string): never {
  throw Error(message);
}
function boundedInteger(
  value: unknown,
  min: number,
  max: number,
  label: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    fail(`${label}无效或超出模型预算。`);
  return value as number;
}
function finiteCoordinate(value: number): void {
  if (!Number.isFinite(value) || Math.abs(value) > COORDINATE_LIMIT)
    fail("模型包含非有限或过大的坐标。");
}
function inspectStl(bytes: Uint8Array): void {
  if (bytes.length >= 84) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint32(80, true);
    if (84 + count * 50 === bytes.length) {
      boundedInteger(count, 1, MODEL_TRIANGLE_LIMIT, "STL 三角形数量");
      for (let face = 0; face < count; face++)
        for (let component = 0; component < 12; component++)
          finiteCoordinate(
            view.getFloat32(84 + face * 50 + component * 4, true),
          );
      return;
    }
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("不是有效的二进制或 ASCII STL。");
  }
  if (!/^\s*solid(?:\s|$)/i.test(source) || !/endsolid(?:\s|$)/i.test(source))
    fail("不是有效的二进制或 ASCII STL。");
  const number = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?";
  const triple = `(${number})\\s+(${number})\\s+(${number})`;
  const facet = new RegExp(
    `facet\\s+normal\\s+${triple}\\s+outer\\s+loop\\s+vertex\\s+${triple}\\s+vertex\\s+${triple}\\s+vertex\\s+${triple}\\s+endloop\\s+endfacet`,
    "gi",
  );
  let count = 0;
  const remainder = source
    .replace(facet, (...match: unknown[]) => {
      count++;
      if (count > MODEL_TRIANGLE_LIMIT) fail("STL 三角形超过 200,000 个。");
      for (let component = 1; component <= 12; component++)
        finiteCoordinate(Number(match[component]));
      return "";
    })
    .replace(/^\s*(?:endsolid|solid)(?:[^\r\n]*)$/gim, "")
    .trim();
  if (!count || remainder) fail("ASCII STL 顶点或面定义不完整。");
}
type Document = Record<string, any>;
function list(document: Document, key: string, max: number): any[] {
  const value = document[key] ?? [];
  if (!Array.isArray(value) || value.length > max)
    fail(`GLB ${key} 超出模型预算。`);
  return value;
}
function inspectImage(bytes: Uint8Array, mimeType: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0,
    height = 0;
  if (mimeType === "image/png") {
    if (
      bytes.length < 24 ||
      view.getUint32(0) !== 0x89504e47 ||
      view.getUint32(4) !== 0x0d0a1a0a ||
      view.getUint32(12) !== 0x49484452
    )
      fail("GLB 内嵌 PNG 文件头无效。");
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (mimeType === "image/jpeg") {
    if (bytes.length < 4 || view.getUint16(0) !== 0xffd8)
      fail("GLB 内嵌 JPEG 文件头无效。");
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) fail("GLB 内嵌 JPEG 数据无效。");
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) fail("GLB 内嵌 JPEG 数据不完整。");
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length)
        fail("GLB 内嵌 JPEG 数据不完整。");
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker)
      ) {
        if (length < 8) fail("GLB 内嵌 JPEG 尺寸无效。");
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
        break;
      }
      offset += length;
    }
  } else fail("模型图片须为内嵌 PNG 或 JPEG。");
  boundedInteger(width, 1, 4096, "纹理宽度");
  boundedInteger(height, 1, 4096, "纹理高度");
  return width * height;
}
export function inspectModelBytes(
  bytes: Uint8Array,
  format: "glb" | "stl",
): void {
  if (!bytes.byteLength || bytes.byteLength > MODEL_LIMIT_BYTES)
    fail("模型文件必须在 1 字节至 12 MiB 之间。");
  if (format === "stl") {
    inspectStl(bytes);
    return;
  }
  if (format !== "glb" || bytes.length < 20) fail("GLB 文件头不完整。");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint32(0, true) !== 0x46546c67 ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== bytes.length
  )
    fail("只支持完整的 GLB 2.0 文件。");
  let offset = 12,
    document: Document | undefined,
    binary: Uint8Array | undefined;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) fail("GLB 数据块不完整。");
    const length = view.getUint32(offset, true),
      kind = view.getUint32(offset + 4, true);
    offset += 8;
    if (length % 4 || offset + length > bytes.length)
      fail("GLB 数据块长度无效。");
    if (kind === 0x4e4f534a) {
      if (document || offset !== 20 || length > 2 * 1024 * 1024)
        fail("GLB JSON 数据块无效或超过 2 MiB。");
      try {
        document = JSON.parse(
          new TextDecoder("utf-8", { fatal: true })
            .decode(bytes.subarray(offset, offset + length))
            .trim(),
        );
      } catch {
        fail("GLB JSON 无效。");
      }
    } else if (kind === 0x004e4942) {
      if (binary || !document) fail("GLB 二进制数据块无效。");
      binary = bytes.subarray(offset, offset + length);
    } else fail("GLB 包含不支持的数据块。");
    offset += length;
  }
  if (!document || document.asset?.version !== "2.0" || !binary)
    fail("缺少 GLB 2.0 内嵌场景数据。");
  let itemCount = 0;
  const visit = (value: unknown, depth = 0) => {
    if (++itemCount > 150_000 || depth > 80)
      fail("模型数据嵌套过深或过于复杂。");
    if (typeof value === "number") finiteCoordinate(value);
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "uri")
        fail("只接受资源完全内嵌的 GLB；请将外部图片/缓冲区打包到模型内。");
      if (
        [
          "KHR_draco_mesh_compression",
          "EXT_meshopt_compression",
          "KHR_texture_basisu",
          "EXT_texture_webp",
          "EXT_mesh_gpu_instancing",
        ].includes(key)
      )
        fail("请上传未压缩的静态 GLB，以便直接测量和校验。");
      visit(item, depth + 1);
    }
  };
  visit(document);
  if (
    list(document, "skins", 0).length ||
    list(document, "animations", 0).length
  )
    fail("请上传静态机械模型。");
  const extensions = [
    ...list(document, "extensionsUsed", 64),
    ...list(document, "extensionsRequired", 64),
  ];
  for (const extension of extensions)
    if (
      [
        "KHR_draco_mesh_compression",
        "EXT_meshopt_compression",
        "KHR_texture_basisu",
        "EXT_texture_webp",
        "EXT_mesh_gpu_instancing",
      ].includes(extension)
    )
      fail("请上传未压缩的静态 GLB，以便直接测量和校验。");
  const buffers = list(document, "buffers", 1);
  if (buffers.length !== 1) fail("GLB 必须使用单个内嵌缓冲区。");
  const binaryLength = boundedInteger(
    buffers[0].byteLength,
    1,
    binary.length,
    "缓冲区长度",
  );
  if (binary.length - binaryLength > 3) fail("GLB 二进制缓冲区长度不匹配。");
  const views = list(document, "bufferViews", 4096);
  for (const buffer of views) {
    if (buffer.buffer !== 0) fail("GLB 缓冲区引用无效。");
    const start = boundedInteger(
      buffer.byteOffset ?? 0,
      0,
      binaryLength,
      "缓冲区起点",
    );
    const length = boundedInteger(
      buffer.byteLength,
      1,
      binaryLength,
      "缓冲区长度",
    );
    if (start + length > binaryLength) fail("GLB 缓冲区超出实际内嵌数据。");
    if (buffer.byteStride !== undefined) {
      const stride = boundedInteger(buffer.byteStride, 4, 252, "顶点步长");
      if (stride % 4) fail("顶点步长必须是 4 字节的倍数。");
    }
  }
  const accessors = list(document, "accessors", 4096);
  const components: Record<string, number> = {
    SCALAR: 1,
    VEC2: 2,
    VEC3: 3,
    VEC4: 4,
    MAT2: 4,
    MAT3: 9,
    MAT4: 16,
  };
  const byteSizes: Record<number, number> = {
    5120: 1,
    5121: 1,
    5122: 2,
    5123: 2,
    5125: 4,
    5126: 4,
  };
  const binView = new DataView(
    binary.buffer,
    binary.byteOffset,
    binary.byteLength,
  );
  let accessorValues = 0;
  const layouts = accessors.map((accessor) => {
    if (accessor.sparse !== undefined)
      fail("暂不支持稀疏顶点数据，请导出普通网格。");
    const count = boundedInteger(accessor.count, 1, VERTEX_LIMIT, "顶点数量");
    const buffer =
      views[
        boundedInteger(
          accessor.bufferView,
          0,
          views.length - 1,
          "顶点缓冲区索引",
        )
      ];
    const width = components[accessor.type],
      bytesPerComponent = byteSizes[accessor.componentType];
    if (!width || !bytesPerComponent) fail("GLB 顶点数据类型无效。");
    accessorValues += count * width;
    if (accessorValues > 8_000_000) fail("模型顶点属性总量超出预算。");
    // Mechanical imports do not use matrix attributes; reject their special packed alignment rules.
    if (String(accessor.type).startsWith("MAT"))
      fail("静态机械模型不支持矩阵顶点属性。");
    const localOffset = boundedInteger(
      accessor.byteOffset ?? 0,
      0,
      buffer.byteLength,
      "顶点起点",
    );
    const start = (buffer.byteOffset ?? 0) + localOffset,
      stride = buffer.byteStride ?? width * bytesPerComponent;
    if (
      start % bytesPerComponent ||
      stride < width * bytesPerComponent ||
      localOffset + (count - 1) * stride + width * bytesPerComponent >
        buffer.byteLength
    )
      fail("GLB 顶点数据超出实际缓冲区。");
    if (accessor.componentType === 5126)
      for (let index = 0; index < count; index++)
        for (let component = 0; component < width; component++)
          finiteCoordinate(
            binView.getFloat32(start + index * stride + component * 4, true),
          );
    return {
      count,
      start,
      stride,
      componentType: accessor.componentType,
      type: accessor.type,
    };
  });
  const meshes = list(document, "meshes", 1024),
    meshTriangles: number[] = [];
  let primitiveCount = 0,
    totalVertices = 0;
  for (const mesh of meshes) {
    if (!Array.isArray(mesh.primitives) || !mesh.primitives.length)
      fail("模型缺少三角网格。");
    let triangles = 0;
    for (const primitive of mesh.primitives) {
      if (++primitiveCount > 2048) fail("模型网格组过多。");
      if (primitive.mode !== undefined && primitive.mode !== 4)
        fail("机械模型只支持三角网格。");
      if (primitive.targets?.length) fail("请移除模型的形变动画目标。");
      const position =
        layouts[
          boundedInteger(
            primitive.attributes?.POSITION,
            0,
            layouts.length - 1,
            "位置顶点索引",
          )
        ];
      if (position.type !== "VEC3" || position.componentType !== 5126)
        fail("位置顶点须使用浮点 VEC3 数据。");
      totalVertices += position.count;
      if (totalVertices > VERTEX_LIMIT) fail("模型顶点超过 600,000 个。");
      for (const index of Object.values(primitive.attributes ?? {}))
        boundedInteger(index, 0, layouts.length - 1, "属性顶点索引");
      let count = position.count;
      if (primitive.indices !== undefined) {
        const indices =
          layouts[
            boundedInteger(
              primitive.indices,
              0,
              layouts.length - 1,
              "三角形索引",
            )
          ];
        if (
          indices.type !== "SCALAR" ||
          ![5121, 5123, 5125].includes(indices.componentType)
        )
          fail("GLB 三角形索引类型无效。");
        count = indices.count;
        for (let index = 0; index < count; index++) {
          const at = indices.start + index * indices.stride;
          const value =
            indices.componentType === 5121
              ? binView.getUint8(at)
              : indices.componentType === 5123
                ? binView.getUint16(at, true)
                : binView.getUint32(at, true);
          if (value >= position.count) fail("GLB 三角形索引超出顶点范围。");
        }
      }
      if (count % 3) fail("GLB 三角形顶点数量不完整。");
      triangles += count / 3;
    }
    meshTriangles.push(triangles);
  }
  const nodes = list(document, "nodes", 2048),
    parents = new Map<number, number>(),
    visiting = new Set<number>(),
    depths = new Map<number, number>();
  let sceneTriangles = 0;
  const walk = (index: number, depth: number): number => {
    if (depth > 64 || visiting.has(index)) fail("模型节点存在循环或层级过深。");
    boundedInteger(index, 0, nodes.length - 1, "模型节点引用");
    const known = depths.get(index);
    if (known !== undefined) {
      if (depth + known > 64) fail("模型节点层级过深。");
      return known;
    }
    const node = nodes[index];
    for (const [key, length] of [
      ["translation", 3],
      ["rotation", 4],
      ["scale", 3],
      ["matrix", 16],
    ] as const) {
      const transform = node[key];
      if (
        transform !== undefined &&
        (!Array.isArray(transform) ||
          transform.length !== length ||
          transform.some((value: unknown) => typeof value !== "number" || !Number.isFinite(value)))
      )
        fail(`GLB 节点 ${key} 变换无效。`);
    }
    if (node.matrix !== undefined && ["translation", "rotation", "scale"].some(key => node[key] !== undefined))
      fail("GLB 节点不能同时声明矩阵和位移/旋转/缩放。");
    if (node.rotation && Math.abs(Math.hypot(...node.rotation) - 1) > 1e-4)
      fail("GLB 节点旋转须为单位四元数。");
    visiting.add(index);
    if (node.mesh !== undefined)
      sceneTriangles +=
        meshTriangles[
          boundedInteger(node.mesh, 0, meshes.length - 1, "网格引用")
        ];
    if (sceneTriangles > MODEL_TRIANGLE_LIMIT)
      fail("显示模型超过 200,000 个三角形，请先简化。");
    if (node.children !== undefined && !Array.isArray(node.children))
      fail("模型子节点定义无效。");
    let height = 0;
    for (const child of node.children ?? []) {
      if (parents.has(child)) fail("同一节点不能被重复引用或有多个父节点。");
      parents.set(child, index);
      height = Math.max(height, walk(child, depth + 1) + 1);
    }
    visiting.delete(index);
    if (height + depth > 64) fail("模型节点层级过深。");
    depths.set(index, height);
    return height;
  };
  nodes.forEach((_: unknown, index: number) => walk(index, 0));
  if (!sceneTriangles) fail("模型中没有可显示的三角网格。");
  const scenes = list(document, "scenes", 64);
  const selectedScene = scenes[boundedInteger(document.scene ?? 0, 0, scenes.length - 1, "默认场景索引")];
  for (const scene of scenes) {
    if (!Array.isArray(scene.nodes) || scene.nodes.length > 2048)
      fail("模型场景节点无效。");
    const roots = new Set<number>();
    for (const index of scene.nodes) {
      boundedInteger(index, 0, nodes.length - 1, "场景节点引用");
      if (roots.has(index) || parents.has(index)) fail("场景根节点引用无效。");
      roots.add(index);
    }
  }
  const hasMesh = (index: number): boolean => nodes[index].mesh !== undefined || (nodes[index].children ?? []).some(hasMesh);
  if (!selectedScene.nodes.some(hasMesh))
    fail("GLB 默认场景中没有可显示的三角网格。");
  const images = list(document, "images", 64);
  let pixels = 0;
  for (const image of images) {
    const buffer =
      views[
        boundedInteger(image.bufferView, 0, views.length - 1, "图片缓冲区引用")
      ];
    pixels += inspectImage(
      binary.subarray(
        buffer.byteOffset ?? 0,
        (buffer.byteOffset ?? 0) + buffer.byteLength,
      ),
      image.mimeType,
    );
    if (pixels > 32 * 1024 * 1024) fail("纹理像素总量超过 32 Mi，请缩小贴图。");
  }
  list(document, "materials", 512);
  list(document, "textures", 128);
  list(document, "samplers", 128);
}
