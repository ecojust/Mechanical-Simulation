"""Measure final source geometry and emit the MCP assembly calibration.

Run in Blender >= 5.2 after all source corrections and before GLB export.
Measured geometry and assumed material/switch parameters are kept distinct.
"""
import argparse
import sys
import gc
import hashlib
import json
import math
import runpy
from pathlib import Path
import bpy
import numpy as np
from mathutils import Vector

ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'assets/puretv-controller'
audit=runpy.run_path(str(ROOT/'scripts/audit-puretv-internals.py'),run_name='puretv_audit_helpers')
evaluated=audit['evaluated'];ray_heights=audit['ray_heights'];gltf=audit['gltf'];clean=audit['clean']
sha=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
repairs=json.loads((ROOT/'docs/puretv-geometry-button-repairs.json').read_text())
manifest=json.loads((SOURCE/'manifest.json').read_text())
report={'version':1,'offset':[0,20,0],'coordinates':'Source millimetres/Z-up to client (x,z,-y); common [0,20,0] offset is applied only when instantiating the assembly.','sourceSha256':{entry['file']:sha(SOURCE/entry['file']) for entry in manifest['assets']},'buttons':[],'assumptions':[
    'Nominal travel 1.00 mm; measured rest gap 0.75 mm; rated switch overtravel 0.25 mm is a declared 6x6/H4.3 round-plunger specification that requires actual component matching and measurement.',
    'Switch reaction/trigger force is not included in the mass-spring model. Electrical contact closes when the declared physical faces touch. This does not certify real switch feel.',
    'Eight main switches use revised D2.85 mm round actuators. Confirmation uses its original round actuator. The external switch-body model does not model internal cavities or compliant contacts.',
    'Moving mass assumes homogeneous PLA density 1.24 g/cm^3 and uses the evaluated closed source cap volume. Zero-extrusion source lettering is treated as a massless decorative surface; no fictitious volume is inferred from its open triangles. No infill or density measurement is claimed.',
    'Spring k uses G=79000 N/mm^2 and k=G*d^4/(8*D^3*N), d=max source wire envelope, measured mean coil diameter and centreline turn count. Source wire scaling is slightly anisotropic; stiffness is nominal, not a measured force curve.',
    'Damping uses assumed damping ratio 0.65 and c=2*zeta*sqrt(k*1000*mass), units N s/m. Solid height=(N+1)*max wire envelope is a conservative geometric estimate, not a spring specification.',
    'Guide cylinder proxies represent the measured central shaft and minimum sampled central bore over the axial guide band only. Interleaved outer arcs, retention ears, cap shoulders and housing are covered by separate source-mesh audits; they are not represented by these cylinders.',
    'Proxy diametral manufacturing tolerance is +/-0.10 mm for each part; minClearance is radial. Local axial relief and housing lateral tolerances are documented separately.',
    'Spring visual/source-path compression is the declared axial affine deformation about the fixed lower endpoint. It preserves the measured end-to-end displacement but is not a constant-wire-section elastic deformation or finite-element model.',
    'Path evidence is discrete sampled source geometry, not continuous collision detection or a guarantee for fabricated material, friction, wear or tolerances.'
]}
parser=argparse.ArgumentParser();parser.add_argument('--only',action='append',help='Re-measure a button key; retain unchanged button calibrations and refresh global source hashes.')
args=parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
if args.only:
    prior=json.loads((ROOT/'docs/puretv-calibration.json').read_text())
    for button in prior['buttons']:
        if button['key'] not in args.only and sha(SOURCE/button['sourceFile'])!=button['sourceSha256']:raise RuntimeError('Also re-calibrate changed source: '+button['sourceFile'])
    report['buttons']=[b for b in prior['buttons'] if b['key'] not in args.only]
labels={'left':'左','right':'右','down':'下','up':'上','a':'A','b':'B','x':'X','y':'Y','confirm':'确认'}
for entry in manifest['assets']:
    if not entry['file'].startswith('buttons/'):continue
    key=Path(entry['file']).stem;path=SOURCE/entry['file'];before=sha(path)
    if args.only and key not in args.only:continue
    repair=next(v for v in repairs['buttons'] if v['key']==key)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    with bpy.data.libraries.load(str(path),link=False) as (available,loaded):loaded.collections=[n for n in available.collections if n.startswith('pureTV')]
    for c in loaded.collections:bpy.context.scene.collection.children.link(c)
    bpy.context.view_layer.update()
    objects={obj.name:evaluated(obj) for obj in bpy.context.scene.objects if obj.type in {'MESH','CURVE','FONT','SURFACE'}}
    def find(tokens):return next(g for name,g in objects.items() if any(t in name for t in tokens))
    cap=find(['一体式键帽与蓝色插销','同款插销与圆形键帽','确认 · 键帽']);spring=find(['回位弹簧','回弹压簧']);sleeve=find(['下环一体式开关套筒','旋锁座']);actuator=find(['按杆','开关触头']);body=find(['6×6 开关','常开开关'])
    x,y=(actuator.low+actuator.high)[:2]/2
    tip=ray_heights(cap,x,y)[0]['z'];top=ray_heights(actuator,x,y)[-1]['z'];free=float(spring.high[2]-spring.low[2])
    # The guide band is the sleeve above the switch body, not the unrelated
    # baseplate attachment below it. Rays record the inner central free cylinder.
    band_low=float(body.high[2]);band_high=float(sleeve.high[2]);bore=[];shaft=[]
    for z in np.linspace(band_low+.01,band_high-.01,17):
        for angle in np.linspace(.007,2*math.pi+.007,64,endpoint=False):
            direction=Vector((math.cos(angle),math.sin(angle),0));origin=Vector((x,y,z))
            hit,normal,index,distance=sleeve.bvh.ray_cast(origin,direction,30)
            if hit is not None and normal.dot(direction)*sleeve.orientation<-.1:bore.append(float(distance))
    for angle in np.linspace(.007,2*math.pi+.007,64,endpoint=False):
        direction=Vector((math.cos(angle),math.sin(angle),0));hit,normal,index,distance=cap.bvh.ray_cast(Vector((x,y,tip+.2)),direction,30)
        if hit is not None and normal.dot(direction)*cap.orientation>.1 and distance<3:shaft.append(float(distance))
    if not bore or not shaft:raise RuntimeError(f'{key}: no central shaft/bore witness')
    pin=2*max(shaft);hole=2*min(bore);outer=2*float(np.max(np.linalg.norm(sleeve.v[:,:2]-np.array([x,y]),axis=1)))
    moving=[cap.name]+[n for n in objects if '键帽标识' in n]
    terminals=[n for n in objects if '焊脚' in n]
    if len(terminals)!=(2 if key=='confirm' else 4):raise RuntimeError(f'{key}: source terminal inventory differs from the audited assembly subgroup')
    massless=[n for n in moving if not objects[n].closed]
    if any('键帽标识' not in n for n in massless):raise RuntimeError(f'{key}: cannot estimate mass of an open functional solid')
    volume=sum(abs(objects[n].signed_volume) for n in moving if objects[n].closed)
    mass=volume*1.24e-6
    spec=repair['springParameters'];diameter=spec['nominalWireDiameterMm'];coil=spec['meanCoilDiameterMm'];turns=spec['centerlineTurns']
    stiffness=79000*diameter**4/(8*coil**3*turns);damping=2*.65*math.sqrt(stiffness*1000*mass)
    shaft_height=min(2.0,float(sleeve.high[2]-tip+1.0))
    support={}
    for label,target,height in [('lower',sleeve,spring.low[2]),('upper',cap,spring.high[2])]:
        ids=np.flatnonzero(abs(spring.v[:,2]-height)<.002);witnesses=[]
        for i in ids:
            point=spring.v[i];near,normal,face,distance=target.bvh.find_nearest(Vector(point))
            witnesses.append({'springSource':point.tolist(),'supportSource':list(near),'distanceMm':float(distance),'normalSource':list(normal)})
        support[label]={'supportName':target.name,'minimumEndpointDistanceMm':min(w['distanceMm'] for w in witnesses),'witnesses':sorted(witnesses,key=lambda w:w['distanceMm'])[:3]}
    button={'key':key,'label':labels[key],'assetId':'buttons-'+key,'sourceFile':entry['file'],'sourceSha256':before,'installationPrimaryNode':sleeve.name,'installationMovingNodes':[body.name,actuator.name,*terminals],'movingNodes':moving,'springNodes':[spring.name],'switchNode':actuator.name,'electricalSwitchNode':body.name,'actuatorNodes':[actuator.name],'strikerNode':cap.name,'strikerSourceClient':gltf([x,y,tip]),'switchSourceClient':gltf([x,y,top]),'axis':[0,1,0],'travel':1.0,'maxOvertravel':.25,'measuredRestGap':tip-top,'freeLength':free,'solidLength':spec['conservativeSolidLengthMm'],'stiffness':stiffness,'mass':mass,'damping':damping,'springMeasured':{'bottomSourceZ':float(spring.low[2]),'topSourceZ':float(spring.high[2]),**spec},'springSupportWitnesses':support,'zeroThicknessDecorationNodes':massless,'movingVolumeMm3':volume,'guide':{'basis':'central-shaft and sampled central-free-bore only; outer interleaved arcs require source audit','pinDiameter':pin,'holeDiameter':hole,'outerDiameter':outer,'height':band_high-band_low,'centerClient':gltf([x,y,(band_low+band_high)/2]),'shaftHeight':shaft_height,'shaftCenterClient':gltf([x,y,tip+shaft_height/2]),'tolerance':.1,'minClearance':.1,'insertionDepth':max(max(0,min(tip+shaft_height-d,band_high)-max(tip-d,band_low)) for d in np.linspace(0,1,101)),'shaftRadiusSamples':len(shaft),'boreRadiusSamples':len(bore),'axialBandSource':[band_low,band_high],'nominalMinimumRadialClearance':(hole-pin)/2,'worstCaseRadialClearance':(hole-pin-.2)/2},'objects':[g.report() for g in objects.values()]}
    if abs(button['measuredRestGap']-.75)>1e-4:raise RuntimeError(f'{key}: gap changed')
    if before!=sha(path):raise RuntimeError('Source changed during measurement')
    report['buttons'].append(button)
    report['buttons'].sort(key=lambda b:list(labels).index(b['key']))
    (ROOT/'docs/puretv-calibration.json').write_text(json.dumps(report,indent=2,ensure_ascii=False,default=clean)+'\n')
    print('CALIBRATED',key,'gap',tip-top,'guide',pin,hole,'spring',free,'mass',mass,flush=True)
    del objects,cap,spring,sleeve,actuator,body
    bpy.ops.wm.read_factory_settings(use_empty=True);gc.collect()
