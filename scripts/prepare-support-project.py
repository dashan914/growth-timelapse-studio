#!/usr/bin/env python3
"""Prepare an isolated visualization-only slicer copy; never edit the source."""
import hashlib
import json
import os
import re
import shutil
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, 'reconfigure'):
        _stream.reconfigure(encoding='utf-8')

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / 'vendor/slicer-profiles/bambu-v02.07.01.57'
_resources = os.environ.get('BAMBU_STUDIO_RESOURCES')
NATIVE = (Path(_resources) if Path(_resources).name.lower() == 'profiles' else Path(_resources) / 'profiles') if _resources else Path('/Applications/BambuStudio.app/Contents/Resources/profiles')

BBL_PROFILE_FALLBACKS = {
    'machine': [
        'Bambu Lab H2C 0.4 nozzle',
        'Bambu Lab H2D 0.4 nozzle',
        'Bambu Lab X1 Carbon 0.4 nozzle',
        'Bambu Lab P1S 0.4 nozzle',
        'Bambu Lab A1 0.4 nozzle',
        'Bambu Lab P1P 0.4 nozzle',
        'Bambu Lab A1 mini 0.4 nozzle',
    ],
    'process': [
        '0.20mm Standard @BBL H2C',
        '0.20mm Standard @BBL H2D',
        '0.20mm Standard @BBL X1C',
        '0.20mm Standard @BBL A1',
        '0.20mm Standard @BBL P1P',
        '0.20mm Standard @BBL A1M',
    ],
    'filament': [
        'Generic PLA @BBL H2C 0.4 nozzle',
        'Bambu PLA Basic @BBL X1C',
        'Bambu PLA Basic @BBL P1S 0.4 nozzle',
        'Generic PLA @BBL A1',
        'Bambu PLA Basic @BBL A1',
        'Generic PLA',
    ],
}


def resolve_profile_file(subdir, preferred_name, resources=NATIVE, vendor='BBL'):
    resources = Path(resources) if resources else NATIVE
    library = resources / vendor if (resources / vendor).is_dir() else resources
    preferred = library / subdir / (preferred_name + '.json')
    if preferred.is_file():
        return preferred
    if vendor == 'BBL':
        for name in BBL_PROFILE_FALLBACKS.get(subdir, ()):
            candidate = library / subdir / (name + '.json')
            if candidate.is_file():
                return candidate
        if (library / subdir).is_dir():
            pattern = '*0.4 nozzle.json' if subdir == 'machine' else ('0.20mm Standard*.json' if subdir == 'process' else '*PLA*.json')
            matches = sorted((library / subdir).glob(pattern))
            if matches:
                return matches[0]
    vendor_preferred = VENDOR / subdir / (preferred_name + '.json')
    if vendor_preferred.is_file():
        return vendor_preferred
    if vendor == 'BBL':
        for name in BBL_PROFILE_FALLBACKS.get(subdir, ()):
            vendor_candidate = VENDOR / subdir / (name + '.json')
            if vendor_candidate.is_file():
                return vendor_candidate
    return preferred


def load_flat_profile(filename, base=NATIVE, stack=()):
    filename = Path(filename)
    if filename in stack or len(stack) > 20:
        raise ValueError('Slicer profile inheritance is cyclic or too deep.')
    data = json.loads(filename.read_text(encoding='utf-8'))
    inherited = data.get('inherits')
    result = {}
    if inherited:
        candidate = filename.parent / (inherited + '.json')
        if not candidate.exists():
            base_path = Path(base) if base else None
            candidates = list(base_path.rglob(inherited + '.json')) if base_path and base_path.exists() else []
            if not candidates and VENDOR.exists():
                candidates = list(VENDOR.rglob(inherited + '.json'))
            if not candidates:
                raise ValueError('Cannot find local profile ancestor: ' + inherited)
            candidates.sort(key=lambda p: (0 if 'OrcaFilamentLibrary' in str(p) else 1, str(p)))
            candidate = candidates[0]
        result.update(load_flat_profile(candidate, base, (*stack, filename)))
    result.update({key: value for key, value in data.items() if key not in ('inherits', 'include')})
    return result


def prepare(source, destination, report_path):
    corrections = []
    with zipfile.ZipFile(source) as original:
        entries = original.infolist()
        names = [entry.filename for entry in entries]
        norm_names = [name.replace('\\', '/') for name in names]
        if any(name.startswith(('/', '\\')) or '..' in name.replace('\\', '/').split('/') for name in names):
            raise ValueError('3MF contains unsafe archive paths.')
        if len(norm_names) != len(set(norm_names)):
            raise ValueError('3MF contains duplicate ZIP entries.')
        if sum(entry.file_size for entry in entries) > 1024 * 1024 * 1024:
            raise ValueError('3MF expands beyond the 1 GB processing limit.')
        settings_name = 'Metadata/project_settings.config'
        actual_settings_entry = next((entry.filename for entry in entries if entry.filename.replace('\\', '/') == settings_name), None)
        if not actual_settings_entry:
            raise ValueError('This 3MF has no saved slicer project settings. Save it as a slicer project first.')
        settings = json.loads(original.read(actual_settings_entry).decode('utf-8-sig'))
        if not isinstance(settings, dict):
            raise ValueError('Project settings must be an object.')
        if str(settings.get('enable_support', '0')).lower() not in ('1', 'true'):
            raise ValueError('Support is disabled in the saved 3MF. Enable support in the slicer and save the project first.')
        support_before = {key: value for key, value in settings.items() if 'support' in key}
        # An attached project is geometry/configuration, never permission to run a script.
        for key in ('post_process', 'post_process_scripts', 'post_processing_script', 'gcode_post_process'):
            if settings.get(key):
                before = settings[key]
                settings[key] = [] if isinstance(before, list) else ''
                corrections.append({'field': key, 'before': before, 'after': settings[key],
                                    'reason': 'Disabled external post-processing commands for local visualization.'})
        # These suffixes are source-display labels, not printer or print preset IDs.
        for key in ('printer_settings_id', 'print_settings_id'):
            value = settings.get(key)
            if isinstance(value, str):
                cleaned = re.sub(r'\([^()]*\.3mf\)\s*$', '', value, flags=re.IGNORECASE).strip()
                if cleaned != value:
                    settings[key] = cleaned
                    corrections.append({'field': key, 'before': value, 'after': cleaned,
                                        'reason': 'Removed the source-file display suffix from the preset ID.'})
        # The two out-of-range fields are unused only in this proven grid/no-override case.
        overrides = False
        for entry in entries:
            norm_entry = entry.filename.replace('\\', '/')
            if norm_entry.startswith('Metadata/') and norm_entry.endswith(('.config', '.xml')) and norm_entry != settings_name:
                try:
                    xml = ET.fromstring(original.read(entry))
                except (ET.ParseError, UnicodeDecodeError):
                    continue
                if any(node.attrib.get('key') == 'sparse_infill_pattern' for node in xml.iter()):
                    overrides = True
        if settings.get('sparse_infill_pattern') == 'grid' and not overrides:
            for key in ('skeleton_infill_line_width', 'skin_infill_line_width'):
                if str(settings.get(key)) == '100':
                    corrections.append({'field': key, 'before': settings.pop(key), 'after': None,
                                        'reason': 'Inactive lockedzag-only field under grid infill with no object or part override.'})
        if str(settings.get('ooze_prevention', '0')).lower() in ('1', 'true') and str(settings.get('enable_prime_tower', '0')).lower() in ('1', 'true'):
            before = settings['ooze_prevention']
            settings['ooze_prevention'] = '0'
            corrections.append({'field': 'ooze_prevention', 'before': before, 'after': '0',
                                'reason': 'Resolved the mutually exclusive skirt/brim ooze-prevention and prime-tower settings for visualization slicing.'})
        if support_before != {key: value for key, value in settings.items() if 'support' in key}:
            raise ValueError('A support setting changed unexpectedly; refusing to slice.')
        settings_bytes = json.dumps(settings, ensure_ascii=False, indent=2).encode('utf-8')
        with zipfile.ZipFile(destination, 'w') as prepared:
            for entry in entries:
                norm_entry = entry.filename.replace('\\', '/')
                if norm_entry == settings_name:
                    target_entry = entry if entry.filename == settings_name else settings_name
                    prepared.writestr(target_entry, settings_bytes)
                else:
                    target_entry = entry if entry.filename == norm_entry else norm_entry
                    with original.open(entry) as incoming, prepared.open(target_entry, 'w') as outgoing:
                        shutil.copyfileobj(incoming, outgoing, length=1024 * 1024)
    source_hash = hashlib.sha256()
    with open(source, 'rb') as incoming:
        for block in iter(lambda: incoming.read(1024 * 1024), b''):
            source_hash.update(block)
    report = {'visualizationOnly': True, 'corrections': corrections,
              'unchangedSupportFields': support_before,
              'changedZipEntries': [settings_name],
              'sourceSha256': source_hash.hexdigest()}
    Path(report_path).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'corrections': corrections, 'supportFieldsPreserved': len(support_before)}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        if len(sys.argv) != 4:
            raise ValueError('Expected source.3mf, preview.3mf and report.json paths.')
        prepare(*sys.argv[1:])
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
