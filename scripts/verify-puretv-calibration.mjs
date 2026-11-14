// Verify that the rendered GLB preserves the measured spring/contact geometry.
// This is a display-to-source consistency check, not the source collision audit.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Box3, Raycaster, Vector3 } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const calibration = JSON.parse(await readFile(path.join(root, "docs/puretv-calibration.json"), "utf8"));
const catalog = JSON.parse(await readFile(path.join(root, "public/models/catalog.json"), "utf8"));
const diagnostics = JSON.parse(await readFile(path.join(root, "public/models/diagnostics.json"), "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const loader = new GLTFLoader();
const limit = 0.001; // mm: same scale as the mechanism spring dimension check.
const rows = [];
for (const button of calibration.buttons) {
  const entry = catalog.find((value) => value.id === button.assetId);
  const diagnostic = diagnostics.assets.find((value) => value.id === button.assetId);
  assert.ok(entry && diagnostic, `${button.key}: missing display collection`);
  const source = await readFile(path.join(root, "assets/puretv-controller", button.sourceFile));
  assert.equal(digest(source), button.sourceSha256, `${button.key}: stale source calibration`);
  assert.equal(diagnostic.sourceSha256, button.sourceSha256, `${button.key}: stale display source`);
  const bytes = await readFile(path.join(root, "public", entry.url.replace(/^\.\//, "")));
  assert.equal(digest(bytes), diagnostic.displaySha256, `${button.key}: display checksum`);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const gltf = await new Promise((resolve, reject) => loader.parse(buffer, "", resolve, reject));
  gltf.scene.updateMatrixWorld(true);
  const bySource = new Map();
  gltf.scene.traverse((object) => {
    if (object.userData.sourceName) bySource.set(object.userData.sourceName, object);
  });
  for (const name of [...button.movingNodes, ...button.springNodes, ...button.actuatorNodes,
    button.strikerNode, button.switchNode, button.electricalSwitchNode]) {
    assert.ok(bySource.has(name), `${button.key}: missing source node ${name}`);
  }
  let springError = 0;
  for (const name of button.springNodes) {
    const object = bySource.get(name);
    const box = new Box3().setFromObject(object);
    const length = box.max.y - box.min.y;
    springError = Math.max(springError, Math.abs(length - button.freeLength));
    assert.ok(springError <= limit, `${button.key}: rendered spring length changed by ${springError} mm`);
    const sourceObject = button.objects.find((value) => value.name === name);
    assert.ok(Math.abs(box.min.y - sourceObject.sourceMin[2]) <= limit, `${button.key}: lower spring endpoint moved`);
    assert.ok(Math.abs(box.max.y - sourceObject.sourceMax[2]) <= limit, `${button.key}: upper spring endpoint moved`);
  }
  const contactErrors = [];
  for (const [name, point] of [[button.strikerNode, button.strikerSourceClient], [button.switchNode, button.switchSourceClient]]) {
    const object = bySource.get(name), target = new Vector3(...point);
    const distances = [];
    for (const sign of [-1, 1]) {
      const ray = new Raycaster(target.clone().add(new Vector3(0, sign * 0.02, 0)), new Vector3(0, -sign, 0), 0, 0.04);
      for (const hit of ray.intersectObject(object, true)) distances.push(hit.point.distanceTo(target));
    }
    const error = Math.min(...distances);
    assert.ok(error <= limit, `${button.key}: rendered contact surface ${name} differs by ${error} mm`);
    contactErrors.push(error);
  }
  rows.push({ key: button.key, sourceFile: button.sourceFile, sourceSha256: button.sourceSha256, displaySha256: diagnostic.displaySha256, springEndpointErrorMm: springError, contactSurfaceErrorMm: Math.max(...contactErrors) });
  gltf.scene.traverse((object) => { object.geometry?.dispose(); });
}
assert.equal(rows.length, 9);
console.log(JSON.stringify({ status: "pass", scope: "Rendered source spring endpoints and physical contact surfaces match measured calibration within 0.001 mm; collision/path evidence is separate.", buttons: rows }, null, 2));
