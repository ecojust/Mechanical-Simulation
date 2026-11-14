// Official MCP SDK interoperability for the native stdio executable.
// The private HTTP fixture isolates transport checks; smoke-macos.mjs tests the real WebView.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EmptyResultSchema } from "@modelcontextprotocol/sdk/types.js";

const binary = resolve(
  process.env.MCP_TEST_BINARY || "src-tauri/target/debug/mechanical-studio",
);
const directory = await mkdtemp(join(tmpdir(), "mechanical-mcp-protocol-"));
const token = randomBytes(32).toString("hex");
const largeData = "A".repeat(16 * 1024 * 1024 + 256);
let address;
let calls = 0;
let serverError;
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/rpc");
    assert.equal(request.headers.host, address);
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.equal(request.headers.origin, undefined);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls++;
    if (process.env.MCP_PROTOCOL_TRACE)
      console.error(`Bridge call ${body.method}`);
    let result;
    if (body.method === "get_project")
      result = { revision: 7, project: { version: 1, parts: [], wires: [] } };
    else if (body.method === "list_component_types")
      result = { revision: 7, types: [{ kind: "pin", requiresMating: true }] };
    else if (body.method === "import_component") {
      assert.equal(body.args.component.model.data.length, largeData.length);
      result = {
        revision: 8,
        acceptedBytes: body.args.component.model.data.length,
      };
    } else if (body.method === "export_project") {
      const exported = JSON.stringify({ models: [{ data: largeData }] });
      if (body.args.chunkIndex === undefined)
        result = { revision: 7, project: JSON.parse(exported) };
      else {
        const size = 512 * 1024;
        result = {
          revision: 7,
          mode: "chunk",
          chunkIndex: body.args.chunkIndex,
          chunkCount: Math.ceil(exported.length / size),
          data: exported.slice(
            body.args.chunkIndex * size,
            (body.args.chunkIndex + 1) * size,
          ),
        };
      }
    } else if (body.method === "transform_part") {
      response.end(
        JSON.stringify({
          error: "Project revision changed; get_project before retrying.",
        }),
      );
      return;
    } else throw Error(`Unexpected method ${body.method}`);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ result }));
  } catch (error) {
    serverError = error;
    response.statusCode = 500;
    response.end(JSON.stringify({ error: String(error) }));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
address = `127.0.0.1:${server.address().port}`;
await writeFile(
  join(directory, "mcp-connection.json"),
  JSON.stringify({ version: 1, address, token }),
  { mode: 0o600 },
);
const client = new Client({
  name: "official-sdk-native-integration",
  version: "1.0.0",
});
const transport = new StdioClientTransport({
  command: binary,
  args: ["--mcp"],
  env: { ...process.env, MECHANICAL_STUDIO_DATA_DIR: directory },
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (data) => {
  stderr += data.toString();
});
try {
  await client.connect(transport);
  const trace = (message) => {
    if (process.env.MCP_PROTOCOL_TRACE) console.error(message);
  };
  trace("Connected");
  assert.equal(client.getServerVersion().name, "mechanical-studio");
  await client.ping();
  const { tools } = await client.listTools();
  assert.equal(tools.length, 17);
  assert.equal(
    tools.find((tool) => tool.name === "configure_mechanism").inputSchema
      .properties.mechanism.properties.contact.properties.switchNormal.type,
    "array",
  );
  assert.ok(
    tools
      .find((tool) => tool.name === "transform_part")
      .inputSchema.required.includes("expectedRevision"),
  );
  assert.equal(
    tools.find((tool) => tool.name === "remove_part").annotations
      .destructiveHint,
    true,
  );
  assert.equal(
    tools.find((tool) => tool.name === "import_component").inputSchema
      .properties.component.properties.model.properties.data.type,
    "string",
  );
  const project = await client.callTool({ name: "get_project", arguments: {} });
  assert.equal(project.isError, false);
  assert.equal(project.structuredContent.revision, 7);
  assert.equal(JSON.parse(project.content[0].text).revision, 7);
  const failure = await client.callTool({
    name: "transform_part",
    arguments: { expectedRevision: 2, partId: "pin", position: [0, 0, 0] },
  });
  assert.equal(failure.isError, true);
  assert.match(failure.content[0].text, /revision changed/);
  assert.equal((await client.listResources()).resources.length, 2);
  const resource = await client.readResource({
    uri: "mechanical://component-types",
  });
  assert.equal(JSON.parse(resource.contents[0].text).types[0].kind, "pin");
  await assert.rejects(
    client.request({ method: "shell/execute" }, EmptyResultSchema),
    /Method not found/,
  );
  await assert.rejects(
    client.callTool({ name: "shell", arguments: {} }),
    /Unknown tool/,
  );
  // Exceeds the 16 MiB boundary: the bridge supports a 12 MiB model plus base64 and metadata.
  const uploaded = await client.callTool(
    {
      name: "import_component",
      arguments: {
        expectedRevision: 7,
        component: { model: { data: largeData } },
      },
    },
    undefined,
    { timeout: 60000 },
  );
  assert.equal(uploaded.structuredContent.acceptedBytes, largeData.length);
  await assert.rejects(
    client.callTool({ name: "export_project", arguments: {} }, undefined, {
      timeout: 60000,
    }),
    /chunkIndex/,
  );
  const chunks = [];
  let chunkCount = 1;
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
    const exported = await client.callTool({
      name: "export_project",
      arguments: { chunkIndex, expectedRevision: 7 },
    });
    assert.equal(exported.structuredContent.revision, 7);
    chunkCount = exported.structuredContent.chunkCount;
    chunks.push(exported.structuredContent.data);
  }
  assert.equal(JSON.parse(chunks.join("")).models[0].data, largeData);
  await rm(join(directory, "mcp-connection.json"));
  const offline = await client.callTool({ name: "get_project", arguments: {} });
  assert.equal(offline.isError, true);
  assert.match(offline.content[0].text, /桌面客户端/);
  assert.equal(serverError, undefined);
  assert.equal(
    stderr,
    "",
    "Native stdout must contain protocol only, without startup diagnostics.",
  );
  console.log(
    `Official MCP SDK ↔ native stdio passed (${tools.length} tools, ${calls} authenticated bridge calls, >16 MiB upload + paged export, resources and errors).`,
  );
} catch (error) {
  if (stderr) console.error("Native stderr:", stderr);
  throw error;
} finally {
  await client.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
