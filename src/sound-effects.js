export const SOUND_EFFECTS = [
  { id: 'reference', label: '参考视频 · 原声', file: 'reference-original.wav' },
];
export function soundEffect(id) { return SOUND_EFFECTS.find(effect => effect.id === id); }
export function soundUrl(effect) { return '/assets/sounds/' + effect.file; }
export const CUSTOM_SOUND_LIMIT = 50 * 1024 * 1024;
export const CUSTOM_SOUND_DURATION = 600;
export function validateCustomSound(file) {
  if (!(file instanceof Blob) || !file.size) throw new Error('请选择有声音的音频文件。');
  if (file.size > CUSTOM_SOUND_LIMIT) throw new Error('自定义音效不能超过 50 MiB。');
  if (!/\.(wav|mp3|m4a|aac|ogg|flac)$/i.test(file.name || '')
      && !/^audio\/(?:wav|x-wav|wave|mpeg|mp3|mp4|aac|ogg|flac|x-flac)$/i.test(file.type || '')) {
    throw new Error('请选择 WAV、MP3、M4A、AAC、OGG 或 FLAC 音频。');
  }
  return file;
}
