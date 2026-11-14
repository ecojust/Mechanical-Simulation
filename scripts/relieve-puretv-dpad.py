"""Relieve the four concealed D-pad guide ends; leave the cap top and striker intact.

The original guide ends have only 0.5774 mm above sleeve supports. A 0.75 mm
local relief provides 0.3274 mm nominal axial room at the 1 mm pressed pose.
Run with Blender >= 5.2. Default writes scratch proposals; --apply edits source.
"""
import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/puretv-controller'

def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def geometry(obj):
    mesh = obj.data
    mesh.calc_loop_triangles()
    vertices = [obj.matrix_world @ v.co for v in mesh.vertices]
    triangles = [tuple(t.vertices) for t in mesh.loop_triangles]
    bm = bmesh.new(); bm.from_mesh(mesh)
    topology = {'vertices':len(vertices), 'triangles':len(triangles),
                'boundaryEdges':sum(e.is_boundary for e in bm.edges),
                'nonManifoldEdges':sum(not e.is_manifold for e in bm.edges),
                'volumeMm3':abs(bm.calc_volume(signed=True)*obj.matrix_world.to_3x3().determinant())}
    bm.free()
    topology.update(sourceMin=[min(v[i] for v in vertices) for i in range(3)],sourceMax=[max(v[i] for v in vertices) for i in range(3)])
    return vertices, triangles, topology

parser=argparse.ArgumentParser();parser.add_argument('--apply',action='store_true');parser.add_argument('--only',action='append')
args=parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
repairs=json.loads((ROOT/'docs/puretv-geometry-button-repairs.json').read_text())
report={'version':1,'applied':args.apply,'method':'Monotone axial relief of hidden guide ends only, radius 2.8..3.5 mm feather, lower 2.2 mm height taper; centre striker and upper cap remain unchanged.','design':{'maxReliefMm':.75,'nominalStrokeMm':1,'originalAxialRoomMm':.5774,'nominalFinalAxialRoomMm':.3274,'tolerancePerPartMm':.1,'nominalWorstCaseRoomMm':.1274},'buttons':[]}
if args.apply and (ROOT/'docs/puretv-geometry-dpad-relief.json').exists():report=json.loads((ROOT/'docs/puretv-geometry-dpad-relief.json').read_text())
for key in ['left','right','down','up']:
    if args.only and key not in args.only:continue
    record=next(v for v in repairs['buttons'] if v['key']==key)
    path=SOURCE/record['sourceFile'];before=sha(path)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    with bpy.data.libraries.load(str(path),link=False) as (available,loaded):loaded.collections=[n for n in available.collections if n.startswith('pureTV')]
    for collection in loaded.collections:bpy.context.scene.collection.children.link(collection)
    bpy.context.view_layer.update()
    cap=bpy.data.objects[record['capName']]
    if cap.get('hiddenGuideReliefMm',0)>.74:
        print('ALREADY_RELIEVED',key,flush=True);continue
    before_vertices, faces, before_topology=geometry(cap)
    bm=bmesh.new();bm.from_mesh(cap.data);bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=1e-7);bmesh.ops.dissolve_degenerate(bm,edges=list(bm.edges),dist=1e-7);bmesh.ops.triangulate(bm,faces=list(bm.faces));bm.to_mesh(cap.data);bm.free()
    before_vertices,faces,_=geometry(cap)
    x,y=record['contactSource'][:2];floor=min(v.z for v in before_vertices)
    inverse=cap.matrix_world.inverted();modified=0;maximum=0
    for vertex,point in zip(cap.data.vertices,before_vertices):
        radius=math.hypot(point.x-x,point.y-y)
        radial=max(0,min(1,(radius-2.8)/.7))
        axial=max(0,min(1,(floor+2.2-point.z)/2.2))
        amount=.75*radial*axial
        if amount>1e-8:
            replacement=point.copy();replacement.z+=amount;vertex.co=inverse@replacement
            modified+=1;maximum=max(maximum,amount)
    cap.data.update();bpy.context.view_layer.update()
    after_vertices,after_faces,after_topology=geometry(cap)
    if after_topology['nonManifoldEdges']:raise RuntimeError(f'Relief must preserve closed mesh topology: {after_topology}')
    # Fixed source triangulation can flip under a non-affine boundary map. Reject
    # a reversed or degenerate actual triangle, not only non-manifold topology.
    flipped=sum((before_vertices[b]-before_vertices[a]).cross(before_vertices[c]-before_vertices[a]).dot((after_vertices[b]-after_vertices[a]).cross(after_vertices[c]-after_vertices[a]))<=0 for a,b,c in after_faces)
    if flipped:
        for a,b,c in after_faces:
            pre=(before_vertices[b]-before_vertices[a]).cross(before_vertices[c]-before_vertices[a]);post=(after_vertices[b]-after_vertices[a]).cross(after_vertices[c]-after_vertices[a])
            if pre.dot(post)<=0:print('FLIP',pre.length,post.length,[list(before_vertices[i]) for i in [a,b,c]],[list(after_vertices[i]) for i in [a,b,c]],flush=True)
        raise RuntimeError(f'{key}: {flipped} reversed/degenerate triangles')
    bvh=BVHTree.FromPolygons(after_vertices,after_faces,all_triangles=True)
    hit=bvh.ray_cast(Vector((x,y,floor-1)),Vector((0,0,1)))[0]
    gap=float(hit.z-record['contactSource'][2])
    if abs(gap-.75)>1e-4:raise RuntimeError('Centre striker changed')
    if max(abs(a[i]-b[i]) for a,b in zip(before_vertices,after_vertices) for i in [0,1])>1e-5:raise RuntimeError('Lateral geometry changed')
    destination=path if args.apply else ROOT.parent/'scratch/puretv-source-repair/relief'/record['sourceFile']
    destination.parent.mkdir(parents=True,exist_ok=True)
    cap['hiddenGuideReliefMm']=maximum
    bpy.data.libraries.write(str(destination),set(loaded.collections),fake_user=True,compress=True)
    item={'key':key,'sourceFile':record['sourceFile'],'beforeSha256':before,'afterSha256':sha(destination),'capName':cap.name,'modifiedVertices':modified,'maxReliefMm':maximum,'before':before_topology,'after':after_topology,'flippedTriangles':flipped,'measuredCenterGapMm':gap}
    report['buttons'].append(item)
    output=ROOT/'docs/puretv-geometry-dpad-relief.json' if args.apply else ROOT.parent/'scratch/puretv-source-repair/dpad-relief-proposal.json'
    output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print('RELIEF',key,modified,'vertices','gap',gap,'max',maximum,flush=True)
