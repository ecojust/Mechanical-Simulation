import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { demoProject } from "../src/catalog";

const STORAGE = "mechanical-studio-project-v1";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({key,project})=>{localStorage.setItem(key,JSON.stringify(project));},{key:STORAGE,project:demoProject()});
  await page.goto("/");
  await expect(page.getByTestId("viewport-canvas")).toBeVisible();
  await expect(page.getByLabel("项目名称")).toHaveValue("榫卯与按压机构");
});

test("方榫沿孔插入，邻接壁阻挡横移与旋转，撤销恢复姿态", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.getByLabel("位置 Y")).toHaveValue("35");
  await page.getByTitle("向下 Y−").click();
  await expect(page.getByLabel("位置 Y")).toHaveValue("34");
  await page.getByTitle("向右 X+").click();
  await expect(page.getByRole("status")).toContainText("阻挡操作路径");
  await expect(page.getByLabel("位置 X", { exact: true })).toHaveValue("-18");
  await page.getByTitle("绕 Y 轴正向旋转").click();
  await expect(page.getByRole("status")).toContainText("阻挡操作路径");
  await expect(page.getByLabel("旋转 Y", { exact: true })).toHaveValue("0");
  const stored = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    STORAGE,
  );
  const tenon = stored.parts.find(
    (part: { kind: string }) => part.kind === "tenon",
  );
  expect(tenon.position).toEqual([-18, 34, 0]);
  expect(tenon.rotation).toEqual([0, 0, 0]);
  await page.getByTitle("撤销 (Ctrl+Z)").click();
  await expect(page.getByLabel("位置 Y")).toHaveValue("35");
  expect(errors).toEqual([]);
});

test("按压弹簧到触发点后点灯，松手回弹并断电，生成验证报告", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: /装配树/ })
    .first()
    .click();
  await page
    .getByRole("button", { name: "04 · 弹簧按压开关", exact: true })
    .click();
  await page.getByRole("button", { name: "开始仿真", exact: true }).click();
  const press = page.getByRole("button", {
    name: "按住施力，松开回弹",
    exact: true,
  });
  await press.scrollIntoViewIfNeeded();
  await expect(page.getByTestId("viewport")).toHaveAttribute(
    "data-powered-lamps",
    "0",
  );
  const box = await press.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  try {
    await expect(page.getByTestId("viewport")).toHaveAttribute(
      "data-powered-lamps",
      "1",
    );
    await expect(page.locator(".simulation-hud")).toContainText("50.0 mA");
    await expect
      .poll(async () =>
        Number.parseFloat(
          await page.locator(".press-test b").first().innerText(),
        ),
      )
      .toBeGreaterThan(0.6);
  } finally {
    await page.mouse.up();
  }
  await expect(page.getByTestId("viewport")).toHaveAttribute(
    "data-powered-lamps",
    "0",
  );
  await expect
    .poll(async () =>
      Number.parseFloat(
        await page.locator(".press-test b").first().innerText(),
      ),
    )
    .toBeLessThan(0.01);
  await expect(page.locator(".simulation-hud")).toContainText("0.0 mA");
  await page.getByRole("button", { name: "暂停仿真", exact: true }).click();
  await page.getByRole("button", { name: "运行验证", exact: true }).click();
  await expect(
    page.locator(".issue-row").filter({ hasText: "按压与回弹" }),
  ).toContainText("通过");
  await expect(
    page.locator(".issue-row").filter({ hasText: "按压触发后的电路" }),
  ).toContainText("1 个灯获得供电");
});

test("项目保存后可完整导入，Blender 原始零件可实际载入", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  const download = await downloadPromise;
  const path = testInfo.outputPath("roundtrip.mechanical.json");
  await download.saveAs(path);
  const saved = JSON.parse(await readFile(path, "utf8"));
  expect(saved.parts).toHaveLength(6);
  expect(saved.wires).toHaveLength(3);
  expect(saved.version).toBe(1);
  await page.getByTitle("新建空白项目").click();
  await expect(page.getByText("从一个零件开始", { exact: true })).toBeVisible();
  await page.locator("input[type=file]").setInputFiles(path);
  await expect(page.getByRole("status")).toContainText("项目导入成功");
  const restored = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    STORAGE,
  );
  expect(restored).toEqual(saved);
  await page.getByRole("button", { name: "原始素材", exact: true }).click();
  await expect(page.locator(".asset-card").first()).toBeVisible();
  const assetResponse = page.waitForResponse(
    (response) => response.url().endsWith(".glb") && response.ok(),
  );
  await page.locator(".asset-card").first().click();
  await assetResponse;
  await expect(page.getByTestId("viewport")).toHaveAttribute(
    "data-loaded-assets",
    "1",
    { timeout: 30_000 },
  );
  await expect(page.locator(".right-panel")).toContainText("BLENDER 素材");
  await expect(page.locator(".right-panel")).toContainText("包围盒预检");
  const catalog = await page.request
    .get("/models/catalog.json")
    .then((response) => response.json());
  const nodeCount = catalog[0].nodes.length;
  await page
    .getByRole("button", { name: "拆分为独立零件", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    `已拆分为 ${nodeCount} 个独立零件`,
  );
  await expect(page.getByTestId("viewport")).toHaveAttribute(
    "data-loaded-assets",
    String(nodeCount),
    { timeout: 30_000 },
  );
  const splitProject = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    STORAGE,
  );
  expect(
    splitProject.parts.filter(
      (part: { kind: string }) => part.kind === "asset",
    ),
  ).toHaveLength(nodeCount);
  expect(
    splitProject.parts
      .filter((part: { kind: string }) => part.kind === "asset")
      .every((part: { params: { assetNode?: string } }) =>
        Boolean(part.params.assetNode),
      ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("原手柄装配按原坐标载入全部十五个总成并显示精度提示", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("button", { name: "原始素材", exact: true }).click();
  await page.getByRole("button", { name: /打开原手柄装配/ }).click();
  await expect(page.locator(".statusbar")).toContainText("15 个零件");
  await expect(page.getByTestId("viewport")).toHaveAttribute("data-loaded-assets", "15", { timeout: 90_000 });
  const original = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), STORAGE);
  expect(original.parts).toHaveLength(15);
  expect(original.parts.every((part: { kind: string }) => part.kind === "asset")).toBe(true);
  const accuracyWarning = page.locator(".issue-row").filter({ hasText: "原始资产仅作包围盒预检" });
  await accuracyWarning.scrollIntoViewIfNeeded();
  await expect(accuracyWarning).toBeVisible();
  await page.getByTitle("适应全部模型").click();
  await page.screenshot({ path: testInfo.outputPath("puretv-assembly.png"), fullPage: true });
  expect(errors).toEqual([]);
});
