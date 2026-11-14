"""Merge independently checked moving-subgroup paths into the lock audit.

Run the lock, confirm-installation and button-installation Blender audits first,
then this script and extract-puretv-bearing-regions.py. Source hashes and the
actual eight-button poses are checked again; stale evidence is never rebound.
"""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets/puretv-controller"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def current_hashes(hashes):
    for relative, digest in hashes.items():
        if sha(SOURCE / relative) != digest:
            raise RuntimeError(f"Stale installation evidence: {relative}")


def read(relative):
    path = ROOT / relative
    report = json.loads(path.read_text())
    if not report.get("sourceFilesUnchanged"):
        raise RuntimeError(f"Sources changed during {relative}")
    current_hashes(report["sourceHashes"])
    return report, sha(path)


path = ROOT / "docs/puretv-geometry-locks.json"
locks = json.loads(path.read_text())
confirm_source = "docs/puretv-geometry-confirm-installation.json"
buttons_source = "docs/puretv-geometry-button-installation.json"
confirm, confirm_digest = read(confirm_source)
buttons, buttons_digest = read(buttons_source)
if confirm["status"] != "sampled-path-clear" or buttons["status"] != "sampled-paths-clear":
    raise RuntimeError("An installation subgroup still has blocked or unverified poses")

forward_count, reverse_count = 0, 0
for item in locks["buttons"]:
    current_hashes({item["sourceFile"]: item["sourceSha256"], item["plateFile"]: item["plateSha256"]})
    if item["key"] == "confirm":
        subgroup = confirm
        if len(subgroup["checks"]) != 8:
            raise RuntimeError("Confirm body, two terminals and actuator require both upper-housing and cap checks")
        for check in subgroup["checks"]:
            if check["blockedSamples"]:
                raise RuntimeError("Blocked confirm subgroup")
            check["reverseSamples"] = [{**sample, "stage": "reverse-"+sample["stage"]} for sample in reversed(check["samples"])]
        subgroup["sourceReport"], subgroup["sourceReportSha256"] = confirm_source, confirm_digest
        subgroup["reverseRemoval"]["status"] = "sampled-path-clear"
        subgroup["reverseRemoval"]["recording"] = "Each check explicitly enumerates the same static rigid poses in reverse; no friction or force reversibility is inferred."
        item["installation"]["slidingClearance"] = subgroup["slidingClearance"]
    else:
        source = next(button for button in buttons["buttons"] if button["key"] == item["key"])
        if source["sourceSha256"] != item["sourceSha256"] or source["plateSha256"] != item["plateSha256"] or source["status"] != "sampled-path-clear" or len(source["members"]) != 6:
            raise RuntimeError("Eight-button subgroup does not match its exact source lock")
        checks = []
        for member in source["members"]:
            if len(member["samples"]) != len(item["path"]["samples"]):
                raise RuntimeError("Subgroup path must match the recorded source lock samples")
            for sample, lock in zip(member["samples"], item["path"]["samples"]):
                if abs(sample["angleDeg"]-lock["angleDeg"]) > 1e-8 or abs(sample["axialOffsetMm"]-lock["axialOffsetMm"]) > 1e-8:
                    raise RuntimeError("Subgroup pose differs from the actual lock path")
            checks.append({"moving": member["part"]["name"], "fixed": source["plate"]["name"], "movingPart": member["part"], "maximumObservedVertexTravelMm": member["maximumObservedVertexTravelMm"], "samples": member["samples"], "reverseSamples": member["reverseRemoval"]["samples"], "blockedSamples": sum(bool(sample["surfaceTrianglePairs"] or sample["strictInteriorSamples"]) for sample in member["samples"])})
        subgroup = {"schemaVersion": 1, "key": item["key"], "status": source["status"], "sourceFilesUnchanged": buttons["sourceFilesUnchanged"], "sourceHashes": {source["sourceFile"]: source["sourceSha256"], source["plateFile"]: source["plateSha256"]}, "sourceReport": buttons_source, "sourceReportSha256": buttons_digest, "auditorScriptSha256": buttons["auditorScriptSha256"], "scope": buttons["scope"], "limitations": buttons["limitations"], "axisCenterSourceXY": source["axisCenterSourceXY"], "entryAngleDeg": source["entryAngleDeg"], "startAxialOffsetMm": source["startAxialOffsetMm"], "turnAxialOffsetMm": source["turnAxialOffsetMm"], "lockedAngleDeg": source["lockedAngleDeg"], "lockedRestAxialOffsetMm": source["lockedAxialOffsetMm"], "sourcePoseCount": source["sourcePoseCount"], "checkedPoseCount": source["checkedPoseCount"], "maximumSampledVertexTravelMm": source["maximumAllowedVertexTravelMm"], "sourceObjects": [member["part"] for member in source["members"]]+[source["plate"]], "checks": checks, "blockedSampleCount": source["blockedSampleCount"], "reverseRemoval": {"status": "sampled-path-clear", "method": "Each check.reverseSamples explicitly reverses the same source lock poses; wires are attached only after locking and removed before disassembly."}, "pathBinding": "Every recorded angle and axial offset was compared with this key's current path.samples; the containing JSON may gain supplemental evidence without changing the physical path."}
    subgroup["movingMembers"] = list(dict.fromkeys(check["moving"] for check in subgroup["checks"]))
    subgroup["fixedMembers"] = list(dict.fromkeys(check["fixed"] for check in subgroup["checks"]))
    item.setdefault("installation", {})["movingSubgroupAssembly"] = subgroup
    forward_count += sum(len(check["samples"]) for check in subgroup["checks"])
    reverse_count += sum(len(check["reverseSamples"]) for check in subgroup["checks"])

locks["summary"]["movingSubgroupCoverage"] = "complete"
locks["summary"]["subgroupSummary"] = {"status": "sampled-paths-clear", "auditedKeys": len(locks["buttons"]), "forwardPoseChecks": forward_count, "reversePoseChecks": reverse_count}
locks["installationEvidenceMerge"] = {"scriptSha256": sha(Path(__file__)), "inputs": [{"file": confirm_source, "sha256": confirm_digest}, {"file": buttons_source, "sha256": buttons_digest}], "scope": "Source-bound installation paths with the upper/lower housing open and wires disconnected. Nonlinear pad compression, force, friction and manufacturing fit are outside these mesh-path checks."}
path.write_text(json.dumps(locks, ensure_ascii=False, indent=2)+"\n")
print("MERGED", forward_count, "forward and", reverse_count, "reverse subgroup poses")
