import type { CompiledSong } from './compiler';
import { SongPlayer } from './player';
import { REGIONS } from './tables';

export interface WavOptions {
  sampleRate?: number;
  /** Extra times to play the looped section after the first play-through. */
  loops?: number;
  /** Fade the final loop out (seconds). */
  fadeSeconds?: number;
}

/** Render a compiled song offline and encode it as a 16-bit mono WAV file. */
export function renderWav(song: CompiledSong, opts: WavOptions = {}): Uint8Array {
  const sampleRate = opts.sampleRate ?? 44100;
  const loops = song.loopFrame >= 0 ? (opts.loops ?? 0) : 0;
  const frameRate = REGIONS[song.region].frameRate;
  const loopLen = song.loopFrame >= 0 ? song.frameCount - song.loopFrame : 0;
  const totalFrames = song.frameCount + loops * loopLen;
  const tail = loops > 0 ? 0 : 1; // let releases ring out when not looping
  const length = Math.ceil(((totalFrames / frameRate) + tail) * sampleRate);

  const player = new SongPlayer(sampleRate);
  player.update(song);
  player.start(0);
  const pcm = new Float32Array(length);
  const playSamples = Math.min(length, Math.round((totalFrames / frameRate) * sampleRate));
  player.render(pcm, 0, playSamples);
  player.stop();
  if (length > playSamples) player.render(pcm, playSamples, length - playSamples);

  const fade = loops > 0 ? Math.min(length, Math.round((opts.fadeSeconds ?? 3) * sampleRate)) : 0;
  for (let i = 0; i < fade; i++) pcm[length - fade + i] *= 1 - i / fade;

  return encodeWav(pcm, sampleRate);
}

export function encodeWav(pcm: Float32Array, sampleRate: number): Uint8Array {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return new Uint8Array(buf);
}
