/** Loads every real source node via native MCP into the actual running workbench. */
import fs from "node:fs/promises";
import { resolve, join } from "node:path";
import { chromium } from "@playwright/test";
import { connectWorkbench } from "./mcp-client.mjs";
import { compactValidation } from "./drive-puretv-report.mjs";
const session = await connectWorkbench();
try {
  const startedAt = new Date().toISOString();
  let runtime;
  for (let attempt = 0; attempt < 60; attempt++) {
    runtime = (await session.tool("get_runtime_status")).runtime;
    if (runtime.ready && runtime.catalogCount > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!runtime?.ready || runtime.catalogCount < 1)
    throw Error("Actual workbench/catalog not ready");
  const tools = (await session.client.listTools()).tools;
  const catalog = await session.tool("list_components");
  const initial = await session.tool("get_project");
  let revision = initial.revision;
  if (tools.some((tool) => tool.name === "new_project"))
    revision = (
      await session.tool("new_project", {
        expectedRevision: revision,
        name: "pureTV · 原始子件完整导入预检",
      })
    ).revision;
  else
    for (const part of initial.project.parts)
      revision = (
        await session.tool("remove_part", {
          expectedRevision: revision,
          partId: part.id,
        })
      ).revision;
  const collections = [];
  for (const asset of catalog.repository) {
    const result = await session.tool("add_repository_parts", {
      expectedRevision: revision,
      assetId: asset.id,
    });
    revision = result.revision;
    collections.push({
      id: asset.id,
      name: asset.name,
      sourceNodes: asset.nodes?.length ?? 0,
      addedParts: result.parts.length,
      revision,
      issues: result.issues.reduce(
        (counts, issue) => (
          (counts[issue.severity] = (counts[issue.severity] ?? 0) + 1),
          counts
        ),
        {},
      ),
    });
    console.log(
      `Loaded ${asset.id}: ${result.parts.length} actual parts, revision ${revision}`,
    );
  }
  const project = await session.tool("get_project");
  const validation = await session.tool("validate_project");
  for (let attempt = 0; attempt < 120; attempt++) {
    runtime = (await session.tool("get_runtime_status")).runtime;
    if (runtime.loadedAssetCount === project.project.parts.length) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (runtime.loadedAssetCount !== project.project.parts.length)
    throw Error("Not all source meshes actually loaded");
  const report = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    startedAt,
    execution: {
      protocol: "Native executable --mcp, official MCP SDK client",
      transport: runtime.desktop
        ? "Native desktop bridge"
        : "Authenticated development adapter forwarding into the actual browser App handler",
      renderer: runtime.desktop
        ? "Native Tauri WebView"
        : "Chromium with real App, IndexedDB and WebGL",
      nativeDesktop: runtime.desktop,
      fixture: false,
      macOSVerification:
        "Required in the packaged WKWebView release smoke; this local run is not a macOS claim",
    },
    operations: [
      "get_runtime_status",
      "list_components",
      "get_project",
      "new_project",
      "add_repository_parts (one actual MCP call per source collection)",
      "validate_project",
    ],
    collections,
    summary: {
      collectionCount: collections.length,
      partCount: project.project.parts.length,
      wireCount: project.project.wires.length,
      mechanismCount: project.project.mechanisms?.length ?? 0,
      revision: project.revision,
      issueCounts: validation.issues.reduce(
        (counts, issue) => (
          (counts[issue.severity] = (counts[issue.severity] ?? 0) + 1),
          counts
        ),
        {},
      ),
    },
    runtime: {
      ready: runtime.ready,
      webgl: runtime.webgl,
      catalogCount: runtime.catalogCount,
      loadedAssetCount: runtime.loadedAssetCount,
      rendererErrors: runtime.rendererErrors,
    },
    parts: project.project.parts.map((part) => ({
      id: part.id,
      name: part.name,
      kind: part.kind,
      source: part.params.assetUrl,
      node: part.params.assetNode,
      size: part.size,
      position: part.position,
      group: part.assemblyGroup,
      interactionStatus: part.interaction?.status,
    })),
    validation: compactValidation(validation, project.project.parts),
  };
  await fs.writeFile(
    resolve("docs/puretv-before-validation.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  // Capture the actual workbench, without storing the private connection metadata in the report.
  const directory = process.env.MECHANICAL_STUDIO_DATA_DIR;
  try {
    const info = JSON.parse(
      await fs.readFile(join(directory, "adapter-session.json"), "utf8"),
    );
    const browser = await chromium.connectOverCDP(
      `http://127.0.0.1:${info.cdpPort}`,
    );
    const page = browser
      .contexts()[0]
      .pages()
      .find((page) => page.url().includes("mcp=development"));
    await page.screenshot({
      path: resolve("docs/puretv-before-workbench.png"),
      fullPage: true,
    });
    await browser.close();
  } catch (error) {
    console.error(`Screenshot unavailable: ${error.message}`);
  }
  console.log(JSON.stringify(report.summary));
} finally {
  await session.close();
}
