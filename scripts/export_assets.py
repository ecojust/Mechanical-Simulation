"""Create lightweight, separately named GLB objects from the source Blender collections.

Run with Blender >= 5.2:
    blender -b --python scripts/export_assets.py
Source .blend files are opened read-only and are never saved. Exported coordinates
are millimetres, with Blender Z-up converted to glTF Y-up. Simplified output is
for display only; diagnostics describe the evaluated source before simplification.
"""
import bpy
import bmesh
import hashlib
import argparse
import sys
import json
import numpy as np
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets' / 'puretv-controller'
OUTPUT = ROOT / 'public' / 'models'
OUTPUT.mkdir(parents=True, exist_ok=True)
MAX_TRIANGLES = 16000
NAMES = {
    'buttons/a.blend': 'A 键 · 插销回弹总成',
    'buttons/b.blend': 'B 键 · 插销回弹总成',
    'buttons/x.blend': 'X 键 · 插销回弹总成',
    'buttons/y.blend': 'Y 键 · 插销回弹总成',
    'buttons/left.blend': '方向键 · 左',
    'buttons/right.blend': '方向键 · 右',
    'buttons/up.blend': '方向键 · 上',
    'buttons/down.blend': '方向键 · 下',
    'buttons/confirm.blend': '确认键 · 旋锁总成',
    'baseplates/dpad.blend': '方向键 · 四键底座',
    'baseplates/abxy.blend': 'ABXY · 四键底座',
    'housing/top.blend': '手柄 · 上盖',
    'housing/bottom.blend': '手柄 · 底壳',
    'electronics/esp32-mount.blend': 'ESP32 · 固定总成',
    'electronics/harness.blend': '手柄 · 九组线束',
}

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def bounds(objects):
    # Transform actual vertices, not local bounding-box corners: rotated curved
    # objects would otherwise acquire a significantly oversized world box.
    minima, maxima = [], []
    for obj in objects:
        coordinates = np.empty(len(obj.data.vertices) * 3, dtype=np.float64)
        obj.data.vertices.foreach_get('co', coordinates)
        coordinates = coordinates.reshape((-1, 3))
        matrix = np.asarray(obj.matrix_world, dtype=np.float64)
        world = coordinates @ matrix[:3, :3].T + matrix[:3, 3]
        world = world[:, [0, 2, 1]] * [1, 1, -1]
        minima.append(world.min(axis=0))
        maxima.append(world.max(axis=0))
    low = np.min(minima, axis=0)
    high = np.max(maxima, axis=0)
    return [round(float(v), 6) for v in high-low], [round(float(v), 6) for v in (high+low)/2]

def diagnostics(obj):
    mesh = obj.data
    mesh.calc_loop_triangles()
    bm = bmesh.new()
    bm.from_mesh(mesh)
    result = {
        'name': obj.name,
        'vertices': len(mesh.vertices),
        'triangles': len(mesh.loop_triangles),
        'boundaryEdges': sum(e.is_boundary for e in bm.edges),
        'nonManifoldEdges': sum(not e.is_manifold for e in bm.edges),
        'worldMatrix': [list(row) for row in obj.matrix_world],
    }
    bm.free()
    return result

def simplify_materials(obj):
    """Keep distinct source colors without embedded texture dependencies."""
    for slot in obj.material_slots:
        source = slot.material
        if source is None:
            continue
        color = tuple(source.diffuse_color)
        metallic = 0.0
        if source.use_nodes:
            for node in source.node_tree.nodes:
                if node.type == 'BSDF_PRINCIPLED':
                    color = tuple(node.inputs['Base Color'].default_value)
                    metallic = node.inputs['Metallic'].default_value
                    break
        mat = bpy.data.materials.get(source.name + '__preview')
        if mat is None:
            mat = bpy.data.materials.new(source.name + '__preview')
            mat.use_nodes = True
            bsdf = mat.node_tree.nodes.get('Principled BSDF')
            bsdf.inputs['Base Color'].default_value = (*color[:3], 1.0)
            bsdf.inputs['Metallic'].default_value = metallic
            bsdf.inputs['Roughness'].default_value = 0.38
            mat.diffuse_color = (*color[:3], 1.0)
        slot.material = mat

def export_one(entry):
    relative = entry['file']
    source_file = SOURCE / relative
    actual_hash = digest(source_file)
    if actual_hash != entry['sha256']:
        raise ValueError(f'Source checksum mismatch: {relative}')
    # A clean scene and a single appended collection avoid unrelated datablocks.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    with bpy.data.libraries.load(str(source_file), link=False) as (available, loaded):
        loaded.collections = [name for name in available.collections if name.startswith('pureTV')]
    for collection in loaded.collections:
        bpy.context.scene.collection.children.link(collection)
    original_objects = [obj for obj in bpy.context.scene.objects if obj.type in {'MESH','CURVE','SURFACE','FONT'}]
    if not original_objects:
        raise ValueError(f'No geometry found in {relative}')
    if len(original_objects) != len(entry['objects']):
        raise ValueError(f'Object count differs from source manifest: {relative}')
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    objects = []
    # Evaluate modifiers first; retain object names and independent transforms.
    for obj in original_objects:
        evaluated = obj.evaluated_get(depsgraph)
        mesh = bpy.data.meshes.new_from_object(evaluated, depsgraph=depsgraph)
        name = obj.name
        matrix = obj.matrix_world.copy()
        bpy.data.objects.remove(obj, do_unlink=True)
        copy = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(copy)
        copy.matrix_world = matrix
        objects.append(copy)
    bpy.context.view_layer.update()
    size, center = bounds(objects)
    original_diagnostics = []
    for obj in objects:
        diag = diagnostics(obj)
        original_diagnostics.append(diag)
        target = MAX_TRIANGLES * (3 if relative.startswith('housing/') else 1)
        if diag['triangles'] > target:
            bpy.context.view_layer.objects.active = obj
            modifier = obj.modifiers.new('Display simplification', 'DECIMATE')
            modifier.ratio = target / diag['triangles']
            bpy.ops.object.modifier_apply(modifier=modifier.name)
        simplify_materials(obj)
        obj.data.calc_loop_triangles()
        diag['displayTriangles'] = len(obj.data.loop_triangles)
        diag['simplified'] = diag['displayTriangles'] < diag['triangles']
        obj['sourceName'] = obj.name
        obj['sourceFile'] = relative
        obj['previewOnly'] = True
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects:
        obj.hide_set(False)
        obj.hide_render = False
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    # Raw positions remain millimetres. No scale or source transform is applied.
    bpy.context.scene.unit_settings.system = 'NONE'
    bpy.context.scene.unit_settings.scale_length = 1.0
    identifier = relative.replace('/', '-').removesuffix('.blend')
    output_file = OUTPUT / f'{identifier}.glb'
    bpy.ops.export_scene.gltf(
        filepath=str(output_file), export_format='GLB', use_selection=True,
        export_yup=True, export_apply=True, export_texcoords=False,
        export_normals=True, export_materials='EXPORT', export_extras=True,
        export_cameras=False, export_lights=False, export_animations=False,
    )
    item = {'id': identifier, 'name': NAMES.get(relative, identifier),
            'file': 'assets/puretv-controller/' + relative,
            'url': './models/' + output_file.name, 'size': size, 'center': center,
            'objects': len(objects),
            'triangles': sum(o['displayTriangles'] for o in original_diagnostics)}
    details = {'id': identifier, 'sourceSha256': actual_hash, 'displaySha256': digest(output_file),
               'displayBytes': output_file.stat().st_size,
               'sourceTriangles': sum(o['triangles'] for o in original_diagnostics),
               'objects': original_diagnostics}
    print('EXPORTED', json.dumps(item, ensure_ascii=False), flush=True)
    return item, details

if bpy.app.version < (5, 2, 0):
    raise RuntimeError('The source files require Blender 5.2 or newer. See docs/assets.md.')
manifest = json.loads((SOURCE / 'manifest.json').read_text())
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--only', action='append', metavar='SOURCE_FILE',
                    help='Re-export only this manifest path; preserve other collections. Can be repeated.')
arguments = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
known_files = {entry['file'] for entry in manifest['assets']}
selected_files = set(arguments.only or known_files)
if not selected_files <= known_files:
    raise ValueError(f'Unknown source path(s): {sorted(selected_files - known_files)}')

def identifier_for(relative):
    return relative.replace('/', '-').removesuffix('.blend')

def write_json(path, value):
    # Atomically replace metadata so a running client never reads partial JSON.
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(path)

if arguments.only:
    catalog = json.loads((OUTPUT / 'catalog.json').read_text())
    report = json.loads((OUTPUT / 'diagnostics.json').read_text())
    catalog_by_id = {item['id']: item for item in catalog}
    details_by_id = {item['id']: item for item in report['assets']}
    # Incremental export must retain a complete, current set. Refuse to silently
    # carry forward a changed source that was omitted from --only.
    for entry in manifest['assets']:
        identifier = identifier_for(entry['file'])
        if identifier not in catalog_by_id or identifier not in details_by_id:
            raise ValueError('Incremental export requires an existing complete catalog and diagnostics.')
        if entry['file'] not in selected_files:
            if details_by_id[identifier]['sourceSha256'] != entry['sha256']:
                raise ValueError(f"Also re-export changed source: {entry['file']}")
            if digest(SOURCE / entry['file']) != entry['sha256']:
                raise ValueError(f"Source checksum mismatch: {entry['file']}")
else:
    catalog_by_id, details_by_id = {}, {}
    report = {'blenderVersion': bpy.app.version_string, 'units': 'mm',
              'coordinateSystem': 'Y up; source (x,y,z) becomes (x,z,-y)',
              'displayOnly': True, 'maxTrianglesPerObject': MAX_TRIANGLES,
              'checks': 'Evaluated source topology only; no self-intersection, clearance or motion certification.',
              'assets': []}
for source_entry in manifest['assets']:
    if source_entry['file'] not in selected_files:
        continue
    item, detail = export_one(source_entry)
    catalog_by_id[item['id']] = item
    details_by_id[item['id']] = detail
    # Source manifest order remains stable in full and incremental exports.
    identifiers = [identifier_for(entry['file']) for entry in manifest['assets']]
    catalog = [catalog_by_id[key] for key in identifiers if key in catalog_by_id]
    report['assets'] = [details_by_id[key] for key in identifiers if key in details_by_id]
    write_json(OUTPUT / 'catalog.json', catalog)
    write_json(OUTPUT / 'diagnostics.json', report)
print(f'Exported {len(selected_files)} collection(s); catalog retains {len(catalog)} collections, '
      f'{sum(item["objects"] for item in catalog)} objects.', flush=True)
# A ready-to-import project restores the shared assembly without changing any
# relative positions. One common shift places the lowest source surface on Y=0.
ground_shift = -min(item['center'][1] - item['size'][1] / 2 for item in catalog)
assembly = {'version': 1, 'name': 'pureTV 原始手柄装配', 'parts': [], 'wires': []}
for item in catalog:
    assembly['parts'].append({
        'id': 'puretv-' + item['id'], 'name': item['name'], 'kind': 'asset',
        'position': [item['center'][0], round(item['center'][1] + ground_shift, 6), item['center'][2]],
        'rotation': [0, 0, 0], 'size': item['size'], 'color': '#92a9b6',
        'fixed': item['id'] == 'housing-bottom', 'visible': True,
        'params': {'assetUrl': item['url']},
    })
(OUTPUT / 'puretv-assembly.json').write_text(json.dumps(assembly, ensure_ascii=False, indent=2) + '\n')
