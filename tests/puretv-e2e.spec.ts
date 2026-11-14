import { expect, test } from "@playwright/test";
import type { Project } from "../src/types";

test("完整 pureTV 试验台使用已匹配源证据，键盘按压接触点灯且失焦释放", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByTestId("viewport-canvas")).toBeVisible();
  const source: Project = await page.request
    .get("/models/puretv-verified-assembly.json")
    .then((response) => response.json());
  const sourceCount = source.parts.filter(
    (part) => part.params.assetUrl,
  ).length;
  await page.getByRole("button", { name: /pureTV 九键试验/ }).click();
  await expect(page.getByLabel("项目名称")).toHaveValue(source.name);
  const viewport = page.getByTestId("viewport");
  await expect(viewport).toHaveAttribute(
    "data-loaded-assets",
    String(sourceCount),
    { timeout: 90_000 },
  );
  const evidence = page.getByTestId("source-evidence-status");
  await expect(evidence).toHaveAttribute("data-status", "pass");
  const bench = page.getByTestId("press-bench");
  await expect(bench.locator(".press-bench-key")).toHaveCount(9);
  await page.getByTitle("内部检视：仅隐藏外壳，保留全部碰撞检查").click();
  await expect(evidence).toHaveAttribute("data-status", "pass");
  await page.getByRole("button", { name: "开始仿真", exact: true }).click();
  const first = bench.locator(".press-bench-key").first();
  await first.focus();
  await page.keyboard.down("Space");
  await expect(first).toHaveAttribute("data-contact", "closed");
  await expect(viewport).toHaveAttribute("data-powered-lamps", "1");
  await expect(evidence).toHaveAttribute("data-status", "pass");
  const firstId = await first.getAttribute("data-mechanism-id");
  const firstMechanism = source.mechanisms!.find(
    (mechanism) => mechanism.id === firstId,
  )!;
  expect(firstMechanism).toBeDefined();
  for (const id of firstMechanism.springPartIds) {
    await expect
      .poll(async () => {
        const matrix = JSON.parse(
          (await viewport.getAttribute("data-rendered-deformations")) ?? "{}",
        )[id];
        if (!matrix || matrix.length !== 16) return Infinity;
        return Math.max(
          ...matrix.map((value: number, index: number) =>
            Math.abs(
              value -
                (index === 5
                  ? 1 -
                    firstMechanism.params.travel /
                      firstMechanism.params.freeLength
                  : index % 5 === 0
                    ? 1
                    : 0),
            ),
          ),
        );
      })
      .toBeLessThan(0.0001);
  }
  await page.screenshot({
    path: testInfo.outputPath("puretv-contact-lamp.png"),
  });
  // A lost key-up must not leave a button held when the window loses focus.
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(first).toHaveAttribute("aria-pressed", "false");
  await expect(first).toHaveAttribute("data-contact", "open");
  await expect(viewport).toHaveAttribute("data-powered-lamps", "0");
  await expect(viewport).toHaveAttribute("data-deformed-parts", "0");
  const returnedMatrices: Record<string, number[]> = JSON.parse(
    (await viewport.getAttribute("data-rendered-deformations")) ?? "{}",
  );
  for (const id of firstMechanism.springPartIds)
    returnedMatrices[id].forEach((value, index) =>
      expect(value).toBeCloseTo(index % 5 === 0 ? 1 : 0, 3),
    );
  await page.keyboard.up("Space");
  await page.getByRole("button", { name: "暂停仿真", exact: true }).click();
  await page.getByRole("button", { name: "运行验证", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "运行验证", exact: true }),
  ).toBeEnabled({ timeout: 90_000 });
  await expect(
    page.locator(".issue-row").filter({ hasText: "组件按压与回弹" }),
  ).toHaveCount(9);
  await expect(page.locator(".issue-row .issue-tag.error")).toHaveCount(0);
  expect(errors).toEqual([]);
});
