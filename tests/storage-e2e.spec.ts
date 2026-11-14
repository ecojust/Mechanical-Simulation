import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  // Use a blank same-origin document so the application autosave cannot interfere.
  await page.route("**/storage-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body>Storage integration test</body></html>",
    }),
  );
  await page.goto("/storage-test");
});

test("IndexedDB preserves the latest queued project across reload and ignores stale legacy mirrors", async ({
  page,
}) => {
  const latest = await page.evaluate(async () => {
    const storage = await import(`${location.origin}/src/storage.ts`);
    const { demoProject } = await import(`${location.origin}/src/catalog.ts`);
    const project = demoProject();
    await Promise.all([
      storage.saveProject({ ...project, name: "first edit" }),
      storage.saveProject({ ...project, name: "last edit" }),
    ]);
    localStorage.setItem(
      "mechanical-studio-project-v1",
      JSON.stringify({ ...project, name: "stale mirror" }),
    );
    return (await storage.loadSavedProject()).name;
  });
  expect(latest).toBe("last edit");
  await page.reload();
  expect(
    await page.evaluate(async () => {
      const storage = await import(`${location.origin}/src/storage.ts`);
      return (await storage.loadSavedProject()).name;
    }),
  ).toBe("last edit");
});

test("corrupt persisted projects are reported and retained instead of silently deleted", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const storage = await import(`${location.origin}/src/storage.ts`);
    const { demoProject } = await import(`${location.origin}/src/catalog.ts`);
    await storage.saveProject(demoProject());
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("mechanical-studio-v1", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const broken = JSON.stringify({
      version: 99,
      name: "recover me",
      parts: [],
      wires: [],
    });
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction("workspace", "readwrite");
      tx.objectStore("workspace").put(broken, "current-project");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    let error = "";
    try {
      await storage.loadSavedProject();
    } catch (cause) {
      error = String(cause);
    }
    const retained = await new Promise<unknown>((resolve, reject) => {
      const request = database
        .transaction("workspace", "readonly")
        .objectStore("workspace")
        .get("current-project");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return { error, retained, broken };
  });
  expect(result.error).toContain("原数据已保留");
  expect(result.retained).toBe(result.broken);
});
