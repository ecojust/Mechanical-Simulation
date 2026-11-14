"""Merge reviewed, source-bound local contact declarations for the final audit.

python scripts/compose-puretv-interfaces.py
blender -b --python scripts/audit-puretv-assembly.py -- \
  --interfaces docs/puretv-assembly-interfaces.json

The merge does not validate or waive a collision. The assembly audit independently
proves each source triangle/contained vertex lies inside its exact local patches.
"""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULTS = [
    'docs/puretv-electronics-interfaces.json',
    'docs/puretv-wiring-interfaces.json',
    'docs/puretv-geometry-pad-interfaces.json',
    'docs/puretv-geometry-fasteners.json',
    'docs/puretv-confirm-bearing-regions.json',
]


def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()


def declarations(document):
    if 'flatInterfaces' in document: return document['flatInterfaces']
    if 'interfaceDeclaration' in document: return [document['interfaceDeclaration']]
    if 'interfaces' in document and all('pair' in item for item in document['interfaces']): return document['interfaces']
    if 'fasteners' in document and all('interfaceDeclaration' in item for item in document['fasteners']):
        return [item['interfaceDeclaration'] for item in document['fasteners']]
    raise ValueError('Expected explicit flatInterfaces, interfaces, or interfaceDeclaration; unreviewed evidence cannot be guessed into rules')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('inputs', nargs='*', default=DEFAULTS)
    parser.add_argument('--output', default='docs/puretv-assembly-interfaces.json')
    args = parser.parse_args()
    sources, rules, provenance, ids = {}, [], [], set()
    for name in args.inputs:
        path = (ROOT/name).resolve()
        if not path.is_relative_to(ROOT): raise ValueError('Reviewed public input must be inside the repository')
        data = json.loads(path.read_text())
        hashes = data.get('sourceSha256', data.get('sourceHashes'))
        if not isinstance(hashes, dict) or not hashes: raise ValueError(f'{name} has no source hash mapping')
        for relative,value in hashes.items():
            relative = relative.removeprefix('assets/puretv-controller/')
            if relative in sources and sources[relative]!=value: raise ValueError(f'Stale inputs disagree about {relative}')
            if sha(ROOT/'assets/puretv-controller'/relative)!=value: raise ValueError(f'{name} is stale for {relative}; regenerate its review')
            sources[relative] = value
        added = declarations(data)
        for rule in added:
            if not all(key in rule for key in ('id','pair','regionBlender','reason')): raise ValueError(f'Incomplete explicit rule in {name}')
            if rule['id'] in ids: raise ValueError(f'Duplicate interface id: {rule["id"]}')
            if len(rule['pair'])!=2 or any('::' not in item for item in rule['pair']): raise ValueError('Exact source file and object names are required')
            if any(item.split('::',1)[0] not in hashes and 'assets/puretv-controller/'+item.split('::',1)[0] not in hashes for item in rule['pair']):
                raise ValueError(f'Interface {rule["id"]} is not bound to both source hashes')
            ids.add(rule['id'])
            rules.append(rule)
        provenance.append({'file':str(path.relative_to(ROOT)), 'sha256':sha(path), 'interfaceCount':len(added)})
    result = {'schemaVersion':1, 'sourceSha256':sources, 'interfaces':rules, 'declarationSources':provenance,
              'scope':'Exact named pairs and local regions only. Final full-source assembly audit must independently prove each declaration; this merge is not a passing collision result.'}
    output = ROOT/args.output
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(f'COMPOSED {len(rules)} source-bound local interfaces -> {output.relative_to(ROOT)}')


if __name__=='__main__': main()
