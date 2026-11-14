"""Replace square switch placeholders by specified D2.85 mm round plungers.

Preserves each original actuator centre, top and bottom plane, material and
object transform. The nominal round-plunger 6x6/H4.3 switch must be sourced to
match this declaration; the mesh cannot certify switch force or rated travel.
"""
import hashlib
import json
import math
from pathlib import Path
import bpy
import bmesh
from mathutils import Vector

ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'assets/puretv-controller'
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
prior=json.loads((ROOT/'docs/puretv-geometry-actuator-repair.json').read_text()) if (ROOT/'docs/puretv-geometry-actuator-repair.json').exists() else {'buttons':[]}
manifest=json.loads((SOURCE/'manifest.json').read_text())
report={'version':1,'applied':True,'nominalDiameterMm':2.85,'nominalHoleDiameterMm':3.46362,'nominalRadialClearanceMm':.30681,'diametralTolerancePerPartMm':.1,'worstCaseNominalRadialClearanceMm':.20681,'specification':'Nominal round-plunger 6x6/H4.3 switch, D2.85 mm, original 1.30 mm visible height and 0.25 mm allowed travel; procurement must match. Force and rated travel are assumed, not source-mesh measurements.','buttons':[]}
for entry in manifest['assets']:
    if not entry['file'].startswith('buttons/') or entry['file']=='buttons/confirm.blend':continue
    path=SOURCE/entry['file'];before=sha(path)
    original=next((b for b in prior['buttons'] if b['sourceFile']==entry['file']),None)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    with bpy.data.libraries.load(str(path),link=False) as (available,loaded):loaded.collections=[n for n in available.collections if n.startswith('pureTV')]
    for c in loaded.collections:bpy.context.scene.collection.children.link(c)
    bpy.context.view_layer.update()
    obj=next(o for o in bpy.context.scene.objects if '按杆' in o.name)
    old=[obj.matrix_world@v.co for v in obj.data.vertices]
    low=[min(p[i] for p in old) for i in range(3)];high=[max(p[i] for p in old) for i in range(3)]
    x,y=[(low[i]+high[i])/2 for i in [0,1]];inverse=obj.matrix_world.inverted();n=128
    vertices=[inverse@Vector((x+1.425*math.cos(2*math.pi*i/n),y+1.425*math.sin(2*math.pi*i/n),z)) for z in [low[2],high[2]] for i in range(n)]
    faces=[tuple(range(n-1,-1,-1)),tuple(range(n,2*n))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    mesh=bpy.data.meshes.new(obj.data.name+'__roundD330');mesh.from_pydata(vertices,[],faces);mesh.update()
    for material in obj.data.materials:mesh.materials.append(material)
    old_mesh=obj.data;obj.data=mesh
    if old_mesh.users==0:bpy.data.meshes.remove(old_mesh)
    bm=bmesh.new();bm.from_mesh(mesh);bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bm.to_mesh(mesh)
    nonmanifold=sum(not e.is_manifold for e in bm.edges);bm.free()
    if nonmanifold:raise RuntimeError('Actuator is not closed')
    obj['nominalSwitchSpecification']='Round plunger D2.85 mm / 6x6 / H4.3; visible height unchanged; allowed travel 0.25 mm'
    bpy.data.libraries.write(str(path),set(loaded.collections),fake_user=True,compress=True)
    report['buttons'].append({'key':Path(entry['file']).stem,'sourceFile':entry['file'],'beforeSha256':original['beforeSha256'] if original else before,'intermediateD330Sha256':before if original else None,'afterSha256':sha(path),'actuatorName':obj.name,'oldSourceMin':original['oldSourceMin'] if original else low,'oldSourceMax':original['oldSourceMax'] if original else high,'centerSourceXY':[x,y],'bottomSourceZ':low[2],'topSourceZ':high[2],'newDiameterMm':2.85,'segments':n,'boundaryEdges':0,'nonManifoldEdges':0})
    (ROOT/'docs/puretv-geometry-actuator-repair.json').write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n')
    print('ROUND_ACTUATOR',entry['file'],obj.name,'top',high[2],flush=True)
