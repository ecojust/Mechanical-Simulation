import type { AssetEntry, AssetNode, Part, Vec3 } from "./types";

/** Source objects stay independently selectable; a group only records their relationship. */
export function createRepositoryParts(
  asset: AssetEntry,
  nodes: AssetNode[],
  offset: Vec3 = [0, 0, 0],
  namespace = crypto.randomUUID(),
): Part[] {
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(namespace))
    throw Error("素材实例标识无效。");
  return nodes.map((node) => {
    const kind = node.kind ?? "asset";
    return {
      id: crypto.randomUUID(),
      name: node.displayName ?? node.name,
      kind,
      position: node.center.map(
        (value, index) => value + offset[index],
      ) as Vec3,
      rotation: [0, 0, 0],
      size: [...node.size],
      color: "#92a9b6",
      fixed: asset.id === "housing-bottom",
      visible: true,
      params: { assetUrl: asset.url, assetNode: node.name },
      ...(node.group
        ? {
            assemblyGroup: {
              id: `${namespace}-${node.group.id}`,
              name: node.group.name,
            },
          }
        : {}),
      ...(kind !== "asset"
        ? {
            interaction: {
              version: 1 as const,
              status: "unconfigured" as const,
              // Placeholder frame only; source meshes do not provide verified interaction axes.
              axis: [0, 1, 0] as Vec3,
              anchor: [0, 0, 0] as Vec3,
              proxySize: [...node.size] as Vec3,
            },
          }
        : {}),
    };
  });
}
