import fs from 'node:fs/promises';
import path from 'node:path';

// Synthetic profiles for staging tests; no locally installed slicer is needed.
export async function createSlicerProfiles(directory) {
  const root = path.join(directory, 'mock-bambu-resources', 'profiles');
  for (const type of ['machine', 'process', 'filament']) await fs.mkdir(path.join(root, 'BBL', type), { recursive: true });
  const presets = {
    h2c: ['Bambu Lab H2C 0.4 nozzle', '0.20mm Standard @BBL H2C', 'Generic PLA @BBL H2C 0.4 nozzle'],
    p1s: ['Bambu Lab P1S 0.4 nozzle', '0.20mm Standard @BBL X1C', 'Bambu PLA Basic @BBL P1S 0.4 nozzle'],
    a1: ['Bambu Lab A1 0.4 nozzle', '0.20mm Standard @BBL A1', 'Generic PLA @BBL A1'],
  };
  for (const [preset, [machine, process, filament]] of Object.entries(presets)) {
    const values = {
      machine: { name: machine, type: 'machine', printer_model: machine.replace(' 0.4 nozzle', ''), nozzle_diameter: ['0.4'], default_print_profile: process, printable_height: preset === 'h2c' ? '320' : '256' },
      process: { name: process, type: 'process', layer_height: '0.2', initial_layer_print_height: '0.2', wall_loops: '2', enable_support: '0' },
      filament: { name: filament, type: 'filament', filament_type: ['PLA'], nozzle_temperature: ['220'] },
    };
    for (const [type, name] of [['machine', machine], ['process', process], ['filament', filament]]) await fs.writeFile(path.join(root, 'BBL', type, name + '.json'), JSON.stringify(values[type]));
  }
  return root;
}
