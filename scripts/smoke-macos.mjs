/** Exercise the packaged WKWebView via the application's actual native MCP stdio bridge. */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { drivePuretv, matchesRenderedYScale } from "./drive-puretv.mjs";

assert.equal(
  process.platform,
  "darwin",
  "Run this check on the macOS release runner",
);
assert.equal(process.arch, "arm64", "Run this check natively on Apple Silicon");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.join(
  root,
  "src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Mechanical Studio.app/Contents/MacOS/mechanical-studio",
);
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "mechanical-studio-smoke-"),
);
const env = { ...process.env, MECHANICAL_STUDIO_DATA_DIR: profile };
const processes = [];
const logs = [];
const pending = new Map();
let sequence = 0;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function launch(args) {
  const child = spawn(executable, args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  processes.push(child);
  child.stderr.on("data", (data) => {
    logs.push(data.toString());
    if (logs.length > 200) logs.shift();
  });
  child.on("error", (error) => logs.push(error.message));
  return child;
}
function assertRunning(child) {
  assert.equal(
    child.exitCode,
    null,
    `Packaged process exited (${child.exitCode}): ${logs.join("")}`,
  );
  assert.equal(
    child.signalCode,
    null,
    `Packaged process terminated (${child.signalCode}): ${logs.join("")}`,
  );
}
let client;
function request(method, params = {}) {
  assertRunning(client);
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error(`MCP request timed out: ${method}`));
    }, 55_000);
    pending.set(id, { resolve, reject, timer });
    client.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
  });
}
async function tool(name, args = {}, expectError = false) {
  const result = await request("tools/call", { name, arguments: args });
  if (expectError) {
    assert.equal(
      result.isError,
      true,
      `${name} must reject a physically blocked action`,
    );
    return result;
  }
  assert.notEqual(
    result.isError,
    true,
    `${name} failed: ${JSON.stringify(result.content)}`,
  );
  assert.ok(result.structuredContent, `${name} must return structured content`);
  return result.structuredContent;
}
async function waitForRuntime(predicate, label) {
  const deadline = Date.now() + 15_000;
  let runtime;
  while (Date.now() < deadline) {
    runtime = (await tool("get_runtime_status")).runtime;
    assert.equal(runtime.ready, true, "Actual workbench must remain ready");
    assert.equal(runtime.webgl, true, "Actual WebGL context must not be lost");
    assert.deepEqual(runtime.rendererErrors, [], "Actual renderer must remain healthy");
    if (predicate(runtime)) return runtime;
    await delay(100);
  }
  assert.fail(`${label}: ${JSON.stringify(runtime)}`);
}
try {
  const gui = launch([]);
  // Wait for native setup before asking the WebView to process requests.
  const startupDeadline = Date.now() + 90_000;
  while (true) {
    assertRunning(gui);
    try {
      await fs.access(path.join(profile, "mcp-connection.json"));
      break;
    } catch {}
    assert.ok(
      Date.now() < startupDeadline,
      `Desktop bridge did not start: ${logs.join("")}`,
    );
    await delay(250);
  }
  client = launch(["--mcp"]);
  const lines = createInterface({ input: client.stdout });
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) call.reject(Error(JSON.stringify(message.error)));
      else call.resolve(message.result);
    } catch (error) {
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(error);
      }
      pending.clear();
    }
  });
  client.on("exit", () => {
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(Error(`MCP exited: ${logs.join("")}`));
    }
    pending.clear();
  });
  const initialize = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "packaged-release-smoke", version: "1.0.0" },
  });
  assert.equal(initialize.serverInfo.name, "mechanical-studio");
  client.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  let status;
  let lastError;
  while (Date.now() < startupDeadline) {
    assertRunning(gui);
    try {
      status = (await tool("get_runtime_status")).runtime;
      if (status.ready && status.catalogCount === 15 && status.webgl) break;
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  assert.ok(
    status?.ready,
    `Workbench did not become ready: ${lastError?.message ?? logs.join("")}`,
  );
  assert.equal(status.desktop, true, "Workbench must execute inside Tauri");
  assert.equal(status.webgl, true, "WKWebView must create a WebGL renderer");
  assert.ok(
    status.canvasSize[0] > 100 && status.canvasSize[1] > 100,
    "Canvas must have real dimensions",
  );
  assert.equal(
    status.catalogCount,
    15,
    "All original asset collections must be bundled",
  );
  assert.equal(status.isolated, true, "Renderer must have no Node.js access");
  assert.equal(
    status.modelMagic,
    "glTF",
    "Bundled GLB must load through the desktop protocol",
  );
  assert.match(status.documentTitle, /Mechanical Studio/);
  assert.deepEqual(
    status.rendererErrors,
    [],
    "Packaged renderer emitted an error",
  );

  const initial = await tool("get_project");
  const pin = initial.project.parts.find((part) => part.kind === "bayonet-pin");
  const socket = initial.project.parts.find(
    (part) => part.kind === "bayonet-socket",
  );
  assert.ok(
    pin && socket,
    "Default assembly must include the mating bayonet pair",
  );
  let revision = initial.revision;
  const transform = async (changes) => {
    const result = await tool("transform_part", {
      expectedRevision: revision,
      partId: pin.id,
      ...changes,
    });
    assert.equal(
      result.revision,
      revision + 1,
      "A successful mutation advances the shared project revision",
    );
    revision = result.revision;
    return result.part;
  };
  const seated = [
    socket.position[0],
    socket.position[1] + 5,
    socket.position[2],
  ];
  const withdrawn = [
    socket.position[0],
    socket.position[1] + 22,
    socket.position[2],
  ];
  assert.deepEqual((await transform({ position: seated })).position, seated);
  assert.deepEqual(
    (await transform({ rotation: [0, 45, 0] })).rotation,
    [0, 45, 0],
  );
  await tool(
    "transform_part",
    { expectedRevision: revision, partId: pin.id, position: withdrawn },
    true,
  );
  const blocked = await tool("get_project");
  assert.equal(
    blocked.revision,
    revision,
    "Blocked withdrawal leaves the project unchanged",
  );
  assert.deepEqual(
    blocked.project.parts.find((part) => part.id === pin.id).position,
    seated,
  );
  assert.deepEqual(
    (await transform({ rotation: [0, 0, 0] })).rotation,
    [0, 0, 0],
  );
  assert.deepEqual(
    (await transform({ position: withdrawn })).position,
    withdrawn,
  );
  const validation = await tool("validate_project");
  assert.ok(
    validation.geometry && validation.circuit,
    "The packaged engine must run mechanical and electrical checks",
  );
  // Upload actual model bytes through the same WebView validator and instantiate the result.
  const stl = Buffer.alloc(134);
  stl.writeUInt32LE(1, 80);
  [0, 0, 0, 1, 0, 1, 0, 1, 1].forEach((value, index) =>
    stl.writeFloatLE(value, 96 + index * 4),
  );
  const component = {
    version: 1,
    id: "release-smoke-base",
    name: "Release model",
    kind: "base",
    size: [1, 1, 1],
    color: "#4688aa",
    params: {},
    material: { metalness: 0.25, roughness: 0.6, useSourceColor: true },
    interaction: {
      version: 1,
      status: "configured",
      axis: [0, 1, 0],
      anchor: [0, 0, 0],
      proxySize: [1, 1, 1],
    },
    model: {
      id: "release-smoke-stl",
      name: "release.stl",
      format: "stl",
      data: stl.toString("base64"),
      sha256: createHash("sha256").update(stl).digest("hex"),
      bytes: stl.length,
      size: [1, 1, 1],
      center: [0.5, 0.5, 0.5],
    },
  };
  const imported = await tool("import_component", {
    expectedRevision: revision,
    component,
  });
  assert.equal(imported.revision, ++revision);
  const added = await tool("add_part", {
    expectedRevision: revision,
    componentId: component.id,
    position: [80, 1, 0],
  });
  assert.equal(added.revision, ++revision);
  const painted = await tool("configure_part", {
    expectedRevision: revision,
    partId: added.part.id,
    color: "#cc8844",
    material: { metalness: 0.8, roughness: 0.2 },
  });
  assert.equal(painted.revision, ++revision);
  assert.equal(painted.part.material.useSourceColor, false);
  const portable = (await tool("export_project")).project;
  const ownPart = portable.parts.find((part) => part.id === added.part.id);
  assert.equal(ownPart.kind, "base");
  assert.equal(ownPart.color, "#cc8844");
  assert.deepEqual(ownPart.material, {
    metalness: 0.8,
    roughness: 0.2,
    useSourceColor: false,
  });
  assert.equal(ownPart.interaction.status, "configured");
  assert.equal(
    portable.models.find((model) => model.id === ownPart.model.id).data,
    component.model.data,
  );
  // The spring source and its declared dimensions both use the actual 8 mm free length.
  const springStl = Buffer.from(stl);
  for (const yOffset of [100, 112, 124])
    springStl.writeFloatLE(springStl.readFloatLE(yOffset) * 8, yOffset);
  const springComponent = {
    ...component,
    id: "release-smoke-spring",
    name: "Release spring visual",
    size: [1, 8, 1],
    interaction: { ...component.interaction, proxySize: [1, 8, 1] },
    model: {
      ...component.model,
      id: "release-smoke-spring-stl",
      name: "release-spring.stl",
      data: springStl.toString("base64"),
      sha256: createHash("sha256").update(springStl).digest("hex"),
      size: [1, 8, 1],
      center: [0.5, 4, 0.5],
    },
  };
  const springImported = await tool("import_component", {
    expectedRevision: revision,
    component: springComponent,
  });
  assert.equal(springImported.revision, ++revision);
  // Four independently editable model parts form the functional button assembly.
  const moving = await tool("add_part", {
    expectedRevision: revision,
    componentId: component.id,
    position: [80, 15, 0],
  });
  assert.equal(moving.revision, ++revision);
  const spring = await tool("add_part", {
    expectedRevision: revision,
    componentId: springComponent.id,
    position: [80, 7, 0],
  });
  assert.equal(spring.revision, ++revision);
  assert.deepEqual(
    spring.part.size,
    [1, 8, 1],
    "Spring visual length must equal the declared freeLength",
  );
  const contact = await tool("add_part", {
    expectedRevision: revision,
    componentId: component.id,
    position: [80, 12, 0],
  });
  assert.equal(contact.revision, ++revision);
  for (const member of [moving.part, spring.part]) {
    const unfixed = await tool("configure_part", {
      expectedRevision: revision,
      partId: member.id,
      fixed: false,
    });
    assert.equal(unfixed.revision, ++revision);
  }
  const compound = {
    version: 1,
    id: "release-compound-press",
    name: "Release compound button",
    kind: "press",
    status: "configured",
    partIds: [ownPart.id, moving.part.id, spring.part.id, contact.part.id],
    movingPartIds: [moving.part.id],
    springPartIds: [spring.part.id],
    switchPartId: contact.part.id,
    contact: {
      strikerPartId: moving.part.id,
      strikerPoint: [0, -0.5, 0],
      switchPoint: [0, 0.5, 0],
      switchNormal: [0, 1, 0],
      radius: 0.3,
      maxOvertravel: 0.1,
    },
    frame: { position: [80, 0, 0], rotation: [0, 0, 0] },
    axis: [0, 1, 0],
    pose: { offset: 0, angle: 0 },
    params: {
      mass: 0.02,
      stiffness: 1,
      damping: 0.3,
      travel: 2,
      trigger: 1,
      freeLength: 8,
      solidLength: 2,
    },
    movingProxy: {
      kind: "base",
      position: [0, 15, 0],
      rotation: [0, 0, 0],
      size: [1, 1, 1],
      params: {},
    },
    fixedProxy: {
      kind: "base",
      position: [0, 6.5, 0],
      rotation: [0, 0, 0],
      size: [1, 12, 1],
      params: {},
    },
  };
  const configured = await tool("configure_mechanism", {
    expectedRevision: revision,
    mechanism: compound,
  });
  assert.equal(configured.revision, ++revision);
  const demoButton = initial.project.parts.find(
    (part) => part.kind === "button",
  );
  const demoLamp = initial.project.parts.find((part) => part.kind === "lamp");
  assert.ok(
    demoButton && demoLamp,
    "Default circuit must contain a button and lamp",
  );
  for (const terminal of [0, 1]) {
    const wired = await tool("connect_wire", {
      expectedRevision: revision,
      from: { partId: contact.part.id, terminal },
      to: { partId: demoButton.id, terminal },
    });
    assert.equal(wired.revision, ++revision);
  }
  const pressedCompound = await tool("press_mechanism", {
    expectedRevision: revision,
    mechanismId: compound.id,
    held: true,
    duration: 0.5,
  });
  assert.equal(pressedCompound.revision, ++revision);
  assert.equal(
    pressedCompound.contacts[compound.id].pressed,
    true,
    "Calibrated striker must reach the fixed switch contact point",
  );
  assert.ok(
    pressedCompound.circuit.poweredLampIds.includes(demoLamp.id),
    "The lamp must receive power through the contacted compound switch",
  );
  assert.ok(
    pressedCompound.state.displacement > 1,
    "Compound moving subgroup must compress while pressed",
  );
  assert.ok(
    pressedCompound.members.find((part) => part.id === moving.part.id)
      .position[1] < 15,
    "Computed member pose must move with the press simulation",
  );
  const renderedPress = await waitForRuntime(
    (runtime) =>
      runtime.loadedAssetCount >= 4 &&
      runtime.renderedPositions?.[moving.part.id]?.[1] < 14 &&
      matchesRenderedYScale(runtime.renderedDeformations?.[spring.part.id], 1 - compound.params.travel / compound.params.freeLength) &&
      runtime.deformedPartCount >= 1,
    "WKWebView must load all uploaded STL instances and apply compound motion/deformation to real Three objects",
  );
  assert.equal(
    renderedPress.renderedPositions[ownPart.id][1],
    1,
    "Actual fixed member must remain still during actuation",
  );
  const releasedCompound = await tool("press_mechanism", {
    expectedRevision: revision,
    mechanismId: compound.id,
    held: false,
    duration: 1,
  });
  assert.equal(releasedCompound.revision, ++revision);
  assert.equal(
    releasedCompound.contacts[compound.id].pressed,
    false,
    "Switch must reopen when the striker retracts",
  );
  assert.ok(
    !releasedCompound.circuit.poweredLampIds.includes(demoLamp.id),
    "The lamp must lose power after the striker separates from its switch",
  );
  assert.ok(
    releasedCompound.state.displacement < 0.1,
    "Compound spring must rebound on release",
  );
  await waitForRuntime(
    (runtime) => runtime.renderedPositions?.[moving.part.id]?.[1] > 14.9 &&
      matchesRenderedYScale(runtime.renderedDeformations?.[spring.part.id], 1),
    "Actual WKWebView moving member must return to its rest position after release",
  );
  const rest = await tool("get_project");
  assert.equal(
    rest.project.parts.find((part) => part.id === moving.part.id).position[1],
    15,
    "Runtime press state must preserve rest geometry",
  );
  assert.equal(
    rest.project.mechanisms.find((mechanism) => mechanism.id === compound.id)
      .partIds.length,
    4,
  );
  await tool(
    "transform_part",
    {
      expectedRevision: revision,
      partId: moving.part.id,
      position: [80, 10, 0],
    },
    true,
  );
  const catalog = (await tool("list_components")).repository;
  assert.equal(
    catalog.reduce((count, asset) => count + (asset.nodes?.length ?? 0), 0),
    catalog.reduce((count, asset) => count + asset.objects, 0),
    "Every currently exported source mesh must be indexed individually",
  );
  const groupedAsset = catalog.find((asset) =>
    asset.nodes?.some(
      (node) =>
        node.group &&
        asset.nodes.filter((other) => other.group?.id === node.group.id)
          .length > 1,
    ),
  );
  assert.ok(
    groupedAsset,
    "Source catalog must retain mating group relationships",
  );
  const groupedNode = groupedAsset.nodes.find(
    (node) =>
      node.group &&
      groupedAsset.nodes.filter((other) => other.group?.id === node.group.id)
        .length > 1,
  );
  const sourceNames = groupedAsset.nodes
    .filter((node) => node.group?.id === groupedNode.group.id)
    .slice(0, 2)
    .map((node) => node.name);
  const source = await tool("add_repository_parts", {
    expectedRevision: revision,
    assetId: groupedAsset.id,
    nodeNames: sourceNames,
    offset: [300, 0, 0],
  });
  assert.equal(source.revision, ++revision);
  assert.equal(source.parts.length, 2);
  assert.deepEqual(
    source.parts[0].assemblyGroup,
    source.parts[1].assemblyGroup,
  );
  const afterSource = await tool("get_project");
  for (const part of source.parts)
    assert.equal(
      afterSource.project.parts.find((item) => item.id === part.id).params
        .assetNode,
      part.params.assetNode,
    );
  // Give WKWebView a frame to mount uploaded/source meshes before checking renderer errors.
  await delay(500);
  const calibration = JSON.parse(
    await fs.readFile(path.join(root, "docs/puretv-calibration.json"), "utf8"),
  );
  const puretv = await drivePuretv(tool, {
    calibration,
    requireEvidence: true,
    waitForRendered: true,
    onStep: (message) => console.log(`Packaged pureTV: ${message}`),
  });
  assert.equal(
    puretv.report.execution.nativeDesktop,
    true,
    "The complete controller must run in the packaged Tauri WebView",
  );
  assert.equal(puretv.report.after.sourceEvidenceStatus, "pass");
  assert.equal(
    puretv.report.tests.length,
    9,
    "All nine source buttons must close only on contact and reopen after release",
  );
  await fs.writeFile(
    path.join(root, "src-tauri/target/puretv-macos-mcp-verification.json"),
    JSON.stringify(puretv.report, null, 2) + "\n",
  );
  const finalStatus = (await tool("get_runtime_status")).runtime;
  assert.deepEqual(
    finalStatus.rendererErrors,
    [],
    "Packaged renderer emitted an error during assembly",
  );
  console.log(
    "Packaged Tauri macOS arm64 workbench smoke passed:",
    JSON.stringify({
      ...status,
      mcpTools: (await request("tools/list")).tools.length,
      bayonet: "insert / lock / blocked withdrawal / unlock / withdraw",
      components:
        "STL import / typed instance / PBR recolor / portable export / grouped repository meshes / compound press and spring rebound",
      puretv: {
        sourceParts: puretv.report.sourceParts,
        totalParts: puretv.report.totalParts,
        buttons: puretv.report.tests.length,
        sourceEvidence: puretv.report.after.sourceEvidenceStatus,
        issues: puretv.report.after.issues,
      },
    }),
  );
} catch (error) {
  console.error("Packaged app stderr:", logs.join(""));
  throw error;
} finally {
  for (const call of pending.values()) clearTimeout(call.timer);
  for (const child of processes.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([exited, delay(3_000)]);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
  await fs.rm(profile, { recursive: true, force: true });
}
