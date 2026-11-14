/** Enrich the catalog with original, independently selectable glTF objects. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Box3, Vector3 } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { repositoryNodeMetadata } from "./repository_metadata.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(root, "public/models");
const catalog = JSON.parse(
  await fs.readFile(path.join(directory, "catalog.json"), "utf8"),
);
const loader = new GLTFLoader();
for (const asset of catalog) {
  const data = await fs.readFile(
    path.join(directory, path.basename(asset.url)),
  );
  const gltf = await loader.parseAsync(
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    "",
  );
  gltf.scene.updateMatrixWorld(true);
  asset.kind = "asset"; // Imported assemblies require explicit interaction configuration.
  asset.nodes = [];
  gltf.scene.traverse((node) => {
    if (!node.userData.sourceName) return;
    const box = new Box3().setFromObject(node, true);
    if (box.isEmpty()) throw Error(`Empty object: ${node.name}`);
    const size = box
      .getSize(new Vector3())
      .toArray()
      .map((value) => +value.toFixed(6));
    const center = box
      .getCenter(new Vector3())
      .toArray()
      .map((value) => +value.toFixed(6));
    // GLTFLoader sanitizes names for animation paths. Use the actual runtime
    // name, while preserving a source display label for the component browser.
    const indexed = {
      name: node.name,
      displayName: node.userData.sourceName,
      size,
      center,
    };
    asset.nodes.push({ ...indexed, ...repositoryNodeMetadata(asset, indexed) });
  });
  if (asset.nodes.length !== asset.objects) {
    throw Error(
      `${asset.id}: expected ${asset.objects} source objects, found ${asset.nodes.length}`,
    );
  }
  console.log(
    `Indexed ${asset.id}: ${asset.nodes.length} independently selectable objects`,
  );
}
await fs.writeFile(
  path.join(directory, "catalog.json"),
  JSON.stringify(catalog, null, 2) + "\n",
);
const groundShift = -Math.min(
  ...catalog.map((asset) => asset.center[1] - asset.size[1] / 2),
);
const project = {
  version: 1,
  name: "pureTV 原始手柄装配",
  wires: [],
  parts: catalog.flatMap((asset) =>
    asset.nodes.map((node, index) => ({
      id: `puretv-${asset.id}-${index + 1}`,
      name: node.displayName,
      kind: node.kind,
      position: [
        node.center[0],
        +(node.center[1] + groundShift).toFixed(6),
        node.center[2],
      ],
      rotation: [0, 0, 0],
      size: node.size,
      color: "#92a9b6",
      fixed: asset.id === "housing-bottom",
      visible: true,
      params: { assetUrl: asset.url, assetNode: node.name },
      ...(node.group
        ? {
            assemblyGroup: {
              id: `puretv-${node.group.id}`,
              name: node.group.name,
            },
          }
        : {}),
      ...(node.kind !== "asset"
        ? {
            interaction: {
              version: 1,
              status: "unconfigured",
              axis: [0, 1, 0],
              anchor: [0, 0, 0],
              proxySize: node.size,
            },
          }
        : {}),
    })),
  ),
};
await fs.writeFile(
  path.join(directory, "puretv-assembly.json"),
  JSON.stringify(project, null, 2) + "\n",
);
console.log(
  `Wrote ${catalog.length} collections and ${project.parts.length} independent source parts.`,
);
