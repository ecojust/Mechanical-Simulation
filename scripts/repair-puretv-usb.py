"""Trim only the USB enclosure bottom to the actual PCB top plane.

The source USB body is a closed exterior envelope, not a detailed connector.
Preserve its top, sides above the board and every other electronics object.
"""
import argparse
import hashlib
import json
import runpy
import shutil
import sys
from pathlib import Path
from types import SimpleNamespace

import bpy
import numpy as np
from mathutils import Vector

ROOT=Path(__file__).resolve().parents[1];SOURCE=ROOT/'assets/puretv-controller'
RELATIVE='electronics/esp32-mount.blend';PATH=SOURCE/RELATIVE
BASELINE='81c1e24d812cbb482338e4ad5422b98f3a5e4b2f3d394015cf6276ec77f36e94'
SCRATCH=ROOT.parent/'scratch/puretv-usb-repair';SCRATCH.mkdir(parents=True,exist_ok=True)
parser=argparse.ArgumentParser();parser.add_argument('--apply',action='store_true')
args=parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
audit=runpy.run_path(str(ROOT/'scripts/audit-puretv-assembly.py'),run_name='puretv_assembly_helpers')
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def identity(obj):
    mesh=obj.data
    points=np.empty(len(mesh.vertices)*3,dtype=np.float64);mesh.vertices.foreach_get('co',points)
    loops=np.empty(len(mesh.loops),dtype=np.int32);mesh.loops.foreach_get('vertex_index',loops)
    return hashlib.sha256(points.tobytes()+loops.tobytes()+np.asarray(obj.matrix_world,dtype=np.float64).tobytes()).hexdigest()
def geometry(obj,tag):
    record=audit['extract'](obj,RELATIVE,tag,SCRATCH/'cache')
    return audit['Geometry'](record,0)
def short(g):
    return {k:g.record[k] for k in ['id','sourceName','vertices','triangles','boundsBlender','signedVolumeMm3','topology','componentCount']}

before_sha=sha(PATH)
if before_sha!=BASELINE:raise RuntimeError('USB repair requires the verified clamp-corrected source SHA')
backup=SCRATCH/'before.blend'
if not backup.exists():shutil.copy2(PATH,backup)
bpy.ops.wm.read_factory_settings(use_empty=True)
with bpy.data.libraries.load(str(PATH),link=False) as (available,loaded):loaded.collections=[n for n in available.collections if n.startswith('pureTV')]
for collection in loaded.collections:bpy.context.scene.collection.children.link(collection)
bpy.context.view_layer.update()
usb=bpy.data.objects['ESP32 · USB connector.005'];pcb=bpy.data.objects['ESP32 · 48.2 × 27.9 PCB.005']
others={obj.name:identity(obj) for obj in bpy.context.scene.objects if obj.type=='MESH' and obj is not usb}
before=geometry(usb,before_sha);board=geometry(pcb,before_sha)
before_contact=audit['audit_pair'](before,board,20000)
plane=float(board.bounds['max'][2]);low=np.array(before.bounds['min']);high=np.array(before.bounds['max'])
# A world-space cutter removes only the volume below the PCB surface.
cutter_low=low-np.array([1,1,10]);cutter_high=high+np.array([1,1,0]);cutter_high[2]=plane
bpy.ops.mesh.primitive_cube_add(size=1,location=(cutter_low+cutter_high)/2)
cutter=bpy.context.object;cutter.dimensions=cutter_high-cutter_low
bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
bpy.context.view_layer.objects.active=usb
modifier=usb.modifiers.new('USB envelope seat on PCB','BOOLEAN');modifier.operation='DIFFERENCE';modifier.solver='EXACT';modifier.object=cutter
bpy.ops.object.modifier_apply(modifier=modifier.name)
bpy.data.objects.remove(cutter,do_unlink=True);bpy.context.view_layer.update()
after=geometry(usb,before_sha+'-usb-trimmed')
after_contact=audit['audit_pair'](after,board,20000)
if not after.closed or after.record['componentCount']!=1:raise RuntimeError('USB enclosure must stay one closed component')
if after_contact['aInsideB']['insidePoints'] or after_contact['bInsideA']['insidePoints'] or after_contact['aInsideB']['uncertainPoints'] or after_contact['bInsideA']['uncertainPoints']:raise RuntimeError('USB still intrudes into PCB')
if abs(after.bounds['min'][2]-plane)>1e-5:raise RuntimeError('USB bottom is not seated on PCB')
for i in [0,1]:
    if abs(after.bounds['min'][i]-low[i])>1e-5 or abs(after.bounds['max'][i]-high[i])>1e-5:raise RuntimeError('USB lateral envelope changed')
if abs(after.bounds['max'][2]-high[2])>1e-5:raise RuntimeError('USB upper envelope changed')
protected=before.vertices[before.vertices[:,2]>=plane+1e-5]
max_protected=max(float(after.tree.find_nearest(Vector(v))[3]) for v in protected)
if max_protected>1e-5:raise RuntimeError('USB upper/side source surface changed')
unchanged={obj.name:identity(obj)==others[obj.name] for obj in bpy.context.scene.objects if obj.name in others}
if not all(unchanged.values()) or len(unchanged)!=43:raise RuntimeError('Non-USB electronics geometry changed')
region={'min':[max(low[0],board.bounds['min'][0])-1e-5,max(low[1],board.bounds['min'][1])-1e-5,plane-1e-5],'max':[min(high[0],board.bounds['max'][0])+1e-5,min(high[1],board.bounds['max'][1])+1e-5,plane+1e-5]}
rule={'id':'usb-enclosure-seated-on-pcb','pair':[after.record['id'],board.record['id']],'regionBlender':region,'maximumPenetrationMm':1e-5,'reason':'USB exterior enclosure rests on the actual PCB top plane. Only this coincident support face is allowed; no rigid enclosure volume enters the PCB.'}
after.amount=0;board.amount=0
audit['classify_allowed'](after_contact,after,board,[rule])
if after_contact['status']!='allowed-local-interface':raise RuntimeError('USB local support contact is not completely bounded')
candidate=SCRATCH/'candidate.blend'
usb['mechanicalRevision']='USB-bottom-seated-on-PCB-v1'
bpy.data.libraries.write(str(candidate),set(loaded.collections),fake_user=True,compress=True)
if args.apply:
    if sha(PATH)!=before_sha:raise RuntimeError('Source changed during repair')
    shutil.copy2(candidate,PATH)
report={'version':1,'status':'pass','applied':args.apply,'sourceFile':RELATIVE,'beforeSha256':before_sha,'afterSha256':sha(candidate),'afterBytes':candidate.stat().st_size,'objectCount':44,'target':usb.name,'fixedNeighbor':pcb.name,'before':short(before),'after':short(after),'pcbTopSourceZ':plane,'removedBottomThicknessMm':plane-low[2],'maximumProtectedUpperSurfaceDeviationMm':max_protected,'unchangedObjects':unchanged,'beforeContact':before_contact,'afterContact':after_contact,'interfaces':[rule],'limitations':['USB is a source exterior envelope; internal socket contacts, shielding construction and solder retention are not modelled. This repair establishes nominal rigid geometry seating, not electrical connector qualification.']}
output=ROOT/'docs/puretv-geometry-usb-repair.json' if args.apply else SCRATCH/'proposal.json'
output.write_text(json.dumps(report,indent=2,ensure_ascii=False,default=audit['native'])+'\n')
print('USB_REPAIRED',report['afterSha256'],report['afterBytes'],'removed',report['removedBottomThicknessMm'],'contact',after_contact['status'],flush=True)
