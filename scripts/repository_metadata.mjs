/** Explicit source-name relationships from the controller README and manifest.
 * These suggest component types, never measured/verified interaction parameters.
 */
const standardButtons = new Set([
  "buttons-left",
  "buttons-right",
  "buttons-down",
  "buttons-up",
  "buttons-a",
  "buttons-b",
  "buttons-x",
  "buttons-y",
]);
const keyLabels = {
  "buttons-left": "左键",
  "buttons-right": "右键",
  "buttons-down": "下键",
  "buttons-up": "上键",
  "buttons-a": "A 键",
  "buttons-b": "B 键",
  "buttons-x": "X 键",
  "buttons-y": "Y 键",
};
export function repositoryNodeMetadata(asset, node) {
  const source = node.displayName;
  const group = (suffix, name) => ({ id: `${asset.id}-${suffix}`, name });
  const typed = (kind, typeBasis, assemblyGroup, role = "support") => ({
    kind,
    typeBasis: `${typeBasis}；交互轴、尺寸及物理参数待人工标定。`,
    ...(assemblyGroup ? { group: assemblyGroup, role } : {}),
  });
  if (standardButtons.has(asset.id)) {
    const key = keyLabels[asset.id];
    const mating = group("pin-sleeve", `${key} · 键帽插销 / 下套筒`);
    const rebound = group("spring-seat", `${key} · 弹簧 / 定位环`);
    const contact = group("switch", `${key} · 开关 / 按杆 / 焊脚`);
    if (
      source.includes("一体式键帽与蓝色插销") ||
      source.includes("同款插销与圆形键帽")
    )
      return typed("pin", "来源对象明确为键帽与上插销一体件", mating, "male");
    if (source.includes("下环一体式开关套筒"))
      return typed(
        "sleeve",
        "来源对象明确为下环一体式开关套筒",
        mating,
        "female",
      );
    if (source.includes("回位弹簧"))
      return typed("spring", "来源对象明确为回位弹簧", rebound);
    if (source.includes("弹簧定位环"))
      return { kind: "asset", group: rebound, role: "support" };
    if (source.includes("6×6 开关"))
      return typed("button", "来源对象明确为 6×6 轻触开关", contact);
    if (source.includes("按杆") || source.includes("焊脚占位"))
      return { kind: "asset", group: contact, role: "support" };
  }
  if (asset.id === "buttons-confirm") {
    const mating = group("guide", "确认键 · 键帽 / 按压导向座");
    const contact = group("switch", "确认键 · 开关 / 触头 / 焊脚");
    if (source.includes("旋锁座"))
      return typed(
        "sleeve",
        "源网格确认内部为键帽滑动导向；座体外部卡耳与上盖安装，另行核对实际锁装路径",
        mating,
        "female",
      );
    if (source.includes("键帽"))
      return typed(
        "pin",
        "源网格确认键帽在座内按压滑动，闭壳防脱由上盖止挡提供；键帽本身不是旋锁公件",
        mating,
        "male",
      );
    if (source.includes("回弹压簧"))
      return typed("spring", "来源对象明确为回弹压簧");
    if (source.includes("常开开关"))
      return typed("button", "来源对象明确为常开开关", contact);
    if (source.includes("开关触头") || source.includes("焊脚"))
      return { kind: "asset", group: contact, role: "support" };
  }
  if (asset.id === "baseplates-dpad" || asset.id === "baseplates-abxy")
    return {
      kind: "asset",
      group: group(
        "fasteners",
        `${asset.id === "baseplates-dpad" ? "方向键" : "ABXY"} · 底座 / M2 固定件`,
      ),
      role: "support",
    };
  if (asset.id === "housing-top" || asset.id === "housing-bottom")
    return {
      kind: "asset",
      group: { id: "housing-shell", name: "手柄 · 上盖 / 底壳" },
      role: "support",
    };
  if (asset.id === "electronics-esp32-mount") {
    if (source.startsWith("ESP32 ·"))
      return {
        kind: "asset",
        group: group("board", "ESP32 · PCB / 板载模块"),
        role: "support",
      };
    if (source.startsWith("PCB ·"))
      return {
        kind: "asset",
        group: group("retainer", "ESP32 · 压条 / 软垫 / 螺钉"),
        role: "support",
      };
    // Exact exported names in manifest.json identify two separate 17-pin rows.
    const pin = /^Header pin\.(\d+)$/.exec(source);
    const row =
      pin && +pin[1] >= 170 && +pin[1] <= 186
        ? "front"
        : pin && +pin[1] >= 187 && +pin[1] <= 203
          ? "back"
          : source === "Pin header.010"
            ? "front"
            : source === "Pin header.011"
              ? "back"
              : undefined;
    if (row)
      return {
        kind: "asset",
        group: group(
          `header-${row}`,
          `ESP32 · ${row === "front" ? "前" : "后"}排针座 / 排针`,
        ),
        role: "support",
      };
  }
  if (asset.id === "electronics-harness") {
    const key = source.split(" · ")[0];
    const slug = {
      A: "a",
      B: "b",
      X: "x",
      Y: "y",
      上: "up",
      下: "down",
      左: "left",
      右: "right",
      确认: "confirm",
      公共接地: "common-ground",
    }[key];
    if (slug)
      return {
        kind: "asset",
        group: group(
          slug,
          `${key} · ${slug === "common-ground" ? "公共地线 / 汇流排" : "GPIO / GND 线对"}`,
        ),
        role: "support",
      };
  }
  return { kind: "asset" };
}
