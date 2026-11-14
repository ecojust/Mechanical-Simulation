"""Read-only full-source installation audit for eight main-key fixed subgroups.

Uses the already measured sleeve lock poses; checks each actual switch body,
actuator and four metal terminals against the corresponding actual baseplate.
"""
import gc
import hashlib
import importlib.util
import json
import math
from pathlib import Path

import bpy
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT/'assets/puretv-controller'
LOCK_REPORT = ROOT/'docs/puretv-geometry-locks.json'
OUTPUT = ROOT/'docs/puretv-geometry-button-installation.json'
spec = importlib.util.spec_from_file_location('source_lock_geometry', ROOT/'scripts/audit-puretv-locks.py')
geometry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(geometry)
KEYS = ['left', 'right', 'up', 'down', 'a', 'b', 'x', 'y']


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def transformed(vertices, center, angle, offset):
    radians = math.radians(angle)
    rotation = np.array([[math.cos(radians), -math.sin(radians), 0], [math.sin(radians), math.cos(radians), 0], [0, 0, 1]])
    return (vertices-center) @ rotation.T+center+[0, 0, offset]


def refine_poses(raw, parts, center):
    """Bound vertex travel conservatively by arc length plus axial distance."""
    radius = max(float(np.linalg.norm(part.v[:, :2]-center[:2], axis=1).max()) for part in parts)
    poses = [{name: raw[0][name] for name in ['stage', 'angleDeg', 'axialOffsetMm']}]
    for before, after in zip(raw, raw[1:]):
        angle_distance = abs(after['angleDeg']-before['angleDeg'])
        axial_distance = abs(after['axialOffsetMm']-before['axialOffsetMm'])
        count = max(1, math.ceil((math.radians(angle_distance)*radius+axial_distance)/.1-1e-10))
        for index in range(1, count+1):
            fraction = index/count
            poses.append({'stage': after['stage'], 'angleDeg': before['angleDeg']+fraction*(after['angleDeg']-before['angleDeg']), 'axialOffsetMm': before['axialOffsetMm']+fraction*(after['axialOffsetMm']-before['axialOffsetMm'])})
    return poses, radius


source_report_bytes = LOCK_REPORT.read_bytes()
lock_report = json.loads(source_report_bytes)
manifest = json.loads((SOURCE/'manifest.json').read_text())
inventory = {entry['file']: entry for entry in manifest['assets']}
rows = {row['key']: row for row in lock_report['buttons']}
report = {
    'schemaVersion': 1, 'auditorScriptSha256': sha(Path(__file__)),
    'pathSourceReport': 'docs/puretv-geometry-locks.json', 'pathSourceReportSha256': hashlib.sha256(source_report_bytes).hexdigest(),
    'coordinates': 'Source mm/Z-up; client=(source.x,source.z,-source.y). Each group uses the same measured source axis as its sleeve.',
    'method': 'Full evaluated source meshes, not display GLBs. Every group member follows the measured sleeve poses; complete BVH surface overlap and bounded three-ray signed-winding interior witnesses are checked against the actual baseplate. Any unclassified surface contact blocks this supplemental path.',
    'scope': 'Switch body, unpressed actuator and four terminals are rigidly carried by the sleeve during its bottom-plate installation. Install the cap and spring after locking this subgroup, then solder the wires. The upper and lower shell are not fitted during this operation.',
    'limitations': ['The source sleeve/baseplate lock and anti-pull result remains a separate required audit.', 'No rubber pad nonlinear compression, friction, wire deformation, cap/spring insertion path, complete assembled-controller service access or assembly force is certified.', 'Maximum sampled vertex travel0.1mm is a geometric sampling bound, not continuous collision detection or a positive clearance certificate.'],
    'buttons': [],
}
hashes = {}
for key in KEYS:
    row = rows[key]
    if row['status'] != 'sampled-path-clear' or row['path']['status'] != 'sampled-path-clear':
        raise RuntimeError(key+': the underlying sleeve path is not clear')
    relative, plate_file = row['sourceFile'], row['plateFile']
    for path, expected in [(relative, row['sourceSha256']), (plate_file, row['plateSha256'])]:
        actual = sha(SOURCE/path)
        if actual != expected:
            raise RuntimeError(path+': source hash differs from measured lock path')
        hashes[path] = actual
    bpy.ops.wm.read_factory_settings(use_empty=True)
    names = [item['exported'] for item in inventory[relative]['objects'] if any(token in item['exported'] for token in ['6×6 开关', '按杆', '焊脚'])]
    if len(names) != 6 or sum('焊脚' in name for name in names) != 4:
        raise RuntimeError(key+': expected one body, one actuator, four terminals')
    parts = [geometry.load_named(relative, name) for name in names]
    plate_name = row['sourceObjects'][1]['name']
    plate = geometry.load_named(plate_file, plate_name)
    center = np.asarray([*row['axisCenterSourceXY'], 0], dtype=float)
    poses, radius = refine_poses(row['path']['samples'], parts, center)
    checks, blocked = [], []
    for part in parts:
        pair = geometry.Pair(part, plate, center)
        samples, previous, maximum_travel = [], None, 0
        for pose in poses:
            world = transformed(part.v, center, pose['angleDeg'], pose['axialOffsetMm'])
            travel = 0 if previous is None else float(np.linalg.norm(world-previous, axis=1).max())
            maximum_travel = max(maximum_travel, travel)
            sample = {'stage': pose['stage'], 'maximumVertexTravelFromPreviousMm': travel, **pair.check(pose['angleDeg'], pose['axialOffsetMm'], detail=True)}
            if travel > .100001:
                raise RuntimeError(key+' '+part.name+': geometric sampling step exceeded')
            if sample['surfaceTrianglePairs'] or sample['strictInteriorSamples']:
                blocked.append({'part': part.name, **sample})
            samples.append(sample)
            previous = world
        reverse_samples = []
        for index, sample in enumerate(reversed(samples)):
            source_index = len(samples)-1-index
            reverse_samples.append({**sample, 'stage': 'reverse-'+sample['stage'], 'maximumVertexTravelFromPreviousMm': 0 if index == 0 else samples[source_index+1]['maximumVertexTravelFromPreviousMm']})
        checks.append({'part': part.report(), 'maximumObservedVertexTravelMm': maximum_travel, 'status': 'sampled-path-clear' if not any(item['part'] == part.name for item in blocked) else 'path-blocked', 'samples': samples, 'reverseRemoval': {'status': 'sampled-path-clear' if not any(item['part'] == part.name for item in blocked) else 'path-blocked', 'samples': reverse_samples}})
    report['buttons'].append({
        'key': key, 'sourceFile': relative, 'sourceSha256': hashes[relative], 'plateFile': plate_file, 'plateSha256': hashes[plate_file],
        'axisCenterSourceXY': center[:2], 'plate': plate.report(),
        'sourcePoseCount': len(row['path']['samples']), 'checkedPoseCount': len(poses),
        'maximumMemberRadiusMm': radius, 'maximumAllowedVertexTravelMm': .1,
        'entryAngleDeg': row['path']['entryAngleDeg'], 'startAxialOffsetMm': row['path']['startAxialOffsetMm'], 'turnAxialOffsetMm': row['path']['seatedAxialOffsetMm'], 'lockedAngleDeg': 0, 'lockedAxialOffsetMm': 0,
        'status': 'sampled-path-clear' if not blocked else 'path-blocked',
        'members': checks, 'blockedSampleCount': len(blocked), 'blockedExamples': blocked[:12],
    })
    OUTPUT.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=geometry.clean)+'\n')
    print('BUTTON-INSTALLATION', key, 'members', len(parts), 'poses', len(poses), 'blocked', len(blocked), flush=True)
    del parts, plate, pair
    bpy.ops.wm.read_factory_settings(use_empty=True)
    gc.collect()
changed = [path for path, expected in hashes.items() if sha(SOURCE/path) != expected]
report['sourceFilesUnchanged'] = not changed
report['sourceFilesChangedDuringAudit'] = changed
report['sourceHashes'] = hashes
report['status'] = 'sampled-paths-clear' if not changed and len(report['buttons']) == 8 and all(row['status'] == 'sampled-path-clear' for row in report['buttons']) else 'incomplete-or-failed'
report['summary'] = {'buttons': len(report['buttons']), 'members': sum(len(row['members']) for row in report['buttons']), 'forwardSamples': sum(len(member['samples']) for row in report['buttons'] for member in row['members']), 'reverseSamples': sum(len(member['reverseRemoval']['samples']) for row in report['buttons'] for member in row['members']), 'blockedSamples': sum(row['blockedSampleCount'] for row in report['buttons'])}
OUTPUT.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=geometry.clean)+'\n')
print('BUTTON-INSTALLATION-REPORT', report['status'], report['summary'], OUTPUT, flush=True)
