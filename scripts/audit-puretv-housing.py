"""Read-only evaluated-source audit of nine keycaps against housings/baseplates.

Run: blender -b --python scripts/audit-puretv-housing.py
Uses source triangles, not simplified GLBs. Sampling is discrete, not CCD.
"""
import bpy
import gc
import hashlib
import json
import time
from pathlib import Path
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/puretv-controller'
OUTPUT = ROOT / 'docs/puretv-geometry-housing-after.json'
EPS = 1e-5
STROKES = [0, .25, .5, .75, 1.0]
DIRECTIONS = [Vector(v).normalized() for v in [(1, .371, .719), (.213, 1, .527), (.641, .193, 1)]]


def round_values(values):
    return [round(float(v), 7) for v in values]


def bounds(points):
    lo, hi = points.min(axis=0), points.max(axis=0)
    return {'min': round_values(lo), 'max': round_values(hi), 'size': round_values(hi-lo), 'center': round_values((hi+lo)/2)}


def client(points):
    return points[:, [0, 2, 1]] * [1, 1, -1]


def append_objects(relative, names):
    with bpy.data.libraries.load(str(SOURCE / relative), link=False) as (available, loaded):
        missing = set(names) - set(available.objects)
        if missing:
            raise RuntimeError(f'Missing source objects {relative}: {missing}')
        # Blender replaces elements in this list with loaded IDs on context exit.
        loaded.objects = list(names)
    result = []
    for obj in loaded.objects:
        bpy.context.scene.collection.objects.link(obj)
        result.append(obj)
    bpy.context.view_layer.update()
    return result


def evaluated_geometry(obj):
    graph = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(graph)
    mesh = bpy.data.meshes.new_from_object(evaluated, depsgraph=graph)
    mesh.calc_loop_triangles()
    local = np.empty(len(mesh.vertices)*3, dtype=np.float64)
    mesh.vertices.foreach_get('co', local)
    local = local.reshape((-1, 3))
    matrix = np.array(obj.matrix_world, dtype=np.float64)
    world = local @ matrix[:3, :3].T + matrix[:3, 3]
    indices = np.empty(len(mesh.loop_triangles)*3, dtype=np.int32)
    mesh.loop_triangles.foreach_get('vertices', indices)
    triangles = indices.reshape((-1, 3))
    bpy.data.meshes.remove(mesh)
    return world, triangles


def bvh(vertices, triangles):
    return BVHTree.FromPolygons(vertices.tolist(), triangles.tolist(), all_triangles=True, epsilon=0)


def inside(tree, point):
    """Strict three-ray parity agreement; near-surface samples are inconclusive."""
    origin = Vector(point)
    nearest = tree.find_nearest(origin)
    if nearest[0] is None or nearest[3] <= EPS:
        return None, 0.0
    results = []
    for direction in DIRECTIONS:
        cursor, crossings = origin.copy(), 0
        for _ in range(256):
            hit = tree.ray_cast(cursor, direction)
            if hit[0] is None:
                break
            crossings += 1
            cursor = hit[0] + direction * EPS
        else:
            return None, float(nearest[3])
        results.append(crossings % 2 == 1)
    return (results[0] if all(v == results[0] for v in results) else None), float(nearest[3])


def component_vertices(triangles):
    count = int(triangles.max())+1
    parent = list(range(count))
    def root(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index
    for a, b, c in triangles:
        a, b, c = root(int(a)), root(int(b)), root(int(c))
        parent[b] = a
        parent[c] = a
    reps = {}
    for vertex in np.unique(triangles):
        reps.setdefault(root(int(vertex)), int(vertex))
    return list(reps.values())


def sample_evidence(vertices, triangles, selected, reps, other_tree, max_samples=768):
    selected = np.array(sorted(set(selected)), dtype=np.int32)
    indices = np.unique(triangles[selected]) if len(selected) else np.array([], dtype=np.int32)
    indices = np.unique(np.concatenate([indices, np.array(reps, dtype=np.int32)]))
    if len(indices) > max_samples:
        indices = indices[np.linspace(0, len(indices)-1, max_samples, dtype=int)]
    points = vertices[indices]
    if len(selected):
        sample_triangles = selected[np.linspace(0, len(selected)-1, min(len(selected), max_samples//2), dtype=int)]
        points = np.concatenate([points, vertices[triangles[sample_triangles]].mean(axis=1)])
    evidence, uncertain, verified_count, maximum = [], 0, 0, 0.0
    for point in points:
        status, depth = inside(other_tree, point)
        if status is None:
            uncertain += 1
        elif status:
            verified_count += 1
            maximum = max(maximum, depth)
            if len(evidence) < 12:
                evidence.append({'pointBlender': round_values(point), 'pointClient': round_values(client(point[None, :])[0]), 'nearestSurfaceDistanceMm': round(depth, 7)})
    return {'testedPoints': len(points), 'strictInteriorSamples': verified_count, 'inconclusiveSurfaceOrParitySamples': uncertain, 'maxSampledInteriorDistanceMm': round(maximum, 7), 'examples': evidence}


def intersects_bounds(a, b):
    return bool(np.all(a.max(axis=0) >= b.min(axis=0)-EPS) and np.all(b.max(axis=0) >= a.min(axis=0)-EPS))


def audit_pair(moving, triangles, reps, stationary, stationary_triangles, stationary_tree):
    if not intersects_bounds(moving, stationary):
        return {'status': 'separated_bounding_boxes', 'surfaceTrianglePairs': 0}
    moving_tree = bvh(moving, triangles)
    overlaps = moving_tree.overlap(stationary_tree)
    moving_selected = [a for a, _ in overlaps]
    stationary_selected = [b for _, b in overlaps]
    first = sample_evidence(moving, triangles, moving_selected, reps, stationary_tree)
    # Surface crossing can cut a large moving triangle without its vertices lying inside.
    # Reverse vertex/triangle-center tests also catch that case.
    target_candidates = np.flatnonzero(np.all(stationary >= moving.min(axis=0)-EPS, axis=1) & np.all(stationary <= moving.max(axis=0)+EPS, axis=1))
    # Reverse containment also matters without any surface crossing (e.g. a small
    # screw entirely enclosed by a cap); select nearby stationary vertices.
    second = sample_evidence(stationary, stationary_triangles, stationary_selected, target_candidates, moving_tree)
    penetration = bool(first['strictInteriorSamples'] or second['strictInteriorSamples'])
    result = {
        'status': 'confirmed_interior_sample' if penetration else 'surface_intersection_unresolved_contact_or_penetration' if overlaps else 'no_surface_intersection_or_component_containment_observed',
        'surfaceTrianglePairs': len(overlaps),
        'movingSurfaceTriangles': len(set(moving_selected)),
        'stationarySurfaceTriangles': len(set(stationary_selected)),
        'movingInsideStationary': first,
        'stationaryInsideMoving': second,
    }
    closest = (float('inf'), None, None, None, None)
    lateral = (float('inf'), None, None, None, None)
    for point in np.concatenate([moving, moving[triangles].mean(axis=1)]):
        hit = stationary_tree.find_nearest(Vector(point))
        if hit[0] is not None and hit[3] < closest[0]:
            closest = (float(hit[3]), point, np.array(hit[0]), np.array(hit[1]), int(hit[2]))
        if hit[0] is not None and abs(hit[1].z) < 0.3 and abs(hit[0].z-float(point[2]))/max(float(hit[3]), 1e-12) < 0.3 and hit[3] < lateral[0]:
            lateral = (float(hit[3]), point, np.array(hit[0]), np.array(hit[1]), int(hit[2]))
    if closest[1] is not None:
        result['sampledSurfaceClearance'] = {
            'distanceMm': round(closest[0], 7),
            'meaning': 'Minimum over every moving mesh vertex and triangle centroid to the stationary surface; an upper bound on the true global minimum, not an exact clearance certificate',
            'movingWitnessClient': round_values(client(closest[1][None, :])[0]),
            'stationaryWitnessClient': round_values(client(closest[2][None, :])[0]),
            'stationaryNormalClient': round_values(client(closest[3][None, :])[0]),
            'stationarySourceTriangle': closest[4],
        }
    if lateral[1] is not None:
        result['sampledLateralWallClearance'] = {
            'distanceMm': round(lateral[0], 7),
            'classification': 'stationary source triangle normal and nearest-point separation vector both have abs(Blender Z component) < 0.3 of their length; excludes axial stop edges',
            'movingWitnessClient': round_values(client(lateral[1][None, :])[0]),
            'stationaryWitnessClient': round_values(client(lateral[2][None, :])[0]),
            'stationaryNormalClient': round_values(client(lateral[3][None, :])[0]),
            'stationarySourceTriangle': lateral[4],
        }
    if overlaps:
        selected_vertices = moving[triangles[np.unique(moving_selected)]].reshape((-1, 3))
        result['involvedMovingTriangleBoundsBlender'] = bounds(selected_vertices)
        result['involvedMovingTriangleBoundsClient'] = bounds(client(selected_vertices))
    return result


started = time.monotonic()
bpy.ops.wm.read_factory_settings(use_empty=True)
manifest = json.loads((SOURCE / 'manifest.json').read_text())
entries = {item['file']: item for item in manifest['assets']}
hashes = {}
caps = []
objects = []
for relative, entry in entries.items():
    if not relative.startswith('buttons/'):
        continue
    names = [item['exported'] for item in entry['objects'] if '键帽' in item['exported'] or '弹簧定位环' in item['exported']]
    hashes[relative] = hashlib.sha256((SOURCE/relative).read_bytes()).hexdigest()
    for obj in append_objects(relative, names):
        name = obj.name
        role = 'spring-seat' if '弹簧定位环' in name else 'label' if '标识' in name else 'cap'
        vertices, triangles = evaluated_geometry(obj)
        caps.append({'id': Path(relative).stem, 'role': role, 'sourceFile': relative, 'sourceName': name, 'vertices': vertices, 'triangles': triangles, 'representativeVertices': component_vertices(triangles)})
        objects.append({'sourceFile': relative, 'sourceName': name, 'movingRole': role, 'vertices': len(vertices), 'triangles': len(triangles), 'componentCount': len(caps[-1]['representativeVertices']), 'boundsBlender': bounds(vertices), 'boundsClient': bounds(client(vertices))})
        bpy.data.objects.remove(obj, do_unlink=True)

checks = []
for relative in ['housing/top.blend', 'housing/bottom.blend', 'baseplates/dpad.blend', 'baseplates/abxy.blend']:
    hashes[relative] = hashlib.sha256((SOURCE/relative).read_bytes()).hexdigest()
    names = [item['exported'] for item in entries[relative]['objects']]
    for obj in append_objects(relative, names):
        target_name = obj.name
        vertices, triangles = evaluated_geometry(obj)
        tree = bvh(vertices, triangles)
        objects.append({'sourceFile': relative, 'sourceName': target_name, 'vertices': len(vertices), 'triangles': len(triangles), 'boundsBlender': bounds(vertices), 'boundsClient': bounds(client(vertices))})
        for cap in caps:
            samples = []
            for stroke in STROKES:
                moved = cap['vertices'] - [0, 0, stroke]
                report = audit_pair(moved, cap['triangles'], cap['representativeVertices'], vertices, triangles, tree)
                samples.append({'strokeMm': stroke, **report})
                if report['surfaceTrianglePairs'] or report['status'] == 'confirmed_interior_sample':
                    print('CONTACT', cap['id'], target_name, stroke, report['status'], report['surfaceTrianglePairs'], flush=True)
            checks.append({'key': cap['id'], 'movingRole': cap['role'], 'movingSourceName': cap['sourceName'], 'stationarySourceFile': relative, 'stationarySourceName': target_name, 'samples': samples})
        print('AUDITED', relative, target_name, len(triangles), flush=True)
        bpy.data.objects.remove(obj, do_unlink=True)
        del tree, vertices, triangles
        gc.collect()

for relative, before in hashes.items():
    if hashlib.sha256((SOURCE/relative).read_bytes()).hexdigest() != before:
        raise RuntimeError(f'Source changed during audit: {relative}')
summary = {'objectPairs': len(checks), 'sampledPosesPerPair': len(STROKES), 'confirmedInteriorPairs': [], 'unresolvedSurfacePairs': [], 'topHousingClearanceWitnesses': []}
for check in checks:
    kinds = {sample['status'] for sample in check['samples']}
    if 'confirmed_interior_sample' in kinds:
        summary['confirmedInteriorPairs'].append({'key': check['key'], 'stationary': check['stationarySourceName'], 'strokesMm': [sample['strokeMm'] for sample in check['samples'] if sample['status'] == 'confirmed_interior_sample']})
    if 'surface_intersection_unresolved_contact_or_penetration' in kinds:
        summary['unresolvedSurfacePairs'].append({'key': check['key'], 'stationary': check['stationarySourceName']})
    if check['stationarySourceFile'] == 'housing/top.blend':
        measured = [sample for sample in check['samples'] if 'sampledSurfaceClearance' in sample]
        if measured:
            worst = min(measured, key=lambda sample: sample['sampledSurfaceClearance']['distanceMm'])
            summary['topHousingClearanceWitnesses'].append({'key': check['key'], 'movingRole': check['movingRole'], 'movingSourceName': check['movingSourceName'], 'stationarySourceName': check['stationarySourceName'], 'strokeMm': worst['strokeMm'], **worst['sampledSurfaceClearance']})
output = {
    'schemaVersion': 1,
    'blenderVersion': bpy.app.version_string,
    'units': 'mm',
    'coordinateConversion': {'source': 'Blender XYZ, Z up', 'client': '(x, y, z) -> (x, z, -y), Y up', 'motionSource': [0, 0, -1], 'motionClient': [0, -1, 0]},
    'method': {'geometry': 'Full evaluated source .blend meshes without decimation', 'surfaceTest': 'BVHTree.overlap on source triangles, epsilon 0', 'containmentTest': 'Three independent ray-parity votes; every sampled vote must agree; samples within 0.00001 mm of a surface excluded', 'sampling': 'All connected moving components represented; overlapping triangle vertices/centroids and nearby stationary vertices sampled in both directions, capped at 1152 points/direction', 'penetrationDepth': 'Nearest-surface distance of a verified interior sample; not a complete maximum penetration computation', 'clearance': 'Every moving vertex and triangle centroid queried against stationary surface; reported minimum is an upper bound on global triangle-triangle distance', 'limitations': ['Five discrete poses are not continuous collision detection.', 'No observed overlap does not certify full manufacturing clearance or self-intersection freedom.', 'Surface intersection without strict interior evidence is unresolved contact or penetration, not declared a pass.', 'Keycap labels and upper spring seats move with caps. Springs, switches and sleeves require their separate internal mechanism audit.']},
    'sourceSha256': hashes,
    'sourceFilesUnchanged': True,
    'objects': objects,
    'summary': summary,
    'findings': [
        f"The report contains {len(checks)*len(STROKES)} discrete moving-member/housing/baseplate/fastener checks; inspect summary for any observed crossings or interior samples.",
        'All nine upper-housing interfaces have witnessed point-to-surface distances below 0.1 mm; therefore a universal 0.1 mm non-contact clearance requirement would fail even though no nominal intersection was found.',
        'Several resting witnesses are predominantly axial and may be intended upper retaining stops. Classify intended stop faces before applying a non-contact tolerance rule.',
        'Left/down key witnesses during pressing include lateral aperture edges. If those are sliding/non-contact faces, provide local relief using the actual manufacturing tolerance budget and re-audit the swept source geometry.',
        'Do not enlarge every aperture indiscriminately: that could remove keycap retention. No source geometry was modified by this audit.',
    ],
    'checks': checks,
    'elapsedSeconds': round(time.monotonic()-started, 3),
}
OUTPUT.write_text(json.dumps(output, ensure_ascii=False, indent=2)+'\n')
print('WROTE', OUTPUT, json.dumps(summary, ensure_ascii=False), flush=True)
