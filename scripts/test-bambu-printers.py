"""Stage isolated native-slicing fixtures for every installed Bambu nozzle profile.

This does not send jobs to printers. Official startup/end/tool-change templates
are included so the application parser is exercised against firmware macros.
"""
import argparse
import json
import runpy
import struct
import subprocess
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--resources', type=Path, required=True)
    parser.add_argument('--slicer', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    args.output.mkdir(parents=True, exist_ok=True)
    library = args.resources / 'BBL'
    prior_path = args.output / 'slicing-results.json'
    prior = {item['profile']: item for item in json.loads(prior_path.read_text())} if args.resume and prior_path.exists() else {}
    profiles = []
    for filename in sorted((library / 'machine').glob('*.json')):
        data = json.loads(filename.read_text(encoding='utf-8'))
        if data.get('printer_model') and data.get('nozzle_diameter') and 'template' not in filename.name:
            profiles.append(filename)
    vertices = [(0, 0, 0), (5, 0, 0), (5, 5, 0), (0, 5, 0),
                (0, 0, 5), (5, 0, 5), (5, 5, 5), (0, 5, 5)]
    faces = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7),
             (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5),
             (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]
    cube = bytearray(80) + struct.pack('<I', len(faces))
    for face in faces:
        cube.extend(struct.pack('<12fH', 0, 0, 0,
                                *sum((list(vertices[i]) for i in face), []), 0))
    results = []
    for index, filename in enumerate(profiles):
        saved = prior.get(filename.stem)
        if saved and saved.get('status') == 'sliced' and Path(saved['gcode']).is_file():
            results.append(saved)
            continue
        item = {'profile': filename.stem, 'status': 'failed'}
        directory = args.output / ('case-%02d' % index)
        directory.mkdir(exist_ok=True)
        try:
            functions = runpy.run_path(str(root / 'scripts/prepare-slice-project.py'))
            # The matrix stages each installed nozzle's native process, rather
            # than the application's three geometry-only background defaults.
            functions['official_process'].__globals__['VENDOR'] = library
            machine = functions['load_flat_profile'](filename, args.resources)
            item.update(model=machine['printer_model'], nozzle=machine['nozzle_diameter'])
            functions['MACHINE']['p1s'] = machine['name']
            functions['PROFILE']['p1s'] = machine['default_print_profile']
            candidates = machine.get('default_filament_profile', [])
            if isinstance(candidates, str):
                candidates = [candidates]
            candidates += ['Bambu PLA Basic @BBL ' + machine['printer_model'].replace('Bambu Lab ', ''),
                           'Generic PLA @BBL ' + machine['printer_model'].replace('Bambu Lab ', '')]
            if machine['printer_model'] == 'Bambu Lab P1P':
                candidates += ['Bambu PLA Basic @BBL X1C', 'Generic PLA @BBL X1C']
            filament = next(name for name in candidates
                            if (library / 'filament' / (name + '.json')).is_file())
            functions['FILAMENT']['p1s'] = filament
            (directory / 'cube.stl').write_bytes(cube)
            (directory / 'options.json').write_text(json.dumps({
                'format': 'stl', 'preset': 'p1s', 'slicerResources': str(args.resources),
                'toolColors': ['#ff3344'], 'forceReslice': True}), encoding='utf-8')
            functions['prepare'](str(directory / 'cube.stl'), str(directory / 'prepared.3mf'),
                                 str(directory / 'report.json'), str(directory / 'options.json'))
            machine_path = directory / 'fallback-machine.json'
            staged = json.loads(machine_path.read_text(encoding='utf-8'))
            # New Studio versions split machine macros into separate files.
            # Flatten those as well, rather than accidentally testing old macros.
            common = machine['printer_model'] + ' 0.4 nozzle'
            templates = sorted((library / 'machine').glob(common + ' template*.json'))
            if filename.stem != common:
                templates += sorted((library / 'machine').glob(filename.stem + ' template*.json'))
            for template in templates:
                for key, value in json.loads(template.read_text(encoding='utf-8')).items():
                    if key.endswith('_gcode') and isinstance(value, str):
                        staged[key] = value
            machine_path.write_text(json.dumps(staged, ensure_ascii=False), encoding='utf-8')
            command = [str(args.slicer), '--debug', '3', '--no-check', '--load-settings',
                       str(machine_path) + ';' + str(directory / 'fallback-process.json'),
                       '--load-filaments', str(directory / 'fallback-filament-1.json'),
                       '--slice', '1', '--arrange', '0', '--orient', '0', '--mstpp', '60',
                       '--outputdir', str(directory / 'output'), str(directory / 'prepared.3mf')]
            with (directory / 'native.log').open('wb') as log:
                completed = subprocess.run(command, stdout=log, stderr=log, timeout=90)
            gcode = directory / 'output/plate_1.gcode'
            if completed.returncode or not gcode.is_file():
                raise RuntimeError('Native slicer failed; see ' + str(directory / 'native.log'))
            item.update(status='sliced', gcode=str(gcode), source=str(directory / 'prepared.3mf'))
        except Exception as error:
            item['error'] = str(error)
        results.append(item)
        (args.output / 'slicing-results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(item, ensure_ascii=False), flush=True)
    print(json.dumps({'profiles': len(profiles), 'sliced': sum(i['status'] == 'sliced' for i in results)}))


if __name__ == '__main__':
    main()
