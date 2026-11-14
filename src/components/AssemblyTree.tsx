import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Eye,
  EyeOff,
  Layers3,
  Lightbulb,
  Link2,
  LockKeyhole,
  RotateCcw,
  Settings2,
  UnlockKeyhole,
  Zap,
} from "lucide-react";
import type { Mechanism, Part } from "../types";
import "./AssemblyTree.css";
interface Props {
  parts: Part[];
  selectedId: string | null;
  revealRequest?: number;
  onSelect: (id: string) => void;
  onUpdate: (part: Part) => void;
  mechanisms?: Mechanism[];
  selectedMechanismId?: string | null;
  onSelectMechanism?: (id: string) => void;
  onEditMechanism?: (id: string) => void;
}
interface TreeEntry {
  id: string;
  name?: string;
  parts: Part[];
}
const iconFor = (kind: Part["kind"]) =>
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
export default function AssemblyTree({
  parts,
  selectedId,
  revealRequest = 0,
  onSelect,
  onUpdate,
  mechanisms,
  selectedMechanismId,
  onSelectMechanism,
  onEditMechanism,
}: Props) {
  const [collapsed, setCollapsed] = useState(() => new Set<string>());
  const treeRef = useRef<HTMLDivElement>(null);
  const pendingReveal = useRef<string | null>(null);
  const mechanismEntries = useMemo(() => {
    const byId = new Map(parts.map((part) => [part.id, part]));
    const claimed = new Set<string>();
    const entries = (mechanisms ?? []).map((mechanism) => ({
      mechanism,
      parts: mechanism.partIds.flatMap((id) => {
        const part = byId.get(id);
        if (!part || claimed.has(id)) return [];
        claimed.add(id);
        return [part];
      }),
    }));
    return { entries, claimed };
  }, [parts, mechanisms]);
  const selectedParent = mechanismEntries.entries.find((entry) =>
    entry.parts.some((part) => part.id === selectedId),
  )?.mechanism.id;
  const selectedGroup = parts.find((part) => part.id === selectedId)
    ?.assemblyGroup?.id;
  useLayoutEffect(() => {
    // A repeated viewport click can reveal the same part after a manual collapse.
    // Ordinary simulation renders must preserve the user's scroll/collapse state.
    pendingReveal.current = selectedMechanismId ? null : selectedId;
    const id = selectedMechanismId ?? selectedParent;
    const key = id ? `mechanism:${id}` : selectedGroup;
    if (!key) return;
    setCollapsed((previous) => {
      if (!previous.has(key)) return previous;
      const next = new Set(previous);
      next.delete(key);
      return next;
    });
  }, [
    selectedParent,
    selectedGroup,
    selectedId,
    selectedMechanismId,
    revealRequest,
  ]);
  useLayoutEffect(() => {
    if (!pendingReveal.current) return;
    const row = treeRef.current?.querySelector<HTMLElement>(".tree-row.selected");
    // A collapsed parent is expanded in the preceding effect; wait for its row.
    if (!row || row.dataset.partId !== pendingReveal.current) return;
    pendingReveal.current = null;
    const scroller = treeRef.current?.closest<HTMLElement>(".assembly-scroll");
    if (!scroller) return;
    const bounds = scroller.getBoundingClientRect();
    const top = bounds.top + scroller.clientTop;
    const bottom = top + scroller.clientHeight;
    const rowBounds = row.getBoundingClientRect();
    const margin = 8;
    // Scroll only this sidebar, without moving the page or stealing keyboard focus.
    if (rowBounds.top < top + margin)
      scroller.scrollTop += rowBounds.top - top - margin;
    else if (rowBounds.bottom > bottom - margin)
      scroller.scrollTop += rowBounds.bottom - bottom + margin;
  });
  const entries = useMemo(() => {
    const result: TreeEntry[] = [];
    const groups = new Map<string, TreeEntry>();
    for (const part of parts) {
      if (mechanismEntries.claimed.has(part.id)) continue;
      if (!part.assemblyGroup) {
        result.push({ id: `part:${part.id}`, parts: [part] });
        continue;
      }
      let entry = groups.get(part.assemblyGroup.id);
      if (!entry) {
        entry = {
          id: part.assemblyGroup.id,
          name: part.assemblyGroup.name,
          parts: [],
        };
        groups.set(entry.id, entry);
        result.push(entry);
      }
      entry.parts.push(part);
    }
    return result;
  }, [parts, mechanismEntries]);
  const row = (part: Part) => {
    const Icon = iconFor(part.kind);
    const selected = !selectedMechanismId && selectedId === part.id;
    return (
      <div
        key={part.id}
        className={`tree-row ${selected ? "selected" : ""}`}
        data-part-id={part.id}
      >
        <button
          className="tree-select"
          aria-pressed={selected}
          onClick={() => onSelect(part.id)}
          title={part.name}
        >
          <Icon size={15} style={{ color: part.color }} />
          <span>{part.name}</span>
        </button>
        <button
          title={part.fixed ? "解锁零件" : "固定零件"}
          onClick={() => onUpdate({ ...part, fixed: !part.fixed })}
        >
          {part.fixed ? <LockKeyhole size={13} /> : <UnlockKeyhole size={13} />}
        </button>
        <button
          title={part.visible ? "隐藏零件" : "显示零件"}
          onClick={() => onUpdate({ ...part, visible: !part.visible })}
        >
          {part.visible ? <Eye size={14} /> : <EyeOff size={14} />}
        </button>
      </div>
    );
  };
  return (
    <div className="tree-list assembly-tree" ref={treeRef}>
      {mechanismEntries.entries.map(({ mechanism, parts: members }) => {
        const collapseKey = `mechanism:${mechanism.id}`;
        const open = !collapsed.has(collapseKey);
        const Icon = mechanism.kind === "press" ? CircleDot : Link2;
        const label = mechanism.kind === "press" ? "弹簧按钮" : "榫卯配合";
        return (
          <section
            key={mechanism.id}
            data-mechanism-id={mechanism.id}
            className={`assembly-tree-mechanism ${selectedMechanismId === mechanism.id ? "selected-mechanism" : ""}`}
          >
            <div className="mechanism-tree-heading">
              <button
                className="mechanism-tree-toggle"
                aria-expanded={open}
                aria-label={`${open ? "收起" : "展开"}功能组件：${mechanism.name}`}
                onClick={() =>
                  setCollapsed((previous) => {
                    const next = new Set(previous);
                    if (next.has(collapseKey)) next.delete(collapseKey);
                    else next.add(collapseKey);
                    return next;
                  })
                }
              >
                {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
              <button
                className="mechanism-tree-select"
                onClick={() => onSelectMechanism?.(mechanism.id)}
                aria-pressed={selectedMechanismId === mechanism.id}
                title={`选择功能组件：${mechanism.name}`}
                disabled={!onSelectMechanism}
              >
                <Icon size={15} />
                <span>
                  <strong>{mechanism.name}</strong>
                  <small>
                    {label} · {members.length} 个子零件
                    {mechanism.status === "unconfigured" ? " · 待配置" : ""}
                  </small>
                </span>
              </button>
              {onEditMechanism && (
                <button
                  className="mechanism-tree-edit"
                  onClick={() => onEditMechanism(mechanism.id)}
                  title={`编辑功能组件：${mechanism.name}`}
                >
                  <Settings2 size={13} />
                </button>
              )}
            </div>
            {open && (
              <div className="assembly-tree-group-parts mechanism-tree-parts">
                {members.map(row)}
              </div>
            )}
          </section>
        );
      })}
      {entries.map((entry) =>
        entry.name ? (
          <section
            key={entry.id}
            className="assembly-tree-group"
            data-assembly-group={entry.id}
          >
            <button
              className="assembly-tree-group-toggle"
              aria-expanded={!collapsed.has(entry.id)}
              onClick={() =>
                setCollapsed((previous) => {
                  const next = new Set(previous);
                  if (next.has(entry.id)) next.delete(entry.id);
                  else next.add(entry.id);
                  return next;
                })
              }
              title={`${entry.name} · ${entry.parts.length} 个独立零件`}
            >
              {collapsed.has(entry.id) ? (
                <ChevronRight size={13} />
              ) : (
                <ChevronDown size={13} />
              )}
              <Link2 size={12} />
              <strong>{entry.name}</strong>
              <small>{entry.parts.length}</small>
            </button>
            {!collapsed.has(entry.id) && (
              <div className="assembly-tree-group-parts">
                {entry.parts.map(row)}
              </div>
            )}
          </section>
        ) : (
          row(entry.parts[0])
        ),
      )}
    </div>
  );
}
