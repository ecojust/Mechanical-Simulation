"""Remove a measured off-axis wall inside the existing ABXY-1 D1.70 pilot.

The cutter follows the existing 63-sided bore ring and its original floor.
No screw, bore floor, outer support wall, or other mounting feature is resized.
Default writes a checked candidate outside the repository; --apply copies the
checked bytes to the authorized lower-housing source.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
SCRATCH = ROOT.parent / "scratch"
spec = importlib.util.spec_from_file_location("source_lock_geometry", ROOT / "scripts/audit-puretv-locks.py")
geometry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(geometry)


def evaluated(obj):
    graph = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(graph), depsgraph=graph)
    mesh.calc_loop_triangles()
    points = np.empty(len(mesh.vertices)*3)
    mesh.vertices.foreach_get("co", points)
    points = points.reshape((-1, 3))
    matrix = np.asarray(obj.matrix_world)
    points = points @ matrix[:3, :3].T+matrix[:3, 3]
    faces = np.empty(len(mesh.loop_triangles)*3, dtype=np.int32)
    mesh.loop_triangles.foreach_get("vertices", faces)
    faces = faces.reshape((-1, 3))
    bm = bmesh.new()
    bm.from_mesh(mesh)
    topology = {"boundaryEdges": sum(edge.is_boundary for edge in bm.edges), "nonManifoldEdges": sum(not edge.is_manifold for edge in bm.edges), "volumeMm3": abs(bm.calc_volume(signed=True)*obj.matrix_world.to_3x3().determinant())}
    bm.free()
    bpy.data.meshes.remove(mesh)
    return geometry.Geometry(obj.name, points, faces), topology


def axial_hits(mesh, center):
    cursor = Vector((center[0], center[1], mesh.low[2]-1))
    direction = Vector((0, 0, 1))
    result = []
    for _ in range(64):
        point, normal, face, distance = mesh.tree.ray_cast(cursor, direction, float(mesh.high[2]-cursor.z+1))
        if point is None:
            break
        result.append({"sourceZ": float(point.z), "normalZ": float(normal.z)})
        cursor = point+direction*.0001
    return result


def radial_measurements(mesh, center, low, high):
    rows = []
    for z in np.linspace(low+.01, high-.01, 21):
        radii, invalid = [], 0
        for angle in np.arange(0, 360, 2)+.137:
            direction = Vector((np.cos(np.deg2rad(angle)), np.sin(np.deg2rad(angle)), 0))
            point, normal, face, distance = mesh.tree.ray_cast(Vector((center[0], center[1], z)), direction, 2)
            if point is None or normal.dot(direction)*mesh.orientation > -.1 or abs(normal.z) > .001:
                invalid += 1
            else:
                radii.append(float(distance))
        rows.append({"sourceZ": float(z), "minimumPilotRadiusMm": min(radii, default=None), "maximumPilotRadiusMm": max(radii, default=None), "invalidRays": invalid, "rayCount": 180})
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else [])
    source = geometry.SOURCE / "housing/bottom.blend"
    source_sha = geometry.sha(source)
    audit_path = ROOT / "docs/puretv-geometry-fasteners.json"
    audit = json.loads(audit_path.read_text())
    if audit["sourceHashes"]["housing/bottom.blend"] != source_sha:
        raise RuntimeError("Fastener evidence no longer matches the lower housing")
    measured = next(item for item in audit["fasteners"] if item["sourceName"] == "ABXY · 边中点 M2 固定螺钉 1.002")
    if len(measured["irregularPilotWallFaces"]) == 0:
        raise RuntimeError("No independently measured off-axis obstruction to repair")
    backup = SCRATCH / "puretv-abxy-pilot-before.blend"
    if not backup.exists():
        shutil.copy2(source, backup)
    before_report = ROOT / "docs/puretv-geometry-fasteners-before.json"
    if not before_report.exists():
        shutil.copy2(audit_path, before_report)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    with bpy.data.libraries.load(str(source), link=False) as (available, loaded):
        loaded.collections = [name for name in available.collections if name.startswith("pureTV")]
    for collection in loaded.collections:
        bpy.context.scene.collection.children.link(collection)
    bpy.context.view_layer.update()
    obj = next(obj for obj in bpy.context.scene.objects if "底壳 · 合壳" in obj.name)
    before, before_topology = evaluated(obj)
    center = np.asarray(measured["axisCenterSourceXY"])
    known_faces = measured["proposedNominalInterfaceRegion"]["fixedCylindricalWallTriangleIndices"]
    wall = before.v[before.f[known_faces]]
    floor_z, top_z = float(wall[:, :, 2].min()), float(wall[:, :, 2].max())
    radius = np.linalg.norm(before.v[:, :2]-center, axis=1)
    ring = before.v[(np.abs(before.v[:, 2]-top_z) < 1e-5) & (np.abs(radius-.85) < 1e-5), :2]
    ring = np.unique(ring, axis=0)
    ring = ring[np.argsort(np.arctan2(ring[:, 1]-center[1], ring[:, 0]-center[0]))]
    if len(ring) != 63:
        raise RuntimeError(f"Expected the measured original 63-sided D1.70 bore, found {len(ring)} vertices")
    count = len(ring)
    points = [[float(x), float(y), z] for z in [floor_z, top_z+.001] for x, y in ring]
    faces = [tuple(reversed(range(count))), tuple(range(count, 2*count))]
    faces += [(i, (i+1) % count, (i+1) % count+count, i+count) for i in range(count)]
    cutter_mesh = bpy.data.meshes.new("Measured existing ABXY1 pilot boundary")
    cutter_mesh.from_pydata(points, [], faces)
    cutter_mesh.update()
    cutter = bpy.data.objects.new("Local existing-pilot obstruction cutter", cutter_mesh)
    bpy.context.scene.collection.objects.link(cutter)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    modifier = obj.modifiers.new("Restore measured ABXY1 pilot interior", "BOOLEAN")
    modifier.operation = "DIFFERENCE"
    modifier.solver = "EXACT"
    modifier.object = cutter
    modifier.use_self = False
    modifier.use_hole_tolerant = True
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    bpy.data.objects.remove(cutter, do_unlink=True)
    bpy.context.view_layer.update()
    after, after_topology = evaluated(obj)
    if after_topology["boundaryEdges"] or after_topology["nonManifoldEdges"]:
        raise RuntimeError(f"Candidate topology failed: {after_topology}")
    outside_changes = []
    for first, second, label in [(before, after, "old-to-new"), (after, before, "new-to-old")]:
        other_vertices = {tuple(point) for point in np.round(second.v, 6)}
        for point in first.v:
            if tuple(np.round(point, 6)) in other_vertices:
                continue
            inside_cutter = np.linalg.norm(point[:2]-center) <= .85002 and floor_z-.0001 <= point[2] <= top_z+.002
            nearest = second.tree.find_nearest(Vector(point))
            if not inside_cutter and (nearest[0] is None or nearest[3] > .0001):
                outside_changes.append({"direction": label, "pointSource": point, "surfaceDistanceMm": nearest[3]})
    if outside_changes:
        raise RuntimeError(f"Unexpected changes outside the measured bore: {outside_changes[:3]}")
    before_axis, after_axis = axial_hits(before, center), axial_hits(after, center)
    if len(before_axis) != len(after_axis) or any(abs(a["sourceZ"]-b["sourceZ"]) > .0001 for a, b in zip(before_axis, after_axis)):
        raise RuntimeError("Pilot floor or exterior end face changed")
    rows = radial_measurements(after, center, floor_z, top_z)
    if any(row["invalidRays"] or row["minimumPilotRadiusMm"] < .8488 or row["maximumPilotRadiusMm"] > .8501 for row in rows):
        raise RuntimeError("Candidate does not restore the measured D1.70 pilot")
    candidate = SCRATCH / "puretv-abxy-pilot-candidate.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(candidate), check_existing=False)
    if geometry.sha(source) != source_sha:
        raise RuntimeError("Source changed during candidate generation")
    if args.apply:
        shutil.copy2(candidate, source)
    report = {"schema": 1, "appliedToSource": args.apply, "sourceFile": "assets/puretv-controller/housing/bottom.blend", "sourceSha256Before": source_sha, "sourceSha256After": geometry.sha(source), "candidateSha256": geometry.sha(candidate), "targetPair": ["baseplates/abxy.blend::ABXY · 边中点 M2 固定螺钉 1.002", "housing/bottom.blend::"+obj.name], "axisCenterSourceXY": center, "nominalPilotDiameterMm": 1.7, "originalPilotPolygonSides": count, "originalPilotSourceZ": [floor_z, top_z], "before": before.report(), "after": after.report(), "topologyBefore": before_topology, "topologyAfter": after_topology, "removedVolumeMm3": before_topology["volumeMm3"]-after_topology["volumeMm3"], "outsideBoreSurfaceChanges": outside_changes, "axisRayBefore": before_axis, "axisRayAfter": after_axis, "radialSectionsAfter": rows, "beforeObstructingFaces": measured["irregularPilotWallFaces"], "scope": "Remove only the old off-axis material protruding into an already existing D1.70 nominal M2 pilot. The existing 63-sided pilot contour and its floor are retained; no outer support or screw is resized. Threads remain declared nominal envelopes, not resolved helical geometry."}
    (ROOT / "docs/puretv-geometry-abxy-pilot-repair.json").write_text(json.dumps(report, ensure_ascii=False, indent=2, default=geometry.clean)+"\n")
    print("PILOT_REPAIR", report["appliedToSource"], report["removedVolumeMm3"], report["sourceSha256After"], flush=True)


if __name__ == "__main__":
    main()
