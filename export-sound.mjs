import path from 'node:path';
import { soundEffect } from './src/sound-effects.js';

export function normalizeExportSound(options, duration) {
  const id = options.soundEffect || 'none';
  if (!['none', 'custom'].includes(id) && !soundEffect(id)) throw new Error('请选择有效的音效。');
  const volume = options.soundVolume ?? 1;
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error('音效音量无效。');
  return { soundEffect: id, soundVolume: volume };
}

export function soundMuxArguments({ root, input, output, options, hasAudio = false, customSoundPath }) {
  const effect = soundEffect(options.soundEffect);
  if (options.soundEffect === 'custom' ? !customSoundPath : !effect) throw new Error('音效文件尚未准备完成。');
  const source = options.soundEffect === 'custom' ? customSoundPath : path.join(root, 'assets', 'sounds', effect.file);
  const duration = options.frames / options.fps;
  const fade = Math.min(.15, duration / 2);
  const soundFilter = `volume=${options.soundVolume},apad,atrim=duration=${duration},afade=t=out:st=${Math.max(0,duration-fade)}:d=${fade}`;
  return [
    '-hide_banner','-loglevel','error','-nostdin','-y','-i',input,
    '-i',source,
    '-filter_complex',hasAudio ? `[1:a]${soundFilter}[sfx];[0:a][sfx]amix=inputs=2:duration=longest,alimiter=limit=0.95[a]` : `[1:a]${soundFilter}[a]`,
    '-map','0:v:0','-map','[a]','-c:v','copy','-c:a','aac','-t',String(duration),
    ...(options.format === 'mp4' ? ['-movflags','+faststart','-f','mp4'] : ['-f','mov']),output,
  ];
}
