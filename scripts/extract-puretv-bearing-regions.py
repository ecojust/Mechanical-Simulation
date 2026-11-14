"""Publish the measured confirm bearing patches from the current source audit."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
audit_path = ROOT / "docs/puretv-geometry-locks.json"
audit = json.loads(audit_path.read_text())
confirm = next(button for button in audit["buttons"] if button["key"] == "confirm")
if confirm["status"] != "sampled-path-clear":
    raise RuntimeError("Confirm installation has not passed its scoped source audit")
for path_key, hash_key in [("sourceFile", "sourceSha256"), ("plateFile", "plateSha256")]:
    actual = hashlib.sha256((ROOT / "assets/puretv-controller" / confirm[path_key]).read_bytes()).hexdigest()
    if actual != confirm[hash_key]:
        raise RuntimeError(f"Source changed after the lock audit: {confirm[path_key]}")
contact = confirm["path"]["samples"][-1]["bearingContact"]
result = {"schema": 1, "coordinates": "Source millimetres/Z-up", "movingSourceId": confirm["sourceFile"]+"::"+confirm["sourceObjects"][0]["name"], "fixedSourceId": confirm["plateFile"]+"::"+confirm["sourceObjects"][1]["name"], "sourceHashes": {confirm["sourceFile"]: confirm["sourceSha256"], confirm["plateFile"]: confirm["plateSha256"]}, "sourceAudit": "docs/puretv-geometry-locks.json", "sourceAuditSha256": hashlib.sha256(audit_path.read_bytes()).hexdigest(), "status": contact["status"], "sourcePlaneZ": contact["sourcePlaneZ"], "planeToleranceMm": contact["numericPlaneToleranceMm"], "strictInteriorSamples": contact["strictInteriorSamples"], "regions": [], "scope": "Only the opposing horizontal seat-ear/support-floor bearing patches. No positive material penetration, adjacent wall contact, full-pair exemption or strength claim is allowed."}
for sector in [0, 1]:
    rows = [patch for patch in contact["supportingTrianglePairs"] if patch["sector"] == sector]
    points = [point for patch in rows for point in patch["polygonSourceXY"]]
    lo = [min(point[axis] for point in points) for axis in [0, 1]]
    hi = [max(point[axis] for point in points) for axis in [0, 1]]
    result["regions"].append({"sector": sector, "sourceMin": [*lo, contact["sourcePlaneZ"]-contact["numericPlaneToleranceMm"]], "sourceMax": [*hi, contact["sourcePlaneZ"]+contact["numericPlaneToleranceMm"]], "bearingAreaMm2": contact["bearingPatchAreasMm2"][sector], "movingTriangleIndices": sorted({patch["movingTriangle"] for patch in rows}), "fixedTriangleIndices": sorted({patch["fixedTriangle"] for patch in rows})})
result["interfaceDeclaration"] = {"id": "confirm-seat-upper-housing-bearing", "pair": [result["movingSourceId"], result["fixedSourceId"]], "regionBlender": {"min": [min(region["sourceMin"][axis] for region in result["regions"]) for axis in range(3)], "max": [max(region["sourceMax"][axis] for region in result["regions"]) for axis in range(3)]}, "regionsBlender": [{"min": region["sourceMin"], "max": region["sourceMax"]} for region in result["regions"]], "maximumPenetrationMm": 1e-5, "reason": "Only these two measured opposing horizontal seat-ear/support-floor patches carry the locked seat. The full source audit independently clips every contact to source Z25.45 and these two patches, with no interior penetration; unrelated sidewalls and any deeper crossing remain blocked.", "sourcePlaneZ": contact["sourcePlaneZ"], "planeToleranceMm": contact["numericPlaneToleranceMm"], "scope": "Nominal load-bearing surface contact; neither a full-pair waiver nor a material-strength certificate."}
output = ROOT / "docs/puretv-confirm-bearing-regions.json"
output.write_text(json.dumps(result, indent=2, ensure_ascii=False)+"\n")
print(output.relative_to(ROOT))
