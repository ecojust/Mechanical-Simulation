import {
  loadBundledAssemblyEvidence,
  validateAssemblyEvidence,
} from "./assemblyEvidence";
import type { AssemblyEvidenceResult } from "./assemblyEvidence";
import type { Issue, Project } from "./types";

let bundled: ReturnType<typeof loadBundledAssemblyEvidence> | undefined;

/** Only application-bundled evidence is trusted; projects cannot bring their own pass result. */
export async function projectSourceEvidence(
  project: Project,
): Promise<AssemblyEvidenceResult | null> {
  if (!project.parts.some((part) => typeof part.params.assetUrl === "string"))
    return null;
  try {
    bundled ??= loadBundledAssemblyEvidence().catch((error) => {
      bundled = undefined;
      throw error;
    });
    const { profile, sources } = await bundled;
    return await validateAssemblyEvidence(project, profile, sources);
  } catch (error) {
    return {
      status: "unknown",
      matched: false,
      scope: "源模型尺寸尚未获得与当前装配一致的验证证据。",
      issues: [{
        id: "assembly-evidence-unavailable",
        severity: "warning",
        category: "geometry",
        title: "源模型尺寸待核对",
        detail: error instanceof Error ? error.message : String(error),
        partIds: [],
      }],
      stateRanges: {},
      sampled: true,
    };
  }
}

/** Complete, matched source checks supersede inconclusive AABB preview warnings only. */
export function withSourceEvidence(
  issues: Issue[],
  evidence: AssemblyEvidenceResult | null | undefined,
): Issue[] {
  const resolved = evidence?.status === "pass" && evidence.matched;
  return [
    ...issues.filter((issue) => !(
      resolved && issue.severity === "warning" &&
      (issue.id === "asset-accuracy" || issue.id.startsWith("proxy-"))
    )).map((issue) => {
      if (!resolved || issue.severity !== "warning") return issue;
      if (issue.id.startsWith("mechanism-") && issue.id.endsWith("-accuracy"))
        return { ...issue, detail: "当前构型与源尺寸采样证据匹配。运动仍采用声明的代理和名义质量、刚度、阻尼；未求解真实开关力曲线、摩擦、材料变形或有限元。" };
      if (issue.id.startsWith("component-proxy-mechanism-"))
        return { ...issue, title: "运行时使用已标定导向代理", detail: "该代理用于中心导向与行程求解；复杂外形另由匹配的源网格采样证据核对。代理不求解摩擦、材料变形或连续曲面接触。" };
      return issue;
    }),
    ...(evidence?.issues ?? []),
  ];
}
