/** Compact, explicitly sampled evidence; the actual validate_project result remains authoritative. */
export function compactValidation(validation, parts = []) {
  const names = new Map(parts.map((part) => [part.id, part.name]));
  const groups = new Map();
  for (const issue of validation.issues) {
    const key = `${issue.category}/${issue.severity}/${issue.title}`;
    if (!groups.has(key))
      groups.set(key, {
        category: issue.category,
        severity: issue.severity,
        title: issue.title,
        count: 0,
        examples: [],
        partNames: new Set(),
      });
    const group = groups.get(key);
    group.count++;
    if (group.examples.length < 2) group.examples.push(issue.detail);
    for (const id of issue.partIds) group.partNames.add(names.get(id) ?? id);
  }
  return {
    scope: validation.scope,
    fullReportTool: "validate_project",
    issueCount: validation.issues.length,
    issueGroups: [...groups.values()].map((group) => ({
      ...group,
      affectedPartCount: group.partNames.size,
      partNames: [...group.partNames].slice(0, 8),
    })),
    geometry: {
      minClearance: validation.geometry.minClearance,
      collisionPairCount: validation.geometry.collisionPairs.length,
      errors: validation.geometry.issues.filter(
        (issue) => issue.severity === "error" && issue.category === "geometry",
      ),
    },
    circuit: validation.circuit,
    contacts: validation.contacts ?? {},
    samples: {
      errors: validation.issues
        .filter((issue) => issue.severity === "error")
        .slice(0, 12),
      warnings: validation.issues
        .filter((issue) => issue.severity === "warning")
        .slice(0, 6),
    },
  };
}
