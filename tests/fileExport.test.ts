import { afterEach, describe, expect, it, vi } from "vitest";
const bridge = vi.hoisted(() => ({
  invoke: vi.fn(),
  isDesktop: vi.fn(() => true),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("../src/mcp/bridge", () => ({ isDesktop: bridge.isDesktop }));
import { MAX_MODEL_EXPORT_BYTES, saveModelFile } from "../src/fileExport";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  bridge.isDesktop.mockReturnValue(true);
});

describe("binary model file saving", () => {
  it("passes the exact typed-array view as raw IPC and preserves cancellation", async () => {
    const backing = Uint8Array.from([99, 1, 2, 3, 88]);
    const bytes = backing.subarray(1, 4);
    bridge.invoke.mockResolvedValueOnce(false);
    expect(await saveModelFile("模型.glb", bytes, "glb")).toBe(false);
    const [command, payload, options] = bridge.invoke.mock.calls[0];
    expect(command).toBe("save_model_export");
    expect(payload).toBe(bytes);
    expect([...payload]).toEqual([1, 2, 3]);
    expect(options.headers).toEqual({
      "x-model-format": "glb",
      "x-model-filename": encodeURIComponent("模型.glb"),
    });
  });
  it("normalizes native write errors without reporting a save", async () => {
    bridge.invoke.mockRejectedValueOnce("磁盘空间不足");
    await expect(
      saveModelFile("part.stl", new ArrayBuffer(84), "stl"),
    ).rejects.toThrow("磁盘空间不足");
  });
  it("rejects empty and oversized payloads before opening a native dialog", async () => {
    await expect(
      saveModelFile("empty", new Uint8Array(), "stl"),
    ).rejects.toThrow("不能为空");
    // The bound is checked before IPC; an oversized view is represented without allocating 256 MiB.
    const tooLarge = new Uint8Array(1);
    Object.defineProperty(tooLarge, "byteLength", {
      value: MAX_MODEL_EXPORT_BYTES + 1,
    });
    await expect(saveModelFile("large", tooLarge, "glb")).rejects.toThrow(
      "256 MiB",
    );
    expect(bridge.invoke).not.toHaveBeenCalled();
  });
  it("browser fallback downloads only the selected view bytes with the requested format", async () => {
    bridge.isDesktop.mockReturnValue(false);
    const anchor = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
    let blob: Blob | undefined;
    const revoke = vi.fn();
    vi.stubGlobal("document", {
      createElement: () => anchor,
      body: { appendChild: vi.fn() },
    });
    vi.stubGlobal("URL", {
      createObjectURL: (value: Blob) => {
        blob = value;
        return "blob:export";
      },
      revokeObjectURL: revoke,
    });
    vi.useFakeTimers();
    try {
      expect(
        await saveModelFile(
          "../模型",
          Uint8Array.from([8, 1, 2, 9]).subarray(1, 3),
          "stl",
        ),
      ).toBe(true);
      expect(anchor.download).toBe("模型.stl");
      expect([...new Uint8Array(await blob!.arrayBuffer())]).toEqual([1, 2]);
      expect(blob!.type).toBe("model/stl");
      expect(anchor.click).toHaveBeenCalledOnce();
      expect(revoke).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(revoke).toHaveBeenCalledWith("blob:export");
    } finally {
      vi.useRealTimers();
    }
  });
});
