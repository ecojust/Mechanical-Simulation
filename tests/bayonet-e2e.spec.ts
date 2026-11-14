import { test, expect } from "@playwright/test";

test("公母旋锁可沿入口装入、旋转锁定，锁定后不能上拔，反旋可拆出", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: /^旋锁装配示例/ }).click();
  await expect(page.getByTestId("viewport-canvas")).toBeVisible();
  await page
    .getByRole("button", { name: /装配树/ })
    .first()
    .click();
  const selectedId = await page
    .locator(".tree-row.selected")
    .getAttribute("data-part-id");
  await expect
    .poll(async () =>
      page.evaluate(async (id) => {
        const storage = await import("/src/storage.ts");
        const project = await storage.loadSavedProject();
        return project?.parts.some((p) => p.id === id);
      }, selectedId),
    )
    .toBe(true);
  const project = await page.evaluate(async () => {
    const storage = await import("/src/storage.ts");
    return (await storage.loadSavedProject())!;
  });
  const pin = project.parts.find(
    (p: { kind: string }) => p.kind === "bayonet-pin",
  );
  const socket = project.parts.find(
    (p: { kind: string }) => p.kind === "bayonet-socket",
  );
  expect(pin).toBeTruthy();
  expect(socket).toBeTruthy();
  await expect(page.getByLabel("零件名称")).toHaveValue(pin.name);
  const y = page.getByLabel("位置 Y", { exact: true });
  const rotation = page.getByLabel("旋转 Y", { exact: true });
  const setPosition = async (value: number) => {
    await y.fill(String(value));
    await y.press("Enter");
  };
  const setRotation = async (value: number) => {
    await rotation.fill(String(value));
    await rotation.press("Enter");
  };
  const bottom = socket.position[1] + 5;
  const entry = socket.position[1] + 19;
  const withdrawn = socket.position[1] + 22;
  const halfway = socket.position[1] + 12;

  // Inside the axial entry, the roof must still block premature twisting.
  await setPosition(halfway);
  await expect(y).toHaveValue(String(halfway));
  await setRotation(45);
  await expect(rotation).toHaveValue("0");
  await expect(page.getByRole("status")).toContainText("阻挡");

  // The same physical lug can reach the transverse channel and turn to lock.
  await setPosition(bottom);
  await expect(y).toHaveValue(String(bottom));
  await setRotation(45);
  await expect(rotation).toHaveValue("45");
  await page.screenshot({ path: testInfo.outputPath("bayonet-locked.png") });
  await setPosition(entry);
  await expect(y).toHaveValue(String(bottom));
  await expect(page.getByRole("status")).toContainText("阻挡");

  // Overrotation hits a real stop, and reversing to the entrance releases it.
  await setRotation(90);
  await expect(rotation).toHaveValue("45");
  await setRotation(0);
  await expect(rotation).toHaveValue("0");
  await setPosition(entry);
  await expect(y).toHaveValue(String(entry));
  // The guided controls must follow the same checked geometry, not teleport.
  await page.getByRole("button", { name: "插入槽底", exact: true }).click();
  await expect(y).toHaveValue(String(bottom));
  await page.getByRole("button", { name: "旋转锁定 45°", exact: true }).click();
  await expect(rotation).toHaveValue("45");
  await page.getByRole("button", { name: "退出插销", exact: true }).click();
  await expect(y).toHaveValue(String(bottom));
  await page.getByRole("button", { name: "逆旋解锁", exact: true }).click();
  await expect(rotation).toHaveValue("0");
  await page.getByRole("button", { name: "退出插销", exact: true }).click();
  await expect(y).toHaveValue(String(withdrawn));
  await expect
    .poll(async () =>
      page.evaluate(async (id) => {
        const storage = await import("/src/storage.ts");
        return (await storage.loadSavedProject())?.parts.find(
          (p) => p.id === id,
        )?.position[1];
      }, pin.id),
    )
    .toBe(withdrawn);
  const saved = await page.evaluate(async () => {
    const storage = await import("/src/storage.ts");
    return (await storage.loadSavedProject())!;
  });
  const finalPin = saved.parts.find((p: { id: string }) => p.id === pin.id);
  expect(finalPin.position[1]).toBe(withdrawn);
  expect(finalPin.rotation[1]).toBe(0);
  expect(errors).toEqual([]);
});
