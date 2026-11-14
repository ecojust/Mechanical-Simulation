"""Repair explicitly documented wire backtracking; clean remaining local sweep overlap.

This is nominal source-solid cleanup, not a bend-radius/material qualification.
Default writes a scratch candidate. --apply changes only harness.blend and its
published route evidence, after every closed wire passes exact self checks.
"""
import argparse, hashlib, importlib.util, json, shutil, sys
from pathlib import Path
import bpy, bmesh, numpy as np
from mathutils import Matrix
ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT/'assets/puretv-controller/electronics/harness.blend'
SCRATCH = ROOT.parent/'scratch'
ROUTES = ROOT/'docs/puretv-geometry-harness-routing.json'
parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--apply',action='store_true')
args=parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
spec=importlib.util.spec_from_file_location('audit', ROOT/'scripts/audit-puretv-assembly.py')
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
sha=lambda path:hashlib.sha256(Path(path).read_bytes()).hexdigest()
before_sha=sha(SOURCE);route_report=json.loads(ROUTES.read_text())
if before_sha != route_report['sourceSha256'] or route_report.get('selfOverlapRepair'):
    raise RuntimeError('Source/route reference mismatch or already repaired; refusing repeated edit')
routes={r['name']:r for r in route_report['routes']}
# Each removed point is a real authored reversal, not a generic smoothing pass.
remove={'确认 · GPIO.005':[1], '确认 · GND.005':[-2], 'A · 中央走线 GND.002':[-2],
        'X · 中央走线 GND.002':[-2], 'Y · 中央走线 GND.002':[-2],
        '左 · 中央走线 GND.002':[-2], '右 · 中央走线 GND.002':[-3,-2],
        '下 · 中央走线 GND.002':[-2], '上 · 中央走线 GND.002':[4]}
changes=[]
for name,indices in remove.items():
    route=routes[name];old=route['points'];indices=sorted({index%len(old) for index in indices})
    if 0 in indices or len(old)-1 in indices:raise RuntimeError('Endpoint removal forbidden')
    route['points']=[p for index,p in enumerate(old) if index not in indices]
    route['backtrackCorrection']={'removedIndices':indices,'removedPoints':[old[i] for i in indices],
        'reason':'Remove a real return along the same conductor; preserve both authored electrical endpoint centers.'}
    changes.append({'name':name,**route['backtrackCorrection']})
bpy.ops.wm.open_mainfile(filepath=str(SOURCE))
for collection in list(bpy.data.collections):
    if collection.name.startswith('pureTV') and collection.name not in bpy.context.scene.collection.children:
        bpy.context.scene.collection.children.link(collection)
bpy.context.view_layer.update()
empty=bpy.data.collections.new('Exact local wire envelope cleanup');bpy.context.scene.collection.children.link(empty)


def geometry(obj,label):
    obj.data.update();bpy.context.view_layer.update()
    coordinates=np.asarray([v.co[:] for v in obj.data.vertices],dtype=np.float64)
    key=hashlib.sha256(coordinates.tobytes()+str([tuple(p.vertices) for p in obj.data.polygons]).encode()+label.encode()).hexdigest()
    record=a.extract(obj,'electronics/harness.blend',key,SCRATCH/'puretv-assembly-audit-cache')
    return a.Geometry(record,0)


def self_stats(g):
    exact=a.audit_self_intersections(g,tolerance=1e-8,shared_feature_tolerance=1e-7)
    return {**exact,'triangles':len(g.faces),
        'exactIntersectionPairs':exact['forbiddenTriangleIntersections'],
        'componentCount':g.record['componentCount'],'topology':g.record['topology'],
        'boundsBlender':g.bounds,'intersectionToleranceMm':1e-8}


def close_mesh(obj,weld=1e-6):
    bm=bmesh.new();bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=weld)
    bmesh.ops.dissolve_degenerate(bm,edges=list(bm.edges),dist=1e-9)
    bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces))
    if bm.calc_volume(signed=True)<0:bmesh.ops.reverse_faces(bm,faces=list(bm.faces))
    bm.to_mesh(obj.data);bm.free();obj.data.update()


def rebuild(obj,route):
    materials=list(obj.data.materials)
    curve=bpy.data.curves.new(obj.name+' corrected centerline','CURVE')
    curve.dimensions='3D';curve.bevel_depth=route['radius'];curve.bevel_resolution=3 if obj.name.startswith('确认') else 2
    curve.twist_mode='MINIMUM';curve.use_fill_caps=True
    spline=curve.splines.new('POLY');spline.points.add(len(route['points'])-1)
    for point,co in zip(spline.points,route['points']):point.co=(*co,1)
    temp=bpy.data.objects.new('wire candidate',curve);bpy.context.scene.collection.objects.link(temp)
    bpy.ops.object.select_all(action='DESELECT');temp.select_set(True);bpy.context.view_layer.objects.active=temp
    bpy.ops.object.convert(target='MESH');temp=bpy.context.object
    obj.data=temp.data;obj.matrix_world=Matrix.Identity(4)
    for material in materials:obj.data.materials.append(material)
    bpy.data.objects.remove(temp,do_unlink=True);close_mesh(obj)
    obj['routeControlPointsSourceMm']=json.dumps(route['points'])


objects=[];failed=[]
for name in sorted(routes):
    obj=bpy.data.objects[name];original=geometry(obj,'before');before=self_stats(original)
    if name in remove:rebuild(obj,routes[name])
    constructed=geometry(obj,'corrected-centerline');constructed_stats=self_stats(constructed)
    cleanups=[]
    if constructed_stats['status'] != 'pass':
        for attempt,weld in enumerate([1e-6,0.00015],1):
            mod=obj.modifiers.new('Union only overlapping local swept surfaces','BOOLEAN')
            mod.operation='UNION';mod.operand_type='COLLECTION';mod.collection=empty;mod.solver='EXACT';mod.use_self=True;mod.use_hole_tolerant=True
            bpy.context.view_layer.objects.active=obj;bpy.ops.object.modifier_apply(modifier=mod.name)
            close_mesh(obj,weld)
            intermediate=geometry(obj,'union-'+str(attempt));check=self_stats(intermediate)
            cleanups.append({'exactSelfUnionPass':attempt,'numericalWeldToleranceMm':weld,'selfAfter':check['exactIntersectionPairs']})
            if check['status']=='pass':break
    final=geometry(obj,'final');after=self_stats(final)
    triangles=final.vertices[final.faces]
    after['closedVolumeMm3']=abs(float(np.einsum('ij,ij->i',triangles[:,0],np.cross(triangles[:,1],triangles[:,2])).sum()/6))
    routes[name]['closedVolumeMm3']=after['closedVolumeMm3']
    bounds_delta=max(float(np.max(np.abs(np.asarray(final.bounds[k])-np.asarray(constructed.bounds[k])))) for k in ['min','max'])
    surface_deviation=max(float(constructed.tree.find_nearest(tuple(point))[3]) for point in final.vertices)
    row={'name':name,'before':before,'afterCenterlineCorrection':constructed_stats,'after':after,
         'centerlineEdited':name in remove,'cleanup':cleanups,
         'maximumCleanupBoundsChangeMm':bounds_delta,'maximumCleanupVertexDistanceFromInputSurfaceMm':surface_deviation,
         'endpointsUnchanged':routes[name]['points'][0]==routes[name]['endpoints'][0] and routes[name]['points'][-1]==routes[name]['endpoints'][-1],
         'nominalRadiusMm':routes[name]['radius']}
    objects.append(row)
    if after['status']!='pass' or not after['topology']['closedConsistentlyOriented'] or after['componentCount']!=1 or bounds_delta>0.0002 or not row['endpointsUnchanged']:
        failed.append(name)
    print('WIRE_SELF',name,'before',before['exactIntersectionPairs'],'after-path',constructed_stats['exactIntersectionPairs'],'after-clean',after['exactIntersectionPairs'],'closed',after['topology']['closedConsistentlyOriented'],flush=True)
bpy.data.collections.remove(empty)
candidate=SCRATCH/'puretv-harness-self-clean-candidate.blend'
bpy.ops.wm.save_as_mainfile(filepath=str(candidate),check_existing=False)
report={'schemaVersion':1,'sourceFile':'electronics/harness.blend','beforeSha256':before_sha,
        'sourceSha256':sha(candidate),'status':'candidate-rejected' if failed else 'candidate-pending-assembly-audit',
        'centerlineCorrections':changes,'objects':objects,'failed':failed,
        'scope':['The documented centerline reversals are actual route corrections; all electrical endpoint centers remain unchanged.',
          'Remaining local adjacent sweep overlaps are resolved using exact solid union; numerical coincident-vertex welding is bounded and reported separately.',
          'The nominal conductor envelope and endpoint locations do not establish manufacturable cable bend radius, insulation thickness, fatigue, solder quality or electrical pin identity.',
          'Discrete centerline corners and local swept envelopes are modeling choices; wire material bending has not been physically measured or certified.',
          'Inter-object and joint-range collision validation must be rerun against this exact final source hash.']}
output=SCRATCH/'puretv-geometry-harness-self-repair-candidate.json'
if args.apply:
    if failed:raise RuntimeError('Self checks failed: '+', '.join(failed))
    if sha(SOURCE)!=before_sha:raise RuntimeError('Source changed concurrently')
    backup=SCRATCH/'puretv-harness-before-self-repair.blend'
    if not backup.exists():shutil.copy2(SOURCE,backup)
    shutil.copy2(candidate,SOURCE)
    report['status']='applied-pending-assembly-audit';output=ROOT/'docs/puretv-geometry-harness-self-repair.json'
    route_report['sourceSha256']=report['sourceSha256'];route_report['status']='applied-pending-full-source-audit'
    route_report['selfOverlapRepair']='docs/puretv-geometry-harness-self-repair.json'
    route_report['routes']=list(routes.values())
    route_report['changedObjects']=sorted(set(route_report['changedObjects'])|{r['name'] for r in objects if r['centerlineEdited'] or r['cleanup']})
    route_report['limits'].append('Discrete centerline corners and nominal swept surfaces do not establish a physically measured or qualified wire bend radius.')
    ROUTES.write_text(json.dumps(route_report,ensure_ascii=False,indent=2)+'\n')
output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print('SELF_CANDIDATE',report['sourceSha256'],'failed',failed,flush=True)
