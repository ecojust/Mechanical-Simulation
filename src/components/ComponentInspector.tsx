import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Box, Check, ChevronDown, Settings2 } from "lucide-react";
import {
  componentPartIssues,
  getComponentTypeSchemas,
  validateInteractionProfile,
} from "../componentRegistry";
import type { InteractionProfile, Part, PartKind, Vec3 } from "../types";
import "./ComponentInspector.css";

interface Props {
  part: Part;
  onApply: (next: Part) => void;
}
type Triple = [string, string, string];
const AXES: { key: string; label: string; vector: Vec3 }[] = [
  { key: "+y", label: "正 Y · 向上", vector: [0, 1, 0] },
  { key: "-y", label: "负 Y · 向下", vector: [0, -1, 0] },
  { key: "+x", label: "正 X", vector: [1, 0, 0] },
  { key: "-x", label: "负 X", vector: [-1, 0, 0] },
  { key: "+z", label: "正 Z", vector: [0, 0, 1] },
  { key: "-z", label: "负 Z", vector: [0, 0, -1] },
];
const triple = (values: Vec3): Triple => values.map(String) as Triple;
const numbers = (values: Triple, name: string, positive = false): Vec3 => {
  if (
    values.some(
      (value) =>
        !value.trim() ||
        !Number.isFinite(Number(value)) ||
        Math.abs(Number(value)) > 100_000 ||
        (positive && Number(value) <= 0),
    )
  ) {
    throw Error(`${name}需要三个${positive ? "大于零的" : ""}有限数值。`);
  }
  return values.map(Number) as Vec3;
};
function VectorFields({
  label,
  value,
  onChange,
  positive = false,
  unit = "mm",
}: {
  label: string;
  value: Triple;
  onChange: (value: Triple) => void;
  positive?: boolean;
  unit?: string;
}) {
  return (
    <fieldset className="ci-vector">
      <legend>
        {label}
        <small>{unit}</small>
      </legend>
      <div>
        {["X", "Y", "Z"].map((axis, index) => (
          <label key={axis}>
            <span>{axis}</span>
            <input
              type="number"
              aria-label={`${label} ${axis}`}
              value={value[index]}
              min={positive ? 0.001 : undefined}
              step={0.1}
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
function valuesFor(part: Part): Record<string, string> {
  const values: Record<string, string> = {};
  const schema = getComponentTypeSchemas().find(
    (item) => item.kind === part.kind,
  )!;
  for (const field of schema.fields) {
    const value =
      field.group === "params"
        ? part.params[field.key]
        : part.interaction?.[field.key as keyof InteractionProfile];
    if (typeof value === "number")
      values[`${field.group}:${field.key}`] = String(value);
  }
  return values;
}

/** Edits instance semantics without replacing its uploaded/repository appearance. */
export default function ComponentInspector({ part, onApply }: Props) {
  const schemas = useMemo(getComponentTypeSchemas, []);
  const [expanded, setExpanded] = useState(false);
  const [kind, setKind] = useState<PartKind>(part.kind);
  const [values, setValues] = useState<Record<string, string>>(() =>
    valuesFor(part),
  );
  const [axis, setAxis] = useState<Triple>(() =>
    triple(part.interaction?.axis ?? [0, 1, 0]),
  );
  const [customAxis, setCustomAxis] = useState(false);
  const [anchor, setAnchor] = useState<Triple>(() =>
    triple(part.interaction?.anchor ?? [0, 0, 0]),
  );
  const [proxySize, setProxySize] = useState<Triple>(() =>
    triple(part.interaction?.proxySize ?? part.size),
  );
  const [family, setFamily] = useState(part.interaction?.mateFamily ?? "");
  const [feedback, setFeedback] = useState("");
  const fingerprint = JSON.stringify([
    part.id,
    part.kind,
    part.params,
    part.interaction,
    part.size,
  ]);
  useEffect(() => {
    setKind(part.kind);
    setValues(valuesFor(part));
    setCustomAxis(false);
    setAxis(triple(part.interaction?.axis ?? [0, 1, 0]));
    setAnchor(triple(part.interaction?.anchor ?? [0, 0, 0]));
    setProxySize(triple(part.interaction?.proxySize ?? part.size));
    setFamily(part.interaction?.mateFamily ?? "");
    setFeedback("");
    // The fingerprint deliberately ignores position/rotation so moving the model
    // does not erase an unfinished form, but external parameter changes do.
  }, [fingerprint]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setExpanded(false), [part.id]);
  const schema = schemas.find((item) => item.kind === kind)!;
  const currentSchema = schemas.find((item) => item.kind === part.kind)!;
  const isBuiltin =
    !part.model &&
    !part.params.assetUrl &&
    !part.interaction &&
    part.kind !== "asset";
  const currentErrors = componentPartIssues(part).filter(
    (issue) => issue.severity === "error",
  );
  const status = isBuiltin
    ? "内置参数化组件"
    : part.interaction?.status === "configured" && !currentErrors.length
      ? "参数已配置 · 代理验证"
      : part.kind === "asset" && !part.interaction
        ? "仅空间预检"
        : "参数待完成 · 仅预览";
  const axisKey = customAxis
    ? "custom"
    : (AXES.find((item) =>
        item.vector.every(
          (value, i) => Math.abs(value - Number(axis[i])) < 1e-6,
        ),
      )?.key ?? "custom");

  function candidate(status: InteractionProfile["status"]): Part {
    const params: Part["params"] = kind === part.kind ? { ...part.params } : {};
    // The visual asset identity never becomes a functional numeric parameter.
    for (const key of ["assetUrl", "assetNode"] as const)
      if (part.params[key] !== undefined) params[key] = part.params[key];
    const profile: InteractionProfile = {
      version: 1,
      status,
      axis: numbers(axis, "配合方向"),
      anchor: numbers(anchor, "功能锚点"),
      proxySize: numbers(proxySize, "代理尺寸", true),
      ...(schema.requiresMating ? { mateFamily: family.trim() } : {}),
    };
    for (const field of schema.fields) {
      const raw = values[`${field.group}:${field.key}`]?.trim() ?? "";
      if (!raw) {
        if (field.group === "params") delete params[field.key];
        continue;
      }
      const value = Number(raw);
      const max = field.key === "lockAngle" ? 45 : field.max;
      if (
        !Number.isFinite(value) ||
        value < field.min ||
        (max !== undefined && value > max)
      )
        throw Error(
          `${field.label}须在 ${field.min}${max === undefined ? " 以上" : ` 至 ${max}`} ${field.unit} 范围内。`,
        );
      if (field.group === "params") params[field.key] = value;
      else (profile as unknown as Record<string, unknown>)[field.key] = value;
    }
    return {
      ...part,
      kind,
      params,
      interaction: validateInteractionProfile(profile),
    };
  }
  let draft: Part | undefined;
  let structureError = "";
  try {
    draft = candidate("configured");
  } catch (error) {
    structureError = (error as Error).message;
  }
  const draftErrors = draft
    ? componentPartIssues(draft).filter((issue) => issue.severity === "error")
    : [];
  function save(status: InteractionProfile["status"]) {
    try {
      const next = candidate(status);
      const errors = componentPartIssues(next).filter(
        (issue) => issue.severity === "error",
      );
      if (status === "configured" && errors.length) {
        setFeedback(errors.map((issue) => issue.detail).join("\n"));
        return;
      }
      onApply(next);
      setFeedback("");
      setExpanded(false);
    } catch (error) {
      setFeedback((error as Error).message);
    }
  }
  function changeKind(next: PartKind) {
    // Only retain values explicitly entered for fields shared by both types.
    const allowed = new Set(
      schemas
        .find((item) => item.kind === next)!
        .fields.map((field) => `${field.group}:${field.key}`),
    );
    setValues((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([key]) => allowed.has(key)),
      ),
    );
    setKind(next);
    setFeedback("");
  }

  return (
    <section className="ci-panel" aria-label="组件类型与交互定义">
      <div className="ci-heading">
        <Box size={15} />
        <strong>{currentSchema.label}</strong>
        <span
          className={`ci-status ${isBuiltin || (part.interaction?.status === "configured" && !currentErrors.length) ? "ready" : ""}`}
        >
          {isBuiltin
            ? "标准件"
            : part.interaction?.status === "configured" && !currentErrors.length
              ? "已配置"
              : "待配置"}
        </span>
      </div>
      <p className="ci-current-status">{status}</p>
      <div className="ci-capabilities">
        <span>
          {currentSchema.role === "male"
            ? "公件配合"
            : currentSchema.role === "female"
              ? "母件配合"
              : "空间检查"}
        </span>
        {currentSchema.supportsPress && <span>按压 / 回弹</span>}
        {currentSchema.supportsElectrical && <span>电气端子</span>}
      </div>
      <button
        type="button"
        className="ci-edit-toggle"
        aria-expanded={expanded}
        onClick={() => {
          setExpanded((value) => !value);
          setFeedback("");
        }}
      >
        <Settings2 size={13} />
        配置类型与交互
        <ChevronDown
          size={13}
          style={{ transform: expanded ? "rotate(180deg)" : undefined }}
        />
      </button>
      {expanded && (
        <div className="ci-editor">
          <label className="ci-type-field">
            功能类型
            <select
              aria-label="组件功能类型"
              value={kind}
              onChange={(event) => changeKind(event.target.value as PartKind)}
            >
              {schemas.map((item) => (
                <option value={item.kind} key={item.kind}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <p className="ci-description">{schema.description}</p>
          <label className="ci-type-field">
            {schema.requiresMating ? "配合 / 插入方向" : "局部功能方向"}
            <select
              aria-label="配合方向"
              value={axisKey}
              onChange={(event) => {
                setCustomAxis(event.target.value === "custom");
                const value = AXES.find(
                  (item) => item.key === event.target.value,
                );
                if (value) setAxis(triple(value.vector));
              }}
            >
              <option value="custom">自定义单位向量</option>
              {AXES.map((item) => (
                <option value={item.key} key={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          {axisKey === "custom" && (
            <>
              <VectorFields
                label="方向向量"
                value={axis}
                onChange={setAxis}
                unit="单位向量"
              />
              <button
                type="button"
                className="ci-normalize"
                onClick={() => {
                  try {
                    const value = numbers(axis, "方向向量");
                    const norm = Math.hypot(...value);
                    if (norm < 1e-12) throw Error("方向不能是零向量。");
                    setAxis(triple(value.map((n) => n / norm) as Vec3));
                    setFeedback("");
                  } catch (error) {
                    setFeedback((error as Error).message);
                  }
                }}
              >
                归一化方向
              </button>
            </>
          )}
          <VectorFields label="功能锚点" value={anchor} onChange={setAnchor} />
          <VectorFields
            label="代理尺寸"
            value={proxySize}
            onChange={setProxySize}
            positive
          />
          <p className="ci-field-help">
            锚点相对模型中心；代理 Y
            是声明的功能轴。仅改变验证代理，不缩放原模型。
          </p>
          {schema.requiresMating && (
            <label className="ci-type-field">
              配合族 <b>*</b>
              <input
                aria-label="配合族"
                value={family}
                maxLength={100}
                onChange={(event) => setFamily(event.target.value)}
                placeholder="例如：按钮定位销 A"
              />
              <small>只有同族公母组件参与配合检查。</small>
            </label>
          )}
          {schema.fields.map((field) => {
            const key = `${field.group}:${field.key}`;
            return (
              <label className="ci-parameter" key={key}>
                <span>
                  {field.label}
                  {field.required && <b>*</b>}
                </span>
                <input
                  type="number"
                  aria-label={`交互参数 ${field.label}`}
                  value={values[key] ?? ""}
                  min={field.min}
                  max={field.key === "lockAngle" ? 45 : field.max}
                  step="any"
                  placeholder={field.key === "lockAngle" ? "45" : "必填"}
                  onChange={(event) =>
                    setValues((previous) => ({
                      ...previous,
                      [key]: event.target.value,
                    }))
                  }
                />
                <small>{field.unit}</small>
              </label>
            );
          })}
          {kind.startsWith("bayonet-") && (
            <p className="ci-proxy-note">
              旋锁只支持已验证的标准 45° 双耳代理：公件 16 × 24 × 16，母件 24 ×
              18 × 24 mm。其他卡扣形状不能凭外观自动认证。
            </p>
          )}
          <div className="ci-proxy-note">
            <AlertCircle size={13} />
            <span>
              上传或原始素材的功能由声明的代理求解；完整参数不代表原网格已通过实体碰撞认证。
            </span>
          </div>
          {(structureError || draftErrors.length > 0) && (
            <div className="ci-validation" role="status">
              <strong>配置尚未完成</strong>
              <ul>
                {structureError ? (
                  <li>{structureError}</li>
                ) : (
                  draftErrors.map((issue) => (
                    <li key={issue.id}>
                      {issue.detail.replace(`${part.name}：`, "")}
                    </li>
                  ))
                )}
              </ul>
            </div>
          )}
          {feedback && (
            <p className="ci-feedback" role="alert">
              {feedback}
            </p>
          )}
          <div className="ci-actions">
            <button
              type="button"
              disabled={Boolean(structureError)}
              onClick={() => save("unconfigured")}
            >
              保存为预览
            </button>
            <button
              type="button"
              className="ci-apply"
              disabled={Boolean(structureError) || draftErrors.length > 0}
              onClick={() => save("configured")}
            >
              <Check size={12} />
              保存交互配置
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
