export const SOUND_EFFECTS = [
  { id: 'reference', label: '参考视频 · 原声', file: 'reference-original.wav' },
];
export function soundEffect(id) { return SOUND_EFFECTS.find(effect => effect.id === id); }
export function soundUrl(effect) { return '/assets/sounds/' + effect.file; }
