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
import ComponentImportDialog from "./components/ComponentImportDialog";
import ComponentInspector from "./components/ComponentInspector";
import RepositoryBrowser from "./components/RepositoryBrowser";
import AssemblyTree from "./components/AssemblyTree";
import MechanismEditor from "./components/MechanismEditor";
import MechanismControls from "./components/MechanismControls";
import PressBench from "./components/PressBench";
import type { MechanismTransformRequest } from "./components/MechanismControls";
import {
  mechanismScene,
  mechanismIssues,
  validateMechanismProject,
  stepMechanisms,
  moveMechanism,
  transformMechanismFrame,
  partMechanism,
  validateMechanismUpdate,
} from "./mechanisms";
import { createRepositoryParts } from "./repository";
import { projectSourceEvidence, withSourceEvidence } from "./projectEvidence";
import { validateEvidenceState } from "./assemblyEvidence";
import type { AssemblyEvidenceResult } from "./assemblyEvidence";
import {
  componentTypeLabel,
  componentPartIssues,
  createPartFromComponent,
  MAX_PROJECT_JSON_BYTES,
} from "./componentRegistry";
import {
  loadSavedProject,
  saveProject,
  loadUserComponents,
  saveUserComponents,
} from "./storage";
import { dispatchWorkbenchCommand } from "./mcp/workbench";
import type { WorkbenchRequest } from "./mcp/workbench";
import {
  registerDesktopBridge,
  getMcpStatus,
  setMcpEnabled,
  isDesktop,
} from "./mcp/bridge";
import type { McpStatus } from "./mcp/bridge";
import {
  definitions,
  bayonetDemoProject,
  makePart,
  newId,
  parseProject,
} from "./catalog";
import { validateMotion, solveCircuit, stepSpring } from "./engine/physics";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import { BAYONET_POSES } from "./engine/bayonet";
import type {
  AssetEntry,
  AssetNode,
  Mechanism,
  ComponentDefinition,
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
async function download(name: string, data: unknown): Promise<boolean> {
  try {
    const content = JSON.stringify(data, null, 2);
    if (isDesktop()) {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<boolean>("save_export", { filename: name, content });
    }
    const url = URL.createObjectURL(
      new Blob([content], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch (error) {
    window.dispatchEvent(
      new CustomEvent("workbench-notification", {
        detail: `保存失败：${(error as Error).message}`,
      }),
    );
    return false;
  }
}
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
  const [project, setProjectState] = useState<Project>(initialProject);
  const projectRef = useRef(project);
  const revisionRef = useRef(0);
  const setProject = useCallback((next: Project) => {
    projectRef.current = next;
    revisionRef.current += 1;
    setProjectState(next);
  }, []);
  const [userComponents, setUserComponents] = useState<ComponentDefinition[]>(
    [],
  );
  const userComponentsRef = useRef(userComponents);
  userComponentsRef.current = userComponents;
  const [storageReady, setStorageReady] = useState(false);
  const readyRef = useRef(false);
  const [libraryReady, setLibraryReady] = useState(false);
  const libraryReadyRef = useRef(false);
  const [saveError, setSaveError] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [editingComponent, setEditingComponent] = useState<
    ComponentDefinition | undefined
  >();
  const [mcpOpen, setMcpOpen] = useState(false);
  const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null);
  const rendererErrors = useRef<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(
    () =>
      project.parts.find((p) => p.kind === "bayonet-pin" || p.kind === "tenon")
        ?.id ??
      project.parts[0]?.id ??
      null,
  );
  const [selectedMechanismId, setSelectedMechanismId] = useState<string | null>(
    null,
  );
  const [mechanismEditorOpen, setMechanismEditorOpen] = useState(false);
  const [editingMechanism, setEditingMechanism] = useState<
    Mechanism | undefined
  >();
  const [mechanismStates, setMechanismStates] = useState<
    Record<string, SpringState>
  >({});
  const mechanismSimulationRef = useRef<Record<string, SpringState>>({});
  const [heldMechanismId, setHeldMechanismId] = useState<string | null>(null);
  const heldMechanismRef = useRef<string | null>(null);
  heldMechanismRef.current = heldMechanismId;
  const selectedMechanism = project.mechanisms?.find(
    (m) => m.id === selectedMechanismId,
  );
  const selectPart = useCallback((id: string | null) => {
    setSelectedMechanismId(null);
    setSelectedId(id);
  }, []);
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
  const [inspectInterior, setInspectInterior] = useState(false);
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
  const [verifying, setVerifying] = useState(false);
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
  const [sourceEvidence, setSourceEvidence] = useState<{
    project: Project;
    result: AssemblyEvidenceResult | null;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void projectSourceEvidence(project).then((result) => {
      if (!cancelled) setSourceEvidence({ project, result });
    });
    return () => { cancelled = true; };
  }, [project]);
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
    mechanismSimulationRef.current = {};
    setMechanismStates({});
    setHeldMechanismId(null);
    simulationTimeRef.current = 0;
  }, []);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 5500);
      return () => clearTimeout(t);
    }
  }, [toast]);
  useEffect(() => {
    let active = true;
    if (!readyRef.current)
      loadSavedProject()
        .then((saved) => {
          if (!active) return;
          readyRef.current = true;
          if (saved) {
            setProject(saved);
            setSelectedId(
              saved.parts.find(
                (p) => p.kind === "bayonet-pin" || p.kind === "tenon",
              )?.id ??
                saved.parts[0]?.id ??
                null,
            );
          }
          setStorageReady(true);
          readyRef.current = true;
        })
        .catch((error) => {
          if (active) {
            readyRef.current = true;
            setSaveError(error.message);
            notify(error.message);
          }
        });
    if (!libraryReadyRef.current)
      loadUserComponents()
        .then((list) => {
          if (active) {
            userComponentsRef.current = list;
            setUserComponents(list);
            setLibraryReady(true);
            libraryReadyRef.current = true;
          }
        })
        .catch((error) => {
          if (active) notify(error.message);
        });
    return () => {
      active = false;
    };
  }, [setProject, notify]);
  useEffect(() => {
    if (!storageReady) return;
    const timer = setTimeout(() => {
      saveProject(project)
        .then(() => setSaveError(""))
        .catch((error) => {
          setSaveError(error.message);
          notify(error.message);
        });
    }, 100);
    return () => clearTimeout(timer);
  }, [project, storageReady, notify]);
  useEffect(() => {
    setReport(null);
  }, [project]);
  useEffect(() => {
    if (!libraryReady) return;
    saveUserComponents(userComponents).catch((error) => notify(error.message));
  }, [userComponents, libraryReady, notify]);
  useEffect(() => {
    const notification = (event: Event) =>
      notify((event as CustomEvent<string>).detail);
    const error = (event: ErrorEvent) => {
      rendererErrors.current = [
        ...rendererErrors.current.slice(-9),
        event.message,
      ];
    };
    window.addEventListener("workbench-notification", notification);
    window.addEventListener("error", error);
    return () => {
      window.removeEventListener("workbench-notification", notification);
      window.removeEventListener("error", error);
    };
  }, [notify]);
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
      if (!readyRef.current) {
        notify("本地工程正在恢复，请稍后操作。");
        return;
      }
      if (next.parts.length > 500 || next.wires.length > 2000) {
        notify("单个工程最多500个零件和2000根导线，请拆成多个工程。");
        return;
      }
      setUndo((prev) => [...prev.slice(-59), projectRef.current]);
      setRedo([]);
      setProject(next);
      resetSimulation();
    },
    [resetSimulation, setProject, notify],
  );
  const assetsRef = useRef(assets);
  assetsRef.current = assets;
  const assetHealth = useRef<Promise<string> | null>(null);
  const handlerRef = useRef<(request: WorkbenchRequest) => Promise<unknown>>(
    async () => {
      throw Error("工作台正在初始化");
    },
  );
  handlerRef.current = async (request) => {
    if (!readyRef.current && request.method !== "get_runtime_status")
      throw Error("工作台尚未恢复完成，请稍后重试。");
    const originalRevision = revisionRef.current;
    const requestProject = projectRef.current;
    const canvas = document.querySelector<HTMLCanvasElement>("canvas");
    if (
      request.method === "get_runtime_status" &&
      !assetHealth.current &&
      assetsRef.current[0]
    )
      assetHealth.current = fetch(assetsRef.current[0].url)
        .then((r) => {
          if (!r.ok) throw Error("素材加载失败");
          return r.arrayBuffer();
        })
        .then((b) => new TextDecoder().decode(b.slice(0, 4)))
        .catch(() => "");
    const modelMagic =
      request.method === "get_runtime_status"
        ? await (assetHealth.current ?? Promise.resolve(""))
        : undefined;
    const evidence = ["validate_project", "get_runtime_status", "press_mechanism"].includes(request.method)
      ? await projectSourceEvidence(requestProject)
      : null;
    if (revisionRef.current !== originalRevision)
      throw Error(`项目已变化：当前revision=${revisionRef.current}，请重新获取后重试。`);
    // Animation may advance during static evidence loading without changing the project revision.
    const requestStates = mechanismSimulationRef.current;
    const currentEvidence = evidence ? validateEvidenceState(evidence, requestStates) : null;
    const webglContext = canvas?.getContext("webgl2");
    const runtime = {
      ready: readyRef.current && libraryReadyRef.current,
      modelMagic,
      glbAssetAvailable: modelMagic === "glTF",
      isolated: !("require" in window) && !("process" in window),
      webgl: Boolean(webglContext && !webglContext.isContextLost()),
      canvasSize: [canvas?.width ?? 0, canvas?.height ?? 0],
      catalogCount: assetsRef.current.length,
      documentTitle: document.title,
      rendererErrors: rendererErrors.current,
      desktop: isDesktop(),
      mechanismStates: requestStates,
      sourceEvidence: currentEvidence ? {
        status: currentEvidence.status,
        matched: currentEvidence.matched,
        scope: currentEvidence.scope,
      } : null,
      mechanismContacts: mechanismScene(
        requestProject,
        requestStates,
      ).contacts,
      renderedPositions: JSON.parse(
        document
          .querySelector('[data-testid="viewport"]')
          ?.getAttribute("data-rendered-positions") ?? "{}",
      ),
      renderedDeformations: JSON.parse(
        document
          .querySelector('[data-testid="viewport"]')
          ?.getAttribute("data-rendered-deformations") ?? "{}",
      ),
      loadedAssetCount: Number(
        document
          .querySelector('[data-testid="viewport"]')
          ?.getAttribute("data-loaded-assets") ?? 0,
      ),
      deformedPartCount: Number(
        document
          .querySelector('[data-testid="viewport"]')
          ?.getAttribute("data-deformed-parts") ?? 0,
      ),
    };
    const outcome = await dispatchWorkbenchCommand(
      requestProject,
      request,
      {
        revision: originalRevision,
        components: userComponentsRef.current,
        assets: assetsRef.current,
        runtime,
        mechanismStates: requestStates,
        sourceEvidence: currentEvidence,
      },
    );
    if (revisionRef.current !== originalRevision)
      throw Error(
        `项目已变化：当前revision=${revisionRef.current}，请重新获取后重试。`,
      );
    if (outcome.project) {
      const before = projectRef.current;
      setUndo((prev) => [...prev.slice(-59), before]);
      setRedo([]);
      setProject(outcome.project);
      resetSimulation();
    }
    if (outcome.component) {
      if (!libraryReadyRef.current) throw Error("组件库未成功恢复，无法导入。");
      const list = [...userComponentsRef.current, outcome.component];
      userComponentsRef.current = list;
      setUserComponents(list);
      revisionRef.current += 1;
    }
    if (outcome.mechanismStates) {
      mechanismSimulationRef.current = outcome.mechanismStates;
      setMechanismStates(outcome.mechanismStates);
      if (outcome.actuation) {
        setSelectedMechanismId(outcome.actuation.mechanismId);
        setHeldMechanismId(
          outcome.actuation.held ? outcome.actuation.mechanismId : null,
        );
      }
      if (
        request.method === "press_mechanism" &&
        typeof request.args?.duration === "number"
      ) {
        simulationTimeRef.current += request.args.duration;
        setElapsed(simulationTimeRef.current);
      }
      setRunning(true);
      setExploded(false);
      revisionRef.current += 1;
    }
    if (outcome.project || outcome.component || outcome.mechanismStates)
      notify(`MCP 已执行 ${request.method}`);
    return outcome.result;
  };
  useEffect(() => {
    let closed = false;
    let unlisten: (() => void) | undefined;
    registerDesktopBridge((request) => handlerRef.current(request))
      .then((stop) => {
        if (closed) stop();
        else unlisten = stop;
      })
      .catch((error) => notify(`MCP 连接失败：${error.message}`));
    return () => {
      closed = true;
      unlisten?.();
    };
  }, [notify]);
  async function openMcp() {
    setMcpOpen(true);
    try {
      setMcpStatus(await getMcpStatus());
    } catch (error) {
      notify((error as Error).message);
    }
  }
  function addCustomComponent(def: ComponentDefinition) {
    const edge = Math.max(
      0,
      ...projectRef.current.parts.map((p) => p.position[0] + p.size[0] / 2),
    );
    const part = createPartFromComponent(def, [
      edge + def.size[0] / 2 + 8,
      def.size[1] / 2,
      0,
    ]);
    const existing = projectRef.current.models?.find(
      (m) => m.id === def.model.id,
    );
    if (existing && existing.sha256 !== def.model.sha256) {
      notify("模型ID冲突，请重新导入该组件。");
      return;
    }
    const next = {
      ...projectRef.current,
      parts: [...projectRef.current.parts, part],
      models: existing
        ? projectRef.current.models
        : [...(projectRef.current.models ?? []), def.model],
    };
    try {
      commit(parseProject(JSON.stringify(next)));
      setSelectedId(part.id);
      setResetKey((k) => k + 1);
    } catch (error) {
      notify((error as Error).message);
    }
  }
  async function saveCustomComponent(def: ComponentDefinition) {
    if (!libraryReady) {
      notify("组件库未成功恢复，暂不能覆盖保存；请先检查本地存储。");
      return;
    }
    const snapshot = userComponentsRef.current;
    const list = [...snapshot.filter((c) => c.id !== def.id), def];
    try {
      await saveUserComponents(list);
      if (userComponentsRef.current !== snapshot) {
        await saveUserComponents(userComponentsRef.current);
        notify("组件库刚刚被其他操作更新，请再次保存当前定义。");
        return;
      }
      userComponentsRef.current = list;
      setUserComponents(list);
      revisionRef.current += 1;
      setImportOpen(false);
      setCategory("custom");
      setEditingComponent(undefined);
      if (!editingComponent) addCustomComponent(def);
      notify(
        def.interaction.status === "configured"
          ? "组件类型和交互参数已保存。"
          : "组件已保存为预览，请补齐交互参数后验证。",
      );
    } catch (error) {
      notify((error as Error).message);
    }
  }
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
  const exportProject = useCallback(async () => {
    if (await download(`${project.name}.mechanical.json`, project))
      notify("项目已导出，包含模型、类型、交互参数与导线。");
  }, [project, notify]);
  const removeSelected = useCallback(() => {
    if (!selected) return;
    if (partMechanism(project, selected.id)) {
      notify("请先编辑功能组件移除该成员，或解除组件，再删除零件。");
      return;
    }
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
      if (!readyRef.current) return;
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
    const release = () => {
      setHeldId(null);
      setHeldMechanismId(null);
    };
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
      .filter(
        (p) =>
          (p.kind === "spring" || p.kind === "button") &&
          !partMechanism(project, p.id),
      )
      .forEach((p) => {
        states[p.id] ??= { displacement: 0, velocity: 0, force: 0 };
      });
    let time = simulationTimeRef.current;
    const tick = (now: number) => {
      const dt = Math.max(0.000001, Math.min((now - previous) / 1000, 0.04));
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
      const stepped = stepMechanisms(
        project,
        mechanismSimulationRef.current,
        dt,
        heldMechanismRef.current ? [heldMechanismRef.current] : [],
      );
      mechanismSimulationRef.current = stepped.states;
      if (stepped.issues.some((issue) => issue.severity === "error")) {
        setRunning(false);
        setHeldMechanismId(null);
        notify(
          stepped.issues.find((issue) => issue.severity === "error")!.detail,
        );
        setMechanismStates({ ...stepped.states });
        return;
      }
      simulationRef.current = states;
      simulationTimeRef.current = time;
      if (now - lastPaint > 30) {
        setSpringStates({ ...states });
        if (project.mechanisms?.length)
          setMechanismStates({ ...mechanismSimulationRef.current });
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
  const functionalScene = useMemo(
    () => mechanismScene(project, mechanismStates),
    [project, mechanismStates],
  );
  const contactOwner =
    selectedMechanism ??
    (selected ? partMechanism(project, selected.id) : undefined);
  const selectedContact = contactOwner
    ? functionalScene.contacts[contactOwner.id]
    : undefined;
  const renderedParts = useMemo(
    () =>
      functionalScene.renderParts.map((p) =>
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
    [functionalScene.renderParts, springStates],
  );
  const pressedIds = useMemo(
    () => [
      ...new Set([
        ...functionalScene.pressedIds,
        ...renderedParts
          .filter(
            (p) =>
              p.kind === "button" &&
              !partMechanism(project, p.id) &&
              Number(p.params.compression ?? 0) >=
                Number(p.params.trigger ?? 0.6),
          )
          .map((p) => p.id),
      ]),
    ],
    [renderedParts, functionalScene.pressedIds, project],
  );
  const validation = useMemo(
    () => validateMechanismProject(project, mechanismStates),
    [project, mechanismStates],
  );
  const circuit = useMemo(
    () => solveCircuit(functionalScene.circuitParts, project.wires, pressedIds),
    [functionalScene.circuitParts, project.wires, pressedIds],
  );
  const liveSourceEvidence = useMemo(
    () => sourceEvidence?.project === project && sourceEvidence.result
      ? validateEvidenceState(sourceEvidence.result, mechanismStates)
      : null,
    [sourceEvidence, project, mechanismStates],
  );
  const liveIssues = useMemo(
    () => withSourceEvidence([
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
    ], liveSourceEvidence),
    [validation, circuit, project.wires.length, liveSourceEvidence],
  );
  const issues = report?.issues ?? liveIssues;
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const collisionIds = validation.collisionPairs.flat();
  function updatePart(next: Part) {
    if (
      !["battery", "button", "lamp", "resistor"].includes(next.kind) &&
      !project.mechanisms?.some(
        (m) => m.kind === "press" && m.switchPartId === next.id,
      ) &&
      project.wires.some(
        (w) => w.from.partId === next.id || w.to.partId === next.id,
      )
    ) {
      notify("请先移除该零件的电气连线，再改为非电气类型。");
      return;
    }
    commit({
      ...project,
      parts: project.parts.map((p) => (p.id === next.id ? next : p)),
    });
  }
  function transform(id: string, position: Vec3, rotation: Vec3) {
    const part = project.parts.find((p) => p.id === id);
    if (!part) return;
    const owner = partMechanism(project, id);
    if (owner) {
      setSelectedMechanismId(owner.id);
      notify("请使用功能组件的整体定位或活动组控制，成员相对关系会一起保持。");
      return;
    }
    if (exploded) {
      notify("请先退出爆炸视图，再进行装配操作。");
      return;
    }
    const next = {
      ...part,
      position: position.map(n) as Vec3,
      rotation: rotation.map(n) as Vec3,
    };
    const check = validateMotion(
      mechanismScene(project).physicsParts,
      id,
      next,
    );
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
  function addRepositoryNodes(asset: AssetEntry, nodes: AssetNode[]) {
    if (!nodes.length) return;
    const current = projectRef.current;
    const edge = Math.max(
      0,
      ...current.parts.map((p) => p.position[0] + p.size[0] / 2),
    );
    const minimum = [0, 1, 2].map((axis) =>
      Math.min(...nodes.map((node) => node.center[axis] - node.size[axis] / 2)),
    ) as Vec3;
    const maximum = [0, 1, 2].map((axis) =>
      Math.max(...nodes.map((node) => node.center[axis] + node.size[axis] / 2)),
    ) as Vec3;
    const offset: Vec3 = [
      edge + 8 - minimum[0],
      -minimum[1],
      -(minimum[2] + maximum[2]) / 2,
    ];
    const parts = createRepositoryParts(asset, nodes, offset);
    commit({ ...current, parts: [...current.parts, ...parts] });
    setSelectedId(parts[0].id);
    setResetKey((key) => key + 1);
    notify(
      parts.length > 1
        ? `已添加 ${parts.length} 个独立子零件，保留组内相对位置。`
        : `已添加独立零件：${parts[0].name}`,
    );
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
    if (!selected || selected.kind !== "bayonet-pin" || selected.interaction)
      return;
    const sockets = project.parts
      .filter((p) => p.kind === "bayonet-socket" && !p.interaction)
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
      notify(
        "已按原始坐标载入全部独立子零件；公母配合件按关系分组，可分别选择与编辑。",
      );
    } catch (err) {
      notify((err as Error).message);
    }
  }
  async function loadVerifiedController() {
    try {
      const response = await fetch("./models/puretv-verified-assembly.json");
      if (!response.ok) throw Error("pureTV 试验工程资源不可用。");
      const next = parseProject(await response.text());
      commit(next);
      setSelectedId(null);
      setSelectedMechanismId(next.mechanisms?.[0]?.id ?? null);
      setLeftTab("assembly");
      setInspectInterior(false);
      setXray(false);
      setView("perspective");
      setResetKey((key) => key + 1);
      notify("已载入 pureTV 九键手柄与指示灯；开始仿真后可在按键试验台按压，内部检视保留所有碰撞检查。");
    } catch (error) {
      notify((error as Error).message);
    }
  }
  function splitAsset() {
    if (!selected) return;
    if (partMechanism(project, selected.id)) {
      notify("请先解除该功能组件，再拆分其成员。");
      return;
    }
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
    const sourceParts = createRepositoryParts(asset, asset.nodes);
    const parts: Part[] = sourceParts.map((part, index) => {
      const node = asset.nodes![index];
      const position = new Vector3(...node.center)
        .sub(new Vector3(...asset.center))
        .applyMatrix4(matrix)
        .toArray() as Vec3;
      return {
        ...part,
        position,
        rotation: [...selected.rotation],
        size: node.size.map((v, i) => Math.max(v * scale[i], 0.001)) as Vec3,
        visible: selected.visible,
        fixed: selected.fixed,
        ...(selected.material
          ? { material: { ...selected.material }, color: selected.color }
          : {}),
        ...(part.interaction
          ? {
              interaction: {
                ...part.interaction,
                proxySize: part.interaction.proxySize.map(
                  (v, i) => v * scale[i],
                ) as Vec3,
              },
            }
          : {}),
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
  function composeMechanism(initial?: Mechanism) {
    if (!initial && project.parts.length < 2) {
      notify("先添加至少两个子零件，再组合成功能组件。");
      return;
    }
    setEditingMechanism(initial);
    setMechanismEditorOpen(true);
  }
  function saveMechanism(mechanism: Mechanism) {
    const current = projectRef.current;
    mechanism = validateMechanismUpdate(current, mechanism);
    const next = parseProject(
      JSON.stringify({
        ...current,
        mechanisms: [
          ...(current.mechanisms ?? []).filter((m) => m.id !== mechanism.id),
          mechanism,
        ],
      }),
    );
    commit(next);
    setSelectedMechanismId(mechanism.id);
    setSelectedId(null);
    setLeftTab("assembly");
    setMechanismEditorOpen(false);
    setEditingMechanism(undefined);
    notify(
      mechanism.status === "configured"
        ? "功能组件已创建，可按压或使用轴向配合控制。"
        : "功能组件已保存为预览，请补齐参数后仿真。",
    );
  }
  function detachMechanism(id: string) {
    const member = project.mechanisms?.find((m) => m.id === id)?.switchPartId;
    if (
      member &&
      project.wires.some(
        (w) => w.from.partId === member || w.to.partId === member,
      ) &&
      !["button", "battery", "lamp", "resistor"].includes(
        project.parts.find((p) => p.id === member)!.kind,
      )
    ) {
      notify("先移除该组件开关的导线，再解除功能绑定。");
      return;
    }
    commit({
      ...project,
      mechanisms: (project.mechanisms ?? []).filter((m) => m.id !== id),
    });
    setSelectedMechanismId(null);
    notify("已解除功能组件，原子零件和外观仍保留。");
  }
  function transformCompound(request: MechanismTransformRequest) {
    if (exploded) {
      notify("请先退出爆炸视图。");
      return;
    }
    const current = projectRef.current;
    const result =
      request.kind === "frame"
        ? transformMechanismFrame(current, request.mechanismId, request.frame)
        : moveMechanism(current, request.mechanismId, {
            distance: request.distance,
            angle: request.angle,
          });
    if (!result.allowed) {
      const message =
        result.issues.find((i) => i.severity === "error")?.detail ??
        "组件动作被拒绝。";
      notify(message);
      throw Error(message);
    }
    commit(result.project);
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
  async function verify() {
    if (verifying) return;
    const originalRevision = revisionRef.current;
    setVerifying(true);
    const yieldForInput = async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (revisionRef.current !== originalRevision)
        throw Error("验证期间工程已修改，请重新运行验证。");
    };
    try {
      await yieldForInput();
      const all = [...liveIssues];
      const configurationIssues = mechanismIssues(project);
      const triggeredSwitches = new Set<string>();
      for (const p of project.parts.filter(
        (p) =>
          (p.kind === "spring" || p.kind === "button") &&
          !partMechanism(project, p.id) &&
          !componentPartIssues(p).some((i) => i.severity === "error"),
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
        if (p.kind === "button" && passed) triggeredSwitches.add(p.id);
        all.push({
          id: `cycle-${p.id}`,
          category: "physics",
          severity: passed ? "pass" : "error",
          title: `${p.name} · 按压与回弹`,
          detail: `5 s 数值试验；最大压缩 ${peak.toFixed(3)} mm，释放后残余 ${state.displacement.toFixed(4)} mm。采用名义刚度及阻尼，尚需实测。`,
          partIds: [p.id],
        });
      }
      for (const mechanism of project.mechanisms ?? []) {
        if (
          mechanism.kind !== "press" ||
          mechanism.status !== "configured" ||
          configurationIssues.some(
            (i) =>
              i.severity === "error" &&
              i.partIds.some((id) => mechanism.partIds.includes(id)),
          )
        )
          continue;
        let states: Record<string, SpringState> = {};
        let peak = 0;
        let didTrigger = !mechanism.switchPartId;
        let blocked = false;
        for (let i = 0; i < 600; i++) {
          if (i % 30 === 0) await yieldForInput();
          const trial = stepMechanisms(
            project,
            states,
            1 / 120,
            i < 120 ? [mechanism.id] : [],
          );
          states = trial.states;
          if (
            mechanism.switchPartId &&
            mechanismScene(project, states).pressedIds.includes(
              mechanism.switchPartId,
            )
          )
            didTrigger = true;
          peak = Math.max(peak, states[mechanism.id]?.displacement ?? 0);
          if (trial.issues.some((i) => i.severity === "error")) {
            blocked = true;
            break;
          }
        }
        const final = states[mechanism.id] ?? {
          displacement: 0,
          velocity: 0,
          force: 0,
        };
        const passed =
          !blocked &&
          peak > 0 &&
          didTrigger &&
          Math.abs(final.displacement) < 0.01 &&
          Math.abs(final.velocity) < 0.01;
        if (passed && mechanism.switchPartId)
          triggeredSwitches.add(mechanism.switchPartId);
        all.push({
          id: `mechanism-cycle-${mechanism.id}`,
          category: "physics",
          severity: passed ? "pass" : "error",
          title: `${mechanism.name} · 组件按压与回弹`,
          detail: `活动子件随声明轴运动；最大压缩 ${peak.toFixed(3)} mm，释放后残余 ${final.displacement.toFixed(4)} mm。${mechanism.switchPartId ? (didTrigger ? "撞针已触及目标并触发开关。" : "撞针未到达有效触发点。") : ""}${blocked ? "行程中发生代理干涉。" : "仍需实物校正刚度、阻尼及接触。"}`,
          partIds: mechanism.partIds,
        });
      }
      const switches = [...triggeredSwitches];
      if (switches.length) {
        const closed = solveCircuit(
          functionalScene.circuitParts,
          project.wires,
          switches,
        );
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
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    } finally {
      setVerifying(false);
    }
  }
  const electrical = functionalScene.circuitParts.filter((p) =>
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
            className="mcp-header-button"
            onClick={() => void openMcp()}
            title="MCP 接入配置"
          >
            <Link2 size={15} />
            MCP
          </button>
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
          <button className="verify-button" onClick={() => void verify()} disabled={verifying}>
            <CheckCircle2 size={15} />
            {verifying ? "正在验证…" : "运行验证"}
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
            if (file.size > MAX_PROJECT_JSON_BYTES)
              throw Error("含模型项目文件不能超过 96 MiB。");
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
          <button
            className="compose-mechanism-button"
            onClick={() => composeMechanism()}
          >
            <Link2 size={14} />
            组成功能组件<small>按压 / 榫卯</small>
          </button>
          <button
            className="puretv-demo-button"
            onClick={() => void loadVerifiedController()}
          >
            <CircleDot size={15} />
            pureTV 九键试验<small>手柄 / 指示灯</small>
          </button>
          {leftTab === "library" ? (
            <>
              <button
                className="upload-component-button"
                onClick={() => {
                  setEditingComponent(undefined);
                  setImportOpen(true);
                }}
              >
                <Upload size={15} />
                上传自定义组件<small>GLB / STL</small>
              </button>
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
                    ["custom", "我的组件"],
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
                      : category === "custom"
                        ? "我的组件与功能定义"
                        : "参数化标准件"}
                  </span>
                  <span>
                    {category === "repository"
                      ? assets.length
                      : category === "custom"
                        ? userComponents.length
                        : filtered.length}
                  </span>
                </div>
                {category !== "repository" && category !== "custom" && (
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
                    category !== "custom" &&
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
                        <em className="component-kind-label">
                          {componentTypeLabel(d.kind)}
                        </em>
                        <span>{d.subtitle}</span>
                      </button>
                    ))}
                </div>
                {category === "custom" && (
                  <div className="custom-library">
                    {userComponents.length === 0 ? (
                      <div className="empty-custom">
                        <Upload size={28} />
                        <strong>定义你的第一个组件</strong>
                        <p>
                          上传模型、选择功能类型，并提供该类型要求的交互参数。
                        </p>
                        <button onClick={() => setImportOpen(true)}>
                          上传 GLB / STL
                        </button>
                      </div>
                    ) : (
                      userComponents
                        .filter((c) => c.name.includes(search))
                        .map((c) => (
                          <div className="custom-component-card" key={c.id}>
                            <button
                              className="custom-component-add"
                              onClick={() => addCustomComponent(c)}
                            >
                              <Box size={22} />
                              <span>
                                <strong>{c.name}</strong>
                                <small>{componentTypeLabel(c.kind)}</small>
                                <em
                                  className={
                                    c.interaction.status === "configured"
                                      ? "configured"
                                      : "unconfigured"
                                  }
                                >
                                  {c.interaction.status === "configured"
                                    ? "代理参数已配置"
                                    : "仅预览 · 参数待补全"}
                                </em>
                              </span>
                              <Plus size={15} />
                            </button>
                            <div className="custom-card-footer">
                              <small>
                                {c.model.format.toUpperCase()} ·{" "}
                                {(c.model.bytes / 1024).toFixed(0)} KB
                              </small>
                              <button
                                title="编辑组件定义"
                                onClick={() => {
                                  setEditingComponent(c);
                                  setImportOpen(true);
                                }}
                              >
                                <Settings2 size={13} />
                                编辑定义
                              </button>
                              <button
                                title="移除库中组件"
                                onClick={() => {
                                  const list = userComponentsRef.current.filter(
                                    (x) => x.id !== c.id,
                                  );
                                  userComponentsRef.current = list;
                                  setUserComponents(list);
                                  revisionRef.current += 1;
                                }}
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          </div>
                        ))
                    )}
                  </div>
                )}
                {category === "repository" && (
                  <RepositoryBrowser
                    assets={assets}
                    search={search}
                    onAdd={addRepositoryNodes}
                    onLoadOriginal={loadOriginal}
                    error={assetError}
                  />
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
              <PressBench
                mechanisms={project.mechanisms ?? []}
                contacts={functionalScene.contacts}
                states={mechanismStates}
                poweredLampIds={circuit.poweredLampIds}
                heldId={heldMechanismId}
                disabled={!running || exploded}
                onPress={setHeldMechanismId}
                onRelease={() => setHeldMechanismId(null)}
                onSelect={(id) => {
                  setSelectedMechanismId(id);
                  setSelectedId(null);
                }}
              />
              <AssemblyTree
                parts={project.parts}
                selectedId={selectedId}
                onSelect={selectPart}
                mechanisms={project.mechanisms}
                selectedMechanismId={selectedMechanismId}
                onSelectMechanism={(id) => {
                  setSelectedMechanismId(id);
                  setSelectedId(null);
                }}
                onEditMechanism={(id) =>
                  composeMechanism(
                    project.mechanisms!.find((m) => m.id === id)!,
                  )
                }
                onUpdate={updatePart}
              />
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
            {project.parts.some((part) =>
              /^\.\/models\/housing-(top|bottom)\.glb$/.test(
                String(part.params.assetUrl ?? ""),
              ),
            ) && (
              <button
                title="内部检视：仅隐藏外壳，保留全部碰撞检查"
                aria-pressed={inspectInterior}
                className={inspectInterior ? "toggled" : ""}
                onClick={() => setInspectInterior(!inspectInterior)}
              >
                <Box size={16} /> 内部
              </button>
            )}
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
              models={project.models}
              parts={inspectInterior
                ? renderedParts.map((part) =>
                    /^\.\/models\/housing-(top|bottom)\.glb$/.test(
                      String(part.params.assetUrl ?? ""),
                    )
                      ? { ...part, visible: false }
                      : part,
                  )
                : renderedParts}
              wires={project.wires}
              selectedId={selectedId}
              onSelect={selectPart}
              deformations={functionalScene.deformations}
              trackedPartIds={project.mechanisms?.flatMap((m) => m.partIds)}
              contactMarkers={
                selectedContact && contactOwner
                  ? [
                      {
                        id: contactOwner.id,
                        striker: selectedContact.strikerWorld,
                        target: selectedContact.switchWorld,
                        contact: selectedContact.pressed,
                      },
                    ]
                  : []
              }
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
            {liveSourceEvidence && (
              <button
                className={`source-evidence-badge ${liveSourceEvidence.status}`}
                data-testid="source-evidence-status"
                data-status={liveSourceEvidence.status}
                title={liveSourceEvidence.scope}
                onClick={() => {
                  setBottomTab("checks");
                  setBottomOpen(true);
                }}
              >
                {liveSourceEvidence.status === "pass"
                  ? "源尺寸已核对 · 采样行程"
                  : liveSourceEvidence.status === "fail"
                    ? "源尺寸检查未通过"
                    : "源尺寸需重新验证"}
              </button>
            )}
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
                        "复合体 SAT / 离散路径采样 / 线性弹簧 / 电阻网络；源网格检查仅适用于所附证据完全匹配的构型和行程，未进行制造认证",
                      sourceEvidence: liveSourceEvidence,
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
          {selectedMechanism ? (
            <MechanismControls
              mechanism={selectedMechanism}
              parts={project.parts}
              issues={withSourceEvidence(mechanismIssues(project), liveSourceEvidence).filter((i) =>
                i.partIds.some((id) => selectedMechanism.partIds.includes(id)),
              )}
              running={running}
              contact={functionalScene.contacts[selectedMechanism.id]}
              held={heldMechanismId === selectedMechanism.id}
              displacement={
                mechanismStates[selectedMechanism.id]?.displacement ?? 0
              }
              force={mechanismStates[selectedMechanism.id]?.force ?? 0}
              onEdit={composeMechanism}
              onRemove={detachMechanism}
              onHeld={(held) => {
                if (running)
                  setHeldMechanismId(held ? selectedMechanism.id : null);
              }}
              onTransform={transformCompound}
            />
          ) : selected ? (
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
                    {selected.params.assetUrl
                      ? "BLENDER 子零件"
                      : selected.model
                        ? "上传组件"
                        : "参数化实体"}
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
                    {partMechanism(project, selected.id) && (
                      <button
                        className="mechanism-member-note"
                        onClick={() => {
                          setSelectedMechanismId(
                            partMechanism(project, selected.id)!.id,
                          );
                          setSelectedId(null);
                        }}
                      >
                        <Link2 size={13} />
                        <span>
                          功能由「{partMechanism(project, selected.id)!.name}
                          」控制<small>打开组件控制；单件外观仍可编辑</small>
                        </span>
                        <ChevronRight size={14} />
                      </button>
                    )}
                    <ComponentInspector part={selected} onApply={updatePart} />
                    {selected.kind.startsWith("bayonet-") &&
                      !selected.interaction && (
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
                      {Boolean(selected.params.assetUrl) && (
                        <>
                          <p className="hint amber">
                            {selected.kind === "asset"
                              ? "原始素材使用包围盒预检。榫槽与薄壁需回到原网格进一步检查。"
                              : "保留源网格显示；交互验证依据功能代理。复杂槽形和薄壁仍需回到原网格复核。"}
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
                        <span>PBR 材质与显示</span>
                        <small>
                          {selected.material ? "自定义外观" : "默认材质"}
                        </small>
                      </div>
                      <label className="inline-setting">
                        零件颜色
                        <input
                          type="color"
                          aria-label="零件颜色"
                          value={selected.color}
                          onChange={(e) =>
                            updatePart({
                              ...selected,
                              color: e.target.value,
                              material: {
                                metalness: selected.material?.metalness ?? 0.15,
                                roughness: selected.material?.roughness ?? 0.5,
                                useSourceColor: false,
                              },
                            })
                          }
                        />
                      </label>
                      <label className="inline-setting pbr-value">
                        金属度
                        <NumberField
                          label="材质金属度"
                          value={selected.material?.metalness ?? 0.15}
                          min={0}
                          max={1}
                          step={0.05}
                          onChange={(metalness) =>
                            updatePart({
                              ...selected,
                              material: {
                                roughness: selected.material?.roughness ?? 0.5,
                                useSourceColor:
                                  selected.material?.useSourceColor ??
                                  Boolean(
                                    selected.params.assetUrl || selected.model,
                                  ),
                                metalness,
                              },
                            })
                          }
                        />
                      </label>
                      <label className="inline-setting pbr-value">
                        粗糙度
                        <NumberField
                          label="材质粗糙度"
                          value={selected.material?.roughness ?? 0.5}
                          min={0}
                          max={1}
                          step={0.05}
                          onChange={(roughness) =>
                            updatePart({
                              ...selected,
                              material: {
                                metalness: selected.material?.metalness ?? 0.15,
                                useSourceColor:
                                  selected.material?.useSourceColor ??
                                  Boolean(
                                    selected.params.assetUrl || selected.model,
                                  ),
                                roughness,
                              },
                            })
                          }
                        />
                      </label>
                      {Boolean(selected.params.assetUrl || selected.model) && (
                        <label className="inline-setting">
                          保留模型原色
                          <input
                            aria-label="保留模型原色"
                            type="checkbox"
                            checked={
                              !selected.material ||
                              selected.material.useSourceColor === true
                            }
                            onChange={(e) =>
                              updatePart({
                                ...selected,
                                material: {
                                  metalness:
                                    selected.material?.metalness ?? 0.15,
                                  roughness:
                                    selected.material?.roughness ?? 0.5,
                                  useSourceColor: e.target.checked,
                                },
                              })
                            }
                          />
                        </label>
                      )}
                      <p className="hint">
                        PBR 控制外观反射。质量、弹性与电气特性由功能参数决定。
                      </p>
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
          {saveError
            ? "本地保存异常"
            : storageReady
              ? "本地工程已恢复"
              : "正在恢复本地工程"}
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
      {!storageReady && !saveError && (
        <div className="restoring-workspace" aria-label="正在恢复本地工程">
          正在恢复工程与组件库…
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <CircleDot size={17} />
          <span>{toast}</span>
          <button onClick={() => setToast("")}>
            <X size={15} />
          </button>
        </div>
      )}
      <MechanismEditor
        open={mechanismEditorOpen}
        project={project}
        initial={editingMechanism}
        initialPartIds={
          selected?.assemblyGroup
            ? project.parts
                .filter(
                  (p) => p.assemblyGroup?.id === selected.assemblyGroup!.id,
                )
                .map((p) => p.id)
            : undefined
        }
        onClose={() => {
          setMechanismEditorOpen(false);
          setEditingMechanism(undefined);
        }}
        onSave={saveMechanism}
      />
      <ComponentImportDialog
        open={importOpen}
        initial={editingComponent}
        onClose={() => {
          setImportOpen(false);
          setEditingComponent(undefined);
        }}
        onSave={saveCustomComponent}
      />
      {mcpOpen && (
        <div className="modal-backdrop" onClick={() => setMcpOpen(false)}>
          <div
            className="help-modal mcp-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <button className="modal-close" onClick={() => setMcpOpen(false)}>
              <X size={20} />
            </button>
            <span className="eyebrow">MODEL CONTEXT PROTOCOL</span>
            <h2>将工作台连接到 AI 工具</h2>
            <p>
              MCP
              与当前界面共享同一个工程，移动、旋转和参数配置沿用相同的验证规则。
            </p>
            {mcpStatus ? (
              <>
                <div className="mcp-state">
                  <span className="green-dot" />
                  {mcpStatus.active
                    ? "本机 MCP 服务已启动"
                    : "MCP 服务尚未启动"}
                  <small>仅监听本机，不对局域网开放</small>
                  <button
                    onClick={async () => {
                      try {
                        await setMcpEnabled(!mcpStatus.active);
                        setMcpStatus(await getMcpStatus());
                      } catch (error) {
                        notify((error as Error).message);
                      }
                    }}
                  >
                    {mcpStatus.active ? "关闭服务" : "开启服务"}
                  </button>
                </div>
                <label className="mcp-config-label">
                  复制到 MCP 客户端配置
                  <textarea
                    aria-label="MCP 客户端配置"
                    readOnly
                    value={JSON.stringify(mcpStatus.config, null, 2)}
                    rows={9}
                  />
                </label>
                <button
                  className="primary"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(
                        JSON.stringify(mcpStatus.config, null, 2),
                      );
                      notify("MCP 配置已复制。");
                    } catch {
                      notify("请选中配置文本手动复制。");
                    }
                  }}
                >
                  <Copy size={14} />
                  复制配置
                </button>
                <p className="hint">
                  连接时保持桌面应用打开。客户端先读取 get_project 的
                  revision，再提交更改；碰撞或版本冲突会拒绝操作。
                </p>
              </>
            ) : (
              <div className="model-note">
                <CircleHelp size={18} />
                <p>
                  浏览器版可完成装配与上传。MCP 由 Tauri 桌面客户端提供，请打开
                  macOS 应用后在此复制配置。
                </p>
              </div>
            )}
            <div className="mcp-capabilities">
              <span>查询类型与必填参数</span>
              <span>上传 / 配置组件</span>
              <span>移动 / 旋转 / 接线</span>
              <span>验证 / 导出当前工程</span>
            </div>
          </div>
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
                  点击左侧零件添加，或从「原始素材」选择独立子件和公母配合组。装配树支持逐件选择、隐藏、固定和PBR外观编辑。
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
