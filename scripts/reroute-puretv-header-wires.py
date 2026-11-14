"""Route only the PCB-side signal-wire tails around real source obstacles.

Preserves authored header endpoints and all earlier control points. The two
confirmed new switch-leg endpoints are the sole documented endpoint correction.
Default writes a scratch candidate; --apply writes only electronics/harness.blend.
"""
import argparse
import hashlib
import heapq
import importlib.util
import itertools
import json
import math
import shutil
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT/'assets/puretv-controller'
SCRATCH = ROOT.parent/'scratch'
TARGET = SOURCE/'electronics/harness.blend'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--apply', action='store_true')
args = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
spec = importlib.util.spec_from_file_location('audit', ROOT/'scripts/audit-puretv-assembly.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
sha = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
reference_path = ROOT/'docs/puretv-harness-route-reference.json'
reference = json.loads(reference_path.read_text())
before_sha = sha(TARGET)
if before_sha != reference['closedSameRouteSourceSha256']:
    raise RuntimeError('Harness differs from the reviewed closed original route; refusing repeated reroute.')
routes = {route['name']: {**route, 'points': [list(point) for point in route['points']]} for route in reference['routes']}
prefix = {'A · 中央走线 GPIO.002': 7, 'B · 中央走线 GPIO.002': 10,
          'X · 中央走线 GPIO.002': 7, 'Y · 中央走线 GPIO.002': 6,
          '左 · 中央走线 GPIO.002': 7, '右 · 中央走线 GPIO.002': 8,
          '上 · 中央走线 GPIO.002': 11, '下 · 中央走线 GPIO.002': 5}
for name in ['确认 · GPIO.005', '确认 · GND.005']:
    routes[name]['points'][0][2] = 19.250424575805664

# Inventory uses unsimplified sources and the same hash-addressed mesh cache as
# final verification. Planning is not itself the source-mesh acceptance report.
records, files, warnings = audit.inventory(SOURCE, json.loads((SOURCE/'manifest.json').read_text()), SCRATCH/'puretv-assembly-audit-cache')
low, high = np.array([-34., 12., 12.]), np.array([32., 25., 24.])
radius, solid_gap, wire_gap, step = .28, .32, .18, .5
required_solid = radius+solid_gap
obstacles = []
for record in records:
    if record['sourceFile'] == 'electronics/harness.blend':
        continue
    b = record['boundsBlender']
    if np.any(np.asarray(b['max']) < low-required_solid) or np.any(np.asarray(b['min']) > high+required_solid):
        continue
    geometry = audit.Geometry(record, 0)
    obstacles.append(geometry)
print('ROUTING_OBSTACLES', len(obstacles), sum(len(g.faces) for g in obstacles), flush=True)
grid_size = np.floor((high-low)/step).astype(int)
directions = [np.array(v) for v in itertools.product([-1, 0, 1], repeat=3) if any(v)]
physical_cache = {}


def solid_free(point):
    key = tuple(np.round(point, 6))
    if key in physical_cache:
        return physical_cache[key]
    for obstacle in obstacles:
        minimum, maximum = np.asarray(obstacle.bounds['min']), np.asarray(obstacle.bounds['max'])
        if np.any(point < minimum-required_solid) or np.any(point > maximum+required_solid):
            continue
        shifts = [0, .5, 1] if obstacle.record['role'] in audit.MOVING else [0]
        for displacement in shifts:
            probe = Vector(point+[0, 0, displacement])
            hit, normal, face, distance = obstacle.tree.find_nearest(probe)
            if hit is None:
                continue
            if distance < required_solid or (obstacle.closed and (probe-hit).dot(normal)*obstacle.orientation < -1e-5):
                physical_cache[key] = False
                return False
    physical_cache[key] = True
    return True


def wire_segments(current):
    starts, ends, margins = [], [], []
    for name, route in routes.items():
        if name == current:
            continue
        points = route['points']
        if name in prefix and not route.get('routed'):
            points = points[:prefix[name]+1]
        for a, b in zip(points, points[1:]):
            starts.append(a); ends.append(b); margins.append(radius+route['radius']+wire_gap)
    starts, ends = np.asarray(starts), np.asarray(ends)
    return starts, ends-starts, np.asarray(margins)


def route_tail(name):
    old = routes[name]['points']
    start = np.asarray(old[prefix[name]])
    endpoint = np.asarray(old[-1])
    goal = np.array([endpoint[0], endpoint[1], 18.4])
    starts, edges, margins = wire_segments(name)
    lengths = np.maximum(np.einsum('ij,ij->i', edges, edges), 1e-30)
    free_cache = {}

    def free(point):
        key = tuple(np.round(point, 6))
        if key in free_cache:
            return free_cache[key]
        if not solid_free(point):
            free_cache[key] = False
            return False
        t = np.clip(np.einsum('ij,ij->i', point-starts, edges)/lengths, 0, 1)
        valid = bool(np.all(np.linalg.norm(point-(starts+t[:, None]*edges), axis=1) >= margins))
        free_cache[key] = valid
        return valid

    def segment(a, b):
        count = max(1, math.ceil(np.linalg.norm(b-a)/.2))
        return all(free(a+(b-a)*t/count) for t in range(count+1))

    if not free(start) or not free(goal):
        raise RuntimeError(f'{name}: unchanged tail anchor/approach is occupied ({free(start)}, {free(goal)}): {start.tolist()} -> {goal.tolist()}')
    def lattice_entry(point):
        center = np.rint((point-low)/step).astype(int)
        candidates = [center+delta for delta in itertools.product(range(-2, 3), repeat=3)]
        candidates.sort(key=lambda node: np.linalg.norm(low+node*step-point))
        for node in candidates:
            if np.all(node >= 0) and np.all(node <= grid_size) and segment(point, low+node*step):
                return tuple(node)
        raise RuntimeError(f'{name}: endpoint cannot reach neighboring routing lattice: {point.tolist()}')
    start_node, goal_node = lattice_entry(start), lattice_entry(goal)
    costs, previous = {start_node: 0.}, {}
    queue = [(float(np.linalg.norm((np.array(start_node)-goal_node)*step)), 0., start_node)]
    expanded = 0
    while queue:
        _, cost, node = heapq.heappop(queue)
        if cost != costs.get(node):
            continue
        if node == goal_node:
            break
        expanded += 1
        if expanded > 180000:
            raise RuntimeError(f'{name}: routing search exhausted')
        point = low+np.array(node)*step
        for direction in directions:
            neighbor = np.array(node)+direction
            if np.any(neighbor < 0) or np.any(neighbor > grid_size):
                continue
            target = low+neighbor*step
            key = tuple(neighbor)
            proposed = cost+float(np.linalg.norm(direction)*step)
            if proposed >= costs.get(key, math.inf) or not segment(point, target):
                continue
            costs[key], previous[key] = proposed, node
            heapq.heappush(queue, (proposed+float(np.linalg.norm(target-goal)), proposed, key))
    else:
        raise RuntimeError(f'{name}: no collision-free PCB-side path')
    nodes, cursor = [goal_node], goal_node
    while cursor != start_node:
        cursor = previous[cursor]
        nodes.append(cursor)
    raw = [start, *[low+np.asarray(node)*step for node in reversed(nodes)], goal]
    simplified, cursor = [start], 0
    while cursor < len(raw)-1:
        target = len(raw)-1
        while target > cursor+1 and not segment(raw[cursor], raw[target]):
            target -= 1
        simplified.append(raw[target]); cursor = target
    # Interpolate rounded corners inside their original two-segment envelope.
    # Every interpolated segment is collision checked again; retain an original
    # corner if rounding cannot satisfy the same clearances.
    rounded = [simplified[0]]
    for index in range(1, len(simplified)-1):
        before, corner, after = simplified[index-1:index+2]
        incoming, outgoing = corner-before, after-corner
        left, right = np.linalg.norm(incoming), np.linalg.norm(outgoing)
        if min(left, right) < 1e-8:
            continue
        offset = min(1.0, left/3, right/3)
        a, b = corner-incoming/left*offset, corner+outgoing/right*offset
        curve = [(1-t)**2*a+2*t*(1-t)*corner+t*t*b for t in np.linspace(0, 1, 9)]
        if segment(rounded[-1], a) and all(segment(x, y) for x, y in zip(curve, curve[1:])):
            rounded.extend(curve)
        else:
            rounded.append(corner)
    rounded.append(goal)
    result = old[:prefix[name]]+[point.tolist() for point in rounded]+[endpoint.tolist()]
    routes[name].update(points=result, routed=True, preservedPrefixPointCount=prefix[name]+1,
                        planning={'expandedNodes': expanded, 'solidCenterlineMarginMm': required_solid,
                                  'minimumWireSurfaceMarginMm': wire_gap, 'segmentCheckStepMm': .2})
    print('ROUTED', name, 'points', len(result), 'nodes', expanded, flush=True)


plan_file = SCRATCH/'puretv-header-route-plan.json'
planning_hashes = {file['sourceFile']: file['sourceSha256'] for file in files}
if plan_file.exists():
    saved = json.loads(plan_file.read_text())
    if isinstance(saved, dict) and saved.get('planningSourceSha256') == planning_hashes and saved.get('referenceSha256') == sha(reference_path):
        routes.update({route['name']: route for route in saved['routes'] if route.get('routed')})
        print('RESTORED_ROUTES', sum(bool(route.get('routed')) for route in routes.values()), flush=True)

# Short/local paths go first; later paths route around all previously accepted
# paths as well as untouched fixed source prefixes and ground/confirm leads.
for name in ['左 · 中央走线 GPIO.002', 'Y · 中央走线 GPIO.002', '上 · 中央走线 GPIO.002',
             '下 · 中央走线 GPIO.002', 'X · 中央走线 GPIO.002', 'A · 中央走线 GPIO.002',
             'B · 中央走线 GPIO.002', '右 · 中央走线 GPIO.002']:
    if not routes[name].get('routed'):
        route_tail(name)
        plan_file.write_text(json.dumps({'planningSourceSha256': planning_hashes, 'referenceSha256': sha(reference_path), 'routes': list(routes.values())}, ensure_ascii=False, indent=2)+'\n')
original_routes = {route['name']: route for route in reference['routes']}
for name, route in routes.items():
    original = original_routes[name]
    if name in prefix and route['points'][:prefix[name]+1] != original['points'][:prefix[name]+1]:
        raise RuntimeError(f'{name}: source prefix changed')
    if route['points'][-1] != original['points'][-1]:
        raise RuntimeError(f'{name}: header/bus endpoint changed')
    expected_first = list(original['points'][0])
    if name in ['确认 · GPIO.005', '确认 · GND.005']:
        expected_first[2] = 19.250424575805664
    if route['points'][0] != expected_first:
        raise RuntimeError(f'{name}: switch endpoint changed unexpectedly')
bpy.ops.wm.open_mainfile(filepath=str(TARGET))
for collection in list(bpy.data.collections):
    if collection.name.startswith('pureTV') and collection.name not in bpy.context.scene.collection.children:
        bpy.context.scene.collection.children.link(collection)
bpy.context.view_layer.update()
changed = []
for name, route in routes.items():
    if name not in prefix and name not in ['确认 · GPIO.005', '确认 · GND.005']:
        continue
    obj = bpy.data.objects[name]
    materials, properties = list(obj.data.materials), dict(obj.items())
    collections = list(obj.users_collection)
    curve = bpy.data.curves.new(name+' · verified route', 'CURVE')
    curve.dimensions = '3D'; curve.bevel_depth = route['radius']
    # Preserve the authored cross-section tessellation on unchanged prefixes.
    curve.bevel_resolution = 2 if name in prefix else 3
    curve.twist_mode = 'MINIMUM'; curve.use_fill_caps = True
    route['bevelResolution'] = curve.bevel_resolution
    spline = curve.splines.new('POLY'); spline.points.add(len(route['points'])-1)
    for point, coordinate in zip(spline.points, route['points']):
        point.co = (*coordinate, 1)
    temp = bpy.data.objects.new(name+' · route candidate', curve)
    bpy.context.scene.collection.objects.link(temp)
    bpy.context.view_layer.objects.active = temp
    bpy.ops.object.select_all(action='DESELECT'); temp.select_set(True)
    bpy.ops.object.convert(target='MESH')
    temp = bpy.context.object
    mesh = temp.data
    bm = bmesh.new(); bm.from_mesh(mesh)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-6)
    boundary = [edge for edge in bm.edges if edge.is_boundary]
    if boundary:
        bmesh.ops.holes_fill(bm, edges=boundary, sides=0)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    if bm.calc_volume(signed=True) < 0:
        bmesh.ops.reverse_faces(bm, faces=list(bm.faces))
    if any(not edge.is_manifold for edge in bm.edges):
        raise RuntimeError(f'{name}: candidate wire is not closed')
    volume = abs(bm.calc_volume(signed=True)); bm.to_mesh(mesh); bm.free()
    obj.data = mesh; obj.matrix_world = Matrix.Identity(4); obj.modifiers.clear()
    for material in materials:
        obj.data.materials.append(material)
    for key, value in properties.items():
        obj[key] = value
    obj['routeControlPointsSourceMm'] = json.dumps(route['points'])
    obj['routeReferenceSha256'] = sha(reference_path)
    bpy.data.objects.remove(temp, do_unlink=True)
    route['closedVolumeMm3'] = volume
    changed.append(name)
bpy.context.view_layer.update()
candidate = SCRATCH/'puretv-harness-routed-candidate.blend'
bpy.ops.wm.save_as_mainfile(filepath=str(candidate), check_existing=False)
candidate_sha = sha(candidate)
report = {'schemaVersion': 1, 'status': 'candidate-needs-source-mesh-validation', 'sourceFile': 'electronics/harness.blend',
          'beforeSha256': before_sha, 'sourceSha256': candidate_sha, 'routeReferenceSha256': sha(reference_path),
          'coordinates': 'Source millimetres, Z up.', 'changedObjects': changed,
          'planningSourceSha256': {file['sourceFile']: file['sourceSha256'] for file in files},
          'routes': [{**route, 'endpoints': [route['points'][0], route['points'][-1]]} for route in routes.values()],
          'limits': ['Collision-checked centerline planning is a construction aid, not final source-mesh certification.',
                     'The full triangle/BVH and bounded containment audit must validate the resulting closed tube meshes before release.',
                     'Rerouted signal/confirm leads retain nominal 0.56 mm diameter; the unchanged GND bus retains 0.76 mm. Actual bend radius, insulation and solder dimensions require physical confirmation.']}
output = SCRATCH/'puretv-geometry-harness-routing-candidate.json'
if args.apply:
    backup = SCRATCH/'puretv-harness-before-pcb-routing.blend'
    if not backup.exists():
        shutil.copy2(TARGET, backup)
    if sha(TARGET) != before_sha:
        raise RuntimeError('Harness changed concurrently; refusing save')
    shutil.copy2(candidate, TARGET)
    report['status'] = 'applied-pending-full-source-audit'
    output = ROOT/'docs/puretv-geometry-harness-routing.json'
output.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
print('ROUTE_CANDIDATE', candidate_sha, 'changed', len(changed), flush=True)
