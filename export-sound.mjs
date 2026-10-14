import path from 'node:path';
import { soundEffect } from './src/sound-effects.js';

export function normalizeExportSound(options, duration) {
  const id = options.soundEffect || 'none';
  if (id !== 'none' && !soundEffect(id)) throw new Error('请选择有效的音效。');
  const volume = options.soundVolume ?? 1;
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error('音效音量无效。');
  return { soundEffect: id, soundVolume: volume };
}

export function soundMuxArguments({ root, input, output, options, hasAudio = false }) {
  const effect = soundEffect(options.soundEffect);
  if (!effect) throw new Error('未知音效。');
  const duration = options.frames / options.fps;
  const fade = Math.min(.15, duration / 2);
  const soundFilter = `volume=${options.soundVolume},apad,atrim=duration=${duration},afade=t=out:st=${Math.max(0,duration-fade)}:d=${fade}`;
  return [
    '-hide_banner','-loglevel','error','-nostdin','-y','-i',input,
    '-i',path.join(root,'assets','sounds',effect.file),
    '-filter_complex',hasAudio ? `[1:a]${soundFilter}[sfx];[0:a][sfx]amix=inputs=2:duration=longest,alimiter=limit=0.95[a]` : `[1:a]${soundFilter}[a]`,
    '-map','0:v:0','-map','[a]','-c:v','copy','-c:a','aac','-t',String(duration),
    ...(options.format === 'mp4' ? ['-movflags','+faststart','-f','mp4'] : ['-f','mov']),output,
  ];
}
