import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Layers3,
  Search,
  Plus,
  ChevronDown,
  ChevronRight,
  Move,
  RotateCw,
  MousePointer2,
  Cable,
  Grid3X3,
  Scan,
  Eye,
  EyeOff,
  LockKeyhole,
  UnlockKeyhole,
  Copy,
  Trash2,
  Undo2,
  Redo2,
  Play,
  Pause,
  Check,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Download,
  Upload,
  X,
  SlidersHorizontal,
  Zap,
  Lightbulb,
  CircleHelp,
  Maximize,
  FolderOpen,
  FilePlus2,
  Settings2,
  RotateCcw,
  Link2,
  Square,
  CircleDot,
} from "lucide-react";
import Viewport from "./components/Viewport";
import {
  definitions,
  bayonetDemoProject,
  makePart,
  newId,
  parseProject,
} from "./catalog";
import {
  validateAssembly,
  validateMotion,
  solveCircuit,
  stepSpring,
} from "./engine/physics";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import { BAYONET_POSES } from "./engine/bayonet";
import type {
  AssetEntry,
  Category,
  Issue,
  Part,
  PartKind,
  Project,
  SpringState,
  Vec3,
} from "./types";

const STORAGE = "mechanical-studio-project-v1";
function initialProject() {
  try {
    const data = localStorage.getItem(STORAGE);
    if (data) return parseProject(data);
  } catch {
    /* use safe baseline */
  }
  return bayonetDemoProject();
}
function download(name: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const kindIcon = (kind: PartKind) =>
  kind === "battery"
    ? Zap
    : kind === "lamp"
      ? Lightbulb
      : kind === "button"
        ? CircleDot
        : kind === "spring"
          ? RotateCcw
          : kind === "asset"
            ? Layers3
            : Box;
const n = (v: number) => Number(v.toFixed(3));
function NumberField({
  value,
  onChange,
  label,
  step = 1,
  min,
  max,
  disabled = false,
}: {
  value: number;
  onChange: (v: number) => void;
  label: string;
  step?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(String(n(value)));
  useEffect(() => setDraft(String(n(value))), [value]);
  function commit() {
    const v = Number(draft);
    if (
      draft.trim() !== "" &&
      Number.isFinite(v) &&
      (min === undefined || v >= min) &&
      (max === undefined || v <= max)
    ) {
      onChange(v);
      setDraft(String(n(value)));
    } else setDraft(String(n(value)));
  }
  return (
    <input
      aria-label={label}
      type="number"
      value={draft}
      step={step}
      min={min}
      max={max}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(String(n(value)));
          e.currentTarget.blur();
        }
      }}
    />
  );
}
function MiniPart({ kind, color }: { kind: PartKind; color: string }) {
  return (
    <div
      className={`mini-part mini-${kind}`}
      style={{ "--part-color": color } as React.CSSProperties}
    >
      <i />
      <b />
      <em />
    </div>
  );
}
export default function App() {
  const [project, setProject] = useState<Project>(initialProject);
  const [selectedId, setSelectedId] = useState<string | null>(
    () =>
      project.parts.find((p) => p.kind === "bayonet-pin" || p.kind === "tenon")
        ?.id ??
      project.parts[0]?.id ??
      null,
  );
  const [undo, setUndo] = useState<Project[]>([]);
  const [redo, setRedo] = useState<Project[]>([]);
  const [tool, setTool] = useState<"select" | "move" | "rotate" | "wire">(
    "select",
  );
  const [view, setView] = useState<"perspective" | "top" | "front">(
    "perspective",
  );
  const [grid, setGrid] = useState(true);
  const [xray, setXray] = useState(false);
  const [exploded, setExploded] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [category, setCategory] = useState<Category>("all");
  const [leftTab, setLeftTab] = useState<"library" | "assembly">("library");
  const [search, setSearch] = useState("");
  const [nav, setNav] = useState("装配工作台");
  const [panelTab, setPanelTab] = useState<"properties" | "circuit">(
    "properties",
  );
  const [moveStep, setMoveStep] = useState(1);
  const [rotateStep, setRotateStep] = useState(15);
  const [running, setRunning] = useState(false);
  const [heldId, setHeldId] = useState<string | null>(null);
  const [springStates, setSpringStates] = useState<Record<string, SpringState>>(
    {},
  );
  const [elapsed, setElapsed] = useState(0);
  const simulationRef = useRef<Record<string, SpringState>>({});
  const simulationTimeRef = useRef(0);
  const [toast, setToast] = useState("");
  const [assets, setAssets] = useState<AssetEntry[]>([]);
  const [assetError, setAssetError] = useState("");
  const [help, setHelp] = useState(false);
  const [report, setReport] = useState<{ issues: Issue[]; at: string } | null>(
    null,
  );
  const [bottomOpen, setBottomOpen] = useState(true);
  const [bottomTab, setBottomTab] = useState<"checks" | "wires">("checks");
  const [wireFrom, setWireFrom] = useState("");
  const [wireTo, setWireTo] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = project.parts.find((p) => p.id === selectedId);
  const notify = useCallback((message: string) => setToast(message), []);
  const resetSimulation = useCallback(() => {
    setRunning(false);
    setHeldId(null);
    setSpringStates({});
    setElapsed(0);
    simulationRef.current = {};
    simulationTimeRef.current = 0;
  }, []);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 5500);
      return () => clearTimeout(t);
    }
  }, [toast]);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE, JSON.stringify(project));
    } catch {
      notify("本地存储空间不足，请导出项目保存。");
    }
    setReport(null);
  }, [project, notify]);
  useEffect(() => {
    let cancelled = false;
    fetch("./models/catalog.json")
      .then((r) => {
        if (!r.ok) throw Error();
        return r.json();
      })
      .then((data) => {
        if (!cancelled)
          setAssets(Array.isArray(data) ? data : (data.assets ?? []));
      })
      .catch(() => {
        if (!cancelled)
          setAssetError("素材目录暂不可用，请运行 npm run assets:export。");
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const commit = useCallback(
    (next: Project) => {
      setUndo((prev) => [...prev.slice(-59), project]);
      setRedo([]);
      setProject(next);
      resetSimulation();
    },
    [project, resetSimulation],
  );
  const undoAction = useCallback(() => {
    if (!undo.length) return;
    setRedo((p) => [...p, project]);
    setProject(undo[undo.length - 1]);
    setUndo((p) => p.slice(0, -1));
    resetSimulation();
  }, [undo, project, resetSimulation]);
  const redoAction = useCallback(() => {
    if (!redo.length) return;
    setUndo((p) => [...p, project]);
    setProject(redo[redo.length - 1]);
    setRedo((p) => p.slice(0, -1));
    resetSimulation();
  }, [redo, project, resetSimulation]);
  const exportProject = useCallback(() => {
    download(`${project.name}.mechanical.json`, project);
    notify("项目已导出，包含全部装配位置、物理参数与导线。");
  }, [project, notify]);
  const removeSelected = useCallback(() => {
    if (!selected) return;
    commit({
      ...project,
      parts: project.parts.filter((p) => p.id !== selected.id),
      wires: project.wires.filter(
        (w) => w.from.partId !== selected.id && w.to.partId !== selected.id,
      ),
    });
    setSelectedId(null);
  }, [selected, project, commit]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        exportProject();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        if (e.shiftKey) redoAction();
        else undoAction();
      } else if (e.key === "Delete") removeSelected();
      else if (e.key.toLowerCase() === "v") setTool("select");
      else if (e.key.toLowerCase() === "g") setTool("move");
      else if (e.key.toLowerCase() === "r") setTool("rotate");
      else if (e.key === "Escape") {
        setHelp(false);
        setHeldId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exportProject, undoAction, redoAction, removeSelected]);
  useEffect(() => {
    const release = () => setHeldId(null);
    window.addEventListener("pointerup", release);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("blur", release);
    };
  }, []);
  useEffect(() => {
    if (!running) return;
    let frame = 0,
      previous = performance.now(),
      lastPaint = 0;
    const states: Record<string, SpringState> = { ...simulationRef.current };
    project.parts
      .filter((p) => p.kind === "spring" || p.kind === "button")
      .forEach((p) => {
        states[p.id] ??= { displacement: 0, velocity: 0, force: 0 };
      });
    let time = simulationTimeRef.current;
    const tick = (now: number) => {
      const dt = Math.min((now - previous) / 1000, 0.04);
      previous = now;
      time += dt;
      for (const p of project.parts) {
        if (!states[p.id]) continue;
        states[p.id] = stepSpring(states[p.id], dt, {
          stiffness: Number(p.params.stiffness ?? 0.8),
          damping: Number(p.params.damping ?? 1.2),
          mass: Number(p.params.mass ?? 0.03),
          travel: Number(p.params.travel ?? 1),
          force:
            p.id === heldRef.current
              ? Number(p.params.stiffness ?? 0.8) *
                Number(p.params.travel ?? 1) *
                1.1
              : 0,
        });
      }
      simulationRef.current = states;
      simulationTimeRef.current = time;
      if (now - lastPaint > 30) {
        setSpringStates({ ...states });
        setElapsed(time);
        lastPaint = now;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [running, project]);
  const heldRef = useRef(heldId);
  heldRef.current = heldId;
  const renderedParts = useMemo(
    () =>
      project.parts.map((p) =>
        springStates[p.id]
          ? {
              ...p,
              params: {
                ...p.params,
                compression: springStates[p.id].displacement,
              },
            }
          : p,
      ),
    [project.parts, springStates],
  );
  const pressedIds = useMemo(
    () =>
      renderedParts
        .filter(
          (p) =>
            p.kind === "button" &&
            Number(p.params.compression ?? 0) >=
              Number(p.params.trigger ?? 0.6),
        )
        .map((p) => p.id),
    [renderedParts],
  );
  const validation = useMemo(
    () => validateAssembly(project.parts),
    [project.parts],
  );
  const circuit = useMemo(
    () => solveCircuit(project.parts, project.wires, pressedIds),
    [project.parts, project.wires, pressedIds],
  );
  const liveIssues = useMemo(
    () => [
      ...validation.issues,
      ...circuit.issues,
      ...(project.wires.length
        ? [
            {
              id: "wire-clearance",
              severity: "warning" as const,
              title: "线束空间待校验",
              detail:
                "导线仅验证电气连通。线径、弯曲半径、焊点与机构干涉尚需基于实物和原始几何复核。",
              partIds: [],
              category: "geometry" as const,
            },
          ]
        : []),
    ],
    [validation, circuit, project.wires.length],
  );
  const issues = report?.issues ?? liveIssues;
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const collisionIds = validation.collisionPairs.flat();
  function updatePart(next: Part) {
    commit({
      ...project,
      parts: project.parts.map((p) => (p.id === next.id ? next : p)),
    });
  }
  function transform(id: string, position: Vec3, rotation: Vec3) {
    const part = project.parts.find((p) => p.id === id);
    if (!part) return;
    if (exploded) {
      notify("请先退出爆炸视图，再进行装配操作。");
      return;
    }
    const next = {
      ...part,
      position: position.map(n) as Vec3,
      rotation: rotation.map(n) as Vec3,
    };
    const check = validateMotion(project.parts, id, next);
    if (!check.allowed) {
      notify(
        check.issues.find((i) => i.severity === "error")?.detail ??
          "移动受到相邻零件阻挡。",
      );
      return;
    }
    updatePart(next);
  }
  function move(axis: number, sign: number) {
    if (!selected) return;
    const pos = [...selected.position] as Vec3;
    pos[axis] += moveStep * sign;
    transform(selected.id, pos, selected.rotation);
  }
  function rotate(axis: number, sign: number) {
    if (!selected) return;
    const rot = [...selected.rotation] as Vec3;
    rot[axis] += rotateStep * sign;
    transform(selected.id, selected.position, rot);
  }
  function addPart(kind: PartKind) {
    const part = makePart(kind);
    let x = 0;
    const maxEdge = Math.max(
      0,
      ...project.parts.map(
        (p) => p.position[0] + Math.max(p.size[0], p.size[2]) / 2,
      ),
    );
    x = project.parts.length ? maxEdge + part.size[0] / 2 + 6 : 0;
    part.position = [x, part.size[1] / 2, 0];
    commit({ ...project, parts: [...project.parts, part] });
    setSelectedId(part.id);
    notify(`已添加${part.name}，可通过右侧面板精确定位。`);
  }
  function addAsset(asset: AssetEntry) {
    const edge = Math.max(
      0,
      ...project.parts.map((p) => p.position[0] + p.size[0] / 2),
    );
    const part: Part = {
      id: newId(),
      name: asset.name,
      kind: "asset",
      position: [edge + asset.size[0] / 2 + 8, asset.size[1] / 2, 0],
      rotation: [0, 0, 0],
      size: asset.size,
      color: "#92a9b6",
      fixed: false,
      visible: true,
      params: { assetUrl: asset.url },
    };
    commit({ ...project, parts: [...project.parts, part] });
    setSelectedId(part.id);
    notify("已载入原始素材显示副本。复杂网格需进一步进行实体几何验证。");
  }
  function loadBayonetDemo() {
    const p = bayonetDemoProject();
    commit(p);
    setSelectedId(p.parts.find((part) => part.kind === "bayonet-pin")!.id);
    setLeftTab("library");
    setPanelTab("properties");
    setExploded(false);
    setResetKey((k) => k + 1);
    notify(
      "旋锁示例已载入：先插入槽底，再旋转45°锁定。所有操作均检查实际路径。",
    );
  }
  function bayonetAction(
    action: "entry" | "insert" | "lock" | "unlock" | "withdraw",
  ) {
    if (!selected || selected.kind !== "bayonet-pin") return;
    const sockets = project.parts
      .filter((p) => p.kind === "bayonet-socket")
      .sort(
        (a, b) =>
          new Vector3(...a.position).distanceToSquared(
            new Vector3(...selected.position),
          ) -
          new Vector3(...b.position).distanceToSquared(
            new Vector3(...selected.position),
          ),
      );
    const socket = sockets[0];
    if (!socket) {
      notify("请先添加配套旋锁套座（母件）。");
      return;
    }
    const orientation = new Quaternion().setFromEuler(
      new Euler(...(socket.rotation.map((v) => (v * Math.PI) / 180) as Vec3)),
    );
    const position = [...selected.position] as Vec3;
    let rotation = [...selected.rotation] as Vec3;
    if (["entry", "insert", "withdraw"].includes(action)) {
      const target = new Vector3(
        0,
        action === "insert"
          ? BAYONET_POSES.seatedOffset
          : action === "withdraw"
            ? BAYONET_POSES.withdrawnOffset
            : BAYONET_POSES.entryOffset,
        0,
      )
        .applyQuaternion(orientation)
        .add(new Vector3(...socket.position));
      position.splice(0, 3, ...target.toArray());
    }
    if (["entry", "lock", "unlock"].includes(action)) {
      const target = orientation
        .clone()
        .multiply(
          new Quaternion().setFromAxisAngle(
            new Vector3(0, 1, 0),
            action === "lock" ? (BAYONET_POSES.lockAngle * Math.PI) / 180 : 0,
          ),
        );
      const euler = new Euler().setFromQuaternion(target, "XYZ");
      rotation = [euler.x, euler.y, euler.z].map(
        (v) => (v * 180) / Math.PI,
      ) as Vec3;
    }
    transform(selected.id, position, rotation);
  }
  async function loadOriginal() {
    try {
      const response = await fetch("./models/puretv-assembly.json");
      if (!response.ok) throw Error("原始装配资源不可用");
      const p = parseProject(await response.text());
      commit(p);
      setSelectedId(p.parts[0]?.id ?? null);
      setLeftTab("assembly");
      setResetKey((k) => k + 1);
      notify("已按原始坐标恢复手柄装配。可使用爆炸视图或选择总成后拆分。");
    } catch (err) {
      notify((err as Error).message);
    }
  }
  function splitAsset() {
    if (!selected) return;
    const asset = assets.find((a) => a.url === selected.params.assetUrl);
    if (!asset?.nodes?.length) {
      notify("此素材尚无分件目录。");
      return;
    }
    const scale = selected.size.map((v, i) => v / asset.size[i]) as Vec3;
    const matrix = new Matrix4().compose(
      new Vector3(...selected.position),
      new Quaternion().setFromEuler(
        new Euler(
          ...(selected.rotation.map((v) => (v * Math.PI) / 180) as Vec3),
        ),
      ),
      new Vector3(...scale),
    );
    const parts: Part[] = asset.nodes.map((node) => {
      const position = new Vector3(...node.center)
        .sub(new Vector3(...asset.center))
        .applyMatrix4(matrix)
        .toArray() as Vec3;
      return {
        ...selected,
        id: newId(),
        name: node.name,
        position,
        size: node.size.map((v, i) => Math.max(v * scale[i], 0.001)) as Vec3,
        params: { assetUrl: asset.url, assetNode: node.name },
      };
    });
    commit({
      ...project,
      parts: [...project.parts.filter((p) => p.id !== selected.id), ...parts],
    });
    setSelectedId(parts[0]?.id ?? null);
    setLeftTab("assembly");
    notify(
      `已拆分为 ${parts.length} 个独立零件，可分别移动和旋转。原始网格仍需精确碰撞复核。`,
    );
  }
  function duplicate() {
    if (!selected) return;
    const edge = Math.max(
      ...project.parts.map((p) => p.position[0] + p.size[0] / 2),
    );
    const p = {
      ...structuredClone(selected),
      id: newId(),
      name: selected.name + " 副本",
      fixed: false,
      position: [
        edge + selected.size[0] / 2 + 5,
        selected.size[1] / 2,
        0,
      ] as Vec3,
    };
    commit({ ...project, parts: [...project.parts, p] });
    setSelectedId(p.id);
  }
  function updateParam(key: string, value: number) {
    if (!selected) return;
    const params = { ...selected.params, [key]: value };
    if (
      (key === "innerWidth" && value >= selected.size[0]) ||
      (key === "innerDepth" && value >= selected.size[2]) ||
      (key === "holeDiameter" &&
        value >= Math.min(selected.size[0], selected.size[2]))
    ) {
      notify("孔尺寸必须小于零件外轮廓。");
      return;
    }
    if (key === "holeDiameter") {
      params.innerWidth = value;
      params.innerDepth = value;
    }
    if (Number(params.trigger ?? 0) > Number(params.travel ?? Infinity)) {
      notify("触发行程不能超过最大行程。");
      return;
    }
    updatePart({ ...selected, params });
  }
  function addWire() {
    if (!wireFrom || !wireTo) {
      notify("请先选择导线的两个接线端子。");
      return;
    }
    const [from, ft] = wireFrom.split(":");
    const [to, tt] = wireTo.split(":");
    if (
      !electrical.some((p) => p.id === from) ||
      !electrical.some((p) => p.id === to) ||
      !["0", "1"].includes(ft) ||
      !["0", "1"].includes(tt)
    ) {
      setWireFrom("");
      setWireTo("");
      notify("端点已发生变化，请重新选择当前电气零件。");
      return;
    }
    if (from === to) {
      notify("请选择两个不同零件的端子。");
      return;
    }
    if (
      project.wires.some((w) =>
        [
          `${w.from.partId}:${w.from.terminal}|${w.to.partId}:${w.to.terminal}`,
          `${w.to.partId}:${w.to.terminal}|${w.from.partId}:${w.from.terminal}`,
        ].includes(`${wireFrom}|${wireTo}`),
      )
    ) {
      notify("这两个端子已经连接。");
      return;
    }
    commit({
      ...project,
      wires: [
        ...project.wires,
        {
          id: newId(),
          from: { partId: from, terminal: Number(ft) as 0 | 1 },
          to: { partId: to, terminal: Number(tt) as 0 | 1 },
          color: "#c97b63",
        },
      ],
    });
    setWireFrom("");
    setWireTo("");
    notify("导线已连接，电路已重新计算。");
  }
  function verify() {
    const all = [...liveIssues];
    for (const p of project.parts.filter(
      (p) => p.kind === "spring" || p.kind === "button",
    )) {
      let state = { displacement: 0, velocity: 0, force: 0 };
      let peak = 0;
      const params = {
        stiffness: Number(p.params.stiffness ?? 0.8),
        damping: Number(p.params.damping ?? 1.2),
        mass: Number(p.params.mass ?? 0.03),
        travel: Number(p.params.travel ?? 1),
        force: 0,
      };
      for (let i = 0; i < 1200; i++) {
        state = stepSpring(state, 1 / 240, {
          ...params,
          force: i < 240 ? params.stiffness * params.travel * 1.1 : 0,
        });
        peak = Math.max(peak, state.displacement);
      }
      const passed =
        Math.abs(state.displacement) < 0.01 &&
        Math.abs(state.velocity) < 0.01 &&
        (p.kind !== "button" || peak >= Number(p.params.trigger ?? 0.6));
      all.push({
        id: `cycle-${p.id}`,
        category: "physics",
        severity: passed ? "pass" : "error",
        title: `${p.name} · 按压与回弹`,
        detail: `5 s 数值试验；最大压缩 ${peak.toFixed(3)} mm，释放后残余 ${state.displacement.toFixed(4)} mm。采用名义刚度及阻尼，尚需实测。`,
        partIds: [p.id],
      });
    }
    const switches = project.parts
      .filter((p) => p.kind === "button")
      .map((p) => p.id);
    if (switches.length) {
      const closed = solveCircuit(project.parts, project.wires, switches);
      all.push(
        ...closed.issues
          .filter((i) => i.severity === "error")
          .map((i) => ({
            ...i,
            id: `closed-${i.id}`,
            title: `闭合态 · ${i.title}`,
          })),
      );
      all.push({
        id: "closed-test",
        category: "circuit",
        severity: closed.shortCircuit
          ? "error"
          : closed.poweredLampIds.length
            ? "pass"
            : "warning",
        title: "按压触发后的电路",
        detail: closed.shortCircuit
          ? "开关闭合后存在电源短路。"
          : `闭合所有按压开关后，${closed.poweredLampIds.length} 个灯获得供电，电流 ${(closed.current * 1000).toFixed(2)} mA。`,
        partIds: closed.poweredLampIds,
      });
    }
    setReport({ issues: all, at: new Date().toISOString() });
    setBottomOpen(true);
    setBottomTab("checks");
    setNav("仿真验证");
    notify("验证完成，查看下方逐项结果；报告包含模型精度限制。");
  }
  const electrical = project.parts.filter((p) =>
    ["battery", "button", "lamp", "resistor"].includes(p.kind),
  );
  const terminalLabel = (p: Part, t: number) =>
    `${p.name} · ${p.kind === "battery" ? (t === 0 ? "正极 +" : "负极 −") : t === 0 ? "端子 A" : "端子 B"}`;
  const filtered = definitions.filter(
    (d) =>
      (category === "all" || d.category === category) &&
      d.name.includes(search),
  );
  const simState = selected ? springStates[selected.id] : undefined;
  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" onClick={(e) => e.preventDefault()}>
          <span className="brand-icon">
            <Box size={23} />
          </span>
          <span>
            MECHANICAL<span className="brand-studio">STUDIO</span>
          </span>
          <span className="version">BETA</span>
        </a>
        <nav>
          {["装配工作台", "仿真验证", "素材资源"].map((v) => (
            <button
              key={v}
              className={nav === v ? "active" : ""}
              onClick={() => {
                setNav(v);
                if (v === "仿真验证") {
                  setBottomOpen(true);
                  setBottomTab("checks");
                }
                if (v === "素材资源") {
                  setCategory("repository");
                  setLeftTab("library");
                }
              }}
            >
              {v}
            </button>
          ))}
        </nav>
        <div className="top-actions">
          <button
            className="icon-button"
            title="操作说明"
            onClick={() => setHelp(true)}
          >
            <CircleHelp size={18} />
          </button>
          <span className="local-badge">
            <i />
            本地工作空间
          </span>
          <span className="avatar">M</span>
        </div>
      </header>
      <div className="projectbar">
        <div className="project-title">
          <FolderOpen size={18} />
          <input
            aria-label="项目名称"
            maxLength={200}
            value={project.name}
            onChange={(e) => setProject({ ...project, name: e.target.value })}
          />
          <span className="saved">
            <Check size={12} /> 自动保存
          </span>
        </div>
        <div className="project-actions">
          <button
            title="新建空白项目"
            onClick={() => {
              commit({ version: 1, name: "未命名装配", parts: [], wires: [] });
              setSelectedId(null);
            }}
          >
            <FilePlus2 size={15} />
            新建
          </button>
          <button onClick={() => inputRef.current?.click()}>
            <Upload size={15} />
            导入
          </button>
          <button onClick={exportProject}>
            <Download size={15} />
            保存项目
          </button>
          <i />
          <button className="verify-button" onClick={verify}>
            <CheckCircle2 size={15} />
            运行验证
          </button>
          <button
            className={`primary ${running ? "running" : ""}`}
            onClick={() => {
              if (!running && liveIssues.some((i) => i.severity === "error")) {
                notify(
                  "请先处理实时检查中的尺寸、干涉或电路错误，再开始仿真。",
                );
                setBottomOpen(true);
                return;
              }
              setRunning(!running);
              setHeldId(null);
              if (!running) setExploded(false);
            }}
          >
            {running ? <Pause size={15} /> : <Play size={15} />}{" "}
            {running ? "暂停仿真" : elapsed > 0 ? "继续仿真" : "开始仿真"}
          </button>
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".json"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          try {
            if (file.size > 5e6) throw Error("项目文件不能超过 5 MB。");
            const p = parseProject(await file.text());
            commit(p);
            setSelectedId(p.parts[0]?.id ?? null);
            notify("项目导入成功。");
          } catch (err) {
            notify(`导入失败：${(err as Error).message}`);
          }
          e.target.value = "";
        }}
      />
      <main className="workspace">
        <aside className="left-panel">
          <div className="panel-tabs">
            <button
              className={leftTab === "library" ? "active" : ""}
              onClick={() => setLeftTab("library")}
            >
              <Box size={15} />
              零件库
            </button>
            <button
              className={leftTab === "assembly" ? "active" : ""}
              onClick={() => setLeftTab("assembly")}
            >
              <Layers3 size={15} />
              装配树 <small>{project.parts.length}</small>
            </button>
          </div>
          {leftTab === "library" ? (
            <>
              <div className="library-search">
                <Search size={15} />
                <input
                  placeholder="搜索零件…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <kbd>⌕</kbd>
              </div>
              <div className="categories">
                {(
                  [
                    ["all", "全部"],
                    ["mechanical", "机械"],
                    ["electrical", "电气"],
                    ["repository", "原始素材"],
                  ] as [Category, string][]
                ).map(([id, label]) => (
                  <button
                    key={id}
                    className={category === id ? "active" : ""}
                    onClick={() => setCategory(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="library-scroll">
                <div className="section-heading">
                  <span>
                    {category === "repository"
                      ? "PURETV 手柄素材"
                      : "参数化标准件"}
                  </span>
                  <span>
                    {category === "repository"
                      ? assets.length
                      : filtered.length}
                  </span>
                </div>
                {category !== "repository" && (
                  <button
                    className="bayonet-demo-button"
                    onClick={loadBayonetDemo}
                  >
                    <RotateCw size={16} />
                    <span>
                      旋锁装配示例<small>插入 → 旋转45° → 锁定</small>
                    </span>
                    <ChevronRight size={14} />
                  </button>
                )}
                <div className="parts-grid">
                  {category !== "repository" &&
                    filtered.map((d) => (
                      <button
                        key={d.kind}
                        className="part-card"
                        onClick={() => addPart(d.kind)}
                        title={`添加${d.name}`}
                      >
                        <div className="part-preview">
                          <MiniPart kind={d.kind} color={d.color} />
                          <span className="add-part">
                            <Plus size={13} />
                          </span>
                        </div>
                        <strong>{d.name}</strong>
                        <span>{d.subtitle}</span>
                      </button>
                    ))}
                </div>
                {category === "repository" && (
                  <>
                    <button
                      className="original-assembly-button"
                      onClick={loadOriginal}
                    >
                      <Layers3 size={15} />
                      <span>
                        打开原手柄装配<small>保留各总成的原始装配坐标</small>
                      </span>
                      <ChevronRight size={14} />
                    </button>
                    <p className="library-note">
                      来自仓库的 Blender
                      分件素材。保留原始文件，使用轻量副本浏览装配。
                    </p>
                    {assetError && <p className="hint amber">{assetError}</p>}
                    {assets
                      .filter((a) =>
                        a.name.toLowerCase().includes(search.toLowerCase()),
                      )
                      .map((a) => (
                        <button
                          className="asset-card"
                          key={a.id}
                          onClick={() => addAsset(a)}
                        >
                          <div>
                            <Layers3 size={23} />
                          </div>
                          <span>
                            <strong>{a.name}</strong>
                            <small>
                              {a.objects} 个对象 ·{" "}
                              {a.size.map((v) => v.toFixed(1)).join(" × ")} mm
                            </small>
                          </span>
                          <Plus size={15} />
                        </button>
                      ))}
                    <p className="attribution">
                      部分手柄造型改编自 Taohid Animation 的 PS5 Controller · CC
                      BY 4.0。详见素材说明。
                    </p>
                  </>
                )}
              </div>
              <div className="library-footer">
                <span className="tiny-icon">
                  <Plus size={14} />
                </span>
                <span>点击零件，添加到装配空间</span>
              </div>
            </>
          ) : (
            <>
              <div className="tree-root">
                <ChevronDown size={14} />
                <Layers3 size={15} />
                <strong>{project.name}</strong>
              </div>
              <div className="tree-list">
                {project.parts.map((p) => {
                  const Icon = kindIcon(p.kind);
                  return (
                    <div
                      key={p.id}
                      className={`tree-row ${selectedId === p.id ? "selected" : ""}`}
                    >
                      <button
                        className="tree-select"
                        onClick={() => setSelectedId(p.id)}
                      >
                        <Icon size={15} style={{ color: p.color }} />
                        <span>{p.name}</span>
                      </button>
                      <button
                        title={p.fixed ? "解锁零件" : "固定零件"}
                        onClick={() => updatePart({ ...p, fixed: !p.fixed })}
                      >
                        {p.fixed ? (
                          <LockKeyhole size={13} />
                        ) : (
                          <UnlockKeyhole size={13} />
                        )}
                      </button>
                      <button
                        title={p.visible ? "隐藏零件" : "显示零件"}
                        onClick={() =>
                          updatePart({ ...p, visible: !p.visible })
                        }
                      >
                        {p.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                      </button>
                    </div>
                  );
                })}
              </div>
              <div className="library-footer">
                <Layers3 size={14} /> {project.parts.length} 个零件 ·{" "}
                {project.wires.length} 根导线
              </div>
            </>
          )}
        </aside>
        <section className="center-panel">
          <div className="viewport-toolbar">
            <div className="tool-group">
              {(
                [
                  { id: "select", label: "选择 (V)", Icon: MousePointer2 },
                  { id: "move", label: "移动 (G)", Icon: Move },
                  { id: "rotate", label: "旋转 (R)", Icon: RotateCw },
                  { id: "wire", label: "连接导线", Icon: Cable },
                ] as const
              ).map(({ id, label, Icon }) => (
                <button
                  key={id}
                  title={label}
                  className={tool === id ? "active" : ""}
                  onClick={() => {
                    setTool(id);
                    if (id === "wire") setPanelTab("circuit");
                  }}
                >
                  <Icon size={17} />
                </button>
              ))}
            </div>
            <i />
            <button
              title="撤销 (Ctrl+Z)"
              disabled={!undo.length}
              onClick={undoAction}
            >
              <Undo2 size={16} />
            </button>
            <button
              title="重做 (Ctrl+Shift+Z)"
              disabled={!redo.length}
              onClick={redoAction}
            >
              <Redo2 size={16} />
            </button>
            <div className="toolbar-spacer" />
            <button
              title="网格"
              className={grid ? "toggled" : ""}
              onClick={() => setGrid(!grid)}
            >
              <Grid3X3 size={16} />
            </button>
            <button
              title="透视内部结构"
              className={xray ? "toggled" : ""}
              onClick={() => setXray(!xray)}
            >
              <Scan size={16} />
            </button>
            <button
              title="爆炸视图（仅观察）"
              className={exploded ? "toggled" : ""}
              onClick={() => {
                setExploded(!exploded);
                setRunning(false);
              }}
            >
              <Layers3 size={16} />
            </button>
            <i />
            <select
              aria-label="视图"
              value={view}
              onChange={(e) => setView(e.target.value as typeof view)}
            >
              <option value="perspective">透视视图</option>
              <option value="top">顶部视图</option>
              <option value="front">正面视图</option>
            </select>
            <button
              title="适应全部模型"
              onClick={() => setResetKey((k) => k + 1)}
            >
              <Maximize size={16} />
            </button>
          </div>
          <div className="viewport-wrap">
            <Viewport
              parts={renderedParts}
              wires={project.wires}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onTransform={transform}
              tool={tool}
              view={view}
              showGrid={grid}
              xray={xray}
              exploded={exploded}
              running={running}
              pressedIds={pressedIds}
              poweredLampIds={circuit.poweredLampIds}
              collisionIds={collisionIds}
              resetKey={resetKey}
            />
            <div className="scene-label">
              <span className={`status-dot ${running ? "live" : ""}`} />
              {exploded
                ? "爆炸视图 · 仅观察"
                : running
                  ? "实时仿真运行中"
                  : "装配编辑模式"}
              <span className="scene-label-divider" />
              mm
            </div>
            <div className="view-corner">
              <span>Y</span>
              <div className="axis-widget">
                <i />
                <b />
                <em />
              </div>
              <small>X</small>
              <strong>Z</strong>
            </div>
            <div className="canvas-footer">
              <span>
                <MousePointer2 size={12} /> 拖动旋转 · 右键平移 · 滚轮缩放
              </span>
              <span>1 unit = 1 mm</span>
            </div>
            {running && (
              <div className="simulation-hud">
                <span className="live-dot" />
                <span>LIVE</span>
                <strong>{elapsed.toFixed(2)} s</strong>
                <span className="hud-divider" />
                <Zap size={13} />
                <span>{(circuit.current * 1000).toFixed(1)} mA</span>
                <button title="复位仿真" onClick={resetSimulation}>
                  <Square size={12} />
                </button>
              </div>
            )}
            {!project.parts.length && (
              <div className="empty-scene">
                <Box size={44} />
                <h2>从一个零件开始</h2>
                <p>从左侧零件库添加机械与电气元件</p>
                <button
                  className="primary"
                  onClick={() => {
                    const p = bayonetDemoProject();
                    commit(p);
                    setSelectedId(p.parts[2].id);
                  }}
                >
                  加载示例装配
                </button>
              </div>
            )}
          </div>
          <section
            className={`validation-panel ${bottomOpen ? "open" : "closed"}`}
          >
            <div className="validation-header">
              <button
                className={bottomTab === "checks" ? "active" : ""}
                onClick={() => {
                  setBottomTab("checks");
                  setBottomOpen(true);
                }}
              >
                <CheckCircle2 size={15} />
                {report ? "验证报告" : "实时检查"}
                <span className={`count ${errors ? "error-count" : ""}`}>
                  {issues.length}
                </span>
              </button>
              <button
                className={bottomTab === "wires" ? "active" : ""}
                onClick={() => {
                  setBottomTab("wires");
                  setBottomOpen(true);
                }}
              >
                <Cable size={15} />
                导线连接<span className="count">{project.wires.length}</span>
              </button>
              <div className="toolbar-spacer" />
              <span
                className={`check-summary ${errors ? "bad" : warnings ? "warn" : ""}`}
              >
                {errors
                  ? `${errors} 项干涉 / 错误`
                  : warnings
                    ? `${warnings} 项待确认`
                    : "检查通过"}
              </span>
              {report && (
                <button
                  title="导出验证报告"
                  onClick={() =>
                    download("verification-report.json", {
                      project,
                      generatedAt: report.at,
                      units: "mm, N, s, V, A",
                      method:
                        "复合体 SAT / 离散路径采样 / 线性弹簧 / 电阻网络；复杂网格仅保守预检，未进行制造认证",
                      issues: report.issues,
                    })
                  }
                >
                  <Download size={14} />
                </button>
              )}
              <button
                title={bottomOpen ? "收起检查" : "展开检查"}
                onClick={() => setBottomOpen(!bottomOpen)}
              >
                <ChevronDown
                  size={15}
                  style={{ transform: bottomOpen ? "none" : "rotate(180deg)" }}
                />
              </button>
            </div>
            {bottomOpen && (
              <div className="validation-body">
                {bottomTab === "checks" ? (
                  <>
                    {issues.length ? (
                      issues.map((issue) => (
                        <button
                          className="issue-row"
                          key={issue.id}
                          onClick={() => {
                            if (issue.partIds[0])
                              setSelectedId(issue.partIds[0]);
                          }}
                        >
                          {issue.severity === "pass" ? (
                            <CheckCircle2 className="green" size={15} />
                          ) : issue.severity === "warning" ? (
                            <AlertTriangle className="amber" size={15} />
                          ) : (
                            <XCircle className="red" size={15} />
                          )}
                          <span className="issue-title">{issue.title}</span>
                          <span className="issue-detail">{issue.detail}</span>
                          <span className={`issue-tag ${issue.severity}`}>
                            {issue.severity === "pass"
                              ? "通过"
                              : issue.severity === "warning"
                                ? "待确认"
                                : "需处理"}
                          </span>
                        </button>
                      ))
                    ) : (
                      <div className="empty-check">
                        添加零件后将在此检查装配尺寸与物理参数。
                      </div>
                    )}
                  </>
                ) : project.wires.length ? (
                  project.wires.map((w, index) => (
                    <div className="wire-row" key={w.id}>
                      <span className="wire-number">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <Cable size={15} />
                      <span>
                        {
                          project.parts.find((p) => p.id === w.from.partId)
                            ?.name
                        }{" "}
                        [{w.from.terminal === 0 ? "A/+" : "B/−"}]
                      </span>
                      <ArrowRight size={14} />
                      <span>
                        {project.parts.find((p) => p.id === w.to.partId)?.name}{" "}
                        [{w.to.terminal === 0 ? "A/+" : "B/−"}]
                      </span>
                      <button
                        title="移除导线"
                        onClick={() =>
                          commit({
                            ...project,
                            wires: project.wires.filter((x) => x.id !== w.id),
                          })
                        }
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="empty-check">
                    在右侧「电气连接」中选择两个端子并添加导线。
                  </div>
                )}
              </div>
            )}
          </section>
        </section>
        <aside className="right-panel">
          <div className="panel-heading">
            <SlidersHorizontal size={16} />
            <strong>零件属性</strong>
            <Settings2 size={15} />
          </div>
          {selected ? (
            <>
              <div className="selected-part">
                <div className="selected-part-icon">
                  <MiniPart kind={selected.kind} color={selected.color} />
                </div>
                <div>
                  <input
                    aria-label="零件名称"
                    maxLength={200}
                    value={selected.name}
                    onChange={(e) =>
                      setProject({
                        ...project,
                        parts: project.parts.map((p) =>
                          p.id === selected.id
                            ? { ...p, name: e.target.value }
                            : p,
                        ),
                      })
                    }
                  />
                  <span>
                    {selected.kind === "asset" ? "BLENDER 素材" : "参数化实体"}
                    <i />
                    mm
                  </span>
                </div>
                <button title="复制零件" onClick={duplicate}>
                  <Copy size={15} />
                </button>
              </div>
              <div className="property-tabs">
                <button
                  className={panelTab === "properties" ? "active" : ""}
                  onClick={() => setPanelTab("properties")}
                >
                  变换与物理
                </button>
                <button
                  className={panelTab === "circuit" ? "active" : ""}
                  onClick={() => setPanelTab("circuit")}
                >
                  电气连接
                </button>
              </div>
              <div className="properties-scroll">
                {panelTab === "properties" ? (
                  <>
                    {selected.kind.startsWith("bayonet-") && (
                      <div className="property-section bayonet-guide">
                        <div className="property-title">
                          <span>公母旋锁配合</span>
                          <small>两耳卡口 · 45°</small>
                        </div>
                        <p className="hint">
                          入口对准后沿轴向插入，再旋转45°。锁定后上拔会受槽肩阻挡，逆旋解锁才能退出。公母尺寸按已验证规格提供，公件零位外接宽深为16
                          mm，双耳角的实际旋转扫掠直径约16.21 mm。
                        </p>
                        {selected.kind === "bayonet-pin" && (
                          <div className="bayonet-actions">
                            <button onClick={() => bayonetAction("entry")}>
                              对准入口
                            </button>
                            <button onClick={() => bayonetAction("insert")}>
                              插入槽底
                            </button>
                            <button onClick={() => bayonetAction("lock")}>
                              旋转锁定 45°
                            </button>
                            <button onClick={() => bayonetAction("unlock")}>
                              逆旋解锁
                            </button>
                            <button onClick={() => bayonetAction("withdraw")}>
                              退出插销
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    <div className="property-section">
                      <div className="property-title">
                        <span>位置</span>
                        <small>mm</small>
                        <button
                          className={selected.fixed ? "fixed" : ""}
                          title="切换固定状态"
                          onClick={() =>
                            updatePart({ ...selected, fixed: !selected.fixed })
                          }
                        >
                          {selected.fixed ? (
                            <LockKeyhole size={13} />
                          ) : (
                            <UnlockKeyhole size={13} />
                          )}
                        </button>
                      </div>
                      <div className="xyz-fields">
                        {["X", "Y", "Z"].map((a, i) => (
                          <label key={a}>
                            <span className={`axis-${a.toLowerCase()}`}>
                              {a}
                            </span>
                            <NumberField
                              label={`位置 ${a}`}
                              value={selected.position[i]}
                              step={moveStep}
                              disabled={selected.fixed || exploded}
                              onChange={(v) => {
                                const pos = [...selected.position] as Vec3;
                                pos[i] = v;
                                transform(selected.id, pos, selected.rotation);
                              }}
                            />
                          </label>
                        ))}
                      </div>
                      <div className="move-controls">
                        <div className="direction-pad">
                          <button
                            title="向上 Y+"
                            disabled={selected.fixed}
                            onClick={() => move(1, 1)}
                          >
                            <ArrowUp size={16} />
                          </button>
                          <button
                            title="向左 X−"
                            disabled={selected.fixed}
                            onClick={() => move(0, -1)}
                          >
                            <ArrowLeft size={16} />
                          </button>
                          <span>
                            <Move size={15} />
                          </span>
                          <button
                            title="向右 X+"
                            disabled={selected.fixed}
                            onClick={() => move(0, 1)}
                          >
                            <ArrowRight size={16} />
                          </button>
                          <button
                            title="向下 Y−"
                            disabled={selected.fixed}
                            onClick={() => move(1, -1)}
                          >
                            <ArrowDown size={16} />
                          </button>
                        </div>
                        <div className="depth-controls">
                          <button
                            disabled={selected.fixed}
                            onClick={() => move(2, -1)}
                          >
                            前移 <span>Z−</span>
                          </button>
                          <button
                            disabled={selected.fixed}
                            onClick={() => move(2, 1)}
                          >
                            后移 <span>Z+</span>
                          </button>
                        </div>
                        <label className="step-field">
                          移动步长
                          <NumberField
                            label="移动步长"
                            value={moveStep}
                            min={0.01}
                            max={100}
                            step={0.1}
                            onChange={setMoveStep}
                          />
                          <small>mm</small>
                        </label>
                      </div>
                      <div className="inline-hint">
                        <span className="green-dot" />
                        移动路径自动检测相邻实体干涉
                      </div>
                    </div>
                    <div className="property-section">
                      <div className="property-title">
                        <span>旋转</span>
                        <small>°</small>
                      </div>
                      <div className="xyz-fields">
                        {["X", "Y", "Z"].map((a, i) => (
                          <label key={a}>
                            <span className={`axis-${a.toLowerCase()}`}>
                              {a}
                            </span>
                            <NumberField
                              label={`旋转 ${a}`}
                              value={selected.rotation[i]}
                              step={rotateStep}
                              disabled={selected.fixed || exploded}
                              onChange={(v) => {
                                const rot = [...selected.rotation] as Vec3;
                                rot[i] = v;
                                transform(selected.id, selected.position, rot);
                              }}
                            />
                          </label>
                        ))}
                      </div>
                      <div className="rotation-controls">
                        {["X", "Y", "Z"].map((a, i) => (
                          <div key={a}>
                            <button
                              title={`绕 ${a} 轴反向旋转`}
                              disabled={selected.fixed}
                              onClick={() => rotate(i, -1)}
                            >
                              <RotateCcw size={12} />
                            </button>
                            <span>{a}</span>
                            <button
                              title={`绕 ${a} 轴正向旋转`}
                              disabled={selected.fixed}
                              onClick={() => rotate(i, 1)}
                            >
                              <RotateCw size={12} />
                            </button>
                          </div>
                        ))}
                      </div>
                      <label className="inline-setting">
                        角度步长
                        <select
                          aria-label="角度步长"
                          value={rotateStep}
                          onChange={(e) =>
                            setRotateStep(Number(e.target.value))
                          }
                        >
                          {[1, 5, 15, 45, 90].map((v) => (
                            <option key={v} value={v}>
                              {v}°
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="property-section">
                      <div className="property-title">
                        <span>
                          {selected.kind === "bayonet-pin"
                            ? "零位外接尺寸"
                            : "几何尺寸"}
                        </span>
                        <small>mm</small>
                      </div>
                      <div className="xyz-fields">
                        {["宽", "高", "深"].map((a, i) => (
                          <label key={a}>
                            <span>{a}</span>
                            <NumberField
                              label={`尺寸${a}`}
                              disabled={selected.kind.startsWith("bayonet-")}
                              value={selected.size[i]}
                              min={0.1}
                              max={1000}
                              step={0.1}
                              onChange={(v) => {
                                const size = [...selected.size] as Vec3;
                                size[i] = v;
                                if (
                                  ["pin", "sleeve"].includes(selected.kind) &&
                                  i !== 1
                                ) {
                                  size[0] = v;
                                  size[2] = v;
                                }
                                if (
                                  (i === 0 &&
                                    Number(selected.params.innerWidth ?? 0) >=
                                      v) ||
                                  (i === 2 &&
                                    Number(selected.params.innerDepth ?? 0) >=
                                      v)
                                ) {
                                  notify("外轮廓必须大于内部开孔。");
                                  return;
                                }
                                updatePart({ ...selected, size });
                              }}
                            />
                          </label>
                        ))}
                      </div>
                      {selected.kind === "asset" && (
                        <>
                          <p className="hint amber">
                            原始素材使用包围盒预检。榫槽与薄壁需回到原网格进一步检查。
                          </p>
                          {!selected.params.assetNode && (
                            <button
                              className="split-asset"
                              onClick={splitAsset}
                            >
                              <Layers3 size={14} />
                              拆分为独立零件
                            </button>
                          )}
                        </>
                      )}
                      {Object.entries(selected.params)
                        .filter(
                          ([key, val]) =>
                            typeof val === "number" &&
                            [
                              "innerWidth",
                              "innerDepth",
                              "holeDiameter",
                              "tolerance",
                            ].includes(key) &&
                            !(
                              selected.kind === "sleeve" &&
                              ["innerWidth", "innerDepth"].includes(key)
                            ),
                        )
                        .map(([key, val]) => (
                          <label className="parameter-row" key={key}>
                            <span>
                              {
                                {
                                  innerWidth: "内孔宽度",
                                  innerDepth: "内孔深度",
                                  holeDiameter: "内孔直径",
                                  tolerance: "尺寸公差 ±",
                                }[key]
                              }
                            </span>
                            <NumberField
                              label={key}
                              value={Number(val)}
                              min={key === "tolerance" ? 0 : 0.1}
                              max={500}
                              step={0.05}
                              onChange={(v) => updateParam(key, v)}
                            />
                            <small>mm</small>
                          </label>
                        ))}
                    </div>
                    <div className="property-section">
                      <div className="property-title">
                        <span>物理属性</span>
                        <span className="nominal-tag">名义参数</span>
                      </div>
                      {Object.entries(selected.params)
                        .filter(
                          ([key, val]) =>
                            typeof val === "number" &&
                            [
                              "stiffness",
                              "damping",
                              "mass",
                              "travel",
                              "trigger",
                              "voltage",
                              "resistance",
                              "freeLength",
                              "solidLength",
                            ].includes(key),
                        )
                        .map(([key, val]) => (
                          <label className="parameter-row" key={key}>
                            <span>
                              {
                                {
                                  stiffness: "弹簧刚度",
                                  damping: "阻尼系数",
                                  mass: "运动质量",
                                  travel: "最大行程",
                                  trigger: "触发行程",
                                  voltage: "电源电压",
                                  resistance: "电阻",
                                  freeLength: "自由长度",
                                  solidLength: "并圈高度",
                                }[key]
                              }
                            </span>
                            <NumberField
                              label={key}
                              value={Number(val)}
                              min={
                                ["damping", "trigger", "solidLength"].includes(
                                  key,
                                )
                                  ? 0
                                  : 0.001
                              }
                              max={key === "mass" ? 100 : 100000}
                              step={key === "mass" ? 0.01 : 0.1}
                              onChange={(v) => updateParam(key, v)}
                            />
                            <small>
                              {
                                {
                                  stiffness: "N/mm",
                                  damping: "N·s/m",
                                  mass: "kg",
                                  travel: "mm",
                                  trigger: "mm",
                                  voltage: "V",
                                  resistance: "Ω",
                                  freeLength: "mm",
                                  solidLength: "mm",
                                }[key]
                              }
                            </small>
                          </label>
                        ))}
                      <label className="inline-setting">
                        固定在当前位置
                        <button
                          className={`toggle ${selected.fixed ? "on" : ""}`}
                          aria-label="固定零件"
                          aria-pressed={selected.fixed}
                          onClick={() =>
                            updatePart({ ...selected, fixed: !selected.fixed })
                          }
                        >
                          <i />
                        </button>
                      </label>
                      {["button", "spring"].includes(selected.kind) && (
                        <div className="press-test">
                          <button
                            className={`press-button ${heldId === selected.id ? "pressed" : ""}`}
                            disabled={!running}
                            onPointerDown={(e) => {
                              e.currentTarget.setPointerCapture(e.pointerId);
                              setHeldId(selected.id);
                            }}
                            onPointerUp={() => setHeldId(null)}
                            onPointerCancel={() => setHeldId(null)}
                            onKeyDown={(e) => {
                              if (e.key === " " || e.key === "Enter")
                                setHeldId(selected.id);
                            }}
                            onKeyUp={() => setHeldId(null)}
                          >
                            <CircleDot size={16} />
                            {running
                              ? "按住施力，松开回弹"
                              : "开始仿真后测试按压"}
                          </button>
                          <div>
                            <span>
                              压缩{" "}
                              <b>
                                {(simState?.displacement ?? 0).toFixed(3)} mm
                              </b>
                            </span>
                            <span>
                              弹簧力{" "}
                              <b>{(simState?.force ?? 0).toFixed(2)} N</b>
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="property-section">
                      <div className="property-title">
                        <span>显示</span>
                      </div>
                      <label className="inline-setting">
                        零件颜色
                        <input
                          type="color"
                          aria-label="零件颜色"
                          value={selected.color}
                          onChange={(e) =>
                            updatePart({ ...selected, color: e.target.value })
                          }
                        />
                      </label>
                      <label className="inline-setting">
                        显示零件
                        <button
                          className={`toggle ${selected.visible ? "on" : ""}`}
                          aria-label="显示零件"
                          onClick={() =>
                            updatePart({
                              ...selected,
                              visible: !selected.visible,
                            })
                          }
                        >
                          <i />
                        </button>
                      </label>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="property-section">
                      <div className="property-title">
                        <span>连接导线</span>
                        <Cable size={15} />
                      </div>
                      <p className="hint">
                        选择两端接线端子，导线将跟随零件移动。按压开关在触发后闭合。
                      </p>
                      <label className="wire-select">
                        起点
                        <select
                          aria-label="导线起点"
                          value={wireFrom}
                          onChange={(e) => setWireFrom(e.target.value)}
                        >
                          <option value="">选择零件端子</option>
                          {electrical.flatMap((p) =>
                            [0, 1].map((t) => (
                              <option
                                key={`${p.id}:${t}`}
                                value={`${p.id}:${t}`}
                              >
                                {terminalLabel(p, t)}
                              </option>
                            )),
                          )}
                        </select>
                      </label>
                      <div className="wire-link">
                        <Link2 size={16} />
                      </div>
                      <label className="wire-select">
                        终点
                        <select
                          aria-label="导线终点"
                          value={wireTo}
                          onChange={(e) => setWireTo(e.target.value)}
                        >
                          <option value="">选择零件端子</option>
                          {electrical.flatMap((p) =>
                            [0, 1].map((t) => (
                              <option
                                key={`${p.id}:${t}`}
                                value={`${p.id}:${t}`}
                              >
                                {terminalLabel(p, t)}
                              </option>
                            )),
                          )}
                        </select>
                      </label>
                      <button className="primary full-width" onClick={addWire}>
                        <Plus size={14} />
                        添加导线
                      </button>
                    </div>
                    <div className="property-section">
                      <div className="property-title">
                        <span>电路状态</span>
                        <span
                          className={circuit.shortCircuit ? "red" : "green"}
                        >
                          {circuit.shortCircuit
                            ? "短路"
                            : circuit.poweredLampIds.length
                              ? "已通电"
                              : "断开"}
                        </span>
                      </div>
                      <div className="circuit-metrics">
                        <div>
                          <small>电源电压</small>
                          <strong>
                            {circuit.voltage.toFixed(1)}
                            <span>V</span>
                          </strong>
                        </div>
                        <div>
                          <small>回路电流</small>
                          <strong>
                            {(circuit.current * 1000).toFixed(1)}
                            <span>mA</span>
                          </strong>
                        </div>
                      </div>
                      <p className="hint">
                        灯按电阻负载计算；支持导线、常开触点和串并联电阻。当前模型不包含
                        LED 非线性与电源内阻。
                      </p>
                    </div>
                  </>
                )}
              </div>
              <div className="selected-footer">
                <button onClick={duplicate}>
                  <Copy size={14} />
                  复制
                </button>
                <button className="delete-button" onClick={removeSelected}>
                  <Trash2 size={14} />
                  删除零件
                </button>
              </div>
            </>
          ) : (
            <div className="no-selection">
              <MousePointer2 size={30} />
              <strong>选择一个零件</strong>
              <p>点击三维模型或装配树，查看尺寸、配合与物理参数。</p>
              <button onClick={() => setLeftTab("assembly")}>
                打开装配树 <ChevronRight size={14} />
              </button>
            </div>
          )}
        </aside>
      </main>
      <footer className="statusbar">
        <span>
          <span className="green-dot" />
          工作空间就绪
        </span>
        <i />
        <span>{project.parts.length} 个零件</span>
        <span>{project.wires.length} 根导线</span>
        <div className="toolbar-spacer" />
        <span>尺寸单位：毫米</span>
        <i />
        <span>离散碰撞检测 · 名义物理参数</span>
        <button onClick={() => setHelp(true)}>
          使用指南 <ChevronRight size={12} />
        </button>
      </footer>
      {toast && (
        <div className="toast" role="status">
          <CircleDot size={17} />
          <span>{toast}</span>
          <button onClick={() => setToast("")}>
            <X size={15} />
          </button>
        </div>
      )}
      {help && (
        <div className="modal-backdrop" onClick={() => setHelp(false)}>
          <div className="help-modal" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setHelp(false)}>
              <X size={20} />
            </button>
            <span className="eyebrow">MECHANICAL STUDIO</span>
            <h2>让每一次装配，有据可依。</h2>
            <p>在毫米尺度上组合、检查和测试你的机构。</p>
            <ol>
              <li>
                <strong>构建装配</strong>
                <span>
                  点击左侧零件添加，或从「原始素材」载入现有手柄。装配树支持选择、隐藏与固定。
                </span>
              </li>
              <li>
                <strong>验证配合</strong>
                <span>
                  选中方榫后点击右侧向下按钮，插入方孔。逐步移动、旋转都会检查路径干涉。尺寸修改的结果显示在实时检查中。
                </span>
              </li>
              <li>
                <strong>测试功能</strong>
                <span>
                  开始仿真，选中按压开关并按住「施力」。弹簧压缩到触发点后接通回路，指示灯点亮；松手后回弹断电。
                </span>
              </li>
              <li>
                <strong>保存与复核</strong>
                <span>
                  运行验证会测试按压回弹和电路闭合。导出项目或验证报告，可在下次继续。新建或导入均可撤销。
                </span>
              </li>
            </ol>
            <div className="model-note">
              <AlertTriangle size={18} />
              <p>
                这是装配与功能验证工具。碰撞使用复合实体与离散路径采样，原始网格仅做保守预检；不包含有限元、摩擦变形或制造认证。弹簧参数和打印公差必须通过实物校正。
              </p>
            </div>
            <button className="primary" onClick={() => setHelp(false)}>
              开始装配 <ArrowRight size={15} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
