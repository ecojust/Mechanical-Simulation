"""Close pureTV wire end caps without changing paths, radii or assembly transforms.

Run with Blender 5.2+: blender -b --python scripts/repair-puretv-harness.py -- --apply
Dry-run is the default. Only electronics/harness.blend may be written.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys

import bpy
import bmesh
import numpy as np
from mathutils import Vector
from mathutils.kdtree import KDTree

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/puretv-controller/electronics/harness.blend'
REPORT = ROOT / 'docs/puretv-geometry-harness-repair.json'
TOLERANCE = 1e-6


def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def components(bm):
    remaining = set(bm.verts)
    count = 0
    while remaining:
        count += 1
        stack = [remaining.pop()]
        while stack:
            vertex = stack.pop()
            for edge in vertex.link_edges:
                other = edge.other_vert(vertex)
                if other in remaining:
                    remaining.remove(other)
                    stack.append(other)
    return count


def stats(bm):
    return {'vertices': len(bm.verts), 'edges': len(bm.edges), 'faces': len(bm.faces),
            'boundaryEdges': sum(edge.is_boundary for edge in bm.edges),
            'nonManifoldEdges': sum(not edge.is_manifold for edge in bm.edges),
            'components': components(bm)}


def boundary_loops(bm):
    boundary = {edge for edge in bm.edges if edge.is_boundary}
    for edge in boundary:
        for vertex in edge.verts:
            if sum(other in boundary for other in vertex.link_edges) != 2:
                raise RuntimeError('Boundary is not a simple closed end ring; refusing an automatic fill')
    loops = []
    while boundary:
        first = boundary.pop()
        loop, stack, vertices = [first], [first], set(first.verts)
        while stack:
            edge = stack.pop()
            for vertex in edge.verts:
                for neighbor in vertex.link_edges:
                    if neighbor in boundary:
                        boundary.remove(neighbor)
                        loop.append(neighbor)
                        stack.append(neighbor)
                        vertices.update(neighbor.verts)
        points = np.asarray([list(vertex.co) for vertex in vertices])
        centered = points - points.mean(axis=0)
        _, _, axes = np.linalg.svd(centered, full_matrices=False)
        error = float(np.max(np.abs(centered @ axes[-1])))
        if len(loop) < 3 or error > TOLERANCE * 8:
            raise RuntimeError(f'Non-planar/invalid end ring ({len(loop)} edges; plane error {error}); refusing a guessed repair')
        loops.append({'edges': loop, 'vertices': len(vertices), 'planeErrorMm': error})
    return loops


def directed_vertex_distance(before, after):
    tree = KDTree(len(after))
    for index, point in enumerate(after): tree.insert(Vector(point), index)
    tree.balance()
    return max((tree.find(Vector(point))[2] for point in before), default=0)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--output', default=str(REPORT))
    args = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
    before_sha = sha(SOURCE)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    with bpy.data.libraries.load(str(SOURCE), link=False) as (available, loaded):
        loaded.collections = list(available.collections)
    collections = list(loaded.collections)
    for collection in collections:
        bpy.context.scene.collection.children.link(collection)
    bpy.context.view_layer.update()
    objects = sorted([obj for obj in bpy.context.scene.objects if obj.type in {'MESH', 'CURVE'}], key=lambda obj: obj.name)
    if len(objects) != 20: raise RuntimeError(f'Expected exactly 20 harness objects; got {len(objects)}')
    records = []
    for obj in objects:
        graph = bpy.context.evaluated_depsgraph_get()
        mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(graph), depsgraph=graph)
        bm = bmesh.new()
        bm.from_mesh(mesh)
        matrix = obj.matrix_world.copy()
        before = np.asarray([list(matrix @ vertex.co) for vertex in bm.verts])
        original = stats(bm)
        original_type = obj.type
        # Existing caps in 18 curves are disconnected duplicates of tube-end rings.
        # Weld only boundary vertices; no interior path vertex can move or disappear.
        candidates = list({vertex for edge in bm.edges if edge.is_boundary for vertex in edge.verts})
        bmesh.ops.remove_doubles(bm, verts=candidates, dist=TOLERANCE)
        if any(len(edge.link_faces) > 2 for edge in bm.edges):
            raise RuntimeError(f'Welding creates a non-manifold junction in {obj.name}; source is left unchanged')
        loops = boundary_loops(bm)
        if len(loops) not in (0, 2):
            raise RuntimeError(f'{obj.name} has {len(loops)} remaining openings, not two wire endpoints')
        added = bmesh.ops.holes_fill(bm, edges=[edge for loop in loops for edge in loop['edges']], sides=0)['faces'] if loops else []
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        if bm.calc_volume(signed=True) < 0: bmesh.ops.reverse_faces(bm, faces=list(bm.faces))
        repaired = stats(bm)
        if repaired['nonManifoldEdges'] or repaired['components'] != 1:
            raise RuntimeError(f'Cannot establish one closed wire solid: {obj.name}: {repaired}')
        after = np.asarray([list(matrix @ vertex.co) for vertex in bm.verts])
        maximum_shift = max(directed_vertex_distance(before, after), directed_vertex_distance(after, before))
        aabb_shift = float(max(np.max(np.abs(before.min(axis=0)-after.min(axis=0))), np.max(np.abs(before.max(axis=0)-after.max(axis=0)))))
        if maximum_shift > TOLERANCE * 2 or aabb_shift > TOLERANCE * 2:
            raise RuntimeError(f'Repair changes wire path/envelope in {obj.name}: {maximum_shift} mm')
        volume = abs(float(bm.calc_volume(signed=True) * matrix.to_3x3().determinant()))
        if volume <= 1e-8: raise RuntimeError(f'Degenerate repaired wire: {obj.name}')
        bm.to_mesh(mesh)
        bm.free()
        mesh.update()
        if obj.type != 'MESH':
            bpy.ops.object.select_all(action='DESELECT')
            obj.select_set(True)
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.convert(target='MESH')
            obj = bpy.context.view_layer.objects.active
        obj.modifiers.clear()
        obj.data = mesh
        obj.matrix_world = matrix
        records.append({'sourceName': obj.name, 'beforeType': original_type, 'afterType': obj.type,
                        'before': original, 'after': repaired, 'filledEndFaces': len(added),
                        'weldedBoundaryVertices': original['vertices']-repaired['vertices'],
                        'remainingOpeningsAfterWeld': [{'vertices': loop['vertices'], 'planeErrorMm': loop['planeErrorMm']} for loop in loops],
                        'maximumBidirectionalOriginalVertexDistanceMm': maximum_shift, 'maximumWorldBoundsChangeMm': aabb_shift,
                        'worldBoundsBefore': {'min': before.min(axis=0).tolist(), 'max': before.max(axis=0).tolist()},
                        'worldBoundsAfter': {'min': after.min(axis=0).tolist(), 'max': after.max(axis=0).tolist()},
                        'closedVolumeMm3': volume})
        print('REPAIRED', obj.name, original, '->', repaired, 'maxShift', maximum_shift, flush=True)
    if sha(SOURCE) != before_sha: raise RuntimeError('Source changed concurrently; refusing save')
    if args.apply:
        backup = ROOT.parent / 'scratch/puretv-harness-repair/harness-before.blend'
        backup.parent.mkdir(parents=True, exist_ok=True)
        if not backup.exists(): shutil.copy2(SOURCE, backup)
        bpy.data.libraries.write(str(SOURCE), set(collections), fake_user=True, compress=True)
    after_sha = sha(SOURCE)
    output = {'schemaVersion': 1, 'sourceFile': 'assets/puretv-controller/electronics/harness.blend',
              'blenderVersion': bpy.app.version_string, 'applied': args.apply, 'beforeSha256': before_sha, 'afterSha256': after_sha,
              'method': 'Evaluate original curves, weld only coincident boundary-ring vertices (1e-6 mm), fill only remaining planar endpoint loops, orient closed faces; do not move route/diameter/assembly vertices.',
              'scope': 'Topological endpoint closure only; full assembly intersections and electrical interfaces require separate source-mesh audit.',
              'objects': records, 'summary': {'objects': len(records), 'closedSingleComponentObjects': len(records),
              'maximumVertexChangeMm': max(record['maximumBidirectionalOriginalVertexDistanceMm'] for record in records),
              'maximumEnvelopeChangeMm': max(record['maximumWorldBoundsChangeMm'] for record in records)}}
    Path(args.output).write_text(json.dumps(output, ensure_ascii=False, indent=2)+'\n')
    print('HARNESS_REPORT', args.output, after_sha, flush=True)


if __name__ == '__main__': main()
