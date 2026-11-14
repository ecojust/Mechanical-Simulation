"""Measure each named latch-pad preload interface, never exempt a whole type."""
import gc
import hashlib
import json
import runpy
from pathlib import Path
from types import SimpleNamespace
import bpy
import numpy as np
from mathutils import Vector

ROOT=Path(__file__).resolve().parents[1];SOURCE=ROOT/'assets/puretv-controller'
helpers=runpy.run_path(str(ROOT/'scripts/audit-puretv-internals.py'),run_name='puretv_audit_helpers')
evaluated=helpers['evaluated'];intersection=helpers['intersection'];clean=helpers['clean']
kernel=runpy.run_path(str(ROOT/'scripts/audit-puretv-assembly.py'),run_name='puretv_assembly_helpers')
def adapt(g):
    if not hasattr(g,'proofGeometry'):g.proofGeometry=SimpleNamespace(vertices=g.v,faces=g.f,tree=g.bvh,bounds={'min':g.low,'max':g.high},closed=g.closed,orientation=g.orientation,surface_only=False)
    return g.proofGeometry
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
manifest=json.loads((SOURCE/'manifest.json').read_text())
report={'version':1,'status':'unknown','coordinates':'World source mm/Z-up; client=(x,z,-y).','scope':'24 individually named elastic latch pads against their own source sleeves; also measure adjacent baseplate faces.','assumptions':['The objects explicitly named elastic latch pads are declared compliant inserts. Their elastic modulus, preload force, compression set and fabrication material are not established by the mesh.','Only the measured shallow axial preload at each named support plane may be allowed. Lateral interference, deeper penetration and other object pairs are not covered.'],'interfaces':[]}
for entry in manifest['assets']:
    if not entry['file'].startswith('buttons/') or entry['file']=='buttons/confirm.blend':continue
    key=Path(entry['file']).stem;plate_file='baseplates/dpad.blend' if key in ['left','right','down','up'] else 'baseplates/abxy.blend'
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for relative in [entry['file'],plate_file]:
        with bpy.data.libraries.load(str(SOURCE/relative),link=False) as (available,loaded):loaded.collections=[n for n in available.collections if n.startswith('pureTV')]
        for c in loaded.collections:bpy.context.scene.collection.children.link(c)
    bpy.context.view_layer.update()
    sleeve=evaluated(next(o for o in bpy.context.scene.objects if '下环一体式开关套筒' in o.name))
    plate_obj=next(o for o in bpy.context.scene.objects if o.type=='MESH' and '中央走线方形底座' in o.name and '螺钉' not in o.name)
    plate=evaluated(plate_obj)
    for obj in list(bpy.context.scene.objects):
        if '旋锁弹性垫' not in obj.name:continue
        pad=evaluated(obj);center=(pad.low+pad.high)/2
        item={'key':key,'padName':pad.name,'sleeveName':sleeve.name,'sourceFile':entry['file'],'sourceSha256':sha(SOURCE/entry['file']),'plateFile':plate_file,'plateSha256':sha(SOURCE/plate_file),'padSourceMin':pad.low,'padSourceMax':pad.high,'padThicknessMm':float(pad.high[2]-pad.low[2]),'checks':[]}
        for target,side in [(sleeve,'sleeve'),(plate,'baseplate')]:
            result=intersection(pad,target)
            witnesses=result.get('penetrationWitnesses',[])
            for witness in witnesses:
                containing=pad if witness['containingObject']==pad.name else target
                hit,normal,face,distance=containing.bvh.find_nearest(Vector(witness['pointSource']))
                witness['normalSource']=list(normal)
            result.update(partNames=[pad.name,target.name],side=side)
            top=side=='sleeve';maximum=.00505 if top or key in ['left','right','down','up'] else 1e-5
            low=pad.low.copy()-1e-5;high=pad.high.copy()+1e-5
            if top:low[2]=pad.high[2]-.00505-1e-5
            else:high[2]=pad.low[2]+maximum+1e-5
            region={'min':low,'max':high}
            proof_result={'possibleOverlapBoundsBlender':kernel['box_region'](adapt(pad).bounds,adapt(target).bounds),'conservativeCrossingRegionBlender':{'min':result.get('sourceCrossingRegionMin',pad.low),'max':result.get('sourceCrossingRegionMax',pad.high)}}
            proof=kernel['prove_local_region'](proof_result,adapt(pad),adapt(target),region)
            result['localRegionProof']=proof
            declaration={'id':key+'-'+pad.name+'-'+side,'pair':[entry['file']+'::'+pad.name,(entry['file'] if top else plate_file)+'::'+target.name],'regionBlender':region,'maximumPenetrationMm':maximum,'reason':('Named compliant pad upper-face preload against its own sleeve, nominal 0.005 mm axial compression.' if top else 'Named compliant pad lower-face contact against its own baseplate; Dpad nominal 0.005 mm axial preload, ABXY zero-depth seating.'),'sourceReferences':[entry['file'],entry['file'] if top else plate_file]}
            result['interfaceDeclaration']=declaration
            if proof['proven'] and result['maximumSampledPenetrationMm']<=maximum+1e-5:
                result['rawStatus']=result['status'];result['status']='allowed-local-interface'
                result['allowedInterface']={'id':declaration['id'],'reason':declaration['reason'],'regionBlenderAtPose':region,'maximumPenetrationMm':maximum,'localRegionProof':proof}

            item['checks'].append(result)
        static_compression=sum(c['maximumSampledPenetrationMm'] for c in item['checks'])
        item['preload']={'measuredStaticCompressionMm':static_compression,'staticStrainFraction':static_compression/item['padThicknessMm'],'nominalLockedThicknessMm':item['padThicknessMm']-static_compression,'requiredAdditionalAssemblyCompressionMm':.25,'nominalAssemblyCompressionMm':.25+static_compression,'nominalAssemblyRemainingThicknessMm':item['padThicknessMm']-.25-static_compression,'nominalAssemblyStrainFraction':(.25+static_compression)/item['padThicknessMm'],'limitation':'Latch-path rigid geometry requires an additional 0.25 mm axial push. About half of the free pad thickness is compressed during assembly. No allowable material strain, assembly force, nonlinear stiffness, compression set or durability is established; matching compliant material and physical testing are required.'}
        report['interfaces'].append(item)
        print('PAD',key,pad.name,'thickness',item['padThicknessMm'],[(c['side'],c['status'],c['maximumSampledPenetrationMm']) for c in item['checks']],flush=True)
        del pad
    (ROOT/'docs/puretv-geometry-pad-interfaces.json').write_text(json.dumps(report,indent=2,ensure_ascii=False,default=clean)+'\n')
    del sleeve,plate
    bpy.ops.wm.read_factory_settings(use_empty=True);gc.collect()
report['sourceSha256']={p:sha(SOURCE/p) for item in report['interfaces'] for p in [item['sourceFile'],item['plateFile']]}
report['flatInterfaces']=[c['interfaceDeclaration'] for item in report['interfaces'] for c in item['checks']]
report['status']='pass' if len(report['interfaces'])==24 and all(c['status'] in ['allowed-local-interface','disjoint-bounds','no-intersection-found'] for p in report['interfaces'] for c in p['checks']) else 'unknown'
(ROOT/'docs/puretv-geometry-pad-interfaces.json').write_text(json.dumps(report,indent=2,ensure_ascii=False,default=clean)+'\n')
print('PAD_INTERFACE_REPORT_READY',report['status'],flush=True)
