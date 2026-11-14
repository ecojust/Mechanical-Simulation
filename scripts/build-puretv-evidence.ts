/** Build hash-bound evidence from final source audits and the actual MCP-exported assembly.
 * npx vite-node --script scripts/build-puretv-evidence.ts --audit docs/puretv-geometry-assembly.json \
 *   --audit docs/puretv-geometry-internals-after.json --audit docs/puretv-geometry-locks.json \
 *   --audit docs/puretv-display-consistency.json
 * Incomplete inputs produce UNKNOWN; --require-pass additionally exits unsuccessfully.
 */
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parseProject } from "../src/catalog";
import { validateAssembly } from "../src/engine/physics";
import { createAssemblyEvidenceBinding } from "../src/assemblyEvidence";
import type {
  AssemblyEvidenceProfile,
  EvidenceStatus,
  EvidenceSourceHash,
} from "../src/assemblyEvidence";
import type { Project, Part, AssetEntry } from "../src/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEYS = ["left", "right", "down", "up", "a", "b", "x", "y", "confirm"];
const MOVING_ROLES = new Set([
  "cap",
  "label",
  "spring-seat",
  "spring",
  "switch-actuator",
]);
type Json = Record<string, any>;
export interface Finding {
  status: EvidenceStatus;
  detail: string;
}
export interface NormalizedAudit {
  role: "assembly" | "internals" | "locks" | "housing" | "display" | "unknown";
  status: EvidenceStatus;
  findings: Finding[];
  staticComplete: boolean;
  environmentComplete: boolean;
  stateMode: "single-key-at-rest" | "joint-range";
  paths: Record<string, { maxDisplacement: number; maxSampleStepMm: number }>;
  allowedContacts: Json[];
}
interface AuditContext {
  sourceSha256: Record<string, string>;
  displaySha256?: Record<string, string>;
  originalCount: number;
  sourceObjects: Set<string>;
  calibration: Json | null;
}
const object = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const array = (value: unknown): any[] => (Array.isArray(value) ? value : []);
const number = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const close = (a: unknown, b: unknown, tolerance = 0.002) =>
  number(a) && number(b) && Math.abs(a - b) <= tolerance;
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : object(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const same = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const vecClose = (a: unknown, b: unknown, tolerance = 0.000002) =>
  Array.isArray(a) &&
  Array.isArray(b) &&
  a.length === 3 &&
  b.length === 3 &&
  a.every((value, index) => close(value, b[index], tolerance));
const sortedIds = (value: unknown): unknown[] => array(value).slice().sort();
/** Only calibration transport comparison allows 1e-12 decimal representation error.
 * The final project snapshot and SHA-256 fingerprint remain exact, without rounding. */
const numericParametersEqual = (actual: unknown, expected: unknown) =>
  object(actual) &&
  object(expected) &&
  same(Object.keys(actual).sort(), Object.keys(expected).sort()) &&
  Object.keys(expected).every((key) =>
    close(actual[key], expected[key], 1e-12),
  );
const sumStatus = (values: EvidenceStatus[]): EvidenceStatus =>
  values.includes("fail")
    ? "fail"
    : values.includes("unknown") || !values.length
      ? "unknown"
      : "pass";
const shaBytes = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const jsonSha = (value: unknown) => shaBytes(JSON.stringify(value));
export const validEvidenceTimestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const pairCount = (n: number) => (n * (n - 1)) / 2;
const sourceFile = (value: string) =>
  value.replace(/^assets\/puretv-controller\//, "");
const sourceObject = (file: string, name: string) =>
  `${sourceFile(file)}::${name}`;
function filePath(input: string): { absolute: string; relative: string } {
  const absolute = path.resolve(ROOT, input),
    relative = path.relative(ROOT, absolute).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative))
    throw Error("Evidence inputs must be repository-relative files");
  return { absolute, relative };
}
async function fileSha(relative: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath(relative).absolute))
    hash.update(chunk);
  return hash.digest("hex");
}
async function readJson(relative: string): Promise<Json> {
  return JSON.parse(await fs.readFile(filePath(relative).absolute, "utf8"));
}
/** Public summaries retain relative provenance, never local credentials or machine paths. */
export function publicValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (path.isAbsolute(value)) {
      const relative = path.relative(ROOT, value).split(path.sep).join("/");
      return relative.startsWith("../")
        ? "[external local path omitted]"
        : relative;
    }
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
      .replace(
        /https?:\/\/(?:localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)(?::\d+)?[^\s"']*/g,
        "[local endpoint omitted]",
      )
      .replaceAll(ROOT + "/", "");
  }
  if (Array.isArray(value)) return value.map(publicValue);
  if (object(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        /^(token|authorization|password|secret|apiKey|environment|env)$/i.test(
          key,
        )
          ? "[redacted]"
          : publicValue(entry),
      ]),
    );
  return value;
}
function sourceHashRecords(report: Json): [string, string][] {
  const hashes: [string, string][] = [];
  if (object(report.sourceSha256))
    for (const [file, hash] of Object.entries(report.sourceSha256))
      if (typeof hash === "string") hashes.push([sourceFile(file), hash]);
  for (const row of [...array(report.buttons), ...array(report.objects)]) {
    if (
      typeof row.sourceFile === "string" &&
      typeof row.sourceSha256 === "string"
    )
      hashes.push([sourceFile(row.sourceFile), row.sourceSha256]);
    if (
      typeof row.plateFile === "string" &&
      typeof row.plateSha256 === "string"
    )
      hashes.push([sourceFile(row.plateFile), row.plateSha256]);
  }
  return hashes;
}
function recordedHashes(report: Json): Record<string, string> {
  return Object.fromEntries(sourceHashRecords(report));
}
const CLEAR = new Set([
  "no-intersection-observed",
  "no-intersection-found",
  "disjoint-bounds",
  "separated_bounding_boxes",
  "no_surface_intersection_or_component_containment_observed",
]);
function geometryStatus(result: Json): EvidenceStatus {
  if (!object(result)) return "unknown";
  if (CLEAR.has(result.status)) {
    if (
      [
        result.insideVertices,
        result.strictInteriorSamples,
        result.aInsideB?.insidePoints,
        result.bInsideA?.insidePoints,
      ].some((count) => number(count) && count > 0) ||
      (number(result.maximumSampledPenetrationMm) &&
        result.maximumSampledPenetrationMm > 1e-5)
    )
      return "fail";
    if (
      (number(result.surfaceTrianglePairs) &&
        result.surfaceTrianglePairs > 0) ||
      [result.aInsideB?.uncertainPoints, result.bInsideA?.uncertainPoints].some(
        (count) => number(count) && count > 0,
      )
    )
      return "unknown";
    return "pass";
  }
  if (result.status === "penetration-evidence" || result.status === "fail")
    return "fail";
  if (
    ["allowed-local-interface", "expected-contact-within-limit"].includes(
      result.status,
    )
  ) {
    const permission = result.allowedInterface ?? result.expectedContact;
    const region =
      permission?.regionBlenderAtPose ??
      (object(permission?.region)
        ? permission.region
        : {
            min: permission?.regionSourceMin,
            max: permission?.regionSourceMax,
          });
    const wholeOverlap = result.possibleOverlapBoundsBlender;
    const regions = Array.isArray(permission?.regionsBlenderAtPose)
      ? permission.regionsBlenderAtPose
      : [region];
    const validRegions =
      regions.length > 0 &&
      regions.every(
        (box: Json) =>
          object(box) &&
          vecClose(box.min, box.min) &&
          vecClose(box.max, box.max) &&
          box.min.every(
            (value: number, index: number) => value <= box.max[index],
          ),
      );
    const boundedProof =
      result.status === "allowed-local-interface"
        ? validRegions &&
          (permission?.localRegionProof?.proven === true ||
            (object(wholeOverlap) &&
              vecClose(wholeOverlap.min, wholeOverlap.min) &&
              vecClose(wholeOverlap.max, wholeOverlap.max) &&
              regions.some(
                (box: Json) =>
                  wholeOverlap.min.every(
                    (value: number, index: number) =>
                      value >= box.min[index] - 1e-5,
                  ) &&
                  wholeOverlap.max.every(
                    (value: number, index: number) =>
                      value <= box.max[index] + 1e-5,
                  ),
              )))
        : close(
            permission?.observedPenetrationMm,
            result.maximumSampledPenetrationMm,
            1e-8,
          ) &&
          Array.isArray(permission?.partNames) &&
          permission.partNames.length === 2 &&
          permission.partNames.every(
            (value: unknown) => typeof value === "string" && value.length > 0,
          );
    return object(permission) &&
      typeof permission.id === "string" &&
      permission.id.length > 0 &&
      boundedProof &&
      (permission.annularRegionProof === undefined ||
        permission.annularRegionProof?.proven === true) &&
      object(region) &&
      vecClose(region.min, region.min) &&
      vecClose(region.max, region.max) &&
      region.min.every(
        (value: number, index: number) => value <= region.max[index],
      ) &&
      number(permission.maximumPenetrationMm) &&
      permission.maximumPenetrationMm >= 0 &&
      number(result.maximumSampledPenetrationMm) &&
      result.maximumSampledPenetrationMm >= 0 &&
      result.maximumSampledPenetrationMm <=
        permission.maximumPenetrationMm + 1e-5
      ? "pass"
      : "unknown";
  }
  return "unknown";
}
function sampledPath(
  values: number[],
  travel: number,
): { maxDisplacement: number; maxSampleStepMm: number } | null {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  if (
    !number(travel) ||
    travel <= 0 ||
    sorted.length < 2 ||
    !close(sorted[0], 0, 1e-6) ||
    !close(sorted.at(-1), travel, 1e-6)
  )
    return null;
  const step = Math.max(
    ...sorted.slice(1).map((value, index) => value - sorted[index]),
  );
  return step > 0 && step <= 0.25 + 1e-6
    ? { maxDisplacement: travel, maxSampleStepMm: step }
    : null;
}
/** Recompute only the inexpensive source AABB plan so missing pair records cannot be hidden by optimistic counters. */
function verifySourcePairPlan(report: Json, calibration: Json | null): boolean {
  const objects = array(report.objects),
    coverage = report.coverage;
  const frames = array(coverage.contexts);
  const pretravel = report.method?.switchPretravelMm;
  if (
    !number(pretravel) ||
    !objects.length ||
    !objects.every(
      (item) =>
        object(item.boundsBlender) &&
        vecClose(item.boundsBlender.min, item.boundsBlender.min) &&
        vecClose(item.boundsBlender.max, item.boundsBlender.max) &&
        item.boundsBlender.min.every(
          (value: number, index: number) =>
            value <= item.boundsBlender.max[index],
        ),
    )
  )
    return false;
  for (const button of array(calibration?.buttons)) {
    if (
      !vecClose(button.axis, [0, 1, 0]) ||
      !close(pretravel, button.travel - (button.maxOvertravel ?? 0.25), 1e-6)
    )
      return false;
    const owned = objects.filter((item) => item.key === button.key);
    const roles = [
      [new Set(["cap", "label", "spring-seat"]), array(button.movingNodes)],
      [new Set(["spring"]), array(button.springNodes)],
      [new Set(["switch-actuator"]), array(button.actuatorNodes)],
    ] as const;
    for (const [role, names] of roles)
      if (
        !same(
          owned
            .filter((item) => role.has(item.role))
            .map((item) => item.sourceName)
            .sort(),
          names.slice().sort(),
        )
      )
        return false;
  }
  const moved = (item: Json, distance: number) => ({
    min: item.boundsBlender.min.map(
      (value: number, index: number) =>
        value - (index === 2 && item.role !== "spring" ? distance : 0),
    ),
    max: item.boundsBlender.max.map(
      (value: number, index: number) => value - (index === 2 ? distance : 0),
    ),
  });
  const overlap = (a: Json, b: Json) =>
    [0, 1, 2].every(
      (index) =>
        a.max[index] >= b.min[index] - 1e-5 &&
        b.max[index] >= a.min[index] - 1e-5,
    );
  const distance = (item: Json, key: string, stroke: number) =>
    item.key !== key || !MOVING_ROLES.has(item.role)
      ? 0
      : item.role === "switch-actuator"
        ? Math.max(0, stroke - pretravel)
        : stroke;
  const token = (a: string, b: string, da: number, db: number) =>
    `${a}@${da.toFixed(8)}|${b}@${db.toFixed(8)}`;
  const jobs = new Map<string, Set<string>>();
  const consider = (
    a: Json,
    b: Json,
    da: number,
    db: number,
    context: string,
  ) => {
    if (!overlap(moved(a, da), moved(b, db))) return false;
    const id = token(a.id, b.id, da, db),
      contexts = jobs.get(id) ?? new Set<string>();
    contexts.add(context);
    jobs.set(id, contexts);
    return true;
  };
  const pairs: [Json, Json][] = [];
  for (let index = 0; index < objects.length; index++)
    for (let next = index + 1; next < objects.length; next++)
      pairs.push([objects[index], objects[next]]);
  const rest = frames.filter((row) => row.scenario === "rest-all-pairs");
  if (rest.length !== 1) return false;
  let restCandidates = 0;
  for (const [a, b] of pairs)
    if (consider(a, b, 0, 0, "rest")) restCandidates++;
  if (
    rest[0].candidatePairs !== restCandidates ||
    rest[0].aabbSeparatedPairs !== pairs.length - restCandidates
  )
    return false;
  const strokesByKey = new Map<string, number[]>();
  for (const key of KEYS) {
    const selected = frames.filter(
      (row) => row.scenario === `key-${key}-against-entire-environment`,
    );
    strokesByKey.set(
      key,
      selected.map((row) => row.strokeMm),
    );
    for (const frame of selected) {
      let checked = 0,
        candidates = 0;
      for (const [a, b] of pairs) {
        if (
          ![a, b].some(
            (item) => item.key === key && MOVING_ROLES.has(item.role),
          )
        )
          continue;
        checked++;
        if (
          consider(
            a,
            b,
            distance(a, key, frame.strokeMm),
            distance(b, key, frame.strokeMm),
            `${key}@${frame.strokeMm.toFixed(8)}`,
          )
        )
          candidates++;
      }
      if (
        frame.consideredPairs !== checked ||
        frame.candidatePairs !== candidates ||
        frame.aabbSeparatedPairs !== checked - candidates
      )
        return false;
    }
  }
  if (coverage.stateMode === "joint-range") {
    const joint = coverage.jointRangeCoverage;
    if (!object(joint)) return false;
    const observed = new Map(
      array(joint.candidates).map((entry) => [`${entry.a}|${entry.b}`, entry]),
    );
    const excluded = new Map(
      array(joint.sweptBoundsExcludedPairs).map((entry) => [
        `${entry.a}|${entry.b}`,
        entry,
      ]),
    );
    let cross = 0,
      candidates = 0,
      poseCount = 0;
    const swept = (item: Json) => {
      const boxes = array(strokesByKey.get(item.key)).map((stroke) =>
        moved(item, distance(item, item.key, stroke)),
      );
      return {
        min: [0, 1, 2].map((index) =>
          Math.min(...boxes.map((box) => box.min[index])),
        ),
        max: [0, 1, 2].map((index) =>
          Math.max(...boxes.map((box) => box.max[index])),
        ),
      };
    };
    for (const [a, b] of pairs) {
      if (
        !MOVING_ROLES.has(a.role) ||
        !MOVING_ROLES.has(b.role) ||
        a.key === b.key
      )
        continue;
      cross++;
      const as = swept(a),
        bs = swept(b),
        key = `${a.id}|${b.id}`;
      const entry = overlap(as, bs) ? observed.get(key) : excluded.get(key);
      if (
        !entry ||
        !vecClose(entry.aSweptBounds?.min, as.min) ||
        !vecClose(entry.aSweptBounds?.max, as.max) ||
        !vecClose(entry.bSweptBounds?.min, bs.min) ||
        !vecClose(entry.bSweptBounds?.max, bs.max)
      )
        return false;
      if (!overlap(as, bs)) continue;
      candidates++;
      for (const sa of strokesByKey.get(a.key) ?? [])
        for (const sb of strokesByKey.get(b.key) ?? []) {
          poseCount++;
          const pose = array(entry.poses).filter(
            (row) => row.aStrokeMm === sa && row.bStrokeMm === sb,
          );
          if (pose.length !== 1) return false;
          const da = distance(a, a.key, sa),
            db = distance(b, b.key, sb);
          const candidate = consider(
            a,
            b,
            da,
            db,
            `joint:${a.key}@${sa.toFixed(8)},${b.key}@${sb.toFixed(8)}`,
          );
          if (candidate === pose[0].aabbSeparated) return false;
          if (candidate) {
            const job = array(coverage.candidates).find(
              (row) => row.id === pose[0].checkId,
            );
            if (
              !job ||
              token(job.a, job.b, job.aMotionMm, job.bMotionMm) !==
                token(a.id, b.id, da, db)
            )
              return false;
          } else if (pose[0].checkId !== null) return false;
        }
    }
    if (
      cross !== joint.movingObjectPairs ||
      candidates !== joint.sweptCandidatePairs ||
      excluded.size !== cross - candidates ||
      observed.size !== candidates ||
      joint.requiredPosePairs !== poseCount
    )
      return false;
  }
  const actual = array(coverage.candidates);
  if (actual.length !== jobs.size) return false;
  const seen = new Set<string>();
  for (const candidate of actual) {
    if (!number(candidate.aMotionMm) || !number(candidate.bMotionMm))
      return false;
    const key = token(
        candidate.a,
        candidate.b,
        candidate.aMotionMm,
        candidate.bMotionMm,
      ),
      expected = jobs.get(key);
    if (
      !expected ||
      seen.has(key) ||
      !same([...expected].sort(), array(candidate.contexts).slice().sort())
    )
      return false;
    seen.add(key);
  }
  return seen.size === jobs.size;
}

function verifiedBearingPatches(contact: Json): boolean {
  const pairs = array(contact.supportingTrianglePairs),
    center = contact.sourceAxisCenterXY;
  if (
    !Array.isArray(center) ||
    center.length !== 2 ||
    !center.every(number) ||
    pairs.length !== contact.opposingHorizontalPairs ||
    !pairs.length
  )
    return false;
  const totals = [0, 0],
    identities = new Set<string>();
  for (const pair of pairs) {
    const polygon = array(pair.polygonSourceXY);
    if (
      ![0, 1].includes(pair.sector) ||
      !Number.isSafeInteger(pair.movingTriangle) ||
      pair.movingTriangle < 0 ||
      !Number.isSafeInteger(pair.fixedTriangle) ||
      pair.fixedTriangle < 0 ||
      polygon.length < 3 ||
      polygon.some(
        (p) => !Array.isArray(p) || p.length !== 2 || !p.every(number),
      )
    )
      return false;
    const id = `${pair.movingTriangle}/${pair.fixedTriangle}`;
    if (identities.has(id)) return false;
    identities.add(id);
    let area = 0;
    for (let index = 0; index < polygon.length; index++) {
      const point = polygon[index],
        next = polygon[(index + 1) % polygon.length],
        dx = point[0] - center[0],
        dy = point[1] - center[1];
      const radius = Math.hypot(dx, dy),
        angle = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360,
        [min, max] = pair.sector === 0 ? [35, 65] : [215, 245];
      if (
        radius < 6.8 - 1e-5 ||
        radius > 9.6 + 1e-5 ||
        angle < min - 1e-5 ||
        angle > max + 1e-5
      )
        return false;
      area += point[0] * next[1] - point[1] * next[0];
    }
    area = Math.abs(area) / 2;
    if (area <= 0 || !close(area, pair.areaMm2, 1e-7)) return false;
    totals[pair.sector] += area;
  }
  return totals.every(
    (area, index) =>
      area > 0.01 && close(area, contact.bearingPatchAreasMm2?.[index], 1e-5),
  );
}

/** A single measured bearing interface is not a general collision exemption. */
export function lockSampleStatus(sample: Json, row: Json): EvidenceStatus {
  if (!completeSampleCounts(sample)) return "unknown";
  if (sample?.status !== "nominal-load-bearing-contact")
    return geometryStatus(sample);
  const contact = sample.bearingContact;
  const counts = [
    contact?.contactPairs,
    contact?.opposingHorizontalPairs,
    contact?.opposingHorizontalPairsReturnedByBvh,
    contact?.boundaryPairs,
  ];
  return row.key === "confirm" &&
    sourceFile(row.sourceFile ?? "") === "buttons/confirm.blend" &&
    sourceFile(row.plateFile ?? "") === "housing/top.blend" &&
    close(sample.angleDeg, 0, 1e-8) &&
    close(sample.axialOffsetMm, 0, 1e-8) &&
    object(contact) &&
    contact.status === "nominal-load-bearing-contact" &&
    close(contact.sourcePlaneZ, 25.45, 0.0001) &&
    same(contact.allowedRadialBandMm, [6.8, 9.6]) &&
    same(contact.allowedAngularSectorsDeg, [
      [35, 65],
      [215, 245],
    ]) &&
    Array.isArray(contact.sourceAxisCenterXY) &&
    contact.sourceAxisCenterXY.length === 2 &&
    contact.sourceAxisCenterXY.every((value: number, index: number) =>
      close(value, row.axisCenterSourceXY?.[index], 1e-5),
    ) &&
    counts.every((count) => Number.isSafeInteger(count) && count >= 0) &&
    contact.contactPairs > 0 &&
    contact.opposingHorizontalPairsReturnedByBvh + contact.boundaryPairs ===
      contact.contactPairs &&
    verifiedBearingPatches(contact) &&
    sample.surfaceTrianglePairs === contact.contactPairs &&
    contact.rejectedPairCount === 0 &&
    array(contact.rejectedPairs).length === 0 &&
    contact.strictInteriorSamples === 0 &&
    sample.strictInteriorSamples === 0 &&
    number(contact.numericPlaneToleranceMm) &&
    contact.numericPlaneToleranceMm > 0 &&
    contact.numericPlaneToleranceMm <= 0.0001 &&
    number(contact.maximumIntersectionPlaneDeviationMm) &&
    contact.maximumIntersectionPlaneDeviationMm >= 0 &&
    contact.maximumIntersectionPlaneDeviationMm <=
      contact.numericPlaneToleranceMm &&
    Array.isArray(contact.bearingPatchAreasMm2) &&
    contact.bearingPatchAreasMm2.length === 2 &&
    contact.bearingPatchAreasMm2.every(
      (value: unknown) => number(value) && value > 0.01,
    )
    ? "pass"
    : "unknown";
}
function retainedBySource(probe: Json): boolean {
  return (
    object(probe) &&
    probe.status === "penetration-evidence" &&
    number(probe.strictInteriorSamples) &&
    probe.strictInteriorSamples > 0 &&
    array(probe.penetrationExamples).some(
      (point) => number(point.depthMm) && point.depthMm > 0,
    )
  );
}
function pathStepsBounded(path: Json): boolean {
  const samples = array(path.samples),
    radius = path.maximumSleeveRadiusMm;
  if (samples.length < 2 || !number(radius) || radius <= 0) return false;
  return samples.every((sample, index) => {
    if (!number(sample.angleDeg) || !number(sample.axialOffsetMm)) return false;
    if (!index) return true;
    const previous = samples[index - 1],
      shift = Math.abs(sample.axialOffsetMm - previous.axialOffsetMm),
      turn = (Math.abs(sample.angleDeg - previous.angleDeg) * Math.PI) / 180;
    return (
      turn <= Math.PI && shift + 2 * radius * Math.sin(turn / 2) <= 0.1 + 1e-6
    );
  });
}

const completeSampleCounts = (sample: Json) =>
  [sample?.surfaceTrianglePairs, sample?.strictInteriorSamples].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  );
const sampleEvidence = (sample: Json) =>
  object(sample)
    ? Object.fromEntries(
        Object.entries(sample).filter(
          ([key]) =>
            !["stage", "maximumVertexTravelFromPreviousMm"].includes(key),
        ),
      )
    : null;

function installationContactStatus(
  sample: Json,
  check: Json,
  calibration: Json,
): EvidenceStatus {
  if (!completeSampleCounts(sample)) return "unknown";
  if (!sample?.contactProof) return geometryStatus(sample);
  const proof = sample.contactProof,
    low = proof.sourcePatchMin,
    high = proof.sourcePatchMax,
    box = proof.contactBoundsSource,
    tol = proof.numericToleranceMm;
  const permitted =
    check.moving === calibration.switchNode &&
    check.fixed === calibration.strikerNode &&
    proof.status === "nominal-actuator-end-contact" &&
    proof.allowedPenetrationMm === 0 &&
    number(tol) &&
    tol > 0 &&
    tol <= 1e-5 &&
    sample.strictInteriorSamples === 0 &&
    sample.strictPlaneStraddlePairs === 0 &&
    array(sample.penetrationExamples).length === 0 &&
    Number.isSafeInteger(proof.exactContactPairs) &&
    proof.exactContactPairs > 0 &&
    proof.exactContactPairs === sample.surfaceTrianglePairs &&
    array(proof.rejectedPairs).length === 0 &&
    close(proof.sourcePlaneZ, calibration.strikerSourceClient?.[1], tol) &&
    vecClose(low, low) &&
    vecClose(high, high) &&
    object(box) &&
    vecClose(box.min, box.min) &&
    vecClose(box.max, box.max) &&
    low.every(
      (v: number, i: number) =>
        v <= high[i] &&
        box.min[i] >= v - tol &&
        box.max[i] <= high[i] + tol &&
        box.min[i] <= box.max[i],
    ) &&
    close(box.min[2], proof.sourcePlaneZ, tol) &&
    close(box.max[2], proof.sourcePlaneZ, tol);
  return permitted ? "pass" : geometryStatus(sample);
}
export function validateInstallationSubgroup(
  row: Json,
  context: AuditContext,
): Finding[] {
  const findings: Finding[] = [];
  const add = (detail: string, status: EvidenceStatus = "unknown") =>
    findings.push({ status, detail: `${row.key}: ${detail}` });
  const group = row.installation?.movingSubgroupAssembly,
    calibration = array(context.calibration?.buttons).find(
      (entry) => entry.key === row.key,
    );
  if (!object(group) || !calibration)
    return [
      {
        status: "unknown",
        detail: `${row.key}: full source installation subgroup audit or calibration is missing.`,
      },
    ];
  if (
    group.status !== "sampled-path-clear" ||
    group.sourceFilesUnchanged !== true ||
    group.blockedSampleCount !== 0 ||
    group.reverseRemoval?.status !== "sampled-path-clear"
  )
    add("auxiliary installation subgroup remains incomplete or blocked.");
  const expectedFiles = [
    sourceFile(row.sourceFile),
    sourceFile(row.plateFile),
  ].sort();
  if (
    !object(group.sourceHashes) ||
    !same(
      Object.keys(group.sourceHashes).map(sourceFile).sort(),
      expectedFiles,
    ) ||
    Object.entries(group.sourceHashes).some(
      ([file, hash]) => context.sourceSha256[sourceFile(file)] !== hash,
    )
  )
    add("installation subgroup source hashes are stale or incomplete.");
  const moving = array(group.movingMembers),
    fixed = array(group.fixedMembers),
    primary = row.sourceObjects?.[0]?.name,
    plate = row.sourceObjects?.[1]?.name;
  const expectedFixed =
    row.key === "confirm" ? [plate, calibration.strikerNode] : [plate];
  if (
    primary !== calibration.installationPrimaryNode ||
    !same(
      moving.slice().sort(),
      array(calibration.installationMovingNodes).slice().sort(),
    ) ||
    moving.length !== (row.key === "confirm" ? 4 : 6) ||
    !same(fixed.slice().sort(), expectedFixed.sort()) ||
    new Set(moving).size !== moving.length ||
    new Set(fixed).size !== fixed.length
  )
    add(
      "source installation subgroup members/hosts do not match explicit calibration and main mating pair.",
    );
  const sourceObjects = new Map(
    array(group.sourceObjects).map((item) => [item.name, item]),
  );
  if ([...moving, ...fixed].some((name) => !sourceObjects.has(name)))
    add("installation subgroup omits actual source object records.");
  const expectedPairs = new Set(
      moving.flatMap((a) => fixed.map((b) => `${a}::${b}`)),
    ),
    seen = new Set<string>();
  if (array(group.checks).length !== expectedPairs.size)
    add("installation subgroup does not enumerate every member/host pair.");
  for (const check of array(group.checks)) {
    const pair = `${check.moving}::${check.fixed}`;
    if (!expectedPairs.has(pair) || seen.has(pair))
      add("installation subgroup repeats or substitutes a source pair.");
    seen.add(pair);
    if (check.blockedSamples !== 0)
      add("installation pair contains blocked or missing sample results.");
    const forward = array(check.samples),
      reverse = array(check.reverseSamples),
      objectRow = sourceObjects.get(check.moving);
    if (forward.length < 2 || reverse.length !== forward.length) {
      add("installation forward/reverse samples are incomplete.");
      continue;
    }
    if (
      !objectRow ||
      !vecClose(objectRow.sourceMin, objectRow.sourceMin) ||
      !vecClose(objectRow.sourceMax, objectRow.sourceMax)
    ) {
      add("installation moving object source bounds are missing.");
      continue;
    }
    const center = array(row.axisCenterSourceXY),
      radius = Math.max(
        ...[objectRow.sourceMin[0], objectRow.sourceMax[0]].flatMap(
          (x: number) =>
            [objectRow.sourceMin[1], objectRow.sourceMax[1]].map((y: number) =>
              Math.hypot(x - center[0], y - center[1]),
            ),
        ),
      );
    if (
      !number(radius) ||
      !pathStepsBounded({ samples: forward, maximumSleeveRadiusMm: radius })
    )
      add(
        "installation moving member path has unverified >0.1 mm vertex steps.",
      );
    if (
      !close(forward[0].angleDeg, row.path.entryAngleDeg, 1e-8) ||
      !close(forward[0].axialOffsetMm, row.path.startAxialOffsetMm, 1e-8) ||
      !close(forward.at(-1)?.angleDeg, row.path.lockedAngleDeg, 1e-8) ||
      !close(forward.at(-1)?.axialOffsetMm, 0, 1e-8)
    )
      add(
        "installation member path endpoints differ from the main source lock path.",
      );
    if (row.key !== "confirm") {
      if (
        forward.length !== array(row.path.samples).length ||
        forward.some(
          (sample, index) =>
            !close(sample.angleDeg, row.path.samples[index]?.angleDeg, 1e-8) ||
            !close(
              sample.axialOffsetMm,
              row.path.samples[index]?.axialOffsetMm,
              1e-8,
            ),
        )
      )
        add(
          "standard-key auxiliary members do not follow the complete checked main lock trajectory.",
        );
    } else {
      if (
        !close(group.initialActuatorGapMm, calibration.measuredRestGap, 1e-5) ||
        !close(
          group.declaredActuatorTravelMm,
          calibration.maxOvertravel,
          1e-5,
        ) ||
        !close(
          group.maximumActuatorCompressionMm,
          Math.max(
            0,
            row.path.seatedAxialOffsetMm - group.initialActuatorGapMm,
          ),
          1e-5,
        ) ||
        group.maximumActuatorCompressionMm >
          group.declaredActuatorTravelMm + 1e-5
      )
        add(
          "confirmation installation exceeds or misbinds the measured compliant actuator travel.",
        );
      for (const sample of forward) {
        const seat = sample.seatOffsetMm,
          angle = sample.angleDeg,
          entry = row.path.entryAngleDeg,
          locked = row.path.lockedAngleDeg,
          turn = row.path.seatedAxialOffsetMm,
          start = row.path.startAxialOffsetMm;
        const onPath =
          number(seat) &&
          number(angle) &&
          ((close(angle, entry, 1e-8) &&
            seat >= Math.min(start, turn) - 1e-8 &&
            seat <= Math.max(start, turn) + 1e-8) ||
            (close(seat, turn, 1e-8) &&
              angle >= Math.min(entry, locked) - 1e-8 &&
              angle <= Math.max(entry, locked) + 1e-8) ||
            (close(angle, locked, 1e-8) &&
              seat >= Math.min(turn, 0) - 1e-8 &&
              seat <= Math.max(turn, 0) + 1e-8));
        const actuator = array(calibration.actuatorNodes).includes(
          check.moving,
        );
        if (
          !onPath ||
          !close(
            sample.axialOffsetMm,
            actuator ? Math.min(seat, group.initialActuatorGapMm) : seat,
            1e-8,
          ) ||
          (actuator &&
            !close(
              sample.actuatorCompressionMm,
              Math.max(0, seat - group.initialActuatorGapMm),
              1e-8,
            ))
        ) {
          add(
            "confirmation members do not follow the checked contact-limited installation path.",
          );
          break;
        }
      }
    }
    for (const [phase, samples] of [
      ["forward", forward],
      ["reverse", reverse],
    ] as const)
      for (const sample of samples) {
        const status = installationContactStatus(sample, check, calibration);
        if (status !== "pass")
          add(
            `${phase} subgroup source pair ${pair}: ${sample?.status ?? "missing"}`,
            status,
          );
      }
    if (
      reverse.some(
        (sample, index) =>
          !same(
            sampleEvidence(sample),
            sampleEvidence(forward[forward.length - index - 1]),
          ),
      )
    )
      add(
        "reverse subgroup motion does not replay the complete tested source poses.",
      );
  }
  return findings;
}

/** Interpret actual check records, never a top-level optimistic summary alone. */
export function validateHarnessSelfIntersection(report: Json): Finding[] {
  const inventory = array(report.objects).filter(
    (item) => sourceFile(item.sourceFile ?? "") === "electronics/harness.blend",
  );
  if (!inventory.length) return [];
  const review = report.selfIntersectionReview,
    findings: Finding[] = [];
  const add = (detail: string, status: EvidenceStatus = "unknown") =>
    findings.push({ status, detail });
  if (!object(review))
    return [
      {
        status: "unknown",
        detail: "Actual harness mesh self-intersection checks are missing.",
      },
    ];
  const expectedIds = inventory.map((item) => item.id).sort();
  if (
    review.complete !== true ||
    review.status !== "pass" ||
    report.summary?.selfIntersectionCoverageComplete !== true ||
    !same(review.scopeSourceFiles, ["electronics/harness.blend"]) ||
    !same(array(review.requiredObjectIds).slice().sort(), expectedIds)
  )
    add("Harness self-intersection scope/inventory is incomplete.");
  const checks = array(review.checks),
    byId = new Map(checks.map((item) => [item.id, item]));
  if (checks.length !== inventory.length || byId.size !== checks.length)
    add("Harness self-intersection records are missing or duplicated.");
  for (const item of inventory) {
    const check = byId.get(item.id),
      result = check?.result;
    if (
      !check ||
      !object(result) ||
      check.sourceSha256 !== item.sourceSha256 ||
      result.fullTriangleCount !== item.triangles ||
      !Number.isSafeInteger(result.fullTriangleCount) ||
      result.fullTriangleCount <= 0
    ) {
      add(
        `Harness self-intersection geometry is stale or incomplete: ${item.id}`,
      );
      continue;
    }
    if (
      result.forbiddenTriangleIntersections > 0 ||
      result.degenerateTriangles > 0 ||
      result.status === "fail"
    )
      add(
        `Harness mesh records self-intersections or degenerate source triangles: ${item.id}`,
        "fail",
      );
    else if (
      result.status !== "pass" ||
      result.topologyAccepted !== true ||
      result.forbiddenTriangleIntersections !== 0 ||
      result.unknownTrianglePairs !== 0 ||
      result.degenerateTriangles !== 0 ||
      !Number.isSafeInteger(result.uniqueTrianglePairs) ||
      result.uniqueTrianglePairs < 0 ||
      result.examinedUniqueTrianglePairs !== result.uniqueTrianglePairs
    )
      add(
        `Harness self-intersection triangle-pair coverage is unclassified or incomplete: ${item.id}`,
      );
  }
  return findings;
}

export function normalizePuretvAudit(
  report: Json,
  context: AuditContext,
): NormalizedAudit {
  const result: NormalizedAudit = {
    role: "unknown",
    status: "unknown",
    findings: [],
    staticComplete: false,
    environmentComplete: false,
    stateMode: "single-key-at-rest",
    paths: {},
    allowedContacts: [],
  };
  const add = (status: EvidenceStatus, detail: string) =>
    result.findings.push({ status, detail });
  const hashes = recordedHashes(report);
  if (!Object.keys(hashes).length)
    add("unknown", "Audit records no source hashes.");
  let sourceMismatch = false;
  for (const [file, hash] of sourceHashRecords(report))
    if (!context.sourceSha256[file] || context.sourceSha256[file] !== hash) {
      sourceMismatch = true;
      add("unknown", `Stale or unrecognized source: ${file}`);
    }
  if (
    report.sourceFilesUnchanged === false ||
    report.manifestUnchanged === false ||
    report.scriptUnchanged === false ||
    array(report.changedSources).length ||
    array(report.sourceFilesChangedDuringAudit).length ||
    array(report.buttons).some((row) => row.sourceFilesUnchanged === false)
  ) {
    sourceMismatch = true;
    add("unknown", "Source, manifest or audit script changed during audit.");
  }
  const calibrated = new Map(
    array(context.calibration?.buttons).map((button) => [button.key, button]),
  );
  if (
    object(report.coverage) &&
    Array.isArray(report.coverage.candidates) &&
    Array.isArray(report.objects)
  ) {
    result.role = "assembly";
    if (
      report.summary?.completeCandidateCoverage !== true ||
      (report.summary?.status !== undefined &&
        report.summary.status !== "no-unclassified-intersection-observed") ||
      array(report.summary?.unclassifiedPairs).length ||
      array(report.coverage?.unknown).length
    )
      add(
        "unknown",
        "Source assembly audit itself still declares incomplete/unclassified geometry or non-passing coverage.",
      );
    const coverage = report.coverage,
      objects = report.objects;
    result.findings.push(...validateHarnessSelfIntersection(report));
    const byId = new Map(objects.map((entry: Json) => [entry.id, entry]));
    const names = new Set(
      objects.map((entry: Json) =>
        sourceObject(entry.sourceFile ?? "", entry.sourceName ?? ""),
      ),
    );
    const inventoryComplete =
      objects.length === context.originalCount &&
      names.size === objects.length &&
      [...context.sourceObjects].every((key) => names.has(key)) &&
      byId.size === objects.length &&
      objects.every(
        (entry: Json) =>
          context.sourceSha256[sourceFile(entry.sourceFile ?? "")] ===
          entry.sourceSha256,
      );
    if (!inventoryComplete)
      add(
        "unknown",
        "Whole source inventory is missing, duplicated, or differs from current exported objects.",
      );
    if (Object.keys(hashes).length !== Object.keys(context.sourceSha256).length)
      add("unknown", "Assembly audit does not bind every source collection.");
    if (array(report.inventoryWarnings).length)
      add(
        "unknown",
        `Source topology/inventory warnings: ${array(report.inventoryWarnings).length}`,
      );
    const candidates = coverage.candidates,
      checks = array(report.checks);
    let planVerified = false;
    try {
      planVerified = verifySourcePairPlan(report, context.calibration);
    } catch {
      /* malformed/missing records are unknown */
    }
    if (!planVerified)
      add(
        "unknown",
        "Source AABB pair plan/roles/poses cannot be independently reproduced from the complete inventory and calibration.",
      );
    const candidateIds = new Set(candidates.map((entry: Json) => entry.id));
    const checkById = new Map(checks.map((entry: Json) => [entry.id, entry]));
    let checkedAll =
      candidateIds.size === candidates.length &&
      checkById.size === checks.length &&
      candidates.length === coverage.uniqueCandidatePairs &&
      checks.length === candidates.length;
    for (const candidate of candidates) {
      const check = checkById.get(candidate.id);
      if (
        !check ||
        !byId.has(candidate.a) ||
        !byId.has(candidate.b) ||
        candidate.a === candidate.b ||
        !["a", "b", "aMotionMm", "bMotionMm"].every((key) =>
          same(check[key], candidate[key]),
        ) ||
        !same(
          array(check.contexts).slice().sort(),
          array(candidate.contexts).slice().sort(),
        )
      )
        checkedAll = false;
    }
    if (!checkedAll)
      add(
        "unknown",
        "Candidate checks are missing, duplicated or do not match the planned source pairs/poses.",
      );
    const rest = array(coverage.contexts).find(
      (entry) => entry.scenario === "rest-all-pairs",
    );
    const contextValid = (entry: Json) =>
      number(entry.consideredPairs) &&
      entry.consideredPairs === entry.aabbSeparatedPairs + entry.candidatePairs;
    const fixedCount = objects.filter(
      (entry: Json) => !MOVING_ROLES.has(entry.role),
    ).length;
    result.staticComplete =
      inventoryComplete &&
      planVerified &&
      checkedAll &&
      Boolean(
        rest &&
        contextValid(rest) &&
        rest.consideredPairs === pairCount(objects.length) &&
        coverage.allRestPairs === rest.consideredPairs &&
        coverage.fixedFixedRestPairs === pairCount(fixedCount),
      );
    if (!result.staticComplete)
      add(
        "unknown",
        "All fixed-fixed/rest candidate pairs have not been accounted for.",
      );
    let movingComplete = inventoryComplete && checkedAll && planVerified;
    for (const key of KEYS) {
      const frames = array(coverage.contexts).filter(
        (entry) => entry.scenario === `key-${key}-against-entire-environment`,
      );
      const expectedActive = new Set(
        objects
          .filter(
            (entry: Json) => entry.key === key && MOVING_ROLES.has(entry.role),
          )
          .map((entry: Json) => entry.id),
      );
      const path = sampledPath(
        frames.map((entry) => entry.strokeMm),
        calibrated.get(key)?.travel,
      );
      if (
        !path ||
        expectedActive.size === 0 ||
        frames.some(
          (entry) =>
            !contextValid(entry) ||
            entry.consideredPairs !==
              pairCount(objects.length) -
                pairCount(objects.length - expectedActive.size) ||
            array(entry.activeObjects).length !== expectedActive.size ||
            array(entry.activeObjects).some((id) => !expectedActive.has(id)),
        )
      ) {
        movingComplete = false;
        add(
          "unknown",
          `${key}: incomplete active/elastic member paths against the full environment.`,
        );
      } else result.paths[key] = path;
    }
    result.environmentComplete = movingComplete;
    if (coverage.stateMode === "joint-range") {
      const joint = coverage.jointRangeCoverage;
      const crossPairs =
        pairCount(
          objects.filter((entry: Json) => MOVING_ROLES.has(entry.role)).length,
        ) -
        KEYS.reduce(
          (sum, key) =>
            sum +
            pairCount(
              objects.filter(
                (entry: Json) =>
                  entry.key === key && MOVING_ROLES.has(entry.role),
              ).length,
            ),
          0,
        );
      let complete =
        object(joint) &&
        joint.complete === true &&
        joint.movingObjectPairs === crossPairs &&
        joint.movingObjectPairs ===
          joint.strictlySeparatedSweptBoundsPairs + joint.sweptCandidatePairs &&
        array(joint.candidates).length === joint.sweptCandidatePairs &&
        joint.completedPosePairs === joint.requiredPosePairs;
      if (complete) {
        let poses = 0;
        for (const candidate of joint.candidates) {
          const a = byId.get(candidate.a),
            b = byId.get(candidate.b);
          const aStrokes = array(coverage.contexts)
            .filter(
              (row) =>
                row.scenario === `key-${a?.key}-against-entire-environment`,
            )
            .map((row) => row.strokeMm);
          const bStrokes = array(coverage.contexts)
            .filter(
              (row) =>
                row.scenario === `key-${b?.key}-against-entire-environment`,
            )
            .map((row) => row.strokeMm);
          const expectedPoses = new Set(
            aStrokes.flatMap((x) => bStrokes.map((y) => `${x}/${y}`)),
          );
          const observed = new Set(
            array(candidate.poses).map(
              (row) => `${row.aStrokeMm}/${row.bStrokeMm}`,
            ),
          );
          if (
            !a ||
            !b ||
            a.key === b.key ||
            observed.size !== expectedPoses.size ||
            [...expectedPoses].some((pose) => !observed.has(pose))
          )
            complete = false;
          for (const pose of array(candidate.poses)) {
            poses++;
            if (
              pose.aabbSeparated !== true &&
              (!pose.checkId || !checkById.has(pose.checkId))
            )
              complete = false;
          }
        }
        if (poses !== joint.requiredPosePairs) complete = false;
      }
      if (complete) result.stateMode = "joint-range";
      else {
        result.environmentComplete = false;
        add(
          "unknown",
          "Joint-range claim lacks the complete independent stroke Cartesian-product checks.",
        );
      }
    }
    for (const check of checks) {
      const status = geometryStatus(check.result);
      if (status !== "pass")
        add(
          status,
          `Source pair ${check.id}: ${check.result?.status ?? "missing result"}`,
        );
      if (status === "pass" && check.result?.allowedInterface)
        result.allowedContacts.push({
          a: byId.get(check.a),
          b: byId.get(check.b),
          permission: check.result.allowedInterface,
          checkId: check.id,
        });
    }
    if (
      result.staticComplete &&
      result.environmentComplete &&
      !checks.some((check) => geometryStatus(check.result) !== "pass")
    )
      add(
        "pass",
        "All recorded rest and sampled source-motion candidates are accounted for, including explicit local contact interfaces.",
      );
  } else if (
    Array.isArray(report.buttons) &&
    report.buttons.some((button: Json) => Array.isArray(button.states))
  ) {
    result.role = "internals";
    const byKey = new Map(
      report.buttons.map((button: Json) => [button.key, button]),
    );
    if (byKey.size !== 9 || report.buttons.length !== 9)
      add("unknown", "Internal audit does not cover exactly nine keys.");
    for (const key of KEYS) {
      const button = byKey.get(key);
      if (!button) {
        add("unknown", `Missing internal audit: ${key}`);
        continue;
      }
      const calibration = calibrated.get(key);
      const clientPoint = (value: unknown) =>
        Array.isArray(value) && value.length === 3
          ? [value[0], value[2], -value[1]]
          : null;
      if (
        !calibration ||
        !vecClose(
          clientPoint(button.centerContact?.strikerSource),
          calibration.strikerSourceClient,
        ) ||
        !vecClose(
          clientPoint(button.centerContact?.actuatorSource),
          calibration.switchSourceClient,
        ) ||
        !close(
          button.centerContact?.gapMm,
          calibration.measuredRestGap,
          1e-5,
        ) ||
        !close(button.spring?.freeLengthMm, calibration.freeLength, 1e-5) ||
        button.roles?.switchContact !== calibration.switchNode ||
        !array(button.roles?.moving).includes(calibration.strikerNode)
      )
        add(
          "unknown",
          `${key}: calibrated striker/target coordinates, free spring length or source roles do not match the independent source measurements.`,
        );
      const path = sampledPath(
        array(button.states).map((state) => state.displacementMm),
        calibration?.travel,
      );
      if (!path)
        add(
          "unknown",
          `${key}: incomplete internal spring/striker stroke sampling.`,
        );
      for (const state of array(button.states))
        for (const group of [
          state.capAgainstFixed,
          state.compressedSpringAgainstFixed,
          state.actuatorAgainstFixed,
        ]) {
          if (!object(group) || !Object.keys(group).length) {
            add("unknown", `${key}: missing fixed-member comparisons.`);
            continue;
          }
          for (const [name, check] of Object.entries(group)) {
            const status = geometryStatus(check as Json);
            if (status !== "pass")
              add(
                status,
                `${key} / ${name}: ${(check as Json)?.status ?? "missing result"}`,
              );
          }
        }
    }
    if (!result.findings.length)
      add(
        "pass",
        "Nine source internal moving/elastic groups checked along the calibrated stroke.",
      );
  } else if (
    Array.isArray(report.buttons) &&
    report.buttons.some(
      (button: Json) =>
        "exploration" in button || "path" in button || "assemblyPose" in button,
    )
  ) {
    result.role = "locks";
    const subgroupSummary = report.summary?.subgroupSummary;
    const forwardCount = array(report.buttons).reduce(
      (count, row) =>
        count +
        array(row.installation?.movingSubgroupAssembly?.checks).reduce(
          (total, check) => total + array(check.samples).length,
          0,
        ),
      0,
    );
    const reverseCount = array(report.buttons).reduce(
      (count, row) =>
        count +
        array(row.installation?.movingSubgroupAssembly?.checks).reduce(
          (total, check) => total + array(check.reverseSamples).length,
          0,
        ),
      0,
    );
    if (
      report.summary?.movingSubgroupCoverage !== "complete" ||
      subgroupSummary?.status !== "sampled-paths-clear" ||
      subgroupSummary.auditedKeys !== 9 ||
      subgroupSummary.forwardPoseChecks !== forwardCount ||
      subgroupSummary.reversePoseChecks !== reverseCount
    )
      add(
        "unknown",
        "All nine source installation subgroups and explicit reverse trajectories have not been completely audited.",
      );
    if (
      object(report.summary) &&
      (report.summary.status !== "sampled-paths-clear" ||
        report.summary.auditedKeys !== 9 ||
        report.summary.pathClearAndRetainedKeys !== 9)
    )
      add(
        "unknown",
        "Source installation audit has not declared all nine actual mounting/retention interfaces complete.",
      );
    const byKey = new Map(
      report.buttons.map((button: Json) => [button.key, button]),
    );
    for (const key of KEYS) {
      const row = byKey.get(key);
      if (!row || row.status !== "sampled-path-clear") {
        add(
          "unknown",
          `${key}: source insert/rotate/reverse-removal path is ${row?.status ?? "missing"}.`,
        );
        continue;
      }
      const path = row.path;
      if (!object(path)) {
        add("unknown", `${key}: source installation path is missing.`);
        continue;
      }
      result.findings.push(...validateInstallationSubgroup(row, context));
      for (const [phase, samples] of [
        ["forward", array(path?.samples)],
        ["reverse", array(path?.reverseRemoval?.samples)],
      ] as const) {
        if (samples.length < 2)
          add(
            "unknown",
            `${key}: ${phase} installation path has no actual samples.`,
          );
        for (const sample of samples) {
          const status = lockSampleStatus(sample, row);
          if (status !== "pass")
            add(
              status,
              `${key}: ${phase} source installation sample is ${sample?.status ?? "missing"}.`,
            );
        }
      }
      if (lockSampleStatus(row.assemblyPose, row) !== "pass")
        add(
          lockSampleStatus(row.assemblyPose, row),
          `${key}: locked rest pose lacks clear source geometry evidence.`,
        );
      if (
        !object(path) ||
        !number(path.entryAngleDeg) ||
        !number(path.lockedAngleDeg ?? path.lockAngleDeg) ||
        !number(path.insertionDistanceMm) ||
        path.insertionDistanceMm <= 0 ||
        !number(path.lockRotationDeg) ||
        Math.abs(path.lockRotationDeg) < 0.1 ||
        !close(
          path.lockRotationDeg,
          path.lockedAngleDeg - path.entryAngleDeg,
          1e-5,
        ) ||
        !Array.isArray(path.samples) ||
        path.samples.length < 2 ||
        path.samples[0]?.status !== "disjoint-bounds" ||
        !close(path.samples[0]?.angleDeg, path.entryAngleDeg, 1e-8) ||
        !close(path.samples[0]?.axialOffsetMm, path.startAxialOffsetMm, 1e-8) ||
        !close(path.samples.at(-1)?.angleDeg, path.lockedAngleDeg, 1e-8) ||
        !close(path.samples.at(-1)?.axialOffsetMm, 0, 1e-8) ||
        !object(path.reverseRemoval) ||
        !["sampled-path-clear", "pass"].includes(path.reverseRemoval.status) ||
        !retainedBySource(path.retentionProbe) ||
        !pathStepsBounded(path) ||
        !(
          number(path.maximumSampledVertexTravelMm) &&
          path.maximumSampledVertexTravelMm > 0 &&
          path.maximumSampledVertexTravelMm <= 0.1 + 1e-6
        )
      )
        add(
          "unknown",
          `${key}: locking report lacks checked path samples, reverse removal or real axial retention evidence.`,
        );
      const forward = array(path?.samples),
        reverse = array(path?.reverseRemoval?.samples);
      if (
        forward.length !== reverse.length ||
        reverse.some(
          (sample, index) =>
            !same(
              sampleEvidence(sample),
              sampleEvidence(forward[forward.length - index - 1]),
            ),
        )
      )
        add(
          "unknown",
          `${key}: reverse removal does not reproduce the checked rigid poses in reverse order.`,
        );
      if (key === "confirm") {
        const installation = row.installation,
          calibration = calibrated.get(key);
        for (const name of [
          "capUpperHousing",
          "capToSeatPressGuide",
          "seatAgainstCapDuringMount",
        ]) {
          const sequence = installation?.[name];
          if (
            !object(sequence) ||
            sequence.status !== "sampled-path-clear" ||
            array(sequence.samples).length < 2 ||
            !pathStepsBounded({
              ...sequence,
              maximumSleeveRadiusMm: path.maximumSleeveRadiusMm,
            }) ||
            !(
              number(sequence.maximumSampledVertexTravelMm) &&
              sequence.maximumSampledVertexTravelMm > 0 &&
              sequence.maximumSampledVertexTravelMm <= 0.1 + 1e-6
            )
          )
            add(
              "unknown",
              `confirm: ${name} source installation/guide sequence is incomplete.`,
            );
          for (const sample of array(sequence?.samples)) {
            const status = geometryStatus(sample);
            if (status !== "pass")
              add(
                status,
                `confirm: ${name} source sample is ${sample?.status ?? "missing"}.`,
              );
          }
        }
        if (!retainedBySource(installation?.capUpperHousing?.retentionProbe))
          add(
            "unknown",
            "confirm: cap retention against the closed upper housing is not demonstrated by source penetration witnesses.",
          );
        const guideSamples = array(installation?.capToSeatPressGuide?.samples),
          guideTravel = calibration?.travel;
        if (
          !sampledPath(
            guideSamples.map((sample) => -sample.axialOffsetMm),
            guideTravel,
          ) ||
          guideSamples.some((sample) => !close(sample.angleDeg, 0, 1e-8))
        )
          add(
            "unknown",
            "confirm: actual cap/seat guide does not cover the calibrated press stroke.",
          );
        const spring = installation?.springAssembly;
        if (
          !object(spring) ||
          spring.status !== "within-declared-length-limit" ||
          !calibration ||
          !close(spring.freeLengthMm, calibration.freeLength, 1e-5) ||
          !close(
            spring.declaredConservativeSolidLengthMm,
            calibration.solidLength,
            1e-5,
          ) ||
          !close(
            spring.maximumAssemblyCompressionMm,
            path.seatedAxialOffsetMm,
            1e-5,
          ) ||
          !close(
            spring.remainingLengthMm,
            spring.freeLengthMm - spring.maximumAssemblyCompressionMm,
            1e-5,
          ) ||
          spring.maximumAssemblyCompressionMm < 0 ||
          spring.remainingLengthMm < spring.declaredConservativeSolidLengthMm
        )
          add(
            "unknown",
            "confirm: seat installation compression is not within the calibrated conservative solid-length limit.",
          );
      }
    }
    if (!result.findings.length)
      add(
        "pass",
        "Eight sleeve locks and the confirmation key's actual mounting/guide/retention interfaces have checked source evidence.",
      );
  } else if (
    Array.isArray(report.buttons) &&
    report.buttons.some(
      (row: Json) =>
        "springEndpointErrorMm" in row || "contactSurfaceErrorMm" in row,
    )
  ) {
    result.role = "display";
    const byKey = new Map(report.buttons.map((row: Json) => [row.key, row]));
    if (byKey.size !== 9 || report.buttons.length !== 9)
      add(
        "unknown",
        "Source/display consistency audit must include all nine keys exactly once.",
      );
    for (const key of KEYS) {
      const row = byKey.get(key),
        file = `buttons/${key}.blend`;
      if (
        !row ||
        row.sourceFile !== file ||
        !context.displaySha256?.[file] ||
        row.displaySha256 !== context.displaySha256[file]
      ) {
        add(
          "unknown",
          `${key}: display consistency proof is missing or binds different GLB bytes.`,
        );
        continue;
      }
      for (const field of ["springEndpointErrorMm", "contactSurfaceErrorMm"]) {
        if (!number(row[field]) || row[field] < 0)
          add("unknown", `${key}: measured display ${field} is missing.`);
        else if (row[field] > 0.001)
          add(
            "fail",
            `${key}: display ${field} exceeds the 0.001 mm source-calibration consistency limit.`,
          );
      }
    }
    if (report.status !== "pass")
      add(
        report.status === "fail" ? "fail" : "unknown",
        "Source/display audit has not reported a complete pass.",
      );
    if (!result.findings.length)
      add(
        "pass",
        "All nine actual GLBs preserve measured spring endpoints and physical contact surfaces within 0.001 mm; this is separate from collision coverage.",
      );
  } else if (
    Array.isArray(report.checks) &&
    report.checks.some((check: Json) => Array.isArray(check.samples))
  ) {
    result.role = "housing";
    for (const check of report.checks)
      for (const sample of array(check.samples)) {
        const status = geometryStatus(sample);
        if (status !== "pass")
          add(status, `${check.key ?? "housing"}: ${sample.status}`);
      }
    if (!report.checks.length)
      add("unknown", "Housing audit has no actual source checks.");
    if (!result.findings.length)
      add(
        "pass",
        "Listed source housing checks passed within their explicitly sampled scope.",
      );
  } else
    add("unknown", "Unsupported audit schema; no geometric pass inferred.");
  if (sourceMismatch) {
    result.status = "unknown";
    result.staticComplete = false;
    result.environmentComplete = false;
  } else
    result.status = sumStatus(result.findings.map((entry) => entry.status));
  return result;
}

function sourcePartIdentity(part: Part): string {
  return `${part.params.assetUrl}::${part.params.assetNode}`;
}
function benchShape(part: Part) {
  return {
    id: part.id,
    kind: part.kind,
    position: part.position,
    rotation: part.rotation,
    size: part.size,
    params: part.params,
  };
}
/** The offline source poses only apply to the exact role/guide/contact calibration used in the workbench. */
export function validateCalibrationBinding(
  project: Project,
  catalog: AssetEntry[],
  calibration: Json | null,
): Finding[] {
  const findings: Finding[] = [];
  const add = (detail: string) =>
    findings.push({ status: "unknown", detail } as Finding);
  if (!calibration || !same(calibration.offset, [0, 20, 0]))
    return [
      {
        status: "unknown",
        detail:
          "Source-to-project calibration is missing or uses a different frame.",
      },
    ];
  const plus = (v: number[], o: number[]) => v.map((n, index) => n + o[index]);
  const minus = (v: number[], o: number[]) => v.map((n, index) => n - o[index]);
  const configured = new Set<string>();
  for (const button of array(calibration.buttons)) {
    const prefix = `${button.key}: `;
    const asset = catalog.find((entry) => entry.id === button.assetId);
    if (!asset || !KEYS.includes(button.key)) {
      add(prefix + "Unknown calibrated source collection.");
      continue;
    }
    const collection = project.parts.filter(
      (part) => part.params.assetUrl === asset.url,
    );
    const partFor = (name: unknown): Part | undefined => {
      const node = asset.nodes?.find(
        (entry) => entry.name === name || entry.displayName === name,
      );
      return node
        ? collection.find((part) => part.params.assetNode === node.name)
        : undefined;
    };
    const striker = partFor(button.strikerNode),
      target = partFor(button.switchNode),
      electrical = partFor(button.electricalSwitchNode);
    const mechanism = project.mechanisms?.find((entry) =>
      entry.partIds.some((id) => collection.some((part) => part.id === id)),
    );
    const roleIds = (names: unknown): string[] | null => {
      if (!Array.isArray(names) || names.some((name) => !partFor(name)))
        return null;
      return names.map((name) => partFor(name)!.id).sort();
    };
    const moving = roleIds(button.movingNodes),
      springs = roleIds(button.springNodes),
      actuators = roleIds(button.actuatorNodes);
    const guide = button.guide;
    if (
      !striker ||
      !target ||
      !electrical ||
      !mechanism ||
      !moving ||
      !springs ||
      !actuators ||
      !object(guide) ||
      ![
        "pinDiameter",
        "holeDiameter",
        "outerDiameter",
        "height",
        "shaftHeight",
        "tolerance",
        "minClearance",
        "insertionDepth",
      ].every((key) => number(guide[key])) ||
      ![
        guide.centerClient,
        guide.shaftCenterClient,
        button.strikerSourceClient,
        button.switchSourceClient,
        button.axis,
      ].every((value) => vecClose(value, value))
    ) {
      add(
        prefix +
          "Incomplete calibrated source roles, guide dimensions or physical/electrical contact owners.",
      );
      continue;
    }
    configured.add(mechanism.id);
    if (
      mechanism.kind !== "press" ||
      mechanism.status !== "configured" ||
      !same(
        sortedIds(mechanism.partIds),
        sortedIds(collection.map((part) => part.id)),
      ) ||
      !same(sortedIds(mechanism.movingPartIds), moving) ||
      !same(sortedIds(mechanism.springPartIds), springs) ||
      mechanism.switchPartId !== electrical.id ||
      electrical.fixed !== true ||
      mechanism.contact?.targetPartId !== target.id ||
      mechanism.contact?.strikerPartId !== striker.id ||
      !same(sortedIds(mechanism.contact?.actuatorPartIds), actuators)
    )
      add(
        prefix +
          "Workbench mechanical roles differ from the source calibration.",
      );
    if (
      !vecClose(
        mechanism.frame.position,
        plus(guide.centerClient, calibration.offset),
      ) ||
      !vecClose(mechanism.frame.rotation, [0, 0, 0]) ||
      !vecClose(mechanism.axis, button.axis) ||
      !same(mechanism.pose, { offset: 0, angle: 0 })
    )
      add(
        prefix + "Workbench mechanism is not in the audited axis/rest frame.",
      );
    const expectedParams = Object.fromEntries(
      [
        "mass",
        "stiffness",
        "damping",
        "travel",
        "freeLength",
        "solidLength",
      ].map((key) => [key, button[key]]),
    );
    Object.assign(expectedParams, {
      insertionDepth: guide.insertionDepth,
      minClearance: guide.minClearance,
    });
    if (
      !numericParametersEqual(mechanism.params, expectedParams) ||
      !Object.values(expectedParams).every(number)
    )
      add(
        prefix +
          "Workbench physical/guide parameters differ from the source calibration.",
      );
    const expectedMoving = {
      kind: "pin",
      position: minus(guide.shaftCenterClient, guide.centerClient),
      rotation: [0, 0, 0],
      size: [guide.pinDiameter, guide.shaftHeight, guide.pinDiameter],
      params: { pinDiameter: guide.pinDiameter, tolerance: guide.tolerance },
    };
    const expectedFixed = {
      kind: "sleeve",
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      size: [guide.outerDiameter, guide.height, guide.outerDiameter],
      params: { holeDiameter: guide.holeDiameter, tolerance: guide.tolerance },
    };
    for (const [actual, expected] of [
      [mechanism.movingProxy, expectedMoving],
      [mechanism.fixedProxy, expectedFixed],
    ] as const)
      if (
        actual.kind !== expected.kind ||
        !vecClose(actual.position, expected.position) ||
        !vecClose(actual.rotation, expected.rotation) ||
        !vecClose(actual.size, expected.size) ||
        !numericParametersEqual(actual.params, expected.params)
      )
        add(
          prefix +
            "Analytic guide geometry does not match measured source calibration.",
        );
    if (
      !mechanism.contact ||
      !vecClose(
        mechanism.contact.strikerPoint,
        minus(
          plus(button.strikerSourceClient, calibration.offset),
          striker.position,
        ),
      ) ||
      !vecClose(
        mechanism.contact.switchPoint,
        minus(
          plus(button.switchSourceClient, calibration.offset),
          target.position,
        ),
      ) ||
      !vecClose(mechanism.contact.switchNormal, [0, 1, 0]) ||
      !close(
        mechanism.contact.radius,
        Math.min(target.size[0], target.size[2]) / 4,
        1e-8,
      ) ||
      !close(
        mechanism.contact.maxOvertravel,
        button.maxOvertravel ?? 0.25,
        1e-8,
      )
    )
      add(
        prefix +
          "Physical striker/target contact coordinates or allowed overtravel differ from measured calibration.",
      );
  }
  if (configured.size !== 9 || project.mechanisms?.length !== 9)
    add(
      "Every source key must have exactly one calibrated mechanism and no additional mechanism.",
    );
  return findings;
}

/** Actual Three wrapper matrices must match each spring role; UI intent counters are insufficient. */
export function validateRenderedSpringEvidence(
  mechanism: { springPartIds: string[]; params: Record<string, number> },
  snapshots: unknown,
  key: string,
): Finding[] {
  const findings: Finding[] = [];
  if (!object(snapshots))
    return [
      {
        status: "unknown",
        detail: `${key}: actual rendered spring matrices were not recorded.`,
      },
    ];
  for (const phase of ["pressed", "released"]) {
    const records = array(snapshots[phase]);
    if (
      !same(
        records.map((row) => row?.partId).sort(),
        mechanism.springPartIds.slice().sort(),
      ) ||
      records.length === 0
    ) {
      findings.push({
        status: "unknown",
        detail: `${key}: ${phase} renderer matrices do not bind every declared spring exactly once.`,
      });
      continue;
    }
    const ratio =
      phase === "pressed"
        ? 1 - mechanism.params.travel / mechanism.params.freeLength
        : 1;
    for (const row of records) {
      if (
        !Array.isArray(row.matrix) ||
        row.matrix.length !== 16 ||
        !row.matrix.every(number)
      ) {
        findings.push({
          status: "unknown",
          detail: `${key}: ${phase} actual Three matrix is missing or malformed.`,
        });
        continue;
      }
      if (
        row.matrix.some(
          (value: number, index: number) =>
            Math.abs(value - (index === 5 ? ratio : index % 5 === 0 ? 1 : 0)) >
            1e-4,
        )
      )
        findings.push({
          status: "fail",
          detail: `${key}: ${phase} actual spring deformation differs from the calibrated Y-axis length ratio.`,
        });
    }
  }
  return findings;
}

export function validateMcpRecord(
  project: Project,
  rawProject: Json,
  calibration: Json | null,
  report: Json | null,
  originalCount: number,
): Finding[] {
  const findings: Finding[] = [],
    add = (status: EvidenceStatus, detail: string) =>
      findings.push({ status, detail });
  if (!calibration || !report)
    return [
      {
        status: "unknown",
        detail: "Actual MCP test report or source calibration is missing.",
      },
    ];
  if (!validEvidenceTimestamp(report.completedAt))
    add(
      "unknown",
      "Actual MCP completedAt must be a valid UTC ISO timestamp for deterministic evidence generation.",
    );
  if (report.status === "fail")
    add("fail", "Actual MCP report explicitly records a failed run.");
  if (
    report.status !== "pass" ||
    report.execution?.fixture !== false ||
    typeof report.execution?.nativeDesktop !== "boolean"
  )
    add("unknown", "MCP report does not attest an actual workbench run.");
  if (
    report.exportedProjectSha256 !== jsonSha(rawProject) ||
    report.calibrationSha256 !== jsonSha(calibration)
  )
    add(
      "unknown",
      "MCP run is not bound to this final exported project/calibration.",
    );
  if (
    report.sourceParts !== originalCount ||
    report.totalParts !== project.parts.length ||
    report.mechanisms !== 9 ||
    report.wires !== project.wires.length ||
    project.wires.length !== 27
  )
    add(
      "unknown",
      "MCP inventory does not match the full assembly and nine test branches.",
    );
  for (const phase of ["before", "after"]) {
    if (
      !number(report[phase]?.issues?.error) ||
      !number(report[phase]?.lampsOn)
    )
      add("unknown", `Actual MCP ${phase} validation metrics are missing.`);
    else if (report[phase].issues.error !== 0 || report[phase].lampsOn !== 0)
      add(
        "fail",
        `Actual MCP ${phase} validation reports an error or unexpectedly powered lamp.`,
      );
  }
  const tests = new Map(array(report.tests).map((test) => [test.key, test]));
  if (tests.size !== 9 || array(report.tests).length !== 9)
    add("unknown", "MCP nine-key tests are missing or duplicated.");
  for (const key of KEYS) {
    const test = tests.get(key),
      button = array(calibration.buttons).find((row) => row.key === key),
      mechanism = project.mechanisms?.find(
        (row) => row.id === test?.mechanismId,
      );
    if (
      !test ||
      !button ||
      !mechanism ||
      test.actualRendererChecked !== true ||
      test.status !== "pass"
    ) {
      add(
        "unknown",
        `${key}: actual-renderer MCP test is missing or not completed.`,
      );
      continue;
    }
    findings.push(
      ...validateRenderedSpringEvidence(mechanism, test.springTransforms, key),
    );
    if (
      test.sourceAssetId !== button.assetId ||
      test.sourceStrikerNode !== button.strikerNode ||
      test.sourceSwitchNode !== button.switchNode ||
      test.sourceElectricalSwitchNode !== button.electricalSwitchNode ||
      !close(mechanism.params.travel, button.travel, 1e-9)
    )
      add(
        "unknown",
        `${key}: MCP test refers to different calibrated source members.`,
      );
    if (
      ![
        test.precontact?.gap,
        test.precontact?.displacement,
        test.precontact?.litLamps,
        test.pressed?.displacement,
        test.pressed?.contact?.surfaceGap,
        test.pressed?.contact?.actuatorTravel,
        test.pressed?.litLamps,
        test.pressed?.currentA,
        test.released?.displacement,
        test.released?.velocity,
        test.released?.litLamps,
      ].every(number) ||
      typeof test.pressed?.contact?.pressed !== "boolean" ||
      typeof test.released?.contact?.pressed !== "boolean"
    ) {
      add(
        "unknown",
        `${key}: actual approach/contact/release measurements are incomplete.`,
      );
      continue;
    }
    if (
      !(number(test.precontact?.gap) && test.precontact.gap > 0) ||
      test.precontact?.litLamps !== 0 ||
      test.pressed?.contact?.pressed !== true ||
      !close(test.pressed?.displacement, mechanism.params.travel) ||
      !close(test.pressed?.contact?.surfaceGap, 0) ||
      !close(
        test.pressed?.contact?.actuatorTravel,
        button.maxOvertravel ?? 0.25,
      ) ||
      test.pressed?.litLamps !== 1 ||
      !close(test.pressed?.currentA, 0.05, 1e-6) ||
      test.released?.contact?.pressed !== false ||
      test.released?.litLamps !== 0 ||
      !close(test.released?.displacement, 0, 0.001) ||
      !close(test.released?.velocity, 0, 0.001)
    )
      add(
        "fail",
        `${key}: approach-OFF/contact-ON/release-OFF or spring return/current criteria failed.`,
      );
  }
  const bench = project.parts.filter((part) => !part.params.assetUrl);
  if (
    bench.length !== 10 ||
    bench.filter((part) => part.kind === "battery").length !== 1 ||
    bench.filter((part) => part.kind === "lamp").length !== 9 ||
    bench.some((part) => part.model || part.fixed !== true) ||
    !same(bench.map(benchShape), report.analyticBench)
  )
    add(
      "unknown",
      "The ten analytic test-bench entities are not exactly those exercised through MCP.",
    );
  if (
    validateAssembly(bench).issues.some((issue) => issue.severity === "error")
  )
    add(
      "fail",
      "Analytic electrical test-bench shapes interfere or have invalid dimensions.",
    );
  if (!findings.length)
    add(
      "pass",
      "Actual workbench MCP exercised all nine approach/contact/release branches, real renderer motion and the ten analytic bench entities.",
    );
  return findings;
}

function worldBounds(part: Part): { min: number[]; max: number[] } | null {
  if (part.rotation.some((value) => value !== 0)) return null;
  return {
    min: part.position.map((value, index) => value - part.size[index] / 2),
    max: part.position.map((value, index) => value + part.size[index] / 2),
  };
}
const disjoint = (
  a: { min: number[]; max: number[] },
  b: { min: number[]; max: number[] },
) =>
  [0, 1, 2].some(
    (index) => a.max[index] < b.min[index] || b.max[index] < a.min[index],
  );
function benchEnvironment(
  project: Project,
  assembly: Json | undefined,
  offset: number[],
  calibration: Json | null,
): Finding[] {
  if (!assembly || !calibration)
    return [
      {
        status: "unknown",
        detail:
          "Cannot bind added analytic bench to the complete source environment bounds.",
      },
    ];
  const bench = project.parts.filter((part) => !part.params.assetUrl),
    findings: Finding[] = [];
  const maximumTravel = Math.max(
    ...array(calibration.buttons).map((button) => button.travel),
  );
  for (const part of bench) {
    const bounds = worldBounds(part);
    if (!bounds) {
      findings.push({
        status: "unknown",
        detail: `Analytic bench orientation requires explicit collision evidence: ${part.id}`,
      });
      continue;
    }
    for (const source of array(assembly.objects)) {
      const original =
        source.boundsClient ??
        (source.boundsBlender
          ? {
              min: [
                source.boundsBlender.min[0],
                source.boundsBlender.min[2],
                -source.boundsBlender.max[1],
              ],
              max: [
                source.boundsBlender.max[0],
                source.boundsBlender.max[2],
                -source.boundsBlender.min[1],
              ],
            }
          : null);
      if (!original) {
        findings.push({
          status: "unknown",
          detail: "Source environment bounds missing for analytic test bench.",
        });
        break;
      }
      const swept = {
        min: original.min.map(
          (v: number, index: number) =>
            v +
            offset[index] -
            (index === 1 && MOVING_ROLES.has(source.role) ? maximumTravel : 0),
        ),
        max: original.max.map((v: number, index: number) => v + offset[index]),
      };
      if (!disjoint(bounds, swept))
        findings.push({
          status: "unknown",
          detail: `Added bench entity overlaps a source swept bound; dedicated exact check required: ${part.id} / ${source.id}`,
        });
    }
  }
  return findings.length
    ? findings
    : [
        {
          status: "pass",
          detail:
            "Ten analytic bench geometries passed actual MCP proxy checks and are strictly AABB-separated from every unsimplified source object's complete axial swept bounds.",
        },
      ];
}

export async function buildPuretvEvidence(options: {
  project: string;
  mcp: string;
  calibration: string;
  audits: string[];
  requirePass?: boolean;
  check?: boolean;
}) {
  const rawProject = await readJson(options.project),
    project = parseProject(JSON.stringify(rawProject));
  const optional = async (file: string) => {
    try {
      return await readJson(file);
    } catch {
      return null;
    }
  };
  const calibration = await optional(options.calibration),
    mcp = await optional(options.mcp);
  const catalog = (await readJson(
    "public/models/catalog.json",
  )) as unknown as AssetEntry[];
  const diagnostics = await readJson("public/models/diagnostics.json"),
    manifest = await readJson("assets/puretv-controller/manifest.json");
  const findings: Finding[] = [],
    sourceHashes: EvidenceSourceHash[] = [],
    actualSourceSha: Record<string, string> = {},
    actualDisplaySha: Record<string, string> = {};
  const expectedSourceObjects = new Set<string>(),
    sourceToPart = new Map<string, string>();
  for (const asset of catalog) {
    const originalFile = sourceFile(asset.file),
      sourceSha256 = await fileSha(asset.file),
      displaySha256 = await fileSha(
        `public/models/${path.basename(asset.url)}`,
      );
    actualSourceSha[originalFile] = sourceSha256;
    actualDisplaySha[originalFile] = displaySha256;
    const diagnostic = array(diagnostics.assets).find(
        (row) => row.id === asset.id,
      ),
      manifested = array(manifest.assets).find(
        (row) => row.file === originalFile,
      );
    if (
      diagnostic?.sourceSha256 !== sourceSha256 ||
      diagnostic?.displaySha256 !== displaySha256 ||
      manifested?.sha256 !== sourceSha256
    )
      findings.push({
        status: "unknown",
        detail: `Final source/export/manifest hashes disagree: ${originalFile}`,
      });
    sourceHashes.push({
      assetUrl: asset.url,
      sourceFile: asset.file,
      sourceSha256,
      displaySha256,
    });
    for (const node of asset.nodes ?? []) {
      const identity = `${asset.url}::${node.name}`,
        sourceIdentity = sourceObject(
          originalFile,
          node.displayName ?? node.name,
        );
      expectedSourceObjects.add(sourceIdentity);
      const matching = project.parts.filter(
        (part) => sourcePartIdentity(part) === identity && !part.model,
      );
      if (matching.length !== 1)
        findings.push({
          status: "unknown",
          detail: `Final assembly must contain exactly one current source object: ${sourceIdentity}`,
        });
      else {
        sourceToPart.set(sourceIdentity, matching[0].id);
        const part = matching[0];
        if (
          part.kind !== (node.kind ?? "asset") ||
          !same(part.params, { assetUrl: asset.url, assetNode: node.name })
        )
          findings.push({
            status: "unknown",
            detail: `Source part type or physical parameters differ from the audited repository definition: ${sourceIdentity}`,
          });
        if (
          !vecClose(
            part.position,
            node.center.map((value, index) => value + [0, 20, 0][index]),
          ) ||
          !vecClose(part.rotation, [0, 0, 0]) ||
          !vecClose(part.size, node.size)
        )
          findings.push({
            status: "unknown",
            detail: `Source object is not at its audited rest pose/dimensions: ${sourceIdentity}`,
          });
      }
    }
  }
  if (
    project.parts.filter((part) => part.params.assetUrl).length !==
    expectedSourceObjects.size
  )
    findings.push({
      status: "unknown",
      detail: "Final project contains additional or missing source geometry.",
    });
  if (
    !calibration ||
    !same(calibration.offset, [0, 20, 0]) ||
    array(calibration.buttons).length !== 9
  )
    findings.push({
      status: "unknown",
      detail:
        "Nine-key calibration with common source-to-client offset [0,20,0] is required.",
    });
  if (calibration) {
    const calibrationSources = recordedHashes(calibration);
    for (const [file, hash] of sourceHashRecords(calibration))
      if (actualSourceSha[file] !== hash)
        findings.push({
          status: "unknown",
          detail: `Calibration contains a stale or unrecognized source hash: ${file}`,
        });
    for (const key of KEYS)
      if (
        calibrationSources[`buttons/${key}.blend`] !==
        actualSourceSha[`buttons/${key}.blend`]
      )
        findings.push({
          status: "unknown",
          detail: `Calibration source hash not current: ${key}`,
        });
  }
  findings.push(...validateCalibrationBinding(project, catalog, calibration));
  const binding = await createAssemblyEvidenceBinding(project);
  const audits: {
    id: string;
    path: string;
    sha256: string;
    status: EvidenceStatus;
    role: string;
    findings: Finding[];
    report: Json;
    normalized: NormalizedAudit;
  }[] = [];
  const supplementalReports = new Map<string, { body: Json; sha256: string }>();
  const context: AuditContext = {
    sourceSha256: actualSourceSha,
    displaySha256: actualDisplaySha,
    originalCount: expectedSourceObjects.size,
    sourceObjects: expectedSourceObjects,
    calibration,
  };
  for (const requested of [...new Set(options.audits)].sort()) {
    const input = filePath(requested),
      raw = await optional(input.relative);
    if (!raw) {
      findings.push({
        status: "unknown",
        detail: `Missing source audit: ${input.relative}`,
      });
      continue;
    }
    const normalized = normalizePuretvAudit(raw, context);
    const auditorScript =
      normalized.role === "assembly"
        ? { path: "scripts/audit-puretv-assembly.py", sha256: raw.scriptSha256 }
        : normalized.role === "locks"
          ? {
              path: "scripts/audit-puretv-locks.py",
              sha256: raw.auditorScriptSha256,
            }
          : null;
    if (
      auditorScript &&
      auditorScript.sha256 !== (await fileSha(auditorScript.path))
    ) {
      normalized.status = "unknown";
      normalized.staticComplete = false;
      normalized.environmentComplete = false;
      normalized.findings.push({
        status: "unknown",
        detail: `Recorded auditor script differs from current source: ${auditorScript.path}`,
      });
    }
    if (
      normalized.role === "assembly" &&
      raw.manifestSha256 !==
        (await fileSha("assets/puretv-controller/manifest.json"))
    ) {
      normalized.status = "unknown";
      normalized.findings.push({
        status: "unknown",
        detail: "Assembly audit manifest hash is stale.",
      });
      normalized.staticComplete = false;
      normalized.environmentComplete = false;
    }
    if (normalized.role === "locks") {
      for (const row of array(raw.buttons)) {
        const group = row.installation?.movingSubgroupAssembly;
        try {
          if (
            !object(group) ||
            typeof group.sourceReport !== "string" ||
            typeof group.sourceReportSha256 !== "string"
          )
            throw Error("Missing source installation report reference.");
          const ref = filePath(group.sourceReport).relative;
          let original = supplementalReports.get(ref);
          if (!original) {
            original = {
              body: await readJson(ref),
              sha256: await fileSha(ref),
            };
            supplementalReports.set(ref, original);
          }
          if (
            original.sha256 !== group.sourceReportSha256 ||
            original.body.sourceFilesUnchanged !== true ||
            !["sampled-path-clear", "sampled-paths-clear"].includes(
              original.body.status,
            )
          )
            throw Error("Installation source report checksum/status changed.");
          if (
            !object(original.body.sourceHashes) ||
            Object.entries(original.body.sourceHashes).some(
              ([file, hash]) => actualSourceSha[sourceFile(file)] !== hash,
            )
          )
            throw Error("Installation source report refers to stale geometry.");
          const subgroupScript =
            row.key === "confirm"
              ? "scripts/audit-puretv-confirm-installation.py"
              : "scripts/audit-puretv-button-installation.py";
          if (
            original.body.auditorScriptSha256 !==
            (await fileSha(subgroupScript))
          )
            throw Error("Installation source report auditor script changed.");
          const sourceButton = array(original.body.buttons).find(
            (item) => item.key === row.key,
          );
          const sourceChecks = sourceButton
            ? array(sourceButton.members).map((member) => ({
                moving: member.part?.name,
                fixed: sourceButton.plate?.name,
                samples: member.samples,
              }))
            : array(original.body.checks);
          if (
            sourceChecks.length !== array(group.checks).length ||
            array(group.checks).some((check) => {
              const source = sourceChecks.find(
                (candidate) =>
                  candidate.moving === check.moving &&
                  candidate.fixed === check.fixed,
              );
              return !source || !same(source.samples, check.samples);
            })
          )
            throw Error(
              "Embedded subgroup samples differ from their actual original source report.",
            );
        } catch (error) {
          normalized.status = "unknown";
          normalized.findings.push({
            status: "unknown",
            detail: `${row.key}: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    }
    audits.push({
      id: path.basename(input.relative, ".json"),
      path: input.relative,
      sha256: await fileSha(input.relative),
      status: normalized.status,
      role: normalized.role,
      findings: normalized.findings,
      report: publicValue(raw) as Json,
      normalized,
    });
  }
  for (const role of ["assembly", "internals", "locks", "display"])
    if (audits.filter((audit) => audit.role === role).length !== 1)
      findings.push({
        status: "unknown",
        detail: `Exactly one final ${role} source audit is required.`,
      });
  const assembly = audits.find((audit) => audit.role === "assembly");
  const mcpFindings = validateMcpRecord(
      project,
      rawProject,
      calibration,
      mcp,
      expectedSourceObjects.size,
    ),
    benchFindings = benchEnvironment(
      project,
      assembly?.report,
      [0, 20, 0],
      calibration,
    );
  const inputsStatus = sumStatus(
    findings.length ? findings.map((finding) => finding.status) : ["pass"],
  );
  const globalStatus = sumStatus([
    inputsStatus,
    ...audits.map((audit) => audit.status),
    sumStatus(mcpFindings.map((finding) => finding.status)),
    sumStatus(benchFindings.map((finding) => finding.status)),
  ]);
  const checks: AssemblyEvidenceProfile["checks"] = [
    {
      id: "final-source-binding",
      status: inputsStatus,
      category: "geometry",
      detail:
        findings.map((finding) => finding.detail).join("; ") ||
        "Every final source, display hash and source object matches the complete exported workbench assembly.",
      evidenceRef: "source-verification:sourceHashes",
    },
    ...audits.map((audit) => ({
      id: audit.id,
      status: audit.status,
      category:
        audit.role === "locks" ? ("fit" as const) : ("geometry" as const),
      detail: audit.findings
        .map((finding) => finding.detail)
        .slice(0, 20)
        .join("; "),
      evidenceRef: `${audit.path}#${audit.role}`,
    })),
    {
      id: "actual-mcp-nine-keys",
      status: sumStatus(mcpFindings.map((finding) => finding.status)),
      category: "circuit",
      detail: mcpFindings.map((finding) => finding.detail).join("; "),
      evidenceRef: options.mcp,
    },
    {
      id: "analytic-bench-environment",
      status: sumStatus(benchFindings.map((finding) => finding.status)),
      category: "geometry",
      detail: benchFindings.map((finding) => finding.detail).join("; "),
      evidenceRef: "source-verification:analyticBench",
    },
  ];
  const movingPaths = array(calibration?.buttons).flatMap((button) => {
    const test = array(mcp?.tests).find((row) => row.key === button.key),
      mechanismKey = binding.mechanismKeys[test?.mechanismId],
      path = assembly?.normalized.paths[button.key];
    return mechanismKey && path
      ? [
          {
            mechanismKey,
            minDisplacement: 0,
            maxDisplacement: path.maxDisplacement,
            continuous: false,
            maxSampleStepMm: path.maxSampleStepMm,
            sourceChecked:
              assembly?.status === "pass" &&
              audits.find((audit) => audit.role === "internals")?.status ===
                "pass",
          },
        ]
      : [];
  });
  const allowedContacts: AssemblyEvidenceProfile["coverage"]["allowedContacts"] =
    [];
  for (const contact of assembly?.normalized.allowedContacts ?? []) {
    const a = sourceToPart.get(
        sourceObject(contact.a?.sourceFile ?? "", contact.a?.sourceName ?? ""),
      ),
      b = sourceToPart.get(
        sourceObject(contact.b?.sourceFile ?? "", contact.b?.sourceName ?? ""),
      );
    if (a && b)
      allowedContacts.push({
        partKeys: [binding.partKeys[a], binding.partKeys[b]],
        region: JSON.stringify({
          sourceCoordinates: "Blender XYZ/Z-up mm",
          regionsAtCheckedPose: contact.permission.regionsBlenderAtPose ?? [
            contact.permission.regionBlenderAtPose,
          ],
          localRegionProof: contact.permission.localRegionProof,
          annularRegionProof: contact.permission.annularRegionProof,
        }),
        maxPenetrationMm: contact.permission.maximumPenetrationMm,
        evidenceRef: `${assembly!.path}#${contact.checkId}`,
      });
  }
  const unknown = [
    ...findings,
    ...audits.flatMap((audit) => audit.findings),
    ...mcpFindings,
    ...benchFindings,
  ]
    .filter((finding) => finding.status === "unknown")
    .map((finding) => finding.detail);
  const limits = [
    "Source collision/clearance evidence is limited to recorded discrete poses and bounded containment witnesses, not continuous collision detection or manufacturing certification.",
    "Spring stiffness, mass, damping and switch overtravel are the declared nominal calibration assumptions, not measured material/fatigue/friction certification.",
    "Spring collision poses use the declared runtime model's axial scaling of the source mesh; constant-wire-section helix deformation and wire self-contact are not solved.",
    "Mesh self-intersection checks cover every harness object; other source objects are covered by the recorded inter-object/interface audits, not a general self-intersection or manufacturing-defect certificate.",
    "Nine lamps and one power source are an external analytic test bench; logical wires do not certify manufactured insulation, solder joints or ESP32 firmware.",
    "Lock/mount trajectories cover named mating pairs in their reported open-housing assembly sequence; they do not certify inserting assembled modules into a closed shell or all-component maintenance sweeps.",
    "The declared compliant lock pads undergo substantial nominal compression during insertion. Allowable pad strain, nonlinear stiffness, assembly force and service life have not been measured; rigid path clearance is not a pad material certification.",
  ];
  const report = publicValue({
    version: 1,
    status: globalStatus,
    generatedAt: validEvidenceTimestamp(mcp?.completedAt)
      ? mcp.completedAt
      : null,
    geometryFingerprint: binding.geometryFingerprint,
    sourceHashes,
    coordinateOffset: [0, 20, 0],
    scope:
      "Complete source-linked pureTV assembly plus ten explicit analytic test-bench parts; only checked source interfaces and nominal sampled actuation are claimed.",
    sourcePartCount: expectedSourceObjects.size,
    totalPartCount: project.parts.length,
    mechanismCount: project.mechanisms?.length ?? 0,
    inputs: {
      project: {
        path: filePath(options.project).relative,
        sha256: jsonSha(rawProject),
      },
      calibration: {
        path: filePath(options.calibration).relative,
        sha256: calibration ? jsonSha(calibration) : null,
      },
      mcp: {
        path: filePath(options.mcp).relative,
        sha256: mcp ? jsonSha(mcp) : null,
      },
    },
    audits: [
      ...audits.map(({ normalized: _, ...audit }) => audit),
      {
        id: "actual-mcp-nine-keys",
        status: sumStatus(mcpFindings.map((finding) => finding.status)),
        findings: mcpFindings,
        report: mcp,
      },
      {
        id: "analytic-bench-environment",
        status: sumStatus(benchFindings.map((finding) => finding.status)),
        findings: benchFindings,
        report: mcp?.analyticBench ?? [],
      },
      { id: "final-source-binding", status: inputsStatus, findings },
    ],
    checks,
    limitations: limits,
  }) as Json;
  const reportText = JSON.stringify(report, null, 2) + "\n";
  const profile: AssemblyEvidenceProfile = {
    version: 1,
    id: "puretv-source-verified-assembly-v1",
    status: globalStatus,
    geometryFingerprint: binding.geometryFingerprint,
    sourceHashes,
    scope: {
      description:
        "绑定整机的源网格采样、名义尺寸/触点及真实MCP逐键验证；不适用于任意编辑。",
      interfaces: [
        "source fixed-fixed geometry",
        "all source moving/spring/actuator paths against the full environment",
        "source insertion/lock/removal interfaces",
        "calibrated striker/switch contact",
        "ten analytic bench entities and nine electrical branches",
      ],
      excluded: [],
      limitations: limits,
    },
    coverage: {
      partCount: project.parts.length,
      mechanismCount: project.mechanisms?.length ?? 0,
      staticGeometry:
        assembly?.normalized.staticComplete &&
        sumStatus(benchFindings.map((finding) => finding.status)) === "pass"
          ? "complete"
          : "partial",
      movingAgainstEnvironment:
        assembly?.normalized.environmentComplete &&
        sumStatus(benchFindings.map((finding) => finding.status)) === "pass"
          ? "complete"
          : "partial",
      stateMode: assembly?.normalized.stateMode ?? "single-key-at-rest",
      movingPaths,
      allowedContacts,
      unknown: [...new Set(unknown)],
    },
    checks,
    provenance: {
      generator: "scripts/build-puretv-evidence.ts",
      version: "1",
      reportUrl: "./models/puretv-source-verification.json",
      reportSha256: shaBytes(reportText),
    },
  };
  const artifacts = [
    { path: "public/models/puretv-source-verification.json", text: reportText },
    {
      path: "public/models/puretv-verified-evidence.json",
      text: JSON.stringify(profile, null, 2) + "\n",
    },
  ];
  if (options.check) {
    if (profile.status !== "pass")
      throw Error(
        `Evidence check requires complete pass; current inputs derive ${profile.status}: ${unknown.slice(0, 5).join("; ")}`,
      );
    for (const artifact of artifacts) {
      let actual: string;
      try {
        actual = await fs.readFile(path.join(ROOT, artifact.path), "utf8");
      } catch {
        throw Error(`Bundled evidence artifact is missing: ${artifact.path}`);
      }
      if (actual !== artifact.text)
        throw Error(
          `Bundled evidence artifact differs from current input provenance/check results: ${artifact.path}`,
        );
    }
  } else {
    for (const artifact of artifacts)
      await fs.writeFile(path.join(ROOT, artifact.path), artifact.text);
  }
  return { report, profile };
}

async function main() {
  const options = {
    project: "public/models/puretv-verified-assembly.json",
    mcp: "docs/puretv-mcp-verification.json",
    calibration: "docs/puretv-calibration.json",
    audits: [] as string[],
    requirePass: false,
    check: false,
  };
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "Usage: npx vite-node --script scripts/build-puretv-evidence.ts [--project PATH] [--mcp PATH] [--calibration PATH] --audit PATH [--audit PATH ...] [--require-pass] [--check]",
    );
    return;
  }
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--check") {
      options.check = true;
      options.requirePass = true;
      continue;
    }
    if (flag === "--require-pass") {
      options.requirePass = true;
      continue;
    }
    if (
      !["--project", "--mcp", "--calibration", "--audit"].includes(flag) ||
      !args[index + 1] ||
      args[index + 1].startsWith("--")
    )
      throw Error(`Invalid argument: ${flag}`);
    const value = filePath(args[++index]).relative;
    if (flag === "--audit") options.audits.push(value);
    else options[flag.slice(2) as "project" | "mcp" | "calibration"] = value;
  }
  const { profile } = await buildPuretvEvidence(options);
  console.log(
    JSON.stringify({
      status: profile.status,
      geometryFingerprint: profile.geometryFingerprint,
      parts: profile.coverage.partCount,
      mechanisms: profile.coverage.mechanismCount,
      unknown: profile.coverage.unknown.length,
      stateMode: profile.coverage.stateMode,
    }),
  );
  if (options.requirePass && profile.status !== "pass") process.exitCode = 1;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
