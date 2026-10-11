/** FBX declares centimetres per file unit; glTF declares metres. Other plain
 * mesh formats need an explicit/user-confirmable estimate, never resampling.
 */
export function modelSourceUnits(format, root) {
  if (format === 'glb' || format === 'gltf') return { sourceUnitsToMm: 1000, sourceUnitsInferred: false };
  if (format === 'fbx') {
    const declared = root?.userData?.unitScaleFactor;
    const value = Number(declared);
    if (declared != null && Number.isFinite(value) && value > 0 && value <= 100000) return { sourceUnitsToMm: value * 10, sourceUnitsInferred: false };
  }
  return { sourceUnitsToMm: 1, sourceUnitsInferred: ['obj','fbx','stl'].includes(format) };
}

export function millimetresToWorld(worldPerSourceUnit, sourceUnitsToMm = 1) {
  if (![worldPerSourceUnit, sourceUnitsToMm].every(value => Number.isFinite(value) && value > 0)) throw new Error('模型长度单位无效。');
  return worldPerSourceUnit / sourceUnitsToMm;
}
