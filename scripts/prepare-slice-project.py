#!/usr/bin/env python3
"""Stage a complete, inert local visualization slice without editing its input.

Saved geometry, paint annotations, part settings and build transforms are copied
byte-for-byte. Missing regular layer height uses the user's 0.16 mm tool
preference; other missing facts come from the pinned Bambu Standard base. A
selected local slicer is the actual engine, reported separately.
"""
import hashlib
import json
import math
import os
import re
import shutil
import struct
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, 'reconfigure'):
        _stream.reconfigure(encoding='utf-8')

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / 'vendor/slicer-profiles/bambu-v02.07.01.57'
_resources = os.environ.get('BAMBU_STUDIO_RESOURCES')
NATIVE = (Path(_resources) if Path(_resources).name.lower() == 'profiles' else Path(_resources) / 'profiles') if _resources else Path('/Applications/BambuStudio.app/Contents/Resources/profiles')
VERSION = 'v02.07.01.57'
COMMIT = '3f126b717ed1f10fee0f32f05ed9731808d0c8bb'
PROFILE = {'h2c': '0.20mm Standard @BBL H2C', 'p1s': '0.20mm Standard @BBL X1C', 'a1': '0.20mm Standard @BBL A1'}
MACHINE = {'h2c': 'Bambu Lab H2C 0.4 nozzle', 'p1s': 'Bambu Lab P1S 0.4 nozzle', 'a1': 'Bambu Lab A1 0.4 nozzle'}
FILAMENT = {'h2c': 'Generic PLA @BBL H2C 0.4 nozzle', 'p1s': 'Bambu PLA Basic @BBL P1S 0.4 nozzle', 'a1': 'Generic PLA @BBL A1'}
FLASH_PROFILES = {'machine': 'Flashforge Creator 5 0.4 nozzle', 'process': '0.20mm Standard @FF C5', 'filament': 'Generic PLA @FF C5'}
DEFAULT_LAYER_HEIGHT_MM = 0.16
DEFAULT_FIRST_LAYER_HEIGHT_MM = 0.2
DEFAULT_LAYER_HEIGHT_POLICY = 'user-preference-0.16'
PROCESS_KEYS = (
    'layer_height', 'initial_layer_print_height', 'wall_loops', 'wall_generator',
    'sparse_infill_density', 'sparse_infill_pattern', 'infill_direction',
    'top_shell_layers', 'top_shell_thickness', 'bottom_shell_layers', 'bottom_shell_thickness',
    'line_width', 'initial_layer_line_width', 'outer_wall_line_width', 'inner_wall_line_width',
    'sparse_infill_line_width', 'internal_solid_infill_line_width', 'top_surface_line_width',
    'top_surface_pattern', 'bottom_surface_pattern', 'internal_solid_infill_pattern',
    'wall_filament', 'sparse_infill_filament', 'solid_infill_filament', 'enable_support',
)
ALIASES = {'initial_layer_print_height': 'first_layer_height', 'wall_loops': 'perimeters',
           'sparse_infill_density': 'fill_density', 'sparse_infill_pattern': 'fill_pattern',
           'infill_direction': 'fill_angle', 'top_shell_layers': 'top_solid_layers',
           'bottom_shell_layers': 'bottom_solid_layers', 'top_surface_pattern': 'top_fill_pattern',
           'bottom_surface_pattern': 'bottom_fill_pattern', 'internal_solid_infill_pattern': 'solid_fill_pattern'}
AXIS = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]
IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def file_hash(filename):
    digest = hashlib.sha256()
    with open(filename, 'rb') as incoming:
        for block in iter(lambda: incoming.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def load_flat_profile(filename, base, stack=()):
    filename = Path(filename)
    if filename in stack or len(stack) > 20:
        raise ValueError('Slicer profile inheritance is cyclic or too deep.')
    data = json.loads(filename.read_text(encoding='utf-8'))
    inherited = data.get('inherits')
    result = {}
    if inherited:
        candidate = filename.parent / (inherited + '.json')
        if not candidate.exists():
            candidates = list(base.rglob(inherited + '.json'))
            if not candidates:
                raise ValueError('Cannot find local profile ancestor: ' + inherited)
            # Generic @System belongs to the official filament library.
            candidates.sort(key=lambda p: (0 if 'OrcaFilamentLibrary' in str(p) else 1, str(p)))
            candidate = candidates[0]
        result.update(load_flat_profile(candidate, base, (*stack, filename)))
    result.update({key: value for key, value in data.items() if key not in ('inherits', 'include')})
    return result


def official_process(preset):
    values = load_flat_profile(VENDOR / 'process' / (PROFILE[preset] + '.json'), VENDOR)
    # These facts are constructor defaults in the pinned PrintConfig.cpp.
    values.setdefault('internal_solid_infill_pattern', 'rectilinear')
    return values


def parse_extruder_offset(value):
    if not value:
        return 0.0, 0.0
    if isinstance(value, list) and value:
        value = value[0]
    match = re.match(r'^\s*(-?\d+(?:\.\d+)?)\s*[xX,]\s*(-?\d+(?:\.\d+)?)\s*$', str(value))
    if match:
        return float(match.group(1)), float(match.group(2))
    return 0.0, 0.0


def inert_settings(settings, corrections):
    for key in ('post_process', 'post_process_scripts', 'post_processing_script', 'gcode_post_process'):
        if settings.get(key):
            before = settings[key]
            settings[key] = [] if isinstance(before, list) else ''
            corrections.append({'field': key, 'before': before, 'after': settings[key],
                                'reason': 'Disabled external post-processing commands for visualization.'})
    # Embedded G-code is never sent to a printer. It can nevertheless contain
    # custom shell hooks in some forks; the only executable part is the slicer.
    for key in ('printer_settings_id', 'print_settings_id'):
        value = settings.get(key)
        if isinstance(value, str):
            cleaned = re.sub(r'\([^()]*\.3mf\)\s*$', '', value, flags=re.IGNORECASE).strip()
            if cleaned != value:
                settings[key] = cleaned
                corrections.append({'field': key, 'before': value, 'after': cleaned,
                                    'reason': 'Removed a file display label from a native preset ID.'})
    # Machine hardware nozzle offset shifts G-code toolpaths relative to nominal 3MF CAD mesh.
    # In visualization slicing, all extruders must use 0x0 offset for exact 1:1 CAD alignment.
    if 'extruder_offset' in settings:
        offsets = settings['extruder_offset']
        count = len(offsets) if isinstance(offsets, list) else 1
        zero_offsets = ['0x0'] * count
        if offsets != zero_offsets:
            settings['extruder_offset'] = zero_offsets
            corrections.append({'field': 'extruder_offset', 'before': offsets, 'after': zero_offsets,
                                'reason': 'Normalized physical machine nozzle offset to 0x0 for exact 1:1 CAD visualization alignment.'})
    else:
        palette_len = len(settings.get('filament_colour', settings.get('filament_color', [])))
        nozzle_len = len(settings.get('nozzle_diameter', []))
        count = palette_len or nozzle_len or 1
        settings['extruder_offset'] = ['0x0'] * count


def read_project_settings(archive, names):
    for filename in ('Metadata/project_settings.config', 'Metadata/Slic3r_PE.config'):
        if filename not in names:
            continue
        if archive.getinfo(filename).file_size > 8 * 1024 * 1024:
            raise ValueError('Saved slicer settings are too large.')
        text = archive.read(filename).decode('utf-8-sig')
        if len(text) > 8 * 1024 * 1024:
            raise ValueError('Saved slicer settings are too large.')
        if text.lstrip().startswith('{'):
            settings = json.loads(text)
        else:
            settings = {}
            for line in text.splitlines():
                match = re.match(r'\s*(?:;\s*)?([\w]+)\s*=\s*(.*?)\s*$', line)
                if match:
                    settings[match[1]] = match[2]
        if not isinstance(settings, dict):
            raise ValueError('Saved slicer settings must be an object.')
        return filename, settings
    return None, {}


def fill_missing(settings, defaults, corrections):
    sources = {}
    for key in PROCESS_KEYS:
        if key in settings:
            sources[key] = {'source': 'project', 'value': settings[key]}
        elif ALIASES.get(key) in settings:
            settings[key] = settings[ALIASES[key]]
            sources[key] = {'source': 'project-alias', 'key': ALIASES[key], 'value': settings[key]}
            corrections.append({'field': key, 'after': settings[key], 'reason': 'Translated the saved slicer parameter alias.'})
        elif key == 'layer_height':
            settings[key] = str(DEFAULT_LAYER_HEIGHT_MM)
            sources[key] = {'source': 'studio-default', 'value': settings[key],
                            'defaultPolicy': DEFAULT_LAYER_HEIGHT_POLICY}
        elif key in defaults:
            settings[key] = defaults[key]
            sources[key] = {'source': 'bambu-default', 'profile': defaults['name'], 'version': VERSION, 'commit': COMMIT, 'value': settings[key]}
    return sources


def native_fallback(destination, settings, defaults, preset, colors, resources=NATIVE, vendor='BBL'):
    """Write fixed local profiles; machine/engine provenance remains explicit."""
    destination = Path(destination)
    resources = Path(resources)
    if vendor not in ('BBL', 'Flashforge'):
        raise ValueError('Unsupported native profile vendor: ' + str(vendor))
    library = resources / vendor if (resources / vendor).is_dir() else resources
    machine_name = MACHINE[preset] if vendor == 'BBL' else FLASH_PROFILES['machine']
    filament_name = FILAMENT[preset] if vendor == 'BBL' else FLASH_PROFILES['filament']
    machine = load_flat_profile(library / 'machine' / (machine_name + '.json'), resources)
    native_machine_name = machine['name']
    process_base = machine.get('default_print_profile', PROFILE[preset]) if vendor == 'BBL' else FLASH_PROFILES['process']
    process = load_flat_profile(library / 'process' / (process_base + '.json'), resources)
    filament = load_flat_profile(library / 'filament' / (filament_name + '.json'), resources)
    process.update({key: value for key, value in defaults.items() if key in process or key in PROCESS_KEYS})
    process.update({key: value for key, value in settings.items() if key in process or key in PROCESS_KEYS})
    layer_height = process.get('layer_height', str(DEFAULT_LAYER_HEIGHT_MM))
    if isinstance(layer_height, list):
        layer_height = layer_height[0]
    process_name = f'Growth Studio {layer_height}mm @BBL {preset.upper()}' if vendor == 'BBL' else f'Growth Studio {layer_height}mm @FF C5 ({preset.upper()} scene)'
    # CLI does not apply the GUI's "empty means every printer" rule when two
    # replacement configs are loaded. BambuStudio.cpp compares the process's
    # list directly to the loaded printer's system name (user preset inherits).
    process.update({'name': process_name, 'from': 'user', 'inherits': process_base,
                    'print_settings_id': process_name, 'compatible_printers': [native_machine_name],
                    'compatible_printers_condition': ''})
    process.pop('setting_id', None)
    for key in ('post_process', 'post_process_scripts', 'post_processing_script', 'gcode_post_process'):
        process[key] = []
    compatibility_changes = []
    # This fork cannot accept Bambu's inactive automatic-wall default. Saved
    # explicit support settings are authoritative and are never altered here.
    if vendor == 'Flashforge' and str(process.get('enable_support', '0')).lower() in ('0', 'false') and 'tree_support_wall_count' not in settings:
        before = process.get('tree_support_wall_count')
        process['tree_support_wall_count'] = '0'
        if before != '0':
            compatibility_changes.append({'field': 'tree_support_wall_count', 'before': before, 'after': '0',
                                          'reason': 'Selected Flashforge engine cannot accept the inactive Bambu automatic support-wall default.'})
    # Missing-machine geometry is visualized on the chosen preset's verified
    # bed dimensions. This is not a downloadable printer-ready job.
    # Match the scene preset's usable photographed plate rectangle. H2C's
    # pinned historic Bambu union is wider (345 mm); the scene's conservative
    # 330 mm rectangle is explicit. A Flashforge profile keeps its own machine
    # identity while using this declared visualization stage rectangle.
    bed = [330.0, 320.0] if preset == 'h2c' else [256.0, 256.0]
    machine.update({'name': f'Growth Studio {native_machine_name}', 'from': 'user', 'inherits': native_machine_name,
                    'printable_area': ['0x0', f'{bed[0]:g}x0', f'{bed[0]:g}x{bed[1]:g}', f'0x{bed[1]:g}'],
                    'printer_settings_id': f'Growth Studio {native_machine_name}'})
    machine.pop('setting_id', None)
    if 'extruder_offset' in machine:
        offsets = machine['extruder_offset']
        count = len(offsets) if isinstance(offsets, list) else 1
        machine['extruder_offset'] = ['0x0'] * count
    # A geometry-only project has no saved prime-tower position. Bambu's CLI
    # default x=15 lies outside H2C's second extruder area (minimum x=25).
    # Supply a default within the common nozzle area without moving models or
    # changing a source project's explicit tower coordinates. Native slicing
    # still validates the resulting tower and model paths.
    areas = machine.get('extruder_printable_area', [])
    shared_min_x = max([min(float(point.split('x')[0]) for point in area.split(',')) for area in areas] or [0.0])
    tower_defaults = {'wipe_tower_x': [f'{shared_min_x + 15:g}'], 'wipe_tower_y': [f'{max(15.0, bed[1] - 100):g}']}
    for key, value in tower_defaults.items():
        if key not in settings:
            process[key] = value
            compatibility_changes.append({'field': key, 'before': None, 'after': value,
                                          'reason': 'Missing auxiliary prime-tower position defaults inside the common nozzle area; source model placement unchanged.'})
    machine_path = destination / 'fallback-machine.json'
    process_path = destination / 'fallback-process.json'
    saved_colors = settings.get('filament_colour', settings.get('filament_color'))
    if isinstance(saved_colors, str):
        saved_colors = [value.strip() for value in re.split('[;,]', saved_colors)]
    if isinstance(saved_colors, list) and saved_colors and all(re.fullmatch('#[0-9a-fA-F]{6}', str(value)) for value in saved_colors):
        palette = saved_colors
    else:
        palette = colors or ['#D6D6D6']
    # CLI receives one compatible native material profile per logical tool.
    # Keep duplicate RGB slots distinct: part/paint indexes reference slots.
    filament_paths = []
    for tool, hex_color in enumerate(palette):
        slot = dict(filament)
        for key, value in settings.items():
            if key in filament and isinstance(value, list) and len(value) == len(palette) and key != 'compatible_printers':
                slot[key] = [value[tool]]
        slot_name = f"Growth Studio {filament['name']} T{tool}"
        slot.update({'name': slot_name, 'from': 'user', 'inherits': filament['name'],
                     'compatible_printers': [native_machine_name], 'compatible_printers_condition': '',
                     'filament_colour': [hex_color], 'filament_settings_id': [slot_name]})
        slot.pop('setting_id', None)
        filename = destination / f'fallback-filament-{tool + 1}.json'
        filename.write_text(json.dumps(slot, ensure_ascii=False, indent=2), encoding='utf-8')
        os.chmod(filename, 0o600)
        filament_paths.append(filename)
    for key, value in list(filament.items()):
        if isinstance(value, list) and len(value) == 1 and key not in ('compatible_printers',):
            filament[key] = value * len(palette)
    filament.update({'compatible_printers': [], 'filament_colour': palette,
                     'filament_settings_id': [filament['name']] * len(palette)})
    for filename, data in ((machine_path, machine), (process_path, process)):
        filename.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
        os.chmod(filename, 0o600)
    # Keep all process/material facts. Only unsupported/missing third-party
    # machine fields are replaced by the selected native Bambu machine; callers
    # report these individual changes without rewriting any model/paint member.
    merged = {**machine, **process, **filament, **settings}
    machine_changes = []
    for key, value in machine.items():
        if key in ('type', 'name', 'from', 'inherits', 'instantiation', 'setting_id', 'compatible_printers', 'compatible_printers_condition') or key.startswith('support_'):
            continue
        if settings.get(key) != value:
            machine_changes.append({'field': key, 'before': settings.get(key), 'after': value,
                                    'reason': f'Selected native {vendor} machine compatibility; original process, colors, volumes and placement retained.'})
        merged[key] = value
    merged.update({'printer_settings_id': machine['name'], 'print_settings_id': process_name,
                   'filament_settings_id': settings.get('filament_settings_id', [filament['name']] * len(palette)), 'filament_colour': palette})
    for key in ('type', 'name', 'from', 'instantiation', 'setting_id', 'compatible_printers', 'compatible_printers_condition'):
        merged.pop(key, None)
    if 'inherits' not in settings:
        merged.pop('inherits', None)
    return merged, bed, {'machine': native_machine_name, 'cliMachineProfile': machine['name'],
                        'cliProcessParent': process_base, 'cliPrinterSystemName': native_machine_name,
                        'cliProcessCompatiblePrinters': process['compatible_printers'],
                        'machineSource': 'installed-bambu-profile' if vendor == 'BBL' else 'installed-flashforge-profile',
                        'profileVendor': vendor, 'nativeProcessBaseProfile': process_base,
                        'resourcesDirectory': str(resources), 'originalMachine': settings.get('printer_model'),
                        'machineChanges': machine_changes, 'compatibilityChanges': compatibility_changes,
                        'process': process_name, 'processSource': 'pinned-bambu-standard-base-with-explicit-settings',
                        'processBaseProfile': PROFILE[preset],
                        'effectiveLayerHeightMm': float(layer_height),
                        'missingLayerHeightPolicy': DEFAULT_LAYER_HEIGHT_POLICY,
                        'filament': filament['name'], 'filamentSource': 'installed-bambu-profile' if vendor == 'BBL' else 'installed-flashforge-profile',
                        'logicalFilamentCount': len(palette), 'toolColorsPreserved': palette,
                        'bedGeometrySource': 'scene-preset-effective-area',
                        'officialH2CMachineUnionMm': [345, 320] if preset == 'h2c' else None,
                        'loadSettings': [machine_path.name, process_path.name], 'loadFilaments': [filename.name for filename in filament_paths]}


def affine_inverse(matrix):
    # Column-major affine matrix, explicit inversion; no fitted alignment.
    a, b, c, d, e, f, g, h, i = matrix[0], matrix[4], matrix[8], matrix[1], matrix[5], matrix[9], matrix[2], matrix[6], matrix[10]
    det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
    if abs(det) < 1e-15:
        raise ValueError('Source transform is singular.')
    rows = [(e*i-f*h, c*h-b*i, b*f-c*e), (f*g-d*i, a*i-c*g, c*d-a*f), (d*h-e*g, b*g-a*h, a*e-b*d)]
    inv = [0.0] * 16
    for r in range(3):
        for col in range(3):
            inv[col * 4 + r] = rows[r][col] / det
        inv[12+r] = -sum(inv[col*4+r] * matrix[12+col] for col in range(3))
    inv[15] = 1
    return inv


def multiply(a, b):
    return [sum(a[k*4+r] * b[col*4+k] for k in range(4)) for col in range(4) for r in range(4)]


def transform(matrix, point):
    return [sum(matrix[col*4+r] * point[col] for col in range(3)) + matrix[12+r] for r in range(3)]


def stl_triangles(source):
    size = Path(source).stat().st_size
    with open(source, 'rb') as incoming:
        header = incoming.read(84)
        count = struct.unpack_from('<I', header, 80)[0] if len(header) == 84 else 0
        if count and 84 + count * 50 == size:
            if count > 8_000_000:
                raise ValueError('STL has more than 8 million triangles; no geometry was truncated.')
            for _ in range(count):
                triangle = struct.unpack('<12fH', incoming.read(50))[3:12]
                yield [triangle[index:index+3] for index in (0, 3, 6)]
            return
    triangle = []
    count = 0
    with open(source, 'r', encoding='ascii') as incoming:
        for line in incoming:
            if len(line) > 1024:
                raise ValueError('ASCII STL has an excessively long line.')
            match = re.fullmatch(r'\s*vertex\s+([\d+eE.\-]+)\s+([\d+eE.\-]+)\s+([\d+eE.\-]+)\s*', line)
            if match:
                triangle.append([float(value) for value in match.groups()])
                if len(triangle) == 3:
                    count += 1
                    if count > 8_000_000:
                        raise ValueError('STL has more than 8 million triangles; no geometry was truncated.')
                    yield triangle
                    triangle = []
    if triangle or not count:
        raise ValueError('STL geometry is incomplete or empty.')


def prepare_stl(source, destination, report, options, defaults):
    matrix = options.get('sourceToPrinter', IDENTITY)
    minimum, maximum = [math.inf]*3, [-math.inf]*3
    count = 0
    for triangle in stl_triangles(source):
        for point in triangle:
            if any(not math.isfinite(value) or abs(value) > 1e7 for value in point):
                raise ValueError('STL contains invalid or unbounded coordinates.')
            point = transform(matrix, point)
            for axis, value in enumerate(point):
                minimum[axis] = min(minimum[axis], value)
                maximum[axis] = max(maximum[axis], value)
        count += 1
    settings = {}
    sources = fill_missing(settings, defaults, [])
    settings, bed, engine = native_fallback(Path(destination).parent, settings, defaults, options['preset'], options.get('toolColors', []), options.get('slicerResources', NATIVE), options.get('profileVendor', 'BBL'))
    span = [maximum[axis]-minimum[axis] for axis in range(3)]
    if span[0] > bed[0] or span[1] > bed[1]:
        raise ValueError('The full-size model does not fit the selected plate. It was not scaled or simplified.')
    translation = [bed[0]/2-(minimum[0]+maximum[0])/2, bed[1]/2-(minimum[1]+maximum[1])/2, -minimum[2]]
    staging = IDENTITY.copy()
    staging[12:15] = translation
    to_source = affine_inverse(matrix)
    if options.get('sourceCoordinateSystem', 'printer-z-up') == 'printer-z-up':
        to_source = multiply(AXIS, to_source)
    to_source = multiply(to_source, affine_inverse(staging))
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        archive.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
        archive.writestr('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
        with archive.open('3D/3dmodel.model', 'w', force_zip64=True) as xml:
            xml.write(b'<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">BambuStudio</metadata><metadata name="BambuStudio:3mfVersion">1</metadata><metadata name="GrowthStudio:Staging">full triangle copy, visualization only</metadata><resources><object id="1" type="model"><mesh><vertices>')
            for triangle in stl_triangles(source):
                for point in triangle:
                    point = transform(matrix, point)
                    xml.write(('<vertex ' + ' '.join(f'{axis}="{value:.17g}"' for axis, value in zip('xyz', point)) + '/>').encode())
            xml.write(b'</vertices><triangles>')
            for face in range(count):
                xml.write(f'<triangle v1="{face*3}" v2="{face*3+1}" v3="{face*3+2}"/>'.encode())
            tx, ty, tz = translation
            xml.write(f'</triangles></mesh></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 {tx:.17g} {ty:.17g} {tz:.17g}"/></build></model>'.encode())
        archive.writestr('Metadata/project_settings.config', json.dumps(settings, ensure_ascii=False))
        archive.writestr('Metadata/model_settings.config', '<config><object id="1"><metadata key="name" value="' + escape(options.get('sourceName', 'Imported full-resolution mesh'), {'"': '&quot;'}) + '"/><metadata key="extruder" value="1"/><part id="1" subtype="normal_part"><metadata key="extruder" value="1"/></part></object><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="1"/><metadata key="instance_id" value="0"/></model_instance></plate></config>')
    report.update({'sourceType': 'stl', 'sourceCoordinateSystem': options.get('sourceCoordinateSystem', 'printer-z-up'),
                   'sourceUnits': 'sourceToPrinter explicit millimetres' if matrix != IDENTITY else 'millimetres',
                   'sourceToPrinter': matrix, 'stagingTransform': staging, 'printerToSource': to_source,
                   'stagingTranslationMm': translation, 'sourceBoundsInPrinterAxesMm': {'min': minimum, 'max': maximum},
                   'triangleCount': count, 'geometrySimplified': False, 'fieldSources': sources, 'fallbackEngineProfiles': engine,
                   'bedSizeMm': bed, 'toolColors': settings['filament_colour'], 'rawSettings': settings,
                   'changedZipEntries': ['generated archive from every source triangle']})


def prepare_3mf(source, destination, report, options, defaults):
    corrections = []
    with zipfile.ZipFile(source) as original:
        entries = original.infolist()
        names = [entry.filename for entry in entries]
        if len(entries) > 10000 or len(names) != len(set(names)):
            raise ValueError('3MF contains too many or duplicate ZIP entries.')
        if any((entry.external_attr >> 16) & 0o170000 == 0o120000 for entry in entries):
            raise ValueError('3MF cannot contain symbolic-link entries.')
        if any(name.startswith(('/', '\\')) or '..' in name.replace('\\', '/').split('/') or '\x00' in name for name in names):
            raise ValueError('3MF contains unsafe archive paths.')
        if sum(entry.file_size for entry in entries) > 1024*1024*1024:
            raise ValueError('3MF expands beyond the 1 GB processing limit.')
        if any(entry.file_size > 512*1024*1024 for entry in entries):
            raise ValueError('3MF contains an excessively large entry.')
        if not any(name.lower().endswith('.model') for name in names):
            raise ValueError('3MF has no model geometry.')
        settings_name, settings = read_project_settings(original, names)
        staging_info = None
        if 'Metadata/growth_source.json' in names:
            if original.getinfo('Metadata/growth_source.json').file_size > 8*1024*1024:
                raise ValueError('Generic staging metadata is too large.')
            staging_info = json.loads(original.read('Metadata/growth_source.json'))
            if not isinstance(staging_info, dict):
                raise ValueError('Generic staging metadata must be an inert object.')
        before = settings.copy()
        source_palette_saved = any(settings.get(key) for key in ('filament_colour', 'filament_color', 'extruder_colour', 'extruder_color'))
        support_before = {key: value for key, value in settings.items() if 'support' in key}
        sources = fill_missing(settings, defaults, corrections)
        inert_settings(settings, corrections)
        # Same proven inactive-setting compatibility repair as support slicing.
        overrides = False
        object_settings = {}
        plate_count = 0
        for entry in entries:
            if entry.filename.startswith('Metadata/') and entry.filename.endswith(('.config', '.xml')) and entry.filename != settings_name and entry.file_size <= 8*1024*1024:
                raw = original.read(entry)
                if b'<!DOCTYPE' in raw or b'<!ENTITY' in raw:
                    raise ValueError('3MF metadata contains unsupported XML entities.')
                try:
                    xml = ET.fromstring(raw)
                except (ET.ParseError, UnicodeDecodeError):
                    continue
                if any(node.attrib.get('key') == 'sparse_infill_pattern' for node in xml.iter()):
                    overrides = True
                if 'model_settings' in entry.filename:
                    plate_count = max(plate_count, len(xml.findall('plate')))
                    for obj in xml.findall('object'):
                        values = {node.attrib.get('key'): node.attrib.get('value') for node in obj.findall('metadata') if node.attrib.get('key')}
                        values['parts'] = {}
                        for part in obj.findall('part'):
                            part_values = {node.attrib.get('key'): node.attrib.get('value') for node in part.findall('metadata') if node.attrib.get('key')}
                            part_values['subtype'] = part.attrib.get('subtype', 'normal_part')
                            values['parts'][part.attrib.get('id')] = part_values
                        object_settings[obj.attrib.get('id')] = values
        if settings.get('sparse_infill_pattern') == 'grid' and not overrides:
            for key in ('skeleton_infill_line_width', 'skin_infill_line_width'):
                if str(settings.get(key)) == '100':
                    corrections.append({'field': key, 'before': settings.pop(key), 'after': None,
                                        'reason': 'Inactive lockedzag-only parameter with grid infill and no object/part override.'})
        if str(settings.get('ooze_prevention', '0')).lower() in ('1', 'true') and str(settings.get('enable_prime_tower', '0')).lower() in ('1', 'true'):
            value = settings['ooze_prevention']
            settings['ooze_prevention'] = '0'
            corrections.append({'field': 'ooze_prevention', 'before': value, 'after': '0',
                                'reason': 'Resolved the mutually exclusive ooze-prevention and prime-tower flags for visualization.'})
        embedded_entries = [entry for entry in entries if re.fullmatch(r'(?:Metadata/)?plate_\d+\.gcode', entry.filename, re.IGNORECASE)]
        force_reslice = options.get('forceReslice') is True
        if plate_count > 1 or (not force_reslice and len(embedded_entries) > 1):
            raise ValueError('该工程包含多个打印盘，当前预览不能保证逐盘对应。请在切片软件导出只包含一个打印盘的工程后再导入。')
        if not force_reslice and embedded_entries and not re.fullmatch(r'(?:Metadata/)?plate_1\.gcode', embedded_entries[0].filename, re.IGNORECASE):
            raise ValueError('该工程的切片缓存不在第 1 盘，无法保证与原始模型盘位对齐。请导出第 1 盘的单盘工程。')
        embedded = None
        if embedded_entries and not force_reslice:
            entry = embedded_entries[0]
            if entry.file_size > options.get('maximumGcodeBytes', 768*1024*1024):
                raise ValueError('原始完整切片文件超过处理限制，不会截断或重新编造填充。')
            embedded_path = Path(destination).parent / 'embedded.gcode'
            with original.open(entry) as incoming, embedded_path.open('xb') as outgoing:
                shutil.copyfileobj(incoming, outgoing, length=1024*1024)
            os.chmod(embedded_path, 0o600)
            embedded = {'archiveEntry': entry.filename, 'bytes': entry.file_size,
                        'sha256': file_hash(embedded_path), 'selection': 'original-embedded-complete-gcode',
                        'file': embedded_path.name, 'reSliced': False}
        machine_missing = not settings.get('printer_settings_id') or not settings.get('printer_model')
        vendor = options.get('profileVendor', 'BBL')
        machine_foreign = not str(settings.get('printer_model', '')).startswith('Flashforge ' if vendor == 'Flashforge' else 'Bambu Lab ')
        engine = None
        if (machine_missing or machine_foreign) and not embedded:
            settings, bed, engine = native_fallback(Path(destination).parent, settings, defaults, options['preset'], options.get('toolColors', []), options.get('slicerResources', NATIVE), vendor)
            report['bedSizeMm'] = bed
            corrections.extend(engine['machineChanges'])
            corrections.extend(engine['compatibilityChanges'])
        if any(settings.get(key) != value for key, value in support_before.items()):
            raise ValueError('A saved support setting changed unexpectedly; refusing to slice.')
        out_settings = 'Metadata/project_settings.config'
        hashes = {}
        removed_members = []
        with zipfile.ZipFile(destination, 'w') as prepared:
            for entry in entries:
                if force_reslice and re.fullmatch(r'(?:Metadata/)?plate_\d+\.gcode(?:\.md5)?', entry.filename, re.IGNORECASE):
                    removed_members.append(entry.filename)
                    continue
                if entry.filename == out_settings:
                    prepared.writestr(entry, json.dumps(settings, ensure_ascii=False, indent=2).encode())
                else:
                    digest = hashlib.sha256()
                    with original.open(entry) as incoming, prepared.open(entry, 'w') as outgoing:
                        for block in iter(lambda: incoming.read(1024*1024), b''):
                            digest.update(block)
                            outgoing.write(block)
                    # Geometry/paint/placement ZIP members copied exactly.
                    if entry.filename.lower().endswith('.model') or 'model_settings' in entry.filename:
                        hashes[entry.filename] = {'sha256': digest.hexdigest(), 'bytes': entry.file_size, 'unchanged': True}
            if out_settings not in names:
                prepared.writestr(out_settings, json.dumps(settings, ensure_ascii=False, indent=2).encode())
        printer_to_source = AXIS.copy()
        if embedded and 'extruder_offset' in before:
            x_off, y_off = parse_extruder_offset(before['extruder_offset'])
            if x_off != 0.0 or y_off != 0.0:
                printer_to_source[12] = x_off
                printer_to_source[14] = -y_off
        report.update({'sourceType': '3mf', 'settingsEntry': settings_name, 'rawSettings': settings,
                       'fieldSources': sources, 'corrections': corrections, 'savedSupportFields': support_before,
                       'objectSettings': object_settings,
                       'genericStaging': staging_info,
                       'plateCount': plate_count or 1, 'slicePlate': 1,
                       'embeddedGcode': embedded, 'sourcePaletteSaved': source_palette_saved,
                       'forceReslice': force_reslice, 'removedCachedSliceMembers': removed_members,
                       'geometrySimplified': False, 'preservedMembers': hashes,
                       'changedZipEntries': ([out_settings] if settings != before or out_settings not in names else []) + removed_members,
                       'sourceCoordinateSystem': 'printer-z-up', 'sourceUnits': '3MF declared units, preserved',
                       'stagingTransform': IDENTITY, 'printerToSource': printer_to_source,
                       'fallbackEngineProfiles': engine,
                       'toolColors': settings.get('filament_colour', settings.get('filament_color', options.get('toolColors', [])))})


def prepare(source, destination, report_path, options_path):
    options = json.loads(Path(options_path).read_text(encoding='utf-8'))
    defaults = official_process(options['preset'])
    report = {'schemaVersion': 1, 'visualizationOnly': True, 'sourceSha256': file_hash(source),
              'fallbackProfile': {'name': PROFILE[options['preset']], 'version': VERSION, 'commit': COMMIT,
                                  'parameterOverrides': {}},
              'slicingEngine': {'bambu': 'installed Bambu Studio CLI', 'flash': 'installed Flash Studio CLI', 'orca': 'installed OrcaSlicer CLI'}.get(options.get('engineId'), 'installed Flash Studio CLI' if options.get('profileVendor') == 'Flashforge' else 'installed Bambu Studio CLI'),
              'engineId': options.get('engineId', 'flash' if options.get('profileVendor') == 'Flashforge' else 'bambu'),
              'profileVendor': options.get('profileVendor', 'BBL'), 'forceReslice': options.get('forceReslice') is True, 'corrections': []}
    if options['format'] == 'stl':
        prepare_stl(source, destination, report, options, defaults)
    else:
        prepare_3mf(source, destination, report, options, defaults)
    layer_source = report['fieldSources'].get('layer_height', {})
    if layer_source.get('source') == 'studio-default':
        report['fallbackProfile']['parameterOverrides']['layer_height'] = layer_source
    os.chmod(destination, 0o600)
    Path(report_path).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    os.chmod(report_path, 0o600)
    print(json.dumps({'phase': 'prepared', 'sourceSha256': report['sourceSha256'],
                      'geometrySimplified': False, 'fallbackFields': sum(item['source'] in ('bambu-default', 'studio-default') for item in report['fieldSources'].values())}))


if __name__ == '__main__':
    try:
        if len(sys.argv) != 5:
            raise ValueError('Expected input, staged 3MF, report, and inert options paths.')
        prepare(*sys.argv[1:])
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
