"""Verify exact switch-terminal and ground-bus solder regions in source meshes.

Run after source changes, using a freshly produced assembly --inventory-only report:
blender -b --python scripts/audit-puretv-wiring-interfaces.py -- \
  --inventory <inventory.json>

This does not waive wire/header crossings: those belong to the independent
electronics review. Named terminal bodies must exist and all intersections must
remain in the explicitly declared exposed-metal solder region.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('assembly_audit', Path(__file__).with_name('audit-puretv-assembly.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)

# The original authored curve endpoints were retained through the closed-end
# repair. Confirm endpoints are the specified revised real-metal termination.
# No candidate collision is used to guess which electrical pin a wire belongs to.
TERMINALS = [
    ('A', 'a', 'GPIO', '008', [43.34999466,11.60000610,20.75304604]),
    ('A', 'a', 'GND', '010', [38.64998627,11.60000610,20.75304604]),
    ('B', 'b', 'GPIO', '010', [50.14998627,23.10000610,20.75304604]),
    ('B', 'b', 'GND', '008', [54.84999466,23.10000610,20.75304604]),
    ('X', 'x', 'GPIO', '008', [31.85000038,23.10000610,20.75304604]),
    ('X', 'x', 'GND', '010', [27.14999008,23.10000610,20.75304604]),
    ('Y', 'y', 'GPIO', '011', [38.64998627,30.39999390,20.75304604]),
    ('Y', 'y', 'GND', '009', [43.34999466,30.39999390,20.75304604]),
    ('左', 'left', 'GPIO', '017', [-48.84999847,24.10000610,18.20304489]),
    ('左', 'left', 'GND', '019', [-53.55000687,24.10000610,18.20304489]),
    ('右', 'right', 'GPIO', '013', [-35.15000153,19.89999390,15.80761433]),
    ('右', 'right', 'GND', '015', [-30.44998932,19.89999390,15.80761433]),
    ('上', 'up', 'GPIO', '014', [-44.09999847,28.84999847,14.57957077]),
    ('上', 'up', 'GND', '013', [-39.89999390,28.84999847,14.57957077]),
    ('下', 'down', 'GPIO', '014', [-39.90000153,15.15000439,17.96893120]),
    ('下', 'down', 'GND', '013', [-44.10000229,15.15000439,17.96893120]),
    ('确认', 'confirm', 'GPIO', None, [2,5.5,19.25042458]),
    ('确认', 'confirm', 'GND', None, [-2,5.5,19.25042458]),
]
GROUND_X = {'A':12., 'B':8.5, 'X':5., 'Y':1.5, '左':-16., '右':-12.5, '上':-9., '下':-5.5, '确认':-2.}


def wire_id(label, signal):
    name = f'确认 · {signal}.005' if label == '确认' else f'{label} · 中央走线 {signal}.002'
    return 'electronics/harness.blend::'+name


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory', required=True)
    parser.add_argument('--routes', default=str(ROOT/'docs/puretv-geometry-harness-routing.json'))
    parser.add_argument('--cache', default=str(ROOT.parent/'scratch/puretv-assembly-audit-cache'))
    parser.add_argument('--output', default=str(ROOT/'docs/puretv-wiring-interfaces.json'))
    args = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
    inventory = json.loads(Path(args.inventory).read_text())
    objects = {obj['id']:obj for obj in inventory['objects']}
    source = ROOT/'assets/puretv-controller'
    relevant = {obj['sourceFile'] for obj in objects.values() if obj['sourceFile'].startswith('buttons/') or obj['sourceFile']=='electronics/harness.blend'}
    hashes = {relative:audit.digest(source/relative) for relative in relevant}
    if any(inventory['sourceSha256'].get(relative) != value for relative,value in hashes.items()):
        raise RuntimeError('Inventory is stale; rerun assembly --inventory-only against final sources')
    route_path = Path(args.routes).resolve()
    if not route_path.is_relative_to(ROOT): raise RuntimeError('Final route definitions must be a public repository artifact')
    route_document = json.loads(route_path.read_text())
    if route_document.get('sourceSha256') != hashes['electronics/harness.blend']:
        raise RuntimeError('Final route metadata is not bound to the actual current harness source hash')
    routes = {route['name']:route for route in route_document['routes']}
    def verify_endpoint(wire, endpoint, which):
        route = routes.get(wire.split('::',1)[1])
        if route is None or abs(route['radius']-.28)>1e-6:
            raise RuntimeError(f'Missing or unexpected conductor route definition: {wire}')
        if np.linalg.norm(np.asarray(route['endpoints'][which])-endpoint)>1e-4:
            raise RuntimeError(f'Route endpoint no longer meets its prescribed terminal: {wire}')
    for obj in objects.values():
        key = hashlib.sha256(f"{audit.CACHE_VERSION}:{obj['sourceSha256']}:{obj['sourceFile']}:{obj['sourceName']}".encode()).hexdigest()
        obj['cacheDirectory'] = str(Path(args.cache)/key)
    rules = []
    for label,key,signal,suffix,endpoint in TERMINALS:
        verify_endpoint(wire_id(label,signal),np.asarray(endpoint),0)
        if label == '确认':
            name = f'确认 · {signal} 金属焊脚.005'
        else:
            name = f'{label} · {"同款" if key in {"a","b","x","y"} else "PS5"} 焊脚占位.{suffix}'
        pin = f'buttons/{key}.blend::{name}'
        record = objects.get(pin)
        if record is None: raise RuntimeError(f'Required real metal terminal is absent: {pin}')
        point = np.asarray(endpoint)
        box = record['boundsBlender']
        if np.any(point < np.asarray(box['min'])-audit.EPS) or np.any(point > np.asarray(box['max'])+audit.EPS):
            raise RuntimeError(f'Authored wire endpoint does not meet its specified terminal: {pin}')
        region = {axis:np.asarray(values).copy() for axis,values in box.items()}
        if label == '确认': region['max'][2] = 19.55
        rules.append({'id':f'{key}-{signal.lower()}-exposed-metal-solder', 'pair':[wire_id(label,signal),pin],
                      'reason':'Named conductor end joined only to its specified exposed metal switch terminal; insulation must be removed within this local solder joint. No plastic-body overlap is permitted.',
                      'regionBlender':region, 'maximumPenetrationMm':.32505,
                      'nominalWireRadiusMm':.28, 'authoredEndpointBlender':endpoint,
                      'terminalScope':'Entire 0.65 mm square exposed terminal leg' if label!='确认' else 'Only the new terminal lower 0.55 mm; embedded plastic-pocket interface is reviewed separately'})
    bus = 'electronics/harness.blend::公共接地 · GND 汇流排.002'
    connections = [(wire_id(label,'GND'),x) for label,x in GROUND_X.items()]
    connections.append(('electronics/harness.blend::公共接地 · GND 引线.002',-17.5))
    for index,(wire,x) in enumerate(connections):
        verify_endpoint(wire,np.array([x,22,21.2]),0 if 'GND 引线' in wire else -1)
        rules.append({'id':f'ground-bus-junction-{index}', 'pair':[wire,bus],
                      'reason':'Explicit stripped ground-conductor end soldered to the bare 0.76 mm ground bus at its authored terminal point; other wire pairs remain subject to full collision tests.',
                      'regionBlender':{'min':[x-1,21.60,20.80], 'max':[x+1,22.40,21.60]},
                      'maximumPenetrationMm':.38005, 'authoredEndpointBlender':[x,22,21.2],
                      'nominalWireRadiusMm':.28, 'nominalBareBusRadiusMm':.38})
    # The 32 authored legs end at their package underside; their faces may be
    # separated by ~1e-6 mm of Blender transform rounding. Only that boundary,
    # never the whole leg or package volume, is an accepted mechanical interface.
    for key in sorted({row[1] for row in TERMINALS if row[1]!='confirm'}):
        group = [obj for obj in objects.values() if obj['sourceFile']==f'buttons/{key}.blend']
        bodies = [obj for obj in group if '6×6 开关' in obj['sourceName']]
        pins = [obj for obj in group if '焊脚占位' in obj['sourceName']]
        if len(bodies)!=1 or len(pins)!=4: raise RuntimeError(f'Unexpected authored package/terminal inventory: {key}')
        body = bodies[0]
        for index,pin in enumerate(pins):
            box = pin['boundsBlender']
            plane = (box['max'][2]+body['boundsBlender']['min'][2])/2
            if abs(box['max'][2]-body['boundsBlender']['min'][2]) > audit.EPS:
                raise RuntimeError(f'Terminal no longer meets package underside: {pin["id"]}')
            rules.append({'id':f'{key}-package-terminal-boundary-{index}', 'pair':[pin['id'],body['id']],
                          'reason':'Exact authored metal-leg top face meets the switch-package underside; zero solid penetration only. Internal electrical contacts are not resolved by the exterior package mesh.',
                          'regionBlender':{'min':[box['min'][0],box['min'][1],plane-audit.EPS],
                                           'max':[box['max'][0],box['max'][1],plane+audit.EPS]},
                          'maximumPenetrationMm':audit.EPS})
    if any(row[1]=='confirm' for row in TERMINALS):
        body = objects['buttons/confirm.blend::确认 · 常开开关.005']
        for signal in ('GPIO','GND'):
            pin = objects[f'buttons/confirm.blend::确认 · {signal} 金属焊脚.005']
            box = pin['boundsBlender']
            rules.append({'id':f'confirm-{signal.lower()}-molded-terminal-pocket', 'pair':[pin['id'],body['id']],
                          'reason':'The real metal terminal meets its exact boolean-cut blind pocket in the package; only the 0.30 mm anchoring pocket surface may touch and no positive-volume overlap is allowed.',
                          'regionBlender':{'min':[box['min'][0]-audit.EPS,box['min'][1]-audit.EPS,body['boundsBlender']['min'][2]-audit.EPS],
                                           'max':[box['max'][0]+audit.EPS,box['max'][1]+audit.EPS,box['max'][2]+audit.EPS]},
                          'maximumPenetrationMm':audit.EPS})
    cache = audit.GeometryCache(500000)
    reviewed, rejected = [], []
    for rule in rules:
        first,second = [cache.get(objects[ident],0) for ident in rule['pair']]
        result = audit.audit_pair(first,second,4096)
        audit.classify_allowed(result,first,second,[rule])
        record = {'interfaceId':rule['id'], 'pair':rule['pair'], 'result':result}
        reviewed.append(record)
        actual_joint = rule['id'].endswith('-exposed-metal-solder') or rule['id'].startswith('ground-bus-junction-')
        accepted = result['status']=='allowed-local-interface' or (not actual_joint and result['status']=='no-intersection-observed')
        if not accepted: rejected.append(record)
        print('WIRING_INTERFACE',rule['id'],result['status'],flush=True)
    output = {'schemaVersion':1, 'sourceSha256':hashes, 'interfaces':rules,
              'routeDefinitionSource':{'file':str(route_path.relative_to(ROOT)), 'sha256':audit.digest(route_path)},
              'review':{'status':'all-declared-joints-bounded' if not rejected else 'unaccepted-joints', 'declaredJoints':len(rules), 'acceptedJoints':len(rules)-len(rejected), 'checks':reviewed},
              'limitations':['These are explicit nominal solder assembly interfaces, not insulation, solder-strength or electrical resistance certification.', 'Full source geometry is still checked against every other object; no complete wire, switch body or component kind is exempt.']}
    audit.dump(args.output,output)
    if rejected: raise RuntimeError(f'{len(rejected)} declared solder joints remain unaccepted; inspect exact witnesses')


if __name__=='__main__': main()
