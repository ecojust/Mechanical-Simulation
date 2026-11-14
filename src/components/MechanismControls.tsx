import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Box,
  CircleDot,
  Layers3,
  LockKeyhole,
  RotateCcw,
  RotateCw,
  Settings2,
  Unlink,
  UnlockKeyhole,
} from "lucide-react";
import type { Issue, Mechanism, Part, Vec3 } from "../types";
import "./MechanismControls.css";

export type MechanismTransformRequest =
  | { mechanismId: string; kind: "frame"; frame: Mechanism["frame"] }
  | { mechanismId: string; kind: "moving"; distance?: number; angle?: number };
/** Derived from the scene contact solver; never inferred from a stroke threshold. */
export interface MechanismContactReadout {
  gap: number;
  surfaceGap?: number;
  overtravel?: number;
  actuatorTravel?: number;
  radial: number;
  triggerTravel: number;
  axisAlignment: number;
  pressed: boolean;
  touching: boolean;
  maxOvertravel: number;
  radius: number;
}
export interface MechanismControlsProps {
  mechanism: Mechanism;
  parts: Part[];
  issues?: Issue[];
  running: boolean;
  held: boolean;
  displacement?: number;
  force?: number;
  stateLabel?: string;
  contact?: MechanismContactReadout;
  busy?: boolean;
  onEdit: (mechanism: Mechanism) => void;
  onView?: (mechanism: Mechanism) => void;
  onRemove: (mechanismId: string) => void | Promise<void>;
  onTransform: (request: MechanismTransformRequest) => void | Promise<void>;
  onHeld: (held: boolean) => void;
}
type DraftVector = [string, string, string];
const draft = (vector: Vec3): DraftVector => vector.map(String) as DraftVector;
const display = (value: number | undefined, digits = 2) =>
  typeof value === "number" && Number.isFinite(value)
    ? Number(value.toFixed(digits)).toString()
    : "—";
function numericVector(value: DraftVector, label: string): Vec3 {
  if (
    value.some(
      (item) =>
        !item.trim() ||
        !Number.isFinite(Number(item)) ||
        Math.abs(Number(item)) > 100_000,
    )
  )
    throw Error(`${label}须为三个范围内的有限数值。`);
  return value.map(Number) as Vec3;
}
function VectorInput({
  label,
  unit,
  value,
  onChange,
  disabled,
}: {
  label: string;
  unit: string;
  value: DraftVector;
  onChange: (value: DraftVector) => void;
  disabled: boolean;
}) {
  return (
    <fieldset className="mc-vector" disabled={disabled}>
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
              step={unit === "mm" ? 1 : 5}
              onChange={(event) => {
                const next = [...value] as DraftVector;
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

/** Requests go through the parent's engine before any controlled pose or state changes. */
export default function MechanismControls({
  mechanism,
  parts,
  issues = [],
  running,
  held,
  displacement,
  force,
  stateLabel,
  contact,
  busy = false,
  onEdit,
  onView,
  onRemove,
  onTransform,
  onHeld,
}: MechanismControlsProps) {
  const [position, setPosition] = useState<DraftVector>(() =>
    draft(mechanism.frame.position),
  );
  const [rotation, setRotation] = useState<DraftVector>(() =>
    draft(mechanism.frame.rotation),
  );
  const [distanceStep, setDistanceStep] = useState("1");
  const [angleStep, setAngleStep] = useState("15");
  const [feedback, setFeedback] = useState("");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const holdingRef = useRef(false);
  const heldCallback = useRef(onHeld);
  heldCallback.current = onHeld;
  const frameKey = JSON.stringify([mechanism.id, mechanism.frame]);
  useEffect(() => {
    setPosition(draft(mechanism.frame.position));
    setRotation(draft(mechanism.frame.rotation));
  }, [frameKey]);
  useEffect(() => {
    setFeedback("");
    setDistanceStep("1");
    setAngleStep("15");
  }, [mechanism.id]);
  const release = () => {
    if (holdingRef.current) {
      holdingRef.current = false;
      heldCallback.current(false);
    }
  };
  useEffect(() => {
    const stop = () => {
      if (holdingRef.current) {
        holdingRef.current = false;
        heldCallback.current(false);
      }
    };
    const visibility = () => {
      if (document.hidden) stop();
    };
    window.addEventListener("blur", stop);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stop();
      window.removeEventListener("blur", stop);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [mechanism.id]);
  useEffect(() => {
    if (
      !running ||
      busy ||
      mechanism.status !== "configured" ||
      mechanism.kind !== "press"
    )
      release();
  }, [running, busy, mechanism.status, mechanism.kind]);
  const unavailable = busy || pending;
  const transformsDisabled = unavailable || running;
  const pressDisabled =
    unavailable || !running || mechanism.status !== "configured";
  const press = () => {
    if (pressDisabled || holdingRef.current) return;
    holdingRef.current = true;
    heldCallback.current(true);
  };
  async function perform(operation: () => void | Promise<void>) {
    if (pendingRef.current || busy) return;
    pendingRef.current = true;
    setPending(true);
    setFeedback("");
    try {
      await operation();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  function stepValue(value: string, label: string): number {
    const number = Number(value);
    if (
      !value.trim() ||
      !Number.isFinite(number) ||
      number <= 0 ||
      number > 100_000
    )
      throw Error(`${label}须大于零且不超过100,000。`);
    return number;
  }
  const move = (axis: "distance" | "angle", direction: number) =>
    perform(() =>
      onTransform({
        mechanismId: mechanism.id,
        kind: "moving",
        [axis]:
          direction *
          stepValue(
            axis === "distance" ? distanceStep : angleStep,
            axis === "distance" ? "位移步长" : "旋转步长",
          ),
      }),
    );
  const relevantIssues = issues.filter((issue) => issue.severity !== "pass");
  const hasErrors = relevantIssues.some((issue) => issue.severity === "error");
  const configured = mechanism.status === "configured";
  const nominal = (size: Vec3, expected: Vec3) =>
    size.every((value, index) => Math.abs(value - expected[index]) < 1e-6);
  const standardBayonet =
    configured &&
    mechanism.movingProxy.kind === "bayonet-pin" &&
    mechanism.fixedProxy.kind === "bayonet-socket" &&
    mechanism.params.lockAngle === 45 &&
    nominal(mechanism.movingProxy.size, [16, 24, 16]) &&
    nominal(mechanism.fixedProxy.size, [24, 18, 24]);
  const travel = mechanism.params.travel;
  const compressionRatio =
    typeof displacement === "number" && Number.isFinite(travel) && travel > 0
      ? Math.min(1, Math.max(0, displacement / travel))
      : 0;
  const members = new Map(parts.map((part) => [part.id, part]));
  const role = (id: string) => {
    const labels = [mechanism.movingPartIds.includes(id)
      ? "活动子组"
      : mechanism.springPartIds.includes(id)
        ? "弹簧"
        : mechanism.contact?.actuatorPartIds?.includes(id)
          ? "随动触头"
          : "固定子组"];
    if (mechanism.switchPartId === id) labels.push("电气开关");
    if ((mechanism.contact?.targetPartId ?? mechanism.switchPartId) === id)
      labels.push("触发面");
    return labels.join(" · ");
  };
  return (
    <section
      className="mc-panel"
      aria-label="功能组件操作"
      data-testid="mechanism-controls"
    >
      <div className="mc-heading">
        <Layers3 size={17} />
        <div>
          <small>
            {mechanism.kind === "press"
              ? "按压功能组件"
              : "插入 / 旋转配合组件"}
          </small>
          <h3>{mechanism.name}</h3>
        </div>
        <span
          className={`mc-status ${configured && !hasErrors ? "configured" : "incomplete"}`}
        >
          {configured ? (hasErrors ? "检查有误" : "参数已配置") : "待配置"}
        </span>
      </div>
      <div className="mc-meta">
        <span>{mechanism.partIds.length} 个成员</span>
        <span>{mechanism.movingPartIds.length} 个活动件</span>
      </div>
      <details className="mc-members">
        <summary>成员与功能角色</summary>
        <ul>
          {mechanism.partIds.map((id) => (
            <li key={id}>
              <Box size={12} />
              <span title={members.get(id)?.name ?? id}>
                {members.get(id)?.name ?? `缺失成员 ${id}`}
              </span>
              <small>{role(id)}</small>
            </li>
          ))}
        </ul>
      </details>
      {onView && (
        <button type="button" className="mc-edit" onClick={() => onView(mechanism)}>
          <Layers3 size={13} />
          查看组件分层
        </button>
      )}
      <button
        type="button"
        className="mc-edit"
        disabled={unavailable || running}
        onClick={() => onEdit(mechanism)}
      >
        <Settings2 size={13} />
        编辑成员、类型与交互参数
      </button>
      <div className="mc-section">
        <h4>整体变换</h4>
        <p className="mc-help">一起移动全部子件，保留组件内部的相对关系。</p>
        <VectorInput
          label="组件位置"
          unit="mm"
          value={position}
          onChange={setPosition}
          disabled={transformsDisabled}
        />
        <VectorInput
          label="组件旋转"
          unit="°"
          value={rotation}
          onChange={setRotation}
          disabled={transformsDisabled}
        />
        <button
          type="button"
          className="mc-apply"
          disabled={transformsDisabled}
          onClick={() =>
            void perform(() =>
              onTransform({
                mechanismId: mechanism.id,
                kind: "frame",
                frame: {
                  position: numericVector(position, "组件位置"),
                  rotation: numericVector(rotation, "组件旋转"),
                },
              }),
            )
          }
        >
          检查并应用整体变换
        </button>
      </div>
      <div className="mc-section mc-function">
        <h4>{mechanism.kind === "press" ? "按压与回弹" : "活动子组配合"}</h4>
        <p className="mc-axis">
          组件局部轴{" "}
          <code>
            [{mechanism.axis.map((value) => display(value, 3)).join(", ")}]
          </code>
        </p>
        {mechanism.kind === "press" ? (
          <>
            <div className="mc-readings">
              <div>
                <small>当前压缩</small>
                <strong>
                  {display(displacement)}
                  <em>mm</em>
                </strong>
              </div>
              <div>
                <small>当前力</small>
                <strong>
                  {display(force)}
                  <em>N</em>
                </strong>
              </div>
            </div>
            <div
              className="mc-travel"
              role="progressbar"
              aria-label="按压行程"
              aria-valuemin={0}
              aria-valuemax={Number.isFinite(travel) && travel > 0 ? travel : 1}
              aria-valuenow={Math.max(
                0,
                Math.min(travel || 1, displacement || 0),
              )}
            >
              <span style={{ width: `${compressionRatio * 100}%` }} />
            </div>
            <div className="mc-travel-caption">
              <span>0 mm</span>
              <span>行程 {display(travel)} mm</span>
            </div>
            <button
              type="button"
              className={`mc-press ${held ? "held" : ""}`}
              disabled={pressDisabled}
              aria-pressed={held}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.focus();
                event.currentTarget.setPointerCapture(event.pointerId);
                press();
              }}
              onPointerUp={release}
              onPointerCancel={release}
              onLostPointerCapture={release}
              onKeyDown={(event) => {
                if (event.key === " " || event.key === "Enter") {
                  event.preventDefault();
                  if (!event.repeat) press();
                }
              }}
              onKeyUp={(event) => {
                if (event.key === " " || event.key === "Enter") {
                  event.preventDefault();
                  release();
                }
              }}
              onBlur={release}
            >
              <CircleDot size={18} />
              {held ? "正在施力 · 松开回弹" : "按住施力"}
            </button>
            <p className="mc-state" aria-live="polite">
              {stateLabel ??
                (!running
                  ? "开始仿真后按住按钮，松手后观察弹簧回弹。"
                  : "等待按压；压缩量与作用力由仿真计算。")}
            </p>
            <div className="mc-contact" aria-label="撞针触点状态">
              <h5>撞针与开关触点</h5>
              {contact ? (
                <>
                  <div className="mc-contact-state" aria-live="polite">
                    <span>
                      {contact.radial > contact.radius + 1e-6
                        ? "横向偏离触点"
                        : contact.touching
                          ? contact.gap < -contact.maxOvertravel - 1e-6 ||
                            (Boolean(
                              mechanism.contact?.actuatorPartIds?.length,
                            ) &&
                              (contact.overtravel ?? 0) >
                                contact.maxOvertravel + 1e-6)
                            ? "撞针压入超限"
                            : "撞针已接触触点"
                          : "撞针与触点分离"}
                    </span>
                    <strong className={contact.pressed ? "closed" : "open"}>
                      {contact.pressed ? "开关闭合" : "开关断开"}
                    </strong>
                  </div>
                  <dl className="mc-contact-metrics">
                    <div>
                      <dt>当前表面间隙</dt>
                      <dd>
                        {display(contact.surfaceGap ?? contact.gap, 3)}{" "}
                        <span>mm</span>
                      </dd>
                    </div>
                    <div>
                      <dt>静止面参考间隙</dt>
                      <dd>
                        {display(contact.gap, 3)} <span>mm</span>
                      </dd>
                    </div>
                    {contact.overtravel !== undefined && (
                      <div>
                        <dt>轴向过行程</dt>
                        <dd>
                          {display(contact.overtravel, 3)} <span>mm</span>
                        </dd>
                      </div>
                    )}
                    {Boolean(mechanism.contact?.actuatorPartIds?.length) && (
                      <div>
                        <dt>触头随动位移</dt>
                        <dd>
                          {display(contact.actuatorTravel, 3)} <span>mm</span>
                        </dd>
                      </div>
                    )}
                    <div>
                      <dt>横向偏差</dt>
                      <dd>
                        {display(contact.radial, 3)} <span>mm</span>
                      </dd>
                    </div>
                    <div>
                      <dt>允许压入</dt>
                      <dd>
                        {display(contact.maxOvertravel, 3)} <span>mm</span>
                      </dd>
                    </div>
                    <div>
                      <dt>触点半径</dt>
                      <dd>
                        {display(contact.radius, 3)} <span>mm</span>
                      </dd>
                    </div>
                  </dl>
                  <p>
                    静止面参考间隙为负时表示压入，当前表面间隙包含触头随动。通断与过行程限制始终按原始触发面判定。
                  </p>
                </>
              ) : (
                <p className="mc-contact-pending">
                  触点几何待配置，当前无法判定接触和通断。
                </p>
              )}
            </div>
            {!configured && (
              <p className="mc-warning">
                请先完成成员角色、行程和弹簧参数配置。
              </p>
            )}
          </>
        ) : (
          <>
            <div className="mc-readings">
              <div>
                <small>已提交轴向位移</small>
                <strong>
                  {display(mechanism.pose.offset)}
                  <em>mm</em>
                </strong>
              </div>
              <div>
                <small>已提交相对角度</small>
                <strong>
                  {display(mechanism.pose.angle)}
                  <em>°</em>
                </strong>
              </div>
            </div>
            <label className="mc-step">
              轴向位移步长
              <input
                aria-label="组件位移步长"
                type="number"
                value={distanceStep}
                min={0.001}
                step={0.5}
                disabled={transformsDisabled}
                onChange={(event) => setDistanceStep(event.target.value)}
              />
              <span>mm</span>
            </label>
            <div className="mc-two-actions">
              <button
                type="button"
                disabled={transformsDisabled || !configured}
                onClick={() => void move("distance", -1)}
              >
                <ArrowDown size={13} />
                沿轴 −
              </button>
              <button
                type="button"
                disabled={transformsDisabled || !configured}
                onClick={() => void move("distance", 1)}
              >
                <ArrowUp size={13} />
                沿轴 ＋
              </button>
            </div>
            <label className="mc-step">
              绕轴旋转步长
              <input
                aria-label="组件旋转步长"
                type="number"
                value={angleStep}
                min={0.01}
                step={5}
                disabled={transformsDisabled}
                onChange={(event) => setAngleStep(event.target.value)}
              />
              <span>°</span>
            </label>
            <div className="mc-two-actions">
              <button
                type="button"
                disabled={transformsDisabled || !configured}
                onClick={() => void move("angle", -1)}
              >
                <RotateCcw size={13} />
                绕轴 −
              </button>
              <button
                type="button"
                disabled={transformsDisabled || !configured}
                onClick={() => void move("angle", 1)}
              >
                <RotateCw size={13} />
                绕轴 ＋
              </button>
            </div>
            {standardBayonet && (
              <div className="mc-bayonet">
                <p>
                  标准双耳旋锁：先沿定义轴装入槽底，再旋转至
                  45°。退出受阻时，先逆旋回零再退出。
                </p>
                <div className="mc-two-actions">
                  <button
                    type="button"
                    disabled={transformsDisabled}
                    onClick={() =>
                      void perform(() =>
                        onTransform({
                          mechanismId: mechanism.id,
                          kind: "moving",
                          angle: 45 - mechanism.pose.angle,
                        }),
                      )
                    }
                  >
                    <LockKeyhole size={12} />
                    转至 45°
                  </button>
                  <button
                    type="button"
                    disabled={transformsDisabled}
                    onClick={() =>
                      void perform(() =>
                        onTransform({
                          mechanismId: mechanism.id,
                          kind: "moving",
                          angle: -mechanism.pose.angle,
                        }),
                      )
                    }
                  >
                    <UnlockKeyhole size={12} />
                    逆旋回零
                  </button>
                </div>
              </div>
            )}
            <p className="mc-help">
              正负方向相对组件局部轴。每次位移和旋转都检查沿途干涉，受阻时保持原位。
            </p>
            {!configured && (
              <p className="mc-warning">
                完成公母代理尺寸、配合参数和活动成员后，可执行配合动作。
              </p>
            )}
          </>
        )}
      </div>
      {running && <p className="mc-help">暂停仿真后可编辑结构或整体位置。</p>}
      {relevantIssues.length > 0 && (
        <div className="mc-issues" aria-label="组件检查结果">
          <strong>当前检查</strong>
          <ul>
            {relevantIssues.slice(0, 6).map((issue) => (
              <li key={issue.id} className={issue.severity}>
                {issue.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
      {feedback && (
        <p className="mc-feedback" role="alert">
          {feedback}
        </p>
      )}
      <div className="mc-footer">
        <button
          type="button"
          disabled={unavailable || running}
          onClick={() => void perform(() => onRemove(mechanism.id))}
        >
          <Unlink size={12} />
          解除功能绑定
        </button>
        <small>保留全部子件和当前装配位置</small>
      </div>
    </section>
  );
}
