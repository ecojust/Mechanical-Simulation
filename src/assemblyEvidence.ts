import type { Issue, MechanismStates, Project } from "./types";

export const ASSEMBLY_EVIDENCE_URL = "./models/puretv-verified-evidence.json";
export const ASSEMBLY_DIAGNOSTICS_URL = "./models/diagnostics.json";
export type EvidenceStatus = "pass" | "fail" | "unknown";
export interface EvidenceSourceHash {
  assetUrl: string;
  sourceFile: string;
  sourceSha256: string;
  displaySha256: string;
}
export interface AssemblyEvidenceProfile {
  version: 1;
  id: string;
  status: EvidenceStatus;
  sourceHashes: EvidenceSourceHash[];
  geometryFingerprint: string;
  scope: {
    description: string;
    interfaces: string[];
    /** Unchecked geometry/interfaces, not general material/FEM/manufacturing limitations. */
    excluded: string[];
    limitations?: string[];
  };
  coverage: {
    partCount: number;
    mechanismCount: number;
    /** All static-static candidate pairs checked/classified; being present as an obstacle is insufficient. */
    staticGeometry: "complete" | "partial";
    /** Every moving/elastic member checked against the entire fixed environment and other assemblies. */
    movingAgainstEnvironment: "complete" | "partial";
    /** Single-key audits keep every other mechanism at rest; they cannot certify concurrent presses. */
    stateMode: "single-key-at-rest" | "joint-range";
    movingPaths: {
      mechanismKey: string;
      minDisplacement: number;
      maxDisplacement: number;
      continuous: boolean;
      maxSampleStepMm: number;
      sourceChecked: boolean;
    }[];
    allowedContacts: {
      partKeys: [string, string];
      region: string;
      maxPenetrationMm: number;
      evidenceRef: string;
    }[];
    unknown: string[];
  };
  checks: {
    id: string;
    status: EvidenceStatus;
    category: Issue["category"];
    detail: string;
    partKeys?: string[];
    evidenceRef?: string;
  }[];
  provenance: {
    generator: string;
    version: string;
    reportSha256: string;
    reportUrl: string;
  };
}
export interface AssemblyEvidenceBinding {
  geometryFingerprint: string;
  snapshot: Record<string, unknown>;
  partKeys: Record<string, string>;
  mechanismKeys: Record<string, string>;
}
/** Hashes observed from bundled assets, not a declaration imported inside a project. */
export interface AssemblyEvidenceSources {
  sourceHashes: EvidenceSourceHash[];
  reportSha256: string;
}
export interface AssemblyEvidenceResult {
  status: EvidenceStatus;
  matched: boolean;
  profileId?: string;
  geometryFingerprint?: string;
  scope: string;
  issues: Issue[];
  /** Internal applicability data: reuse this static result for fast per-frame state checks. */
  stateRanges: Record<string, { min: number; max: number; partIds: string[] }>;
  sampled: boolean;
  stateMode?: "single-key-at-rest" | "joint-range";
}
const SHA = /^[a-f0-9]{64}$/;
const BUNDLED_GLB = /^\.\/models\/[a-z0-9][a-z0-9_-]*\.glb$/i;
const BUNDLED_JSON = /^\.\/models\/[a-z0-9][a-z0-9_-]*\.json$/i;
const statuses = new Set(["pass", "fail", "unknown"]);
const categories = new Set(["geometry", "fit", "physics", "circuit"]);
const record = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function canonical(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw Error("机械规范包含非有限数值。");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (record(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonical(value[key])]),
    );
  throw Error("机械规范包含无法签名的数据。");
}
export async function evidenceSha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
async function digestValue(value: unknown): Promise<string> {
  return evidenceSha256(
    new TextEncoder().encode(JSON.stringify(canonical(value))),
  );
}
/** Bind physical content and all neighbours. Cosmetic names/materials/visibility do not alter geometry. */
export async function createAssemblyEvidenceBinding(
  project: Project,
): Promise<AssemblyEvidenceBinding> {
  const modelById = new Map(
    (project.models ?? []).map((model) => [model.id, model]),
  );
  if (modelById.size !== (project.models?.length ?? 0))
    throw Error("上传模型标识重复。");
  const verifiedModels = new Map<string, Promise<void>>();
  const seenIds = new Set<string>();
  const partRows = await Promise.all(
    project.parts.map(async (part) => {
      if (!nonempty(part.id) || seenIds.has(part.id))
        throw Error("零件标识重复或缺失。");
      seenIds.add(part.id);
      const model = part.model ? modelById.get(part.model.id) : undefined;
      if (part.model && !model) throw Error("机械规范缺少上传模型。");
      if (model) {
        let verified = verifiedModels.get(model.id);
        if (!verified) {
          verified = (async () => {
            const bytes = Uint8Array.from(atob(model.data), (value) =>
              value.charCodeAt(0),
            );
            if (
              bytes.length !== model.bytes ||
              (await evidenceSha256(bytes)) !== model.sha256
            )
              throw Error("上传模型内容与SHA-256不一致。");
          })();
          verifiedModels.set(model.id, verified);
        }
        await verified;
      }
      const physical = {
        kind: part.kind,
        position: part.position,
        rotation: part.rotation,
        size: part.size,
        fixed: part.fixed,
        params: part.params,
        interaction: part.interaction,
        model: model
          ? {
              sha256: model.sha256,
              format: model.format,
              bytes: model.bytes,
              size: model.size,
              center: model.center,
            }
          : undefined,
      };
      return {
        id: part.id,
        key: `part:${await digestValue(physical)}`,
        physical,
      };
    }),
  );
  if (new Set(partRows.map((row) => row.key)).size !== partRows.length)
    throw Error("存在机械定义完全相同的重叠零件，证据不能唯一绑定成员。");
  const partKeys = Object.fromEntries(partRows.map((row) => [row.id, row.key]));
  const keyForPart = (id: string): string => {
    if (!Object.hasOwn(partKeys, id))
      throw Error("机构或导线引用不存在的成员。");
    return partKeys[id];
  };
  const members = (ids: string[]) => ids.map(keyForPart).sort();
  const mechanismIds = new Set<string>();
  const mechanismRows = await Promise.all(
    (project.mechanisms ?? []).map(async (mechanism) => {
      if (!nonempty(mechanism.id) || mechanismIds.has(mechanism.id))
        throw Error("机构标识重复或缺失。");
      mechanismIds.add(mechanism.id);
      const physical = {
        version: mechanism.version,
        kind: mechanism.kind,
        status: mechanism.status,
        partKeys: members(mechanism.partIds),
        movingPartKeys: members(mechanism.movingPartIds),
        springPartKeys: members(mechanism.springPartIds),
        switchPartKey: mechanism.switchPartId
          ? keyForPart(mechanism.switchPartId)
          : undefined,
        frame: mechanism.frame,
        axis: mechanism.axis,
        pose: mechanism.pose,
        params: mechanism.params,
        movingProxy: mechanism.movingProxy,
        fixedProxy: mechanism.fixedProxy,
        contact: mechanism.contact
          ? {
              ...mechanism.contact,
              strikerPartId: keyForPart(mechanism.contact.strikerPartId),
              ...(mechanism.contact.targetPartId
                ? { targetPartId: keyForPart(mechanism.contact.targetPartId) }
                : {}),
              ...(mechanism.contact.actuatorPartIds
                ? {
                    actuatorPartIds: members(mechanism.contact.actuatorPartIds),
                  }
                : {}),
            }
          : undefined,
      };
      return {
        id: mechanism.id,
        key: `mechanism:${await digestValue(physical)}`,
        physical,
      };
    }),
  );
  if (
    new Set(mechanismRows.map((row) => row.key)).size !== mechanismRows.length
  )
    throw Error("机构机械定义重复，无法唯一绑定证据。");
  const wires = project.wires
    .map((wire) => ({
      from: {
        partKey: keyForPart(wire.from.partId),
        terminal: wire.from.terminal,
      },
      to: { partKey: keyForPart(wire.to.partId), terminal: wire.to.terminal },
    }))
    .map((wire) => canonical(wire))
    .sort((a, b) =>
      JSON.stringify(a) < JSON.stringify(b)
        ? -1
        : JSON.stringify(a) > JSON.stringify(b)
          ? 1
          : 0,
    );
  const snapshot = canonical({
    schema: "mechanical-source-evidence-v1",
    parts: partRows
      .sort((a, b) => (a.key < b.key ? -1 : 1))
      .map((row) => ({ key: row.key, ...row.physical })),
    mechanisms: mechanismRows
      .sort((a, b) => (a.key < b.key ? -1 : 1))
      .map((row) => ({ key: row.key, ...row.physical })),
    wires,
  }) as Record<string, unknown>;
  return {
    snapshot,
    geometryFingerprint: await digestValue(snapshot),
    partKeys,
    mechanismKeys: Object.fromEntries(
      mechanismRows.map((row) => [row.id, row.key]),
    ),
  };
}
function parseSource(raw: unknown): EvidenceSourceHash {
  if (
    !record(raw) ||
    !BUNDLED_GLB.test(raw.assetUrl) ||
    !nonempty(raw.sourceFile) ||
    !SHA.test(raw.sourceSha256) ||
    !SHA.test(raw.displaySha256)
  )
    throw Error("证据来源或SHA-256字段无效。");
  return raw as EvidenceSourceHash;
}
export function parseAssemblyEvidenceProfile(
  raw: unknown,
): AssemblyEvidenceProfile {
  if (
    !record(raw) ||
    raw.version !== 1 ||
    !nonempty(raw.id) ||
    !statuses.has(raw.status) ||
    !SHA.test(raw.geometryFingerprint) ||
    !Array.isArray(raw.sourceHashes) ||
    !record(raw.scope) ||
    !record(raw.coverage) ||
    !Array.isArray(raw.checks) ||
    !record(raw.provenance)
  )
    throw Error("源几何证据格式无效。");
  if (
    !nonempty(raw.scope.description) ||
    !Array.isArray(raw.scope.interfaces) ||
    !raw.scope.interfaces.every(nonempty) ||
    !Array.isArray(raw.scope.excluded) ||
    !raw.scope.excluded.every(nonempty) ||
    (raw.scope.limitations !== undefined &&
      (!Array.isArray(raw.scope.limitations) ||
        !raw.scope.limitations.every(nonempty)))
  )
    throw Error("证据适用范围无效。");
  raw.sourceHashes.forEach(parseSource);
  if (
    new Set(raw.sourceHashes.map((entry: EvidenceSourceHash) => entry.assetUrl))
      .size !== raw.sourceHashes.length
  )
    throw Error("证据来源重复。");
  const coverage = raw.coverage;
  if (
    ![coverage.partCount, coverage.mechanismCount].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    !["complete", "partial"].includes(coverage.staticGeometry) ||
    !["complete", "partial"].includes(coverage.movingAgainstEnvironment) ||
    !["single-key-at-rest", "joint-range"].includes(coverage.stateMode) ||
    !Array.isArray(coverage.movingPaths) ||
    !Array.isArray(coverage.allowedContacts) ||
    !Array.isArray(coverage.unknown) ||
    !coverage.unknown.every(nonempty)
  )
    throw Error("源几何证据覆盖清单无效。");
  for (const path of coverage.movingPaths)
    if (
      !record(path) ||
      !nonempty(path.mechanismKey) ||
      !nonnegative(path.minDisplacement) ||
      !nonnegative(path.maxDisplacement) ||
      path.maxDisplacement < path.minDisplacement ||
      typeof path.continuous !== "boolean" ||
      !nonnegative(path.maxSampleStepMm) ||
      (!path.continuous && path.maxSampleStepMm === 0) ||
      typeof path.sourceChecked !== "boolean"
    )
      throw Error("运动路径证据无效。");
  for (const contact of coverage.allowedContacts)
    if (
      !record(contact) ||
      !Array.isArray(contact.partKeys) ||
      contact.partKeys.length !== 2 ||
      !contact.partKeys.every(nonempty) ||
      contact.partKeys[0] === contact.partKeys[1] ||
      !nonempty(contact.region) ||
      !nonnegative(contact.maxPenetrationMm) ||
      !nonempty(contact.evidenceRef)
    )
      throw Error("允许接触须限定两个实体、局部区域、压入量和来源记录。");
  for (const check of raw.checks)
    if (
      !record(check) ||
      !nonempty(check.id) ||
      !statuses.has(check.status) ||
      !categories.has(check.category) ||
      !nonempty(check.detail) ||
      (check.partKeys !== undefined &&
        (!Array.isArray(check.partKeys) || !check.partKeys.every(nonempty))) ||
      (check.evidenceRef !== undefined && !nonempty(check.evidenceRef))
    )
      throw Error("源几何检查项无效。");
  const provenance = raw.provenance;
  if (
    !nonempty(provenance.generator) ||
    !nonempty(provenance.version) ||
    !SHA.test(provenance.reportSha256) ||
    !BUNDLED_JSON.test(provenance.reportUrl) ||
    provenance.reportUrl === ASSEMBLY_EVIDENCE_URL
  )
    throw Error("源报告来源或哈希无效。");
  return raw as unknown as AssemblyEvidenceProfile;
}
const evidenceIssue = (
  id: string,
  status: EvidenceStatus,
  detail: string,
  partIds: string[] = [],
  category: Issue["category"] = "geometry",
): Issue => ({
  id: `assembly-evidence-${id}`,
  severity:
    status === "unknown" ? "warning" : status === "fail" ? "error" : "pass",
  title:
    status === "pass"
      ? "绑定构型的源几何证据通过"
      : status === "fail"
        ? "源几何验证未通过"
        : "源几何证据不适用或未完成",
  detail,
  partIds,
  category,
});
const scope =
  "仅适用于来源哈希、全部邻近实体和机械规范完全匹配的构型及记录的行程；不等于任意编辑或制造认证。";
function unknownResult(
  detail: string,
  profileId?: string,
): AssemblyEvidenceResult {
  return {
    status: "unknown",
    matched: false,
    profileId,
    scope,
    issues: [evidenceIssue("unavailable", "unknown", detail)],
    stateRanges: Object.create(null),
    sampled: false,
  };
}
/** Static validation only. Call validateEvidenceState on this result for changing press states. */
export async function validateAssemblyEvidence(
  project: Project,
  raw: unknown,
  sources: AssemblyEvidenceSources,
): Promise<AssemblyEvidenceResult> {
  let profile: AssemblyEvidenceProfile, binding: AssemblyEvidenceBinding;
  try {
    profile = parseAssemblyEvidenceProfile(raw);
    binding = await createAssemblyEvidenceBinding(project);
  } catch (error) {
    return unknownResult(
      error instanceof Error ? error.message : String(error),
    );
  }
  const result: AssemblyEvidenceResult = {
    status: "unknown",
    matched: false,
    profileId: profile.id,
    geometryFingerprint: binding.geometryFingerprint,
    scope: `${profile.scope.description} ${scope}`,
    issues: [],
    stateRanges: Object.create(null),
    sampled: false,
    stateMode: profile.coverage.stateMode,
  };
  const mismatches: string[] = [];
  if (binding.geometryFingerprint !== profile.geometryFingerprint)
    mismatches.push(
      "机械规范已改变：位置、尺寸、角色、触点、物理参数或邻近实体与受检构型不一致，旧证据已失效。",
    );
  if (
    profile.coverage.partCount !== project.parts.length ||
    profile.coverage.mechanismCount !== (project.mechanisms?.length ?? 0)
  )
    mismatches.push("受检零件或机构数量与当前装配不一致。");
  if (
    !sources ||
    sources.reportSha256 !== profile.provenance.reportSha256 ||
    !Array.isArray(sources.sourceHashes)
  )
    mismatches.push("未核对实际源报告文件的SHA-256。");
  const actualSources = new Map<string, EvidenceSourceHash>();
  for (const source of sources?.sourceHashes ?? []) {
    try {
      parseSource(source);
    } catch {
      mismatches.push("当前模型来源哈希无效。");
      continue;
    }
    if (actualSources.has(source.assetUrl))
      mismatches.push("当前模型来源记录重复。");
    actualSources.set(source.assetUrl, source);
  }
  const declaredSources = new Map(
    profile.sourceHashes.map((source) => [source.assetUrl, source]),
  );
  for (const source of profile.sourceHashes) {
    const actual = actualSources.get(source.assetUrl);
    if (
      !actual ||
      ["sourceFile", "sourceSha256", "displaySha256"].some(
        (key) =>
          actual[key as keyof EvidenceSourceHash] !==
          source[key as keyof EvidenceSourceHash],
      )
    )
      mismatches.push(`模型或源文件哈希不匹配：${source.assetUrl}。`);
  }
  for (const part of project.parts)
    if (
      typeof part.params.assetUrl === "string" &&
      !part.model &&
      !declaredSources.has(part.params.assetUrl)
    )
      mismatches.push(`未覆盖当前原始模型来源：${part.params.assetUrl}。`);
  if (mismatches.length) {
    result.issues = [...new Set(mismatches)].map((detail, index) =>
      evidenceIssue(`binding-${index}`, "unknown", detail),
    );
    return result;
  }
  result.matched = true;
  const keyToPart = new Map(
    Object.entries(binding.partKeys).map(([id, key]) => [key, id]),
  );
  let incomplete =
    profile.status === "unknown" ||
    profile.coverage.staticGeometry !== "complete" ||
    profile.coverage.movingAgainstEnvironment !== "complete" ||
    profile.coverage.unknown.length > 0 ||
    profile.scope.excluded.length > 0;
  let failed = profile.status === "fail";
  const markUnknown = (id: string, detail: string) => {
    incomplete = true;
    result.issues.push(evidenceIssue(id, "unknown", detail));
  };
  if (profile.coverage.staticGeometry !== "complete")
    markUnknown(
      "static",
      "固定实体之间的候选接触/干涉尚未全部检查或限定局部预期接触；仅作为运动环境不构成静态装配通过。",
    );
  if (profile.coverage.movingAgainstEnvironment !== "complete")
    markUnknown(
      "environment",
      "活动件与弹簧尚未对完整壳体、底座、线束、PCB及相邻机构检查，不能据此判定整机行程通过。",
    );
  profile.scope.excluded.forEach((detail, index) =>
    markUnknown(`excluded-${index}`, `未覆盖几何：${detail}`),
  );
  profile.coverage.unknown.forEach((detail, index) =>
    markUnknown(`coverage-${index}`, detail),
  );
  if (
    !profile.checks.length ||
    !profile.checks.some((check) => check.category === "geometry")
  )
    markUnknown("checks", "缺少源网格几何检查记录。");
  for (const check of profile.checks) {
    if ((check.partKeys ?? []).some((key) => !keyToPart.has(key))) {
      markUnknown(`check-${check.id}`, "检查记录引用了不属于当前构型的实体。");
      continue;
    }
    failed ||= check.status === "fail";
    incomplete ||= check.status === "unknown";
    result.issues.push(
      evidenceIssue(
        `check-${check.id}`,
        check.status,
        check.detail,
        (check.partKeys ?? []).map((key) => keyToPart.get(key)!),
        check.category,
      ),
    );
  }
  for (const contact of profile.coverage.allowedContacts)
    if (contact.partKeys.some((key) => !keyToPart.has(key)))
      markUnknown(
        "contact",
        "接触许可引用的实体未包含在受检构型中；不得使用通用碰撞忽略规则。",
      );
  const paths = new Map<
    string,
    AssemblyEvidenceProfile["coverage"]["movingPaths"][number]
  >();
  const knownMechanisms = new Set(Object.values(binding.mechanismKeys));
  for (const path of profile.coverage.movingPaths) {
    if (paths.has(path.mechanismKey) || !knownMechanisms.has(path.mechanismKey))
      markUnknown("path-binding", "路径记录重复或引用了未绑定机构。");
    paths.set(path.mechanismKey, path);
  }
  for (const mechanism of project.mechanisms ?? []) {
    const path = paths.get(binding.mechanismKeys[mechanism.id]);
    if (mechanism.kind !== "press") {
      markUnknown(
        `path-${mechanism.id}`,
        "此证据版本仅覆盖绑定静止姿态和按压行程，不认证其他机构运动。",
      );
      continue;
    }
    if (
      !path ||
      !path.sourceChecked ||
      path.minDisplacement !== 0 ||
      path.maxDisplacement < mechanism.params.travel ||
      !Number.isFinite(mechanism.params.travel) ||
      mechanism.params.travel <= 0
    ) {
      markUnknown(
        `path-${mechanism.id}`,
        "机构从静止到最大行程的源网格路径尚未完整验证。",
      );
      continue;
    }
    result.stateRanges[mechanism.id] = {
      min: 0,
      max: Math.min(path.maxDisplacement, mechanism.params.travel),
      partIds: [...mechanism.partIds],
    };
    result.sampled ||= !path.continuous;
  }
  result.status = failed ? "fail" : incomplete ? "unknown" : "pass";
  if (result.status !== "pass")
    result.issues = result.issues.filter((issue) => issue.severity !== "pass");
  if (result.status === "pass")
    result.issues.push(
      evidenceIssue(
        "scope",
        "pass",
        result.sampled
          ? "已匹配源网格离散路径与静态构型记录；采样间隔见证据，不构成连续碰撞保证。"
          : "已匹配源几何完整检查记录及限定行程。",
      ),
    );
  else if (!result.issues.length)
    result.issues.push(
      evidenceIssue(
        "status",
        result.status,
        "源报告尚未给出该构型的全部通过结论。",
      ),
    );
  return result;
}
/** Fast state applicability check: it never upgrades an incomplete or stale static result. */
export function validateEvidenceState(
  base: AssemblyEvidenceResult,
  states: MechanismStates = {},
): AssemblyEvidenceResult {
  if (!base.matched || base.status !== "pass") return base;
  const issues: Issue[] = [];
  if (
    base.stateMode !== "joint-range" &&
    Object.values(states).filter((state) => state && state.displacement > 1e-6)
      .length > 1
  )
    issues.push(
      evidenceIssue(
        "simultaneous-state",
        "unknown",
        "源证据逐键采样且其他键静止；当前多键同时压缩不在已验证状态组合内。",
      ),
    );
  for (const [id, state] of Object.entries(states)) {
    const range = Object.hasOwn(base.stateRanges, id)
      ? base.stateRanges[id]
      : undefined;
    if (
      !range ||
      !state ||
      ![state.displacement, state.velocity, state.force].every(
        Number.isFinite,
      ) ||
      state.displacement < range.min ||
      state.displacement > range.max
    )
      issues.push(
        evidenceIssue(
          `state-${id}`,
          "unknown",
          "当前状态不在已验证的机构行程范围内，不能继续沿用源网格通过结论。",
          range?.partIds ?? [],
        ),
      );
  }
  return issues.length
    ? {
        ...base,
        status: "unknown",
        issues: [
          ...base.issues.filter((issue) => issue.severity !== "pass"),
          ...issues,
        ],
      }
    : base;
}
/** Fixed bundled location; uploaded project JSON cannot supply a self-approved evidence profile. */
export async function loadBundledAssemblyEvidence(
  fetcher: typeof fetch = fetch,
): Promise<{
  profile: AssemblyEvidenceProfile;
  sources: AssemblyEvidenceSources;
}> {
  const response = await fetcher(ASSEMBLY_EVIDENCE_URL);
  if (!response.ok) throw Error("尚未提供本版本的源几何证据。");
  const profile = parseAssemblyEvidenceProfile(await response.json());
  const report = await fetcher(profile.provenance.reportUrl);
  if (!report.ok) throw Error("源几何报告不可用。");
  const reportBytes = new Uint8Array(await report.arrayBuffer());
  const reportSha256 = await evidenceSha256(reportBytes);
  if (reportSha256 !== profile.provenance.reportSha256)
    throw Error("源几何报告SHA-256不匹配。");
  const reportBody: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(reportBytes),
  );
  if (
    !record(reportBody) ||
    reportBody.geometryFingerprint !== profile.geometryFingerprint ||
    reportBody.status !== profile.status ||
    !Array.isArray(reportBody.sourceHashes)
  )
    throw Error("源报告正文的构型指纹或结论与证据不一致。");
  if (
    profile.status === "pass" &&
    (!Array.isArray(reportBody.audits) ||
      reportBody.audits.length === 0 ||
      reportBody.audits.some(
        (audit: unknown) => !record(audit) || audit.status !== "pass",
      ))
  )
    throw Error("源审计未全部完成或仍含fail/unknown，不能汇总为完整通过。");
  const reportSources = reportBody.sourceHashes.map(parseSource);
  const sourceSignature = (entries: EvidenceSourceHash[]) =>
    JSON.stringify(
      canonical(
        [...entries].sort((a, b) =>
          a.assetUrl < b.assetUrl ? -1 : a.assetUrl > b.assetUrl ? 1 : 0,
        ),
      ),
    );
  if (sourceSignature(reportSources) !== sourceSignature(profile.sourceHashes))
    throw Error("源报告正文的来源哈希与证据不一致。");
  const diagnosticResponse = await fetcher(ASSEMBLY_DIAGNOSTICS_URL);
  if (!diagnosticResponse.ok) throw Error("随应用提供的源模型诊断清单不可用。");
  const diagnostics: unknown = await diagnosticResponse.json();
  if (!record(diagnostics) || !Array.isArray(diagnostics.assets))
    throw Error("源模型诊断清单格式无效。");
  const diagnosticById = new Map<string, Record<string, unknown>>();
  for (const entry of diagnostics.assets) {
    if (!record(entry) || !nonempty(entry.id) || diagnosticById.has(entry.id))
      throw Error("源模型诊断标识重复或无效。");
    diagnosticById.set(entry.id, entry);
  }
  const sourceHashes = await Promise.all(
    profile.sourceHashes.map(async (source) => {
      const assetId = source.assetUrl.slice("./models/".length, -".glb".length);
      const diagnostic = diagnosticById.get(assetId);
      if (
        !diagnostic ||
        diagnostic.sourceSha256 !== source.sourceSha256 ||
        diagnostic.displaySha256 !== source.displaySha256
      )
        throw Error(
          `报告与随应用提供的源模型诊断哈希不一致：${source.assetUrl}`,
        );
      const model = await fetcher(source.assetUrl);
      if (!model.ok) throw Error(`模型来源不可用：${source.assetUrl}`);
      const displaySha256 = await evidenceSha256(
        new Uint8Array(await model.arrayBuffer()),
      );
      if (displaySha256 !== source.displaySha256)
        throw Error(`模型SHA-256不匹配：${source.assetUrl}`);
      // Source .blend files are not shipped; their recorded hashes agree in the report and export diagnostics.
      return { ...source, displaySha256 };
    }),
  );
  return { profile, sources: { sourceHashes, reportSha256 } };
}
