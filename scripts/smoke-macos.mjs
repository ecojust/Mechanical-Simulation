/** Launch the actual packaged macOS arm64 app before making a public release. */
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

assert.equal(
  process.platform,
  "darwin",
  "Run this check on the macOS release runner",
);
assert.equal(process.arch, "arm64", "Run this check natively on Apple Silicon");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "mechanical-studio-smoke-"),
);
let app;
try {
  app = await electron.launch({
    executablePath: path.join(
      root,
      "release/mac-arm64/Mechanical Studio.app/Contents/MacOS/Mechanical Studio",
    ),
    args: [
      `--user-data-dir=${profile}`,
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
    timeout: 45_000,
  });
  const page = await app.firstWindow({ timeout: 30_000 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByTestId("viewport-canvas").waitFor({ timeout: 30_000 });
  const result = await page.evaluate(async () => {
    const canvas = document.querySelector("canvas");
    const gl = canvas?.getContext("webgl2");
    const response = await fetch("./models/catalog.json");
    if (!response.ok) throw Error("Bundled catalog is unavailable");
    const catalog = await response.json();
    const first = await fetch(catalog[0].url);
    const bytes = new Uint8Array(await first.arrayBuffer());
    return {
      isolated: typeof window.require === "undefined",
      webgl: Boolean(gl && canvas.width > 100 && canvas.height > 100),
      catalogCount: catalog.length,
      modelMagic: new TextDecoder().decode(bytes.slice(0, 4)),
      title: document.title,
    };
  });
  assert.equal(result.isolated, true, "Renderer must have no Node.js access");
  assert.equal(
    result.webgl,
    true,
    "Packaged workbench must create a WebGL canvas",
  );
  assert.equal(
    result.catalogCount,
    15,
    "All original asset collections must be bundled",
  );
  assert.equal(
    result.modelMagic,
    "glTF",
    "A bundled GLB must load through the desktop protocol",
  );
  assert.match(result.title, /Mechanical Studio/);
  // Exercise the actual packaged bayonet UI, not only a static canvas.
  await page.getByRole("button", { name: "插入槽底", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('[aria-label="位置 Y"]').value === "18",
  );
  await page.getByRole("button", { name: "旋转锁定 45°", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('[aria-label="旋转 Y"]').value === "45",
  );
  await page.getByRole("button", { name: "退出插销", exact: true }).click();
  assert.equal(
    await page.getByLabel("位置 Y", { exact: true }).inputValue(),
    "18",
    "Locked pin must resist withdrawal",
  );
  await page.getByRole("button", { name: "逆旋解锁", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('[aria-label="旋转 Y"]').value === "0",
  );
  await page.getByRole("button", { name: "退出插销", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('[aria-label="位置 Y"]').value === "35",
  );
  assert.deepEqual(errors, [], "Packaged renderer emitted an error");
  console.log("Packaged macOS arm64 workbench smoke passed:", result);
} finally {
  await app?.close();
  await fs.rm(profile, { recursive: true, force: true });
}
