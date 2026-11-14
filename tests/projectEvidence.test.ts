import { describe, expect, it } from "vitest";
import { withSourceEvidence } from "../src/projectEvidence";
import type { AssemblyEvidenceResult } from "../src/assemblyEvidence";
import type { Issue } from "../src/types";

const checks: Issue[] = [
  { id: "proxy-cap-housing", severity: "warning", category: "geometry", title: "Envelope overlap", detail: "Source mesh inspection needed", partIds: ["cap", "housing"] },
  { id: "asset-accuracy", severity: "warning", category: "geometry", title: "Preview only", detail: "Source inspection needed", partIds: ["housing"] },
  { id: "collision-cap-wall", severity: "error", category: "geometry", title: "Actual obstruction", detail: "Must remain an error", partIds: ["cap", "wall"] },
  { id: "wire-clearance", severity: "warning", category: "geometry", title: "Test leads", detail: "Electrical connectivity is not lead clearance", partIds: [] },
];
const evidence = (status: AssemblyEvidenceResult["status"], matched = true): AssemblyEvidenceResult => ({
  status, matched, scope: "Bound source geometry", issues: [], stateRanges: {}, sampled: true,
});

describe("source evidence and preview checks", () => {
  it("supersedes only inconclusive envelope warnings after complete matching source checks", () => {
    expect(withSourceEvidence(checks, evidence("pass")).map((issue) => issue.id))
      .toEqual(["collision-cap-wall", "wire-clearance"]);
  });
  it.each([evidence("unknown"), evidence("fail"), evidence("pass", false), null])(
    "keeps every original issue when evidence is unavailable, incomplete, failed or stale",
    (result) => expect(withSourceEvidence(checks, result)).toEqual(checks),
  );
  it("keeps the material-model limitation after source geometry has been checked", () => {
    const original: Issue = {
      id: "mechanism-button-accuracy", severity: "warning", category: "physics",
      title: "Declared model", detail: "Source geometry still unverified", partIds: ["cap"],
    };
    const [checked] = withSourceEvidence([original], evidence("pass"));
    expect(checked.severity).toBe("warning");
    expect(checked.detail).toContain("源尺寸采样证据匹配");
    expect(checked.detail).toContain("未求解真实开关力曲线");
    expect(withSourceEvidence([original], evidence("unknown"))[0]).toEqual(original);
  });
  it("describes calibrated mechanism proxies accurately while keeping their physical limits", () => {
    const original: Issue = { id: "component-proxy-mechanism-left-moving", severity: "warning", category: "physics", title: "Unverified upload", detail: "No source evidence", partIds: ["cap"] };
    const [checked] = withSourceEvidence([original], evidence("pass"));
    expect(checked.severity).toBe("warning");
    expect(checked.title).toBe("运行时使用已标定导向代理");
    expect(checked.detail).toContain("不求解摩擦");
    expect(withSourceEvidence([original], evidence("unknown"))[0]).toEqual(original);
  });
});
