import { useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  CheckCircle2,
  FileUp,
  AlertTriangle,
  X,
  ArrowRight,
} from "lucide-react";
import * as THREE from "three";
import {
  getComponentTypeSchemas,
  componentDefinitionIssues,
  validateComponentDefinition,
} from "../componentRegistry";
import { importModelFile, loadImportedModelScene } from "../modelImport";
import type { ModelUnit } from "../modelImport";
import type {
  ComponentDefinition,
  InteractionProfile,
  PartKind,
  UploadedModel,
  Vec3,
} from "../types";
import "./ComponentImportDialog.css";
import { applyPartMaterial } from "../materials";

function ModelPreview({
  model,
  color,
  material,
}: {
  model: UploadedModel;
  color: string;
  material?: ComponentDefinition["material"];
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const element = host.current;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      return;
    }
    const width = element.clientWidth || 260,
      height = 210;
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setClearColor("#eaf0f3");
    element.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x647b90, 3));
    const light = new THREE.DirectionalLight(0xfff3df, 3);
    light.position.set(8, 12, 9);
    scene.add(light);
    const camera = new THREE.PerspectiveCamera(40, width / height, 0.001, 1e7);
    let alive = true,
      object: THREE.Object3D | undefined;
    void loadImportedModelScene(model)
      .then((source) => {
        if (!alive) return;
        object = source.clone(true);
        applyPartMaterial(object, {
          color,
          material:
            material ??
            (model.format === "stl"
              ? { metalness: 0.15, roughness: 0.5, useSourceColor: false }
              : undefined),
        });
        const bounds = new THREE.Box3().setFromObject(object, true),
          center = bounds.getCenter(new THREE.Vector3()),
          size = bounds.getSize(new THREE.Vector3());
        object.position.sub(center);
        scene.add(object);
        const radius = Math.max(size.x, size.y, size.z, 0.01);
        camera.near = radius / 10000;
        camera.far = radius * 100;
        camera.position.set(radius * 1.5, radius * 1.1, radius * 1.7);
        camera.lookAt(0, 0, 0);
        camera.updateProjectionMatrix();
        renderer.render(scene, camera);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (object) {
        scene.remove(object);
        object.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return;
          for (const item of Array.isArray(child.material)
            ? child.material
            : [child.material]) {
            for (const value of Object.values(item))
              if (value instanceof THREE.Texture) value.dispose();
            item.dispose();
          }
        });
      }
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [model, color, material]);
  return (
    <div
      className="component-model-preview"
      ref={host}
      aria-label="导入模型预览"
    />
  );
}
const axisChoices: { label: string; value: Vec3 }[] = [
  { label: "Y +（向上）", value: [0, 1, 0] },
  { label: "Y −（向下）", value: [0, -1, 0] },
  { label: "X +（向右）", value: [1, 0, 0] },
  { label: "X −（向左）", value: [-1, 0, 0] },
  { label: "Z +（向后）", value: [0, 0, 1] },
  { label: "Z −（向前）", value: [0, 0, -1] },
];
interface Props {
  open: boolean;
  initial?: ComponentDefinition;
  onClose: () => void;
  onSave: (definition: ComponentDefinition) => void | Promise<void>;
}
export default function ComponentImportDialog({
  open,
  initial,
  onClose,
  onSave,
}: Props) {
  const schemas = useMemo(getComponentTypeSchemas, []);
  const [model, setModel] = useState<UploadedModel | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<PartKind | "">("");
  const [unit, setUnit] = useState<ModelUnit>("mm");
  const [color, setColor] = useState("#7896a7");
  const [material, setMaterial] = useState<ComponentDefinition["material"]>();
  const [axis, setAxis] = useState<Vec3>([0, 1, 0]);
  const [anchor, setAnchor] = useState<string[]>(["0", "0", "0"]);
  const [size, setSize] = useState<string[]>(["1", "1", "1"]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [family, setFamily] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const file = useRef<File | null>(null);
  const request = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current
      ?.querySelector<HTMLElement>("button:not(:disabled)")
      ?.focus();
    return () => previous?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    request.current++;
    file.current = null;
    setModel(initial?.model ?? null);
    setName(initial?.name ?? "");
    setKind(initial?.kind ?? "");
    setColor(initial?.color ?? "#7896a7");
    setMaterial(initial?.material);
    setAxis(initial?.interaction.axis ?? [0, 1, 0]);
    setAnchor((initial?.interaction.anchor ?? [0, 0, 0]).map(String));
    setSize(
      (initial?.interaction.proxySize ?? initial?.size ?? [1, 1, 1]).map(
        String,
      ),
    );
    setFamily(initial?.interaction.mateFamily ?? "");
    setUnit("mm");
    setError("");
    setBusy(false);
    const entries: Record<string, string> = {};
    if (initial) {
      for (const [key, value] of Object.entries(initial.params))
        if (typeof value === "number") entries[`params.${key}`] = String(value);
      for (const key of [
        "insertionDepth",
        "minClearance",
        "lockAngle",
      ] as const)
        if (initial.interaction[key] !== undefined)
          entries[`interaction.${key}`] = String(initial.interaction[key]);
    }
    setValues(entries);
  }, [open, initial]);
  const schema = schemas.find((s) => s.kind === kind);
  function candidate(
    status: InteractionProfile["status"],
  ): ComponentDefinition | null {
    if (!model || !kind || !name.trim()) return null;
    const params: ComponentDefinition["params"] = {};
    const interaction: InteractionProfile = {
      version: 1,
      status,
      axis,
      anchor: anchor.map(Number) as Vec3,
      proxySize: size.map(Number) as Vec3,
      ...(schema?.requiresMating ? { mateFamily: family } : {}),
    };
    for (const field of schema?.fields ?? []) {
      const text = values[`${field.group}.${field.key}`];
      if (text === undefined || text.trim() === "") continue;
      const value = Number(text);
      if (!Number.isFinite(value)) continue;
      if (field.group === "params") params[field.key] = value;
      else
        (interaction as unknown as Record<string, unknown>)[field.key] = value;
    }
    return {
      version: 1,
      id: initial?.id ?? "component-preview",
      name: name.trim(),
      kind,
      size: [...model.size],
      color,
      ...(material ? { material } : {}),
      params,
      interaction,
      model,
    };
  }
  const ready = candidate("configured");
  let problems: string[] = [];
  if (ready) {
    if (
      size.some(
        (v) => !v.trim() || !Number.isFinite(Number(v)) || Number(v) <= 0,
      )
    )
      problems.push("请填写大于零的功能代理尺寸。");
    if (anchor.some((v) => !v.trim() || !Number.isFinite(Number(v))))
      problems.push("请填写有效的代理中心位置。");
    if (!problems.length)
      problems.push(
        ...componentDefinitionIssues(ready)
          .filter((i) => i.severity === "error")
          .map((i) => i.detail.replace(`${ready.name}：`, "")),
      );
  }
  async function chooseModel(selected: File, selectedUnit: ModelUnit) {
    const ticket = ++request.current;
    file.current = selected;
    setModel(null);
    setBusy(true);
    setError("");
    try {
      const next = await importModelFile(selected, selectedUnit);
      if (ticket !== request.current) return;
      setModel(next);
      setSize(next.size.map((v) => String(Number(v.toFixed(4)))));
      setName(
        (current) =>
          current || selected.name.replace(/\.[^.]+$/, "").slice(0, 200),
      );
    } catch (err) {
      if (ticket === request.current) setError((err as Error).message);
    } finally {
      if (ticket === request.current) setBusy(false);
    }
  }
  async function save(status: InteractionProfile["status"]) {
    setError("");
    try {
      const value = candidate(status);
      if (!value) throw Error("请上传模型、填写名称并选择组件类型。");
      const checked = validateComponentDefinition({
        ...value,
        id: initial?.id ?? crypto.randomUUID(),
      });
      if (status === "configured") {
        const issue = componentDefinitionIssues(checked).find(
          (i) => i.severity === "error",
        );
        if (issue) throw Error(issue.detail);
      }
      setBusy(true);
      await onSave(checked);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!open) return null;
  return (
    <div
      className="component-dialog-backdrop"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <section
        ref={dialog}
        className="component-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="component-dialog-title"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onClose();
          }
          if (event.key !== "Tab") return;
          const targets = Array.from(
            dialog.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
            ) ?? [],
          ).filter((element) => element.getClientRects().length > 0);
          const first = targets[0],
            last = targets[targets.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header>
          <span className="component-dialog-icon">
            <Box size={23} />
          </span>
          <div>
            <small>COMPONENT DEFINITION</small>
            <h2 id="component-dialog-title">
              {initial ? "编辑组件定义" : "上传自定义组件"}
            </h2>
          </div>
          <button title="关闭组件导入" disabled={busy} onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <div className="component-dialog-body">
          <aside className="component-model-column">
            <input
              ref={fileInput}
              type="file"
              accept=".glb,.stl"
              hidden
              aria-label="上传模型文件"
              onChange={(event) => {
                const selected = event.target.files?.[0];
                if (selected) void chooseModel(selected, unit);
                event.target.value = "";
              }}
            />
            {model ? (
              <>
                <ModelPreview model={model} color={color} material={material} />
                <div className="import-model-name">
                  <strong>{model.name}</strong>
                  <small>
                    {model.format.toUpperCase()} ·{" "}
                    {(model.bytes / 1048576).toFixed(2)} MiB
                  </small>
                </div>
                <div className="measured-model-size">
                  <small>实测模型外接尺寸 · mm</small>
                  <strong>
                    {model.size.map((v) => Number(v.toFixed(3))).join(" × ")}
                  </strong>
                </div>
              </>
            ) : (
              <button
                className="component-upload-area"
                disabled={busy}
                onClick={() => fileInput.current?.click()}
              >
                <FileUp size={32} />
                <strong>
                  {busy ? "正在检查模型…" : "选择 GLB / STL 模型"}
                </strong>
                <span>资源需内嵌 · 不超过 12 MiB</span>
              </button>
            )}
            <button
              className="component-replace"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              <FileUp size={14} />
              {model ? "替换模型文件" : "浏览文件"}
            </button>
            <label className="component-field">
              源文件尺寸单位
              <select
                aria-label="模型单位"
                value={unit}
                disabled={busy || Boolean(initial && !file.current)}
                onChange={(event) => {
                  const value = event.target.value as ModelUnit;
                  setUnit(value);
                  if (file.current) void chooseModel(file.current, value);
                }}
              >
                <option value="mm">毫米 mm</option>
                <option value="cm">厘米 cm</option>
                <option value="m">米 m</option>
              </select>
            </label>
            <div className="component-explanation">
              <AlertTriangle size={16} />
              <p>
                模型决定外观，类型和参数决定功能。尺寸以导入单位转换为毫米；不会根据外观猜测孔、卡耳或开关触发点。
              </p>
            </div>
          </aside>
          <div className="component-definition-column">
            <label className="component-field">
              组件名称
              <input
                aria-label="组件名称"
                value={name}
                maxLength={200}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="component-field">
              功能类型 <b>*</b>
              <select
                aria-label="组件功能类型"
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as PartKind);
                  setValues({});
                }}
              >
                <option value="" disabled>
                  请选择该组件的实际类型
                </option>
                {schemas.map((s) => (
                  <option value={s.kind} key={s.kind}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            {schema && (
              <p className="component-type-description">{schema.description}</p>
            )}
            <label className="component-color-field">
              显示颜色
              <input
                aria-label="组件显示颜色"
                type="color"
                value={color}
                onChange={(event) => {
                  setColor(event.target.value);
                  setMaterial({
                    metalness: material?.metalness ?? 0.15,
                    roughness: material?.roughness ?? 0.5,
                    useSourceColor: false,
                  });
                }}
              />
              <span>每个组件均使用 PBR 材质；颜色只影响外观</span>
            </label>
            <div className="component-material-fields">
              <label className="component-field">
                金属度
                <input
                  aria-label="组件金属度"
                  type="number"
                  min="0"
                  max="1"
                  step="0.05"
                  value={material?.metalness ?? 0.15}
                  onChange={(event) =>
                    setMaterial({
                      metalness: Number(event.target.value),
                      roughness: material?.roughness ?? 0.5,
                      useSourceColor: material
                        ? material.useSourceColor
                        : model?.format === "glb",
                    })
                  }
                />
              </label>
              <label className="component-field">
                粗糙度
                <input
                  aria-label="组件粗糙度"
                  type="number"
                  min="0"
                  max="1"
                  step="0.05"
                  value={material?.roughness ?? 0.5}
                  onChange={(event) =>
                    setMaterial({
                      metalness: material?.metalness ?? 0.15,
                      roughness: Number(event.target.value),
                      useSourceColor: material
                        ? material.useSourceColor
                        : model?.format === "glb",
                    })
                  }
                />
              </label>
              {model?.format === "glb" && (
                <label className="component-source-color">
                  <input
                    type="checkbox"
                    aria-label="保留 GLB 原色"
                    checked={material ? material.useSourceColor === true : true}
                    onChange={(event) =>
                      setMaterial({
                        metalness: material?.metalness ?? 0.15,
                        roughness: material?.roughness ?? 0.5,
                        useSourceColor: event.target.checked,
                      })
                    }
                  />
                  保留 GLB 原色
                </label>
              )}
            </div>
            {schema && (
              <>
                <h3>功能代理与局部坐标</h3>
                <p className="component-form-note">
                  模型中心归零后，按真实配合位置填写。代理轴向长度为
                  Y，外接宽深为 X / Z；下方轴向决定它在模型内的方向。
                </p>
                <div className="component-vector-fields">
                  <span>代理尺寸 · mm</span>
                  {["X", "Y", "Z"].map((label, index) => (
                    <label key={label}>
                      {label}
                      <input
                        type="number"
                        min="0.001"
                        step="0.1"
                        aria-label={`代理尺寸 ${label}`}
                        value={size[index]}
                        onChange={(event) =>
                          setSize((current) =>
                            current.map((v, i) =>
                              i === index ? event.target.value : v,
                            ),
                          )
                        }
                      />
                    </label>
                  ))}
                </div>
                <label className="component-field">
                  配合 / 运动轴
                  <select
                    aria-label="配合轴"
                    value={axisChoices.findIndex((choice) =>
                      choice.value.every((value, i) => value === axis[i]),
                    )}
                    onChange={(event) =>
                      setAxis(axisChoices[Number(event.target.value)].value)
                    }
                  >
                    {axisChoices.map((choice, index) => (
                      <option key={choice.label} value={index}>
                        {choice.label}
                      </option>
                    ))}
                    {!axisChoices.some((choice) =>
                      choice.value.every((value, i) => value === axis[i]),
                    ) && (
                      <option value={-1}>自定义方向 [{axis.join(", ")}]</option>
                    )}
                  </select>
                </label>
                <div className="component-vector-fields">
                  <span>代理中心偏移 · mm</span>
                  {["X", "Y", "Z"].map((label, index) => (
                    <label key={label}>
                      {label}
                      <input
                        type="number"
                        step="0.1"
                        aria-label={`代理中心 ${label}`}
                        value={anchor[index]}
                        onChange={(event) =>
                          setAnchor((current) =>
                            current.map((v, i) =>
                              i === index ? event.target.value : v,
                            ),
                          )
                        }
                      />
                    </label>
                  ))}
                </div>
                {schema.requiresMating && (
                  <label className="component-field">
                    配合族 <b>*</b>
                    <input
                      aria-label="配合族"
                      value={family}
                      maxLength={100}
                      placeholder="例如 my-pin-6mm，公母件需使用相同名称"
                      onChange={(event) => setFamily(event.target.value)}
                    />
                  </label>
                )}
                <h3>交互验证参数</h3>
                <div className="component-parameter-grid">
                  {schema.fields.map((field) => (
                    <label
                      className="component-field"
                      key={`${field.group}.${field.key}`}
                    >
                      {field.label} {field.required && <b>*</b>}
                      <div>
                        <input
                          type="number"
                          aria-label={field.label}
                          min={field.min}
                          max={field.max}
                          step="any"
                          value={values[`${field.group}.${field.key}`] ?? ""}
                          placeholder="待填写"
                          onChange={(event) =>
                            setValues((current) => ({
                              ...current,
                              [`${field.group}.${field.key}`]:
                                event.target.value,
                            }))
                          }
                        />
                        <span>{field.unit}</span>
                      </div>
                    </label>
                  ))}
                </div>
                {!schema.fields.length && (
                  <p className="component-form-note">
                    此类型没有机构动作；只使用声明的外接尺寸进行空间预检。
                  </p>
                )}
              </>
            )}
            {ready && (
              <div
                className={`component-completeness ${problems.length ? "incomplete" : "complete"}`}
              >
                {problems.length ? (
                  <>
                    <AlertTriangle size={16} />
                    <div>
                      <strong>{problems.length} 项参数待完成</strong>
                      <ul>
                        {problems.slice(0, 5).map((problem, i) => (
                          <li key={i}>{problem}</li>
                        ))}
                      </ul>
                    </div>
                  </>
                ) : (
                  <>
                    <CheckCircle2 size={16} />
                    <span>必填参数完整，可启用该类型的交互代理验证。</span>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
        {error && (
          <div className="component-import-error" role="alert">
            {error}
          </div>
        )}
        <footer>
          <p>代理计算不等于上传网格已通过制造验证。</p>
          <button
            disabled={busy || !ready}
            onClick={() => void save("unconfigured")}
          >
            保存为预览
          </button>
          <button
            className="primary"
            disabled={busy || !ready || problems.length > 0}
            onClick={() => void save("configured")}
          >
            {busy ? "处理中…" : "保存并启用交互"}
            <ArrowRight size={14} />
          </button>
        </footer>
      </section>
    </div>
  );
}
