"""Read-only full-resolution pureTV assembly audit (Blender 5.2+).

blender -b --threads 2 --python scripts/audit-puretv-assembly.py -- \
  --output docs/puretv-geometry-assembly.json

All manifest collections are evaluated without decimation. Inventory arrays are cached
by source SHA outside the repository; a triangle-budget LRU prevents nine 2M-triangle
sleeves from remaining resident. Every rest pair and every active-key/environment pair
is considered. AABB-separated pairs are counted; candidate pairs use complete BVHs.
Discrete poses and bounded containment witnesses are explicitly NOT a CCD/FEA or
manufacturing-clearance certificate. Unclassified contact remains unknown.
"""
import argparse
from collections import Counter, OrderedDict
import gc
import hashlib
import itertools
import json
import math
from pathlib import Path
import sys
import time

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[1]
EPS = 1e-5
CACHE_VERSION = 3
DIRECTIONS = [Vector(v).normalized() for v in ((.731, .371, .573), (-.431, .811, .391), (.213, -.579, .787))]
MOVING = {'cap', 'label', 'spring-seat', 'spring', 'switch-actuator'}


def digest(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def native(value):
    if isinstance(value, np.ndarray): return value.tolist()
    if isinstance(value, (np.floating, np.integer, np.bool_)): return value.item()
    raise TypeError(type(value))


def dump(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, default=native) + '\n')
    temporary.replace(path)


def rounded(value): return [round(float(v), 8) for v in value]
def client(point): return [float(point[0]), float(point[2]), float(-point[1])]
def bounds(vertices): return {'min': rounded(vertices.min(axis=0)), 'max': rounded(vertices.max(axis=0))}
def overlap_bounds(a, b): return bool(np.all(np.asarray(a['max']) >= np.asarray(b['min']) - EPS) and np.all(np.asarray(b['max']) >= np.asarray(a['min']) - EPS))
def box_region(a, b): return {'min': np.maximum(a['min'], b['min']).tolist(), 'max': np.minimum(a['max'], b['max']).tolist()}


def role(name, relative):
    if not relative.startswith('buttons/'): return 'fixed'
    if '标识' in name: return 'label'
    if '键帽' in name: return 'cap'
    if '回位弹簧' in name or '回弹压簧' in name: return 'spring'
    if '弹簧定位环' in name: return 'spring-seat'
    if '按杆' in name or '开关触头' in name: return 'switch-actuator'
    return 'fixed'


def surface_definition(obj, relative):
    # These four authored FONT objects are planar lettering, not damaged solids.
    # A different open mesh does not inherit this declaration by name or type.
    keys = {'buttons/a.blend': 'A', 'buttons/b.blend': 'B', 'buttons/x.blend': 'X', 'buttons/y.blend': 'Y'}
    key = keys.get(relative)
    if key and obj.name == f'键帽标识 · {key}.002' and obj.type == 'FONT' and obj.data.extrude == 0 and obj.data.bevel_depth == 0:
        return {'kind': 'zero-thickness-lettering',
                'basis': 'Exact source FONT definition has zero extrusion and zero bevel; it is a moving decorative surface, not a volumetric material.',
                'sourceFontExtrude': float(obj.data.extrude), 'sourceFontBevelDepth': float(obj.data.bevel_depth),
                'collisionScope': 'All source triangles and surface-inside-solid probes remain checked; reverse solid-inside-lettering containment is explicitly not applicable.'}
    return {'kind': 'solid-volume-candidate'}


def component_representatives(mesh):
    """Use Blender's native mesh-island field; no million-vertex Python union graph."""
    group = bpy.data.node_groups.get('_puretv_audit_islands')
    if group is None:
        group = bpy.data.node_groups.new('_puretv_audit_islands', 'GeometryNodeTree')
        group.interface.new_socket(name='Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
        group.interface.new_socket(name='Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
        incoming = group.nodes.new('NodeGroupInput')
        outgoing = group.nodes.new('NodeGroupOutput')
        islands = group.nodes.new('GeometryNodeInputMeshIsland')
        store = group.nodes.new('GeometryNodeStoreNamedAttribute')
        store.data_type, store.domain = 'INT', 'POINT'
        store.inputs['Name'].default_value = '_puretv_audit_island'
        group.links.new(incoming.outputs['Geometry'], store.inputs['Geometry'])
        group.links.new(islands.outputs['Island Index'], store.inputs['Value'])
        group.links.new(store.outputs['Geometry'], outgoing.inputs['Geometry'])
    temporary = bpy.data.objects.new('_puretv_audit_mesh', mesh)
    bpy.context.scene.collection.objects.link(temporary)
    modifier = temporary.modifiers.new('_puretv_audit_islands', 'NODES')
    modifier.node_group = group
    bpy.context.view_layer.update()
    graph = bpy.context.evaluated_depsgraph_get()
    evaluated = temporary.evaluated_get(graph)
    result = evaluated.to_mesh(preserve_all_data_layers=True, depsgraph=graph)
    try:
        attribute = result.attributes.get('_puretv_audit_island')
        if attribute is None or len(result.vertices) != len(mesh.vertices):
            raise RuntimeError('Native mesh-island attribute unavailable; cannot claim complete component coverage')
        labels = np.empty(len(result.vertices), dtype=np.int32)
        attribute.data.foreach_get('value', labels)
        _, indices = np.unique(labels, return_index=True)
        return indices.tolist()
    finally:
        evaluated.to_mesh_clear()
        bpy.data.objects.remove(temporary, do_unlink=True)


def topology(mesh):
    loops = np.empty(len(mesh.loops), dtype=np.int32)
    mesh.loops.foreach_get('edge_index', loops)
    counts = np.bincount(loops, minlength=len(mesh.edges))
    edge_vertices = np.empty(len(mesh.edges) * 2, dtype=np.int32)
    mesh.edges.foreach_get('vertices', edge_vertices)
    edge_vertices = edge_vertices.reshape((-1, 2))
    loop_vertices = np.empty(len(mesh.loops), dtype=np.int32)
    mesh.loops.foreach_get('vertex_index', loop_vertices)
    signs = np.where(loop_vertices == edge_vertices[loops, 0], 1, -1)
    winding = np.bincount(loops, weights=signs, minlength=len(mesh.edges))
    return {'boundaryEdges': int(np.count_nonzero(counts == 1)),
            'nonManifoldEdges': int(np.count_nonzero(counts != 2)),
            'inconsistentWindingEdges': int(np.count_nonzero((counts == 2) & (winding != 0))),
            'closedConsistentlyOriented': bool(len(counts) and np.all(counts == 2) and np.all(winding == 0))}


def extract(obj, relative, source_sha, cache):
    key = hashlib.sha256(f'{CACHE_VERSION}:{source_sha}:{relative}:{obj.name}'.encode()).hexdigest()
    directory = cache / key
    metadata_file = directory / 'metadata.json'
    if metadata_file.exists():
        result = json.loads(metadata_file.read_text())
        result['geometrySemantics'] = surface_definition(obj, relative)
        if not (directory / 'geometry.npz').exists():
            np.savez_compressed(directory / 'geometry.npz',
                                vertices=np.load(directory / 'vertices.npy'),
                                triangles=np.load(directory / 'triangles.npy'))
            (directory / 'vertices.npy').unlink()
            (directory / 'triangles.npy').unlink()
        result['cacheDirectory'] = str(directory)
        return result
    graph = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(graph), depsgraph=graph)
    try:
        mesh.calc_loop_triangles()
        local = np.empty(len(mesh.vertices) * 3, dtype=np.float64)
        mesh.vertices.foreach_get('co', local)
        matrix = np.asarray(obj.matrix_world, dtype=np.float64)
        vertices = local.reshape((-1, 3)) @ matrix[:3, :3].T + matrix[:3, 3]
        faces = np.empty(len(mesh.loop_triangles) * 3, dtype=np.int32)
        mesh.loop_triangles.foreach_get('vertices', faces)
        faces = faces.reshape((-1, 3))
        if not len(vertices) or not len(faces) or not np.isfinite(vertices).all():
            raise RuntimeError(f'Invalid or empty source mesh: {relative}:{obj.name}')
        volume = 0.0
        for start in range(0, len(faces), 65536):
            triangles = vertices[faces[start:start+65536]]
            volume += float(np.einsum('ij,ij->i', triangles[:, 0], np.cross(triangles[:, 1], triangles[:, 2])).sum() / 6)
        reps = component_representatives(mesh)
        result = {'id': f'{relative}::{obj.name}', 'sourceFile': relative, 'sourceName': obj.name,
                  'sourceSha256': source_sha, 'sourceType': obj.type,
                  'collections': sorted(collection.name for collection in obj.users_collection),
                  'role': role(obj.name, relative), 'key': Path(relative).stem if relative.startswith('buttons/') else None,
                  'vertices': len(vertices), 'triangles': len(faces), 'boundsBlender': bounds(vertices),
                  'componentCount': len(reps), 'componentRepresentativeVertices': reps,
                  'topology': topology(mesh), 'signedVolumeMm3': volume,
                  'worldMatrix': [list(row) for row in obj.matrix_world]}
        result['geometrySemantics'] = surface_definition(obj, relative)
        directory.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(directory / 'geometry.npz', vertices=vertices, triangles=faces)
        dump(metadata_file, result)
        result['cacheDirectory'] = str(directory)
        return result
    finally:
        bpy.data.meshes.remove(mesh)


def inventory(source, manifest, cache):
    objects, files, warnings = [], [], []
    for entry in manifest['assets']:
        relative = entry['file']
        path = source / relative
        before = digest(path)
        bpy.ops.wm.read_factory_settings(use_empty=True)
        with bpy.data.libraries.load(str(path), link=False) as (available, loaded):
            collections, available_names = list(available.collections), list(available.objects)
            loaded.collections = list(collections)
        for collection in loaded.collections:
            if collection.name not in bpy.context.scene.collection.children:
                bpy.context.scene.collection.children.link(collection)
        bpy.context.view_layer.update()
        geometric = [obj for obj in bpy.context.scene.objects if obj.type in {'MESH', 'CURVE', 'SURFACE', 'FONT'}]
        expected = {obj['exported'] for obj in entry['objects']}
        actual = {obj.name for obj in geometric}
        mismatch = {'missingManifestObjects': sorted(expected - actual), 'unlistedSourceObjects': sorted(actual - expected),
                    'objectsOutsideCollections': sorted(set(available_names) - {obj.name for obj in bpy.context.scene.objects})}
        if any(mismatch.values()) or before != entry['sha256']:
            warnings.append({'sourceFile': relative, 'manifestSha256Matches': before == entry['sha256'], **mismatch})
        for obj in sorted(geometric, key=lambda obj: obj.name):
            record = extract(obj, relative, before, cache)
            objects.append(record)
            print('INVENTORY', relative, obj.name, record['triangles'], 'triangles', record['topology'], flush=True)
        if digest(path) != before:
            raise RuntimeError(f'Source changed during inventory: {relative}; rerun against a stable snapshot')
        files.append({'sourceFile': relative, 'sourceSha256': before, 'manifestSha256': entry['sha256'],
                      'collections': collections, 'sourceObjectCount': len(available_names), 'auditedMeshObjectCount': len(geometric), **mismatch})
        del geometric
        bpy.ops.wm.read_factory_settings(use_empty=True)
        gc.collect()
    return objects, files, warnings


def motion_distance(obj, active_key, stroke, pretravel):
    if obj['key'] != active_key or obj['role'] not in MOVING: return 0.0
    return max(0.0, stroke - pretravel) if obj['role'] == 'switch-actuator' else stroke


def moved_bounds(obj, amount):
    result = {axis: list(values) for axis, values in obj['boundsBlender'].items()}
    result['max'][2] -= amount
    if obj['role'] != 'spring': result['min'][2] -= amount
    return result


class Geometry:
    def __init__(self, record, amount):
        directory = Path(record['cacheDirectory'])
        self.record, self.amount = record, amount
        with np.load(directory / 'geometry.npz') as stored:
            self.vertices = stored['vertices']
            self.faces = stored['triangles']
        if amount:
            self.vertices = self.vertices.copy()
            if record['role'] == 'spring':
                bottom, top = record['boundsBlender']['min'][2], record['boundsBlender']['max'][2]
                if amount >= top - bottom: raise RuntimeError('Compression collapses the source spring below zero length')
                self.vertices[:, 2] = bottom + (self.vertices[:, 2] - bottom) * (1 - amount / (top - bottom))
            else: self.vertices[:, 2] -= amount
        self.bounds = moved_bounds(record, amount)
        self.tree = BVHTree.FromPolygons(self.vertices.tolist(), self.faces.tolist(), all_triangles=True, epsilon=0)
        self.orientation = 1 if record['signedVolumeMm3'] >= 0 else -1
        self.closed = record['topology']['closedConsistentlyOriented'] and abs(record['signedVolumeMm3']) > EPS
        self.surface_only = record.get('geometrySemantics', {}).get('kind') == 'zero-thickness-lettering'


class GeometryCache:
    def __init__(self, budget):
        self.budget, self.entries, self.triangles, self.peak, self.loads = budget, OrderedDict(), 0, 0, 0
    def get(self, record, amount):
        key = (record['id'], amount)
        if key in self.entries:
            self.entries.move_to_end(key)
            return self.entries[key]
        while self.entries and self.triangles + record['triangles'] > self.budget:
            _, old = self.entries.popitem(last=False)
            self.triangles -= old.record['triangles']
            del old
            gc.collect()
        result = Geometry(record, amount)
        self.entries[key] = result
        self.triangles += record['triangles']
        self.peak = max(self.peak, self.triangles)
        self.loads += 1
        return result


def points_on_triangles(point, triangles, tolerance=EPS):
    """Double-precision plane and projected-edge test, in source millimetres.

    Blender's single-precision closest-point routine can select a neighbouring
    skinny triangle and report a nonzero lateral distance on an exactly coplanar
    support face. Never interpret that lateral error as material penetration.
    """
    edges = np.roll(triangles, -1, axis=1) - triangles
    normals = np.cross(edges[:, 0], -edges[:, 2])
    lengths = np.linalg.norm(normals, axis=1)
    valid = lengths > 1e-16
    safe = np.where(valid, lengths, 1.0)
    unit = normals / safe[:, None]
    plane_distance = np.einsum('ij,ij->i', point-triangles[:, 0], unit)
    projected = point - plane_distance[:, None]*unit
    sides = np.einsum('ijk,ik->ij', np.cross(edges, projected[:, None, :]-triangles), unit)
    return valid & (np.abs(plane_distance) <= tolerance) & np.all(sides >= -tolerance*np.linalg.norm(edges, axis=2), axis=1)


class ExactSurfaceIndex:
    """Conservative triangle-AABB grid; complete, with bounded membership memory.

    Large triangles are retained in a separate list, never discarded. All grid
    boxes are expanded by EPS, so boundary cells cannot hide a surface candidate.
    Exact plane/edge tests use original float64 source vertices, not BVH results.
    """
    def __init__(self, geometry):
        self.geometry = geometry
        self.origin = np.asarray(geometry.bounds['min'], dtype=np.float64)-EPS*2
        extent = np.maximum(np.asarray(geometry.bounds['max'])-self.origin+EPS*2, EPS*4)
        resolution = 16
        while True:
            scale = resolution / extent
            low = np.empty((len(geometry.faces), 3), dtype=np.int16)
            high = np.empty_like(low)
            for start in range(0, len(geometry.faces), 65536):
                end = min(start+65536, len(geometry.faces))
                triangles = geometry.vertices[geometry.faces[start:end]]
                low[start:end] = np.clip(np.floor((triangles.min(axis=1)-EPS-self.origin)*scale), 0, resolution-1)
                high[start:end] = np.clip(np.floor((triangles.max(axis=1)+EPS-self.origin)*scale), 0, resolution-1)
            spans = (high-low+1).astype(np.int32)
            counts = np.prod(spans, axis=1)
            small = counts <= 64
            if int(counts[small].sum()) <= 8000000 or resolution == 1: break
            resolution //= 2
        self.resolution, self.scale = resolution, scale
        self.large = np.flatnonzero(~small).astype(np.int32)
        selected = np.flatnonzero(small).astype(np.int32)
        repeated = np.repeat(selected, counts[selected])
        starts = np.repeat(np.cumsum(counts[selected])-counts[selected], counts[selected])
        ranks = np.arange(len(repeated), dtype=np.int32)-starts
        widths = spans[repeated]
        cells = low[repeated].astype(np.int32)
        cells[:, 0] += ranks % widths[:, 0]
        cells[:, 1] += (ranks // widths[:, 0]) % widths[:, 1]
        cells[:, 2] += ranks // (widths[:, 0]*widths[:, 1])
        codes = cells[:, 0] + resolution*(cells[:, 1]+resolution*cells[:, 2])
        order = np.argsort(codes, kind='stable')
        self.faces = repeated[order]
        self.offsets = np.concatenate(([0], np.cumsum(np.bincount(codes, minlength=resolution**3))))

    def ray_candidates(self, point, direction):
        codes = np.flatnonzero(np.diff(self.offsets))
        cells = np.column_stack((codes % self.resolution, (codes//self.resolution) % self.resolution, codes//self.resolution**2))
        low = self.origin + cells/self.scale
        high = self.origin + (cells+1)/self.scale
        first, second = (low-point)/direction, (high-point)/direction
        enter, leave = np.minimum(first, second).max(axis=1), np.maximum(first, second).min(axis=1)
        crossed = codes[(leave >= np.maximum(enter, 0))]
        chunks = [self.faces[self.offsets[code]:self.offsets[code+1]] for code in crossed]
        if len(self.large): chunks.append(self.large)
        return np.unique(np.concatenate(chunks)) if chunks else np.array([], dtype=np.int32)

    def box_candidates(self, low, high):
        lower = np.clip(np.floor((low-self.origin)*self.scale),0,self.resolution-1).astype(int)
        upper = np.clip(np.floor((high-self.origin)*self.scale),0,self.resolution-1).astype(int)
        codes = [x+self.resolution*(y+self.resolution*z) for x in range(lower[0],upper[0]+1)
                 for y in range(lower[1],upper[1]+1) for z in range(lower[2],upper[2]+1)]
        chunks = [self.faces[self.offsets[code]:self.offsets[code+1]] for code in codes]
        if len(self.large): chunks.append(self.large)
        return np.unique(np.concatenate(chunks)) if chunks else np.array([],dtype=np.int32)

    def find(self, point):
        cell = np.clip(np.floor((point-self.origin)*self.scale), 0, self.resolution-1).astype(np.int32)
        code = int(cell[0]+self.resolution*(cell[1]+self.resolution*cell[2]))
        candidates = self.faces[self.offsets[code]:self.offsets[code+1]]
        if len(self.large): candidates = np.concatenate((candidates, self.large))
        for start in range(0, len(candidates), 4096):
            indices = candidates[start:start+4096]
            triangles = self.geometry.vertices[self.geometry.faces[indices]]
            in_box = np.all(point >= triangles.min(axis=1)-EPS, axis=1) & np.all(point <= triangles.max(axis=1)+EPS, axis=1)
            if not in_box.any(): continue
            indices, triangles = indices[in_box], triangles[in_box]
            hits = np.flatnonzero(points_on_triangles(point, triangles))
            if len(hits): return int(indices[hits[0]])
        return None


def exact_surface_face(target, point, nearest=None):
    point = np.asarray(point, dtype=np.float64)
    if nearest is not None and nearest[2] is not None:
        face = int(nearest[2])
        if points_on_triangles(point, target.vertices[target.faces[[face]]])[0]: return face
    if not hasattr(target, '_exact_surface_index'):
        target._exact_surface_index = ExactSurfaceIndex(target)
    return target._exact_surface_index.find(point)


def exact_winding_inside(target, point):
    """Complete float64 ray/triangle fallback when Blender ray votes disagree."""
    if not hasattr(target, '_exact_surface_index'):
        target._exact_surface_index = ExactSurfaceIndex(target)
    point = np.asarray(point, dtype=np.float64)
    votes = []
    for raw_direction in DIRECTIONS:
        direction = np.asarray(raw_direction, dtype=np.float64)
        indices = target._exact_surface_index.ray_candidates(point, direction)
        hits = []
        for start in range(0, len(indices), 8192):
            triangles = target.vertices[target.faces[indices[start:start+8192]]]
            normals = np.cross(triangles[:, 1]-triangles[:, 0], triangles[:, 2]-triangles[:, 0])
            lengths = np.linalg.norm(normals, axis=1)
            denominators = normals @ direction
            valid = np.abs(denominators) > np.maximum(lengths*1e-12, 1e-16)
            triangles, normals, denominators = triangles[valid], normals[valid], denominators[valid]
            distances = np.einsum('ij,ij->i', triangles[:, 0]-point, normals)/denominators
            valid = distances > EPS
            triangles, denominators, distances = triangles[valid], denominators[valid], distances[valid]
            locations = point + distances[:, None]*direction
            hit = points_on_triangles(locations, triangles, tolerance=1e-8)
            hits.extend(zip(distances[hit].tolist(), np.sign(denominators[hit]*target.orientation).astype(int).tolist()))
        hits.sort()
        winding, cursor = 0, 0
        while cursor < len(hits):
            end = cursor+1
            while end < len(hits) and hits[end][0]-hits[cursor][0] <= EPS: end += 1
            signs = {sign for _, sign in hits[cursor:end]}
            winding += next(iter(signs)) if len(signs) == 1 else 0
            cursor = end
        votes.append(winding > 0)
    return votes[0] if all(value == votes[0] for value in votes) else None


def winding_inside(target, point):
    if not target.closed: return None
    votes = []
    for direction in DIRECTIONS:
        cursor = Vector(point) + direction * EPS
        winding = 0
        for _ in range(256):
            hit, normal, index, distance = target.tree.ray_cast(cursor, direction, 2000)
            if hit is None: break
            facing = normal.dot(direction) * target.orientation
            if abs(facing) > 1e-6: winding += 1 if facing > 0 else -1
            cursor = hit + direction * EPS
        else: return None
        votes.append(winding > 0)
    return votes[0] if all(value == votes[0] for value in votes) else exact_winding_inside(target, point)


def evidence(source, target, crossed_faces, max_samples):
    representatives = np.asarray(source.record['componentRepresentativeVertices'], dtype=np.int32)
    nearby = np.flatnonzero(np.all(source.vertices >= np.asarray(target.bounds['min']) - EPS, axis=1) & np.all(source.vertices <= np.asarray(target.bounds['max']) + EPS, axis=1)) if crossed_faces else np.array([], dtype=np.int32)
    if len(nearby) > max_samples:
        nearby = nearby[np.linspace(0, len(nearby)-1, max_samples, dtype=int)]
    indices = np.unique(np.concatenate((representatives, nearby)))
    points = source.vertices[indices]
    if crossed_faces:
        faces = np.asarray(sorted(set(crossed_faces)), dtype=np.int32)
        if len(faces) > max_samples // 2:
            faces = faces[np.linspace(0, len(faces)-1, max_samples//2, dtype=int)]
        points = np.concatenate((points, source.vertices[source.faces[faces]].mean(axis=1)))
    result = {'testedPoints': 0, 'insidePoints': 0, 'surfacePoints': 0, 'uncertainPoints': 0,
              'allSourceComponentsRepresented': len(representatives) == source.record['componentCount'],
              'targetClosedConsistentlyOriented': target.closed, 'maximumSampledDepthMm': 0.0, 'insideExamples': [], 'uncertainExamples': []}
    if getattr(target, 'surface_only', False):
        result['containmentNotApplicable'] = 'Target is explicitly declared zero-thickness source lettering. Its complete surface-triangle intersection test is still performed.'
        return result, []
    inside_points = []
    for point in points:
        if np.any(point < np.asarray(target.bounds['min']) - EPS) or np.any(point > np.asarray(target.bounds['max']) + EPS): continue
        result['testedPoints'] += 1
        nearest = target.tree.find_nearest(Vector(point))
        if nearest[0] is None:
            result['uncertainPoints'] += 1
            continue
        depth = float(nearest[3])
        if exact_surface_face(target, point, nearest) is not None:
            result['surfacePoints'] += 1
            continue
        # All selected points receive oriented three-ray votes; no nearest-normal shortcut.
        inside = winding_inside(target, point)
        if inside is None:
            result['uncertainPoints'] += 1
            if len(result['uncertainExamples']) < 4: result['uncertainExamples'].append({'pointBlender': rounded(point), 'pointClient': client(point)})
        elif inside:
            result['insidePoints'] += 1
            result['maximumSampledDepthMm'] = max(result['maximumSampledDepthMm'], depth)
            inside_points.append(np.asarray(point))
            if len(result['insideExamples']) < 8:
                result['insideExamples'].append({'pointBlender': rounded(point), 'pointClient': client(point), 'nearestSurfaceDistanceMm': depth, 'targetTriangle': int(nearest[2])})
    return result, inside_points


def audit_pair(a, b, max_samples):
    pairs = a.tree.overlap(b.tree)
    first, first_points = evidence(a, b, [left for left, _ in pairs], max_samples)
    second, second_points = evidence(b, a, [right for _, right in pairs], max_samples)
    penetration = first['insidePoints'] or second['insidePoints']
    uncertain = first['uncertainPoints'] or second['uncertainPoints'] or any(not item.closed and not getattr(item, 'surface_only', False) for item in (a, b))
    surface = first['surfacePoints'] or second['surfacePoints']
    status = 'penetration-evidence' if penetration else 'unknown-contact-or-crossing' if pairs or surface else 'unknown-containment' if uncertain else 'no-intersection-observed'
    result = {'status': status, 'surfaceTrianglePairs': len(pairs), 'aInsideB': first, 'bInsideA': second,
              'geometrySemantics': {'a': a.record.get('geometrySemantics', {'kind': 'solid-volume-candidate'}), 'b': b.record.get('geometrySemantics', {'kind': 'solid-volume-candidate'})},
              'possibleOverlapBoundsBlender': box_region(a.bounds, b.bounds),
              'maximumSampledPenetrationMm': max(first['maximumSampledDepthMm'], second['maximumSampledDepthMm'])}
    if pairs:
        pair_array = np.asarray(pairs, dtype=np.int32)
        lows, highs = [], []
        for start in range(0, len(pair_array), 32768):
            batch = pair_array[start:start+32768]
            va, vb = a.vertices[a.faces[batch[:, 0]]], b.vertices[b.faces[batch[:, 1]]]
            lows.append(np.maximum(va.min(axis=1), vb.min(axis=1)).min(axis=0))
            highs.append(np.minimum(va.max(axis=1), vb.max(axis=1)).max(axis=0))
        result['conservativeCrossingRegionBlender'] = {'min': rounded(np.min(lows, axis=0)), 'max': rounded(np.max(highs, axis=0))}
        result['sourceTrianglePairExamples'] = pair_array[:8].tolist()
    return result


def triangle_intersection_points(first, second, tolerance=EPS):
    """Exact float64 convex triangle contact support, including coplanar faces."""
    normals = [np.cross(triangle[1]-triangle[0], triangle[2]-triangle[0]) for triangle in (first, second)]
    lengths = [np.linalg.norm(normal) for normal in normals]
    if min(lengths) <= 1e-16: return None
    normals = [normal/length for normal, length in zip(normals, lengths)]
    if np.linalg.norm(np.cross(*normals)) < 1e-10:
        if np.max(np.abs((first-second[0]) @ normals[1])) > tolerance: return np.empty((0,3))
        polygon = [point.copy() for point in first]
        for index in range(3):
            if not polygon: break
            origin, edge = second[index], second[(index+1)%3]-second[index]
            normal = np.cross(normals[1], edge)
            normal /= np.linalg.norm(normal)
            clipped = []
            for start, end in zip(polygon, polygon[1:]+polygon[:1]):
                da, db = (start-origin) @ normal, (end-origin) @ normal
                if da >= -tolerance: clipped.append(start)
                if (da >= -tolerance) != (db >= -tolerance) and abs(da-db) > 1e-16:
                    clipped.append(start + (end-start)*(da/(da-db)))
            polygon = clipped
        return np.asarray(polygon).reshape((-1,3))
    points = []
    for triangle, target, normal in ((first,second,normals[1]),(second,first,normals[0])):
        distances = (triangle-target[0]) @ normal
        for index in range(3):
            start, end = triangle[index], triangle[(index+1)%3]
            da, db = distances[index], distances[(index+1)%3]
            if abs(da) <= tolerance and points_on_triangles(start,target[None,:,:],tolerance=tolerance)[0]: points.append(start)
            if da*db < 0:
                point = start+(end-start)*(da/(da-db))
                if points_on_triangles(point,target[None,:,:],tolerance=tolerance)[0]: points.append(point)
    return np.asarray(points).reshape((-1,3))


def audit_self_intersections(geometry, tolerance=1e-8, shared_feature_tolerance=1e-7):
    """Complete source triangle self-check, not merely a watertightness check.

    Sharing a vertex/edge does not exempt the whole triangle pair. Only the actual
    common topological feature may touch; crossing elsewhere is still forbidden.
    """
    pairs=geometry.tree.overlap(geometry.tree)
    result={'status':'pending','fullTriangleCount':len(geometry.faces),'rawBvhTrianglePairs':len(pairs),
            'uniqueTrianglePairs':0,'examinedUniqueTrianglePairs':0,'sharedFeatureContactPairs':0,
            'disjointExactPairs':0,'forbiddenTriangleIntersections':0,'unknownTrianglePairs':0,
            'degenerateTriangles':0,'topologyAccepted':bool(geometry.closed and geometry.record['componentCount']==1),
            'intersectionToleranceMm':tolerance,'sharedFeatureToleranceMm':shared_feature_tolerance,'examples':[]}
    for start in range(0,len(geometry.faces),65536):
        triangles=geometry.vertices[geometry.faces[start:start+65536]]
        area=np.linalg.norm(np.cross(triangles[:,1]-triangles[:,0],triangles[:,2]-triangles[:,0]),axis=1)
        result['degenerateTriangles']+=int(np.count_nonzero(area<=1e-16))
    for first,second in pairs:
        if first>=second:continue
        result['uniqueTrianglePairs']+=1
        result['examinedUniqueTrianglePairs']+=1
        face_a,face_b=geometry.faces[first],geometry.faces[second]
        shared=sorted(set(face_a)&set(face_b))
        points=triangle_intersection_points(geometry.vertices[face_a],geometry.vertices[face_b],tolerance=tolerance)
        if points is None:
            result['unknownTrianglePairs']+=1
            continue
        if not len(points):
            result['disjointExactPairs']+=1
            continue
        permitted=False
        if len(shared)==1:
            permitted=bool(np.all(np.linalg.norm(points-geometry.vertices[shared[0]],axis=1)<=shared_feature_tolerance))
        elif len(shared)==2:
            origin,end=geometry.vertices[shared]
            edge=end-origin;length=float(edge@edge)
            if length>1e-30:
                parameter=np.clip(((points-origin)@edge)/length,0,1)
                permitted=bool(np.all(np.linalg.norm(points-(origin+parameter[:,None]*edge),axis=1)<=shared_feature_tolerance))
        if permitted:result['sharedFeatureContactPairs']+=1
        else:
            result['forbiddenTriangleIntersections']+=1
            if len(result['examples'])<8:
                result['examples'].append({'triangles':[int(first),int(second)],'sharedVertexIndices':[int(value) for value in shared],
                                           'intersectionPointsBlender':points.tolist(),
                                           'reason':'Intersection exceeds the actual common topological feature' if shared else 'Non-adjacent source triangles intersect'})
    passed=result['topologyAccepted'] and not any(result[key] for key in ('forbiddenTriangleIntersections','unknownTrianglePairs','degenerateTriangles'))
    result['status']='pass' if passed else 'fail'
    return result


def prove_local_region(result, a, b, region, maximum_vertices=20000):
    """Avoid classifying a hollow part's entire AABB as actual material contact.

    Polyhedral intersection extrema are input vertices inside the other solid or
    intersecting triangle edges. Complete surface-pair AABB intersections give a
    conservative bound for the latter. The fallback exhaustively classifies every
    input vertex in the other AABB (never a bounded sampling pass).
    """
    regions = region if isinstance(region, list) else [region]
    def within(box):
        return any(bool(np.all(np.asarray(box['min']) >= item['min']-EPS) and np.all(np.asarray(box['max']) <= item['max']+EPS)) for item in regions)
    def point_within(point):
        return any(np.all(point >= item['min']-EPS) and np.all(point <= item['max']+EPS) for item in regions)
    if within(result['possibleOverlapBoundsBlender']):
        return {'proven': True, 'method': 'entire possible object-AABB overlap is in the declared local region', 'exhaustiveVertices': 0}
    crossing = result.get('conservativeCrossingRegionBlender')
    exact_pairs = 0
    if crossing and not within(crossing):
        # A union's overall envelope includes the forbidden gap between support
        # patches. Check every triangle contact against ONE complete patch, then
        # clip conservative triangle AABBs only where they are inconclusive.
        for ia, ib in a.tree.overlap(b.tree):
            first, second = a.vertices[a.faces[ia]], b.vertices[b.faces[ib]]
            box = box_region(bounds(first), bounds(second))
            if within(box): continue
            points = triangle_intersection_points(first, second)
            exact_pairs += 1
            if points is None:
                return {'proven': False, 'reason': 'Degenerate triangle prevents complete local contact proof'}
            if len(points) and not within(bounds(points)):
                return {'proven': False, 'reason': 'An exact triangle contact extends outside every declared local patch', 'witnessBlender': rounded(points[0])}
    checked = 0
    for source, target in ((a, b), (b, a)):
        if getattr(target, 'surface_only', False): continue
        if not target.closed:
            return {'proven': False, 'reason': 'An undeclared open target cannot establish a bounded volume interface'}
        indices = np.flatnonzero(np.all(source.vertices >= np.asarray(target.bounds['min'])-EPS, axis=1) & np.all(source.vertices <= np.asarray(target.bounds['max'])+EPS, axis=1))
        if checked + len(indices) > maximum_vertices:
            return {'proven': False, 'reason': 'Exhaustive vertex proof exceeds budget; interface remains unknown', 'requiredVerticesAtLeast': checked+len(indices)}
        for index in indices:
            point = source.vertices[index]
            checked += 1
            nearest = target.tree.find_nearest(Vector(point))
            if nearest[0] is None: return {'proven': False, 'reason': 'Nearest surface query failed'}
            status = True if exact_surface_face(target, point, nearest) is not None else winding_inside(target, point)
            if status is None: return {'proven': False, 'reason': 'Oriented containment votes disagree'}
            if status and not point_within(point):
                return {'proven': False, 'reason': 'An exhaustive inside/boundary vertex lies outside the declared region', 'witnessBlender': rounded(point)}
    return {'proven': True, 'method': 'Every triangle contact bounded by one declared patch; float64 clipping where conservative AABBs exceed a patch; exhaustive bidirectional input-vertex containment', 'exhaustiveVertices': checked, 'exactTrianglePairClips': exact_pairs, 'regionCount': len(regions)}


def clip_polygon_z(points, low, high):
    polygon = list(points)
    for plane,sign in ((low,1),(high,-1)):
        if not polygon: break
        clipped = []
        for start,end in zip(polygon,polygon[1:]+polygon[:1]):
            da,db = (start[2]-plane)*sign,(end[2]-plane)*sign
            if da>=0: clipped.append(start)
            if (da>=0)!=(db>=0) and abs(da-db)>1e-16:
                clipped.append(start+(end-start)*(da/(da-db)))
        polygon = clipped
    return np.asarray(polygon).reshape((-1,3))


def polygon_minimum_radius(points, center):
    points = np.asarray(points)[:,:2]-center
    if not len(points): return math.inf
    if len(points)==1: return float(np.linalg.norm(points[0]))
    following = np.roll(points,-1,axis=0)
    edges = following-points
    lengths = np.einsum('ij,ij->i',edges,edges)
    parameters = np.clip(-np.einsum('ij,ij->i',points,edges)/np.maximum(lengths,1e-30),0,1)
    distance = float(np.linalg.norm(points+parameters[:,None]*edges,axis=1).min())
    area = np.sum(points[:,0]*following[:,1]-points[:,1]*following[:,0])
    sides = edges[:,0]*(-points[:,1])-edges[:,1]*(-points[:,0])
    if abs(area)>1e-16 and (np.all(sides>=-1e-12) or np.all(sides<=1e-12)): return 0.0
    return distance


def prove_annular_region(a,b,declaration,maximum_vertices=20000):
    """Do not silently reduce a declared thread annulus to its enclosing box.

    The outer cylinder is convex: exact triangle-contact vertices and every
    contained input vertex bound the complete polyhedral overlap. The excluded
    inner cylinder must be wholly void in at least one member: no source boundary
    may enter it and a three-ray volume query at its centre must be outside.
    """
    center=np.asarray(declaration['axisCenterSourceXY'],dtype=float)
    inner,outer=float(declaration['innerRadiusMm']),float(declaration['outerRadiusMm'])
    low,high=float(declaration['sourceZMin']),float(declaration['sourceZMax'])
    if not np.isfinite([*center,inner,outer,low,high]).all() or not 0<inner<outer or not low<high:
        return {'proven':False,'reason':'Invalid explicit annular geometry'}
    pairs=a.tree.overlap(b.tree)
    for ia,ib in pairs:
        points=triangle_intersection_points(a.vertices[a.faces[ia]],b.vertices[b.faces[ib]])
        if points is None: return {'proven':False,'reason':'Degenerate source contact triangle'}
        if len(points) and (np.any(np.linalg.norm(points[:,:2]-center,axis=1)>outer+EPS) or np.any(points[:,2]<low-EPS) or np.any(points[:,2]>high+EPS)):
            return {'proven':False,'reason':'Exact triangle contact exceeds outer cylinder or engagement height','witnessBlender':rounded(points[0])}
    checked=0
    for source,target in ((a,b),(b,a)):
        indices=np.flatnonzero(np.all(source.vertices>=np.asarray(target.bounds['min'])-EPS,axis=1)&np.all(source.vertices<=np.asarray(target.bounds['max'])+EPS,axis=1))
        if checked+len(indices)>maximum_vertices:
            return {'proven':False,'reason':'Annular exhaustive vertex proof exceeds budget','requiredVerticesAtLeast':checked+len(indices)}
        for index in indices:
            point=source.vertices[index];checked+=1
            # Vertices already within the convex permitted outer cylinder cannot
            # invalidate this outer bound, so only classify exterior witnesses.
            if np.linalg.norm(point[:2]-center)<=outer+EPS and low-EPS<=point[2]<=high+EPS: continue
            nearest=target.tree.find_nearest(Vector(point))
            status=True if exact_surface_face(target,point,nearest) is not None else winding_inside(target,point)
            if status is None:return {'proven':False,'reason':'Uncertain outer-cylinder vertex containment'}
            if status:return {'proven':False,'reason':'An exhaustive intersection vertex lies outside the declared annulus outer bound','witnessBlender':rounded(point)}
    void_attempts=[]
    for geometry in (a,b):
        point=np.array([center[0],center[1],(low+high)/2])
        if exact_surface_face(geometry,point) is not None or winding_inside(geometry,point) is not False:
            void_attempts.append({'source':geometry.record['id'],'reason':'Inner-cylinder representative is material or uncertain'})
            continue
        index=geometry._exact_surface_index
        candidates=index.box_candidates(np.array([center[0]-inner-EPS,center[1]-inner-EPS,low-EPS]),np.array([center[0]+inner+EPS,center[1]+inner+EPS,high+EPS]))
        examined=0;blocked=None
        for face in candidates:
            triangle=geometry.vertices[geometry.faces[face]]
            if triangle[:,2].max()<low or triangle[:,2].min()>high:continue
            polygon=clip_polygon_z(triangle,low,high)
            if not len(polygon):continue
            examined+=1
            radius=polygon_minimum_radius(polygon,center)
            if radius<inner-EPS:
                blocked={'triangle':int(face),'minimumProjectedRadiusMm':radius};break
        if blocked is None:
            return {'proven':True,'method':'Complete exact intersection extrema fit the outer cylinder/height; one member has no source boundary in the excluded inner cylinder and its cylinder-centre volume test is outside',
                    'emptyInnerCylinderSource':geometry.record['id'],'innerCylinderBoundaryTrianglesExamined':examined,
                    'exhaustiveVertices':checked,'exactTrianglePairs':len(pairs),'annularRegion':declaration}
        void_attempts.append({'source':geometry.record['id'],'reason':'Source boundary enters excluded inner cylinder',**blocked})
    return {'proven':False,'reason':'Neither source proves the declared inner cylinder is empty','attempts':void_attempts}


def default_interfaces(objects, pretravel, overtravel):
    rules = []
    for key in sorted({obj['key'] for obj in objects if obj['key']}):
        group = [obj for obj in objects if obj['key'] == key]
        actuator = next((obj for obj in group if obj['role'] == 'switch-actuator'), None)
        switch = next((obj for obj in group if '6×6 开关' in obj['sourceName'] or '常开开关' in obj['sourceName']), None)
        cap = next((obj for obj in group if obj['role'] == 'cap'), None)
        if not actuator or not switch or not cap: continue
        low, high = actuator['boundsBlender']['min'], actuator['boundsBlender']['max']
        top = switch['boundsBlender']['max'][2]
        rules.append({'id': f'{key}-switch-compliant-interface', 'pair': [actuator['id'], switch['id']],
                      'reason': 'Explicit nominal switch actuator/body compliant interface; body remains fixed and actuator follows only after prescribed pretravel.',
                      'regionBlender': {'min': [low[0]-EPS, low[1]-EPS, top-overtravel-EPS], 'max': [high[0]+EPS, high[1]+EPS, top+EPS]},
                      'maximumPenetrationMm': overtravel + EPS, 'nominalPretravelMm': pretravel, 'nominalOvertravelMm': overtravel})
        rules.append({'id': f'{key}-striker-contact-face', 'pair': [cap['id'], actuator['id']],
                      'reason': 'Explicit striker-to-switch top-face contact; only coincident face contact is allowed, not solid penetration.',
                      'regionBlender': {'min': [low[0]-EPS, low[1]-EPS, high[2]-EPS*5], 'max': [high[0]+EPS, high[1]+EPS, high[2]+EPS*5]},
                      'translateWith': actuator['id'], 'maximumPenetrationMm': EPS*5})
    return rules


def classify_allowed(result, a, b, rules):
    if result['status'] == 'no-intersection-observed': return
    for rule in rules:
        if set(rule['pair']) != {a.record['id'], b.record['id']}: continue
        regions = [{key: np.asarray(value, dtype=float).copy() for key, value in item.items()} for item in rule.get('regionsBlender',[rule['regionBlender']])]
        for geometry in (a, b):
            if rule.get('translateWith') == geometry.record['id']:
                for region in regions:
                    region['min'][2] -= geometry.amount
                    region['max'][2] -= geometry.amount
        proof = prove_local_region(result, a, b, regions)
        within = proof['proven']
        annular_proof = prove_annular_region(a,b,rule['annularRegion']) if within and 'annularRegion' in rule else None
        if annular_proof is not None: within = within and annular_proof['proven']
        depth_ok = result['maximumSampledPenetrationMm'] <= rule.get('maximumPenetrationMm', EPS) + EPS
        topology_ok = all(item.closed or (getattr(item, 'surface_only', False) and rule.get('surfaceAttachment') is True) for item in (a, b))
        if within and depth_ok and topology_ok and not result['aInsideB']['uncertainPoints'] and not result['bInsideA']['uncertainPoints']:
            result['status'] = 'allowed-local-interface'
            result['allowedInterface'] = {'id': rule['id'], 'reason': rule['reason'], 'regionBlenderAtPose': {'min': np.min([item['min'] for item in regions],axis=0),'max': np.max([item['max'] for item in regions],axis=0)}, 'regionsBlenderAtPose': regions,
                                          'maximumPenetrationMm': rule.get('maximumPenetrationMm', EPS),
                                          'localRegionProof': proof,
                                          'scope': 'Proven overlap support is inside the explicitly declared local region; not a kind-wide exclusion.'}
            if annular_proof is not None: result['allowedInterface']['annularRegionProof']=annular_proof
            return
        result.setdefault('interfaceRejected', []).append({'id': rule['id'], 'localRegionProof': proof, 'annularRegionProof':annular_proof, 'sampledDepthWithinAllowance': bool(depth_ok), 'topologyAcceptableForDeclaredInterface': topology_ok})


def plan(objects, strokes, pretravel):
    jobs, coverage = {}, []
    pair_hasher = hashlib.sha256()
    def consider(a, b, da, db, context, counter):
        counter['consideredPairs'] += 1
        token = f"{a['id']}@{da:.8f}|{b['id']}@{db:.8f}"
        pair_hasher.update((context + ':' + token + '\n').encode())
        if not overlap_bounds(moved_bounds(a, da), moved_bounds(b, db)):
            counter['aabbSeparatedPairs'] += 1
            return None
        counter['candidatePairs'] += 1
        check_id = hashlib.sha256(token.encode()).hexdigest()[:24]
        if check_id not in jobs:
            jobs[check_id] = {'id': check_id, 'a': a['id'], 'b': b['id'], 'aMotionMm': da, 'bMotionMm': db, 'contexts': []}
        jobs[check_id]['contexts'].append(context)
        return check_id
    rest = {'scenario': 'rest-all-pairs', 'strokeMm': 0, 'consideredPairs': 0, 'aabbSeparatedPairs': 0, 'candidatePairs': 0}
    for a, b in itertools.combinations(objects, 2): consider(a, b, 0.0, 0.0, 'rest', rest)
    coverage.append(rest)
    for key in sorted({obj['key'] for obj in objects if obj['key']}):
        active_ids = {obj['id'] for obj in objects if obj['key'] == key and obj['role'] in MOVING}
        for stroke in strokes:
            context = f'{key}@{stroke:.8f}'
            counter = {'scenario': f'key-{key}-against-entire-environment', 'strokeMm': stroke, 'activeObjects': sorted(active_ids), 'consideredPairs': 0, 'aabbSeparatedPairs': 0, 'candidatePairs': 0}
            for a, b in itertools.combinations(objects, 2):
                if a['id'] not in active_ids and b['id'] not in active_ids: continue
                consider(a, b, motion_distance(a, key, stroke, pretravel), motion_distance(b, key, stroke, pretravel), context, counter)
            coverage.append(counter)
    # Pairwise geometry depends only on the two members' poses, so the independent
    # 5x5 Cartesian product covers different-key pairs without a 5^9 scene expansion.
    # Within-key members remain coupled and are covered by the key/environment scans.
    movable = [obj for obj in objects if obj['key'] and obj['role'] in MOVING]
    joint = {'movingObjectPairs': 0, 'strictlySeparatedSweptBoundsPairs': 0,
             'sweptCandidatePairs': 0, 'requiredPosePairs': 0, 'completedPosePairs': 0,
             'complete': False, 'candidates': [], 'sweptBoundsExcludedPairs': []}
    def swept(obj):
        states = [moved_bounds(obj, motion_distance(obj, obj['key'], stroke, pretravel)) for stroke in strokes]
        return {'min': np.min([state['min'] for state in states], axis=0).tolist(),
                'max': np.max([state['max'] for state in states], axis=0).tolist()}
    for a, b in itertools.combinations(movable, 2):
        if a['key'] == b['key']: continue
        joint['movingObjectPairs'] += 1
        swept_a, swept_b = swept(a), swept(b)
        if not overlap_bounds(swept_a, swept_b):
            joint['strictlySeparatedSweptBoundsPairs'] += 1
            joint['sweptBoundsExcludedPairs'].append({'a': a['id'], 'b': b['id'], 'aSweptBounds': swept_a, 'bSweptBounds': swept_b})
            continue
        joint['sweptCandidatePairs'] += 1
        candidate = {'a': a['id'], 'b': b['id'], 'aSweptBounds': swept_a, 'bSweptBounds': swept_b, 'poses': []}
        counter = {'scenario': f"independent-{a['key']}-{b['key']}", 'consideredPairs': 0, 'aabbSeparatedPairs': 0, 'candidatePairs': 0}
        for first, second in itertools.product(strokes, repeat=2):
            check_id = consider(a, b, motion_distance(a, a['key'], first, pretravel),
                                motion_distance(b, b['key'], second, pretravel),
                                f"joint:{a['key']}@{first:.8f},{b['key']}@{second:.8f}", counter)
            candidate['poses'].append({'aStrokeMm': first, 'bStrokeMm': second,
                                       'checkId': check_id, 'aabbSeparated': check_id is None})
        joint['requiredPosePairs'] += len(candidate['poses'])
        joint['candidates'].append(candidate)
        coverage.append(counter)
    records = {obj['id']: obj for obj in objects}
    def order(job):
        heavy = max((records[job['a']], records[job['b']]), key=lambda obj: (obj['triangles'], obj['id']))
        return (-heavy['triangles'], heavy['id'], job['a'], job['b'], job['aMotionMm'], job['bMotionMm'])
    return sorted(jobs.values(), key=order), coverage, pair_hasher.hexdigest(), joint


def summarize(report):
    counts = Counter(check['result']['status'] for check in report['checks'])
    checked = {check['id'] for check in report['checks']}
    expected = {candidate['id'] for candidate in report['coverage']['candidates']}
    complete = checked == expected and len(checked) == len(report['checks'])
    joint = report['coverage']['jointRangeCoverage']
    joint['completedPosePairs'] = sum(pose['aabbSeparated'] or pose['checkId'] in checked
                                      for candidate in joint['candidates'] for pose in candidate['poses'])
    joint['complete'] = joint['completedPosePairs'] == joint['requiredPosePairs']
    self_review=report.get('selfIntersectionReview')
    self_complete=True
    self_failed=False
    if self_review is not None:
        self_complete={item['id'] for item in self_review['checks']}==set(self_review['requiredObjectIds']) and len(self_review['checks'])==len(self_review['requiredObjectIds'])
        self_failed=any(item['result']['status']!='pass' for item in self_review['checks'])
        self_review['complete']=self_complete
        self_review['status']='incomplete' if not self_complete else 'fail' if self_failed else 'pass'
    blocked = counts['penetration-evidence'] > 0
    unknown = any(count for status, count in counts.items() if status.startswith('unknown')) or bool(report['inventoryWarnings']) or not self_complete
    return {'status': 'incomplete' if not complete else 'self-intersection-or-topology-failure' if self_failed else 'penetration-found' if blocked else 'unknown-interfaces-or-containment' if unknown else 'no-unclassified-intersection-observed',
            'completeCandidateCoverage': complete, 'statusCounts': dict(counts),
            'selfIntersectionCoverageComplete':self_complete,
            'unclassifiedPairs': [{'checkId': check['id'], 'a': check['a'], 'b': check['b'], 'contexts': check['contexts'],
                                   'status': check['result']['status'], 'surfaceTrianglePairs': check['result']['surfaceTrianglePairs'],
                                   'maximumSampledPenetrationMm': check['result']['maximumSampledPenetrationMm']}
                                  for check in report['checks'] if check['result']['status'] not in {'no-intersection-observed', 'allowed-local-interface'}]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', default=str(ROOT / 'assets/puretv-controller'))
    parser.add_argument('--output', default=str(ROOT / 'docs/puretv-geometry-assembly.json'))
    parser.add_argument('--cache', default=str(ROOT.parent / 'scratch/puretv-assembly-audit-cache'))
    parser.add_argument('--step', type=float, default=.25)
    parser.add_argument('--travel', type=float, default=1.0)
    parser.add_argument('--pretravel', type=float, default=.75)
    parser.add_argument('--switch-overtravel', type=float, default=.25)
    parser.add_argument('--samples-per-direction', type=int, default=4096)
    parser.add_argument('--cache-triangles', type=int, default=2300000)
    parser.add_argument('--interfaces', help='Reviewed exact object-pair/local-region JSON; unknown interfaces are never inferred by kind.')
    parser.add_argument('--inventory-only', action='store_true')
    parser.add_argument('--max-checks', type=int, default=0, help='Diagnostic partial run only; report explicitly remains incomplete.')
    parser.add_argument('--priority-fixed', action='store_true', help='Audit every static fixed/fixed candidate before repeated dynamic poses.')
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
    if not 0 < args.step <= .25 or args.travel != 1.0 or not 16 <= args.samples_per_direction <= 20000:
        parser.error('Audit requires 0 < step <= .25 mm, full 1 mm travel, and 16..20000 containment samples/direction.')
    started = time.monotonic()
    script_sha = digest(Path(__file__))
    source, output, cache = Path(args.source_root).resolve(), Path(args.output), Path(args.cache)
    manifest_path = source / 'manifest.json'
    manifest_sha = digest(manifest_path)
    manifest = json.loads(manifest_path.read_text())
    objects, files, warnings = inventory(source, manifest, cache)
    strokes = [round(min(args.travel, index * args.step), 8) for index in range(math.ceil(args.travel/args.step)+1)]
    jobs, contexts, universe_sha, joint = plan(objects, strokes, args.pretravel)
    if args.priority_fixed:
        roles = {obj['id']: obj['role'] for obj in objects}
        jobs.sort(key=lambda job: not ('rest' in job['contexts'] and roles[job['a']] not in MOVING and roles[job['b']] not in MOVING))
    rules = default_interfaces(objects, args.pretravel, args.switch_overtravel)
    if args.interfaces:
        supplied = json.loads(Path(args.interfaces).read_text())
        expected = supplied.get('sourceSha256', {})
        for relative, value in expected.items():
            if digest(source / relative) != value: raise RuntimeError(f'Contact interface file is stale: {relative}')
        for rule in supplied['interfaces']:
            if len(rule['pair']) != 2 or any(not any(obj['id'] == item for obj in objects) for item in rule['pair']): raise RuntimeError('Interface references unknown exact object IDs')
            for region in [rule['regionBlender'], *rule.get('regionsBlender',[])]:
                if any(len(region[key]) != 3 or not all(math.isfinite(v) for v in region[key]) for key in ('min', 'max')) or np.any(np.asarray(region['min']) > region['max']): raise RuntimeError('Invalid local contact region')
            if not rule.get('reason'): raise RuntimeError('An explicit design-interface reason is required')
            rules.append(rule)
    source_hashes = {file['sourceFile']: file['sourceSha256'] for file in files}
    signature = hashlib.sha256(json.dumps({'source': source_hashes, 'manifest': manifest_sha, 'script': script_sha, 'step': args.step, 'pretravel': args.pretravel, 'overtravel': args.switch_overtravel, 'samples': args.samples_per_direction, 'interfaces': rules}, sort_keys=True).encode()).hexdigest()
    report = {'schemaVersion': 1, 'blenderVersion': bpy.app.version_string, 'units': 'mm',
              'sourceRoot': str(source.relative_to(ROOT)) if source.is_relative_to(ROOT) else 'external-read-only-snapshot', 'sourceSha256': source_hashes,
              'manifestSha256': manifest_sha, 'auditSignature': signature, 'scriptSha256': script_sha,
              'coordinates': {'source': 'Blender XYZ, Z up', 'client': '(x,z,-y), Y up', 'pressDirectionSource': [0,0,-1]},
              'method': {'geometry': 'Every evaluated source triangle, no decimation or display GLB used',
                         'broadPhase': 'All object pairs at rest, and each active group against every source object at each pose; AABB pruning only',
                         'surfaceTest': 'BVHTree.overlap over every triangle, epsilon 0',
                         'containmentTest': 'Three non-axis oriented exit-minus-entry ray counts agree; exact float64 triangle-plane/edge tests exclude surface points; complete float64 grid/ray fallback resolves disagreeing BVH votes; no nearest-normal-only conclusion',
                         'componentCoverage': 'Blender native Mesh Island field provides a representative for every connected source component, additional nearby vertices and intersecting-face centroids sampled bidirectionally',
                         'samplesPerDirection': args.samples_per_direction, 'strokesMm': strokes,
                         'motion': 'Caps, ABXY labels and remaining upper spring seats move -Z; springs compress around fixed lower plane; switch actuators move max(0,stroke-pretravel) in -Z',
                         'switchPretravelMm': args.pretravel, 'nominalSwitchOvertravelMm': args.switch_overtravel,
                         'limitations': ['Discrete poses are not continuous collision detection.', 'Bounded containment/depth witnesses are not complete maximum-penetration or manufacturing-clearance measurements.', 'Open or inconsistent topology is never treated as a reliable containment target.', 'Unclassified contact is unknown, never a pass; exact pair plus bounded local design interface is required.', 'Different-key moving members additionally use independent pairwise stroke Cartesian products; interpolation between listed samples is not certified.', 'Spring geometry uses the application\'s affine axial display compression. Wire cross-section preservation, spring solid length and force require the separate spring specification; this source-envelope audit is not a spring material simulation.', 'Every harness object also receives a mandatory exact source self-intersection check. Self-intersection of other objects and manufacturing defects remain outside this inter-object audit scope.', 'Material stiffness, friction, tolerance distribution and electrical connectivity are not established by this mesh audit.']},
              'files': files, 'objects': [{key: value for key, value in obj.items() if key != 'cacheDirectory'} for obj in objects], 'inventoryWarnings': warnings,
              'selfIntersectionReview':{'scopeSourceFiles':['electronics/harness.blend'],
                  'requiredObjectIds':[obj['id'] for obj in objects if obj['sourceFile']=='electronics/harness.blend'],
                  'method':'Complete source BVH candidate enumeration followed by float64 triangle intersection at 1e-8 mm. Adjacent triangles may meet only on their actual common edge or vertex, tested at 1e-7 mm. Closed single-component topology and nondegenerate triangles are also required.',
                  'checks':[],'complete':False,'status':'pending'},
              'allowedLocalInterfaces': rules, 'coverage': {'stateMode': 'joint-range', 'jointRangeCoverage': joint,
                  'objects': len(objects), 'fixedObjects': sum(obj['role'] not in MOVING for obj in objects),
                  'fixedFixedRestPairs': math.comb(sum(obj['role'] not in MOVING for obj in objects), 2),
                  'allRestPairs': math.comb(len(objects), 2), 'contexts': contexts, 'pairUniverseSha256': universe_sha,
                  'uniqueCandidatePairs': len(jobs), 'candidates': jobs}, 'checks': []}
    if args.resume and output.exists():
        previous = json.loads(output.read_text())
        if previous.get('auditSignature') != signature: raise RuntimeError('Cannot resume an audit of different geometry, rules or script')
        report['checks'] = previous.get('checks', [])
    report['summary'] = summarize(report)
    dump(output, report)
    print('PLANNED', len(objects), 'objects', len(jobs), 'unique full-BVH candidate pairs; output', output, flush=True)
    if args.inventory_only: return
    records = {obj['id']: obj for obj in objects}
    geometries = GeometryCache(args.cache_triangles)
    for ident in report['selfIntersectionReview']['requiredObjectIds']:
        geometry=geometries.get(records[ident],0.0)
        result=audit_self_intersections(geometry)
        report['selfIntersectionReview']['checks'].append({'id':ident,'sourceSha256':records[ident]['sourceSha256'],'result':result})
        print('SELF_CHECK',ident,result['status'],result['forbiddenTriangleIntersections'],'forbidden triangle intersections',flush=True)
    report['summary']=summarize(report)
    dump(output,report)
    completed = {check['id'] for check in report['checks']}
    journal = cache / 'audit-journals' / f'{output.stem}-{signature[:16]}.checks.jsonl'
    journal.parent.mkdir(parents=True, exist_ok=True)
    performed = 0
    with journal.open('a' if args.resume else 'w') as stream:
        for job in jobs:
            if job['id'] in completed: continue
            if args.max_checks and performed >= args.max_checks: break
            a = geometries.get(records[job['a']], job['aMotionMm'])
            b = geometries.get(records[job['b']], job['bMotionMm'])
            result = audit_pair(a, b, args.samples_per_direction)
            classify_allowed(result, a, b, rules)
            check = {**job, 'result': result}
            report['checks'].append(check)
            stream.write(json.dumps(check, ensure_ascii=False, default=native) + '\n')
            stream.flush()
            performed += 1
            print('CHECK', len(report['checks']), '/', len(jobs), result['status'], job['a'], '<>', job['b'], result['maximumSampledPenetrationMm'], flush=True)
            del a, b
            if performed % 10 == 0:
                report['summary'] = summarize(report)
                report['elapsedSeconds'] = round(time.monotonic()-started, 3)
                dump(output, report)
    changed = [relative for relative, value in source_hashes.items() if digest(source/relative) != value]
    report['sourceFilesUnchanged'] = not changed
    report['sourceFilesChangedDuringAudit'] = changed
    report['manifestUnchanged'] = digest(manifest_path) == manifest_sha
    report['scriptUnchanged'] = digest(Path(__file__)) == script_sha
    report['memoryStrategy'] = {'cacheTriangleBudget': args.cache_triangles, 'peakCachedTriangles': geometries.peak, 'BVHBuildCount': geometries.loads,
                               'note': 'LRU cache plus at most the active pair; large source .blend collections were unloaded before pair checks.'}
    try:
        import resource
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        report['memoryStrategy']['peakResidentMiB'] = round(peak / (1024*1024 if sys.platform == 'darwin' else 1024), 2)
    except ImportError:
        report['memoryStrategy']['peakResidentMiB'] = None
    report['elapsedSeconds'] = round(time.monotonic()-started, 3)
    report['summary'] = summarize(report)
    if changed or not report['manifestUnchanged'] or not report['scriptUnchanged']: report['summary']['status'] = 'invalidated-source-or-script-changed'
    dump(output, report)
    print('AUDIT_WRITTEN', output, report['summary']['status'], dict(Counter(check['result']['status'] for check in report['checks'])), flush=True)


if __name__ == '__main__':
    main()
