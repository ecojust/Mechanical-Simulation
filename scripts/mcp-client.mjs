/** Official MCP client for the native --mcp executable; no alternate project state. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function connectWorkbench(options = {}) {
  const binary = resolve(
    options.binary ??
      process.env.MCP_NATIVE_BINARY ??
      "src-tauri/target/debug/mechanical-studio",
  );
  const dataDirectory =
    options.dataDirectory ?? process.env.MECHANICAL_STUDIO_DATA_DIR;
  if (!dataDirectory)
    throw Error(
      "Set MECHANICAL_STUDIO_DATA_DIR to the actual running desktop/development adapter discovery directory.",
    );
  const client = new Client({
    name: "mechanical-workbench-driver",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command: binary,
    args: ["--mcp"],
    env: { ...process.env, MECHANICAL_STUDIO_DATA_DIR: dataDirectory },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (data) => process.stderr.write(data));
  await client.connect(transport);
  const tool = async (name, args = {}) => {
    const response = await client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: 60000 },
    );
    if (response.isError) {
      const error = Error(
        `${name}: ${response.content.map((item) => item.text ?? "").join("\n")}`,
      );
      error.toolResult = response;
      throw error;
    }
    return response.structuredContent ?? JSON.parse(response.content[0].text);
  };
  return { client, transport, tool, close: () => client.close() };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const session = await connectWorkbench();
  try {
    console.log(
      JSON.stringify(
        await session.tool(
          process.argv[2] ?? "get_runtime_status",
          process.argv[3] ? JSON.parse(process.argv[3]) : {},
        ),
        null,
        2,
      ),
    );
  } finally {
    await session.close();
  }
}
