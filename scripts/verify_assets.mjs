/** Verify generated display meshes with the same loader used by the client. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Box3, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'public/models');
const catalog = JSON.parse(await fs.readFile(path.join(directory, 'catalog.json'), 'utf8'));
const diagnostics = JSON.parse(await fs.readFile(path.join(directory, 'diagnostics.json'), 'utf8'));
const loader = new GLTFLoader();
let failed = false;
for (const asset of catalog) {
  const data = await fs.readFile(path.join(directory, path.basename(asset.url)));
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const gltf = await loader.parseAsync(buffer, '');
  gltf.scene.updateMatrixWorld(true);
  const box = new Box3().setFromObject(gltf.scene, true);
  const size = box.getSize(new Vector3()).toArray();
  const center = box.getCenter(new Vector3()).toArray();
  let meshes = 0;
  gltf.scene.traverse(node => { if (node.isMesh) meshes++; });
  const deviation = Math.max(...size.map((v, i) => Math.abs(v - asset.size[i])),
    ...center.map((v, i) => Math.abs(v - asset.center[i])));
  const recorded = diagnostics.assets.find(record => record.id === asset.id);
  const sha = crypto.createHash('sha256').update(data).digest('hex');
  // This verifies scale/placement, not precise dimensions of simplified surfaces.
  const nodesValid = asset.nodes?.length === asset.objects && asset.nodes.every(indexed => {
    const node = gltf.scene.getObjectByName(indexed.name);
    if (!node || node.userData.sourceName !== indexed.displayName) return false;
    const nodeBox = new Box3().setFromObject(node, true);
    const actualSize = nodeBox.getSize(new Vector3()).toArray();
    const actualCenter = nodeBox.getCenter(new Vector3()).toArray();
    return actualSize.every((v, i) => Number.isFinite(v) && v > 0 && Math.abs(v - indexed.size[i]) < 0.00001)
      && actualCenter.every((v, i) => Math.abs(v - indexed.center[i]) < 0.00001);
  });
  const ok = size.every(v => Number.isFinite(v) && v > 0) &&
    deviation < 0.5 && meshes >= asset.objects && sha === recorded.displaySha256 && nodesValid;
  failed ||= !ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${asset.id}: ${meshes} meshes, source bounds deviation ${deviation.toFixed(6)} mm`);
}
if (failed) process.exitCode = 1;
else console.log(`Verified ${catalog.length} GLB collections.`);
