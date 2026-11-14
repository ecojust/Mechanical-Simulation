/** Enrich the catalog with original, independently selectable glTF objects. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Box3, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'public/models');
const catalog = JSON.parse(await fs.readFile(path.join(directory, 'catalog.json'), 'utf8'));
const loader = new GLTFLoader();
for (const asset of catalog) {
  const data = await fs.readFile(path.join(directory, path.basename(asset.url)));
  const gltf = await loader.parseAsync(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '');
  gltf.scene.updateMatrixWorld(true);
  asset.nodes = [];
  gltf.scene.traverse(node => {
    if (!node.userData.sourceName) return;
    const box = new Box3().setFromObject(node, true);
    if (box.isEmpty()) throw Error(`Empty object: ${node.name}`);
    const size = box.getSize(new Vector3()).toArray().map(value => +value.toFixed(6));
    const center = box.getCenter(new Vector3()).toArray().map(value => +value.toFixed(6));
    // GLTFLoader sanitizes names for animation paths. Use the actual runtime
    // name, while preserving a source display label for the component browser.
    asset.nodes.push({ name: node.name, displayName: node.userData.sourceName, size, center });
  });
  if (asset.nodes.length !== asset.objects) {
    throw Error(`${asset.id}: expected ${asset.objects} source objects, found ${asset.nodes.length}`);
  }
  console.log(`Indexed ${asset.id}: ${asset.nodes.length} independently selectable objects`);
}
await fs.writeFile(path.join(directory, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
const groundShift = -Math.min(...catalog.map(asset => asset.center[1] - asset.size[1] / 2));
const project = {
  version: 1, name: 'pureTV 原始手柄装配', wires: [],
  parts: catalog.map(asset => ({
    id: `puretv-${asset.id}`, name: asset.name, kind: 'asset',
    position: [asset.center[0], +(asset.center[1] + groundShift).toFixed(6), asset.center[2]],
    rotation: [0, 0, 0], size: asset.size, color: '#92a9b6',
    fixed: asset.id === 'housing-bottom', visible: true,
    params: { assetUrl: asset.url },
  })),
};
await fs.writeFile(path.join(directory, 'puretv-assembly.json'), JSON.stringify(project, null, 2) + '\n');
console.log(`Wrote ${catalog.length} collection catalog and original assembly project.`);
