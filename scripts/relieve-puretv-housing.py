"""Locally relieve lateral upper-shell sliding walls without moving axial stops.

Default writes a candidate .blend in scratch. --apply writes housing/top.blend.
The source manifest is deliberately not modified by this script.
"""
import argparse
import bpy
import hashlib
import json
import shutil
import sys
import numpy as np
from pathlib import Path
from mathutils import Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/puretv-controller'
TARGET = SOURCE / 'housing/top.blend'
SCRATCH = ROOT.parent / 'scratch'
GOAL = .37  # 0.30 mm target plus source polygon interpolation reserve.
STROKES = [0, .25, .5, .75, 1]
parser = argparse.ArgumentParser()
parser.add_argument('--apply', action='store_true')
args = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])


def mesh_arrays(obj):
    graph = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(graph), depsgraph=graph)
    mesh.calc_loop_triangles()
    v = np.empty(len(mesh.vertices)*3); mesh.vertices.foreach_get('co', v); v = v.reshape((-1, 3))
    matrix = np.array(obj.matrix_world)
    world = v @ matrix[:3, :3].T + matrix[:3, 3]
    t = np.empty(len(mesh.loop_triangles)*3, dtype=np.int32); mesh.loop_triangles.foreach_get('vertices', t); t = t.reshape((-1, 3))
    bpy.data.meshes.remove(mesh)
    return world, t


def normals(v, t):
    points = v[t]
    n = np.cross(points[:, 1]-points[:, 0], points[:, 2]-points[:, 0])
    lengths = np.linalg.norm(n, axis=1)
    return n/np.maximum(lengths[:, None], 1e-30), lengths


def tree(v, t):
    return BVHTree.FromPolygons(v.tolist(), t.tolist(), all_triangles=True, epsilon=0)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sampled_clearances(shell_tree, caps):
    result = []
    for cap in caps:
        side, axial, collisions = None, None, []
        for stroke in STROKES:
            moving = cap['vertices']-[0, 0, stroke]
            pairs = tree(moving, cap['triangles']).overlap(shell_tree)
            if pairs: collisions.append({'stroke': stroke, 'trianglePairs': len(pairs)})
            for point in np.concatenate([moving, moving[cap['triangles']].mean(axis=1)]):
                hit = shell_tree.find_nearest(Vector(point))
                if hit[0] is None: continue
                delta = np.array(hit[0])-point
                ratio = abs(delta[2])/max(float(hit[3]), 1e-12)
                record = {'distanceMm': float(hit[3]), 'strokeMm': stroke, 'movingClient': [float(point[0]), float(point[2]), float(-point[1])], 'shellClient': [float(hit[0].x), float(hit[0].z), float(-hit[0].y)], 'shellNormalClient': [float(hit[1].x), float(hit[1].z), float(-hit[1].y)], 'shellTriangle': int(hit[2]), 'axialDistanceFraction': ratio}
                if abs(hit[1].z) < .3 and ratio < .3 and (side is None or hit[3] < side['distanceMm']): side = record
                if abs(hit[1].z) > .9 and ratio > .9 and (axial is None or hit[3] < axial['distanceMm']): axial = record
        result.append({'key': cap['key'], 'sourceName': cap['name'], 'lateralWitness': side, 'axialStopWitness': axial, 'surfaceIntersections': collisions})
    return result


bpy.ops.wm.read_factory_settings(use_empty=True)
manifest = json.loads((SOURCE/'manifest.json').read_text())
caps = []
for entry in manifest['assets']:
    if not entry['file'].startswith('buttons/'): continue
    name = next(o['exported'] for o in entry['objects'] if '键帽' in o['exported'] and '标识' not in o['exported'])
    path = SOURCE/entry['file']
    with bpy.data.libraries.load(str(path), link=False) as (available, loaded): loaded.objects = [name]
    obj = loaded.objects[0]; bpy.context.scene.collection.objects.link(obj); bpy.context.view_layer.update()
    v, t = mesh_arrays(obj)
    points = v[t]
    volume = float(np.sum(np.einsum('ij,ij->i', points[:, 0], np.cross(points[:, 1], points[:, 2])))/6)
    if volume < 0: t = t[:, [0, 2, 1]]
    n, _ = normals(v, t)
    caps.append({'key': Path(entry['file']).stem, 'name': name, 'sha256': digest(path), 'vertices': v, 'triangles': t, 'sideTree': tree(v, t[np.abs(n[:, 2]) < .5])})
    bpy.data.objects.remove(obj, do_unlink=True)

baseline_hash = digest(TARGET)
backup = SCRATCH / 'puretv-top-before-relief.blend'
if not backup.exists(): shutil.copy2(TARGET, backup)
if digest(backup) != baseline_hash: raise RuntimeError('Existing backup differs; do not apply twice without reviewing it.')
bpy.ops.wm.open_mainfile(filepath=str(TARGET))
for collection in list(bpy.data.collections):
    if collection.name.startswith('pureTV') and collection.name not in bpy.context.scene.collection.children:
        bpy.context.scene.collection.children.link(collection)
bpy.context.view_layer.update()
obj = bpy.data.objects.get('pureTV · 按键区圆滑过渡上壳.002')
if obj is None or obj.modifiers: raise RuntimeError('Expected named, modifier-free source shell.')
v, triangles = mesh_arrays(obj)
before_normals, before_areas = normals(v, triangles)
polygon_normals_before = np.empty(len(obj.data.polygons)*3)
obj.data.polygons.foreach_get('normal', polygon_normals_before)
polygon_normals_before = polygon_normals_before.reshape((-1, 3))
eligible = np.zeros(len(v), dtype=bool)
eligible[np.unique(triangles[np.abs(before_normals[:, 2]) < .3])] = True
before = sampled_clearances(tree(v, triangles), caps)
if any(record['surfaceIntersections'] for record in before):
    raise RuntimeError('Baseline source transform or geometry differs from the original no-intersection housing audit.')
current = v.copy()
edges = np.empty(len(obj.data.edges)*2, dtype=np.int32)
obj.data.edges.foreach_get('vertices', edges); edges = edges.reshape((-1, 2))
degree = np.bincount(edges.ravel(), minlength=len(v))
iterations = []
for iteration in range(24):
    changed, maximum = 0, 0.0
    for cap in caps:
        low = cap['vertices'].min(axis=0)-[.55, .55, 1.05]
        high = cap['vertices'].max(axis=0)+[.55, .55, .05]
        indices = np.flatnonzero(eligible & np.all(current >= low, axis=1) & np.all(current <= high, axis=1))
        for index in indices:
            for stroke in STROKES:
                point = current[index]
                hit = cap['sideTree'].find_nearest(Vector(point+[0, 0, stroke]), GOAL)
                if hit[0] is None or hit[3] >= GOAL-1e-6: continue
                delta = point-(np.array(hit[0])-[0, 0, stroke])
                horizontal = np.linalg.norm(delta[:2])
                if np.dot(delta[:2], np.array(hit[1])[:2]) <= 0: continue
                # Axial edge/retaining contacts are not sliding-wall defects.
                if horizontal < 1e-8 or abs(delta[2])/max(hit[3], 1e-12) >= .4: continue
                required = np.sqrt(max(0, GOAL*GOAL-delta[2]*delta[2]))-horizontal
                if required <= 1e-6: continue
                move = delta[:2]/horizontal*required
                current[index, :2] += move
                changed += 1; maximum = max(maximum, float(np.linalg.norm(move)))
    # Spread horizontal relief smoothly over adjacent vertices. A hard selection
    # boundary on micrometre source quads can invert faces even for a small move.
    displacement_field = current-v
    for _ in range(5):
        average = np.zeros_like(displacement_field)
        for coordinate in [0, 1]:
            total = np.bincount(edges[:, 0], weights=displacement_field[edges[:, 1], coordinate], minlength=len(v)) + np.bincount(edges[:, 1], weights=displacement_field[edges[:, 0], coordinate], minlength=len(v))
            average[:, coordinate] = total/np.maximum(1, degree)
        displacement_field = .5*displacement_field+.5*average
    current = v+displacement_field
    iterations.append({'iteration': iteration+1, 'vertexUpdates': changed, 'maxIncrementMm': maximum})
    print('RELIEF', iterations[-1], flush=True)
    if changed == 0: break

displacement = np.linalg.norm(current-v, axis=1)
inverse = np.linalg.inv(np.array(obj.matrix_world))
local_repairs = []
for repair_iteration in range(12):
    local = current @ inverse[:3, :3].T + inverse[:3, 3]
    obj.data.vertices.foreach_set('co', local.ravel()); obj.data.update()
    bpy.context.view_layer.update()
    polygon_normals = np.empty(len(obj.data.polygons)*3)
    obj.data.polygons.foreach_get('normal', polygon_normals)
    polygon_normals = polygon_normals.reshape((-1, 3))
    inverted = np.flatnonzero(np.sum(polygon_normals_before*polygon_normals, axis=1) < -1e-6)
    if not len(inverted): break
    affected = np.unique(np.concatenate([np.array(obj.data.polygons[int(index)].vertices) for index in inverted]))
    local_repairs.append({'iteration': repair_iteration+1, 'invertedPolygons': len(inverted), 'verticesBacktracked': len(affected)})
    # Backtrack only the tiny residual bad polygons, then re-evaluate all neighbors.
    current[affected] = v[affected]+.5*(current[affected]-v[affected])
# Moving polygon corners changes valid tessellation of concave source quads.
# Re-evaluate Blender's actual tessellation instead of reusing stale triangles.
actual, after_triangles = mesh_arrays(obj)
after_normals, after_areas = normals(actual, after_triangles)
polygon_normals_after = np.empty(len(obj.data.polygons)*3)
obj.data.polygons.foreach_get('normal', polygon_normals_after)
polygon_normals_after = polygon_normals_after.reshape((-1, 3))
flipped = np.flatnonzero(np.sum(polygon_normals_before*polygon_normals_after, axis=1) < -1e-6)
collapsed = np.flatnonzero(after_areas < 1e-10)
after = sampled_clearances(tree(actual, after_triangles), caps)
before_tree, after_tree = tree(v, triangles), tree(actual, after_triangles)
stops = []
for cap in caps:
    original_hits, retained_hits, distances = 0, 0, []
    for point in np.concatenate([cap['vertices'], cap['vertices'][cap['triangles']].mean(axis=1)]):
        origin = Vector(point)+Vector((0, 0, 1e-5))
        old = before_tree.ray_cast(origin, Vector((0, 0, 1)), .4)
        if old[0] is None or old[1].z > -.7: continue
        original_hits += 1
        hit = after_tree.ray_cast(origin, Vector((0, 0, 1)), .6)
        if hit[0] is not None and hit[1].z < -.5:
            retained_hits += 1; distances.append(float(hit[3]))
    stops.append({'key': cap['key'], 'restingSourceSamplesWithUpperStopBefore': original_hits, 'retainedUpperStopSamplesAfter': retained_hits, 'afterMinAxialRayMm': min(distances) if distances else None, 'afterMaxAxialRayMm': max(distances) if distances else None})
edge_indices = np.empty(len(obj.data.loops), dtype=np.int32)
obj.data.loops.foreach_get('edge_index', edge_indices)
incidence = np.bincount(edge_indices, minlength=len(obj.data.edges))
record = {
    'method': 'XY-only displacement of vertices incident to source shell side faces abs(normalZ)<0.3. Nearest lateral keycap triangles over five source stroke poses guide local relief; axial contacts excluded. No topology or cap geometry changed.',
    'nominalLateralGoalMm': .30, 'constructionTargetMm': GOAL,
    'sourceName': obj.name, 'sourceSha256Before': baseline_hash,
    'sourceKeyHashes': {cap['key']: cap['sha256'] for cap in caps},
    'vertices': len(v), 'sourceTriangles': len(triangles),
    'movedVertices': int(np.count_nonzero(np.linalg.norm(actual-v, axis=1) > 1e-7)), 'maxDisplacementMm': float(np.linalg.norm(actual-v, axis=1).max()),
    'maxAxialCoordinateChangeMm': float(np.max(np.abs(actual[:, 2]-v[:, 2]))),
    'normalFlippedSourcePolygons': len(flipped), 'collapsedTriangles': len(collapsed), 'trianglesAfterRetessellation': len(after_triangles),
    'boundaryEdgesAfter': int(np.count_nonzero(incidence == 1)), 'nonManifoldEdgesAfter': int(np.count_nonzero(incidence != 2)),
    'iterations': iterations, 'localBacktracking': local_repairs, 'upperStopRayEvidence': stops, 'before': before, 'after': after,
    'limitations': ['Distances are source vertex/triangle-centroid witnesses, not complete triangle-triangle minimum-distance certificates.', 'Only five discrete stroke poses are tested; intended axial stops are retained and excluded from the lateral 0.30 mm criterion.'],
}
failures = []
if len(flipped) or len(collapsed): failures.append('Changed face orientation or collapsed face')
if displacement.max() > .6: failures.append('Relief exceeds local 0.6 mm budget')
if np.count_nonzero(incidence != 2): failures.append('Shell is not a closed two-face-per-edge manifold')
for stop in stops:
    if not stop['retainedUpperStopSamplesAfter']: failures.append(f"No retained upper-stop ray evidence: {stop['key']}")
for key in after:
    if key['surfaceIntersections']: failures.append(f"Source mesh intersects {key['key']}")
    if key['lateralWitness'] and key['lateralWitness']['distanceMm'] < .299: failures.append(f"Lateral witness below target: {key['key']}")
record['failures'] = failures
report = ROOT/'docs/puretv-geometry-housing-relief.json'
report.write_text(json.dumps(record, ensure_ascii=False, indent=2)+'\n')
if failures:
    print('REJECTED', failures, flush=True)
    raise RuntimeError('Candidate failed local geometric checks; no source saved.')
destination = TARGET if args.apply else SCRATCH/'puretv-top-relief-candidate.blend'
bpy.ops.wm.save_as_mainfile(filepath=str(destination), compress=True)
record['savedPath'] = str(destination.relative_to(ROOT)) if destination.is_relative_to(ROOT) else 'scratch/puretv-top-relief-candidate.blend'
record['sourceSha256After'] = digest(destination)
record['sourceFileChanged'] = bool(args.apply)
report.write_text(json.dumps(record, ensure_ascii=False, indent=2)+'\n')
print('SAVED', destination, record['sourceSha256After'], flush=True)
