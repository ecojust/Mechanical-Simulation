"""Small Blender regressions for full-source audit decisions and joint-pose coverage."""
from pathlib import Path
import importlib.util
from types import SimpleNamespace
import bmesh
import numpy as np
from mathutils.bvhtree import BVHTree
spec=importlib.util.spec_from_file_location('audit',str(Path(__file__).with_name('audit-puretv-assembly.py')));audit=importlib.util.module_from_spec(spec);spec.loader.exec_module(audit)
def cube(name,center=(0,0,0),scale=1,reverse=False):
 bm=bmesh.new();bmesh.ops.create_cube(bm,size=2);bmesh.ops.triangulate(bm,faces=list(bm.faces));bm.verts.index_update()
 v=np.asarray([list(x.co) for x in bm.verts])*scale+np.array(center);f=np.array([[x.index for x in face.verts] for face in bm.faces],dtype=np.int32);bm.free()
 if reverse:f=f[:,[0,2,1]]
 return SimpleNamespace(vertices=v,faces=f,bounds=audit.bounds(v),record={'id':name,'componentRepresentativeVertices':[0],'componentCount':1},tree=BVHTree.FromPolygons(v.tolist(),f.tolist(),all_triangles=True),orientation=-1 if reverse else 1,closed=True,amount=0)
a=cube('outer');b=cube('inner',scale=.2)
assert audit.audit_pair(a,b,128)['status']=='penetration-evidence'
assert audit.audit_pair(a,cube('far',center=(4,0,0)),128)['status']=='no-intersection-observed'
assert audit.audit_pair(a,cube('crossing',center=(1.5,0,0)),128)['status']=='penetration-evidence'
assert audit.audit_pair(cube('reverse',reverse=True),b,128)['status']=='penetration-evidence'
open_cube=cube('open');open_cube.closed=False
assert audit.audit_pair(open_cube,b,128)['status'].startswith('unknown')
face=cube('face',center=(2,0,0));result=audit.audit_pair(a,face,128)
assert result['status'].startswith('unknown')
audit.classify_allowed(result,a,face,[{'id':'face-contact','pair':['outer','face'],'reason':'Declared exact mating faces','regionBlender':{'min':[1,-1,-1],'max':[1,1,1]},'maximumPenetrationMm':1e-5}])
assert result['status']=='allowed-local-interface',result
other=cube('other',center=(.5,0,0));v=np.concatenate((a.vertices,other.vertices));f=np.concatenate((a.faces,other.faces+len(a.vertices)))
double=SimpleNamespace(vertices=v,faces=f,bounds=audit.bounds(v),record={'id':'double','componentRepresentativeVertices':[0,8],'componentCount':2},tree=BVHTree.FromPolygons(v.tolist(),f.tolist(),all_triangles=True),orientation=1,closed=True,amount=0)
assert audit.winding_inside(double,np.array([.25,0,0])) is True
objects=[{'id':name,'key':name,'role':'cap','triangles':12,'boundsBlender':{'min':[x,0,0],'max':[x+2,2,2]}} for name,x in [('a',0),('b',1),('c',10)]]
jobs,contexts,digest,joint=audit.plan(objects,[0,.25,.5,.75,1],.75)
assert joint['movingObjectPairs']==3 and joint['strictlySeparatedSweptBoundsPairs']==2
assert joint['sweptCandidatePairs']==1 and joint['requiredPosePairs']==25
assert {(pose['aStrokeMm'],pose['bStrokeMm']) for pose in joint['candidates'][0]['poses']}=={(a,b) for a in [0,.25,.5,.75,1] for b in [0,.25,.5,.75,1]}
missing=joint['candidates'][0]['poses'][0]['checkId']
report={'checks':[{'id':job['id'],'result':{'status':'no-intersection-observed'}} for job in jobs if job['id']!=missing], 'coverage':{'uniqueCandidatePairs':len(jobs),'candidates':jobs,'jointRangeCoverage':joint}, 'inventoryWarnings':[]}
assert audit.summarize(report)['completeCandidateCoverage'] is False
assert joint['complete'] is False
print('AUDIT_KERNEL_TESTS_PASSED 13',flush=True)
# A distant lobe makes the source AABB overlap the target deeply, although only
# the other lobe's top mating face actually touches. Exhaustive local proof must
# accept that face and reject a hidden interior lobe outside its allowed region.
def compound(name, first, second):
 v=np.concatenate((first.vertices,second.vertices));f=np.concatenate((first.faces,second.faces+len(first.vertices)))
 return SimpleNamespace(vertices=v,faces=f,bounds=audit.bounds(v),record={'id':name,'componentRepresentativeVertices':[0,len(first.vertices)],'componentCount':2},tree=BVHTree.FromPolygons(v.tolist(),f.tolist(),all_triangles=True),orientation=1,closed=True,amount=0)
tip=cube('tip',center=(0,0,1.2),scale=.2)
hollow=compound('hollow',tip,cube('remote',center=(3,0,0),scale=.2))
region={'min':np.array([-.2,-.2,1-1e-5]),'max':np.array([.2,.2,1+1e-5])}
result=audit.audit_pair(hollow,a,128)
assert audit.prove_local_region(result,hollow,a,region)['proven'] is True
hidden=compound('hidden',tip,cube('inside',center=(.5,.5,0),scale=.1))
result=audit.audit_pair(hidden,a,128)
assert audit.prove_local_region(result,hidden,a,region)['proven'] is False
letter=cube('letter',center=(4,0,0),scale=.1);letter.closed=False;letter.surface_only=True
result=audit.audit_pair(a,letter,128)
assert result['status']=='no-intersection-observed'
assert 'containmentNotApplicable' in result['aInsideB']
letter_inside=cube('letter-inside',scale=.1);letter_inside.closed=False;letter_inside.surface_only=True
assert audit.audit_pair(a,letter_inside,128)['status']=='penetration-evidence'
print('AUDIT_EXTENDED_KERNEL_TESTS_PASSED 5',flush=True)
# Real clamp support coordinates: a float BVH may return the neighbouring skinny
# triangle although this point lies on the other triangle's support face.
z=14.850000381469727
triangles=np.array([[[37.5,5.25,z],[.699999988,6.25,z],[5.300000191,6.25,z]],
                    [[37.5,5.25,z],[-7.699999809,6.25,z],[.699999988,6.25,z]]])
v=triangles.reshape((-1,3));f=np.arange(6).reshape((-1,3))
skinny=SimpleNamespace(vertices=v,faces=f,bounds=audit.bounds(v))
p=np.array([32.427734375,5.3765621185,z])
assert audit.exact_surface_face(skinny,p,(p,None,0,.011267))==1
assert audit.exact_surface_face(skinny,p+np.array([0,0,.001])) is None
assert audit.exact_winding_inside(a,np.array([0.,0.,0.])) is True
assert audit.exact_winding_inside(a,np.array([2.,0.,0.])) is False
assert audit.exact_winding_inside(double,np.array([.25,0.,0.])) is True
assert audit.exact_winding_inside(cube('inward',reverse=True),np.array([0.,0.,0.])) is True
print('AUDIT_NUMERICAL_KERNEL_TESTS_PASSED 6',flush=True)
# Two explicit support islands must never permit a hidden contact in their gap.
left_tip=cube('left-tip',center=(-.6,0,1.2),scale=.2)
right_tip=cube('right-tip',center=(.6,0,1.2),scale=.2)
two=compound('two-supports',left_tip,right_tip)
patches=[
 {'min':np.array([-.8,-.2,1-1e-5]),'max':np.array([-.4,.2,1+1e-5])},
 {'min':np.array([.4,-.2,1-1e-5]),'max':np.array([.8,.2,1+1e-5])}]
result=audit.audit_pair(two,a,128)
assert audit.prove_local_region(result,two,a,patches)['proven'] is True
gap=compound('gap-contact',two,cube('gap-tip',center=(0,0,1.1),scale=.1))
assert audit.prove_local_region(audit.audit_pair(gap,a,128),gap,a,patches)['proven'] is False
clipped=audit.triangle_intersection_points(np.array([[0.,0,0],[3,0,0],[0,3,0]]),np.array([[1.,1,0],[4,1,0],[1,4,0]]))
assert len(clipped)>=3 and np.all(clipped[:,:2]>=1-1e-5) and np.all(clipped[:,0]+clipped[:,1]<=3+1e-5)
print('AUDIT_REGION_UNION_TESTS_PASSED 3',flush=True)
def cylinder(name,radius=1.1,height=.9,hole=None):
 n=32;angles=np.arange(n)*2*np.pi/n
 if hole is None:
  v=np.array([[radius*np.cos(t),radius*np.sin(t),z] for z in [-height,height] for t in angles]);f=[]
  for i in range(n):
   j=(i+1)%n;f.extend([[i,j,n+j],[i,n+j,n+i]])
  for i in range(1,n-1):f.extend([[0,i+1,i],[n,n+i,n+i+1]])
 else:
  v=np.array([[r*np.cos(t),r*np.sin(t),z] for r,z in [(radius,-height),(radius,height),(hole,-height),(hole,height)] for t in angles]);f=[]
  for i in range(n):
   j=(i+1)%n;f.extend([[i,j,n+j],[i,n+j,n+i],[2*n+i,3*n+i,3*n+j],[2*n+i,3*n+j,2*n+j],
                     [n+i,n+j,3*n+j],[n+i,3*n+j,3*n+i],[i,2*n+i,2*n+j],[i,2*n+j,j]])
 f=np.array(f,dtype=np.int32)
 return SimpleNamespace(vertices=v,faces=f,bounds=audit.bounds(v),record={'id':name,'componentRepresentativeVertices':[0],'componentCount':1},tree=BVHTree.FromPolygons(v.tolist(),f.tolist(),all_triangles=True),orientation=1,closed=True,amount=0)
shank=cylinder('shank');socket=cylinder('socket',radius=2,height=1,hole=1)
annulus={'axisCenterSourceXY':[0,0],'innerRadiusMm':.99,'outerRadiusMm':1.11,'sourceZMin':-.91,'sourceZMax':.91}
assert audit.prove_annular_region(shank,socket,annulus)['proven'] is True
blocked_core=compound('off-axis-core-obstacle',socket,cube('small-wall',center=(.5,0,0),scale=.1))
assert audit.prove_annular_region(shank,blocked_core,annulus)['proven'] is False
blocked_axis=compound('axis-core-obstacle',socket,cube('floor',scale=.1))
assert audit.prove_annular_region(shank,blocked_axis,annulus)['proven'] is False
assert audit.prove_annular_region(shank,socket,{**annulus,'outerRadiusMm':1.01})['proven'] is False
print('AUDIT_ANNULAR_REGION_TESTS_PASSED 4',flush=True)
assert audit.audit_self_intersections(a)['status']=='pass'
assert audit.audit_self_intersections(double)['forbiddenTriangleIntersections']>0
v=np.array([[0.,0,0],[2,0,0],[0,2,0],[1,1,-1],[1,1,1]])
f=np.array([[0,1,2],[0,3,4]])
vertex_cross=SimpleNamespace(vertices=v,faces=f,bounds=audit.bounds(v),record={'componentCount':1},closed=False,
 tree=BVHTree.FromPolygons(v.tolist(),f.tolist(),all_triangles=True))
assert audit.audit_self_intersections(vertex_cross)['forbiddenTriangleIntersections']==1
v=np.array([[0.,0,0],[1,0,0],[0,1,0],[1,1,0]]);f=np.array([[0,1,2],[1,3,2]])
edge_contact=SimpleNamespace(vertices=v,faces=f,bounds=audit.bounds(v),record={'componentCount':1},closed=False,
 tree=BVHTree.FromPolygons(v.tolist(),f.tolist(),all_triangles=True))
assert audit.audit_self_intersections(edge_contact)['forbiddenTriangleIntersections']==0
print('AUDIT_SELF_INTERSECTION_TESTS_PASSED 4',flush=True)
