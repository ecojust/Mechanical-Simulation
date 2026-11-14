import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, CircleDot, Lightbulb } from "lucide-react";
import type { Mechanism, MechanismStates } from "../types";
import type { MechanismContactState } from "../mechanisms";
import "./PressBench.css";

export interface PressBenchProps {
  mechanisms: Mechanism[];
  contacts: Record<string, MechanismContactState>;
  states: MechanismStates;
  poweredLampIds: string[];
  heldId: string | null;
  onPress: (id: string) => void;
  onRelease: () => void;
  onSelect: (id: string) => void;
  disabled?: boolean;
}
type Holding = {
  id: string;
  button: HTMLButtonElement;
  pointerId?: number;
  key?: string;
};
const pressKey = (key: string) => key === " " || key === "Enter";

/** A hold-to-test surface. Contact/lamp states always come from the shared simulation. */
export default function PressBench({
  mechanisms,
  contacts,
  states,
  poweredLampIds,
  heldId,
  onPress,
  onRelease,
  onSelect,
  disabled = false,
}: PressBenchProps) {
  const [expanded, setExpanded] = useState(true);
  const controlsId = useId();
  const presses = mechanisms.filter((mechanism) => mechanism.kind === "press");
  const holding = useRef<Holding | null>(null);
  const callbacks = useRef({ onPress, onRelease, onSelect });
  callbacks.current = { onPress, onRelease, onSelect };
  const release = (notify = true) => {
    const active = holding.current;
    if (!active) return;
    // Clear before releasing capture: lostpointercapture may run synchronously.
    holding.current = null;
    if (active.pointerId !== undefined) {
      try {
        if (active.button.hasPointerCapture?.(active.pointerId))
          active.button.releasePointerCapture(active.pointerId);
      } catch {
        /* The browser may already have cancelled this pointer during blur/unmount. */
      }
    }
    if (notify) callbacks.current.onRelease();
  };
  useEffect(() => {
    const pointerEnd = (event: PointerEvent) => {
      if (holding.current?.pointerId === event.pointerId) release();
    };
    const keyEnd = (event: KeyboardEvent) => {
      if (holding.current?.key === event.key) release();
    };
    const stop = () => release();
    const visibility = () => {
      if (document.hidden) release();
    };
    window.addEventListener("pointerup", pointerEnd);
    window.addEventListener("pointercancel", pointerEnd);
    window.addEventListener("keyup", keyEnd);
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      release();
      window.removeEventListener("pointerup", pointerEnd);
      window.removeEventListener("pointercancel", pointerEnd);
      window.removeEventListener("keyup", keyEnd);
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  useEffect(() => {
    if (holding.current && holding.current.id !== heldId) release(false);
  }, [heldId]);
  useEffect(() => {
    const current = holding.current;
    if (
      current &&
      (disabled ||
        !presses.some(
          (mechanism) =>
            mechanism.id === current.id && mechanism.status === "configured",
        ))
    )
      release();
  }, [disabled, mechanisms]);

  function begin(mechanism: Mechanism, input: Holding) {
    if (
      !expanded ||
      disabled ||
      mechanism.status !== "configured" ||
      holding.current?.id === mechanism.id
    )
      return;
    release();
    holding.current = input;
    callbacks.current.onSelect(mechanism.id);
    callbacks.current.onPress(mechanism.id);
  }
  if (!presses.length) return null;
  const litCount = new Set(poweredLampIds).size;
  return (
    <section
      className={`press-bench${expanded ? "" : " collapsed"}`}
      aria-label="按键试验台"
      data-testid="press-bench"
    >
      <header className="press-bench-heading">
        <h3>
          <button
            type="button"
            className="press-bench-toggle"
            aria-expanded={expanded}
            aria-controls={controlsId}
            aria-label={`${expanded ? "收起" : "展开"}按键试验台`}
            onClick={() => {
              if (expanded) release();
              setExpanded(!expanded);
            }}
          >
            <CircleDot size={16} aria-hidden="true" />
            <span>
              按键试验台
              <small>{presses.length} 个按键 · 按住试验，松手回弹</small>
            </span>
            <ChevronDown
              size={15}
              className="press-bench-chevron"
              aria-hidden="true"
            />
          </button>
        </h3>
        <span
          className={`press-bench-lamps ${litCount ? "lit" : ""}`}
          role="status"
          aria-label={`当前亮灯 ${litCount} 盏`}
        >
          <Lightbulb size={14} aria-hidden="true" />
          <b>{litCount}</b>
          <small>亮灯</small>
        </span>
      </header>
      <div id={controlsId} hidden={!expanded}>
        {disabled && <p className="press-bench-paused">启用仿真后可按压试验。</p>}
        <div className="press-bench-grid">
          {presses.map((mechanism) => {
            const contact = contacts[mechanism.id];
            const held = heldId === mechanism.id;
            const displacement = states[mechanism.id]?.displacement ?? 0;
            const status =
              mechanism.status !== "configured"
                ? "参数待配置"
                : contact?.pressed
                  ? "接触导通"
                  : contact?.touching
                    ? "接触未触发"
                    : contact
                      ? "分离"
                      : "触点未配置";
            return (
              <button
                key={mechanism.id}
                type="button"
                className={`press-bench-key ${held ? "held" : ""} ${contact?.pressed ? "conducting" : ""}`}
                data-mechanism-id={mechanism.id}
                data-contact={contact?.pressed ? "closed" : "open"}
                aria-label={`按住 ${mechanism.name}`}
                aria-pressed={held}
                title={`${mechanism.name}；按住鼠标、空格或 Enter，松手释放`}
                disabled={disabled || mechanism.status !== "configured"}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  event.currentTarget.focus({ preventScroll: true });
                  begin(mechanism, {
                    id: mechanism.id,
                    button: event.currentTarget,
                    pointerId: event.pointerId,
                  });
                  if (holding.current?.pointerId === event.pointerId)
                    try {
                      event.currentTarget.setPointerCapture(event.pointerId);
                    } catch {
                      /* Window pointerup remains the fallback. */
                    }
                }}
                onPointerUp={(event) => {
                  if (holding.current?.pointerId === event.pointerId) release();
                }}
                onPointerCancel={(event) => {
                  if (holding.current?.pointerId === event.pointerId) release();
                }}
                onLostPointerCapture={(event) => {
                  if (holding.current?.pointerId === event.pointerId) release();
                }}
                onKeyDown={(event) => {
                  if (!pressKey(event.key)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  if (!event.repeat)
                    begin(mechanism, {
                      id: mechanism.id,
                      button: event.currentTarget,
                      key: event.key,
                    });
                }}
                onKeyUp={(event) => {
                  if (!pressKey(event.key)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  if (holding.current?.key === event.key) release();
                }}
                onBlur={() => {
                  if (holding.current?.id === mechanism.id) release();
                }}
                onClick={() => callbacks.current.onSelect(mechanism.id)}
              >
                <strong>{mechanism.name}</strong>
                <span className="press-bench-contact">
                  <i aria-hidden="true" />
                  {status}
                </span>
                <span className="press-bench-stroke">
                  {Number.isFinite(displacement) ? displacement.toFixed(2) : "—"}
                  <small> mm</small>
                </span>
              </button>
            );
          })}
        </div>
        <p className="press-bench-hint">
          <kbd>Space</kbd> / <kbd>Enter</kbd> 按住 · 松开释放
        </p>
      </div>
    </section>
  );
}
