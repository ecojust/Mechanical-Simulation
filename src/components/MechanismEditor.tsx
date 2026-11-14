import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Layers3, X } from "lucide-react";
import { Box3, Euler, Quaternion, Vector3 } from "three";
import { getComponentTypeSchemas } from "../componentRegistry";
import {
  createMechanism,
  mechanismContact,
  mechanismDefinitionIssues,
  validateMechanismDefinition,
} from "../mechanisms";
import type {
  Mechanism,
  MechanismProxy,
  MechanismProxyKind,
  Project,
  Vec3,
} from "../types";
import "./MechanismEditor.css";

interface Props {
  open: boolean;
  project: Project;
  initial?: Mechanism;
  initialPartIds?: string[];
  onClose: () => void;
  onSave: (mechanism: Mechanism) => void | Promise<void>;
}
type Triple = [string, string, string];
type Role = "fixed" | "moving" | "spring" | "switch" | "";
interface ProxyDraft {
  kind: MechanismProxyKind;
  position: Triple;
  rotation: Triple;
  size: Triple;
  params: Record<string, string>;
}
interface Draft {
  id: string;
  name: string;
  kind: Mechanism["kind"];
  roles: Record<string, Role>;
  position: Triple;
  rotation: Triple;
  axis: Triple;
  pose: Mechanism["pose"];
  params: Record<string, string>;
  moving: ProxyDraft;
  fixed: ProxyDraft;
  contact: ContactDraft | null;
}
interface ContactDraft {
  strikerPartId: string;
  targetPartId?: string;
  strikerPoint: Triple;
  switchPoint: Triple;
  switchNormal: Triple;
  radius: string;
  maxOvertravel: string;
  actuatorPartIds?: string[];
}
const emptyContact = (): ContactDraft => ({
  strikerPartId: "",
  strikerPoint: ["", "", ""],
  switchPoint: ["", "", ""],
  switchNormal: ["", "", ""],
  radius: "",
  maxOvertravel: "",
});
const axes: { label: string; vector: Vec3 }[] = [
  { label: "正 Y（向上）", vector: [0, 1, 0] },
  { label: "负 Y（向下）", vector: [0, -1, 0] },
  { label: "正 X", vector: [1, 0, 0] },
  { label: "负 X", vector: [-1, 0, 0] },
  { label: "正 Z", vector: [0, 0, 1] },
  { label: "负 Z", vector: [0, 0, -1] },
];
interface Parameter {
  key: string;
  label: string;
  unit: string;
  min: number;
  max?: number;
}
const pressFields: Parameter[] = [
  { key: "stiffness", label: "弹簧刚度", unit: "N/mm", min: 0.001 },
  { key: "mass", label: "运动质量", unit: "kg", min: 0.000001 },
  { key: "damping", label: "阻尼系数", unit: "N·s/m", min: 0 },
  { key: "travel", label: "最大行程", unit: "mm", min: 0.001 },
  { key: "freeLength", label: "自由长度", unit: "mm", min: 0.001 },
  { key: "solidLength", label: "并圈高度", unit: "mm", min: 0 },
];
const matingFields: Parameter[] = [
  { key: "insertionDepth", label: "允许插入深度", unit: "mm", min: 0.001 },
  { key: "minClearance", label: "要求的最小单侧余隙", unit: "mm", min: 0 },
];
const proxyKinds: MechanismProxyKind[] = [
  "base",
  "tenon",
  "mortise",
  "pin",
  "sleeve",
  "bayonet-pin",
  "bayonet-socket",
];
const strings = (vector: Vec3) => vector.map(String) as Triple;
const stringParams = (params: Record<string, number>) =>
  Object.fromEntries(
    Object.entries(params).map(([key, value]) => [key, String(value)]),
  );
const proxyDraft = (proxy: MechanismProxy): ProxyDraft => ({
  kind: proxy.kind,
  position: strings(proxy.position),
  rotation: strings(proxy.rotation),
  size: strings(proxy.size),
  params: stringParams(proxy.params),
});
function toDraft(mechanism: Mechanism, requireRoles: boolean): Draft {
  return {
    id: mechanism.id,
    name: mechanism.name,
    kind: mechanism.kind,
    roles: Object.fromEntries(
      mechanism.partIds.map((id) => [
        id,
        requireRoles
          ? ""
          : mechanism.springPartIds.includes(id)
            ? "spring"
            : mechanism.switchPartId === id
              ? "switch"
              : mechanism.movingPartIds.includes(id)
                ? "moving"
                : "fixed",
      ]),
    ),
    position: strings(mechanism.frame.position),
    rotation: strings(mechanism.frame.rotation),
    axis: strings(mechanism.axis),
    pose: { ...mechanism.pose },
    params: stringParams(mechanism.params),
    moving: proxyDraft(mechanism.movingProxy),
    fixed: proxyDraft(mechanism.fixedProxy),
    contact: mechanism.contact
      ? {
          strikerPartId: mechanism.contact.strikerPartId,
          ...(mechanism.contact.targetPartId
            ? { targetPartId: mechanism.contact.targetPartId }
            : {}),
          strikerPoint: strings(mechanism.contact.strikerPoint),
          switchPoint: strings(mechanism.contact.switchPoint),
          switchNormal: strings(mechanism.contact.switchNormal),
          radius: String(mechanism.contact.radius),
          maxOvertravel: String(mechanism.contact.maxOvertravel),
          ...(mechanism.contact.actuatorPartIds
            ? { actuatorPartIds: [...mechanism.contact.actuatorPartIds] }
            : {}),
        }
      : null,
  };
}
function numberVector(values: Triple, label: string, positive = false): Vec3 {
  if (
    values.some(
      (value) =>
        !value.trim() ||
        !Number.isFinite(Number(value)) ||
        (positive && Number(value) <= 0),
    )
  )
    throw Error(
      `请填写有效的${label}${positive ? "（三个尺寸均须大于零）" : ""}。`,
    );
  return values.map(Number) as Vec3;
}
function numberParams(values: Record<string, string>, label: string) {
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(values)) {
    if (!raw.trim()) continue;
    if (!Number.isFinite(Number(raw))) throw Error(`${label}必须是有限数值。`);
    result[key] = Number(raw);
  }
  return result;
}
function proxyValue(draft: ProxyDraft, label: string): MechanismProxy {
  return {
    kind: draft.kind,
    position: numberVector(draft.position, `${label}代理位置`),
    rotation: numberVector(draft.rotation, `${label}代理旋转`),
    size: numberVector(draft.size, `${label}代理尺寸`, true),
    params: numberParams(draft.params, `${label}代理参数`),
  };
}
function VectorFields({
  label,
  value,
  onChange,
  unit = "mm",
}: {
  label: string;
  value: Triple;
  onChange: (value: Triple) => void;
  unit?: string;
}) {
  return (
    <fieldset className="me-vector">
      <legend>
        {label} · {unit}
      </legend>
      <div>
        {["X", "Y", "Z"].map((axis, index) => (
          <label key={axis}>
            <span>{axis}</span>
            <input
              type="number"
              step="any"
              aria-label={`${label} ${axis}`}
              value={value[index]}
              onChange={(event) => {
                const next = [...value] as Triple;
                next[index] = event.target.value;
                onChange(next);
              }}
            />
          </label>
        ))}
      </div>
    </fieldset>
  );
}
function ParameterFields({
  fields,
  values,
  label,
  onChange,
}: {
  fields: Parameter[];
  values: Record<string, string>;
  label: string;
  onChange: (values: Record<string, string>) => void;
}) {
  return (
    <div className="me-parameters">
      {fields.map((field) => (
        <label className="me-parameter" key={field.key}>
          <span>
            {field.label}
            <b>*</b>
          </span>
          <div>
            <input
              type="number"
              step="any"
              min={field.min}
              max={field.max}
              aria-label={`${label} ${field.label}`}
              value={values[field.key] ?? ""}
              placeholder="待填写"
              onChange={(event) =>
                onChange({ ...values, [field.key]: event.target.value })
              }
            />
            <small>{field.unit}</small>
          </div>
        </label>
      ))}
    </div>
  );
}
function ProxyFields({
  label,
  value,
  onChange,
  onEstimate,
}: {
  label: string;
  value: ProxyDraft;
  onChange: (value: ProxyDraft) => void;
  onEstimate: () => void;
}) {
  const schemas = getComponentTypeSchemas();
  const fields = schemas
    .find((schema) => schema.kind === value.kind)!
    .fields.filter((field) => field.group === "params");
  return (
    <details className="me-section" open>
      <summary>{label}功能代理</summary>
      <p className="me-note">
        代理位置与旋转相对组件坐标系；代理自身 Y 轴是销 /
        孔轴。只描述有效功能几何，不替换子件模型。
      </p>
      <button type="button" className="me-estimate" onClick={onEstimate}>
        读取{label}成员外接尺寸
      </button>
      <label className="me-field">
        代理形状
        <select
          aria-label={`${label}代理类型`}
          value={value.kind}
          onChange={(event) => {
            const kind = event.target.value as MechanismProxyKind;
            const allowed = new Set(
              schemas
                .find((schema) => schema.kind === kind)!
                .fields.filter((field) => field.group === "params")
                .map((field) => field.key),
            );
            onChange({
              ...value,
              kind,
              params: Object.fromEntries(
                Object.entries(value.params).filter(([key]) =>
                  allowed.has(key),
                ),
              ),
            });
          }}
        >
          {proxyKinds.map((kind) => (
            <option key={kind} value={kind}>
              {schemas.find((schema) => schema.kind === kind)!.label}
            </option>
          ))}
        </select>
      </label>
      <VectorFields
        label={`${label}代理位置`}
        value={value.position}
        onChange={(position) => onChange({ ...value, position })}
      />
      <VectorFields
        label={`${label}代理旋转`}
        value={value.rotation}
        unit="°"
        onChange={(rotation) => onChange({ ...value, rotation })}
      />
      <VectorFields
        label={`${label}代理尺寸`}
        value={value.size}
        onChange={(size) => onChange({ ...value, size })}
      />
      <ParameterFields
        label={`${label}代理参数`}
        fields={fields}
        values={value.params}
        onChange={(params) => onChange({ ...value, params })}
      />
    </details>
  );
}

/** A mechanism preserves all source parts and declares how its members cooperate. */
export default function MechanismEditor({
  open,
  project,
  initial,
  initialPartIds,
  onClose,
  onSave,
}: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [search, setSearch] = useState("");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [customAxis, setCustomAxis] = useState(false);
  useEffect(() => {
    if (!open) return;
    const parts = project.parts.filter((part) =>
      initialPartIds?.includes(part.id),
    );
    setDraft(toDraft(initial ?? createMechanism("press", parts), !initial));
    setSearch("");
    setFeedback("");
    setBusy(false);
    setCustomAxis(false);
    // Scene updates while the dialog is open must not erase unfinished form fields.
  }, [open, initial]); // eslint-disable-line react-hooks/exhaustive-deps
  const parts = useMemo(
    () =>
      project.parts.filter((part) =>
        `${part.name} ${part.assemblyGroup?.name ?? ""}`
          .toLocaleLowerCase()
          .includes(search.trim().toLocaleLowerCase()),
      ),
    [project.parts, search],
  );
  if (!open || !draft) return null;
  const calibrationLocked = Boolean(
    initial && (initial.pose.offset !== 0 || initial.pose.angle !== 0),
  );
  const update = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch });
    setFeedback("");
  };
  const hasBayonet =
    draft.moving.kind.startsWith("bayonet-") ||
    draft.fixed.kind.startsWith("bayonet-");
  const switchId = Object.keys(draft.roles).find(
    (id) => draft.roles[id] === "switch",
  );
  const contact = draft.contact ?? emptyContact();
  const targetId = contact.targetPartId ?? switchId;
  const pairedProxy =
    draft.moving.kind !== "base" || draft.fixed.kind !== "base";
  const fields = [
    ...(draft.kind === "press" ? pressFields : []),
    ...(draft.kind === "mating" || pairedProxy ? matingFields : []),
    ...(hasBayonet
      ? [
          {
            key: "lockAngle",
            label: "锁定角（当前仅45°）",
            unit: "°",
            min: 45,
            max: 45,
          },
        ]
      : []),
  ];
  function estimateProxy(role: "moving" | "fixed") {
    if (!draft) return;
    try {
      const members = project.parts.filter((part) =>
        role === "moving"
          ? draft.roles[part.id] === "moving"
          : draft.roles[part.id] === "fixed" ||
            draft.roles[part.id] === "switch",
      );
      if (!members.length)
        throw Error(`请先指定${role === "moving" ? "活动" : "固定"}成员。`);
      const rotation = (values: Triple) =>
        new Quaternion().setFromEuler(
          new Euler(
            ...(numberVector(values, "旋转").map(
              (v) => (v * Math.PI) / 180,
            ) as Vec3),
          ),
        );
      const frameOrigin = new Vector3(
        ...numberVector(draft.position, "组件坐标原点"),
      );
      const frameInverse = rotation(draft.rotation).invert();
      const proxyRotation = rotation(draft[role].rotation);
      const inverse = proxyRotation.clone().invert();
      const bounds = new Box3();
      for (const member of members) {
        const memberRotation = new Quaternion().setFromEuler(
          new Euler(
            ...(member.rotation.map((v) => (v * Math.PI) / 180) as Vec3),
          ),
        );
        for (const x of [-1, 1])
          for (const y of [-1, 1])
            for (const z of [-1, 1]) {
              bounds.expandByPoint(
                new Vector3(
                  (member.size[0] * x) / 2,
                  (member.size[1] * y) / 2,
                  (member.size[2] * z) / 2,
                )
                  .applyQuaternion(memberRotation)
                  .add(new Vector3(...member.position))
                  .sub(frameOrigin)
                  .applyQuaternion(frameInverse)
                  .applyQuaternion(inverse),
              );
            }
      }
      const position = bounds
        .getCenter(new Vector3())
        .applyQuaternion(proxyRotation)
        .toArray() as Vec3;
      const size = bounds.getSize(new Vector3()).toArray() as Vec3;
      update({
        [role]: {
          ...draft[role],
          position: strings(position),
          size: strings(size),
        },
      });
    } catch (error) {
      setFeedback((error as Error).message);
    }
  }
  function candidate(status: Mechanism["status"]): Mechanism {
    if (!draft) throw Error("功能组件尚未初始化。");
    if (calibrationLocked && initial)
      return validateMechanismDefinition(
        { ...initial, name: draft.name.trim() },
        project.parts,
      );
    const partIds = Object.keys(draft.roles);
    if (partIds.length < 2)
      throw Error("至少选择两个独立子件，再指定各自的功能角色。");
    if (partIds.some((id) => !draft.roles[id]))
      throw Error("请为每个选中的子件明确指定角色。");
    const switches = partIds.filter((id) => draft.roles[id] === "switch");
    if (switches.length > 1)
      throw Error("一个按压功能组件只能指定一个触发开关。");
    const allowed = new Set(fields.map((field) => field.key));
    const params = numberParams(
      Object.fromEntries(
        Object.entries(draft.params).filter(([key]) => allowed.has(key)),
      ),
      "机制参数",
    );
    let contactDefinition: Mechanism["contact"];
    if (draft.kind === "press" && switches.length && draft.contact) {
      const entry = draft.contact;
      if (!entry.strikerPartId)
        throw Error("请选择实际撞针端点所属的活动子件。");
      if (
        !entry.radius.trim() ||
        !entry.maxOvertravel.trim() ||
        !Number.isFinite(Number(entry.radius)) ||
        !Number.isFinite(Number(entry.maxOvertravel))
      )
        throw Error("请填写触发面的有效半径与允许过行程。");
      contactDefinition = {
        strikerPartId: entry.strikerPartId,
        ...(entry.targetPartId ? { targetPartId: entry.targetPartId } : {}),
        strikerPoint: numberVector(entry.strikerPoint, "撞针局部端点"),
        switchPoint: numberVector(entry.switchPoint, "开关局部触发点"),
        switchNormal: numberVector(entry.switchNormal, "开关触发面法向"),
        radius: Number(entry.radius),
        maxOvertravel: Number(entry.maxOvertravel),
        ...(entry.actuatorPartIds
          ? { actuatorPartIds: [...entry.actuatorPartIds] }
          : {}),
      };
    }
    return validateMechanismDefinition(
      {
        version: 1,
        id: draft.id,
        name: draft.name.trim(),
        kind: draft.kind,
        status,
        partIds,
        movingPartIds: partIds.filter((id) => draft.roles[id] === "moving"),
        springPartIds: partIds.filter((id) => draft.roles[id] === "spring"),
        ...(switches.length ? { switchPartId: switches[0] } : {}),
        ...(contactDefinition ? { contact: contactDefinition } : {}),
        frame: {
          position: numberVector(draft.position, "组件坐标原点"),
          rotation: numberVector(draft.rotation, "组件整体旋转"),
        },
        axis: numberVector(draft.axis, "机制操作方向"),
        pose: { ...draft.pose },
        params,
        movingProxy: proxyValue(draft.moving, "活动"),
        fixedProxy: proxyValue(draft.fixed, "固定"),
      },
      project.parts,
    );
  }
  let configured: Mechanism | undefined;
  let structureError = "";
  try {
    configured = candidate("configured");
  } catch (error) {
    structureError = (error as Error).message;
  }
  const issues = configured
    ? mechanismDefinitionIssues(configured, project.parts).filter(
        (issue) => issue.severity === "error",
      )
    : [];
  let contactMetrics: ReturnType<typeof mechanismContact>;
  if (configured?.contact) {
    try {
      contactMetrics = mechanismContact(project, configured);
    } catch {
      /* Incomplete declarations are listed by the shared validator below. */
    }
  }
  const conflicts = Object.keys(draft.roles).some((id) =>
    (project.mechanisms ?? []).some(
      (mechanism) =>
        mechanism.id !== draft.id && mechanism.partIds.includes(id),
    ),
  );
  const errors = [
    ...(structureError ? [structureError] : []),
    ...issues.map((issue) => issue.detail),
    ...(conflicts
      ? ["所选子件已属于其他功能组件。请先解除原组件关系，再重新组合。"]
      : []),
  ];
  const axisIndex = axes.findIndex((axis) =>
    axis.vector.every(
      (value, index) => Math.abs(value - Number(draft.axis[index])) < 1e-6,
    ),
  );
  async function save(status: Mechanism["status"]) {
    try {
      if (conflicts) throw Error("子件不能同时属于两个功能组件。");
      const mechanism = candidate(status);
      if (status === "configured") {
        const problems = mechanismDefinitionIssues(
          mechanism,
          project.parts,
        ).filter((issue) => issue.severity === "error");
        if (problems.length)
          throw Error(problems.map((issue) => issue.detail).join("\n"));
      }
      setBusy(true);
      await onSave(mechanism);
      onClose();
    } catch (error) {
      setFeedback((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="me-backdrop"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <section
        className="me-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mechanism-editor-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="me-header">
          <Layers3 size={25} />
          <div>
            <small>FUNCTIONAL ASSEMBLY</small>
            <h2 id="mechanism-editor-title">
              {initial ? "编辑功能组件" : "组合成功能组件"}
            </h2>
          </div>
          <button
            aria-label="关闭功能组件编辑"
            disabled={busy}
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </header>
        <div className="me-body">
          <aside className="me-members">
            <h3>选择参与协作的子零件</h3>
            <p className="me-note">
              模型保持独立。请指定哪些子件固定、哪些一起运动，以及实际弹簧与触发开关。
            </p>
            <input
              className="me-search"
              aria-label="搜索组件成员"
              placeholder="搜索子件或关系组…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <div className="me-member-count">
              <span>已选择 {Object.keys(draft.roles).length} 个子件</span>
              <span>{project.parts.length} 个可选</span>
            </div>
            <div className="me-member-list">
              {parts.map((part) => {
                const selected = Object.hasOwn(draft.roles, part.id);
                const owner = (project.mechanisms ?? []).find(
                  (mechanism) =>
                    mechanism.id !== draft.id &&
                    mechanism.partIds.includes(part.id),
                );
                return (
                  <div
                    className={`me-member ${selected ? "selected" : ""}`}
                    key={part.id}
                    data-member-id={part.id}
                  >
                    <label>
                      <input
                        type="checkbox"
                        aria-label={`选择子件 ${part.name}`}
                        checked={selected}
                        disabled={Boolean(owner) || calibrationLocked}
                        onChange={(event) => {
                          const roles = { ...draft.roles };
                          if (event.target.checked) roles[part.id] = "";
                          else delete roles[part.id];
                          update({
                            roles,
                            ...(draft.roles[part.id] === "switch"
                              ? { contact: null }
                              : {}),
                          });
                        }}
                      />
                      <span>
                        {part.name}
                        <small>
                          {owner
                            ? `已属于：${owner.name}`
                            : (part.assemblyGroup?.name ?? "独立子零件")}
                        </small>
                      </span>
                    </label>
                    {selected && (
                      <select
                        aria-label={`成员角色 ${part.name}`}
                        disabled={calibrationLocked}
                        value={draft.roles[part.id]}
                        onChange={(event) =>
                          update({
                            roles: {
                              ...draft.roles,
                              [part.id]: event.target.value as Role,
                            },
                            ...((draft.roles[part.id] === "switch") !==
                            (event.target.value === "switch")
                              ? { contact: null }
                              : {}),
                          })
                        }
                      >
                        <option value="">请选择角色</option>
                        <option value="fixed">固定成员 / 基座</option>
                        <option value="moving">活动成员 / 公件</option>
                        {draft.kind === "press" && (
                          <>
                            <option value="spring">弹簧（随行程压缩）</option>
                            <option value="switch">触发开关（固定）</option>
                          </>
                        )}
                      </select>
                    )}
                  </div>
                );
              })}
            </div>
            {!parts.length && (
              <p className="me-note">
                没有匹配子件。先把所需模型加入装配空间。
              </p>
            )}
          </aside>
          <div className="me-settings">
            <div className="me-field-row">
              <label className="me-field">
                组件名称<b>*</b>
                <input
                  aria-label="功能组件名称"
                  value={draft.name}
                  maxLength={200}
                  onChange={(event) => update({ name: event.target.value })}
                />
              </label>
              <label className="me-field">
                协作类型
                <select
                  aria-label="功能组件类型"
                  disabled={calibrationLocked}
                  value={draft.kind}
                  onChange={(event) =>
                    update({
                      kind: event.target.value as Mechanism["kind"],
                      params: {},
                      contact: null,
                      roles: Object.fromEntries(
                        Object.keys(draft.roles).map((id) => [id, ""]),
                      ),
                    })
                  }
                >
                  <option value="press">弹簧按压 / 触发回弹</option>
                  <option value="mating">榫卯插接 / 旋锁配合</option>
                </select>
              </label>
            </div>
            {calibrationLocked && (
              <div className="me-warning">
                <AlertTriangle size={14} />
                <span>
                  当前配合姿态已离开零位，仅可修改名称。请先通过右侧活动组控制退回轴向偏移
                  0、相对角度 0，再编辑成员、轴和功能代理。
                </span>
              </div>
            )}
            <fieldset className="me-calibration" disabled={calibrationLocked}>
              <p className="me-note">
                {draft.kind === "press"
                  ? "按下时活动成员沿操作轴的负方向移动，弹簧压缩；松开后按质量、刚度和阻尼回弹。撞针与开关触发面实际接触后才闭合电路。"
                  : "公件由活动成员组成，母件由固定成员组成。沿轴插入和旋转必须通过整条操作路径及相邻组件检查。"}
              </p>
              <label className="me-field">
                操作轴（组件局部坐标）
                <select
                  aria-label="机制操作轴"
                  value={
                    customAxis || axisIndex < 0 ? "custom" : String(axisIndex)
                  }
                  onChange={(event) => {
                    setCustomAxis(event.target.value === "custom");
                    if (event.target.value !== "custom")
                      update({
                        axis: strings(axes[Number(event.target.value)].vector),
                      });
                  }}
                >
                  <option value="custom">自定义单位向量</option>
                  {axes.map((axis, index) => (
                    <option key={axis.label} value={index}>
                      {axis.label}
                    </option>
                  ))}
                </select>
              </label>
              {(customAxis || axisIndex < 0) && (
                <VectorFields
                  label="机制轴向量"
                  unit="单位向量"
                  value={draft.axis}
                  onChange={(axis) => update({ axis })}
                />
              )}
              <div className="me-section">
                <h3>功能参数 · 必须按实际结构填写</h3>
                <ParameterFields
                  fields={fields}
                  values={draft.params}
                  label="机制参数"
                  onChange={(params) => update({ params })}
                />
              </div>
              {draft.kind === "press" && switchId && (
                <div className="me-section">
                  <h3>撞针与开关的实际接触</h3>
                  <p className="me-note">
                    只有撞针端点到达开关触发面、落在有效区域内，才闭合电路。坐标相对各自子件中心，须位于模型外接范围内；不会根据预设压缩阈值假定接触。
                  </p>
                  <label className="me-field">
                    撞针端点所属活动子件<b>*</b>
                    <select
                      aria-label="撞针所属子件"
                      value={contact.strikerPartId}
                      onChange={(event) =>
                        update({
                          contact: {
                            ...contact,
                            strikerPartId: event.target.value,
                            strikerPoint: ["", "", ""],
                          },
                        })
                      }
                    >
                      <option value="">请选择实际撞针所在子件</option>
                      {project.parts
                        .filter((part) => draft.roles[part.id] === "moving")
                        .map((part) => (
                          <option key={part.id} value={part.id}>
                            {part.name}
                          </option>
                        ))}
                    </select>
                    <small>
                      开关：
                      {project.parts.find((part) => part.id === switchId)?.name}
                    </small>
                  </label>
                  <label className="me-field">
                    触发面所属子件
                    <select
                      aria-label="触发面所属子件"
                      value={contact.targetPartId ?? ""}
                      onChange={(event) => {
                        const nextTarget = event.target.value || switchId;
                        update({
                          contact: {
                            ...contact,
                            targetPartId: event.target.value || undefined,
                            switchPoint: ["", "", ""],
                            switchNormal: ["", "", ""],
                            actuatorPartIds: contact.actuatorPartIds
                              ? [
                                  ...new Set(
                                    contact.actuatorPartIds.map((id) =>
                                      id === targetId ? nextTarget : id,
                                    ),
                                  ),
                                ]
                              : undefined,
                          },
                        });
                      }}
                    >
                      <option value="">电气开关子件（默认）</option>
                      {project.parts
                        .filter(
                          (part) =>
                            draft.roles[part.id] === "fixed" ||
                            draft.roles[part.id] === "switch",
                        )
                        .map((part) => (
                          <option key={part.id} value={part.id}>
                            {part.name}
                          </option>
                        ))}
                    </select>
                    <small>
                      导线仍接电气开关；独立按杆的接触点和法向以此处所选子件为准。
                    </small>
                  </label>
                  <VectorFields
                    label="撞针局部端点"
                    value={contact.strikerPoint}
                    onChange={(strikerPoint) =>
                      update({ contact: { ...contact, strikerPoint } })
                    }
                  />
                  <VectorFields
                    label="开关局部触发点"
                    value={contact.switchPoint}
                    onChange={(switchPoint) =>
                      update({ contact: { ...contact, switchPoint } })
                    }
                  />
                  <VectorFields
                    label="开关触发面法向"
                    unit="单位向量"
                    value={contact.switchNormal}
                    onChange={(switchNormal) =>
                      update({ contact: { ...contact, switchNormal } })
                    }
                  />
                  <ParameterFields
                    fields={[
                      {
                        key: "radius",
                        label: "触发面有效半径",
                        unit: "mm",
                        min: 0.001,
                      },
                      {
                        key: "maxOvertravel",
                        label: "允许过行程",
                        unit: "mm",
                        min: 0,
                      },
                    ]}
                    values={{
                      radius: contact.radius,
                      maxOvertravel: contact.maxOvertravel,
                    }}
                    label="接触参数"
                    onChange={(values) =>
                      update({
                        contact: {
                          ...contact,
                          radius: values.radius,
                          maxOvertravel: values.maxOvertravel,
                        },
                      })
                    }
                  />
                  <fieldset className="me-actuators">
                    <legend>开关触头随动</legend>
                    <label>
                      <input
                        type="checkbox"
                        aria-label="启用触头随动"
                        checked={Boolean(contact.actuatorPartIds?.length)}
                        onChange={(event) =>
                          update({
                            contact: {
                              ...contact,
                              actuatorPartIds: event.target.checked
                                ? [targetId!]
                                : undefined,
                            },
                          })
                        }
                      />
                      撞针接触后，触头随允许的过行程压入
                    </label>
                    <p className="me-note">
                      仅选择实际可压入的按杆或触头，固定开关主体保持原位。实际触发面所属子件必须随动；所有触头需要解除零件固定锁。
                    </p>
                    {contact.actuatorPartIds &&
                      project.parts
                        .filter(
                          (part) =>
                            draft.roles[part.id] === "fixed" ||
                            draft.roles[part.id] === "switch",
                        )
                        .map((part) => (
                          <label key={part.id}>
                            <input
                              type="checkbox"
                              aria-label={`随动触头 ${part.name}`}
                              checked={contact.actuatorPartIds!.includes(
                                part.id,
                              )}
                              disabled={part.id === targetId}
                              onChange={(event) =>
                                update({
                                  contact: {
                                    ...contact,
                                    actuatorPartIds: event.target.checked
                                      ? [...contact.actuatorPartIds!, part.id]
                                      : contact.actuatorPartIds!.filter(
                                          (id) => id !== part.id,
                                        ),
                                  },
                                })
                              }
                            />
                            {part.name}
                            {part.id === targetId ? "（触发面，必选）" : ""}
                            {part.fixed ? " · 零件已固定" : ""}
                          </label>
                        ))}
                  </fieldset>
                  {contactMetrics && (
                    <p className="me-note">
                      根据当前装配计算：零位到首次接触{" "}
                      {Number(contactMetrics.triggerTravel.toFixed(3))}{" "}
                      mm，法向间距 {Number(contactMetrics.gap.toFixed(3))}{" "}
                      mm。最终导通仍由每帧实际接触决定。
                    </p>
                  )}
                </div>
              )}
              <details className="me-section">
                <summary>组件整体坐标系</summary>
                <p className="me-note">
                  {initial
                    ? "现有组件的坐标系在此只读。请关闭编辑器，通过右侧“整体变换”移动全部子件并检查路径。"
                    : "当前子件位置作为装配基准；代理位置相对此坐标系填写。创建后通过右侧整体变换移动全部成员。"}
                </p>
                <fieldset
                  className="me-calibration"
                  disabled={Boolean(initial)}
                >
                  <VectorFields
                    label="组件坐标原点"
                    value={draft.position}
                    onChange={(position) => update({ position })}
                  />
                  <VectorFields
                    label="组件坐标旋转"
                    unit="°"
                    value={draft.rotation}
                    onChange={(rotation) => update({ rotation })}
                  />
                </fieldset>
              </details>
              <ProxyFields
                label="活动"
                value={draft.moving}
                onChange={(moving) => update({ moving })}
                onEstimate={() => estimateProxy("moving")}
              />
              <ProxyFields
                label="固定"
                value={draft.fixed}
                onChange={(fixed) => update({ fixed })}
                onEstimate={() => estimateProxy("fixed")}
              />
            </fieldset>
            <div className="me-warning">
              <AlertTriangle size={14} />
              <span>
                初始外接尺寸仅供填写参考。代理必须覆盖实际参与接触的部位；固定包络不可堵住活动行程。原网格、摩擦、疲劳和实体制造仍需核对。
                {hasBayonet &&
                  "旋锁仅支持标准45°两耳代理：公16×24×16、母24×18×24 mm。"}
              </span>
            </div>
            {errors.length ? (
              <div className="me-errors" role="status">
                <strong>定义尚未完成</strong>
                <ul>
                  {errors.map((error, index) => (
                    <li key={index}>{error}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="me-ready">
                参数完整，可启用功能代理；保存后仍需运行装配与动作验证。
              </p>
            )}
            {feedback && (
              <div className="me-errors" role="alert">
                {feedback}
              </div>
            )}
          </div>
        </div>
        <footer className="me-footer">
          <p>子件保留原模型、材质和分组。保存预览不会获得功能验证通过。</p>
          <button disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            disabled={
              busy || Boolean(structureError) || conflicts || calibrationLocked
            }
            onClick={() => void save("unconfigured")}
          >
            保存组件预览
          </button>
          <button
            className="primary"
            disabled={busy || errors.length > 0}
            onClick={() => void save("configured")}
          >
            {busy ? "保存中…" : "保存并启用组件"}
          </button>
        </footer>
      </section>
    </div>
  );
}
