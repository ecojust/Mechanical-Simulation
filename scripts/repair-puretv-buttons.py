"""Calibrate source button tips, join upper spring locators, and close spring ends.

Default writes proposed .blend files outside the repository. --apply saves the
audited changes to source assets; manifest is updated separately after all repairs.
"""
import argparse
import hashlib
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
SCRATCH = ROOT.parent / 'scratch/puretv-source-repair'
SCRATCH.mkdir(parents=True, exist_ok=True)
TARGET_GAP = 0.75

def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def mesh_world(obj):
    graph = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(graph), depsgraph=graph)
    mesh.calc_loop_triangles()
    points = [obj.matrix_world @ v.co for v in mesh.vertices]
    faces = [tuple(t.vertices) for t in mesh.loop_triangles]
    return mesh, points, faces
def topology(obj):
    mesh, points, faces = mesh_world(obj)
    bm = bmesh.new(); bm.from_mesh(mesh)
    visited, components = set(), []
    for v in bm.verts:
        if v in visited: continue
        pending=[v];visited.add(v);count=0
        while pending:
            point=pending.pop();count+=1
            for edge in point.link_edges:
                nxt=edge.other_vert(point)
                if nxt not in visited:visited.add(nxt);pending.append(nxt)
        components.append(count)
    result={'vertices':len(mesh.vertices),'triangles':len(faces),'boundaryEdges':sum(e.is_boundary for e in bm.edges),'nonManifoldEdges':sum(not e.is_manifold for e in bm.edges),'components':components,'volumeMm3':abs(bm.calc_volume(signed=True)*obj.matrix_world.to_3x3().determinant()),'sourceMin':[min(v[i] for v in points) for i in range(3)],'sourceMax':[max(v[i] for v in points) for i in range(3)]}
    bm.free();bpy.data.meshes.remove(mesh)
    return result
def axial_faces(obj, x, y):
    mesh, points, faces = mesh_world(obj)
    bvh=BVHTree.FromPolygons(points,faces,all_triangles=True)
    zmin=min(v.z for v in points);zmax=max(v.z for v in points)
    origin=Vector((x,y,zmin-1));direction=Vector((0,0,1));heights=[]
    for _ in range(100):
        point,normal,index,distance=bvh.ray_cast(origin,direction,zmax-origin.z+1)
        if point is None:break
        heights.append(float(point.z));origin=point+direction*.0001
    bpy.data.meshes.remove(mesh)
    return heights
def apply_boolean(target, other, operation='UNION'):
    bpy.context.view_layer.objects.active=target
    modifier=target.modifiers.new('Audited mechanical connection','BOOLEAN')
    modifier.operation=operation;modifier.solver='EXACT';modifier.object=other
    modifier.use_self=True;modifier.use_hole_tolerant=True
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    bpy.data.objects.remove(other,do_unlink=True)

parser=argparse.ArgumentParser()
parser.add_argument('--apply',action='store_true');parser.add_argument('--only',action='append')
args=parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
manifest=json.loads((SOURCE/'manifest.json').read_text())
report={'version':1,'targetGapMm':TARGET_GAP,'nominalTravelMm':1,'switchNominalOvertravelMm':.25,'switchAssumption':'H4.3 nominal placeholder; actual force/travel rating requires component datasheet and measurement.','applied':args.apply,'buttons':[]}
for entry in manifest['assets']:
    if not entry['file'].startswith('buttons/'):continue
    key=Path(entry['file']).stem
    if args.only and key not in args.only:continue
    source=SOURCE/entry['file'];before=sha(source)
    backup=SCRATCH/'before'/entry['file'];backup.parent.mkdir(parents=True,exist_ok=True)
    if not backup.exists():shutil.copy2(source,backup)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    with bpy.data.libraries.load(str(source),link=False) as (available,loaded):loaded.collections=[n for n in available.collections if n.startswith('pureTV')]
    collections=loaded.collections
    for collection in collections:bpy.context.scene.collection.children.link(collection)
    bpy.context.view_layer.update()
    def find(tokens):return next((o for o in bpy.context.scene.objects if any(t in o.name for t in tokens)),None)
    cap=find(['一体式键帽与蓝色插销','同款插销与圆形键帽','确认 · 键帽'])
    ring=find(['弹簧定位环']);spring=find(['回位弹簧','回弹压簧']);actuator=find(['按杆','开关触头'])
    contact_bounds=topology(actuator)
    x,y=[(contact_bounds['sourceMin'][i]+contact_bounds['sourceMax'][i])/2 for i in [0,1]]
    tip_before=axial_faces(cap,x,y)[0];contact_z=axial_faces(actuator,x,y)[-1];tip_target=contact_z+TARGET_GAP
    cap_before=topology(cap);ring_before=topology(ring) if ring else None;spring_before=topology(spring)
    modified=0;inverse=cap.matrix_world.inverted()
    for vertex in cap.data.vertices:
        point=cap.matrix_world@vertex.co
        if math.hypot(point.x-x,point.y-y)<2.0 and point.z<tip_target and point.z<=tip_before+.0001:
            point.z=tip_target;vertex.co=inverse@point;modified+=1
    cap.data.update()
    ring_name=ring.name if ring else None
    if ring:apply_boolean(cap,ring)
    spring_parameters={}
    if spring.type=='CURVE':
        spline=spring.data.splines[0]
        points=np.array([list(spring.matrix_world@p.co.xyz) for p in spline.points])
        if len(points):
            center=np.array([x,y]);angles=np.unwrap(np.arctan2(points[:,1]-center[1],points[:,0]-center[0]));turns=abs(angles[-1]-angles[0])/(2*math.pi)
            diameter=2*spring.data.bevel_depth*max(spring.matrix_world.to_scale())
            spring_parameters={'centerlineStartSource':points[0].tolist(),'centerlineEndSource':points[-1].tolist(),'centerlineTurns':float(turns),'nominalWireDiameterMm':float(diameter),'wireEnvelopeAxesMm':[float(2*spring.data.bevel_depth*v) for v in spring.matrix_world.to_scale()],'meanCoilDiameterMm':float(2*np.linalg.norm(points[:,:2]-center,axis=1).mean()),'conservativeSolidLengthMm':float((turns+1)*diameter),'note':'Solid length is a conservative geometry estimate; source scaling makes the wire envelope slightly anisotropic. This is not a measured spring specification.'}
        spring.data.use_fill_caps=False
        bpy.ops.object.select_all(action='DESELECT');spring.select_set(True);bpy.context.view_layer.objects.active=spring
        bpy.ops.object.convert(target='MESH');spring=bpy.context.view_layer.objects.active
        spring['sourceCenterlineParameters']=json.dumps(spring_parameters)
    bm=bmesh.new();bm.from_mesh(spring.data);bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=1e-6);bmesh.ops.holes_fill(bm,edges=[e for e in bm.edges if e.is_boundary],sides=0);bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bm.to_mesh(spring.data);bm.free()
    bpy.context.view_layer.update()
    cap_after=topology(cap);spring_after=topology(spring)
    measured_gap=axial_faces(cap,x,y)[0]-axial_faces(actuator,x,y)[-1]
    if abs(measured_gap-TARGET_GAP)>.0001:raise RuntimeError(f'{key}: contact gap {measured_gap}')
    if cap_after['nonManifoldEdges'] or len(cap_after['components'])!=1:raise RuntimeError(f'{key}: cap union is not one closed component: {cap_after}')
    if spring_after['nonManifoldEdges'] or len(spring_after['components'])!=1:raise RuntimeError(f'{key}: spring cap failed: {spring_after}')
    destination=source if args.apply else SCRATCH/'proposed'/entry['file'];destination.parent.mkdir(parents=True,exist_ok=True)
    for collection in collections:collection['mechanicalRevision']='puretv-striker075-ringunion-springcaps-v1'
    bpy.data.libraries.write(str(destination),set(collections),fake_user=True,compress=True)
    record={'key':key,'sourceFile':entry['file'],'beforeSha256':before,'afterSha256':sha(destination),'destination':str(destination.relative_to(ROOT)) if args.apply else 'scratch/proposed/'+entry['file'],'capName':cap.name,'mergedUpperLocator':ring_name,'movedTipVertices':modified,'tipShorteningMm':tip_target-tip_before,'contactSource':[x,y,contact_z],'strikerSource':[x,y,contact_z+measured_gap],'measuredGapMm':measured_gap,'beforeCap':cap_before,'beforeRing':ring_before,'afterCap':cap_after,'beforeSpring':spring_before,'afterSpring':spring_after,'springParameters':spring_parameters,'objects':[{'exported':obj.name,'world_matrix':[list(row) for row in obj.matrix_world]} for obj in bpy.context.scene.objects if obj.type in {'MESH','CURVE','SURFACE','FONT'}]}
    report['buttons'].append(record)
    output=ROOT/'docs'/('puretv-geometry-button-repairs.json' if args.apply else 'puretv-geometry-button-repair-proposal.json')
    output.write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n')
    print('REPAIRED',key,'gap',measured_gap,'capTopology',cap_after['components'],cap_after['nonManifoldEdges'],'spring',spring_parameters,flush=True)
