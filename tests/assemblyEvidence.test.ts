import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  createAssemblyEvidenceBinding,
  evidenceSha256,
  loadBundledAssemblyEvidence,
  validateAssemblyEvidence,
  validateEvidenceState,
  ASSEMBLY_EVIDENCE_URL,
  ASSEMBLY_DIAGNOSTICS_URL,
} from "../src/assemblyEvidence";
import type {
  AssemblyEvidenceProfile,
  AssemblyEvidenceSources,
} from "../src/assemblyEvidence";
import type { Mechanism, Part, Project } from "../src/types";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const displayBytes = new TextEncoder().encode("source display geometry bytes");
function part(id: string, y: number, kind: Part["kind"] = "asset"): Part {
  return {
    id,
    name: id,
    kind,
    position: [0, y, 0],
    rotation: [0, 0, 0],
    size: [4, 2, 4],
    color: "#8899aa",
    fixed: id !== "cap",
    visible: true,
    params: { assetUrl: "./models/buttons-left.glb", assetNode: id },
  };
}
function fixture(): Project {
  const parts = [
    part("cap", 8),
    part("switch", 3, "button"),
    part("shell", 5),
    part("actuator", 4),
  ];
  const mechanism: Mechanism = {
    version: 1,
    id: "press",
    name: "fixture press",
    kind: "press",
    status: "configured",
    partIds: ["cap", "switch", "actuator"],
    movingPartIds: ["cap"],
    springPartIds: [],
    switchPartId: "switch",
    frame: { position: [0, 5, 0], rotation: [0, 0, 0] },
    axis: [0, 1, 0],
    pose: { offset: 0, angle: 0 },
    params: {
      travel: 1,
      stiffness: 1,
      mass: 0.02,
      damping: 0.8,
      freeLength: 5,
      solidLength: 2,
    },
    movingProxy: {
      kind: "base",
      position: [0, 3, 0],
      rotation: [0, 0, 0],
      size: [4, 2, 4],
      params: {},
    },
    fixedProxy: {
      kind: "base",
      position: [0, -2, 0],
      rotation: [0, 0, 0],
      size: [4, 2, 4],
      params: {},
    },
    contact: {
      strikerPartId: "cap",
      targetPartId: "actuator",
      strikerPoint: [0, -1, 0],
      switchPoint: [0, 1, 0],
      switchNormal: [0, 1, 0],
      radius: 0.5,
      maxOvertravel: 0.25,
      actuatorPartIds: ["actuator"],
    },
  };
  return {
    version: 1,
    name: "fixture",
    parts,
    wires: [],
    mechanisms: [mechanism],
  };
}
async function certified(project = fixture()) {
  const binding = await createAssemblyEvidenceBinding(project);
  const profile: AssemblyEvidenceProfile = {
    version: 1,
    id: "fixture-source-report",
    status: "pass",
    geometryFingerprint: binding.geometryFingerprint,
    sourceHashes: [
      {
        assetUrl: "./models/buttons-left.glb",
        sourceFile: "assets/puretv-controller/buttons/left.blend",
        sourceSha256: sha("original blender source"),
        displaySha256: await evidenceSha256(displayBytes),
      },
    ],
    scope: {
      description: "Bound fixture source geometry",
      interfaces: ["cap motion", "fixed shell and switch"],
      excluded: [],
      limitations: ["Nominal parameters only; not manufacturing certification"],
    },
    coverage: {
      partCount: project.parts.length,
      mechanismCount: project.mechanisms!.length,
      staticGeometry: "complete",
      movingAgainstEnvironment: "complete",
      stateMode: "single-key-at-rest",
      movingPaths: [
        {
          mechanismKey: binding.mechanismKeys.press,
          minDisplacement: 0,
          maxDisplacement: 1,
          continuous: false,
          maxSampleStepMm: 0.25,
          sourceChecked: true,
        },
      ],
      allowedContacts: [
        {
          partKeys: [binding.partKeys.cap, binding.partKeys.switch],
          region: "declared tip and contact disk only",
          maxPenetrationMm: 0.25,
          evidenceRef: "source-report:contact-1",
        },
      ],
      unknown: [],
    },
    checks: [
      {
        id: "all-source-pairs",
        status: "pass",
        category: "geometry",
        detail:
          "Source static candidates and complete sampled moving paths checked",
        partKeys: Object.values(binding.partKeys),
        evidenceRef: "source-report:geometry",
      },
    ],
    provenance: {
      generator: "fixture-test",
      version: "1",
      reportSha256: sha("pending report"),
      reportUrl: "./models/puretv-source-report.json",
    },
  };
  const reportBytes = new TextEncoder().encode(
    JSON.stringify({
      status: profile.status,
      geometryFingerprint: profile.geometryFingerprint,
      sourceHashes: profile.sourceHashes,
      audits: [{ status: "pass" }],
    }),
  );
  profile.provenance.reportSha256 = await evidenceSha256(reportBytes);
  const sources: AssemblyEvidenceSources = {
    sourceHashes: structuredClone(profile.sourceHashes),
    reportSha256: profile.provenance.reportSha256,
  };
  return { project, binding, profile, sources, reportBytes };
}
const diagnosticBody = (profile: AssemblyEvidenceProfile) => ({
  assets: profile.sourceHashes.map((source) => ({
    id: source.assetUrl.slice("./models/".length, -4),
    sourceSha256: source.sourceSha256,
    displaySha256: source.displaySha256,
  })),
});

describe("source evidence binds the entire mechanical scene", () => {
  it("uses full SHA-256 and matches canonical source geometry after harmless UUID/cosmetic changes", async () => {
    const { project, profile, sources } = await certified();
    const renamed = structuredClone(project);
    renamed.name = "Different title";
    const remap = (id: string) => `new-${id}`;
    for (const p of renamed.parts) {
      p.id = remap(p.id);
      p.name = "renamed";
      p.color = "#ffffff";
      p.visible = false;
      p.material = { metalness: 1, roughness: 0.1 };
    }
    const m = renamed.mechanisms![0];
    m.id = "new-press";
    m.name = "renamed assembly";
    m.partIds = m.partIds.map(remap).reverse();
    m.movingPartIds = m.movingPartIds.map(remap);
    m.springPartIds = m.springPartIds.map(remap);
    m.switchPartId = remap(m.switchPartId!);
    m.contact!.strikerPartId = remap(m.contact!.strikerPartId);
    m.contact!.targetPartId = remap(m.contact!.targetPartId!);
    m.contact!.actuatorPartIds = m.contact!.actuatorPartIds!.map(remap);
    renamed.parts.reverse();
    const checked = await validateAssemblyEvidence(renamed, profile, sources);
    expect(checked.geometryFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(checked.status).toBe("pass");
    expect(checked.stateRanges["new-press"].max).toBe(1);
    expect(checked.sampled).toBe(true);
  });
  it.each([
    "position",
    "rotation",
    "size",
    "fixed",
    "proxy",
    "contact",
    "roles",
    "spring",
    "actuator",
    "contact-target",
    "added",
    "removed",
    "whole-assembly",
    "new-wire",
  ])("invalidates stale evidence after %s changes", async (change) => {
    const { project, profile, sources } = await certified();
    const m = project.mechanisms![0];
    if (change === "position") project.parts[2].position[0] += 0.01;
    if (change === "rotation") project.parts[2].rotation[2] += 0.1;
    if (change === "size") project.parts[0].size[1] += 0.01;
    if (change === "fixed") project.parts[2].fixed = false;
    if (change === "proxy") m.movingProxy.size[0] += 1;
    if (change === "contact") m.contact!.switchPoint[1] += 0.01;
    if (change === "roles") m.movingPartIds.push("actuator");
    if (change === "spring") m.params.stiffness += 0.1;
    if (change === "actuator") m.contact!.actuatorPartIds = [];
    if (change === "contact-target") m.contact!.targetPartId = "switch";
    if (change === "added")
      project.parts.push({ ...part("new-obstacle", 12), params: {} });
    if (change === "removed")
      project.parts = project.parts.filter((p) => p.id !== "shell");
    if (change === "whole-assembly") {
      project.parts.forEach((p) => (p.position[0] += 5));
      m.frame.position[0] += 5;
    }
    if (change === "new-wire")
      project.wires.push({
        id: "wire",
        from: { partId: "cap", terminal: 0 },
        to: { partId: "switch", terminal: 1 },
        color: "#8899aa",
      });
    const checked = await validateAssemblyEvidence(project, profile, sources);
    expect(checked.status).toBe("unknown");
    expect(checked.matched).toBe(false);
    expect(checked.issues.some((issue) => issue.severity === "pass")).toBe(
      false,
    );
  });
  it("rejects ambiguous identical geometry instead of arbitrarily assigning role bindings", async () => {
    const project = fixture();
    project.parts.push({
      ...structuredClone(project.parts[0]),
      id: "duplicate",
    });
    await expect(createAssemblyEvidenceBinding(project)).rejects.toThrow(
      /唯一/,
    );
  });
  it("checks actual display, source-report and recorded source hashes", async () => {
    for (const field of ["displaySha256", "sourceSha256", "reportSha256"]) {
      const { project, profile, sources } = await certified();
      if (field === "reportSha256")
        sources.reportSha256 = sha("changed report");
      else
        sources.sourceHashes[0][field as "displaySha256" | "sourceSha256"] =
          sha("changed model");
      expect(
        (await validateAssemblyEvidence(project, profile, sources)).status,
      ).toBe("unknown");
    }
  });
});

describe("scope and motion coverage never turn incomplete geometry into a pass", () => {
  it.each([
    "static",
    "environment",
    "unsupported",
    "excluded",
    "missing-path",
    "short-path",
    "failed-check",
    "unknown-check",
  ])("preserves %s outcome", async (change) => {
    const { project, profile, sources } = await certified();
    if (change === "static") profile.coverage.staticGeometry = "partial";
    if (change === "environment")
      profile.coverage.movingAgainstEnvironment = "partial";
    if (change === "unsupported")
      profile.coverage.unknown.push(
        "Open spring geometry lacks a certified volume",
      );
    if (change === "excluded")
      profile.scope.excluded.push("PCB and harness collision not checked");
    if (change === "missing-path") profile.coverage.movingPaths = [];
    if (change === "short-path")
      profile.coverage.movingPaths[0].maxDisplacement = 0.75;
    if (change === "failed-check") profile.checks[0].status = "fail";
    if (change === "unknown-check") profile.checks[0].status = "unknown";
    const checked = await validateAssemblyEvidence(project, profile, sources);
    expect(checked.matched).toBe(true);
    expect(checked.status).toBe(change === "failed-check" ? "fail" : "unknown");
    expect(checked.issues.some((issue) => issue.severity === "pass")).toBe(
      false,
    );
  });
  it("limits state checks to evidenced displacement and never upgrades an unknown static result", async () => {
    const { project, profile, sources } = await certified();
    const base = await validateAssemblyEvidence(project, profile, sources);
    for (const displacement of [0, 0.5, 1])
      expect(
        validateEvidenceState(base, {
          press: { displacement, velocity: -2, force: 5 },
        }).status,
      ).toBe("pass");
    for (const displacement of [-0.001, 1.001, Number.NaN])
      expect(
        validateEvidenceState(base, {
          press: { displacement, velocity: 0, force: 0 },
        }).status,
      ).toBe("unknown");
    expect(
      validateEvidenceState(base, {
        unknown: { displacement: 0, velocity: 0, force: 0 },
      }).status,
    ).toBe("unknown");
    expect(
      validateEvidenceState(base, {
        press: { displacement: 0, velocity: Infinity, force: 0 },
      }).status,
    ).toBe("unknown");
    profile.coverage.staticGeometry = "partial";
    const incomplete = await validateAssemblyEvidence(
      project,
      profile,
      sources,
    );
    expect(validateEvidenceState(incomplete, {}).status).toBe("unknown");
  });
  it("does not accept blanket contact permissions or absent source geometry checks", async () => {
    const { project, profile, sources } = await certified();
    profile.coverage.allowedContacts[0].region = "";
    expect(
      (await validateAssemblyEvidence(project, profile, sources)).status,
    ).toBe("unknown");
    profile.coverage.allowedContacts[0].region = "limited disk";
    profile.checks = [];
    expect(
      (await validateAssemblyEvidence(project, profile, sources)).status,
    ).toBe("unknown");
  });
  it("does not extend single-key source paths to simultaneous key combinations", async () => {
    const { project, profile, sources } = await certified();
    const base = await validateAssemblyEvidence(project, profile, sources);
    base.stateRanges.second = { min: 0, max: 1, partIds: [] };
    const both = {
      press: { displacement: 0.5, velocity: 0, force: 1 },
      second: { displacement: 0.5, velocity: 0, force: 1 },
    };
    expect(validateEvidenceState(base, both).status).toBe("unknown");
    expect(
      validateEvidenceState({ ...base, stateMode: "joint-range" }, both).status,
    ).toBe("pass");
    expect(
      validateEvidenceState(base, {
        ...both,
        second: { displacement: 1e-9, velocity: 0, force: 0 },
      }).status,
    ).toBe("pass");
  });
});

describe("bundled evidence loader", () => {
  it.each([
    "fingerprint",
    "status",
    "report-source",
    "diagnostic-source",
    "unknown-audit",
    "failed-audit",
    "missing-audits",
  ])(
    "rejects a matching file hash with mismatched %s binding",
    async (mismatch) => {
      const { profile, reportBytes } = await certified();
      const report = JSON.parse(new TextDecoder().decode(reportBytes));
      const diagnostics = diagnosticBody(profile);
      if (mismatch === "fingerprint")
        report.geometryFingerprint = sha("different project");
      if (mismatch === "status") report.status = "fail";
      if (mismatch === "report-source")
        report.sourceHashes[0].sourceSha256 = sha("other original mesh");
      if (mismatch === "diagnostic-source")
        diagnostics.assets[0].sourceSha256 = sha("other exported source");
      if (mismatch === "unknown-audit") report.audits[0].status = "unknown";
      if (mismatch === "failed-audit") report.audits[0].status = "fail";
      if (mismatch === "missing-audits") delete report.audits;
      const modifiedReport = new TextEncoder().encode(JSON.stringify(report));
      profile.provenance.reportSha256 = await evidenceSha256(modifiedReport);
      const fetcher = async (url: string | URL | Request) =>
        new Response(
          url === ASSEMBLY_EVIDENCE_URL
            ? JSON.stringify(profile)
            : url === ASSEMBLY_DIAGNOSTICS_URL
              ? JSON.stringify(diagnostics)
              : url === profile.provenance.reportUrl
                ? modifiedReport
                : displayBytes,
        );
      await expect(
        loadBundledAssemblyEvidence(fetcher as typeof fetch),
      ).rejects.toThrow(/指纹|结论|来源|诊断|审计/);
    },
  );
  it("hashes the actual report and GLB from fixed bundled URLs", async () => {
    const { profile, reportBytes } = await certified();
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      url === ASSEMBLY_EVIDENCE_URL
        ? new Response(JSON.stringify(profile))
        : url === ASSEMBLY_DIAGNOSTICS_URL
          ? new Response(JSON.stringify(diagnosticBody(profile)))
          : new Response(
              url === profile.provenance.reportUrl ? reportBytes : displayBytes,
            ),
    );
    const loaded = await loadBundledAssemblyEvidence(fetcher as typeof fetch);
    expect(loaded.sources.reportSha256).toBe(profile.provenance.reportSha256);
    expect(fetcher.mock.calls.map((call) => call[0]).sort()).toEqual(
      [
        ASSEMBLY_EVIDENCE_URL,
        ASSEMBLY_DIAGNOSTICS_URL,
        profile.provenance.reportUrl,
        profile.sourceHashes[0].assetUrl,
      ].sort(),
    );
  });
  it("refuses substituted report/model content and external evidence URLs", async () => {
    const { profile, reportBytes } = await certified();
    for (const replaced of [
      profile.provenance.reportUrl,
      profile.sourceHashes[0].assetUrl,
    ]) {
      const fetcher = async (url: string | URL | Request) =>
        url === ASSEMBLY_EVIDENCE_URL
          ? new Response(JSON.stringify(profile))
          : url === ASSEMBLY_DIAGNOSTICS_URL
            ? new Response(JSON.stringify(diagnosticBody(profile)))
            : new Response(
                url === replaced
                  ? "substituted bytes"
                  : url === profile.provenance.reportUrl
                    ? reportBytes
                    : displayBytes,
              );
      await expect(
        loadBundledAssemblyEvidence(fetcher as typeof fetch),
      ).rejects.toThrow(/SHA-256/);
    }
    profile.provenance.reportUrl = "https://example.invalid/approved.json";
    await expect(
      loadBundledAssemblyEvidence(
        (async () => new Response(JSON.stringify(profile))) as typeof fetch,
      ),
    ).rejects.toThrow(/来源/);
  });
});
