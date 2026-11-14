"""Read-only full-resolution button audit. Run with Blender >=5.2, -- --only left optionally."""
import argparse
import gc
import hashlib
import json
import math
import sys
from pathlib import Path

import bpy
import bmesh
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets/puretv-controller"
OUT = ROOT / "docs/puretv-geometry-internals.json"
STEPS = [0, 0.25, 0.5, 0.75, 1.0]
EPS = 1e-5
DIAGNOSTICS = {obj['name']: obj for asset in json.loads((ROOT / 'public/models/diagnostics.json').read_text())['assets'] for obj in asset['objects']}

def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def gltf(v): return [float(v[0]), float(v[2]), float(-v[1])]
def clean(value):
    if isinstance(value, np.ndarray): return value.tolist()
    if isinstance(value, (np.floating, np.integer)): return value.item()
    raise TypeError(type(value))

class Geometry:
    def __init__(self, name, vertices, faces, build=True, closed=True):
        self.name, self.v, self.f = name, vertices, faces
        self.closed = closed
        self.low, self.high = vertices.min(axis=0), vertices.max(axis=0)
        self.bvh = BVHTree.FromPolygons(vertices.tolist(), faces.tolist(), all_triangles=True, epsilon=0.0) if build else None
        a, b, c = (vertices[faces[:, i]] for i in range(3))
        self.signed_volume = float(np.einsum('ij,ij->i', a, np.cross(b, c)).sum() / 6)
        self.orientation = 1 if self.signed_volume >= 0 else -1
    def moved(self, distance, spring=False):
        coords = self.v.copy()
        if spring: coords[:, 2] = self.low[2] + (coords[:, 2] - self.low[2]) * (1 - distance / (self.high[2] - self.low[2]))
        else: coords[:, 2] -= distance
        return Geometry(self.name, coords, self.f, closed=self.closed)
    def report(self):
        return {"name": self.name, "vertices": len(self.v), "triangles": len(self.f), "closedTopology": self.closed, "sourceMin": self.low, "sourceMax": self.high, "clientCenter": gltf((self.low + self.high) / 2), "clientSize": [(self.high-self.low)[i] for i in [0, 2, 1]], "signedVolumeMm3": self.signed_volume}

def evaluated(obj):
    graph = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(graph), depsgraph=graph)
    mesh.calc_loop_triangles()
    coords = np.empty(len(mesh.vertices) * 3, dtype=np.float64)
    mesh.vertices.foreach_get('co', coords)
    coords = coords.reshape((-1, 3))
    matrix = np.asarray(obj.matrix_world)
    coords = coords @ matrix[:3, :3].T + matrix[:3, 3]
    faces = np.empty(len(mesh.loop_triangles) * 3, dtype=np.int32)
    mesh.loop_triangles.foreach_get('vertices', faces)
    faces = faces.reshape((-1, 3))
    if len(faces) < 100000:
        # Count original polygon adjacency. Triangulation of an exact Boolean
        # n-gon can contain zero-area diagonals and falsely report an open shell.
        bm=bmesh.new();bm.from_mesh(mesh)
        closed=bool(len(bm.edges) and all(edge.is_manifold and edge.is_contiguous for edge in bm.edges))
        bm.free()
    else:
        known = DIAGNOSTICS.get(obj.name, {})
        closed = known.get('triangles') == len(faces) and known.get('nonManifoldEdges') == 0
    result = Geometry(obj.name, coords, faces, closed=closed)
    bpy.data.meshes.remove(mesh)
    return result

def ray_heights(geometry, x, y):
    origin = Vector((x, y, geometry.low[2] - 1))
    direction = Vector((0, 0, 1))
    heights = []
    for _ in range(64):
        location, normal, index, distance = geometry.bvh.ray_cast(origin, direction, float(geometry.high[2] - origin.z + 1))
        if location is None: break
        heights.append({"z": float(location.z), "normalZ": float(normal.z * geometry.orientation), "face": int(index)})
        origin = location + direction * 0.0001
    return heights

def intersection(a, b):
    if np.any(a.high < b.low - EPS) or np.any(b.high < a.low - EPS):
        return {"surfaceTrianglePairs": 0, "insideVertices": 0, "maximumSampledPenetrationMm": 0, "status": "disjoint-bounds"}
    pairs = a.bvh.overlap(b.bvh)
    depths, inside, checked, witnesses = [], 0, 0, []
    # Full small-object vertices; full-resolution target vertices near the moving AABB,
    # bounded to 20k deterministic samples. Surface overlap itself uses every triangle.
    for source, target in [(a, b), (b, a)]:
        if not target.closed: continue
        mask = np.all(source.v >= target.low - EPS, axis=1) & np.all(source.v <= target.high + EPS, axis=1)
        indices = np.flatnonzero(mask)
        if len(indices) > 20000: indices = indices[np.linspace(0, len(indices)-1, 20000, dtype=int)]
        for index in indices:
            point = Vector(source.v[index])
            location, normal, face, distance = target.bvh.find_nearest(point)
            checked += 1
            if location is not None and distance > EPS and (point - location).dot(normal) * target.orientation < -EPS and inside_winding(target, point):
                inside += 1
                depths.append(float(distance))
                witnesses.append({'pointSource':list(point),'surfaceSource':list(location),'depthMm':float(distance),'pointObject':source.name,'containingObject':target.name})
    result = {"surfaceTrianglePairs": len(pairs), "insideVertices": inside, "sampledVertices": checked, "maximumSampledPenetrationMm": max(depths, default=0), "penetrationWitnesses":sorted(witnesses,key=lambda w:-w['depthMm'])[:8], "status": "penetration-evidence" if inside else "surface-contact-or-crossing" if pairs else "no-intersection-found"}
    if pairs:
        indices = np.unique(a.f[np.array([pair[0] for pair in pairs], dtype=int)].reshape(-1))
        region = a.v[indices]
        result["sourceCrossingRegionMin"] = region.min(axis=0)
        result["sourceCrossingRegionMax"] = region.max(axis=0)
    return result

def inside_winding(geometry, point):
    # Nearest normals alone misclassify concave/corner geometry. Confirm every
    # candidate with three non-axis rays; oriented exit-minus-entry counts also
    # tolerate overlapping outward closed components (parity alone would not).
    for raw in [(0.731, 0.371, 0.573), (-0.431, 0.811, 0.391), (0.213, -0.579, 0.787)]:
        direction = Vector(raw).normalized()
        origin = point + direction * EPS
        winding = 0
        for _ in range(128):
            location, normal, index, distance = geometry.bvh.ray_cast(origin, direction, 2000)
            if location is None: break
            facing = normal.dot(direction) * geometry.orientation
            if abs(facing) > 1e-6: winding += 1 if facing > 0 else -1
            origin = location + direction * EPS
        else: return False
        if winding <= 0: return False
    return True

def radial_sections(cap, sleeve, x, y, lower, upper):
    # These sections interleave annular arcs. Comparing the outermost cap exit to
    # the innermost sleeve entry invents a negative gap although their material
    # intervals are disjoint. Retain ordered material crossings as raw witnesses.
    sections = []
    if upper <= lower: return sections
    for z in np.linspace(lower + .05, upper - .05, 7):
        rays=[]
        for angle in np.linspace(0,2*math.pi,16,endpoint=False):
            direction=Vector((math.cos(angle),math.sin(angle),0));origin=Vector((x,y,z))
            record={'angleDeg':float(math.degrees(angle))}
            for geometry,label in [(cap,'capCrossings'),(sleeve,'sleeveCrossings')]:
                point=origin.copy();hits=[]
                for _ in range(40):
                    hit,normal,face,distance=geometry.bvh.ray_cast(point,direction,30)
                    if hit is None:break
                    hits.append({'radiusMm':float((hit-origin).length),'outwardDot':float(normal.dot(direction)*geometry.orientation)})
                    point=hit+direction*.0001
                record[label]=hits
            rays.append(record)
        sections.append({'sourceZ':float(z),'rays':rays})
    return sections

def expected_interface(result, first, second, region_low, region_high, maximum, detail):
    """Limit a named compliant interface by measured depth and witness region."""
    witnesses=result.get('penetrationWitnesses',[])
    inside=all(all(region_low[i]-EPS<=w['pointSource'][i]<=region_high[i]+EPS for i in range(3)) for w in witnesses)
    if result['maximumSampledPenetrationMm']<=maximum+EPS and inside:
        result['rawStatus']=result['status']
        result['status']='expected-contact-within-limit'
        result['expectedContact']={'id':first.name+'::'+second.name,'partNames':[first.name,second.name],'region':detail,'regionSourceMin':list(region_low),'regionSourceMax':list(region_high),'maximumPenetrationMm':maximum,'observedPenetrationMm':result['maximumSampledPenetrationMm']}
    return result

def main():
    global SOURCE
    parser = argparse.ArgumentParser()
    parser.add_argument('--only', action='append')
    parser.add_argument('--output', default=str(OUT))
    parser.add_argument('--source-root')
    args = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
    manifest = json.loads((SOURCE / 'manifest.json').read_text())
    if args.source_root:SOURCE=Path(args.source_root)
    report = {"schema": 1, "blender": bpy.app.version_string, "coordinates": "Source mm/Z-up; client (x,y,z)=(source.x,source.z,-source.y); press source -Z/client -Y", "method": "Evaluated unsimplified source triangles; exact BVH triangle overlap, bounded bidirectional penetration samples confirmed by three oriented ray winding counts (not exhaustive volume certification); axial contact ray casts and radial guide rays.", "limitations": ["Switch actuator is a compliant nominal placeholder; actuator entering the switch body is expected and not a solid-material certification.", "Spring stiffness, switch rated travel and friction cannot be measured from mesh geometry."], "buttons": []}
    for entry in manifest['assets']:
        if not entry['file'].startswith('buttons/'): continue
        key = Path(entry['file']).stem
        if args.only and key not in args.only: continue
        path = SOURCE / entry['file']
        before = sha(path)
        bpy.ops.wm.read_factory_settings(use_empty=True)
        with bpy.data.libraries.load(str(path), link=False) as (available, loaded):
            loaded.collections = [name for name in available.collections if name.startswith('pureTV')]
        for collection in loaded.collections: bpy.context.scene.collection.children.link(collection)
        bpy.context.view_layer.update()
        raw = list(bpy.context.scene.objects)
        objects = {}
        for obj in raw:
            if obj.type in {'MESH', 'CURVE', 'SURFACE', 'FONT'}:
                objects[obj.name] = evaluated(obj)
        def find(tokens):
            return next((value for name, value in objects.items() if any(token in name for token in tokens)), None)
        cap = find(['一体式键帽与蓝色插销', '同款插销与圆形键帽', '确认 · 键帽'])
        sleeve = find(['下环一体式开关套筒', '旋锁座'])
        spring = find(['回位弹簧', '回弹压簧'])
        actuator = find(['按杆', '开关触头'])
        switch = find(['6×6 开关', '常开开关'])
        ring = find(['弹簧定位环'])
        x, y = (switch.low + switch.high)[:2] / 2
        center_cap, center_actuator = ray_heights(cap, x, y), ray_heights(actuator, x, y)
        gap = center_cap[0]['z'] - center_actuator[-1]['z'] if center_cap and center_actuator else None
        item = {"key": key, "sourceFile": entry['file'], "sourceSha256": before, "axisSource": [0, 0, 1], "axisClient": [0, 1, 0], "axisCenterSourceXY": [x, y], "roles": {"moving": [name for name in objects if '键帽' in name], "spring": [spring.name], "switchContact": actuator.name, "electricalSwitch":switch.name, "fixed": [value.name for value in [sleeve, ring, switch] if value]}, "objects": [value.report() for value in objects.values()], "centerContact": {"strikerRay": center_cap, "actuatorRay": center_actuator, "gapMm": gap, "strikerSource": [x, y, center_cap[0]['z']] if center_cap else None, "actuatorSource": [x, y, center_actuator[-1]['z']] if center_actuator else None}, "spring": {"freeLengthMm": float(spring.high[2]-spring.low[2]), "bottomSourceZ": float(spring.low[2]), "topSourceZ": float(spring.high[2])}, "guideSections": radial_sections(cap, sleeve, x, y, max(cap.low[2], sleeve.low[2]), min(cap.high[2], sleeve.high[2])), "states": []}
        print('MEASURED', key, 'centralGap', gap, 'springLength', item['spring']['freeLengthMm'], flush=True)
        for displacement in STEPS:
            moved = cap.moved(displacement)
            compressed = spring.moved(displacement, spring=True)
            overtravel=max(0,displacement-max(0,gap or 0))
            follower=actuator.moved(overtravel)
            state = {"displacementMm": displacement, "capAgainstFixed": {}, "compressedSpringAgainstFixed": {},"actuatorAgainstFixed":{}}
            for target in [sleeve, ring, switch]:
                if target is None: continue
                state['capAgainstFixed'][target.name] = intersection(moved, target)
                state['compressedSpringAgainstFixed'][target.name] = intersection(compressed, target)
                state['actuatorAgainstFixed'][target.name] = intersection(follower,target)
            contact=intersection(moved,follower)
            if displacement>=gap-EPS:
                low=follower.low.copy();high=follower.high.copy();low[2]=high[2]-EPS
                contact=expected_interface(contact,moved,follower,low,high,EPS,'Centre striker face touches the actuator top; actuator follows after first contact without rigid penetration.')
            state['capAgainstFixed'][follower.name]=contact
            compliance=state['actuatorAgainstFixed'][switch.name]
            low=follower.low.copy();high=follower.high.copy();low[2]=switch.high[2]-.25-EPS;high[2]=switch.high[2]+EPS
            if compliance['status'] not in ['disjoint-bounds','no-intersection-found']:
                state['actuatorAgainstFixed'][switch.name]=expected_interface(compliance,follower,switch,low,high,.25,'Nominal compliant actuator motion into the switch-body exterior placeholder, limited to the upper 0.25 mm; switch internals are not modelled.')
            state['compressedSpringAgainstFixed'][follower.name]=intersection(compressed,follower)
            state['expectedPlungerCompressionMm'] = overtravel
            item['states'].append(state)
            print('STATE', key, displacement, [(name, value['status'], value.get('maximumSampledPenetrationMm')) for name, value in state['capAgainstFixed'].items()], flush=True)
            del moved, compressed, follower
            gc.collect()
        if sha(path) != before: raise RuntimeError('Source modified during audit')
        report['buttons'].append(item)
        Path(args.output).write_text(json.dumps(report, indent=2, ensure_ascii=False, default=clean) + '\n')
        del objects, raw
        bpy.ops.wm.read_factory_settings(use_empty=True)
        gc.collect()
    print('AUDIT_WRITTEN', args.output, flush=True)

if __name__ == "__main__":
    main()
