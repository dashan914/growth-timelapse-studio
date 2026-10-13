// Parameter facts verified against Bambu Studio v02.07.01.57. This module
// normalizes saved settings; it does not synthesize or claim exact toolpaths.
import {BAMBU_PRINTER_MODELS,DEFAULT_BAMBU_PRINTER_MODEL_ID,getBambuPrinterModel} from './printer-presets.js';
export const BAMBU_DEFAULT_VERSION = 'v02.07.01.57';
export const BAMBU_DEFAULT_COMMIT = '3f126b717ed1f10fee0f32f05ed9731808d0c8bb';
// The user selected 0.16 mm as this tool's missing-layer preference. Other
// absent parameters still come from the verified 0.20 Standard base profile;
// this is not a claim that the complete official 0.16 preset was selected.
export const DEFAULT_LAYER_HEIGHT_MM = 0.16;
export const DEFAULT_FIRST_LAYER_HEIGHT_MM = 0.2;
export const DEFAULT_LAYER_HEIGHT_POLICY = 'user-preference-0.16';
const BASE_URL = `https://github.com/bambulab/BambuStudio/blob/${BAMBU_DEFAULT_COMMIT}`;
export const BAMBU_SLICE_DEFAULT_SOURCES = Object.freeze([
  `${BASE_URL}/resources/profiles/BBL/process/fdm_process_common.json`,
  `${BASE_URL}/resources/profiles/BBL/process/fdm_process_single_0.20.json`,
  `${BASE_URL}/resources/profiles/BBL/process/0.20mm%20Standard%20%40BBL%20H2C.json`,
  `${BASE_URL}/resources/profiles/BBL/process/0.20mm%20Standard%20%40BBL%20X1C.json`,
  `${BASE_URL}/resources/profiles/BBL/process/0.20mm%20Standard%20%40BBL%20A1.json`,
  `${BASE_URL}/src/libslic3r/PrintConfig.cpp`,
]);

const PROFILE_NAMES = Object.freeze(Object.fromEntries(BAMBU_PRINTER_MODELS.map(model=>[model.id,model.processProfile])));
const DEFAULTS = Object.freeze({
  layer_height: String(DEFAULT_LAYER_HEIGHT_MM), initial_layer_print_height: String(DEFAULT_FIRST_LAYER_HEIGHT_MM), wall_loops: '2',
  sparse_infill_density: '15%', sparse_infill_pattern: 'grid', infill_direction: '45',
  top_shell_layers: '5', top_shell_thickness: '1.0', bottom_shell_layers: '3', bottom_shell_thickness: '0',
  line_width: '0.42', initial_layer_line_width: '0.5', outer_wall_line_width: '0.42',
  inner_wall_line_width: '0.45', sparse_infill_line_width: '0.45', internal_solid_infill_line_width: '0.42',
  top_surface_line_width: '0.42', top_surface_pattern: 'monotonicline', bottom_surface_pattern: 'monotonic',
  internal_solid_infill_pattern: 'rectilinear', wall_filament: '0', sparse_infill_filament: '0',
  solid_infill_filament: '0', nozzle_diameter: ['0.4'],
});

const NUMBER_FIELDS = Object.freeze({
  layerHeightMm: { key: 'layer_height', min: 0, max: 10, positive: true },
  firstLayerHeightMm: { key: 'initial_layer_print_height', aliases: ['first_layer_height'], min: 0, max: 10, positive: true },
  wallLoops: { key: 'wall_loops', aliases: ['perimeters'], min: 0, max: 1000, integer: true },
  sparseInfillDensityPercent: { key: 'sparse_infill_density', aliases: ['fill_density'], min: 0, max: 100, percent: true },
  infillDirectionDeg: { key: 'infill_direction', aliases: ['fill_angle'], min: -36000, max: 36000 },
  topShellLayers: { key: 'top_shell_layers', aliases: ['top_solid_layers'], min: 0, max: 1000, integer: true },
  bottomShellLayers: { key: 'bottom_shell_layers', aliases: ['bottom_solid_layers'], min: 0, max: 1000, integer: true },
  topShellThicknessMm: { key: 'top_shell_thickness', aliases: ['top_solid_min_thickness'], min: 0, max: 10000 },
  bottomShellThicknessMm: { key: 'bottom_shell_thickness', aliases: ['bottom_solid_min_thickness'], min: 0, max: 10000 },
});
const PATTERN_FIELDS = Object.freeze({
  sparseInfillPattern: { key: 'sparse_infill_pattern', aliases: ['fill_pattern'] },
  topSurfacePattern: { key: 'top_surface_pattern', aliases: ['top_fill_pattern'] },
  bottomSurfacePattern: { key: 'bottom_surface_pattern', aliases: ['bottom_fill_pattern'] },
  solidInfillPattern: { key: 'internal_solid_infill_pattern', aliases: ['solid_fill_pattern'] },
});
const WIDTH_FIELDS = Object.freeze({
  default: 'line_width', initial: 'initial_layer_line_width', outerWall: 'outer_wall_line_width',
  innerWall: 'inner_wall_line_width', sparseInfill: 'sparse_infill_line_width',
  solidInfill: 'internal_solid_infill_line_width', topSurface: 'top_surface_line_width',
});
const TOOL_FIELDS = Object.freeze({ wall: 'wall_filament', sparseInfill: 'sparse_infill_filament', solidInfill: 'solid_infill_filament' });
const own = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k);
const scalar = value => Array.isArray(value) ? value[0] : value;
const color = value => /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(String(value)) ? String(value).slice(0, 7).toLowerCase() : null;
const arrayValue = value => Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[;,]/) : [];

/** Accept only inert JSON or serialized setting lines, never execute G-code. */
export function parseSliceSettingsText(text = '') {
  if (text && typeof text === 'object') {
    if (Array.isArray(text)) throw new Error('切片参数必须为对象。');
    return text;
  }
  if (typeof text !== 'string') throw new Error('切片参数格式无效。');
  if (text.trim().startsWith('{')) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('切片参数 JSON 损坏。'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('切片参数必须为对象。');
    return parsed;
  }
  const parsed = Object.create(null);
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:;\s*)?([\w]+)\s*=\s*(.*?)\s*$/);
    if (match && !['__proto__', 'constructor', 'prototype'].includes(match[1])) parsed[match[1]] = match[2];
  }
  return parsed;
}

function valueFrom(layers, keys) {
  for (let i = layers.length - 1; i >= 0; i--) {
    for (const key of keys) if (own(layers[i].values, key)) return { ...layers[i], key, rawValue: layers[i].values[key] };
  }
  return null;
}
function numberValue(raw, { percent = false, min = -Infinity, max = Infinity, integer = false, positive = false } = {}) {
  const value = scalar(raw);
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const text = String(value).trim();
  if (!(percent ? /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)%?$/ : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/).test(text)) return null;
  const numeric = Number(text.replace(/%$/, ''));
  return Number.isFinite(numeric) && numeric >= min && numeric <= max && (!positive || numeric > 0) && (!integer || Number.isInteger(numeric)) ? numeric : null;
}
function normalizeLayers(layers, preset) {
  const fields = {}, warnings = [], values = {};
  const read = (path, specification, convert) => {
    const { key, aliases = [] } = specification;
    let item = valueFrom(layers, [key, ...aliases]);
    let value = item ? convert(item.rawValue) : null;
    if (value === null) {
      if (item) warnings.push({ field: path, code: 'invalid-saved-value', key: item.key, value: item.rawValue });
      item = key === 'layer_height'
        ? { source: 'studio-default', key, rawValue: DEFAULTS[key], defaultPolicy: DEFAULT_LAYER_HEIGHT_POLICY }
        : { source: 'bambu-default', key, rawValue: DEFAULTS[key], profile: PROFILE_NAMES[preset], version: BAMBU_DEFAULT_VERSION, commit: BAMBU_DEFAULT_COMMIT };
      value = convert(item.rawValue);
    }
    const { source, key: sourceKey, rawValue, objectId, partId, profile, version, commit, defaultPolicy } = item;
    fields[path] = { source, key: sourceKey, rawValue, ...(objectId !== undefined ? { objectId } : {}), ...(partId !== undefined ? { partId } : {}), ...(profile ? { profile, version, commit } : {}), ...(defaultPolicy ? { defaultPolicy } : {}) };
    return value;
  };
  for (const [path, spec] of Object.entries(NUMBER_FIELDS)) values[path] = read(path, spec, raw => numberValue(raw, spec));
  for (const [path, spec] of Object.entries(PATTERN_FIELDS)) values[path] = read(path, spec, raw => {
    const item = scalar(raw);
    return typeof item === 'string' && /^[\w -]{1,64}$/.test(item.trim()) ? item.trim() : null;
  });
  const nozzle = valueFrom(layers, ['nozzle_diameter']);
  values.nozzleDiameterMm = numberValue(nozzle?.rawValue, { min: 0.1, max: 5 }) ?? 0.4;
  fields.nozzleDiameterMm = nozzle && numberValue(nozzle.rawValue, { min: 0.1, max: 5 }) !== null
    ? { source: nozzle.source, key: 'nozzle_diameter', rawValue: nozzle.rawValue }
    : { source: 'bambu-default', key: 'nozzle_diameter', rawValue: DEFAULTS.nozzle_diameter, profile: PROFILE_NAMES[preset], version: BAMBU_DEFAULT_VERSION, commit: BAMBU_DEFAULT_COMMIT };
  values.lineWidthsMm = {};
  for (const [name, key] of Object.entries(WIDTH_FIELDS)) {
    values.lineWidthsMm[name] = read(`lineWidthsMm.${name}`, { key }, raw => {
      const str = String(scalar(raw) ?? '').trim();
      if (str.endsWith('%')) {
        const p = numberValue(str, { min: 1, max: 1000, percent: true });
        return p === null ? null : values.nozzleDiameterMm * p / 100;
      }
      // Zero means auto in slicers, not a bead with zero width. Use the pinned
      // profile width and record that this is a fallback, not an exact path.
      return numberValue(raw, { min: 0, max: 10, positive: true });
    });
  }
  values.filamentAssignments = {};
  for (const [name, key] of Object.entries(TOOL_FIELDS)) {
    values.filamentAssignments[name] = read(`filamentAssignments.${name}`, { key, aliases: name === 'solidInfill' ? ['sparse_infill_filament'] : [] }, raw => {
      const tool = numberValue(raw, { min: 0, max: 65536, integer: true });
      return tool === null ? null : tool === 0 ? 'inherit' : tool - 1;
    });
    if (values.filamentAssignments[name] === 'inherit') values.filamentAssignments[name] = null;
  }
  let objectExtruder = 0;
  for (const layer of layers) {
    const value = numberValue(layer.values.extruder, { min: 0, max: 65536, integer: true });
    if (value > 0) objectExtruder = value - 1;
  }
  values.objectExtruder = objectExtruder;
  values.resolvedFilamentAssignments = Object.fromEntries(Object.entries(values.filamentAssignments).map(([key, tool]) => [key, tool ?? values.objectExtruder]));
  values.minimumTopShellLayers = Math.max(values.topShellLayers, Math.ceil(values.topShellThicknessMm / values.layerHeightMm - 1e-9));
  values.minimumBottomShellLayers = Math.max(values.bottomShellLayers, Math.ceil(values.bottomShellThicknessMm / values.layerHeightMm - 1e-9));
  return { ...values, fields, warnings, usesFallback: Object.values(fields).some(field => ['bambu-default','studio-default'].includes(field.source)) };
}

/** Settings describe intent; actual G-code is authoritative for per-layer
 * geometry, painted colors, modifier volumes, shell transitions and Arachne. */
export function normalizeSliceSettings(project = {}, { preset = 'h2c', objects = new Map(), source = 'project' } = {}) {
  if (!own(PROFILE_NAMES, preset)) preset = DEFAULT_BAMBU_PRINTER_MODEL_ID;
  const printerModel=getBambuPrinterModel(preset);
  const raw = parseSliceSettingsText(project);
  const layers = [{ source, values: raw }];
  const base = normalizeLayers(layers, preset);
  const colors = arrayValue(raw.filament_colour ?? raw.filament_color ?? raw.extruder_colour ?? raw.extruder_color).map(color);
  const types = arrayValue(raw.filament_type);
  const filaments = colors.map((value, tool) => ({ tool, color: value, type: String(types[tool] ?? types[0] ?? ''), source }));
  const overrides = [];
  const iterable = objects instanceof Map ? objects.entries() : Object.entries(objects || {});
  for (const [objectId, object] of iterable) {
    const objectLayers = [...layers, { source: 'object', objectId: String(objectId), values: object }];
    const objectSettings = normalizeLayers(objectLayers, preset);
    const parts = [];
    const partIterable = object.parts instanceof Map ? object.parts.entries() : Object.entries(object.parts || {});
    for (const [partId, part] of partIterable) {
      parts.push({ partId: String(partId), subtype: part.subtype || 'normal_part',
        settings: normalizeLayers([...objectLayers, { source: 'part', objectId: String(objectId), partId: String(partId), values: part }], preset) });
    }
    overrides.push({ objectId: String(objectId), settings: objectSettings, parts });
  }
  return { ...base, schemaVersion: 1, preset, sourceType: source, profileName: String(raw.print_settings_id || `Growth Studio ${base.layerHeightMm}mm @BBL ${printerModel.displayName}`),
    printerName: String(raw.printer_model || raw.printer_settings_id || printerModel.machineProfile),
    fallbackProfile: { name: PROFILE_NAMES[preset], version: BAMBU_DEFAULT_VERSION, commit: BAMBU_DEFAULT_COMMIT, nozzleDiameterMm: 0.4,
      parameterOverrides: base.fields.layerHeightMm.source === 'studio-default' ? { layer_height: { value: String(DEFAULT_LAYER_HEIGHT_MM), source: 'studio-default', defaultPolicy: DEFAULT_LAYER_HEIGHT_POLICY } } : {} },
    filaments, overrides, exactToolpaths: false, colorResolution: 'slice-required' };
}

export function defaultSliceSettings(preset = 'h2c') { return normalizeSliceSettings({}, { preset }); }

export function resolveSliceSettingsForPart(settings, objectId, partId) {
  const object = settings.overrides.find(item => item.objectId === String(objectId));
  if (!object) return settings;
  return object.parts.find(item => item.partId === String(partId))?.settings || object.settings;
}

/** Parse only a CONFIG_BLOCK when present. This avoids treating arbitrary
 * executable machine commands or later role comments as configuration. */
export function parseGCodeSliceSettings(text, options = {}) {
  if (typeof text !== 'string') throw new Error('切片 G-code 必须为文字。');
  const block = text.match(/;\s*CONFIG_BLOCK_START\s*\r?\n([\s\S]*?);\s*CONFIG_BLOCK_END/i);
  const normalized = normalizeSliceSettings(parseSliceSettingsText(block?.[1] ?? text), { ...options, source: 'gcode-config' });
  normalized.exactToolpaths = false;
  return normalized;
}
