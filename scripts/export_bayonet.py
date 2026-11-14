"""Build editable, closed bayonet parts from the exact client collision geometry.

Run the TypeScript geometry exporter first, then:
    blender -b --python scripts/export_bayonet.py

Coordinates in geometry.json are millimetres / Y-up. The .blend uses
millimetres / Z-up; independent STL files use millimetres with their lowest
surface at Z=0. Original pureTV assets are never read or overwritten.
"""
from __future__ import annotations

import hashlib
import json
import math
import struct
from pathlib import Path

import bpy
import bmesh
from mathutils import Euler, Matrix, Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'assets' / 'bayonet'
SOURCE = OUTPUT / 'geometry.json'
AXIS = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_vector(value):
    return Vector((value[0], -value[2], value[1]))


def source_pose(position, rotation):
    # THREE's Euler XYZ means Rx @ Ry @ Rz, independent of Blender Euler UI.
    rx, ry, rz = (math.radians(v) for v in rotation)
    matrix = (Matrix.Rotation(rx, 4, 'X') @ Matrix.Rotation(ry, 4, 'Y') @ Matrix.Rotation(rz, 4, 'Z'))
    matrix.translation = Vector(position)
    return AXIS @ matrix @ AXIS.inverted()


def make_convex(name, solid, collection):
    mesh = bpy.data.meshes.new(name)
    points = [source_vector(v) for v in solid['vertices']]
    mesh.from_pydata(points, [], solid.get('faces', []))
    mesh.update()
    bm = bmesh.new()
    bm.from_mesh(mesh)
    if not solid.get('faces'):
        bmesh.ops.convex_hull(bm, input=list(bm.verts), use_existing_faces=False)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    return obj


def inspect_mesh(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    boundary = sum(e.is_boundary for e in bm.edges)
    nonmanifold = sum(not e.is_manifold for e in bm.edges)
    unused = set(v.index for v in bm.verts)
    components = 0
    while unused:
        components += 1
        queue = [unused.pop()]
        while queue:
            v = bm.verts[queue.pop()]
            for e in v.link_edges:
                index = e.other_vert(v).index
                if index in unused:
                    unused.remove(index)
                    queue.append(index)
    volume = bm.calc_volume(signed=True)
    bm.free()
    obj.data.calc_loop_triangles()
    coords = [v.co for v in obj.data.vertices]
    low = [min(v[i] for v in coords) for i in range(3)]
    high = [max(v[i] for v in coords) for i in range(3)]
    return {
        'vertices': len(obj.data.vertices),
        'triangles': len(obj.data.loop_triangles),
        'boundaryEdges': boundary,
        'nonManifoldEdges': nonmanifold,
        'connectedComponents': components,
        'volumeMm3': volume,
        'localBoundsBlenderZUp': {'min': low, 'max': high},
    }


def union_part(part):
    collection = bpy.data.collections.new('construction-' + part['id'])
    bpy.context.scene.collection.children.link(collection)
    pieces = [make_convex(f"{part['id']}-convex-{i:03d}", s, collection) for i, s in enumerate(part['solids'])]
    if not pieces:
        raise ValueError('No collision solids: ' + part['id'])
    # Work on a copy: the original convex decomposition remains editable in a
    # hidden collection, so the exact source of every manufactured surface is inspectable.
    result = pieces[0].copy()
    result.data = pieces[0].data.copy()
    result.name = part.get('name', part['id'])
    bpy.context.scene.collection.objects.link(result)
    operands = bpy.data.collections.new('boolean-operands-' + part['id'])
    bpy.context.scene.collection.children.link(operands)
    for obj in pieces[1:]:
        operands.objects.link(obj)
    if pieces[1:]:
        modifier = result.modifiers.new('Exact union of shared collision solids', 'BOOLEAN')
        modifier.operation = 'UNION'
        modifier.solver = 'EXACT'
        modifier.operand_type = 'COLLECTION'
        modifier.collection = operands
        modifier.use_self = True
        bpy.context.view_layer.objects.active = result
        result.select_set(True)
        bpy.ops.object.modifier_apply(modifier=modifier.name)
        result.select_set(False)
    bpy.data.collections.remove(operands)
    bm = bmesh.new()
    bm.from_mesh(result.data)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-7)
    bmesh.ops.dissolve_degenerate(bm, edges=list(bm.edges), dist=1e-8)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(result.data)
    bm.free()
    result.data.update()
    result['source'] = 'assets/bayonet/geometry.json'
    result['units'] = 'mm'
    result['sourceKind'] = part['kind']
    color = part.get('color', '#6288a8')
    rgb = [int(color[i:i+2], 16)/255 for i in (1, 3, 5)]
    material = bpy.data.materials.new(part['id'] + '-material')
    material.diffuse_color = (*rgb, 1)
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*rgb, 1)
    bsdf.inputs['Metallic'].default_value = 0.12
    bsdf.inputs['Roughness'].default_value = 0.38
    result.data.materials.append(material)
    collection.hide_viewport = True
    collection.hide_render = True
    return result


def export_stl(obj, path):
    mesh = obj.data
    mesh.calc_loop_triangles()
    # STL has no declared units; these values are explicitly millimetres.
    minimum_z = min(v.co.z for v in mesh.vertices)
    with path.open('wb') as out:
        out.write(b'Mechanical Studio bayonet; units mm; independent printable orientation'.ljust(80, b'\0'))
        out.write(struct.pack('<I', len(mesh.loop_triangles)))
        for tri in mesh.loop_triangles:
            a, b, c = [mesh.vertices[i].co.copy() for i in tri.vertices]
            for v in (a, b, c):
                v.z -= minimum_z
            normal = (b-a).cross(c-a).normalized()
            out.write(struct.pack('<12fH', *normal, *a, *b, *c, 0))
    return {'groundingTranslationZMm': -minimum_z, 'bytes': path.stat().st_size, 'sha256': digest(path)}


def inspect_stl(path, expected_bounds):
    data = path.read_bytes()
    count = struct.unpack_from('<I', data, 80)[0]
    if len(data) != 84 + count * 50:
        raise ValueError('Invalid binary STL length: ' + path.name)
    points, index_by_point, edges = [], {}, {}
    volume = 0.0
    degenerate = 0
    for i in range(count):
        values = struct.unpack_from('<12fH', data, 84 + i * 50)
        triangle = [tuple(values[start:start+3]) for start in (3, 6, 9)]
        indices = []
        for point in triangle:
            if point not in index_by_point:
                index_by_point[point] = len(points)
                points.append(point)
            indices.append(index_by_point[point])
        a, b, c = map(Vector, triangle)
        if (b-a).cross(c-a).length < 1e-10:
            degenerate += 1
        volume += a.dot(b.cross(c)) / 6
        for a, b in zip(indices, indices[1:] + indices[:1]):
            edge = tuple(sorted((a,b)))
            edges[edge] = edges.get(edge, 0) + 1
    size = [max(v[i] for v in points)-min(v[i] for v in points) for i in range(3)]
    expected_size = [expected_bounds['max'][i]-expected_bounds['min'][i] for i in range(3)]
    difference = max(abs(a-b) for a,b in zip(size,expected_size))
    nonmanifold = sum(n != 2 for n in edges.values())
    if nonmanifold or degenerate or volume <= 0 or difference > 5e-5:
        raise ValueError(f'STL roundtrip failed: {path.name}, edges={nonmanifold}, degenerate={degenerate}, volume={volume}, bounds={difference}')
    return {'triangles':count,'nonManifoldEdges':nonmanifold,'degenerateTriangles':degenerate,'volumeMm3':volume,'sizeZUpMm':size,'maxBoundsDifferenceMm':difference,'passed':True}


def world_bvh(obj, matrix):
    obj.data.calc_loop_triangles()
    vertices = [matrix @ v.co for v in obj.data.vertices]
    triangles = [tuple(t.vertices) for t in obj.data.loop_triangles]
    return BVHTree.FromPolygons(vertices, triangles, all_triangles=True, epsilon=0.0)


def main():
    source = json.loads(SOURCE.read_text())
    if source.get('units') != 'mm':
        raise ValueError('Expected shared geometry in millimetres')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.preferences.filepaths.save_version = 0
    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.scale_length = 0.001
    scene.unit_settings.length_unit = 'MILLIMETERS'
    OUTPUT.mkdir(parents=True, exist_ok=True)
    records = []
    objects = {}
    for part in source['parts']:
        obj = union_part(part)
        report = inspect_mesh(obj)
        if report['boundaryEdges'] or report['nonManifoldEdges'] or report['connectedComponents'] != 1 or report['volumeMm3'] <= 0:
            raise ValueError(f"Invalid solid {part['id']}: {report}")
        filename = part['id'] + '.stl'
        stl = export_stl(obj, OUTPUT / filename)
        stl['roundtrip'] = inspect_stl(OUTPUT / filename, report['localBoundsBlenderZUp'])
        obj.matrix_world = source_pose(part.get('position', [0, 0, 0]), part.get('rotation', [0, 0, 0]))
        objects[part['kind']] = obj
        records.append({'id':part['id'],'kind':part['kind'],'file':filename,'sourceSolids':len(part['solids']),'nominalSizeYUpMm':part.get('size'),'parameters':part.get('params',{}),'positionYUpMm':part.get('position',[0,0,0]),'rotationXYZDegrees':part.get('rotation',[0,0,0]),'mesh':report,'stl':stl})
        print(f"PASS {part['id']}: one closed solid, {report['triangles']} triangles, {report['volumeMm3']:.6f} mm³", flush=True)
    checks = []
    for check in source.get('meshChecks', []):
        a, b = objects[check['a']['kind']], objects[check['b']['kind']]
        ma = source_pose(check['a']['position'],check['a']['rotation'])
        mb = source_pose(check['b']['position'],check['b']['rotation'])
        count = len(world_bvh(a, ma).overlap(world_bvh(b, mb)))
        expected = check['expectIntersection']
        passed = (count > 0) == expected
        checks.append({'name':check['name'],'surfaceIntersectionPairs':count,'expectIntersection':expected,'passed':passed})
        if not passed:
            raise ValueError(f"Mesh check failed: {checks[-1]}")
    for obj in bpy.context.selected_objects:
        obj.select_set(False)
    for obj in objects.values():
        obj.select_set(True)
    bpy.context.view_layer.objects.active = next(iter(objects.values()))
    # Save a useful inspection view alongside the two individually editable solids.
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == 'VIEW_3D':
                space = area.spaces.active
                space.region_3d.view_location = Vector((0, 0, 23))
                space.region_3d.view_distance = 65
                space.region_3d.view_rotation = Euler((math.radians(65), 0, math.radians(30)), 'XYZ').to_quaternion()
                space.shading.color_type = 'MATERIAL'
    blend = OUTPUT / 'bayonet-assembly.blend'
    bpy.ops.wm.save_as_mainfile(filepath=str(blend), compress=True)
    manifest = {'schemaVersion':1,'units':'mm','sourceCoordinateSystem':'Y-up, XYZ degrees','blenderCoordinateSystem':'Z-up; mapping (x,y,z) → (x,-z,y)','source':{'file':'geometry.json','sha256':digest(SOURCE)},'nominal':source.get('nominal',{}),'poses':source.get('poses',{}),'blenderVersion':bpy.app.version_string,'assembly':{'file':blend.name,'sha256':digest(blend),'bytes':blend.stat().st_size},'parts':records,'surfaceIntersectionChecks':checks,'limitations':['Nominal geometry only; physical print tolerance, friction, spring force and wear require measurement.','STL has implicit millimetre units and each part is separately grounded; use the Blender file for shared assembly coordinates.','BVH checks test surface intersections at specified poses, not continuous swept contact or self-intersection certification.']}
    (OUTPUT / 'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    print('Exported editable Blender assembly, independent STL solids, and mesh manifest.', flush=True)


if __name__ == '__main__':
    main()
