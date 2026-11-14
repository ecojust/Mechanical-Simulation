import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { ComponentDefinition, Project } from "../src/types";

// A complete small cylinder: a real uploaded mesh with 6 × 12 × 6 mm bounds.
function cylinderStl(): Buffer {
  const faces: number[][] = [];
  const point = (i: number, y: number) => [
    3 * Math.cos((i * Math.PI) / 8),
    y,
    3 * Math.sin((i * Math.PI) / 8),
  ];
  for (let i = 0; i < 16; i++) {
    const a = point(i, 0),
      b = point(i + 1, 0),
      c = point(i, 12),
      d = point(i + 1, 12);
    faces.push(
      [...a, ...b, ...c],
      [...b, ...d, ...c],
      [0, 0, 0, ...b, ...a],
      [0, 12, 0, ...c, ...d],
    );
  }
  const bytes = Buffer.alloc(84 + faces.length * 50);
  bytes.writeUInt32LE(faces.length, 80);
  faces.forEach((vertices, face) =>
    vertices.forEach((value, index) =>
      bytes.writeFloatLE(value, 84 + face * 50 + 12 + index * 4),
    ),
  );
  return bytes;
}

async function savedProject(page: Page): Promise<Project> {
  return page.evaluate(async () => {
    const storage = await import(`${location.origin}/src/storage.ts`);
    return storage.loadSavedProject();
  });
}

async function savedComponents(page: Page): Promise<ComponentDefinition[]> {
  return page.evaluate(async () => {
    const storage = await import(`${location.origin}/src/storage.ts`);
    return storage.loadUserComponents();
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("viewport-canvas")).toBeVisible();
  await expect(page.getByLabel("项目名称")).not.toHaveValue("");
  await expect(page.getByLabel("组件类型与交互定义")).toContainText(
    "内置参数化组件",
  );
  await page.getByTitle("新建空白项目").click();
  await expect(page.getByText("从一个零件开始", { exact: true })).toBeVisible();
});

test("真实 STL 上传先预览，补齐功能参数后从组件库装配并完整恢复", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const bytes = cylinderStl();
  await page.getByRole("button", { name: /上传自定义组件/ }).click();
  const dialog = page.getByRole("dialog", { name: "上传自定义组件" });
  await dialog.getByLabel("上传模型文件").setInputFiles({
    name: "fixture-pin.stl",
    mimeType: "model/stl",
    buffer: bytes,
  });
  await expect(
    dialog.getByText("fixture-pin.stl", { exact: true }),
  ).toBeVisible();
  await expect(dialog.locator(".measured-model-size")).toContainText(
    "6 × 12 × 6",
  );
  await dialog.getByLabel("组件名称", { exact: true }).fill("测试定位销 6mm");
  await dialog.getByLabel("组件功能类型", { exact: true }).selectOption("pin");
  await expect(
    dialog.getByRole("button", { name: "保存并启用交互", exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByLabel("插销直径", { exact: true })).toHaveValue("");
  await dialog.getByRole("button", { name: "保存为预览", exact: true }).click();
  await expect(dialog).toBeHidden();
  const card = page
    .locator(".custom-component-card")
    .filter({ hasText: "测试定位销 6mm" });
  await expect(card).toContainText("仅预览 · 参数待补全");
  await expect(page.getByLabel("组件类型与交互定义")).toContainText(
    "参数待完成 · 仅预览",
  );
  await expect
    .poll(async () => (await savedProject(page)).parts[0]?.interaction?.status)
    .toBe("unconfigured");

  await card.getByTitle("编辑组件定义").click();
  const editor = page.getByRole("dialog", { name: "编辑组件定义" });
  await expect(
    editor.getByText("fixture-pin.stl", { exact: true }),
  ).toBeVisible();
  await editor.getByLabel("配合族", { exact: true }).fill("fixture-pin-6mm");
  await editor.getByLabel("尺寸公差 ±", { exact: true }).fill("0.05");
  await editor.getByLabel("允许插入深度", { exact: true }).fill("8");
  await editor.getByLabel("要求的最小单侧余隙", { exact: true }).fill("0.1");
  await editor.getByLabel("插销直径", { exact: true }).fill("6");
  await expect(
    editor.getByRole("button", { name: "保存并启用交互", exact: true }),
  ).toBeEnabled();
  await editor
    .getByRole("button", { name: "保存并启用交互", exact: true })
    .click();
  await expect(editor).toBeHidden();
  await expect(card).toContainText("代理参数已配置");
  // Library changes do not silently replace an instance that was already assembled.
  await expect(page.getByLabel("组件类型与交互定义")).toContainText(
    "参数待完成 · 仅预览",
  );
  await page.getByTitle("新建空白项目").click();
  await card.locator(".custom-component-add").click();
  await expect(page.getByLabel("组件类型与交互定义")).toContainText(
    "参数已配置 · 代理验证",
  );
  await expect(page.getByTestId("viewport")).toHaveAttribute(
    "data-loaded-assets",
    "1",
    { timeout: 30_000 },
  );
  await expect
    .poll(async () => (await savedProject(page)).parts[0]?.interaction?.status)
    .toBe("configured");
  await page.getByLabel("零件颜色", { exact: true }).fill("#d6a74f");
  await page.getByLabel("材质金属度", { exact: true }).fill("0.8");
  await page.getByLabel("材质金属度", { exact: true }).press("Enter");
  await page.getByLabel("材质粗糙度", { exact: true }).fill("0.25");
  await page.getByLabel("材质粗糙度", { exact: true }).press("Enter");
  await expect(
    page.getByLabel("保留模型原色", { exact: true }),
  ).not.toBeChecked();
  await expect
    .poll(async () => (await savedProject(page)).parts[0]?.material?.roughness)
    .toBe(0.25);
  const assembled = await savedProject(page);
  const definition = (await savedComponents(page))[0];
  expect(assembled.parts).toHaveLength(1);
  expect(assembled.models).toHaveLength(1);
  expect(assembled.models![0].data).toBe(bytes.toString("base64"));
  expect(assembled.models![0].bytes).toBe(bytes.length);
  expect(assembled.parts[0].size).toEqual([6, 12, 6]);
  expect(assembled.parts[0].params.pinDiameter).toBe(6);
  expect(assembled.parts[0].color).toBe("#d6a74f");
  expect(assembled.parts[0].material).toEqual({
    metalness: 0.8,
    roughness: 0.25,
    useSourceColor: false,
  });
  expect(assembled.parts[0].interaction).toMatchObject({
    status: "configured",
    axis: [0, 1, 0],
    proxySize: [6, 12, 6],
    mateFamily: "fixture-pin-6mm",
    insertionDepth: 8,
    minClearance: 0.1,
  });
  expect(assembled.parts[0].model?.id).toBe(definition.model.id);

  await page.reload();
  await expect(page.getByTestId("viewport")).toHaveAttribute(
    "data-loaded-assets",
    "1",
    { timeout: 30_000 },
  );
  expect(await savedProject(page)).toEqual(assembled);
  await page.getByRole("button", { name: "我的组件", exact: true }).click();
  await expect(card).toContainText("代理参数已配置");
  expect((await savedComponents(page))[0]).toEqual(definition);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  const download = await downloadPromise;
  const path = testInfo.outputPath("uploaded-pin.mechanical.json");
  await download.saveAs(path);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(assembled);
  expect(errors).toEqual([]);
});

test("原始素材可直接定义功能，切换类型保留模型来源且不会自动补全参数", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("button", { name: "原始素材", exact: true }).click();
  await page.locator(".repository-node").first().click();
  await expect(page.getByTestId("viewport")).toHaveAttribute(
    "data-loaded-assets",
    "1",
    { timeout: 30_000 },
  );
  const original = (await savedProject(page)).parts[0];
  expect(original.params.assetUrl).toBeTruthy();
  expect(original.params.assetNode).toBeTruthy();
  const inspector = page.getByLabel("组件类型与交互定义");
  await inspector.getByRole("button", { name: "配置类型与交互" }).click();
  await inspector
    .getByLabel("组件功能类型", { exact: true })
    .selectOption("battery");
  await expect(
    inspector.getByLabel("交互参数 电压", { exact: true }),
  ).toHaveValue("");
  await expect(
    inspector.getByRole("button", { name: "保存交互配置", exact: true }),
  ).toBeDisabled();
  await inspector
    .getByRole("button", { name: "保存为预览", exact: true })
    .click();
  await expect(inspector).toContainText("参数待完成 · 仅预览");
  await inspector.getByRole("button", { name: "配置类型与交互" }).click();
  await inspector.getByLabel("交互参数 电压", { exact: true }).fill("12");
  await inspector.getByLabel("配合方向", { exact: true }).selectOption("-x");
  await inspector.getByLabel("功能锚点 Y", { exact: true }).fill("2");
  await inspector
    .getByRole("button", { name: "保存交互配置", exact: true })
    .click();
  await expect(inspector).toContainText("参数已配置 · 代理验证");
  await expect(inspector).toContainText("电气端子");
  await expect
    .poll(async () => (await savedProject(page)).parts[0]?.interaction?.status)
    .toBe("configured");
  const configured = (await savedProject(page)).parts[0];
  expect(configured.kind).toBe("battery");
  expect(configured.params.assetUrl).toBe(original.params.assetUrl);
  expect(configured.params.assetNode).toBe(original.params.assetNode);
  expect(configured.params.voltage).toBe(12);
  expect(configured.interaction).toMatchObject({
    axis: [-1, 0, 0],
    anchor: [0, 2, 0],
  });
  await expect(page.getByTestId("viewport")).toHaveAttribute(
    "data-loaded-assets",
    "1",
  );
  expect(errors).toEqual([]);
});
