import type { WorkbenchRequest } from "./workbench";
export interface DesktopBridgeRequest extends WorkbenchRequest {
  id: string;
}
export interface McpStatus {
  active: boolean;
  endpoint?: string;
  config: { mcpServers: Record<string, { command: string; args: string[] }> };
}
export const isDesktop = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
/** Native requests are serialized; the handler must read current state from refs. */
export async function registerDesktopBridge(
  handler: (request: WorkbenchRequest) => Promise<unknown>,
): Promise<() => void> {
  if (!isDesktop()) return () => {};
  const [{ listen }, { invoke }] = await Promise.all([
    import("@tauri-apps/api/event"),
    import("@tauri-apps/api/core"),
  ]);
  let queue = Promise.resolve();
  return listen<DesktopBridgeRequest>("mechanical-mcp-request", (event) => {
    queue = queue
      .then(async () => {
        try {
          const result = await handler(event.payload);
          await invoke("mcp_reply", {
            id: event.payload.id,
            result,
            error: null,
          });
        } catch (error) {
          await invoke("mcp_reply", {
            id: event.payload.id,
            result: null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })
      .catch((error) => console.error("MCP bridge response failed", error));
  });
}
export async function getMcpStatus(): Promise<McpStatus | null> {
  if (!isDesktop()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<McpStatus>("mcp_status");
}

export async function setMcpEnabled(enabled: boolean): Promise<void> {
  if (!isDesktop()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("mcp_set_enabled", { enabled });
}
