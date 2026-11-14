"""Read-only source dimensions of the eight M2 envelopes and lower-shell pilots.

This quantifies an explicitly named nominal threaded interface. It never claims
that intersecting smooth cylinders are resolved helical threads or validates
thread strength, tapping, friction, torque, or plastic deformation.
Run with Blender 5.2+: blender -b --python scripts/audit-puretv-fasteners.py
"""
import argparse
import importlib.util
import json
import math
from pathlib import Path
import sys

import bpy
import numpy as np
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("source_lock_geometry", ROOT / "scripts/audit-puretv-locks.py")
geometry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(geometry)
SOURCE = geometry.SOURCE


def add_nominal_declarations(report):
    report["flatInterfaces"] = []
    for item in report["fasteners"]:
        if item["status"] != "nominal-interface-dimensions-measured":
            continue
        region = item["proposedNominalInterfaceRegion"]
        maximum = item["shaftDiameterRangeMm"][1]/2-item["cylindricalWallPlaneRadiusRangeMm"][0]+1e-5
        group = Path(item["sourceFile"]).stem
        index = item["sourceName"].split("固定螺钉 ")[1].split(".")[0]
        rule = {"id": f"nominal-m2-{group}-{index}", "pair": [item["sourceFile"]+"::"+item["sourceName"], item["fixedSourceFile"]+"::"+item["fixedSourceName"]], "regionBlender": {"min": region["sourceMin"], "max": region["sourceMax"]}, "maximumPenetrationMm": maximum, "reason": "This exact source M2-design screw uses a measured D1.86 smooth polygonal shank envelope in this exact D1.70 pilot. Only the measured retained annular engagement is a declared nominal threaded interface; the source omits helical teeth. The screw head, hole floor, other plastic and any deeper or off-axis intrusion are excluded.", "annularRegion": {"axisCenterSourceXY": region["axisCenterSourceXY"], "innerRadiusMm": region["innerRadiusMm"], "outerRadiusMm": region["outerRadiusMm"], "sourceZMin": region["sourceMin"][2], "sourceZMax": region["sourceMax"][2]}, "measuredShankDiameterMm": item["shaftDiameterRangeMm"], "measuredPilotPlaneRadiusMm": item["cylindricalWallPlaneRadiusRangeMm"], "scope": "Source-design nominal fastening occupancy only; this is not proof of a manufactured helical thread, material displacement, engagement strength or tightening torque."}
        item["interfaceDeclaration"] = rule
        report["flatInterfaces"].append(rule)


def radial_section(screw, shell, center, z):
    values = []
    outer = float(np.linalg.norm(screw.v[:, :2]-center[:2], axis=1).max()+1)
    # Avoid launching every cardinal ray exactly through a cylinder seam edge.
    for angle in np.arange(0, 360, 5)+.137:
        direction = Vector((math.cos(math.radians(angle)), math.sin(math.radians(angle)), 0))
        origin = Vector((center[0], center[1], float(z)))
        hit, normal, face, distance = screw.tree.ray_cast(origin+direction*outer, -direction, outer)
        if hit is None:
            continue
        radius = float((hit-origin).length)
        hole, hole_normal, hole_face, hole_distance = shell.tree.ray_cast(origin, direction, outer+1)
        enters_material = hole is not None and hole_normal.dot(direction)*shell.orientation < -.1
        values.append({"angleDeg": float(angle), "screwRadiusMm": radius, "shellFirstSurfaceRadiusMm": float(hole_distance) if hole is not None else None, "shellFirstSurfaceNormalSource": list(hole_normal) if hole is not None else None, "cylindricalWall": bool(enters_material and abs(hole_normal.z) < .001), "axisInPilotVoid": bool(enters_material), "radialEnvelopeIntrusionMm": max(0, radius-float(hole_distance)) if enters_material else None, "screwTriangle": int(face), "shellTriangle": int(hole_face) if hole is not None else None})
    void_rays = [value for value in values if value["axisInPilotVoid"]]
    return {"sourceZ": float(z), "screwRadiusRangeMm": [min((value["screwRadiusMm"] for value in values), default=0), max((value["screwRadiusMm"] for value in values), default=0)], "pilotRadiusRangeMm": [min((value["shellFirstSurfaceRadiusMm"] for value in void_rays), default=None), max((value["shellFirstSurfaceRadiusMm"] for value in void_rays), default=None)], "pilotVoidRayCount": len(void_rays), "maximumRadialEnvelopeIntrusionMm": max((value["radialEnvelopeIntrusionMm"] for value in void_rays), default=0), "rays": values}


def audit_screw(relative, token, shell):
    screw = geometry.load_named(relative, token)
    center = (screw.low+screw.high)/2
    levels = np.unique(np.round(screw.v[:, 2], 5))
    spans = []
    for low, high in zip(levels, levels[1:]):
        if high-low < .001:
            continue
        section = radial_section(screw, shell, center, (low+high)/2)
        spans.append({"sourceZMin": float(low), "sourceZMax": float(high), "heightMm": float(high-low), "section": section})
    longest = max(spans, key=lambda span: span["heightMm"])
    shaft_z = (longest["sourceZMin"]+longest["sourceZMax"])/2
    z_faces = screw.v[:, 2][screw.f]
    crossing = screw.f[(z_faces.min(axis=1) < shaft_z) & (z_faces.max(axis=1) > shaft_z)]
    profile_radii, profile_edge_radii = [], []
    for triangle in screw.v[crossing]:
        cuts = geometry.triangle_plane_cuts(triangle, triangle[:, 2]-shaft_z)
        if len(cuts) != 2:
            continue
        segment = cuts[:, :2]-center[:2]
        profile_radii.extend(np.linalg.norm(segment, axis=1).tolist())
        edge = segment[1]-segment[0]
        parameter = np.clip(-float(segment[0] @ edge)/max(float(edge @ edge), 1e-30), 0, 1)
        profile_edge_radii.append(float(np.linalg.norm(segment[0]+edge*parameter)))
    shaft_radius = max(profile_radii)
    shaft_spans = [span for span in spans if abs(span["section"]["screwRadiusRangeMm"][1]-shaft_radius) < .02]
    shaft_low = min(span["sourceZMin"] for span in shaft_spans)
    shaft_high = max(span["sourceZMax"] for span in shaft_spans)
    zs = np.linspace(shaft_low+.001, shaft_high-.001, math.ceil((shaft_high-shaft_low)/.1)+1)
    sections = [radial_section(screw, shell, center, z) for z in zs]
    overlap = [section for section in sections if section["maximumRadialEnvelopeIntrusionMm"] > 1e-5]
    void_sections = [section for section in sections if section["pilotVoidRayCount"] == 72]
    tip_section = radial_section(screw, shell, center, shaft_low+.01)
    min_hole = min((section["pilotRadiusRangeMm"][0] for section in overlap if section["pilotRadiusRangeMm"][0] is not None), default=None)
    max_hole = max((section["pilotRadiusRangeMm"][1] for section in overlap if section["pilotRadiusRangeMm"][1] is not None), default=None)
    engaged_rays = [ray for section in sections for ray in section["rays"] if (ray["radialEnvelopeIntrusionMm"] or 0) > 1e-5]
    cylindrical_faces = sorted(set(ray["shellTriangle"] for ray in engaged_rays if ray["cylindricalWall"]))
    wall_triangles = shell.v[shell.f[cylindrical_faces]]
    normals = np.cross(wall_triangles[:, 1]-wall_triangles[:, 0], wall_triangles[:, 2]-wall_triangles[:, 0])
    normals /= np.maximum(np.linalg.norm(normals, axis=1)[:, None], 1e-30)
    plane_radii = np.abs(np.einsum("ni,ni->n", wall_triangles[:, 0, :2]-center[:2], normals[:, :2]))/np.maximum(np.linalg.norm(normals[:, :2], axis=1), 1e-30)
    nominal_plane_radius = float(np.median(plane_radii))
    regular = np.abs(plane_radii-nominal_plane_radius) < .01
    wall_low = max(shaft_low, float(wall_triangles[regular, :, 2].min()))
    wall_high = min(shaft_high, float(wall_triangles[regular, :, 2].max()))
    irregular = [{"fixedTriangleIndex": int(cylindrical_faces[index]), "verticesSource": wall_triangles[index], "normalSource": normals[index], "planeDistanceFromAxisMm": float(plane_radii[index])} for index in np.flatnonzero(~regular)]
    non_cylindrical = [ray for ray in engaged_rays if not ray["cylindricalWall"]]
    non_cylindrical_intrusion = max((ray["radialEnvelopeIntrusionMm"] for ray in non_cylindrical), default=0)
    pair = geometry.Pair(screw, shell, center)
    intersection = pair.check(0, 0, detail=True)
    region = {"sourceMin": [float(center[0]-shaft_radius-.0001), float(center[1]-shaft_radius-.0001), wall_low-.0001], "sourceMax": [float(center[0]+shaft_radius+.0001), float(center[1]+shaft_radius+.0001), wall_high+.0001], "axisSource": [0, 0, 1], "axisCenterSourceXY": center[:2], "innerRadiusMm": float(plane_radii[regular].min())-.0001, "outerRadiusMm": shaft_radius+.0001, "onlyAnnularPilotEngagement": True, "fixedCylindricalWallTriangleIndices": [int(cylindrical_faces[index]) for index in np.flatnonzero(regular)]}
    outside = []
    for witness in intersection.get("penetrationExamples", []):
        point = witness["point"]
        if np.linalg.norm(np.asarray(point[:2])-center[:2]) > shaft_radius+.0001 or point[2] < shaft_low-.0001 or point[2] > shaft_high+.0001:
            outside.append(witness)
    result = {"sourceFile": relative, "sourceSha256": geometry.sha(SOURCE/relative), "sourceName": screw.name, "fixedSourceFile": "housing/bottom.blend", "fixedSourceName": shell.name, "sourceObjects": [screw.report(), shell.report()], "declaredNominalThread": "M2 source-design envelope; helical thread/flank geometry is not modeled", "axisCenterSourceXY": center[:2], "shaftDiameterRangeMm": [2*min(profile_edge_radii), 2*shaft_radius], "shaftDiameterMethod": "Exact unsimplified triangle-plane section: minimum polygon-edge distance and maximum polygon-vertex radius, not the 5-degree ray samples.", "shaftSourceZRangeMm": [shaft_low, shaft_high], "pilotDiameterRangeWithinSampledEngagementMm": [2*min_hole if min_hole is not None else None, 2*max_hole if max_hole is not None else None], "cylindricalWallPlaneRadiusRangeMm": [float(plane_radii.min()), float(plane_radii.max())], "irregularPilotWallFaces": irregular, "maximumSampledRadialEnvelopeIntrusionMm": max((section["maximumRadialEnvelopeIntrusionMm"] for section in sections), default=0), "maximumNonCylindricalIntrusionMm": non_cylindrical_intrusion, "nonCylindricalIntrusionRays": sorted(non_cylindrical, key=lambda ray: -ray["radialEnvelopeIntrusionMm"])[:12], "sampledEngagementSourceZRangeMm": [min((section["sourceZ"] for section in overlap), default=None), max((section["sourceZ"] for section in overlap), default=None)], "shaftTipPilotVoidRayCount": tip_section["pilotVoidRayCount"], "allAzimuthPilotVoidSectionCount": len(void_sections), "sectionCount": len(sections), "maximumAxialSampleStepMm": .1, "angularStepDeg": 5, "angularOffsetDeg": .137, "proposedNominalInterfaceRegion": region, "observedMeshIntersection": intersection, "penetrationWitnessesOutsideShaftRegion": outside, "sections": sections, "geometricProfileSpans": spans, "status": "nominal-interface-dimensions-measured" if overlap and not outside and non_cylindrical_intrusion < 1e-5 and not irregular else "requires-interface-review", "limitations": ["A named M2 part is not by itself evidence that a material overlap is acceptable.", "A local threaded engagement may be declared only for this exact source pair and shaft/pilot region; the head, bearing face, hole floor and unrelated plastic are excluded.", "Pilot dimensions are sampled on actual surfaces. No thread pitch, flank profile, tapping operation, assembly torque or material strength is inferred."]}
    def compact_section(section):
        rays = section.pop("rays")
        candidates = [ray for ray in rays if ray["axisInPilotVoid"]]
        chosen = {}
        if candidates:
            for value in [min(candidates, key=lambda ray: ray["shellFirstSurfaceRadiusMm"]), max(candidates, key=lambda ray: ray["shellFirstSurfaceRadiusMm"]), max(candidates, key=lambda ray: ray["radialEnvelopeIntrusionMm"])]:
                chosen[value["angleDeg"]] = value
        section["sampledRayCount"] = len(rays)
        section["extremeRayWitnesses"] = list(chosen.values())
    for section in sections:
        compact_section(section)
    for span in spans:
        compact_section(span["section"])
    print("FASTENER", screw.name, "shaft", result["shaftDiameterRangeMm"], "pilot", result["pilotDiameterRangeWithinSampledEngagementMm"], "intrusion", result["maximumSampledRadialEnvelopeIntrusionMm"], "outside", len(outside), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=str(ROOT / "docs/puretv-geometry-fasteners.json"))
    parser.add_argument("--declarations-only", action="store_true", help="Derive explicit local rules from an existing current-source measurement report")
    args = parser.parse_args(sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else [])
    if args.declarations_only:
        report = json.loads(Path(args.output).read_text())
        if not report.get("sourceFilesUnchanged") or any(geometry.sha(SOURCE/path) != digest for path, digest in report["sourceHashes"].items()):
            raise RuntimeError("Cannot declare interfaces from stale source measurements")
        add_nominal_declarations(report)
        Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2, default=geometry.clean)+"\n")
        print("DECLARED", len(report["flatInterfaces"]), flush=True)
        return
    paths = ["baseplates/dpad.blend", "baseplates/abxy.blend", "housing/bottom.blend"]
    hashes = {path: geometry.sha(SOURCE/path) for path in paths}
    bpy.ops.wm.read_factory_settings(use_empty=True)
    shell = geometry.load_named(paths[-1], "底壳 · 合壳")
    report = {"schema": 1, "coordinates": "Source millimetres/Z-up; client=(source.x,source.z,-source.y)", "sourceHashes": hashes, "scope": "Eight individual named screw envelopes against the actual lower-shell pilot surfaces. Dimension evidence for explicit nominal thread interfaces, not a source-mesh clearance or manufacturing certificate.", "fasteners": []}
    for relative in paths[:2]:
        for index in range(1, 5):
            report["fasteners"].append(audit_screw(relative, f"固定螺钉 {index}.002", shell))
            Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2, default=geometry.clean)+"\n")
    report["sourceFilesUnchanged"] = all(geometry.sha(SOURCE/path) == digest for path, digest in hashes.items())
    add_nominal_declarations(report)
    Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2, default=geometry.clean)+"\n")


if __name__ == "__main__":
    main()
