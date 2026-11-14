/** DEV ONLY: native MCP stdio -> authenticated local HTTP -> actual Chromium App handler.
 * No fixture results or alternate project state. Production bundles omit the browser hook.
 */
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDirectory =
  process.env.MCP_DEV_DATA_DIR ??
  (await fs.mkdtemp(join(tmpdir(), "mechanical-browser-mcp-")));
await fs.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
await fs.chmod(dataDirectory, 0o700);
const port = Number(process.env.MCP_DEV_PORT ?? 5175),
  url = `http://127.0.0.1:${port}/?mcp=development`;
const token = randomBytes(32).toString("hex");
let address, context, server;
let serial = Promise.resolve();
const vite = spawn(
  process.execPath,
  [
    join(root, "node_modules/vite/bin/vite.js"),
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ],
  { cwd: root, stdio: ["ignore", "ignore", "pipe"] },
);
vite.stderr.on("data", (data) => process.stderr.write(data));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  await context?.close().catch(() => {});
  server?.close();
  vite.kill("SIGTERM");
  await fs.rm(join(dataDirectory, "mcp-connection.json"), { force: true });
  process.exit(code);
}
process.on("SIGTERM", () => stop());
process.on("SIGINT", () => stop());
try {
  let serving = false;
  for (let tries = 0; tries < 100; tries++) {
    try {
      serving = (await fetch(url)).ok;
      if (serving) break;
    } catch {}
    if (vite.exitCode !== null) throw Error("Vite exited before startup");
    await pause(200);
  }
  if (!serving) throw Error("Vite startup timed out");
  context = await chromium.launchPersistentContext(
    join(dataDirectory, "browser"),
    {
      headless: true,
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/usr/bin/chromium",
      viewport: { width: 1536, height: 960 },
      args: [
        "--no-sandbox",
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--remote-debugging-port=0",
      ],
    },
  );
  const page = context.pages()[0] ?? (await context.newPage());
  page.on("pageerror", (error) =>
    process.stderr.write(`Browser error: ${error.message}\n`),
  );
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => typeof window.__MECHANICAL_WORKBENCH_MCP__?.dispatch === "function",
    undefined,
    { timeout: 30000 },
  );
  server = createServer(async (request, response) => {
    const respond = (status, body) => {
      const encoded = Buffer.from(JSON.stringify(body));
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": encoded.length,
        "Cache-Control": "no-store",
        Connection: "close",
      });
      response.end(encoded);
    };
    try {
      const auth = Buffer.from(request.headers.authorization ?? ""),
        expected = Buffer.from(`Bearer ${token}`);
      const names = request.rawHeaders
        .filter((_, index) => index % 2 === 0)
        .map((name) => name.toLowerCase());
      if (request.method !== "POST" || request.url !== "/rpc")
        return respond(404, { error: "Not found" });
      if (
        request.headers.host !== address ||
        auth.length !== expected.length ||
        !timingSafeEqual(auth, expected) ||
        request.headers.origin !== undefined ||
        request.headers["transfer-encoding"] !== undefined ||
        new Set(names).size !== names.length
      )
        return respond(403, { error: "Forbidden" });
      let length = 0;
      const chunks = [];
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 24 * 1024 * 1024)
          return respond(413, { error: "Request exceeds 24 MiB" });
        chunks.push(chunk);
      }
      const command = JSON.parse(Buffer.concat(chunks).toString());
      if (
        typeof command.method !== "string" ||
        command.args === null ||
        typeof command.args !== "object" ||
        Array.isArray(command.args)
      )
        return respond(400, { error: "Invalid command" });
      const run = serial.then(() =>
        page.evaluate(async (request) => {
          const handler = window.__MECHANICAL_WORKBENCH_MCP__?.dispatch;
          if (!handler) throw Error("Actual workbench is not available");
          return await handler(request);
        }, command),
      );
      serial = run.catch(() => {});
      respond(200, { result: await run });
    } catch (error) {
      respond(200, { error: error.message });
    }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 10000;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  address = `127.0.0.1:${server.address().port}`;
  await fs.writeFile(
    join(dataDirectory, "mcp-connection.json"),
    JSON.stringify({ version: 1, address, token }),
    { mode: 0o600 },
  );
  const devtools = (
    await fs.readFile(join(dataDirectory, "browser/DevToolsActivePort"), "utf8")
  ).split("\n");
  await fs.writeFile(
    join(dataDirectory, "adapter-session.json"),
    JSON.stringify(
      {
        pid: process.pid,
        url,
        cdpPort: Number(devtools[0]),
        dataDirectory,
        transport:
          "native MCP stdio + authenticated development browser adapter",
        renderer: "actual Chromium workbench",
        nativeDesktop: false,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      ready: true,
      url,
      dataDirectory,
      cdpPort: Number(devtools[0]),
      nativeDesktop: false,
    }),
  );
} catch (error) {
  console.error(error);
  await stop(1);
}
