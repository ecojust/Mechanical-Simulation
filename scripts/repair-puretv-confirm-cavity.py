"""Cut a measured clearance cavity for the fixed confirm switch body.

Blender 5.2+: default writes a scratch candidate; --apply writes only the
confirm source after validation. The source manifest is not modified.
"""
import argparse
import hashlib
import importlib.util
import json
import shutil
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT/'assets/puretv-controller/buttons/confirm.blend'
SCRATCH = ROOT.parent/'scratch'
spec = importlib.util.spec_from_file_location('internals', ROOT/'scripts/audit-puretv-internals.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def geometry_hash(geometry):
    digest = hashlib.sha256()
    digest.update(geometry.v.astype('<f8').tobytes())
    digest.update(geometry.f.astype('<i4').tobytes())
    return digest.hexdigest()


def topology(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    visited, components = set(), []
    for vertex in bm.verts:
        if vertex in visited:
            continue
        visited.add(vertex)
        pending, count = [vertex], 0
        while pending:
            current = pending.pop()
            count += 1
            for edge in current.link_edges:
                other = edge.other_vert(current)
                if other not in visited:
                    visited.add(other)
                    pending.append(other)
        components.append(count)
    result = {'components': components, 'boundaryEdges': sum(edge.is_boundary for edge in bm.edges), 'nonManifoldEdges': sum(not edge.is_manifold for edge in bm.edges)}
    bm.free()
    return result


def protected_geometry(geometry, kind):
    points = geometry.v[geometry.f]
    radii = np.linalg.norm(points[:, :, :2]-[0, 5.5], axis=2)
    selected = np.all(radii > 6.9, axis=1) if kind == 'external-mount' else np.all(points[:, :, 2] > 25.14, axis=1)
    triangles = points[selected]
    vertices = geometry.v[(np.linalg.norm(geometry.v[:, :2]-[0, 5.5], axis=1) > 6.9) if kind == 'external-mount' else (geometry.v[:, 2] > 25.14)]
    return triangles, sorted(tuple(round(float(c), 8) for c in point) for point in vertices)


def preserve_existing_triangles(obj):
    """Retain source diagonals on the existing non-planar mounting faces."""
    old = obj.data
    if old.uv_layers or old.color_attributes:
        raise RuntimeError('Unexpected visual vertex data; do not discard it')
    old.calc_loop_triangles()
    triangles = list(old.loop_triangles)
    replacement = bpy.data.meshes.new(old.name+' - preserved source triangles')
    replacement.from_pydata([tuple(vertex.co) for vertex in old.vertices], [], [tuple(triangle.vertices) for triangle in triangles])
    for material in old.materials:
        replacement.materials.append(material)
    for polygon, triangle in zip(replacement.polygons, triangles):
        polygon.material_index = old.polygons[triangle.polygon_index].material_index
        polygon.use_smooth = old.polygons[triangle.polygon_index].use_smooth
    replacement.update()
    obj.data = replacement


def subtract(target, cutter):
    bpy.context.view_layer.objects.active = target
    modifier = target.modifiers.new('Measured fixed interface cavity', 'BOOLEAN')
    modifier.operation = 'DIFFERENCE'
    modifier.solver = 'EXACT'
    modifier.use_self = True
    modifier.use_hole_tolerant = True
    modifier.object = cutter
    bpy.ops.object.modifier_apply(modifier=modifier.name)


def cube(name, low, high):
    bpy.ops.mesh.primitive_cube_add(size=1, location=tuple((low+high)/2))
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = tuple(high-low)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return obj


parser = argparse.ArgumentParser()
parser.add_argument('--apply', action='store_true')
args = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
before_sha = sha(SOURCE)
backup = SCRATCH/'puretv-confirm-before-switch-cavity.blend'
if backup.exists() and sha(backup) != before_sha:
    raise RuntimeError('Source differs from cavity backup; refusing cumulative repair')
if not backup.exists():
    shutil.copy2(SOURCE, backup)
bpy.ops.wm.open_mainfile(filepath=str(SOURCE))
for collection in list(bpy.data.collections):
    if collection.name.startswith('pureTV') and collection.name not in bpy.context.scene.collection.children:
        bpy.context.scene.collection.children.link(collection)
bpy.context.view_layer.update()
seat = bpy.data.objects['确认 · 旋锁座.005']
body = bpy.data.objects['确认 · 常开开关.005']
cap = bpy.data.objects['确认 · 键帽.007']
actuator = bpy.data.objects['确认 · 开关触头.005']
spring = bpy.data.objects['确认 · 回弹压簧.005']
before = audit.evaluated(seat)
body_geometry = audit.evaluated(body)
before_intersection = audit.intersection(before, body_geometry)
unchanged = {obj.name: geometry_hash(audit.evaluated(obj)) for obj in [cap, actuator, spring]}
matrix_before = np.asarray(seat.matrix_world).copy()
body_matrix_before = np.asarray(body.matrix_world).copy()
preserve_existing_triangles(seat)

clearance = .30
cavity_low = body_geometry.low-clearance
cavity_high = body_geometry.high+clearance
cavity_low[2] = min(cavity_low[2], before.low[2]-.5)
cutter = cube('Temporary measured switch cavity', cavity_low, cavity_high)
subtract(seat, cutter)
bpy.data.objects.remove(cutter, do_unlink=True)

terminal_material = bpy.data.materials.new('Tin-plated confirm switch terminals')
terminal_material.use_nodes = True
bsdf = terminal_material.node_tree.nodes.get('Principled BSDF')
bsdf.inputs['Base Color'].default_value = (.72, .76, .80, 1)
bsdf.inputs['Metallic'].default_value = 1
bsdf.inputs['Roughness'].default_value = .28
terminal_material.diffuse_color = (.72, .76, .80, 1)
terminals = []
source_collection = next(collection for collection in seat.users_collection if collection.name.startswith('pureTV'))
for label, x in [('GPIO', 2), ('GND', -2)]:
    low = np.array([x-.325, 5.5-.325, 19.0])
    high = np.array([x+.325, 5.5+.325, body_geometry.low[2]+.30])
    terminal = cube('确认 · '+label+' 金属焊脚.005', low, high)
    terminal.data.materials.append(terminal_material)
    for collection in list(terminal.users_collection):
        collection.objects.unlink(terminal)
    source_collection.objects.link(terminal)
    # Real blind pockets replace plastic/metal volume overlap.
    subtract(body, terminal)
    terminals.append(terminal)
bpy.context.view_layer.update()
after = audit.evaluated(seat)
after_topology = topology(seat)
body_after = audit.evaluated(body)
body_topology = topology(body)
after_intersection = audit.intersection(after, body_after)
if not np.array_equal(matrix_before, np.asarray(seat.matrix_world)):
    raise RuntimeError('Seat object transform changed')
if not np.array_equal(body_matrix_before, np.asarray(body.matrix_world)):
    raise RuntimeError('Switch body transform changed')
for obj in [cap, actuator, spring]:
    if unchanged[obj.name] != geometry_hash(audit.evaluated(obj)):
        raise RuntimeError('Unrelated object changed: '+obj.name)
protected = {}
for region in ['external-mount', 'upper-guide-and-spring-support']:
    old, old_vertices = protected_geometry(before, region)
    new, new_vertices = protected_geometry(after, region)
    maximum_surface_change = 0
    for triangles, target in [(old, after), (new, before)]:
        samples = np.concatenate([triangles.reshape((-1, 3)), triangles.mean(axis=1)])
        maximum_surface_change = max(maximum_surface_change, max(float(target.bvh.find_nearest(Vector(point))[3]) for point in samples))
    def triangle_set(triangles):
        return sorted(tuple(sorted(tuple(round(float(value), 8) for value in point) for point in triangle)) for triangle in triangles)
    triangles_unchanged = triangle_set(old) == triangle_set(new)
    protected[region] = {'beforeTriangles': len(old), 'afterTriangles': len(new), 'identicalWorldVerticesAt1e8Mm': old_vertices == new_vertices, 'identicalWorldTrianglesAt1e8Mm': triangles_unchanged, 'maximumBidirectionalSurfaceSampleChangeMm': maximum_surface_change, 'note': 'Original evaluated diagonals are frozen before Boolean. Triangle coordinates, not triangle indices, are compared exactly at1e-8mm; BVH nearest-point distances on identical thin triangles have floating-point noise.'}
    if old_vertices != new_vertices or not triangles_unchanged:
        print('PROTECTION', region, protected[region], 'oldUnique',len(set(old_vertices)),'newUnique',len(set(new_vertices)), 'removed',list(set(old_vertices)-set(new_vertices))[:3], 'added',list(set(new_vertices)-set(old_vertices))[:3],flush=True)
        raise RuntimeError('Protected geometry changed: '+region)
clearance_witnesses = []
for point in np.concatenate([body_geometry.v, body_geometry.v[body_geometry.f].mean(axis=1)]):
    hit, normal, face, distance = after.bvh.find_nearest(Vector(point))
    clearance_witnesses.append({'bodySourcePoint': point.tolist(), 'seatSourcePoint': list(hit), 'distanceMm': float(distance), 'seatTriangle': int(face)})
press = []
for displacement in [0, .25, .5, .75, 1.0]:
    moved_cap = audit.evaluated(cap).moved(displacement)
    moved_spring = audit.evaluated(spring).moved(displacement, spring=True)
    moved_actuator = audit.evaluated(actuator).moved(max(0, displacement-.75))
    press.append({'displacementMm': displacement, 'capAgainstSeat': audit.intersection(moved_cap, after), 'springAgainstSeat': audit.intersection(moved_spring, after), 'actuatorAgainstSeat': audit.intersection(moved_actuator, after)})
terminal_reports = []
for terminal in terminals:
    mesh = audit.evaluated(terminal)
    terminal_reports.append({
        'name': terminal.name, 'geometry': mesh.report(), 'topology': topology(terminal),
        'world_matrix': [list(row) for row in terminal.matrix_world],
        'againstPlasticBody': audit.intersection(mesh, body_after),
        'againstSeat': audit.intersection(mesh, after),
        'plasticContactRegionSourceMin': [float(mesh.low[0]), float(mesh.low[1]), float(body_geometry.low[2])],
        'plasticContactRegionSourceMax': mesh.high,
        'contactDefinition': 'Fixed metal terminal seated in a matching plastic blind pocket. Nominal zero-gap boundary contact only; no plastic/metal volume penetration allowed.',
        'solderRegionSourceMin': [float(mesh.low[0]), float(mesh.low[1]), 19.0],
        'solderRegionSourceMax': [float(mesh.high[0]), float(mesh.high[1]), 19.55],
        'solderDefinition': 'Only the matching confirm wire end may intersect this terminal-local region as a declared solder joint; actual wire source is repaired and checked separately.',
        'material': {'name': terminal_material.name, 'metalness': 1, 'roughness': .28, 'baseColor': [.72, .76, .80, 1]},
    })
report = {
    'schemaVersion': 1, 'source': 'assets/puretv-controller/buttons/confirm.blend', 'target': seat.name,
    'sourceSha256Before': before_sha,
    'method': 'Exact Boolean difference of the actual fixed switch body world AABB expanded by0.30mm. Full source mesh re-evaluation, BVH triangle intersections and bounded three-ray winding interior witnesses. No decimation or collider exclusion.',
    'cavitySourceMin': cavity_low, 'cavitySourceMax': cavity_high, 'nominalClearanceMm': clearance,
    'beforeSeat': before.report(), 'afterSeat': after.report(), 'afterTopology': after_topology,
    'beforePlasticBody': body_geometry.report(), 'afterPlasticBody': body_after.report(), 'afterPlasticBodyTopology': body_topology,
    'beforeBodyIntersection': before_intersection, 'afterBodyIntersection': after_intersection,
    'protectedGeometry': protected, 'unchangedObjectGeometrySha256': unchanged,
    'bodyClearanceWitnesses': clearance_witnesses,
    'minimumSampledBodyClearanceMm': min(item['distanceMm'] for item in clearance_witnesses),
    'roofHeights': {'centralGuideStepSourceZ': 25.15, 'springSupportSourceZ': 25.80, 'cavityTopSourceZ': float(cavity_high[2]), 'centralGuideStepAboveCavityMm': float(25.15-cavity_high[2]), 'springSupportAboveCavityMm': float(25.80-cavity_high[2]), 'note': 'Vertical section distances at the named levels; not a global minimum wall-thickness or structural-strength certificate.'},
    'pressSamples': press,
    'terminals': terminal_reports,
    'sourceObjectsAfter': [{'exported': obj.name, 'world_matrix': [list(row) for row in obj.matrix_world]} for obj in source_collection.objects if obj.type in {'MESH', 'CURVE'}],
    'limitations': ['Five press samples do not prove a continuous collision-free sweep.', 'The switch cavity is an open-bottom geometric fit; fastening and real switch load capacity require physical design verification.', 'Protected outer mounting vertices retain their source coordinates; coplanar tessellation may change and the complete installation audit must still bind the new source file hash.'],
    'appliedToSource': False,
}
failures = []
if after_topology['nonManifoldEdges'] or len(after_topology['components']) != 1:
    failures.append('Seat is not one closed manifold')
if body_topology['nonManifoldEdges'] or len(body_topology['components']) != 1:
    failures.append('Plastic switch body is not one closed manifold')
for terminal in terminal_reports:
    if terminal['topology']['nonManifoldEdges'] or len(terminal['topology']['components']) != 1:
        failures.append(terminal['name']+' is not one closed manifold')
    if terminal['againstPlasticBody']['insideVertices']:
        failures.append(terminal['name']+' penetrates plastic body')
    if terminal['againstSeat']['surfaceTrianglePairs'] or terminal['againstSeat']['insideVertices']:
        failures.append(terminal['name']+' collides with seat')
if after_intersection['surfaceTrianglePairs'] or after_intersection['insideVertices']:
    failures.append('Fixed switch body still collides with seat')
if report['minimumSampledBodyClearanceMm'] < .299:
    failures.append('Body clearance witness below target')
for step in press:
    for name in ['capAgainstSeat', 'springAgainstSeat', 'actuatorAgainstSeat']:
        if step[name]['surfaceTrianglePairs'] or step[name]['insideVertices']:
            failures.append(f'{step["displacementMm"]}mm {name} is not clear')
report['failures'] = failures
output = ROOT/'docs/puretv-geometry-confirm-cavity-repair.json'
output.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=audit.clean)+'\n')
if failures:
    raise RuntimeError('Cavity candidate rejected: '+str(failures))
candidate = SCRATCH/'puretv-confirm-switch-cavity-candidate.blend'
bpy.ops.wm.save_as_mainfile(filepath=str(candidate), compress=True)
report.update(candidateSha256=sha(candidate), candidateBytes=candidate.stat().st_size)
if args.apply:
    if sha(SOURCE) != before_sha:
        raise RuntimeError('Concurrent source update; refusing overwrite')
    shutil.copy2(candidate, SOURCE)
    report['appliedToSource'] = True
    report['sourceSha256After'] = sha(SOURCE)
output.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=audit.clean)+'\n')
print('CONFIRM-CAVITY', json.dumps({'sourceChanged': args.apply, 'candidateSha256': report['candidateSha256'], 'bodyClearance': report['minimumSampledBodyClearanceMm'], 'topology': after_topology}, ensure_ascii=False), flush=True)
