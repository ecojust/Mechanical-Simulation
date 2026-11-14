import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { demoProject } from "../src/catalog";
import type { AssetEntry, Project } from "../src/types";

const STORAGE = "mechanical-studio-project-v1";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ key, project }) => {
      localStorage.setItem(key, JSON.stringify(project));
    },
    { key: STORAGE, project: demoProject() },
  );
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
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const storage = await import(`${location.origin}/src/storage.ts`);
        return storage.loadSavedProject();
      }),
    )
    .toEqual(saved);
  await page.getByRole("button", { name: "原始素材", exact: true }).click();
  const collection = page.locator('[data-asset-collection="buttons-left"]');
  await expect(collection.locator(".repository-node").first()).toBeVisible();
  const catalog: AssetEntry[] = await page.request
    .get("/models/catalog.json")
    .then((response) => response.json());
  const asset = catalog.find((entry) => entry.id === "buttons-left")!;
  const group = asset.nodes!.filter(
    (node) => node.group?.id === "buttons-left-pin-sleeve",
  );
  expect(group).toHaveLength(2);
  expect(group.map((node) => node.role).sort()).toEqual(["female", "male"]);
  const male = group.find((node) => node.role === "male")!;
  await collection
    .getByTitle(`添加子零件：${male.displayName ?? male.name}`, { exact: true })
    .click();
  await expect(page.getByTestId("viewport")).toHaveAttribute(
    "data-loaded-assets",
    "1",
    { timeout: 30_000 },
  );
  const single: Project = await page.evaluate(async () => {
    const storage = await import(`${location.origin}/src/storage.ts`);
    return storage.loadSavedProject();
  });
  const sourcePart = single.parts.find((part) =>
    Boolean(part.params.assetNode),
  )!;
  expect(sourcePart.params).toMatchObject({
    assetUrl: asset.url,
    assetNode: male.name,
  });
  expect(sourcePart.kind).toBe("pin");
  expect(sourcePart.interaction?.status).toBe("unconfigured");
  expect(sourcePart.size).toEqual(male.size);
  await expect(page.getByLabel("组件类型与交互定义")).toContainText(
    "参数待完成 · 仅预览",
  );

  await page.getByTitle("新建空白项目").click();
  await collection
    .locator('[data-group-id="buttons-left-pin-sleeve"]')
    .getByRole("button", { name: "整组添加", exact: true })
    .click();
  await expect(page.getByTestId("viewport")).toHaveAttribute(
    "data-loaded-assets",
    "2",
    { timeout: 30_000 },
  );
  const pair: Project = await page.evaluate(async () => {
    const storage = await import(`${location.origin}/src/storage.ts`);
    return storage.loadSavedProject();
  });
  expect(pair.parts).toHaveLength(2);
  expect(new Set(pair.parts.map((part) => part.params.assetNode)).size).toBe(2);
  expect(new Set(pair.parts.map((part) => part.assemblyGroup?.id)).size).toBe(
    1,
  );
  expect(
    pair.parts.every(
      (part) => part.assemblyGroup?.name === group[0].group!.name,
    ),
  ).toBe(true);
  expect(pair.parts.map((part) => part.kind).sort()).toEqual(["pin", "sleeve"]);
  for (let axis = 0; axis < 3; axis++) {
    expect(
      pair.parts[1].position[axis] - pair.parts[0].position[axis],
    ).toBeCloseTo(group[1].center[axis] - group[0].center[axis], 6);
  }
  await page
    .getByRole("button", { name: /装配树/ })
    .first()
    .click();
  const treeGroup = page.locator("[data-assembly-group]");
  await expect(treeGroup).toHaveCount(1);
  await expect(treeGroup.locator(".tree-select")).toHaveCount(2);
  for (const part of pair.parts) {
    await treeGroup.getByTitle(part.name, { exact: true }).click();
    await expect(page.getByLabel("零件名称", { exact: true })).toHaveValue(
      part.name,
    );
  }
  expect(errors).toEqual([]);
});

test("原手柄以189个独立子零件保留装配坐标和公母分组，未配置功能不获得验证通过", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const source: Project = await page.request
    .get("/models/puretv-assembly.json")
    .then((response) => response.json());
  expect(source.parts).toHaveLength(189);
  await page.getByRole("button", { name: "原始素材", exact: true }).click();
  await page.getByRole("button", { name: /打开原手柄装配/ }).click();
  await expect(page.locator(".statusbar")).toContainText("189 个零件");
  await expect(page.getByTestId("viewport")).toHaveAttribute(
    "data-loaded-assets",
    "189",
    { timeout: 120_000 },
  );
  const original: Project = await page.evaluate(async () => {
    const storage = await import(`${location.origin}/src/storage.ts`);
    return storage.loadSavedProject();
  });
  expect(original.parts).toEqual(source.parts);
  expect(original.parts.every((part) => Boolean(part.params.assetNode))).toBe(
    true,
  );
  const functional = original.parts.filter((part) => part.kind !== "asset");
  expect(functional.length).toBeGreaterThan(0);
  expect(
    functional.every((part) => part.interaction?.status === "unconfigured"),
  ).toBe(true);
  const groupIds = new Set(
    original.parts.flatMap((part) =>
      part.assemblyGroup ? [part.assemblyGroup.id] : [],
    ),
  );
  expect(groupIds.size).toBeGreaterThan(0);
  await expect(page.locator("[data-assembly-group]")).toHaveCount(
    groupIds.size,
  );
  await expect(page.locator(".tree-select")).toHaveCount(189);
  const pair = original.parts.filter(
    (part) => part.assemblyGroup?.id === "puretv-buttons-left-pin-sleeve",
  );
  expect(pair).toHaveLength(2);
  expect(pair.map((part) => part.kind).sort()).toEqual(["pin", "sleeve"]);
  const accuracyWarning = page
    .locator(".issue-row")
    .filter({ hasText: "组件交互参数未完成" })
    .first();
  await accuracyWarning.scrollIntoViewIfNeeded();
  await expect(accuracyWarning).toBeVisible();
  await page.getByTitle("适应全部模型").click();
  await page.screenshot({
    path: testInfo.outputPath("puretv-independent-parts.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
