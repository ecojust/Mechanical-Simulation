import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  normalizePuretvAudit,
  publicValue,
  validateCalibrationBinding,
  validateMcpRecord,
  validEvidenceTimestamp,
  lockSampleStatus,
  validateRenderedSpringEvidence,
  validateInstallationSubgroup,
  validateHarnessSelfIntersection,
} from "../scripts/build-puretv-evidence";
import type { AssetEntry, Project } from "../src/types";

const KEYS = ["left", "right", "down", "up", "a", "b", "x", "y", "confirm"];
const HASH = "c".repeat(64);
const jsonSha = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Deliberately tiny fabricated reports test accounting only; never bundled as source evidence.
function sourceFixture() {
  const objects = KEYS.map((key, index) => ({
    id: `buttons/${key}.blend::cap-${key}`,
    sourceFile: `buttons/${key}.blend`,
    sourceName: `cap-${key}`,
    sourceSha256: HASH,
    role: "cap",
    key,
    boundsBlender: { min: [index * 5, 0, 0], max: [index * 5 + 1, 1, 2] },
  }));
  objects.push({
    id: "buttons/left.blend::fixed",
    sourceFile: "buttons/left.blend",
    sourceName: "fixed",
    sourceSha256: HASH,
    role: "fixed",
    key: "left",
    boundsBlender: { min: [0, 0, 1], max: [1, 1, 3] },
  });
  const strokes = [0, 0.25, 0.5, 0.75, 1];
  const candidates = strokes.map((stroke, index) => ({
    id: `check-${index}`,
    a: objects[0].id,
    b: objects[9].id,
    aMotionMm: stroke,
    bMotionMm: 0,
    contexts: [...(index === 0 ? ["rest"] : []), `left@${stroke.toFixed(8)}`],
  }));
  const contexts = [
    {
      scenario: "rest-all-pairs",
      strokeMm: 0,
      consideredPairs: 45,
      aabbSeparatedPairs: 44,
      candidatePairs: 1,
    },
    ...KEYS.flatMap((key, index) =>
      strokes.map((stroke) => ({
        scenario: `key-${key}-against-entire-environment`,
        strokeMm: stroke,
        activeObjects: [objects[index].id],
        consideredPairs: 9,
        aabbSeparatedPairs: key === "left" ? 8 : 9,
        candidatePairs: key === "left" ? 1 : 0,
      })),
    ),
  ];
  const excluded = [];
  for (let i = 0; i < 9; i++)
    for (let j = i + 1; j < 9; j++)
      excluded.push({
        a: objects[i].id,
        b: objects[j].id,
        aSweptBounds: { min: [i * 5, 0, -1], max: [i * 5 + 1, 1, 2] },
        bSweptBounds: { min: [j * 5, 0, -1], max: [j * 5 + 1, 1, 2] },
      });
  const sourceSha256 = Object.fromEntries(
    KEYS.map((key) => [`buttons/${key}.blend`, HASH]),
  );
  const calibration = {
    offset: [0, 20, 0],
    buttons: KEYS.map((key) => ({
      key,
      axis: [0, 1, 0],
      travel: 1,
      maxOvertravel: 0.25,
      movingNodes: [`cap-${key}`],
      springNodes: [],
      actuatorNodes: [],
    })),
  };
  const report = {
    sourceSha256,
    method: { switchPretravelMm: 0.75 },
    objects,
    coverage: {
      allRestPairs: 45,
      fixedFixedRestPairs: 0,
      contexts,
      uniqueCandidatePairs: 5,
      candidates,
      stateMode: "joint-range",
      jointRangeCoverage: {
        movingObjectPairs: 36,
        strictlySeparatedSweptBoundsPairs: 36,
        sweptCandidatePairs: 0,
        requiredPosePairs: 0,
        completedPosePairs: 0,
        complete: true,
        candidates: [],
        sweptBoundsExcludedPairs: excluded,
      },
    },
    checks: candidates.map((candidate) => ({
      ...candidate,
      result: { status: "no-intersection-observed" },
    })),
    summary: { completeCandidateCoverage: true },
  };
  return {
    report,
    context: {
      sourceSha256,
      originalCount: 10,
      sourceObjects: new Set(objects.map((item) => item.id)),
      calibration,
    },
  };
}

function installationFixture() {
  const moving = Array.from({ length: 6 }, (_, index) => `auxiliary-${index}`);
  const samples = [0.1, 0].map((axialOffsetMm) => ({
    angleDeg: 0,
    axialOffsetMm,
    status: "disjoint-bounds",
    strictInteriorSamples: 0,
    surfaceTrianglePairs: 0,
  }));
  const group = {
    status: "sampled-path-clear",
    sourceFilesUnchanged: true,
    blockedSampleCount: 0,
    reverseRemoval: { status: "sampled-path-clear" },
    sourceHashes: { "buttons/left.blend": HASH, "baseplates/dpad.blend": HASH },
    movingMembers: moving,
    fixedMembers: ["plate"],
    sourceObjects: [...moving, "plate"].map((name) => ({
      name,
      sourceMin: [-1, -1, 0],
      sourceMax: [1, 1, 1],
    })),
    checks: moving.map((name) => ({
      moving: name,
      fixed: "plate",
      blockedSamples: 0,
      samples: structuredClone(samples),
      reverseSamples: structuredClone(samples).reverse(),
    })),
  };
  return {
    row: {
      key: "left",
      sourceFile: "buttons/left.blend",
      plateFile: "baseplates/dpad.blend",
      sourceObjects: [{ name: "sleeve" }, { name: "plate" }],
      axisCenterSourceXY: [0, 0],
      path: {
        entryAngleDeg: 0,
        lockedAngleDeg: 0,
        startAxialOffsetMm: 0.1,
        samples,
      },
      installation: { movingSubgroupAssembly: group },
    },
    context: {
      sourceSha256: group.sourceHashes,
      originalCount: 8,
      sourceObjects: new Set<string>(),
      calibration: {
        buttons: [
          {
            key: "left",
            installationPrimaryNode: "sleeve",
            installationMovingNodes: moving,
          },
        ],
      },
    },
  };
}

describe("pureTV source evidence generation", () => {
  it("rejects lock clear labels without actual nonnegative collision counters", () => {
    for (const sample of [
      { status: "no-intersection-found" },
      {
        status: "no-intersection-found",
        surfaceTrianglePairs: -1,
        strictInteriorSamples: -1,
      },
    ])
      expect(lockSampleStatus(sample, {})).toBe("unknown");
  });
  it("binds all reverse subgroup collision/contact records to the tested forward pose", () => {
    const { row, context } = installationFixture();
    const reverse =
      row.installation.movingSubgroupAssembly.checks[0].reverseSamples;
    Object.assign(reverse[0], {
      contactProof: {
        status: "nominal-actuator-end-contact",
        sourcePlaneZ: 1000,
      },
    });
    expect(
      validateInstallationSubgroup(row, context).some((finding) =>
        finding.detail.includes("reverse subgroup motion"),
      ),
    ).toBe(true);
    delete (reverse[0] as { contactProof?: unknown }).contactProof;
    delete (reverse[0] as { strictInteriorSamples?: number })
      .strictInteriorSamples;
    expect(
      validateInstallationSubgroup(row, context).some(
        (finding) => finding.status === "unknown",
      ),
    ).toBe(true);
  });
  it("requires full current harness triangle-pair coverage and rejects known self-crossings", () => {
    const object = {
      id: "electronics/harness.blend::wire",
      sourceFile: "electronics/harness.blend",
      sourceSha256: HASH,
      triangles: 24,
    };
    const result = {
      status: "pass",
      topologyAccepted: true,
      fullTriangleCount: 24,
      uniqueTrianglePairs: 12,
      examinedUniqueTrianglePairs: 12,
      forbiddenTriangleIntersections: 0,
      unknownTrianglePairs: 0,
      degenerateTriangles: 0,
    };
    const report = {
      objects: [object],
      summary: { selfIntersectionCoverageComplete: true },
      selfIntersectionReview: {
        scopeSourceFiles: [object.sourceFile],
        requiredObjectIds: [object.id],
        complete: true,
        status: "pass",
        checks: [{ id: object.id, sourceSha256: HASH, result }],
      },
    };
    expect(validateHarnessSelfIntersection(report)).toEqual([]);
    result.examinedUniqueTrianglePairs = 11;
    expect(validateHarnessSelfIntersection(report)[0].status).toBe("unknown");
    result.examinedUniqueTrianglePairs = 12;
    result.forbiddenTriangleIntersections = 1;
    expect(validateHarnessSelfIntersection(report)[0].status).toBe("fail");
    result.forbiddenTriangleIntersections = 0;
    report.selfIntersectionReview.checks = [];
    expect(
      validateHarnessSelfIntersection(report).some(
        (finding) => finding.status === "unknown",
      ),
    ).toBe(true);
  });
  it("requires every auxiliary installation member and its full reverse source path", () => {
    const { row, context } = installationFixture();
    expect(validateInstallationSubgroup(row, context)).toEqual([]);
    row.installation.movingSubgroupAssembly.checks.pop();
    expect(
      validateInstallationSubgroup(row, context).some((finding) =>
        finding.detail.includes("every member/host pair"),
      ),
    ).toBe(true);
  });
  it("invalidates stale subgroup source geometry and an altered reverse pose", () => {
    const { row, context } = installationFixture();
    row.installation.movingSubgroupAssembly.sourceHashes = {
      ...context.sourceSha256,
      "buttons/left.blend": "d".repeat(64),
    };
    row.installation.movingSubgroupAssembly.checks[0].reverseSamples[0].axialOffsetMm = 0.05;
    const findings = validateInstallationSubgroup(row, context);
    expect(
      findings.some((finding) => finding.detail.includes("source hashes")),
    ).toBe(true);
    expect(
      findings.some((finding) =>
        finding.detail.includes("reverse subgroup motion"),
      ),
    ).toBe(true);
  });
  it("does not excuse auxiliary-member penetration using an unrelated contact label", () => {
    const { row, context } = installationFixture();
    Object.assign(
      row.installation.movingSubgroupAssembly.checks[0].samples[0],
      {
        status: "penetration-evidence",
        strictInteriorSamples: 1,
        contactProof: {
          status: "nominal-actuator-end-contact",
          allowedPenetrationMm: 0,
        },
      },
    );
    expect(
      validateInstallationSubgroup(row, context).some(
        (finding) => finding.status === "fail",
      ),
    ).toBe(true);
  });
  it("accounts for the entire rest/sampled candidate universe and joint swept exclusions", () => {
    const { report, context } = sourceFixture();
    const normalized = normalizePuretvAudit(report, context);
    expect(normalized.status).toBe("pass");
    expect(normalized.staticComplete).toBe(true);
    expect(normalized.environmentComplete).toBe(true);
    expect(normalized.stateMode).toBe("joint-range");
    expect(Object.keys(normalized.paths)).toHaveLength(9);
  });
  it("does not trust an optimistic complete summary with missing checks", () => {
    const { report, context } = sourceFixture();
    report.checks.pop();
    expect(normalizePuretvAudit(report, context).status).toBe("unknown");
  });
  it("does not override the auditor's remaining incomplete declaration", () => {
    const { report, context } = sourceFixture();
    report.summary.completeCandidateCoverage = false;
    expect(normalizePuretvAudit(report, context).status).toBe("unknown");
  });
  it("reconstructs missing candidates even when counters and checks were consistently reduced", () => {
    const { report, context } = sourceFixture();
    report.coverage.candidates.pop();
    report.checks.pop();
    report.coverage.uniqueCandidatePairs = 4;
    expect(
      normalizePuretvAudit(report, context).findings.some((row) =>
        row.detail.includes("independently reproduced"),
      ),
    ).toBe(true);
  });
  it("rejects substituted or missing full-source inventory", () => {
    const { report, context } = sourceFixture();
    report.objects[1].sourceName = "another-member";
    expect(normalizePuretvAudit(report, context).status).toBe("unknown");
  });
  it("does not certify stale source hashes", () => {
    const { report, context } = sourceFixture();
    report.sourceSha256 = {
      ...report.sourceSha256,
      "buttons/left.blend": "b".repeat(64),
    };
    const result = normalizePuretvAudit(report, context);
    expect(result.status).toBe("unknown");
    expect(result.staticComplete).toBe(false);
  });
  it("keeps unclassified surface or containment contacts unknown", () => {
    const { report, context } = sourceFixture();
    report.checks[0].result.status = "unknown-containment";
    expect(normalizePuretvAudit(report, context).status).toBe("unknown");
  });
  it("does not allow a clear status label to conceal recorded penetration", () => {
    const { report, context } = sourceFixture();
    Object.assign(report.checks[0].result, {
      maximumSampledPenetrationMm: 0.2,
    });
    expect(normalizePuretvAudit(report, context).status).toBe("fail");
  });
  it("retains actual penetration evidence as failure", () => {
    const { report, context } = sourceFixture();
    report.checks[0].result.status = "penetration-evidence";
    expect(normalizePuretvAudit(report, context).status).toBe("fail");
  });
  it("requires explicit bounded local contact evidence rather than a status label", () => {
    const { report, context } = sourceFixture();
    report.checks[0].result.status = "allowed-local-interface";
    expect(normalizePuretvAudit(report, context).status).toBe("unknown");
    Object.assign(report.checks[0].result, {
      allowedInterface: {
        id: "local",
        regionBlenderAtPose: { min: [0, 0, 0], max: [1, 1, 1] },
        maximumPenetrationMm: 0.25,
        localRegionProof: { proven: true },
      },
      maximumSampledPenetrationMm: 0.2,
    });
    expect(normalizePuretvAudit(report, context).status).toBe("pass");
    Object.assign(report.checks[0].result, {
      maximumSampledPenetrationMm: 0.3,
    });
    expect(normalizePuretvAudit(report, context).status).toBe("unknown");
  });
  it("rejects a false swept-bound exclusion for simultaneous keys", () => {
    const { report, context } = sourceFixture();
    report.coverage.jointRangeCoverage.sweptBoundsExcludedPairs[0].aSweptBounds.min[0] = 999;
    expect(normalizePuretvAudit(report, context).status).toBe("unknown");
  });
  it("requires source-calibrated motion roles and axis rather than arbitrary activity declarations", () => {
    const { report, context } = sourceFixture();
    context.calibration.buttons[0].movingNodes = [];
    expect(normalizePuretvAudit(report, context).status).toBe("unknown");
  });
  it("does not promote single-key source scans to simultaneous coverage", () => {
    const { report, context } = sourceFixture();
    report.coverage.stateMode = "single-key-at-rest";
    const result = normalizePuretvAudit(report, context);
    expect(result.status).toBe("pass");
    expect(result.stateMode).toBe("single-key-at-rest");
  });
  it("keeps an unverified confirmation seat installation unknown", () => {
    const { context } = sourceFixture();
    const report = {
      sourceSha256: context.sourceSha256,
      buttons: KEYS.map((key) => ({
        key,
        status: "not-applicable",
        assemblyPose: { status: "no-intersection-found" },
        exploration: {},
      })),
    };
    expect(normalizePuretvAudit(report, context).status).toBe("unknown");
  });
  it("separately binds display consistency to every actual GLB hash", () => {
    const { context } = sourceFixture();
    const displaySha256 = Object.fromEntries(
      KEYS.map((key) => [`buttons/${key}.blend`, HASH]),
    );
    const report = {
      status: "pass",
      buttons: KEYS.map((key) => ({
        key,
        sourceFile: `buttons/${key}.blend`,
        sourceSha256: HASH,
        displaySha256: HASH,
        springEndpointErrorMm: 0.000001,
        contactSurfaceErrorMm: 0,
      })),
    };
    const bound = { ...context, displaySha256 };
    expect(normalizePuretvAudit(report, bound).status).toBe("pass");
    report.buttons[0].displaySha256 = "d".repeat(64);
    expect(normalizePuretvAudit(report, bound).status).toBe("unknown");
  });
  it("does not certify a display whose physical contact surface exceeds the declared error", () => {
    const { context } = sourceFixture();
    const displaySha256 = Object.fromEntries(
      KEYS.map((key) => [`buttons/${key}.blend`, HASH]),
    );
    const report = {
      status: "pass",
      buttons: KEYS.map((key) => ({
        key,
        sourceFile: `buttons/${key}.blend`,
        sourceSha256: HASH,
        displaySha256: HASH,
        springEndpointErrorMm: 0,
        contactSurfaceErrorMm: key === "left" ? 0.002 : 0,
      })),
    };
    expect(
      normalizePuretvAudit(report, { ...context, displaySha256 }).status,
    ).toBe("fail");
  });
  it("accepts only the exact confirmation bearing interface with recomputed patch areas", () => {
    const bearing = {
      status: "nominal-load-bearing-contact",
      sourcePlaneZ: 25.45,
      sourceAxisCenterXY: [0, 5.5],
      allowedRadialBandMm: [6.8, 9.6],
      allowedAngularSectorsDeg: [
        [35, 65],
        [215, 245],
      ],
      numericPlaneToleranceMm: 0.0001,
      contactPairs: 1,
      opposingHorizontalPairs: 2,
      opposingHorizontalPairsReturnedByBvh: 0,
      boundaryPairs: 1,
      maximumIntersectionPlaneDeviationMm: 0,
      bearingPatchAreasMm2: [0.04, 0.04],
      supportingTrianglePairs: [
        {
          movingTriangle: 1,
          fixedTriangle: 3,
          sector: 0,
          areaMm2: 0.04,
          polygonSourceXY: [
            [5.5, 11],
            [5.7, 11],
            [5.7, 11.2],
            [5.5, 11.2],
          ],
        },
        {
          movingTriangle: 2,
          fixedTriangle: 4,
          sector: 1,
          areaMm2: 0.04,
          polygonSourceXY: [
            [-5.5, 0],
            [-5.7, 0],
            [-5.7, -0.2],
            [-5.5, -0.2],
          ],
        },
      ],
      strictInteriorSamples: 0,
      rejectedPairCount: 0,
      rejectedPairs: [],
    };
    const sample = {
      status: "nominal-load-bearing-contact",
      angleDeg: 0,
      axialOffsetMm: 0,
      surfaceTrianglePairs: 1,
      strictInteriorSamples: 0,
      bearingContact: bearing,
    };
    const row = {
      key: "confirm",
      sourceFile: "buttons/confirm.blend",
      plateFile: "housing/top.blend",
      axisCenterSourceXY: [0, 5.5],
    };
    expect(lockSampleStatus(sample, row)).toBe("pass");
    expect(lockSampleStatus(sample, { ...row, key: "left" })).toBe("unknown");
    expect(lockSampleStatus({ ...sample, axialOffsetMm: 0.1 }, row)).toBe(
      "unknown",
    );
    bearing.supportingTrianglePairs[0].polygonSourceXY[0][0] = 20;
    expect(lockSampleStatus(sample, row)).toBe("unknown");
  });
  it("does not infer geometric validation from a repair log", () => {
    const { context } = sourceFixture();
    expect(
      normalizePuretvAudit(
        { sourceSha256: context.sourceSha256, status: "pass", applied: true },
        context,
      ).status,
    ).toBe("unknown");
  });
  it("public summaries remove local endpoints, credentials and absolute paths", () => {
    const output = publicValue({
      token: "private",
      path: "/home/agent/private/file",
      source: "/workspace/Mechanical-Simulation/docs/check.json",
      message: "Bearer private-token http://127.0.0.1:9876/private",
      nested: { environment: { secret: "a" } },
    }) as Record<string, unknown>;
    expect(output.token).toBe("[redacted]");
    expect(output.path).toBe("[external local path omitted]");
    expect(output.source).toBe("docs/check.json");
    expect(JSON.stringify(output)).not.toContain("private-token");
    expect(JSON.stringify(output)).not.toContain("9876");
  });
  it("requires a deterministic completedAt timestamp instead of the generator clock", () => {
    expect(validEvidenceTimestamp("2026-11-14T11:00:00.000Z")).toBe(true);
    expect(validEvidenceTimestamp("yesterday")).toBe(false);
    expect(validEvidenceTimestamp("2026-02-30T00:00:00.000Z")).toBe(false);
    expect(validEvidenceTimestamp(undefined)).toBe(false);
  });
  it("requires recorded spring matrices and rejects intent-only or wrong-axis deformation", () => {
    const mechanism = {
      springPartIds: ["spring"],
      params: { travel: 1, freeLength: 4 },
    };
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const pressed = [...identity];
    pressed[5] = 0.75;
    const snapshots = {
      pressed: [{ partId: "spring", matrix: pressed }],
      released: [{ partId: "spring", matrix: identity }],
    };
    expect(
      validateRenderedSpringEvidence(mechanism, snapshots, "left"),
    ).toEqual([]);
    expect(
      validateRenderedSpringEvidence(mechanism, undefined, "left")[0].status,
    ).toBe("unknown");
    expect(
      validateRenderedSpringEvidence(
        mechanism,
        { ...snapshots, pressed: [{ partId: "other", matrix: pressed }] },
        "left",
      )[0].status,
    ).toBe("unknown");
    expect(
      validateRenderedSpringEvidence(
        mechanism,
        { ...snapshots, pressed: [{ partId: "spring", matrix: identity }] },
        "left",
      )[0].status,
    ).toBe("fail");
    const wrongAxis = [...identity];
    wrongAxis[0] = 0.75;
    expect(
      validateRenderedSpringEvidence(
        mechanism,
        { ...snapshots, pressed: [{ partId: "spring", matrix: wrongAxis }] },
        "left",
      )[0].status,
    ).toBe("fail");
  });
  it("requires actual MCP evidence rather than a top-level pass", () => {
    const project: Project = {
      version: 1,
      name: "test",
      parts: [],
      mechanisms: [],
      wires: [],
    };
    const findings = validateMcpRecord(
      project,
      project,
      { buttons: [] },
      {
        status: "pass",
        execution: { fixture: true, nativeDesktop: false },
        exportedProjectSha256: jsonSha(project),
        calibrationSha256: jsonSha({ buttons: [] }),
      },
      0,
    );
    expect(findings.some((row) => row.status === "unknown")).toBe(true);
    expect(findings.some((row) => row.status === "pass")).toBe(false);
  });
  it("requires calibrated source and distinct physical/electrical contact owners", () => {
    const project: Project = {
      version: 1,
      name: "test",
      parts: [],
      mechanisms: [],
      wires: [],
    };
    const assets: AssetEntry[] = [];
    expect(
      validateCalibrationBinding(project, assets, {
        offset: [0, 20, 0],
        buttons: [{ key: "left", assetId: "missing" }],
      }).some((row) => row.status === "unknown"),
    ).toBe(true);
  });
});
