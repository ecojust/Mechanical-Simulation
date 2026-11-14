import { expect, test } from "@playwright/test";

test("实际 WebGL 上下文丢失后，MCP 运行状态不能继续报告图形正常", async ({ page }) => {
  await page.goto("/?mcp=development");
  await page.waitForFunction(() => typeof (window as any).__MECHANICAL_WORKBENCH_MCP__?.dispatch === "function");
  const runtime = () => page.evaluate(async () =>
    (await (window as any).__MECHANICAL_WORKBENCH_MCP__.dispatch({ method: "get_runtime_status", args: {} })).runtime,
  );
  await expect.poll(async () => (await runtime()).ready).toBe(true);
  expect((await runtime()).webgl).toBe(true);
  const lost = await page.evaluate(() => {
    const context = document.querySelector("canvas")?.getContext("webgl2");
    const extension = context?.getExtension("WEBGL_lose_context");
    if (!extension) return false;
    extension.loseContext();
    return true;
  });
  expect(lost).toBe(true);
  await expect.poll(async () => (await runtime()).webgl).toBe(false);
});
