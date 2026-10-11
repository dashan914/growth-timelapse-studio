#!/usr/bin/env python3
"""Prepare an isolated visualization-only slicer copy; never edit the source."""
import hashlib
import json
import re
import shutil
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path


def prepare(source, destination, report_path):
    corrections = []
    with zipfile.ZipFile(source) as original:
        entries = original.infolist()
        names = [entry.filename for entry in entries]
        if any(name.startswith(('/', '\\')) or '..' in name.replace('\\', '/').split('/') for name in names):
            raise ValueError('3MF contains unsafe archive paths.')
        if len(names) != len(set(names)):
            raise ValueError('3MF contains duplicate ZIP entries.')
        if sum(entry.file_size for entry in entries) > 1024 * 1024 * 1024:
            raise ValueError('3MF expands beyond the 1 GB processing limit.')
        settings_name = 'Metadata/project_settings.config'
        if settings_name not in names:
            raise ValueError('This 3MF has no saved slicer project settings. Save it as a slicer project first.')
        settings = json.loads(original.read(settings_name))
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
            if entry.filename.startswith('Metadata/') and entry.filename.endswith(('.config', '.xml')) and entry.filename != settings_name:
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
                if entry.filename == settings_name:
                    prepared.writestr(entry, settings_bytes)
                else:
                    with original.open(entry) as incoming, prepared.open(entry, 'w') as outgoing:
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
