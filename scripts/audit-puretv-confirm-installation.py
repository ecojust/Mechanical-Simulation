"""Audit the complete confirm fixed subgroup during open-upper-shell installation.

Read-only source meshes. Complements the seat/upper-shell lock path in
audit-puretv-locks.py with the actual body, terminals and compliant actuator.
"""
import hashlib
import importlib.util
import json
import math
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT/'assets/puretv-controller'


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


locks = module('lock_geometry', ROOT/'scripts/audit-puretv-locks.py')
assembly = module('assembly_geometry', ROOT/'scripts/audit-puretv-assembly.py')


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def rotation(angle):
    radians = math.radians(angle)
    return np.array([[math.cos(radians), -math.sin(radians), 0], [math.sin(radians), math.cos(radians), 0], [0, 0, 1]])


def world_vertices(part, angle, offset):
    return (part.v-[0, 5.5, 0]) @ rotation(angle).T+[0, 5.5, offset]


def actuator_contact(part, cap, angle, offset, sample, plane, patch_low, patch_high):
    """Every reported triangle contact must lie on the real opposing end faces."""
    moved = locks.Geometry(part.name, world_vertices(part, angle, offset), part.f)
    all_points, rejected, nonempty = [], [], 0
    for moving_index, cap_index in moved.tree.overlap(cap.tree):
        points = assembly.triangle_intersection_points(moved.v[moved.f[moving_index]], cap.v[cap.f[cap_index]])
        if points is None:
            rejected.append({'movingTriangle': moving_index, 'capTriangle': cap_index, 'reason': 'degenerate triangle'})
            continue
        if not len(points):
            continue
        nonempty += 1
        all_points.extend(points.tolist())
        if np.any(np.abs(points[:, 2]-plane) > 1e-5) or np.any(points < patch_low-1e-5) or np.any(points > patch_high+1e-5):
            rejected.append({'movingTriangle': moving_index, 'capTriangle': cap_index, 'reason': 'contact outside actual striker endpoint patch', 'points': points.tolist()})
    valid = not sample['strictInteriorSamples'] and not rejected and nonempty > 0
    return {'status': 'nominal-actuator-end-contact' if valid else 'actuator-contact-unresolved', 'sourcePlaneZ': plane, 'sourcePatchMin': patch_low.tolist(), 'sourcePatchMax': patch_high.tolist(), 'exactContactPairs': nonempty, 'rejectedPairs': rejected, 'contactBoundsSource': {'min': np.min(all_points, axis=0).tolist(), 'max': np.max(all_points, axis=0).tolist()} if all_points else None, 'allowedPenetrationMm': 0, 'numericToleranceMm': 1e-5}


bpy.ops.wm.read_factory_settings(use_empty=True)
source_files = ['buttons/confirm.blend', 'housing/top.blend']
hashes = {name: sha(SOURCE/name) for name in source_files}
seat = locks.load_named(source_files[0], '旋锁座')
body = locks.load_named(source_files[0], '常开开关')
gpio = locks.load_named(source_files[0], 'GPIO 金属焊脚')
ground = locks.load_named(source_files[0], 'GND 金属焊脚')
actuator = locks.load_named(source_files[0], '开关触头')
cap = locks.load_named(source_files[0], '确认 · 键帽')
upper = locks.load_named(source_files[1], '按键区圆滑过渡上壳')
fixed_subgroup = [body, gpio, ground]
center = [0, 5.5, 0]
initial_gap = float(cap.low[2]-actuator.high[2])
contact_plane = float(cap.low[2])
endpoint = cap.v[abs(cap.v[:, 2]-contact_plane) < 1e-5]
patch_low, patch_high = endpoint.min(axis=0), endpoint.max(axis=0)
start = math.floor((upper.low[2]-max(part.high[2] for part in [seat, body, gpio, ground, actuator])-.25)*10)/10
poses = [('insert-fixed-subgroup', 30, float(z)) for z in np.linspace(start, 1, math.ceil((1-start)/.1)+1)]
poses += [('rotate-fixed-subgroup', float(angle), 1) for angle in np.linspace(30, 0, 61)]
poses += [('seat-fixed-subgroup', 0, float(z)) for z in np.linspace(1, 0, 11)]
checks, blocked = [], []
for moving in fixed_subgroup+[actuator]:
    for fixed in [upper, cap]:
        pair = locks.Pair(moving, fixed, center)
        samples = []
        for stage, angle, seat_offset in poses:
            offset = min(seat_offset, initial_gap) if moving is actuator else seat_offset
            sample = {'stage': stage, 'seatOffsetMm': seat_offset, 'actuatorCompressionMm': max(0, seat_offset-offset) if moving is actuator else None, **pair.check(angle, offset, detail=True)}
            allowed = False
            if sample['surfaceTrianglePairs'] and moving is actuator and fixed is cap:
                sample['contactProof'] = actuator_contact(moving, cap, angle, offset, sample, contact_plane, patch_low, patch_high)
                allowed = sample['contactProof']['status'] == 'nominal-actuator-end-contact'
            if sample['strictInteriorSamples'] or (sample['surfaceTrianglePairs'] and not allowed):
                blocked.append({'moving': moving.name, 'fixed': fixed.name, **sample})
            samples.append(sample)
        checks.append({'moving': moving.name, 'fixed': fixed.name, 'samples': samples, 'blockedSamples': sum(1 for item in blocked if item['moving'] == moving.name and item['fixed'] == fixed.name)})
        print('INSTALLATION-GROUP', moving.name, 'against', fixed.name, 'samples', len(samples), 'blocked', checks[-1]['blockedSamples'], flush=True)

old_report_path = ROOT/'docs/puretv-geometry-confirm-mount-repair.json'
old_report = json.loads(old_report_path.read_text())
witnesses = []
for witness in old_report['lateralDistanceWitnesses']:
    angle, offset = witness['angleDeg'], witness['axialOffsetMm']
    moving_world = np.asarray(witness['movingSourcePoint'])
    rest_point = (moving_world-[0, 5.5, offset]) @ rotation(angle)+[0, 5.5, 0]
    on_current_seat = seat.tree.find_nearest(Vector(rest_point))
    target, normal, triangle, distance = upper.tree.find_nearest(Vector(moving_world))
    valid = float(on_current_seat[3]) <= 1e-5 and abs(float(distance)-witness['distanceMm']) <= 1e-5
    witnesses.append({**witness, 'distanceMm': float(distance), 'fixedSourcePoint': list(target), 'fixedSourceNormal': list(normal), 'fixedTriangleIndex': int(triangle), 'movingRestSourcePoint': rest_point.tolist(), 'distanceToCurrentSeatMm': float(on_current_seat[3]), 'revalidatedOnCurrentSources': valid})
clearance_valid = all(item['revalidatedOnCurrentSources'] for item in witnesses)
clearance = {'status': 'sampled-distance-evidence' if clearance_valid else 'witness-not-revalidated', 'sourceHashes': hashes, 'previousReport': 'docs/puretv-geometry-confirm-mount-repair.json', 'previousReportSha256': sha(old_report_path), 'nominalSlidingClearanceGoalMm': .3, 'minimumWitnessDistanceMm': min(item['distanceMm'] for item in witnesses), 'witnesses': witnesses, 'limitation': 'These revalidated vertex/triangle-centroid nearest distances are upper bounds on the global minimum; not a positive-clearance or manufacturing-tolerance certificate.'}
unchanged = all(sha(SOURCE/name) == value for name, value in hashes.items())
report = {
    'schemaVersion': 1, 'sourceHashes': hashes, 'sourceFilesUnchanged': unchanged,
    'status': 'sampled-path-clear' if not blocked and unchanged and clearance_valid else 'installation-not-verified',
    'coordinates': 'Source mm/Z-up; axis XY=(0,5.5); client=(source.x,source.z,-source.y).',
    'scope': 'Seat, fixed switch body and its two embedded terminals are installed together into the open upper shell before connecting their two wires. Cap remains at its upper retention stop. The actuator follows its body until the actual striker face is reached, then compresses relative to that body.',
    'method': 'Full evaluated source triangles; discrete BVH overlaps and bounded bidirectional interior witnesses. Actuator contacts additionally reconstruct every returned triangle intersection and require the actual striker endpoint plane and zero interior penetration.',
    'auditorScriptSha256': sha(Path(__file__)),
    'sourceObjects': [part.report() for part in [seat, body, gpio, ground, actuator, cap, upper]],
    'startAxialOffsetMm': start, 'entryAngleDeg': 30, 'turnAxialOffsetMm': 1, 'lockedAngleDeg': 0,
    'maximumAxialSampleStepMm': .1, 'maximumAngularSampleStepDeg': .5,
    'initialActuatorGapMm': initial_gap, 'maximumActuatorCompressionMm': max(0, 1-initial_gap), 'declaredActuatorTravelMm': .25,
    'checks': checks, 'blockedSampleCount': len(blocked), 'blockedExamples': blocked[:12],
    'reverseRemoval': {'status': 'same-sampled-poses-clear' if not blocked else 'path-blocked', 'method': 'Reverse exactly the recorded poses with the wires disconnected and the lower shell open; no closed-housing service access or friction/force reversibility is inferred.'},
    'slidingClearance': clearance,
    'limitations': ['The separate seat/upper lock audit is still required for bearing support and anti-pull retention.', 'No continuous collision detection, switch force curve, wire flexibility, assembly force, spring stress or manufacturing certification is inferred.', 'Terminal to plastic boundaries are fixed embedded interfaces in the same rigid subgroup; the final assembly audit separately verifies those local contacts and solder regions.'],
}
if report['maximumActuatorCompressionMm'] > .25001:
    report['status'] = 'installation-not-verified'
    report['actuatorTravelError'] = 'Declared actuator travel exceeded'
output = ROOT/'docs/puretv-geometry-confirm-installation.json'
output.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=locks.clean)+'\n')
print('INSTALLATION-REPORT', report['status'], 'blocked', len(blocked), 'clearance', clearance['status'], output, flush=True)
