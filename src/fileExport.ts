import { isDesktop } from "./mcp/bridge";

export type ModelFileFormat = "glb" | "stl";
export const MAX_MODEL_EXPORT_BYTES = 256 * 1024 * 1024;

/** Native false means the user cancelled. Browser true means a download was requested. */
export async function saveModelFile(
  filename: string,
  data: Uint8Array | ArrayBuffer,
  format: ModelFileFormat,
): Promise<boolean> {
  if (format !== "glb" && format !== "stl")
    throw new Error("仅支持 GLB 或二进制 STL 导出");
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (!bytes.byteLength || bytes.byteLength > MAX_MODEL_EXPORT_BYTES)
    throw new Error("模型导出不能为空且不能超过 256 MiB");
  const safeName =
    Array.from(filename.replace(/[\u0000-\u001f\u007f/\\<>:"|?*]/g, ""))
      .slice(0, 180)
      .join("")
      .replace(/^[ .]+|[ .]+$/g, "") || "assembly";
  const name = safeName.toLowerCase().endsWith(`.${format}`)
    ? safeName
    : `${safeName}.${format}`;
  if (isDesktop()) {
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      // A raw payload preserves typed-array byteOffset/byteLength without JSON/base64 expansion.
      return await invoke<boolean>("save_model_export", bytes, {
        headers: {
          "x-model-format": format,
          "x-model-filename": encodeURIComponent(name),
        },
      });
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
  const url = URL.createObjectURL(
    new Blob([bytes], {
      type: format === "glb" ? "model/gltf-binary" : "model/stl",
    }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    // Keep the blob alive while the browser starts a possibly large binary download.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return true;
}
