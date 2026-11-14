"""Read-only review of exact ESP32 connector/support and wire-end interfaces.

Writes explicit source-hash-bound pair rules and retains all unaccepted overlaps.
Does not infer electrical pin numbers from the visual connector model.
"""
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import bpy
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/puretv-controller'
SCRATCH = ROOT.parent / 'scratch'
spec = importlib.util.spec_from_file_location('audit', ROOT / 'scripts/audit-puretv-assembly.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
EPS = 0.00002
FILES = ['electronics/esp32-mount.blend', 'electronics/harness.blend', 'housing/bottom.blend']
sha = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
source_hashes = {file: sha(SOURCE/file) for file in FILES}
route_file = ROOT/'docs/puretv-geometry-harness-routing.json'
if not route_file.exists():
    route_file = ROOT/'docs/puretv-harness-route-reference.json'
route_evidence = json.loads(route_file.read_text())
expected_harness_sha = route_evidence.get('sourceSha256') or route_evidence['closedSameRouteSourceSha256']
if expected_harness_sha != source_hashes['electronics/harness.blend']:
    raise RuntimeError('Published route/endpoint evidence does not match the current source harness.')
endpoints = route_evidence['routes']
bpy.ops.wm.read_factory_settings(use_empty=True)
records = {}
for relative in FILES:
    with bpy.data.libraries.load(str(SOURCE/relative), link=False) as (available, loaded):
        loaded.objects = [name for name in available.objects if relative != 'housing/bottom.blend' or name == '底壳 · 合壳.007']
    for obj in loaded.objects:
        if not obj or obj.type not in {'MESH', 'CURVE'}:
            continue
        bpy.context.scene.collection.objects.link(obj)
        bpy.context.view_layer.update()
        record = audit.extract(obj, relative, source_hashes[relative], SCRATCH/'puretv-assembly-audit-cache')
        records[record['id']] = record
        bpy.data.objects.remove(obj, do_unlink=True)
geometries = audit.GeometryCache(2500000)
rules, reviewed, checks = [], [], []
electronics = [record for record in records.values() if record['sourceFile'] == FILES[0]]
pins = sorted((r for r in electronics if r['sourceName'].startswith('Header pin.')), key=lambda r: r['sourceName'])
if len(pins) != 34:
    raise RuntimeError('Expected the reviewed two rows of 17 source header pins.')
find = lambda name: next(r for r in electronics if r['sourceName'] == name)
pcb = find('ESP32 · 48.2 × 27.9 PCB.005')
clamp = find('PCB · 长轴压条.005')


def intersect_region(a, b, pad=EPS):
    return {'min': (np.maximum(a['boundsBlender']['min'], b['boundsBlender']['min'])-pad).tolist(),
            'max': (np.minimum(a['boundsBlender']['max'], b['boundsBlender']['max'])+pad).tolist()}


def rule(identifier, a, b, region, reason, maximum=EPS, **details):
    entry = {'id': identifier, 'pair': [a['id'], b['id']], 'regionBlender': region,
             'maximumPenetrationMm': maximum, 'reason': reason, **details}
    rules.append(entry)
    return entry


for index, pin in enumerate(pins):
    holder = find('Pin header.010' if index < 17 else 'Pin header.011')
    low, high = (np.asarray(pin['boundsBlender'][edge]) for edge in ['min', 'max'])
    expected_x = -21.4+(index % 17)*2.54
    expected_y = -2.7 if index < 17 else 19.7
    if not np.allclose(high-low, [.65, .65, 5.7], atol=1e-5) or not np.allclose((low+high)[:2]/2, [expected_x, expected_y], atol=1e-5):
        raise RuntimeError('A named header pin differs from its reviewed pitch/section.')
    entry = rule(f'header-insert-{index+1:02}', pin, holder, intersect_region(pin, holder),
                 'This exact 0.65 mm square metal pin is the retained insert of this exact moulded connector housing; the source simplifies the preassembled insert interface as overlapping solids. Only its 1.10 mm-deep internal socket region is included; no external pin/wire collision or assembly travel is exempted.',
                 maximum=1.10002, nominalInsertLengthMm=1.1,
                 scope='Nominal preassembled connector internal insert; does not certify polymer displacement or manufacturing fit.')
    reviewed.append({'ruleId': entry['id'], 'pinSectionMm': [.65, .65], 'pitchMm': 2.54,
                     'pinCenterBlenderXY': [expected_x, expected_y], 'insertZIntervalMm': [11.3, 12.4]})

for number, name in enumerate(['ESP32 · RF module.005', 'Pin header.010', 'Pin header.011',
                               'PCB · 0.40 mm 软垫（装配压缩至 0.25 mm）.010',
                               'PCB · 0.40 mm 软垫（装配压缩至 0.25 mm）.011']):
    mounted = find(name)
    region = intersect_region(pcb, mounted)
    if abs(mounted['boundsBlender']['min'][2]-pcb['boundsBlender']['max'][2]) > 1e-5:
        raise RuntimeError('A declared PCB top-face support is not coincident.')
    rule(f'pcb-top-support-{number+1}', pcb, mounted, region,
         'Exact named source component/soft pad bottom face rests on the PCB top plane at Z=9.60 mm; only coincident face contact is included.')
    if '软垫' in name:
        region = intersect_region(mounted, clamp)
        rule(f'pad-clamp-foot-{number-2}', mounted, clamp, region,
             'Exact 4.6 × 4.5 mm compressed soft pad top face bears against its original clamp foot at Z=9.85 mm; no overlap away from that plane is allowed.')

usb_evidence_path = ROOT/'docs/puretv-geometry-usb-repair.json'
if usb_evidence_path.exists():
    usb_evidence = json.loads(usb_evidence_path.read_text())
    if usb_evidence['afterSha256'] != source_hashes[FILES[0]]:
        raise RuntimeError('USB seat repair evidence is stale for the current ESP32 source.')
    rules.extend(usb_evidence['interfaces'])

bottom = records['housing/bottom.blend::底壳 · 合壳.007']
rule('pcb-bottom-original-support-plane', pcb, bottom,
     {'min': [pcb['boundsBlender']['min'][0]-EPS, pcb['boundsBlender']['min'][1]-EPS, 8-EPS],
      'max': [pcb['boundsBlender']['max'][0]+EPS, pcb['boundsBlender']['max'][1]+EPS, 8+EPS]},
     'The PCB underside rests on the original bottom-housing support plane at Z=8.00 mm. Only this exact board footprint and coincident underside plane are included; side/upper housing interference is forbidden.')
regions = [{'min': [x-3.50002, 5.24998, 14.84998], 'max': [x+3.50002, 11.75002, 14.85002]} for x in [-34, 34]]
entry = rule('pcb-clamp-two-original-mounting-column-faces', clamp, bottom,
             {'min': [-37.50002, 5.24998, 14.84998], 'max': [37.50002, 11.75002, 14.85002]},
             'Only the two original mounting-column end faces meet the clamp underside. The middle span is excluded by the explicit two-region union. All other shell/clamp penetration remains forbidden.',
             regionsBlender=regions, evidenceRef='docs/puretv-geometry-clamp-repair.json')

designated = {}
for wire in endpoints:
    if not ('GPIO' in wire['name'] or wire['name'] == '公共接地 · GND 引线.002'):
        continue
    endpoint = np.asarray(wire['endpoints'][-1])
    matches = [pin for pin in pins if np.linalg.norm((np.asarray(pin['boundsBlender']['min'])+np.asarray(pin['boundsBlender']['max']))[:2]/2-endpoint[:2]) < 1e-4]
    if len(matches) != 1 or abs(endpoint[2]-16.9) > 1e-4:
        raise RuntimeError('The authored wire endpoint does not identify exactly one reviewed pin tip.')
    pin = matches[0]
    source_wire = records[f'electronics/harness.blend::{wire["name"]}']
    designated[source_wire['id']] = pin['id']
    radius = wire['radius']
    region = {'min': [float(endpoint[0]-radius-EPS), float(endpoint[1]-radius-EPS), float(endpoint[2]-EPS)],
              'max': [float(endpoint[0]+radius+EPS), float(endpoint[1]+radius+EPS), 17.00002]}
    rule(f'authored-header-wire-tip-{len(designated):02}', source_wire, pin, region,
         'The original source polyline explicitly ends on this single header pin axis at Z=16.90 mm, 0.10 mm below its tip. This bounded joint represents the nominal stripped/soldered endpoint only; neighbouring pin crossings are not connections and are never exempted.',
         maximum=.10002, authoredEndpointBlender=endpoint.tolist(), nominalTipInsertionMm=.1,
         scope='Source mechanical endpoint occupancy; actual GPIO marking, stripped length, solder shape and insulation require physical confirmation.')
if len(designated) != 10:
    raise RuntimeError('Expected nine signal endpoints and one common-ground return.')

jobs = []
for index, a in enumerate(electronics):
    for b in electronics[index+1:]:
        if audit.overlap_bounds(a['boundsBlender'], b['boundsBlender']):
            jobs.append((a, b))
for wire_id in designated:
    wire = records[wire_id]
    for pin in pins:
        if audit.overlap_bounds(wire['boundsBlender'], pin['boundsBlender']):
            jobs.append((wire, pin))
jobs.append((clamp, bottom))
jobs.append((pcb, bottom))
for index, (a, b) in enumerate(jobs):
    first, second = geometries.get(a, 0), geometries.get(b, 0)
    result = audit.audit_pair(first, second, 20000)
    raw = result['status']
    audit.classify_allowed(result, first, second, rules)
    checks.append({'a': a['id'], 'b': b['id'], 'rawStatus': raw, 'result': result})
    if index % 25 == 0:
        print('ELECTRONICS_REVIEW', index+1, '/', len(jobs), result['status'], flush=True)
unaccepted = [check for check in checks if check['result']['status'] not in ['no-intersection-observed', 'allowed-local-interface']]
summary = [{'a': check['a'], 'b': check['b'], 'status': check['result']['status'],
            'surfaceTrianglePairs': check['result']['surfaceTrianglePairs'],
            'maximumSampledPenetrationMm': check['result']['maximumSampledPenetrationMm'],
            'designatedHeaderPin': designated.get(check['a']) or designated.get(check['b']),
            'regionBlender': check['result'].get('conservativeCrossingRegionBlender')} for check in unaccepted]
scope = ['Exact named source interfaces only, with source hashes and bounded local regions.',
         'The plastic connector model represents preassembled retained metal inserts. This is a declared nominal internal interface, not a general permission for metal/plastic interpenetration.',
         'USB shell/PCB overlap is not accepted without an explicit seat/cutout definition.',
         'Wire endpoint locations come from the original authored polyline and the documented zero-displacement cap repair, not from guessing which pin a crossing touches.',
         'Nominal geometry does not establish electrical pin identity, solder quality, material strength or insulation clearances.']
(ROOT/'docs/puretv-electronics-interfaces.json').write_text(json.dumps({'schemaVersion': 1, 'sourceSha256': source_hashes, 'interfaces': rules, 'scope': scope}, ensure_ascii=False, indent=2)+'\n')
(ROOT/'docs/puretv-electronics-interface-review.json').write_text(json.dumps({'schemaVersion': 1, 'status': 'unaccepted-geometry-remains' if unaccepted else 'reviewed-local-interfaces', 'sourceSha256': source_hashes,
     'reviewedHeaderInserts': reviewed, 'authoredHeaderEndpoints': designated, 'checkedPairs': len(checks), 'unaccepted': summary, 'checks': checks, 'scope': scope}, ensure_ascii=False, indent=2, default=audit.native)+'\n')
print(json.dumps({'checkedPairs': len(checks), 'explicitRules': len(rules), 'unaccepted': summary}, ensure_ascii=False), flush=True)
