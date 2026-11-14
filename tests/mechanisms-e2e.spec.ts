import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Part, Project, Vec3 } from "../src/types";

const part = (
  id: string,
  name: string,
  kind: Part["kind"],
  position: Vec3,
  size: Vec3,
  params: Part["params"] = {},
  fixed = false,
): Part => ({
  id,
  name,
  kind,
  position,
  rotation: [0, 0, 0],
  size,
  color: "#7f9eae",
  fixed,
  visible: true,
  params,
});
const pressProject = (): Project => ({
  version: 1,
  name: "组合按压试验",
  parts: [
    part("press-base", "按压基座", "base", [0, 2, 0], [20, 4, 20], {}, true),
    part("press-cap", "独立键帽", "base", [0, 12, 0], [8, 4, 8]),
    part("press-spring", "独立回位弹簧", "spring", [0, 6, 0], [4, 8, 4], {
      stiffness: 0.8,
      mass: 0.03,
      damping: 1.2,
      travel: 3,
      freeLength: 8,
      solidLength: 3,
    }),
    part(
      "press-switch",
      "独立触发开关",
      "button",
      [0, 7, 0],
      [5, 2, 5],
      {
        stiffness: 0.8,
        mass: 0.03,
        damping: 1.2,
        travel: 3,
        trigger: 0.1,
        compression: 1,
      },
      true,
    ),
    part("press-battery", "外部电源", "battery", [-30, 6, 0], [20, 12, 13], {
      voltage: 5,
    }),
    part("press-lamp", "外部指示灯", "lamp", [30, 8, 0], [10, 16, 10], {
      resistance: 100,
    }),
  ],
  wires: [
    {
      id: "press-wire-1",
      from: { partId: "press-battery", terminal: 0 },
      to: { partId: "press-switch", terminal: 0 },
      color: "#c97b63",
    },
    {
      id: "press-wire-2",
      from: { partId: "press-switch", terminal: 1 },
      to: { partId: "press-lamp", terminal: 0 },
      color: "#c97b63",
    },
    {
      id: "press-wire-3",
      from: { partId: "press-lamp", terminal: 1 },
      to: { partId: "press-battery", terminal: 1 },
      color: "#4f6c82",
    },
  ],
});
const matingProject = (): Project => ({
  version: 1,
  name: "组合旋锁试验",
  parts: [
    part(
      "mating-pin",
      "独立双耳插销",
      "bayonet-pin",
      [0, 31, 0],
      [16, 24, 16],
      { tolerance: 0.1 },
    ),
    part(
      "mating-socket",
      "独立旋锁套座",
      "bayonet-socket",
      [0, 9, 0],
      [24, 18, 24],
      { tolerance: 0.1, holeDiameter: 9.6 },
      true,
    ),
  ],
  wires: [],
});

async function openProject(page: Page, project: Project) {
  await page.addInitScript(
    (value) =>
      localStorage.setItem(
        "mechanical-studio-project-v1",
        JSON.stringify(value),
      ),
    project,
  );
  await page.goto("/");
  await expect(page.getByTestId("viewport-canvas")).toBeVisible();
  await expect(page.getByLabel("项目名称")).toHaveValue(project.name);
}
async function stored(page: Page): Promise<Project> {
  return page.evaluate(async () => {
    const storage = await import(`${location.origin}/src/storage.ts`);
    return storage.loadSavedProject();
  });
}
async function vector(dialog: Locator, label: string, values: Vec3) {
  for (let i = 0; i < 3; i++)
    await dialog
      .getByLabel(`${label} ${["X", "Y", "Z"][i]}`, { exact: true })
      .fill(String(values[i]));
}
async function role(dialog: Locator, name: string, value: string) {
  await dialog.getByLabel(`选择子件 ${name}`, { exact: true }).check();
  await dialog
    .getByLabel(`成员角色 ${name}`, { exact: true })
    .selectOption(value);
}
async function rendered(
  page: Page,
  id: string,
  attribute = "data-rendered-positions",
): Promise<Vec3 | undefined> {
  return JSON.parse(
    (await page.getByTestId("viewport").getAttribute(attribute)) ?? "{}",
  )[id];
}

test("多个独立子件创建按压组件，真实键帽移动、弹簧压缩、开关闭合并回弹", async ({
  page,
}) => {
  test.setTimeout(100_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openProject(page, pressProject());
  await page.getByRole("button", { name: /组成功能组件/ }).click();
  const editor = page.getByRole("dialog", {
    name: "组合成功能组件",
    exact: true,
  });
  await editor.getByLabel("功能组件名称", { exact: true }).fill("测试按压组件");
  await role(editor, "按压基座", "fixed");
  await role(editor, "独立键帽", "moving");
  await role(editor, "独立回位弹簧", "spring");
  await role(editor, "独立触发开关", "switch");
  await expect(
    editor.getByLabel("机制参数 弹簧刚度", { exact: true }),
  ).toHaveValue("");
  await expect(
    editor.getByRole("button", { name: "保存并启用组件", exact: true }),
  ).toBeDisabled();
  for (const [label, value] of Object.entries({
    弹簧刚度: "0.02",
    运动质量: "0.3",
    阻尼系数: "2.5",
    最大行程: "3",
    自由长度: "8",
    并圈高度: "3",
  }))
    await editor.getByLabel(`机制参数 ${label}`, { exact: true }).fill(value);
  await editor
    .getByRole("button", { name: "读取活动成员外接尺寸", exact: true })
    .click();
  await expect(
    editor.getByLabel("活动代理位置 Y", { exact: true }),
  ).toHaveValue("12");
  await vector(editor, "固定代理位置", [0, 2, 0]);
  await vector(editor, "固定代理尺寸", [20, 4, 20]);
  await expect(
    editor.getByLabel("机制参数 触发行程", { exact: true }),
  ).toHaveCount(0);
  await expect(
    editor.getByRole("button", { name: "保存并启用组件", exact: true }),
  ).toBeDisabled();
  await editor
    .getByLabel("撞针所属子件", { exact: true })
    .selectOption("press-cap");
  await vector(editor, "撞针局部端点", [0, -2, 0]);
  await vector(editor, "开关局部触发点", [0, 1, 0]);
  await vector(editor, "开关触发面法向", [0, 1, 0]);
  await editor.getByLabel("接触参数 触发面有效半径", { exact: true }).fill("1");
  await editor.getByLabel("接触参数 允许过行程", { exact: true }).fill("1");
  await expect(editor).toContainText("首次接触 2 mm");
  await editor
    .getByRole("button", { name: "保存并启用组件", exact: true })
    .click();
  await expect(editor).toBeHidden();
  const controls = page.getByTestId("mechanism-controls");
  await expect(controls).toContainText("测试按压组件");
  await expect(page.locator("[data-mechanism-id] .tree-row")).toHaveCount(4);
  await expect
    .poll(async () => (await rendered(page, "press-cap"))?.[1])
    .toBe(12);
  await expect(page.getByTestId("viewport")).toHaveAttribute(
    "data-powered-lamps",
    "0",
  );
  await page.evaluate(() => {
    const viewport = document.querySelector('[data-testid="viewport"]')!;
    const recorder = {
      active: true,
      samples: [] as { gap: number; lamps: number }[],
    };
    (
      window as unknown as { contactRecorder: typeof recorder }
    ).contactRecorder = recorder;
    const sample = () => {
      const contacts = Object.values(
        JSON.parse(viewport.getAttribute("data-contact-markers") ?? "{}"),
      ) as { striker: number[]; target: number[] }[];
      const contact = contacts[0];
      if (contact)
        recorder.samples.push({
          gap: contact.striker[1] - contact.target[1],
          lamps: Number(viewport.getAttribute("data-powered-lamps")),
        });
      if (recorder.active) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.getByRole("button", { name: "开始仿真", exact: true }).click();
  const press = controls.locator(".mc-press");
  await press.scrollIntoViewIfNeeded();
  const box = await press.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  try {
    await expect(page.getByTestId("viewport")).toHaveAttribute(
      "data-powered-lamps",
      "1",
    );
    await expect(page.getByTestId("viewport")).toHaveAttribute(
      "data-deformed-parts",
      "1",
    );
    await expect
      .poll(async () => (await rendered(page, "press-cap"))?.[1] ?? 12)
      .toBeLessThanOrEqual(10);
    const positions: Record<string, Vec3> = JSON.parse(
      (await page
        .getByTestId("viewport")
        .getAttribute("data-rendered-positions")) ?? "{}",
    );
    const cap = positions["press-cap"];
    const spring = positions["press-spring"];
    expect(spring[1]).toBeCloseTo(6 - (12 - cap[1]) / 2, 1);
    expect(await rendered(page, "press-base")).toEqual([0, 2, 0]);
    expect(await rendered(page, "press-switch")).toEqual([0, 7, 0]);
    const contacts = Object.values(
      JSON.parse(
        (await page
          .getByTestId("viewport")
          .getAttribute("data-contact-markers")) ?? "{}",
      ),
    ) as { striker: Vec3; target: Vec3; contact: boolean }[];
    expect(contacts[0].target).toEqual([0, 8, 0]);
    expect(contacts[0].striker[1]).toBeLessThanOrEqual(8);
    expect(contacts[0].contact).toBe(true);
    const samples = await page.evaluate(() => {
      const recorder = (
        window as unknown as {
          contactRecorder: {
            active: boolean;
            samples: { gap: number; lamps: number }[];
          };
        }
      ).contactRecorder;
      recorder.active = false;
      return recorder.samples;
    });
    const approaching = samples.filter(
      (sample) => sample.gap > 0.5 && sample.gap < 1.95,
    );
    expect(approaching.length).toBeGreaterThan(0);
    expect(approaching.every((sample) => sample.lamps === 0)).toBe(true);
  } finally {
    await page.mouse.up();
  }
  await expect(page.getByTestId("viewport")).toHaveAttribute(
    "data-powered-lamps",
    "0",
  );
  await expect
    .poll(async () =>
      Math.abs(((await rendered(page, "press-cap"))?.[1] ?? 0) - 12),
    )
    .toBeLessThan(0.01);
  await expect
    .poll(async () =>
      Math.abs(((await rendered(page, "press-spring"))?.[1] ?? 0) - 6),
    )
    .toBeLessThan(0.01);
  await page.getByRole("button", { name: "暂停仿真", exact: true }).click();
  await page.getByRole("button", { name: "运行验证", exact: true }).click();
  await expect(
    page
      .locator(".issue-row")
      .filter({ hasText: "测试按压组件 · 组件按压与回弹" }),
  ).toContainText("通过");
  const project = await stored(page);
  expect(project.mechanisms).toHaveLength(1);
  expect(project.mechanisms![0]).toMatchObject({
    kind: "press",
    status: "configured",
    movingPartIds: ["press-cap"],
    springPartIds: ["press-spring"],
    switchPartId: "press-switch",
    params: { travel: 3 },
    contact: {
      strikerPartId: "press-cap",
      strikerPoint: [0, -2, 0],
      switchPoint: [0, 1, 0],
      switchNormal: [0, 1, 0],
      radius: 1,
      maxOvertravel: 1,
    },
  });
  expect(
    project.parts.find((part) => part.id === "press-cap")!.position,
  ).toEqual([0, 12, 0]);
  await page.reload();
  await page
    .getByRole("button", { name: /装配树/ })
    .first()
    .click();
  await page.getByTitle("选择功能组件：测试按压组件", { exact: true }).click();
  await expect(controls).toContainText("参数已配置");
  expect((await stored(page)).mechanisms).toEqual(project.mechanisms);
  expect(errors).toEqual([]);
});

test("独立公母子件组合旋锁，沿实际代理插入锁定，锁后不能拔出且逆旋可拆", async ({
  page,
}) => {
  test.setTimeout(100_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openProject(page, matingProject());
  await page.getByRole("button", { name: /组成功能组件/ }).click();
  const editor = page.getByRole("dialog", {
    name: "组合成功能组件",
    exact: true,
  });
  await editor
    .getByLabel("功能组件名称", { exact: true })
    .fill("测试公母旋锁组件");
  await editor
    .getByLabel("功能组件类型", { exact: true })
    .selectOption("mating");
  await role(editor, "独立双耳插销", "moving");
  await role(editor, "独立旋锁套座", "fixed");
  await editor
    .getByLabel("活动代理类型", { exact: true })
    .selectOption("bayonet-pin");
  await editor
    .getByLabel("固定代理类型", { exact: true })
    .selectOption("bayonet-socket");
  await expect(
    editor.getByRole("button", { name: "保存并启用组件", exact: true }),
  ).toBeDisabled();
  await editor
    .getByRole("button", { name: "读取活动成员外接尺寸", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "读取固定成员外接尺寸", exact: true })
    .click();
  await editor
    .getByLabel("活动代理参数 尺寸公差 ±", { exact: true })
    .fill("0.1");
  await editor
    .getByLabel("固定代理参数 尺寸公差 ±", { exact: true })
    .fill("0.1");
  await editor.getByLabel("固定代理参数 配合孔径", { exact: true }).fill("9.6");
  await editor.getByLabel("机制参数 允许插入深度", { exact: true }).fill("18");
  await editor
    .getByLabel("机制参数 要求的最小单侧余隙", { exact: true })
    .fill("0.1");
  await editor
    .getByLabel("机制参数 锁定角（当前仅45°）", { exact: true })
    .fill("90");
  await expect(
    editor.getByRole("button", { name: "保存并启用组件", exact: true }),
  ).toBeDisabled();
  await editor
    .getByLabel("机制参数 锁定角（当前仅45°）", { exact: true })
    .fill("45");
  await editor
    .getByRole("button", { name: "保存并启用组件", exact: true })
    .click();
  await expect(editor).toBeHidden();
  const controls = page.getByTestId("mechanism-controls");
  const offset = async () => (await stored(page)).mechanisms![0].pose.offset;
  const angle = async () => (await stored(page)).mechanisms![0].pose.angle;
  await controls.getByLabel("组件位移步长", { exact: true }).fill("10");
  await controls.getByRole("button", { name: "沿轴 −", exact: true }).click();
  await expect.poll(offset).toBe(-10);
  await controls.getByRole("button", { name: "转至 45°", exact: true }).click();
  await expect(controls.getByRole("alert")).toBeVisible();
  expect(await angle()).toBe(0);
  await controls.getByLabel("组件位移步长", { exact: true }).fill("7");
  await controls.getByRole("button", { name: "沿轴 −", exact: true }).click();
  await expect.poll(offset).toBe(-17);
  await controls.getByRole("button", { name: "转至 45°", exact: true }).click();
  await expect.poll(angle).toBe(45);
  await expect
    .poll(
      async () =>
        (await rendered(page, "mating-pin", "data-rendered-rotations"))?.[1],
    )
    .toBeCloseTo(45, 4);
  expect(await rendered(page, "mating-pin")).toEqual([0, 14, 0]);
  expect(await rendered(page, "mating-socket")).toEqual([0, 9, 0]);
  await controls
    .getByRole("button", { name: "编辑成员、类型与交互参数", exact: true })
    .click();
  const lockedEditor = page.getByRole("dialog", {
    name: "编辑功能组件",
    exact: true,
  });
  await expect(
    lockedEditor.getByLabel("机制操作轴", { exact: true }),
  ).toBeDisabled();
  await expect(
    lockedEditor.getByLabel("活动代理尺寸 X", { exact: true }),
  ).toBeDisabled();
  await expect(
    lockedEditor.getByLabel("成员角色 独立双耳插销", { exact: true }),
  ).toBeDisabled();
  await lockedEditor
    .locator("summary")
    .filter({ hasText: "组件整体坐标系" })
    .click();
  await expect(
    lockedEditor.getByLabel("组件坐标原点 X", { exact: true }),
  ).toBeDisabled();
  await lockedEditor
    .getByLabel("功能组件名称", { exact: true })
    .fill("测试公母旋锁组件 · 已锁定");
  await lockedEditor
    .getByRole("button", { name: "保存并启用组件", exact: true })
    .click();
  await expect(lockedEditor).toBeHidden();
  expect(await angle()).toBe(45);
  await controls.getByLabel("组件位移步长", { exact: true }).fill("17");
  await controls.getByRole("button", { name: "沿轴 ＋", exact: true }).click();
  await expect(controls.getByRole("alert")).toBeVisible();
  expect(await offset()).toBe(-17);
  await controls.getByRole("button", { name: "逆旋回零", exact: true }).click();
  await expect.poll(angle).toBe(0);
  await controls.getByRole("button", { name: "沿轴 ＋", exact: true }).click();
  await expect.poll(offset).toBe(0);
  await expect
    .poll(async () => (await rendered(page, "mating-pin"))?.[1])
    .toBe(31);
  expect(errors).toEqual([]);
});
