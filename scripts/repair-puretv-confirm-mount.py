"""Repair only the confirm seat's mounting ears and the two upper-shell pockets.

Run with Blender 5.2+. Default writes reviewed candidates under ../scratch;
--apply copies candidates over the two unchanged inputs after geometry checks.
The manifest is deliberately left to the shared asset publication pipeline.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import shutil
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/puretv-controller'
SCRATCH = ROOT.parent / 'scratch'
spec = importlib.util.spec_from_file_location('lock_audit', ROOT / 'scripts/audit-puretv-locks.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def geometry(obj):
    graph = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(graph), depsgraph=graph)
    mesh.calc_loop_triangles()
    vertices = np.empty(len(mesh.vertices)*3)
    mesh.vertices.foreach_get('co', vertices)
    matrix = np.asarray(obj.matrix_world)
    vertices = vertices.reshape((-1, 3)) @ matrix[:3, :3].T + matrix[:3, 3]
    faces = np.empty(len(mesh.loop_triangles)*3, dtype=np.int32)
    mesh.loop_triangles.foreach_get('vertices', faces)
    result = audit.Geometry(obj.name, vertices, faces.reshape((-1, 3)))
    bpy.data.meshes.remove(mesh)
    return result


def polar(vertices):
    points = vertices[:, :2]-[0, 5.5]
    radius = np.linalg.norm(points, axis=1)
    radians = np.arctan2(points[:, 1], points[:, 0])
    angle = (np.rad2deg(radians)-48+90) % 180-90
    return radius, radians, angle


def repair_seat(vertices):
    result = vertices.copy()
    radius, radians, angle = polar(vertices)
    ears = ((abs(vertices[:, 2]-25.45) < .002) | (abs(vertices[:, 2]-27.25) < .002)) & (radius > 7.38)
    new_radius = radius.copy()
    new_radius[radius > 7.35] -= .10
    new_radius[ears] = 7.3+(radius[ears]-7.4)*(2.0/1.95)
    new_angle = radians.copy()
    new_angle[ears] += np.deg2rad(angle[ears]*(13/18-1))
    result[:, 0] = new_radius*np.cos(new_angle)
    result[:, 1] = 5.5+new_radius*np.sin(new_angle)
    return result


def repair_shell(vertices):
    result = vertices.copy()
    radius, _, angle = polar(vertices)
    z = vertices[:, 2]
    def ramp(value, low, high):
        return np.clip((value-low)/(high-low), 0, 1)
    weight = ramp(radius, 7.3, 7.6)*ramp(-radius, -10.5, -10.0)*ramp(angle, -12, -8)*ramp(-angle, -22, -17)
    mapped = np.interp(z, [21, 24.21236455, 24.65, 27.18, 28.5], [21, 25.4500007, 25.50, 26.05, 28.5])
    selected = (z > 21) & (z < 28.5)
    result[selected, 2] += (mapped[selected]-z[selected])*weight[selected]
    return result


def make_candidate(relative, token, repair):
    path = SOURCE/relative
    backup = SCRATCH/('puretv-confirm-mount-before-'+Path(relative).stem+'.blend')
    if backup.exists() and sha(backup) != sha(path):
        raise RuntimeError(f'{relative} differs from backup; refusing cumulative repair')
    if not backup.exists():
        shutil.copy2(path, backup)
    bpy.ops.wm.open_mainfile(filepath=str(path))
    for collection in list(bpy.data.collections):
        if collection.name.startswith('pureTV') and collection.name not in bpy.context.scene.collection.children:
            bpy.context.scene.collection.children.link(collection)
    bpy.context.view_layer.update()
    objects = [obj for obj in bpy.data.objects if token in obj.name]
    if len(objects) != 1 or objects[0].modifiers:
        raise RuntimeError('Expected one unmodified source mesh')
    obj = objects[0]
    before = geometry(obj)
    before_normals = np.empty(len(obj.data.polygons)*3)
    obj.data.polygons.foreach_get('normal', before_normals)
    desired = repair(before.v)
    inverse = np.linalg.inv(np.asarray(obj.matrix_world))
    backtracking = []
    for iteration in range(12):
        local = desired @ inverse[:3, :3].T + inverse[:3, 3]
        obj.data.vertices.foreach_set('co', local.ravel())
        obj.data.update()
        bpy.context.view_layer.update()
        after_normals = np.empty(len(obj.data.polygons)*3)
        obj.data.polygons.foreach_get('normal', after_normals)
        inverted = np.sum(before_normals.reshape((-1, 3))*after_normals.reshape((-1, 3)), axis=1) < -1e-6
        if not inverted.any():
            break
        affected = np.unique(np.concatenate([np.array(obj.data.polygons[int(index)].vertices) for index in np.flatnonzero(inverted)]))
        backtracking.append({'iteration': iteration, 'polygons': int(inverted.sum()), 'vertices': affected.tolist(), 'sourceWorldPoints': before.v[affected].tolist()})
        desired[affected] = before.v[affected]+.5*(desired[affected]-before.v[affected])
    after = geometry(obj)
    triangles = after.v[after.f]
    collapsed = np.linalg.norm(np.cross(triangles[:, 1]-triangles[:, 0], triangles[:, 2]-triangles[:, 0]), axis=1) < 1e-10
    edge_indices = np.empty(len(obj.data.loops), dtype=np.int32)
    obj.data.loops.foreach_get('edge_index', edge_indices)
    counts = np.bincount(edge_indices, minlength=len(obj.data.edges))
    displacement = np.linalg.norm(after.v-before.v, axis=1)
    report = {
        'source': 'assets/puretv-controller/'+relative,
        'sourceName': obj.name,
        'sha256Before': sha(path),
        'before': before.report(), 'after': after.report(),
        'movedVertices': int((displacement > 1e-6).sum()),
        'maximumVertexDisplacementMm': float(displacement.max()),
        'invertedSourcePolygons': int(inverted.sum()),
        'collapsedTriangles': int(collapsed.sum()),
        'boundaryEdges': int((counts == 1).sum()),
        'nonManifoldEdges': int((counts != 2).sum()),
        'localBacktracking': backtracking,
    }
    if inverted.any() or collapsed.any() or (counts != 2).any():
        raise RuntimeError('Candidate topology failed: '+json.dumps(report, default=audit.clean))
    candidate = SCRATCH/('puretv-confirm-mount-candidate-'+Path(relative).stem+'.blend')
    bpy.ops.wm.save_as_mainfile(filepath=str(candidate), compress=True)
    report.update(candidateSha256=sha(candidate), candidateBytes=candidate.stat().st_size)
    return before, after, candidate, report


def lateral_witness(pair, angle, offset):
    radians = math.radians(angle)
    rotation = np.array([[math.cos(radians), -math.sin(radians), 0], [math.sin(radians), math.cos(radians), 0], [0, 0, 1]])
    vertices = (pair.sleeve.v-[0, 5.5, 0]) @ rotation.T+[0, 5.5, offset]
    nearest = None
    for point in np.concatenate([vertices, vertices[pair.sleeve.f].mean(axis=1)]):
        hit, normal, triangle, distance = pair.plate.tree.find_nearest(Vector(point))
        if hit is None or distance < 1e-5:
            continue
        delta = np.asarray(hit)-point
        if abs(normal.z) >= .3 or abs(delta[2])/distance >= .3:
            continue
        if nearest is None or distance < nearest['distanceMm']:
            nearest = {'distanceMm': float(distance), 'movingSourcePoint': point.tolist(), 'fixedSourcePoint': list(hit), 'fixedSourceNormal': list(normal), 'fixedTriangleIndex': int(triangle), 'angleDeg': angle, 'axialOffsetMm': offset}
    return nearest


parser = argparse.ArgumentParser()
parser.add_argument('--apply', action='store_true')
args = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
seat_before, seat, seat_candidate, seat_report = make_candidate('buttons/confirm.blend', '旋锁座', repair_seat)
shell_before, shell, shell_candidate, shell_report = make_candidate('housing/top.blend', '按键区圆滑', repair_shell)
pair = audit.Pair(seat, shell, [0, 5.5, 0])
samples = []
start_offset = math.floor((shell.low[2]-seat.high[2]-.25)*10)/10
for stage, poses in [
    ('insert', [(30, float(offset)) for offset in np.linspace(start_offset, 1, math.ceil((1-start_offset)/.1)+1)]),
    ('turn', [(float(angle), 1) for angle in np.linspace(30, 0, 61)]),
    ('seat', [(0, float(offset)) for offset in np.linspace(1, 0, 11)]),
]:
    for angle, offset in poses:
        sample = {'stage': stage, **pair.check(angle, offset, detail=True)}
        samples.append(sample)
        print('CONFIRM-MOUNT', stage, angle, offset, sample['surfaceTrianglePairs'], sample['strictInteriorSamples'], flush=True)
retention = [pair.check(0, offset, detail=True) for offset in [-.05, -.1, -.25, -.5]]
rest = pair.check(0, 0, detail=True)
lateral = [lateral_witness(pair, float(angle), 1) for angle in np.linspace(0, 30, 13)]
blocked = [item for item in samples if item['strictInteriorSamples'] or (item['surfaceTrianglePairs'] and not (item['stage'] == 'seat' and item['axialOffsetMm'] == 0))]
report = {
    'schemaVersion': 1,
    'coordinateConvention': 'Source mm/Z-up; client (x,y,z)=(source.x,source.z,-source.y). Mount center source XY=(0,5.5).',
    'method': 'Full evaluated source triangles; actual Blender re-tessellation after vertex edits. Discrete BVH triangle intersection and three-ray signed winding witnesses. No GLB simplification or parametric proxy.',
    'repair': {'seat': 'Two ears retain Z25.45..27.25, narrow 18 to 13 degrees, outer radius9.35 to9.30; exterior body radius7.4 to7.3. Interior spring/cap/switch surfaces unchanged.', 'shell': 'Two existing lock pocket regions only: R7.3..10.5, source angles36..70 and opposite, Z21..28.5. Monotone local Z remapping raises old Z24.21236455 bearing plane to25.4500007 and lowers shoulder27.18 to26.05. Cap upper retention stop is outside edited Z range.'},
    'sources': [seat_report, shell_report],
    'entryAngleDeg': 30, 'startAxialOffsetMm': start_offset, 'turnAxialOffsetMm': 1, 'lockedAngleDeg': 0,
    'maximumAxialSampleStepMm': .1, 'maximumAngularSampleStepDeg': .5,
    'spring': {'freeLengthMm': 3.2398, 'conservativeSolidLengthMm': 1.75, 'assemblyCompressionMm': 1, 'remainingCompressionBeforeConservativeSolidMm': .4898, 'assumption': 'Cap held at its unchanged upper stop while seat is raised.'},
    'assemblyPath': samples, 'blockedPathSamples': len(blocked), 'restContact': rest,
    'downwardRetention': retention, 'lateralDistanceWitnesses': lateral,
    'limitations': ['Witness distances are upper bounds on the true global minimum, not a positive-clearance certificate.', 'Discrete poses do not certify continuous collision-free motion.', 'Rest planar bearing contact is intentional and excluded from sliding-clearance goals.', 'Closed-housing assembly, spring stability, material strength, friction, and manufacturing tolerances require separate validation.'],
    'appliedToSource': False,
}
output = ROOT/'docs/puretv-geometry-confirm-mount-repair.json'
output.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=audit.clean)+'\n')
if blocked or rest['strictInteriorSamples'] or not retention[0]['strictInteriorSamples']:
    raise RuntimeError('Assembly path or retention check failed; source files unchanged')
if min(item['distanceMm'] for item in lateral if item) < .299:
    raise RuntimeError('Sampled lateral witness below nominal .30mm; source files unchanged')
if args.apply:
    for candidate, relative, entry in [(seat_candidate, 'buttons/confirm.blend', seat_report), (shell_candidate, 'housing/top.blend', shell_report)]:
        if sha(SOURCE/relative) != entry['sha256Before']:
            raise RuntimeError('Concurrent source edit; refusing overwrite')
    for candidate, relative, entry in [(seat_candidate, 'buttons/confirm.blend', seat_report), (shell_candidate, 'housing/top.blend', shell_report)]:
        shutil.copy2(candidate, SOURCE/relative)
    report['appliedToSource'] = True
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=audit.clean)+'\n')
print('REPORT', output, 'applied', args.apply, flush=True)
