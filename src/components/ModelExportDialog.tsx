import { useEffect, useId, useRef, useState } from "react";
import { Download, LoaderCircle, X } from "lucide-react";
import "./ModelExportDialog.css";

interface Props {
  partCount: number;
  wireCount: number;
  onClose: () => void;
  onExport: (format: "glb" | "stl") => Promise<boolean>;
}

export default function ModelExportDialog({
  partCount,
  wireCount,
  onClose,
  onExport,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const initialFormatRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const [format, setFormat] = useState<"glb" | "stl">("glb");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const id = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement;
    dialog.showModal();
    initialFormatRef.current?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus({ preventScroll: true });
    };
  }, []);

  function close() {
    if (!busyRef.current) onClose();
  }

  async function exportModel() {
    if (busyRef.current) return;
    busyRef.current = true;
    // Keep keyboard events inside the modal when all form controls are disabled.
    dialogRef.current?.focus({ preventScroll: true });
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (await onExport(format)) onClose();
      else setNotice("已取消保存，可继续选择格式并导出。");
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : "模型导出失败，请重试。",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="model-export-dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-scope`}
      aria-busy={busy}
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key !== "Tab") return;
        const controls = event.currentTarget.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
        );
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!first) {
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      onKeyUp={(event) => event.stopPropagation()}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void exportModel();
        }}
      >
        <header className="model-export-header">
          <span className="model-export-icon" aria-hidden="true">
            <Download size={22} />
          </span>
          <div>
            <h2 id={`${id}-title`}>导出整体模型</h2>
            <p>
              {partCount} 个可见零件 · {wireCount} 根导线
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭模型导出"
            disabled={busy}
            onClick={close}
          >
            <X size={19} aria-hidden="true" />
          </button>
        </header>

        <div className="model-export-body">
          <p id={`${id}-scope`} className="model-export-scope">
            导出当前可见零件和导线的姿态。隐藏零件、参考网格、地板及辅助标记不包含在文件中。
          </p>
          <fieldset className="model-export-formats" disabled={busy}>
            <legend>文件格式</legend>
            <label className={format === "glb" ? "selected" : ""}>
              <input
                ref={initialFormatRef}
                type="radio"
                name={`${id}-format`}
                value="glb"
                checked={format === "glb"}
                onChange={() => {
                  setFormat("glb");
                  setError(null);
                  setNotice(null);
                }}
                aria-describedby={`${id}-glb-description`}
              />
              <span>
                <strong>
                  GLB <small>推荐</small>
                </strong>
                <span id={`${id}-glb-description`}>
                  保留 PBR 材质与零件层级；单位为米。适合三维预览和继续编辑。
                </span>
              </span>
            </label>
            <label className={format === "stl" ? "selected" : ""}>
              <input
                type="radio"
                name={`${id}-format`}
                value="stl"
                checked={format === "stl"}
                onChange={() => {
                  setFormat("stl");
                  setError(null);
                  setNotice(null);
                }}
                aria-describedby={`${id}-stl-description`}
              />
              <span>
                <strong>
                  STL <small>二进制</small>
                </strong>
                <span id={`${id}-stl-description`}>
                  仅导出几何，不保留颜色或零件层级。坐标按毫米写入，导入时请选择毫米。
                </span>
              </span>
            </label>
          </fieldset>
          {error && (
            <p className="model-export-error" role="alert">
              {error}
            </p>
          )}
          <p className="model-export-status" role="status" aria-live="polite">
            {busy ? "正在生成并保存模型，请稍候…" : notice}
          </p>
        </div>

        <footer className="model-export-footer">
          <button type="button" disabled={busy} onClick={close}>
            取消
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? (
              <LoaderCircle
                size={15}
                className="model-export-spinner"
                aria-hidden="true"
              />
            ) : (
              <Download size={15} aria-hidden="true" />
            )}
            {busy ? "正在导出…" : `导出 ${format.toUpperCase()}`}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
