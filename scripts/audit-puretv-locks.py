"""Read-only source-mesh bayonet assembly audit (Blender 5.2+).

Measured four-key candidate, before fitting the upper housing::

    blender -b --python scripts/audit-puretv-locks.py -- \
      --path-only --path-entry=-25 --seated-offset=-.25

Explore arbitrary source angles/depths with --angle-min/--angle-max and
--offset-min/--offset-max, omitting --path-only. Never infer a locking result
merely from a free rotation: a straight-pull penetration witness is required.

The unsimplified sleeve stays fixed in a BVH. Inverse-transforming the much
smaller actual baseplate gives exactly the same relative triangle geometry.
No display mesh, nominal two-lug proxy, decimation, or disabled collider is used.
"""
import argparse
import gc
import hashlib
import json
import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets/puretv-controller"
EPS = 1e-5


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def clean(value):
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, (np.floating, np.integer)):
        return value.item()
    raise TypeError(type(value))


def client(point):
    return [float(point[0]), float(point[2]), float(-point[1])]


def load_named(relative, token):
    with bpy.data.libraries.load(str(SOURCE / relative), link=False) as (available, loaded):
        loaded.objects = [name for name in available.objects if token in name]
    if len(loaded.objects) != 1:
        raise RuntimeError(f"Expected one {token} in {relative}, got {len(loaded.objects)}")
    obj = loaded.objects[0]
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.update()
    graph = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(graph), depsgraph=graph)
    mesh.calc_loop_triangles()
    coords = np.empty(len(mesh.vertices) * 3, dtype=np.float64)
    mesh.vertices.foreach_get("co", coords)
    coords = coords.reshape((-1, 3))
    matrix = np.asarray(obj.matrix_world)
    coords = coords @ matrix[:3, :3].T + matrix[:3, 3]
    faces = np.empty(len(mesh.loop_triangles) * 3, dtype=np.int32)
    mesh.loop_triangles.foreach_get("vertices", faces)
    faces = faces.reshape((-1, 3))
    name = obj.name
    bpy.data.meshes.remove(mesh)
    return Geometry(name, coords, faces)


class Geometry:
    def __init__(self, name, vertices, faces):
        self.name, self.v, self.f = name, vertices, faces
        self.low, self.high = vertices.min(axis=0), vertices.max(axis=0)
        self.tree = BVHTree.FromPolygons(vertices.tolist(), faces.tolist(), all_triangles=True, epsilon=0)
        a, b, c = (vertices[faces[:, index]] for index in range(3))
        volume = float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6)
        self.orientation = 1 if volume >= 0 else -1

    def report(self):
        digest = hashlib.sha256()
        digest.update(self.v.astype("<f8").tobytes())
        digest.update(self.f.astype("<i4").tobytes())
        return {"name": self.name, "vertices": len(self.v), "triangles": len(self.f), "evaluatedGeometrySha256": digest.hexdigest(), "sourceMin": self.low, "sourceMax": self.high, "clientCenter": client((self.low+self.high)/2), "clientSize": (self.high-self.low)[[0, 2, 1]]}


def inside(geometry, point):
    for raw in [(0.731, 0.371, 0.573), (-0.431, 0.811, 0.391), (0.213, -0.579, 0.787)]:
        direction = Vector(raw).normalized()
        origin = point + direction * EPS
        winding = 0
        for _ in range(128):
            location, normal, index, distance = geometry.tree.ray_cast(origin, direction, 2000)
            if location is None:
                break
            facing = normal.dot(direction) * geometry.orientation
            if abs(facing) > 1e-6:
                winding += 1 if facing > 0 else -1
            origin = location + direction * EPS
        else:
            return False
        if winding <= 0:
            return False
    return True


def triangle_plane_cuts(triangle, distances, epsilon=1e-7):
    points = [triangle[index] for index in range(3) if abs(distances[index]) <= epsilon]
    for first, second in [(0, 1), (1, 2), (2, 0)]:
        if distances[first]*distances[second] < 0:
            points.append(triangle[first]+(triangle[second]-triangle[first])*(-distances[first])/(distances[second]-distances[first]))
    return np.asarray(points)


def horizontal_triangle_intersection(first, second, epsilon=1e-7):
    """Convex clipping only for the explicitly allowed horizontal bearing plane."""
    polygon = [point[:2].copy() for point in first]
    clipping = second[:, :2].copy()
    cross = lambda a, b: float(a[0]*b[1]-a[1]*b[0])
    if cross(clipping[1]-clipping[0], clipping[2]-clipping[0]) < 0:
        clipping = clipping[::-1]
    for edge_start, edge_end in zip(clipping, np.roll(clipping, -1, axis=0)):
        previous_polygon, polygon = polygon, []
        if not previous_polygon:
            break
        edge = edge_end-edge_start
        edge_length = max(float(np.linalg.norm(edge)), 1e-30)
        previous = previous_polygon[-1]
        previous_distance = cross(edge, previous-edge_start)/edge_length
        for current in previous_polygon:
            distance = cross(edge, current-edge_start)/edge_length
            if (distance >= -epsilon) != (previous_distance >= -epsilon):
                denominator = previous_distance-distance
                if abs(denominator) > 1e-15:
                    polygon.append(previous+(current-previous)*previous_distance/denominator)
            if distance >= -epsilon:
                polygon.append(current)
            previous, previous_distance = current, distance
    return np.asarray(polygon)


def bearing_contact(pair, sample, plane_z=25.45):
    """Accept only the two known opposing horizontal load-bearing ear faces.

    This is deliberately not a general surface-overlap exemption. Every BVH
    intersection must reduce to this source plane and the two measured ear
    sectors; an interior witness, same-facing face, or other contact rejects it.
    """
    a, b = pair.sleeve, pair.plate
    epsilon = 1e-4  # 0.1 micrometre numerical classification, not fit clearance.
    rejected, planar, boundary, maximum_deviation = [], 0, 0, 0.0
    areas = [0.0, 0.0]
    supporting_pairs = []
    # Blender's triangle intersection callback can omit exactly coplanar
    # interiors. Measure the actual opposing horizontal patches independently
    # instead of inventing area from the returned boundary intersections.
    def horizontal_faces(geometry, sign):
        z = geometry.v[:, 2][geometry.f]
        indices = np.flatnonzero(np.all(np.abs(z-plane_z) <= epsilon, axis=1))
        triangles = geometry.v[geometry.f[indices]]
        mask = np.any(np.all(np.abs(triangles[:, :, :2]-pair.center[:2]) <= 9.7, axis=2), axis=1)
        indices, triangles = indices[mask], triangles[mask]
        normals = np.cross(triangles[:, 1]-triangles[:, 0], triangles[:, 2]-triangles[:, 0])
        normals /= np.maximum(np.linalg.norm(normals, axis=1)[:, None], 1e-30)
        mask = normals[:, 2]*geometry.orientation*sign > .99999
        return indices[mask], triangles[mask]
    indices_a, floors_a = horizontal_faces(a, -1)
    indices_b, floors_b = horizontal_faces(b, 1)
    for ia, ta in zip(indices_a, floors_a):
        for ib, tb in zip(indices_b, floors_b):
            if np.any(ta[:, :2].max(axis=0) < tb[:, :2].min(axis=0)-epsilon) or np.any(tb[:, :2].max(axis=0) < ta[:, :2].min(axis=0)-epsilon):
                continue
            polygon = horizontal_triangle_intersection(ta, tb)
            if len(polygon) < 3:
                continue
            area = abs(float(np.sum(polygon[:, 0]*np.roll(polygon[:, 1], -1)-polygon[:, 1]*np.roll(polygon[:, 0], -1)))/2)
            if area < 1e-10:
                continue
            radius = np.linalg.norm(polygon-pair.center[:2], axis=1)
            angle = np.degrees(np.arctan2(polygon[:, 1]-pair.center[1], polygon[:, 0]-pair.center[0])) % 360
            sector = 0 if np.all((angle >= 35) & (angle <= 65)) else 1 if np.all((angle >= 215) & (angle <= 245)) else None
            if sector is not None and np.all(radius >= 6.8) and np.all(radius <= 9.6):
                areas[sector] += area
                supporting_pairs.append({"movingTriangle": int(ia), "fixedTriangle": int(ib), "sector": sector, "areaMm2": area, "polygonSourceXY": polygon})
    pairs = a.tree.overlap(b.tree)
    for ia, ib in pairs:
        ta, tb = a.v[a.f[ia]], b.v[b.f[ib]]
        na, nb = np.cross(ta[1]-ta[0], ta[2]-ta[0]), np.cross(tb[1]-tb[0], tb[2]-tb[0])
        na /= max(np.linalg.norm(na), 1e-30)
        nb /= max(np.linalg.norm(nb), 1e-30)
        da, db = (ta-tb[0]) @ nb, (tb-ta[0]) @ na
        horizontal = abs(na[2]) > .99999 and abs(nb[2]) > .99999
        coplanar = np.max(np.abs(da)) <= epsilon and np.max(np.abs(db)) <= epsilon
        area = 0.0
        if coplanar:
            drop = int(np.argmax(np.abs(na)))
            keep = [axis for axis in range(3) if axis != drop]
            polygon = horizontal_triangle_intersection(ta[:, keep], tb[:, keep], epsilon=epsilon)
            if len(polygon) < 1:
                rejected.append({"movingTriangle": ia, "fixedTriangle": ib, "reason": "unresolved coplanar triangle intersection"})
                continue
            points = np.zeros((len(polygon), 3))
            points[:, keep] = polygon
            points[:, drop] = ta[0, drop]-((polygon-ta[0, keep]) @ na[keep])/na[drop]
            if horizontal:
                if np.dot(na*a.orientation, nb*b.orientation) > -.9999:
                    rejected.append({"movingTriangle": ia, "fixedTriangle": ib, "reason": "horizontal bearing normals are not opposing"})
                    continue
                planar += 1
            else:
                boundary += 1
        else:
            direction = np.cross(na, nb)
            ca, cb = triangle_plane_cuts(ta, da, epsilon), triangle_plane_cuts(tb, db, epsilon)
            if np.linalg.norm(direction) < 1e-8 or len(ca) == 0 or len(cb) == 0:
                rejected.append({"movingTriangle": ia, "fixedTriangle": ib, "reason": "intersection is not the horizontal bearing boundary"})
                continue
            direction /= np.linalg.norm(direction)
            lo, hi = max((ca @ direction).min(), (cb @ direction).min()), min((ca @ direction).max(), (cb @ direction).max())
            if lo > hi+epsilon:
                # Float BVH may report touching triangles whose double-precision
                # intervals narrowly miss; retain their nearest endpoint pair.
                if lo-hi > epsilon:
                    rejected.append({"movingTriangle": ia, "fixedTriangle": ib, "reason": "unresolved triangle intersection"})
                    continue
            points = np.array([ca[0]+direction*(value-ca[0] @ direction) for value in [lo, hi]])
            boundary += 1
        deviation = float(np.max(np.abs(points[:, 2]-plane_z)))
        maximum_deviation = max(maximum_deviation, deviation)
        radius = np.linalg.norm(points[:, :2]-pair.center[:2], axis=1)
        angle = np.degrees(np.arctan2(points[:, 1]-pair.center[1], points[:, 0]-pair.center[0])) % 360
        sectors = ((angle >= 35) & (angle <= 65)) | ((angle >= 215) & (angle <= 245))
        if deviation > epsilon or np.any(radius < 6.8) or np.any(radius > 9.6) or not np.all(sectors):
            rejected.append({"movingTriangle": ia, "fixedTriangle": ib, "reason": "intersection escapes the two measured bearing patches", "points": points})
    valid = bool(pairs) and sample["strictInteriorSamples"] == 0 and not rejected and min(areas) > .01
    return {"status": "nominal-load-bearing-contact" if valid else "bearing-contact-unresolved", "sourcePlaneZ": plane_z, "sourceAxisCenterXY": pair.center[:2], "allowedRadialBandMm": [6.8, 9.6], "allowedAngularSectorsDeg": [[35, 65], [215, 245]], "numericPlaneToleranceMm": epsilon, "contactPairs": len(pairs), "opposingHorizontalPairs": len(supporting_pairs), "opposingHorizontalPairsReturnedByBvh": planar, "boundaryPairs": boundary, "maximumIntersectionPlaneDeviationMm": maximum_deviation, "bearingPatchAreasMm2": areas, "supportingTrianglePairs": supporting_pairs, "strictInteriorSamples": sample["strictInteriorSamples"], "rejectedPairCount": len(rejected), "rejectedPairs": rejected[:12], "manufacturingLimit": "Zero nominal separation is intentional only on these supporting faces. This does not waive sliding-wall clearance or certify printed tolerance, contact force or wear."}


class Pair:
    def __init__(self, sleeve, plate, axis_center):
        self.sleeve, self.plate = sleeve, plate
        self.center = np.asarray(axis_center, dtype=np.float64)
        self.cache = {}

    def check(self, angle, offset, detail=False):
        key = (round(float(angle), 7), round(float(offset), 7), detail)
        if key in self.cache:
            return self.cache[key]
        # sleeve world pose: Rz(angle)*(p-center)+center+(0,0,offset).
        # Apply its inverse to the plate, keeping the original sleeve BVH.
        inverse = len(self.sleeve.f) >= len(self.plate.f)
        radians = math.radians(-angle if inverse else angle)
        rotation = np.array([[math.cos(radians), -math.sin(radians), 0], [math.sin(radians), math.cos(radians), 0], [0, 0, 1]])
        vertices = (self.plate.v-self.center-[0, 0, offset]) @ rotation.T+self.center if inverse else (self.sleeve.v-self.center) @ rotation.T+self.center+[0, 0, offset]
        fixed = self.sleeve if inverse else self.plate
        result = {"angleDeg": float(angle), "axialOffsetMm": float(offset), "surfaceTrianglePairs": 0, "strictInteriorSamples": 0, "witnessCoordinates": "moving-part-rest-source" if inverse else "source-world"}
        if np.any(vertices.max(axis=0) < fixed.low-EPS) or np.any(vertices.min(axis=0) > fixed.high+EPS):
            result["status"] = "disjoint-bounds"
            self.cache[key] = result
            return result
        moved = Geometry(self.plate.name if inverse else self.sleeve.name, vertices, self.plate.f if inverse else self.sleeve.f)
        a, b = (self.sleeve, moved) if inverse else (moved, self.plate)
        pairs = a.tree.overlap(b.tree)
        result["surfaceTrianglePairs"] = len(pairs)
        result["status"] = "surface-contact-or-crossing" if pairs else "no-intersection-found"
        if detail:
            examples = []
            distances = []
            if pairs:
                indices_a = np.array([pair[0] for pair in pairs], dtype=int)
                indices_b = np.array([pair[1] for pair in pairs], dtype=int)
                result["movingSurfaceTriangleIndices"] = np.unique(indices_a).tolist()
                result["fixedSurfaceTriangleIndices"] = np.unique(indices_b).tolist()
                triangles_a, triangles_b = a.v[a.f[indices_a]], b.v[b.f[indices_b]]
                normals_a = np.cross(triangles_a[:, 1]-triangles_a[:, 0], triangles_a[:, 2]-triangles_a[:, 0])
                normals_b = np.cross(triangles_b[:, 1]-triangles_b[:, 0], triangles_b[:, 2]-triangles_b[:, 0])
                normals_a /= np.maximum(np.linalg.norm(normals_a, axis=1)[:, None], 1e-30)
                normals_b /= np.maximum(np.linalg.norm(normals_b, axis=1)[:, None], 1e-30)
                distances_ba = np.einsum("nvi,ni->nv", triangles_b-triangles_a[:, :1], normals_a)
                distances_ab = np.einsum("nvi,ni->nv", triangles_a-triangles_b[:, :1], normals_b)
                coplanar = np.all(np.abs(distances_ba) <= EPS, axis=1) & np.all(np.abs(distances_ab) <= EPS, axis=1)
                straddling = (distances_ba.min(axis=1) < -EPS) & (distances_ba.max(axis=1) > EPS) & (distances_ab.min(axis=1) < -EPS) & (distances_ab.max(axis=1) > EPS)
                result["coplanarTrianglePairs"] = int(coplanar.sum())
                result["strictPlaneStraddlePairs"] = int(straddling.sum())
                result["boundaryOnlyTrianglePairs"] = int((~coplanar & ~straddling).sum())
            for source, target, side in [(b, a, "plate-in-sleeve"), (a, b, "sleeve-in-plate")]:
                if pairs:
                    selected = np.array([pair[1 if side == "plate-in-sleeve" else 0] for pair in pairs], dtype=int)
                    indices = np.unique(source.f[selected])
                else:
                    indices = np.flatnonzero(np.all(source.v >= target.low-EPS, axis=1) & np.all(source.v <= target.high+EPS, axis=1))
                if len(indices) > 512:
                    indices = indices[np.linspace(0, len(indices)-1, 512, dtype=int)]
                for index in indices:
                    point = Vector(source.v[index])
                    location, normal, face, distance = target.tree.find_nearest(point)
                    if location is not None:
                        distances.append(float(distance))
                    if location is not None and distance > EPS and (point-location).dot(normal)*target.orientation < -EPS and inside(target, point):
                        result["strictInteriorSamples"] += 1
                        if len(examples) < 12:
                            examples.append({"side": side, "point": list(point), "depthMm": distance, "sourceVertexIndex": int(index), "targetTriangleIndex": int(face)})
            result["penetrationExamples"] = examples
            result["minimumSampledSurfaceDistanceMm"] = min(distances, default=None)
            if result["strictInteriorSamples"]:
                result["status"] = "penetration-evidence"
            if pairs:
                selected = np.unique(a.f[np.array([pair[0] for pair in pairs], dtype=int)])
                region = a.v[selected]
                result["crossingRegion"] = {"min": region.min(axis=0), "max": region.max(axis=0)}
        self.cache[key] = result
        return result


def verify_path(pair, entry_angle, seated_offset, step=.1, angle_step=1):
    start_offset = math.ceil((pair.plate.high[2]-pair.sleeve.low[2]+.25)*10)/10
    maximum_radius = float(np.linalg.norm(pair.sleeve.v[:, :2]-pair.center[:2], axis=1).max())
    turn_step = min(angle_step, math.degrees(.1/maximum_radius))
    samples = []
    for offset in np.linspace(start_offset, seated_offset, math.ceil(abs(start_offset-seated_offset)/step)+1):
        samples.append({"stage": "insert", **pair.check(entry_angle, float(offset), detail=True)})
    for angle in np.linspace(entry_angle, 0, math.ceil(abs(entry_angle)/turn_step)+1):
        samples.append({"stage": "lock", **pair.check(float(angle), seated_offset, detail=True)})
    for offset in np.linspace(seated_offset, 0, math.ceil(abs(seated_offset)/step)+1):
        samples.append({"stage": "release-to-locked-rest", **pair.check(0, float(offset), detail=True)})
    blocked = [sample for sample in samples if sample["surfaceTrianglePairs"] or sample["strictInteriorSamples"]]
    retention_samples = [pair.check(0, .5, detail=True)]
    if not retention_samples[0]["strictInteriorSamples"]:
        for offset in np.linspace(.1, start_offset, math.ceil(start_offset/.1)):
            retention_samples.append(pair.check(0, float(offset), detail=True))
            if retention_samples[-1]["strictInteriorSamples"]:
                break
    retained = next((sample for sample in retention_samples if sample["strictInteriorSamples"]), None)
    retention_status = "retained-by-source-geometry" if retained else "surface-contact-unresolved" if any(sample["surfaceTrianglePairs"] for sample in retention_samples) else "no-retention-observed"
    return {"entryAngleDeg": entry_angle, "lockedAngleDeg": 0, "lockRotationDeg": -entry_angle, "startAxialOffsetMm": start_offset, "insertionDistanceMm": start_offset-seated_offset, "seatedAxialOffsetMm": seated_offset, "lockedRestAxialOffsetMm": 0, "maximumAxialSampleStepMm": step, "maximumAngularSampleStepDeg": turn_step, "maximumSampledVertexTravelMm": .1, "maximumSleeveRadiusMm": maximum_radius, "status": "sampled-path-clear" if not blocked else "path-blocked", "samples": samples, "blockedSampleCount": len(blocked), "reverseRemoval": {"status": "sampled-path-clear" if not blocked else "path-blocked", "samples": [{**sample, "stage": {"insert": "withdraw", "lock": "unlock", "release-to-locked-rest": "depress-to-unlock"}[sample["stage"]]} for sample in reversed(samples)], "method": "The exact rigid poses in reverse order: depress from rest to seated offset, unlock 0 to entry angle at that depth, then withdraw to start offset. No friction, latch deformation, or force reversibility is inferred."}, "retention": {"status": retention_status, "samples": retention_samples}, "retentionProbe": retained or retention_samples[0]}


def audit_confirm_installation(output):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    files = ["buttons/confirm.blend", "housing/top.blend", "housing/bottom.blend"]
    hashes = {path: sha(SOURCE/path) for path in files}
    cap = load_named(files[0], "确认 · 键帽")
    seat = load_named(files[0], "旋锁座")
    switch = load_named(files[0], "常开开关")
    center = (switch.low+switch.high)/2
    report = {"schema": 1, "sourceHashes": hashes, "coordinates": "Source mm/Z-up; all offsets are source Z, all angles around source +Z", "scope": "Actual confirm cap/seat against each actual housing mesh; directional retention exploration, not a closed-housing assembly path assertion.", "checks": []}
    for path, token in [(files[1], "按键区圆滑过渡上壳"), (files[2], "底壳 · 合壳")]:
        housing = load_named(path, token)
        for moving in [seat, cap]:
            pair = Pair(moving, housing, center)
            item = {"moving": moving.report(), "fixed": housing.report(), "assemblyPose": pair.check(0, 0, detail=True), "axialSamples": [], "angularSamples": []}
            print("CONFIRM_PAIR", moving.name, housing.name, json.dumps(item["assemblyPose"], default=clean), flush=True)
            for offset in np.arange(-5, 10.01, .25):
                sample = pair.check(0, float(offset), detail=True)
                item["axialSamples"].append(sample)
                print("CONFIRM_AXIAL", moving.name, housing.name, round(float(offset), 2), sample["status"], sample["surfaceTrianglePairs"], sample["strictInteriorSamples"], flush=True)
            if moving is seat:
                for angle in np.arange(-180, 180.1, 5):
                    item["angularSamples"].append(pair.check(float(angle), 0, detail=True))
            report["checks"].append(item)
            Path(output).write_text(json.dumps(report, indent=2, ensure_ascii=False, default=clean)+"\n")
        del housing, pair
        gc.collect()
    report["sourceFilesUnchanged"] = all(sha(SOURCE/path) == digest for path, digest in hashes.items())
    Path(output).write_text(json.dumps(report, indent=2, ensure_ascii=False, default=clean)+"\n")


def check_pose_sequence(pair, poses, allow_bearing=False):
    samples = []
    previous_stage = None
    for stage, angle, offset in poses:
        if stage != previous_stage:
            print("PATH_STAGE", pair.sleeve.name, "against", pair.plate.name, stage, flush=True)
            previous_stage = stage
        sample = {"stage": stage, **pair.check(angle, offset, detail=True)}
        if allow_bearing and abs(angle) < 1e-7 and abs(offset) < 1e-7 and sample["surfaceTrianglePairs"]:
            sample["bearingContact"] = bearing_contact(pair, sample)
            if sample["bearingContact"]["status"] == "nominal-load-bearing-contact":
                sample["status"] = "nominal-load-bearing-contact"
        samples.append(sample)
    blocked = [sample for sample in samples if sample["strictInteriorSamples"] or (sample["surfaceTrianglePairs"] and sample["status"] != "nominal-load-bearing-contact")]
    return {"status": "sampled-path-clear" if not blocked else "path-blocked", "samples": samples, "blockedSampleCount": len(blocked), "maximumSampledVertexTravelMm": .1}


def audit_confirm_mount(turn_offset, confirm_file="buttons/confirm.blend", top_file="housing/top.blend"):
    """The seat locks to the upper housing; the cap is a separate sliding guide."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    source_hash, top_hash = sha(SOURCE/confirm_file), sha(SOURCE/top_file)
    cap = load_named(confirm_file, "确认 · 键帽")
    seat = load_named(confirm_file, "旋锁座")
    switch = load_named(confirm_file, "常开开关")
    spring = load_named(confirm_file, "回弹压簧")
    upper = load_named(top_file, "按键区圆滑过渡上壳")
    center = (switch.low+switch.high)/2
    mount = Pair(seat, upper, center)
    cap_upper = Pair(cap, upper, center)
    cap_seat = Pair(cap, seat, center)
    seat_cap = Pair(seat, cap, center)
    radius = float(np.linalg.norm(seat.v[:, :2]-center[:2], axis=1).max())
    angle_step = min(1, math.degrees(.1/radius))
    start = math.floor((upper.low[2]-seat.high[2]-.25)*10)/10
    cap_start = math.floor((upper.low[2]-cap.high[2]-.25)*10)/10
    poses = [("insert-seat-from-below", 30, float(offset)) for offset in np.linspace(start, turn_offset, math.ceil((turn_offset-start)/.1)+1)]
    poses += [("rotate-seat-to-lock", float(angle), turn_offset) for angle in np.linspace(30, 0, math.ceil(30/angle_step)+1)]
    poses += [("settle-seat-on-bearing", 0, float(offset)) for offset in np.linspace(turn_offset, 0, math.ceil(turn_offset/.1)+1)]
    path = check_pose_sequence(mount, poses, allow_bearing=True)
    path.update({"entryAngleDeg": 30, "lockedAngleDeg": 0, "lockRotationDeg": -30, "startAxialOffsetMm": start, "insertionDistanceMm": turn_offset-start, "seatedAxialOffsetMm": turn_offset, "lockedRestAxialOffsetMm": 0, "maximumAxialSampleStepMm": .1, "maximumAngularSampleStepDeg": angle_step, "maximumSleeveRadiusMm": radius})
    path["reverseRemoval"] = {"status": path["status"], "maximumSampledVertexTravelMm": .1, "samples": [{**sample, "stage": "reverse-"+sample["stage"]} for sample in reversed(path["samples"])], "method": "Exact rigid poses in reverse, with the upper housing open and other fitted contents removed; does not claim removal from the closed controller."}
    path["retentionProbe"] = mount.check(0, -.05, detail=True)
    path["retention"] = {"status": "retained-by-source-geometry" if path["retentionProbe"]["strictInteriorSamples"] else "retention-not-proven", "directionSource": [0, 0, -1]}
    cap_poses = [("insert-cap-from-upper-housing-interior", 0, float(offset)) for offset in np.linspace(cap_start, 0, math.ceil(-cap_start/.1)+1)]
    cap_path = check_pose_sequence(cap_upper, cap_poses)
    cap_path["retentionProbe"] = cap_upper.check(0, .25, detail=True)
    cap_path["retention"] = {"status": "retained-by-source-geometry" if cap_path["retentionProbe"]["strictInteriorSamples"] else "retention-not-proven", "directionSource": [0, 0, 1]}
    guide = check_pose_sequence(cap_seat, [("press-guide", 0, -float(distance)) for distance in np.linspace(0, 1, 11)])
    internal_mount = check_pose_sequence(seat_cap, poses)
    free_length = float(spring.high[2]-spring.low[2])
    spring_check = {"freeLengthMm": free_length, "declaredConservativeSolidLengthMm": 1.75, "maximumAssemblyCompressionMm": turn_offset, "remainingLengthMm": free_length-turn_offset, "status": "within-declared-length-limit" if 0 <= turn_offset <= free_length-1.75 else "solid-length-limit-exceeded", "basis": "Source spring axial bounds; 1.75 mm conservative declared solid length shared with the confirm press profile. No friction, coil stress, force or fatigue is inferred."}
    clearance = {"status": "not-reported"}
    repair_path = ROOT / "docs/puretv-geometry-confirm-mount-repair.json"
    if repair_path.exists():
        repair = json.loads(repair_path.read_text())
        source_rows = repair.get("sources", [])
        if len(source_rows) == 2 and source_rows[0].get("sha256After") == source_hash and source_rows[1].get("sha256After") == top_hash:
            witnesses = repair.get("lateralDistanceWitnesses", [])
            clearance = {"status": "sampled-distance-evidence", "sourceReport": "docs/puretv-geometry-confirm-mount-repair.json", "sourceReportSha256": sha(repair_path), "nominalSlidingClearanceGoalMm": .3, "minimumWitnessDistanceMm": min((witness["distanceMm"] for witness in witnesses), default=None), "witnesses": witnesses, "limitation": "These nearest-surface witness distances are upper bounds on the global minimum; they are not a positive-clearance or manufacturing-tolerance certificate."}
    valid = path["status"] == "sampled-path-clear" and path["retention"]["status"] == "retained-by-source-geometry" and cap_path["status"] == "sampled-path-clear" and cap_path["retention"]["status"] == "retained-by-source-geometry" and guide["status"] == "sampled-path-clear" and internal_mount["status"] == "sampled-path-clear" and spring_check["status"] == "within-declared-length-limit"
    unchanged = sha(SOURCE/confirm_file) == source_hash and sha(SOURCE/top_file) == top_hash
    return {"key": "confirm", "sourceFile": confirm_file, "sourceSha256": source_hash, "plateFile": top_file, "plateSha256": top_hash, "status": "invalidated-source-changed" if not unchanged else "sampled-path-clear" if valid else "installation-not-verified", "interface": "confirm seat to upper-housing lock; cap to seat is a sliding press guide", "scope": "Install the cap through the open upper-housing interior, fit the spring and seat, insert and turn the seat into its actual upper-housing lock, then fit other internals and close the lower housing. Pair paths include seat against the cap; they do not certify closed-housing service access, wire routing, friction or force.", "sourceObjects": [seat.report(), upper.report(), cap.report(), spring.report()], "axisCenterSourceXY": center[:2], "assemblyPose": path["samples"][-1], "path": path, "installation": {"capUpperHousing": cap_path, "capToSeatPressGuide": guide, "seatAgainstCapDuringMount": internal_mount, "springAssembly": spring_check, "slidingClearance": clearance}, "sourceFilesUnchanged": unchanged}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", action="append")
    parser.add_argument("--output", default=str(ROOT / "docs/puretv-geometry-locks.json"))
    parser.add_argument("--angle-step", type=float, default=5)
    parser.add_argument("--angle-min", type=float, default=0)
    parser.add_argument("--angle-max", type=float, default=120)
    parser.add_argument("--offset-step", type=float, default=.5)
    parser.add_argument("--offset-min", type=float, default=-5)
    parser.add_argument("--offset-max", type=float, default=5)
    parser.add_argument("--pose", action="append", help="Additional detailed angle:offset pose")
    parser.add_argument("--path-entry", type=float, help="Verify an observed entrance angle with <=0.1 mm vertex-travel samples")
    parser.add_argument("--seated-offset", type=float, default=0)
    parser.add_argument("--path-only", action="store_true")
    parser.add_argument("--plan", action="append", help="Per-key override key:entry-angle:seated-offset")
    parser.add_argument("--confirm-installation", action="store_true")
    parser.add_argument("--confirm-mount-path", action="store_true")
    parser.add_argument("--confirm-guide-exploration", action="store_true", help="Explore the cap/seat sliding guide instead of the actual seat/upper-housing lock")
    parser.add_argument("--confirm-turn-offset", type=float, default=1.0)
    parser.add_argument("--confirm-source", default="buttons/confirm.blend")
    parser.add_argument("--top-source", default="housing/top.blend")
    args = parser.parse_args(sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else [])
    if args.confirm_installation:
        audit_confirm_installation(args.output)
        return
    if args.confirm_mount_path:
        result = audit_confirm_mount(args.confirm_turn_offset, args.confirm_source, args.top_source)
        Path(args.output).write_text(json.dumps(result, indent=2, ensure_ascii=False, default=clean)+"\n")
        print("CONFIRM_MOUNT", result["status"], result["path"]["blockedSampleCount"], flush=True)
        return
    if args.angle_step <= 0 or args.offset_step <= 0:
        raise ValueError("Sampling increments must be positive")
    plans = {}
    for raw in args.plan or []:
        key, angle, offset = raw.split(":")
        plans[key] = (float(angle), float(offset))
    report = {"schema": 1, "blender": bpy.app.version_string, "auditorScriptSha256": sha(Path(__file__)), "coordinates": "Source mm/Z-up; client (x,y,z)=(source.x,source.z,-source.y). Positive angle is source +Z/client +Y; positive offset moves the sleeve upward.", "method": "Unsimplified evaluated source mesh BVH triangle overlap; actual baseplate inverse-transformed against the full sleeve, followed by bounded three-ray winding containment witnesses. No parameterized mating proxy is used.", "limitations": ["Discrete samples are not continuous collision detection or manufacturing certification.", "Surface overlap may include touching; strict winding interior witnesses establish penetration where reported.", "No elastic pad deformation, friction, printed tolerances, or assembly force is certified.", "This is an isolated mating pair audit before upper-housing installation, not a closed-housing maintenance or all-component sweep clearance claim."], "buttons": []}
    hashes = {}
    for key in args.only or ["left", "right", "up", "down", "a", "b", "x", "y", "confirm"]:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        relative = f"buttons/{key}.blend"
        source_sha = sha(SOURCE/relative)
        if key == "confirm" and not args.confirm_guide_exploration:
            item = audit_confirm_mount(args.confirm_turn_offset, args.confirm_source, args.top_source)
            report["buttons"].append(item)
            hashes[item["sourceFile"]], hashes[item["plateFile"]] = item["sourceSha256"], item["plateSha256"]
            Path(args.output).write_text(json.dumps(report, indent=2, ensure_ascii=False, default=clean)+"\n")
            print("CONFIRM_MOUNT", item["status"], item["path"]["blockedSampleCount"], flush=True)
            continue
        plate_file = relative if key == "confirm" else "baseplates/"+("dpad" if key in ["left", "right", "up", "down"] else "abxy")+".blend"
        plate_sha = sha(SOURCE/plate_file)
        hashes[relative], hashes[plate_file] = source_sha, plate_sha
        sleeve = load_named(relative, "确认 · 键帽" if key == "confirm" else "下环一体式开关套筒")
        plate = load_named(plate_file, "旋锁座" if key == "confirm" else "中央走线方形底座")
        switch = load_named(relative, "常开开关" if key == "confirm" else "6×6 开关")
        pair = Pair(sleeve, plate, (switch.low+switch.high)/2)
        item = {"key": key, "sourceFile": relative, "sourceSha256": source_sha, "plateFile": plate_file, "plateSha256": plate_sha, "scope": "Pairwise rigid assembly before installing the upper housing; other key internals, housing, wires and screws are not part of this lock-interface path audit.", "sourceObjects": [sleeve.report(), plate.report()], "axisCenterSourceXY": pair.center[:2], "status": "exploration-incomplete", "assemblyPose": pair.check(0, 0, detail=True), "exploration": {"angleStepDeg": args.angle_step, "offsetStepMm": args.offset_step, "samples": []}}
        print("ASSEMBLY", key, json.dumps(item["assemblyPose"], default=clean), flush=True)
        for offset in [] if args.path_only else np.arange(args.offset_min, args.offset_max+args.offset_step/2, args.offset_step):
            row = []
            for angle in np.arange(args.angle_min, args.angle_max+args.angle_step/2, args.angle_step):
                value = pair.check(float(angle), float(offset))
                item["exploration"]["samples"].append(value)
                if value["surfaceTrianglePairs"] == 0:
                    row.append(round(float(angle), 4))
            print("GRID", key, round(float(offset), 4), "clearAngles", row, flush=True)
        item["additionalPoses"] = [pair.check(*map(float, value.split(":")), detail=True) for value in args.pose or []]
        item["status"] = "path-not-verified"
        entry_angle, seated_offset = plans.get(key, (args.path_entry, args.seated_offset))
        if entry_angle is not None:
            item["path"] = verify_path(pair, entry_angle, seated_offset)
            item["status"] = item["path"]["status"]
            if item["status"] == "sampled-path-clear" and item["path"]["retention"]["status"] != "retained-by-source-geometry":
                item["status"] = item["path"]["retention"]["status"]
            print("PATH", key, item["status"], "blocked", item["path"]["blockedSampleCount"], flush=True)
        report["buttons"].append(item)
        if sha(SOURCE/relative) != source_sha or sha(SOURCE/plate_file) != plate_sha:
            raise RuntimeError("Source changed during read-only audit; rerun against stable sources")
        Path(args.output).write_text(json.dumps(report, indent=2, ensure_ascii=False, default=clean)+"\n")
        del pair, sleeve, plate
        bpy.ops.wm.read_factory_settings(use_empty=True)
        gc.collect()
    changed = [relative for relative, digest in hashes.items() if sha(SOURCE/relative) != digest]
    report["sourceFilesUnchanged"] = not changed
    report["sourceFilesChangedDuringAudit"] = changed
    report["summary"] = {"auditedKeys": len(report["buttons"]), "pathClearAndRetainedKeys": sum(item["status"] == "sampled-path-clear" for item in report["buttons"]), "status": "invalidated-source-changed" if changed else "sampled-paths-clear" if len(report["buttons"]) == 9 and all(item["status"] == "sampled-path-clear" for item in report["buttons"]) else "incomplete-or-failed"}
    Path(args.output).write_text(json.dumps(report, indent=2, ensure_ascii=False, default=clean)+"\n")
    print("AUDIT_WRITTEN", args.output, flush=True)


if __name__ == "__main__":
    main()
