// Transpose a whole song (every pattern) on chosen channels, staying within what each channel can play.

import { CHANNELS, type Song } from '../model/types';
import { fitToChannel } from './hardware';

const HIGHEST = 108; // top of the piano roll (C8)

/** Where a transposed pitch ends up on a channel: moved by whole octaves if it would fall out of range. */
function landOn(pitch: number, channel: number, song: Song): number {
  if (CHANNELS[channel].kind === 'noise') return Math.max(0, Math.min(15, pitch));
  let p = fitToChannel(pitch, channel, song.region);
  while (p > HIGHEST) p -= 12;
  return p;
}

export interface TransposeResult {
  moved: number;
  /** Notes that had to shift by an octave (or clamp, for noise) to stay playable. */
  adjusted: number;
}

/** Count what a transpose would do, without changing anything. */
export function previewTranspose(song: Song, semitones: number, channels: number[]): TransposeResult {
  let moved = 0, adjusted = 0;
  for (const p of song.patterns) {
    for (const ch of channels) {
      if (CHANNELS[ch].kind === 'dmc') continue;
      for (const n of p.notes[ch]) {
        moved++;
        if (landOn(n.pitch + semitones, ch, song) !== n.pitch + semitones) adjusted++;
      }
    }
  }
  return { moved, adjusted };
}

/** Shift every note on the chosen channels (in all patterns) and their step notes. Mutates `song` (an immer draft). */
export function transposeSong(song: Song, semitones: number, channels: number[]): TransposeResult {
  const result = previewTranspose(song, semitones, channels);
  for (const ch of channels) {
    if (CHANNELS[ch].kind === 'dmc') continue;
    for (const p of song.patterns) for (const n of p.notes[ch]) n.pitch = landOn(n.pitch + semitones, ch, song);
    song.channels[ch].stepPitch = landOn(song.channels[ch].stepPitch + semitones, ch, song);
  }
  return result;
}
