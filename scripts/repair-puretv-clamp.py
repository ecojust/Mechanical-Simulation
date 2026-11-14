"""Relieve only the PCB clamp's two obstructed outer corners.

Run with Blender; default writes a scratch candidate. --apply copies the verified
candidate over electronics/esp32-mount.blend. No manifest or other source changes.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import shutil
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/puretv-controller'
SCRATCH = ROOT.parent / 'scratch'
RELATIVE = 'electronics/esp32-mount.blend'
TARGET = SOURCE / RELATIVE
NAME = 'PCB · 长轴压条.005'
BASELINE = '84c4bdaa1b598067dbc804d40aa5a1f26c37e9c43dc82803a9d8db8a8a5b5715'
CLEARANCE = .32  # The 0.30 mm requirement plus 0.02 mm polygon/rounding reserve.
CUT_SEGMENTS = 256
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--apply', action='store_true')
args = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
spec = importlib.util.spec_from_file_location('assembly_audit', ROOT / 'scripts/audit-puretv-assembly.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def arrays(obj):
    graph = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(graph), depsgraph=graph)
    mesh.calc_loop_triangles()
    local = np.empty(len(mesh.vertices)*3)
    mesh.vertices.foreach_get('co', local)
    matrix = np.asarray(obj.matrix_world)
    vertices = local.reshape((-1, 3)) @ matrix[:3, :3].T + matrix[:3, 3]
    faces = np.empty(len(mesh.loop_triangles)*3, dtype=np.int32)
    mesh.loop_triangles.foreach_get('vertices', faces)
    faces = faces.reshape((-1, 3))
    points = vertices[faces]
    result = {
        'vertices': len(vertices), 'triangles': len(faces),
        'boundsBlender': {'min': vertices.min(axis=0).tolist(), 'max': vertices.max(axis=0).tolist()},
        'volumeMm3': abs(float(np.einsum('ij,ij->i', points[:, 0], np.cross(points[:, 1], points[:, 2])).sum()/6)),
        'componentCount': len(audit.component_representatives(mesh)),
        'topology': audit.topology(mesh),
        'geometrySha256': hashlib.sha256(vertices.tobytes()+faces.tobytes()).hexdigest(),
        'worldMatrix': [list(row) for row in obj.matrix_world],
    }
    bpy.data.meshes.remove(mesh)
    return vertices, faces, result


def tree(vertices, faces):
    return BVHTree.FromPolygons(vertices.tolist(), faces.tolist(), all_triangles=True, epsilon=0)


def mesh_identity(obj):
    """Detect changes to every non-clamp source object, without expensive tessellation."""
    transform = json.dumps([list(row) for row in obj.matrix_world]).encode()
    if obj.type == 'MESH':
        vertices = np.empty(len(obj.data.vertices)*3, dtype=np.float64)
        obj.data.vertices.foreach_get('co', vertices)
        loops = np.empty(len(obj.data.loops), dtype=np.int32)
        obj.data.loops.foreach_get('vertex_index', loops)
        transform += vertices.tobytes()+loops.tobytes()
    else:
        transform += repr(obj.data).encode()
    return hashlib.sha256(transform).hexdigest()


def radial_distance(vertices, faces, center):
    """Exact 2D projected triangle distance; bounds the entire clamp, not vertices alone."""
    points = vertices[faces, :2] - np.asarray(center)
    best = math.inf
    for left, right in [(0, 1), (1, 2), (2, 0)]:
        start, edge = points[:, left], points[:, right]-points[:, left]
        t = np.clip(-np.einsum('ij,ij->i', start, edge)/np.maximum(np.einsum('ij,ij->i', edge, edge), 1e-30), 0, 1)
        best = min(best, float(np.linalg.norm(start+t[:, None]*edge, axis=1).min()))
    cross = lambda a, b: a[:, 0]*b[:, 1]-a[:, 1]*b[:, 0]
    a, b, c = points[:, 0], points[:, 1], points[:, 2]
    area = cross(b-a, c-a)
    s = np.stack([cross(b-a, -a), cross(c-b, -b), cross(a-c, -c)])
    interior = (np.abs(area) > 1e-10) & ((np.all(s >= 0, axis=0)) | (np.all(s <= 0, axis=0)))
    return 0.0 if interior.any() else best


def cut_circle(obj, name, center, radius):
    # Polygon inradius equals the required cutter envelope, avoiding inscribed-circle undercut.
    bpy.ops.mesh.primitive_cylinder_add(vertices=CUT_SEGMENTS, radius=radius/math.cos(math.pi/CUT_SEGMENTS), depth=30, location=(*center, 15))
    cutter = bpy.context.object
    cutter.name = name
    bpy.context.view_layer.objects.active = obj
    modifier = obj.modifiers.new(name, 'BOOLEAN')
    modifier.operation = 'DIFFERENCE'
    modifier.solver = 'EXACT'
    modifier.object = cutter
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    bpy.data.objects.remove(cutter, do_unlink=True)


def ray_levels(bvh, x, y):
    origin = Vector((x, y, 5))
    direction = Vector((0, 0, 1))
    heights = []
    for _ in range(32):
        point, normal, index, distance = bvh.ray_cast(origin, direction, 30)
        if point is None:
            break
        heights.append(float(point.z))
        origin = point+direction*.0001
    return heights


def interfaces(bvh):
    pads = []
    for center in [-10, 3]:
        heights = [ray_levels(bvh, center+dx, 8.5+dy) for dx in [-2, 0, 2] for dy in [-2, 0, 2]]
        pads.append({'centerBlender': [center, 8.5, 9.85], 'sampleCount': len(heights),
                     'lowerHeightsMm': [values[0] if values else None for values in heights]})
    bearings = []
    for x in [-34, 34]:
        samples = []
        thickness = []
        for angle in np.arange(0, math.tau, math.tau/360):
            for r in [1.55, 1.8, 2.0]:
                levels = ray_levels(bvh, x+math.cos(angle)*r, 8.5+math.sin(angle)*r)
                samples.append(bool(levels) and abs(levels[0]-14.85) < 1e-4)
                if len(levels) != 2:
                    raise RuntimeError('The protected screw-bearing section must have exactly two planar surfaces.')
                thickness.append(levels[1]-levels[0])
        bearings.append({'centerBlender': [x, 8.5, 14.85], 'radiiMm': [1.55, 1.8, 2.0],
                         'angularSamples': 360, 'retainedSamples': sum(samples), 'totalSamples': len(samples),
                         'minimumSectionThicknessMm': min(thickness), 'maximumSectionThicknessMm': max(thickness)})
    return {'pcbPadFeet': pads, 'lowerFastenerBearingAnnuli': bearings,
            'leftThroughBoreAxisLevels': ray_levels(bvh, -34, 8.5),
            'rightThroughBoreAxisLevels': ray_levels(bvh, 34, 8.5)}


def append_object(relative, name):
    path = SOURCE / relative
    with bpy.data.libraries.load(str(path), link=False) as (available, loaded):
        if name not in available.objects:
            raise RuntimeError(f'Missing obstruction {relative}::{name}')
        loaded.objects = [name]
    obj = loaded.objects[0]
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.update()
    return obj


if sha(TARGET) != BASELINE:
    raise RuntimeError('Clamp source differs from the reviewed baseline; do not apply the relief twice.')
backup = SCRATCH / 'puretv-esp32-mount-before-clamp.blend'
if not backup.exists():
    shutil.copy2(TARGET, backup)
if sha(backup) != BASELINE:
    raise RuntimeError('Backup hash differs from the reviewed baseline.')
bpy.ops.wm.open_mainfile(filepath=str(TARGET))
for collection in list(bpy.data.collections):
    if collection.name.startswith('pureTV') and collection.name not in bpy.context.scene.collection.children:
        bpy.context.scene.collection.children.link(collection)
bpy.context.view_layer.update()
clamp = bpy.data.objects.get(NAME)
if not clamp or clamp.type != 'MESH' or clamp.modifiers:
    raise RuntimeError('Expected a named modifier-free source clamp.')
original_objects = {obj.name: mesh_identity(obj) for obj in bpy.data.objects if obj.name != NAME}
before_v, before_f, before = arrays(clamp)
before_interfaces = interfaces(tree(before_v, before_f))
cuts = [
    {'name': 'Down sleeve outer arc relief', 'centerBlenderXY': [-42, 12.8], 'obstacleRadiusMm': 5.59167},
    {'name': 'ABXY pillar and screw outer arc relief', 'centerBlenderXY': [32.51, 12.51], 'obstacleRadiusMm': 1.86001},
]
for cut in cuts:
    cut['clearanceMm'] = CLEARANCE
    cut['cutterInradiusMm'] = cut['obstacleRadiusMm']+CLEARANCE
    cut['cutterCircumradiusMm'] = cut['cutterInradiusMm']/math.cos(math.pi/CUT_SEGMENTS)
    cut_circle(clamp, cut['name'], cut['centerBlenderXY'], cut['cutterInradiusMm'])
bm = bmesh.new()
bm.from_mesh(clamp.data)
bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
bm.to_mesh(clamp.data)
bm.free()
bpy.context.view_layer.update()
after_v, after_f, after = arrays(clamp)
after_interfaces = interfaces(tree(after_v, after_f))
if not after['topology']['closedConsistentlyOriented'] or after['componentCount'] != 1:
    raise RuntimeError('Relieved clamp is not one consistently oriented closed component.')
if {obj.name: mesh_identity(obj) for obj in bpy.data.objects if obj.name != NAME} != original_objects:
    raise RuntimeError('A source object other than the clamp changed.')
if before['worldMatrix'] != after['worldMatrix'] or before_interfaces != after_interfaces:
    raise RuntimeError('Original frame, PCB pad feet, fastener bearing annuli or screw bores changed.')
def pad_face_area(vertices, faces):
    points = vertices[faces]
    points = points[np.all(np.abs(points[:, :, 2]-9.85) < 1e-4, axis=1)]
    return float(np.linalg.norm(np.cross(points[:, 1]-points[:, 0], points[:, 2]-points[:, 0]), axis=1).sum()/2)
before_pad_area, after_pad_area = pad_face_area(before_v, before_f), pad_face_area(after_v, after_f)
if abs(before_pad_area-after_pad_area) > 1e-6 or after_pad_area < 41.39:
    raise RuntimeError('The original PCB pad contact area changed.')
after_interfaces['pcbPadTotalContactAreaMm2'] = after_pad_area
protected_annulus_gaps = [min(math.dist([x, 8.5], cut['centerBlenderXY'])-cut['cutterCircumradiusMm']-2 for cut in cuts) for x in [-34, 34]]
if min(protected_annulus_gaps) <= 0:
    raise RuntimeError('A cutter reaches the protected 2 mm-radius bearing annulus.')
after_interfaces['protectedAnnulusOuterRadiusMm'] = 2
after_interfaces['protectedAnnulusCutterGapsMm'] = protected_annulus_gaps
for cut in cuts:
    cut['minimumClampAxisDistanceMm'] = radial_distance(after_v, after_f, cut['centerBlenderXY'])
    cut['analyticEnvelopeClearanceMm'] = cut['minimumClampAxisDistanceMm']-cut['obstacleRadiusMm']
    if cut['analyticEnvelopeClearanceMm'] < .3:
        raise RuntimeError('Full-triangle cutter clearance is below 0.30 mm.')
candidate = SCRATCH / 'puretv-clamp-candidate.blend'
bpy.ops.wm.save_as_mainfile(filepath=str(candidate), check_existing=False)
candidate_sha = sha(candidate)

# Imported neighbours are read only and are loaded only after the candidate save.
checks = []
cache = SCRATCH / 'puretv-assembly-audit-cache'
clamp_record = audit.extract(clamp, RELATIVE, candidate_sha, cache)
clamp_geo = audit.Geometry(clamp_record, 0)
for relative, name in [
    ('buttons/down.blend', '下 · PS5 下环一体式开关套筒.003'),
    ('housing/bottom.blend', '底壳 · 合壳.007'),
    ('baseplates/abxy.blend', 'ABXY · 边中点 M2 固定螺钉 1.002'),
]:
    obstacle = append_object(relative, name)
    record = audit.extract(obstacle, relative, sha(SOURCE/relative), cache)
    geometry = audit.Geometry(record, 0)
    result = audit.audit_pair(clamp_geo, geometry, 20000)
    checks.append({'sourceFile': relative, 'sourceName': name, 'sourceSha256': record['sourceSha256'], 'result': result})
    if relative != 'housing/bottom.blend' and result['status'] != 'no-intersection-observed':
        raise RuntimeError(f'Relief did not resolve {relative}: {result["status"]}')
    if relative == 'buttons/down.blend':
        measured_radius = float(np.linalg.norm(geometry.vertices[:, :2]-[-42, 12.8], axis=1).max())
        if measured_radius > cuts[0]['obstacleRadiusMm']:
            raise RuntimeError('Current sleeve exceeds the conservative cutter envelope.')
        cuts[0]['measuredSourceMaximumRadiusMm'] = measured_radius
    if relative == 'housing/bottom.blend':
        crossing = result.get('conservativeCrossingRegionBlender')
        if crossing and any(abs(crossing[edge][2]-14.850000381469727) > 1e-5 for edge in ['min', 'max']):
            raise RuntimeError('A shell/clamp intersection remains outside the original mounting bearing plane.')
        if result['aInsideB']['insidePoints']:
            raise RuntimeError('A clamp point remains inside the bottom housing.')
        checks[-1]['retainedMountingBearingPlane'] = {
            'sourceZMm': 14.850000381469727,
            'allSourceTriangleCrossingsOnPlane': True,
            'contactPurpose': 'Original PCB screw mounting-column end faces against clamp underside; two protected bearing annuli remain intact.',
            'rawNumericalClassificationRetained': True,
            'independentReviewRequired': True,
        }
        v = geometry.vertices
        local = v[(v[:, 0] > 29) & (v[:, 0] < 38) & (v[:, 1] > 10) & (v[:, 1] < 15) & (v[:, 2] > 14.8501) & (v[:, 2] < 18)]
        measured_radius = float(np.linalg.norm(local[:, :2]-[32.51, 12.51], axis=1).max())
        if measured_radius > cuts[1]['obstacleRadiusMm']:
            raise RuntimeError('Current ABXY pillar exceeds the conservative cutter envelope.')
        cuts[1]['measuredSourceMaximumRadiusMm'] = measured_radius
    bpy.data.objects.remove(obstacle, do_unlink=True)
    del geometry

report = {
    'version': 1, 'status': 'candidate', 'blenderVersion': bpy.app.version_string,
    'sourceFile': RELATIVE, 'sourceObject': NAME,
    'beforeSha256': BASELINE, 'afterSha256': candidate_sha,
    'coordinates': 'Source millimetres, Z up; client=(source.x,source.z,-source.y).',
    'operation': 'Two local cylindrical outer-corner subtractions; original object frame and all other objects unchanged.',
    'before': before, 'after': after,
    'removedVolumeMm3': before['volumeMm3']-after['volumeMm3'],
    'retainedVolumeFraction': after['volumeMm3']/before['volumeMm3'],
    'cuts': cuts, 'preservedInterfaces': after_interfaces,
    'unchangedOtherObjectCount': len(original_objects), 'sourceObjectCount': len(original_objects)+1,
    'minimumRightShaftHoleLigamentMm': math.dist([34, 8.5], cuts[1]['centerBlenderXY'])-cuts[1]['cutterCircumradiusMm']-1.4,
    'lowerRightFastenerSeatThicknessMm': after_interfaces['lowerFastenerBearingAnnuli'][1]['minimumSectionThicknessMm'],
    'sourceBvhChecks': checks,
    'limitations': [
        'The two original mounting-column bearing planes at Z=14.85 are intentionally retained; full-source BVH may report coplanar contact, which requires a bounded interface review rather than a global collision waiver.',
        'Radial envelope clearance bounds the full projected triangles for the relieved sleeve and pillar zones; it does not certify unreviewed source interfaces.',
        'Retained section and seat dimensions are geometric measurements, not fastener preload, polymer strength, fatigue or printability certification.',
    ],
}
output = SCRATCH / 'puretv-geometry-clamp-repair-proposal.json'
if args.apply:
    # Candidate is saved before imported obstacles enter the Blender session.
    shutil.copy2(candidate, TARGET)
    report['status'] = 'applied-pending-independent-assembly-review'
    output = ROOT / 'docs/puretv-geometry-clamp-repair.json'
output.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
print(json.dumps({'status': report['status'], 'afterSha256': candidate_sha, 'triangles': after['triangles'], 'retainedVolumeFraction': report['retainedVolumeFraction'], 'clearancesMm': [cut['analyticEnvelopeClearanceMm'] for cut in cuts], 'minimumRightShaftHoleLigamentMm': report['minimumRightShaftHoleLigamentMm'], 'checks': [check['result']['status'] for check in checks]}, ensure_ascii=False), flush=True)
