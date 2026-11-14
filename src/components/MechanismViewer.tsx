import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, Box, Layers3, Maximize2, X } from "lucide-react";
import type { Mechanism, Part, UploadedModel } from "../types";
import { buildMechanismPreview } from "../mechanismPreview";
import Viewport from "./Viewport";
import "./MechanismViewer.css";

export interface MechanismViewerProps {
  mechanism: Mechanism;
  parts: Part[];
  models?: UploadedModel[];
  onClose: () => void;
}
const noTransform = () => {};
const emptyIds: string[] = [];
const emptyWires: [] = [];
const millimetres = (value: number) => Number(value.toFixed(2)).toString();

export default function MechanismViewer({ mechanism, parts, models, onClose }: MechanismViewerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const closeCallback = useRef(onClose);
  closeCallback.current = onClose;
  const titleId = useId();
  const descriptionId = useId();
  const [layered, setLayered] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fitRevision, setFitRevision] = useState(0);
  const preview = useMemo(() => buildMechanismPreview(mechanism, parts, layered), [mechanism, parts, layered]);
  const previewParts = useMemo(() => preview.members.map((member) => member.preview), [preview]);
  const selected = preview.members.find((member) => member.original.id === selectedId);

  useEffect(() => {
    const dialog = dialogRef.current!;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    closeRef.current?.focus();
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    setSelectedId(null);
    setLayered(true);
    setFitRevision((revision) => revision + 1);
  }, [mechanism.id]);

  function changeView(nextLayered: boolean) {
    setLayered(nextLayered);
    setFitRevision((revision) => revision + 1);
  }

  return createPortal(
    <dialog
      ref={dialogRef}
      className="mechanism-viewer"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-modal="true"
      data-testid="mechanism-viewer"
      onCancel={(event) => {
        event.preventDefault();
        closeCallback.current();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          closeCallback.current();
        } else if (event.key === "Tab") {
          const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
          )].filter((element) => element.getClientRects().length > 0);
          const first = buttons[0], last = buttons[buttons.length - 1];
          if (first && last) {
            if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }
      }}
      onKeyUp={(event) => event.stopPropagation()}
    >
      <header className="mechanism-viewer-header">
        <Layers3 size={21} aria-hidden="true" />
        <div>
          <small>功能组件查看</small>
          <h2 id={titleId}>{mechanism.name}</h2>
        </div>
        <button ref={closeRef} type="button" className="mechanism-viewer-close" onClick={onClose} aria-label="关闭组件查看">
          <X size={20} aria-hidden="true" />
        </button>
      </header>
      <div className="mechanism-viewer-toolbar">
        <div role="group" aria-label="组件查看模式" className="mechanism-viewer-modes">
          <button type="button" aria-pressed={layered} onClick={() => changeView(true)}>
            <Layers3 size={15} aria-hidden="true" />分层视图
          </button>
          <button type="button" aria-pressed={!layered} onClick={() => changeView(false)}>
            <Box size={15} aria-hidden="true" />装配视图
          </button>
        </div>
        <button type="button" className="mechanism-viewer-fit" onClick={() => setFitRevision((revision) => revision + 1)}>
          <Maximize2 size={14} aria-hidden="true" />适应窗口
        </button>
      </div>
      <p id={descriptionId} className="mechanism-viewer-description">
        沿组件轴线从上到下查看 {preview.members.length} 个零件。拖动旋转，滚轮缩放；点击模型或列表高亮。
      </p>
      {preview.missingCount > 0 && <p role="alert" className="mechanism-viewer-warning">此组件有 {preview.missingCount} 个成员未找到。</p>}
      <div className="mechanism-viewer-body">
        <div className="mechanism-viewer-scene" aria-label="组件三维预览">
          <Viewport
            testId="mechanism-viewer-viewport"
            parts={previewParts}
            models={models}
            wires={emptyWires}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onTransform={noTransform}
            tool="select"
            view="front"
            showGrid={false}
            xray={false}
            exploded={false}
            running={false}
            pressedIds={emptyIds}
            poweredLampIds={emptyIds}
            collisionIds={emptyIds}
            resetKey={fitRevision}
          />
          <span className="mechanism-viewer-scene-label">
            <ArrowDown size={13} aria-hidden="true" />
            {layered ? `分层间距 ${millimetres(preview.gap)} mm` : "装配位置"}
          </span>
        </div>
        <aside className="mechanism-viewer-members" aria-label="组件成员">
          <div className="mechanism-viewer-list-heading"><span>从上到下</span><span>{preview.members.length} 件</span></div>
          <ol aria-label="从上到下的子零件">
            {preview.members.map(({ original, role }, index) => (
              <li key={original.id}>
                <button type="button" aria-pressed={selectedId === original.id} onClick={() => setSelectedId(original.id)} data-part-id={original.id}>
                  <span className="mechanism-viewer-number" aria-hidden="true">{index + 1}</span>
                  <span className="mechanism-viewer-member-text">
                    <strong>{original.name}</strong>
                    <span>{role}</span>
                    <small>{original.size.map(millimetres).join(" × ")} mm</small>
                  </span>
                  <i style={{ background: original.color }} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ol>
          {preview.members.length === 0 && <p className="mechanism-viewer-empty">此组件尚无可显示的成员。</p>}
        </aside>
      </div>
      <footer className="mechanism-viewer-footer">
        <span>{selected ? `已选：${selected.original.name}` : "选择零件查看对应位置"}</span>
        <small>只读预览 · 分层间距仅用于观察</small>
      </footer>
    </dialog>,
    document.body,
  );
}
