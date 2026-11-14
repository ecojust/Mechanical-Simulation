/** Assemble and exercise the actual workbench exclusively through its MCP tools. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { connectWorkbench } from "./mcp-client.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const plus = (point, offset) => point.map((value, index) => value + offset[index]);
const minus = (point, origin) => point.map((value, index) => value - origin[index]);
const closeTo = (actual, expected, tolerance = 0.002) =>
  Math.abs(actual - expected) <= tolerance;
export const matchesRenderedYScale = (matrix, ratio) =>
  Array.isArray(matrix) && matrix.length === 16 &&
  matrix.every((value, index) => Number.isFinite(value) &&
    closeTo(value, index === 5 ? ratio : [0, 10, 15].includes(index) ? 1 : 0, 0.0001));
const summary = (issues = []) => Object.fromEntries(
  ["error", "warning", "pass"].map((severity) => [severity,
    issues.filter((issue) => issue.severity === severity).length]),
);

export async function drivePuretv(tool, {
  calibration,
  requireEvidence = false,
  waitForRendered = true,
  onStep = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  assert.equal(calibration?.version, 1, "A measured calibration file is required");
  assert.equal(calibration.buttons.length, 9, "All nine source buttons must be calibrated");
  assert.deepEqual(calibration.offset, [0, 20, 0], "Use the documented common ground offset");
  const startedAt = new Date().toISOString();
  const operations = [];
  let revision = (await tool("get_project")).revision;
  async function mutate(name, args) {
    const result = await tool(name, { expectedRevision: revision, ...args });
    assert.equal(result.revision, revision + 1, `${name} must update the actual workbench revision`);
    revision = result.revision;
    operations.push({ tool: name, revision, ...(
      name === "add_repository_parts" ? { assetId: args.assetId, parts: result.parts.length } :
      name === "configure_mechanism" ? { mechanismId: args.mechanism.id } :
      name === "press_mechanism" ? { mechanismId: args.mechanismId, held: args.held, duration: args.duration } : {}
    ) });
    return result;
  }
  const listed = await tool("list_components");
  assert.equal(listed.repository.length, 15, "The complete source collection set is required");
  const sourceCount = listed.repository.reduce((sum, asset) => sum + asset.nodes.length, 0);
  await mutate("new_project", { name: "pureTV 手柄 · 九键触点与指示灯试验" });
  const collections = new Map();
  for (const asset of listed.repository) {
    const result = await mutate("add_repository_parts", { assetId: asset.id, offset: calibration.offset });
    assert.equal(result.parts.length, asset.nodes.length);
    collections.set(asset.id, { asset, parts: result.parts });
    onStep(`MCP assembled ${asset.id}: ${result.parts.length} independent parts`);
  }
  const rigs = [];
  for (const button of calibration.buttons) {
    const collection = collections.get(button.assetId);
    assert.ok(collection, `Missing ${button.assetId}`);
    const partFor = (name) => {
      const node = collection.asset.nodes.find((item) => item.name === name || item.displayName === name);
      assert.ok(node, `Missing calibrated source node ${name}`);
      const part = collection.parts.find((item) => item.params.assetNode === node.name);
      assert.ok(part);
      return part;
    };
    const guide = button.guide;
    for (const key of ["pinDiameter", "holeDiameter", "outerDiameter", "height", "shaftHeight", "tolerance", "minClearance", "insertionDepth"])
      assert.ok(Number.isFinite(guide?.[key]), `${button.key}: measured guide.${key} is required`);
    const framePosition = plus(guide.centerClient, calibration.offset);
    const striker = partFor(button.strikerNode), contactPart = partFor(button.switchNode);
    const electricalSwitch = (await mutate("configure_part", {
      partId: partFor(button.electricalSwitchNode).id, fixed: true,
    })).part;
    const movingParts = button.movingNodes.map(partFor), springs = button.springNodes.map(partFor);
    const actuatorParts = button.actuatorNodes.map(partFor);
    const mechanism = {
      version: 1, id: `puretv-${button.key}-press`, name: `${button.label} · 按键`,
      kind: "press", status: "configured", partIds: collection.parts.map((part) => part.id),
      movingPartIds: movingParts.map((part) => part.id), springPartIds: springs.map((part) => part.id),
      switchPartId: electricalSwitch.id, frame: { position: framePosition, rotation: [0, 0, 0] },
      axis: button.axis, pose: { offset: 0, angle: 0 },
      params: Object.fromEntries([
        "mass", "stiffness", "damping", "travel", "freeLength", "solidLength",
      ].map((key) => {
        assert.ok(Number.isFinite(button[key]), `${button.key}.${key} is required`);
        return [key, button[key]];
      })),
      movingProxy: {
        kind: "pin", position: minus(plus(guide.shaftCenterClient, calibration.offset), framePosition),
        rotation: [0, 0, 0], size: [guide.pinDiameter, guide.shaftHeight, guide.pinDiameter],
        params: { pinDiameter: guide.pinDiameter, tolerance: guide.tolerance },
      },
      fixedProxy: {
        kind: "sleeve", position: [0, 0, 0], rotation: [0, 0, 0],
        size: [guide.outerDiameter, guide.height, guide.outerDiameter],
        params: { holeDiameter: guide.holeDiameter, tolerance: guide.tolerance },
      },
      contact: {
        strikerPartId: striker.id,
        targetPartId: contactPart.id,
        strikerPoint: minus(plus(button.strikerSourceClient, calibration.offset), striker.position),
        switchPoint: minus(plus(button.switchSourceClient, calibration.offset), contactPart.position),
        switchNormal: [0, 1, 0],
        radius: Math.min(contactPart.size[0], contactPart.size[2]) / 4,
        maxOvertravel: button.maxOvertravel ?? 0.25,
        actuatorPartIds: actuatorParts.map((part) => part.id),
      },
    };
    mechanism.params.insertionDepth = guide.insertionDepth;
    mechanism.params.minClearance = guide.minClearance;
    const configured = await mutate("configure_mechanism", { mechanism });
    const errors = configured.issues.filter((issue) => issue.severity === "error");
    assert.deepEqual(errors, [], `${button.key}: invalid measured mechanism`);
    const movable = new Set([...movingParts, ...springs, ...actuatorParts].map((part) => part.id));
    rigs.push({ button, mechanism, striker, contactPart, electricalSwitch, movingParts, springs, actuatorParts,
      fixedParts: collection.parts.filter((part) => !movable.has(part.id)) });
  }
  const battery = (await mutate("add_part", { kind: "battery", position: [-88, 6, 73] })).part;
  await mutate("configure_part", { partId: battery.id, name: "试验台 · 5 V 电源", fixed: true, params: { voltage: 5 } });
  for (const [index, rig] of rigs.entries()) {
    const lamp = (await mutate("add_part", { kind: "lamp", position: [-60 + index * 15, 8, 73] })).part;
    rig.lamp = (await mutate("configure_part", { partId: lamp.id, name: `${rig.button.label} · 指示灯`, fixed: true, params: { resistance: 100 } })).part;
    for (const [from, to] of [
      [{ partId: battery.id, terminal: 0 }, { partId: rig.electricalSwitch.id, terminal: 0 }],
      [{ partId: rig.electricalSwitch.id, terminal: 1 }, { partId: lamp.id, terminal: 0 }],
      [{ partId: lamp.id, terminal: 1 }, { partId: battery.id, terminal: 1 }],
    ]) await mutate("connect_wire", { from, to });
  }
  const assembled = await tool("get_project");
  assert.equal(assembled.project.parts.length, sourceCount + 10);
  assert.equal(assembled.project.wires.length, 27);
  assert.equal(assembled.project.mechanisms.length, 9);

  async function runtimeUntil(predicate, label) {
    const deadline = Date.now() + 45_000;
    let runtime;
    while (Date.now() < deadline) {
      runtime = (await tool("get_runtime_status")).runtime;
      assert.equal(runtime.ready, true, "The actual workbench must remain ready");
      assert.equal(runtime.webgl, true, "The actual WebGL context must remain usable");
      assert.deepEqual(runtime.rendererErrors, [], "Actual renderer must have no errors");
      if (predicate(runtime)) return runtime;
      await pause(200);
    }
    assert.fail(`${label}: ${JSON.stringify(runtime)}`);
  }
  const loaded = await runtimeUntil((runtime) => runtime.loadedAssetCount === sourceCount, "All original subparts must finish loading");
  const before = await tool("validate_project");
  assert.deepEqual(before.issues.filter((issue) => issue.severity === "error"), [], "Assembly must have no dimensional/functional errors");
  assert.deepEqual(before.circuit.poweredLampIds, [], "All nine lamps must be off at rest");
  if (requireEvidence) assert.equal(before.sourceEvidence?.status, "pass", "Source geometry evidence must match this exact assembled project");

  const tests = [];
  for (const rig of rigs) {
    const { mechanism, button, striker, contactPart, lamp } = rig;
    const approach = await mutate("press_mechanism", { mechanismId: mechanism.id, held: true, duration: 0.001 });
    assert.ok(approach.contacts[mechanism.id].gap > 0, `${button.key}: approach must remain before contact`);
    assert.deepEqual(approach.circuit.poweredLampIds, [], "Displacement alone must not light a lamp");
    const pressed = await mutate("press_mechanism", { mechanismId: mechanism.id, held: true, duration: 0.5 });
    const contact = pressed.contacts[mechanism.id];
    assert.ok(closeTo(pressed.state.displacement, button.travel));
    assert.equal(contact.pressed, true);
    assert.ok(closeTo(contact.surfaceGap, 0));
    assert.ok(closeTo(contact.actuatorTravel, 0.25));
    assert.deepEqual(pressed.circuit.poweredLampIds, [lamp.id], `${button.key}: only its own lamp may light`);
    assert.ok(closeTo(pressed.circuit.current, 0.05, 1e-6), "5 V / 100 ohm = 50 mA");
    if (requireEvidence) assert.equal(pressed.sourceEvidence?.status, "pass");
    let pressedRenderer, releasedRenderer;
    if (waitForRendered) pressedRenderer = await runtimeUntil((runtime) => {
      const positions = runtime.renderedPositions;
      return positions[striker.id] && positions[contactPart.id] &&
        closeTo(positions[striker.id][1], striker.position[1] - button.travel) &&
        closeTo(positions[contactPart.id][1], contactPart.position[1] - contact.actuatorTravel) &&
        rig.movingParts.every((part) => positions[part.id] && closeTo(positions[part.id][1], part.position[1] - button.travel)) &&
        rig.actuatorParts.every((part) => positions[part.id] && closeTo(positions[part.id][1], part.position[1] - contact.actuatorTravel)) &&
        rig.springs.every((spring) => positions[spring.id] && closeTo(positions[spring.id][1], spring.position[1] - button.travel / 2)) &&
        rig.springs.every((spring) => matchesRenderedYScale(runtime.renderedDeformations?.[spring.id], 1 - button.travel / button.freeLength)) &&
        rig.fixedParts.every((part) => positions[part.id] && part.position.every((value, axis) => closeTo(positions[part.id][axis], value))) &&
        runtime.deformedPartCount >= rig.springs.length;
    }, `${button.key}: actual Three objects must move with cap, spring and actuator`);
    const released = await mutate("press_mechanism", { mechanismId: mechanism.id, held: false, duration: 1.5 });
    assert.ok(Math.abs(released.state.displacement) < 0.001 && Math.abs(released.state.velocity) < 0.001);
    assert.deepEqual(released.circuit.poweredLampIds, [], "Release must turn all lamps off");
    assert.equal(released.contacts[mechanism.id].pressed, false);
    if (waitForRendered) releasedRenderer = await runtimeUntil((runtime) =>
      [...rig.movingParts, ...rig.springs, ...rig.actuatorParts, ...rig.fixedParts].every((part) =>
        runtime.renderedPositions[part.id] && part.position.every((value, axis) => closeTo(runtime.renderedPositions[part.id][axis], value)),
      ) && rig.springs.every((spring) => matchesRenderedYScale(runtime.renderedDeformations?.[spring.id], 1)) &&
        runtime.deformedPartCount === 0,
    `${button.key}: actual cap, spring and actuator must return while the base stays fixed`);
    tests.push({
      key: button.key, label: button.label, status: "pass", mechanismId: mechanism.id,
      sourceAssetId: button.assetId, sourceStrikerNode: button.strikerNode, sourceSwitchNode: button.switchNode,
      sourceElectricalSwitchNode: button.electricalSwitchNode,
      precontact: { displacement: approach.state.displacement, gap: approach.contacts[mechanism.id].gap, litLamps: approach.circuit.poweredLampIds.length },
      pressed: { displacement: pressed.state.displacement, contact, litLampId: lamp.id, litLamp: lamp.name, litLamps: pressed.circuit.poweredLampIds.length, currentA: pressed.circuit.current },
      released: { displacement: released.state.displacement, velocity: released.state.velocity, contact: released.contacts[mechanism.id], litLamps: released.circuit.poweredLampIds.length },
      actualRendererChecked: waitForRendered,
      springTransforms: waitForRendered ? {
        pressed: rig.springs.map((part) => ({ partId: part.id, matrix: pressedRenderer.renderedDeformations[part.id] })),
        released: rig.springs.map((part) => ({ partId: part.id, matrix: releasedRenderer.renderedDeformations[part.id] })),
      } : undefined,
    });
    onStep(`MCP verified ${button.label}: approach OFF / contact ON / release OFF, real cap + spring + actuator motion`);
  }
  const after = await tool("validate_project");
  assert.deepEqual(after.issues.filter((issue) => issue.severity === "error"), []);
  if (requireEvidence) assert.equal(after.sourceEvidence?.status, "pass");
  const exported = await tool("export_project");
  assert.ok(exported.project, "This source-linked controller should fit a single portable project response");
  const report = {
    version: 1, status: "pass", startedAt, completedAt: new Date().toISOString(),
    execution: { protocol: "Native --mcp stdio with actual workbench handler", renderer: loaded.desktop ? "packaged Tauri WKWebView" : "actual Chromium workbench via authenticated DEV adapter", nativeDesktop: loaded.desktop, fixture: false },
    calibrationSha256: createHash("sha256").update(JSON.stringify(calibration)).digest("hex"),
    digestMethod: "SHA-256 of UTF-8 JSON.stringify(parsed JSON object), preserving key order; not the indented file bytes",
    exportedProjectSha256: createHash("sha256").update(JSON.stringify(exported.project)).digest("hex"),
    sourceParts: sourceCount, totalParts: exported.project.parts.length, mechanisms: rigs.length, wires: exported.project.wires.length,
    analyticBench: exported.project.parts.filter((part) => !part.params.assetUrl).map((part) => ({ id: part.id, kind: part.kind, position: part.position, rotation: part.rotation, size: part.size, params: part.params })),
    operations, tests,
    before: { issues: summary(before.issues), sourceEvidenceStatus: before.sourceEvidence?.status ?? "unavailable", lampsOn: before.circuit.poweredLampIds.length },
    after: { issues: summary(after.issues), sourceEvidenceStatus: after.sourceEvidence?.status ?? "unavailable", lampsOn: after.circuit.poweredLampIds.length },
    limits: ["Source geometry validation is a separate hash-bound evidence report; this MCP pass alone is not a source-mesh or manufacturing certificate.", "Nominal linear spring and ideal contact/electrical model; real tactile switch force, friction and material deformation require physical measurement.", "The nine indicator lamps and their logical leads form an external test bench, not the ESP32 firmware or final manufactured harness."],
  };
  return { project: exported.project, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const calibration = JSON.parse(await fs.readFile(path.join(root, "docs/puretv-calibration.json"), "utf8"));
  const session = await connectWorkbench();
  try {
    const result = await drivePuretv(session.tool, { calibration, requireEvidence: process.argv.includes("--require-evidence") });
    await fs.writeFile(path.join(root, "public/models/puretv-verified-assembly.json"), JSON.stringify(result.project, null, 2) + "\n");
    await fs.writeFile(path.join(root, "docs/puretv-mcp-verification.json"), JSON.stringify(result.report, null, 2) + "\n");
    console.log(JSON.stringify({ status: result.report.status, parts: result.report.totalParts, buttons: result.report.tests.length, nativeDesktop: result.report.execution.nativeDesktop }));
  } finally {
    await session.close();
  }
}
