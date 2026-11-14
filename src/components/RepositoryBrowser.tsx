import { useMemo, useState } from "react";
import {
  Box,
  ChevronDown,
  ChevronRight,
  Layers3,
  Link2,
  Plus,
} from "lucide-react";
import { componentTypeLabel } from "../componentRegistry";
import type { AssetEntry, AssetNode } from "../types";
import "./RepositoryBrowser.css";

interface Props {
  assets: AssetEntry[];
  search: string;
  onAdd: (asset: AssetEntry, nodes: NonNullable<AssetEntry["nodes"]>) => void;
  onLoadOriginal: () => void;
  error?: string;
}
interface NodeSet {
  id: string;
  name?: string;
  nodes: AssetNode[];
}
const displayName = (node: AssetNode) => node.displayName ?? node.name;
const shortName = (node: AssetNode) => displayName(node);
function nodeSets(nodes: AssetNode[]): NodeSet[] {
  const result: NodeSet[] = [];
  const grouped = new Map<string, NodeSet>();
  for (const node of nodes) {
    if (!node.group) {
      result.push({ id: `node:${node.name}`, nodes: [node] });
      continue;
    }
    let set = grouped.get(node.group.id);
    if (!set) {
      set = { id: node.group.id, name: node.group.name, nodes: [] };
      grouped.set(set.id, set);
      result.push(set);
    }
    set.nodes.push(node);
  }
  // Put the actual mating pair first; long switch-pin lists must not hide it.
  const rank = (set: NodeSet) =>
    set.nodes.some((node) => node.role === "male") &&
    set.nodes.some((node) => node.role === "female")
      ? 0
      : set.nodes.some((node) => node.kind === "spring")
        ? 1
        : set.name
          ? 2
          : 3;
  return result.sort((a, b) => rank(a) - rank(b));
}
export default function RepositoryBrowser({
  assets,
  search,
  onAdd,
  onLoadOriginal,
  error,
}: Props) {
  const [expanded, setExpanded] = useState(() => new Set(["buttons-left"]));
  const query = search.trim().toLocaleLowerCase();
  const collections = useMemo(
    () =>
      assets
        .map((asset) => {
          const matchesCollection = asset.name
            .toLocaleLowerCase()
            .includes(query);
          const sets = nodeSets(asset.nodes ?? []).filter(
            (set) =>
              !query ||
              matchesCollection ||
              set.name?.toLocaleLowerCase().includes(query) ||
              set.nodes.some((node) =>
                `${displayName(node)} ${componentTypeLabel(node.kind ?? "asset")}`
                  .toLocaleLowerCase()
                  .includes(query),
              ),
          );
          return { asset, sets };
        })
        .filter((collection) => collection.sets.length),
    [assets, query],
  );
  const renderNode = (asset: AssetEntry, node: AssetNode) => (
    <button
      className="repository-node"
      key={node.name}
      onClick={() => onAdd(asset, [node])}
      title={`添加子零件：${displayName(node)}`}
      data-asset-node={node.name}
    >
      <Box size={14} />
      <span>
        <strong>{shortName(node)}</strong>
        <small>
          {node.role === "male"
            ? "公件 · "
            : node.role === "female"
              ? "母件 · "
              : ""}
          {node.kind && node.kind !== "asset"
            ? componentTypeLabel(node.kind)
            : "结构子零件"}
          {node.kind && node.kind !== "asset" ? " · 待配置" : " · 仅预检"}
        </small>
        <small className="repository-node-size">
          {node.size.map((value) => value.toFixed(1)).join(" × ")} mm
        </small>
      </span>
      <Plus size={13} />
    </button>
  );
  return (
    <div className="repository-browser">
      <button className="original-assembly-button" onClick={onLoadOriginal}>
        <Layers3 size={15} />
        <span>
          打开原手柄装配<small>全部子零件 · 保留原始装配坐标</small>
        </span>
        <ChevronRight size={14} />
      </button>
      <p className="library-note">
        {assets.length} 个来源 ·{" "}
        {assets.reduce((sum, asset) => sum + (asset.nodes?.length ?? 0), 0)}{" "}
        个独立子零件。公母配合按组收纳，组内零件仍可单独编辑。
      </p>
      {error && <p className="hint amber">{error}</p>}
      <div className="repository-collections">
        {collections.map(({ asset, sets }) => {
          const open = Boolean(query) || expanded.has(asset.id);
          return (
            <section
              className="repository-collection"
              key={asset.id}
              data-asset-collection={asset.id}
            >
              <button
                className="repository-collection-toggle"
                aria-expanded={open}
                onClick={() =>
                  setExpanded((previous) => {
                    const next = new Set(previous);
                    if (next.has(asset.id)) next.delete(asset.id);
                    else next.add(asset.id);
                    return next;
                  })
                }
              >
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <Layers3 size={14} />
                <strong>{asset.name}</strong>
                <small>{asset.nodes?.length ?? 0}</small>
              </button>
              {open && (
                <div className="repository-collection-content">
                  {sets.map((set) =>
                    set.name ? (
                      <div
                        className="repository-pair-group"
                        key={set.id}
                        data-group-id={set.id}
                      >
                        <div className="repository-pair-heading">
                          <Link2 size={12} />
                          <strong>{set.name}</strong>
                          <button
                            onClick={() => onAdd(asset, set.nodes)}
                            title={`添加配合组：${set.name}，保留相对位置`}
                          >
                            <Plus size={12} />
                            整组添加
                          </button>
                        </div>
                        {set.nodes.map((node) => renderNode(asset, node))}
                      </div>
                    ) : (
                      renderNode(asset, set.nodes[0])
                    ),
                  )}
                </div>
              )}
            </section>
          );
        })}
        {!collections.length && !error && (
          <p className="repository-empty">
            {query ? "没有匹配的子零件或配合组。" : "正在载入子零件目录…"}
          </p>
        )}
      </div>
      <p className="attribution">
        部分手柄造型改编自 Taohid Animation 的 PS5 Controller · CC BY
        4.0。详见素材说明。
      </p>
    </div>
  );
}
