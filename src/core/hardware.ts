// What the NES can and can't play, and helpers that keep the editor within those limits.

import { CHANNELS, patternLength, type Note, type Song } from '../model/types';
import { REGIONS, midiToFreq, type Region } from './tables';

/** Lowest MIDI note a channel can actually play (the pulse timer can't count high enough for lower notes). */
export function lowestPitch(channel: number, region: Region): number {
  const kind = CHANNELS[channel].kind;
  if (kind !== 'pulse' && kind !== 'triangle') return 0;
  const div = kind === 'pulse' ? 16 : 32;
  let p = kind === 'pulse' ? 24 : 12;
  while (Math.round(REGIONS[region].cpuClock / (div * midiToFreq(p))) - 1 > 0x7ff) p++;
  return p;
}

/** Move a pitch up whole octaves until the channel can play it. */
export function fitToChannel(pitch: number, channel: number, region: Region): number {
  const lo = lowestPitch(channel, region);
  while (pitch < lo) pitch += 12;
  return pitch;
}

export type OverlapMode = 'replace' | 'chord';

/**
 * Make a channel's notes play exactly as drawn on a one-note-at-a-time channel: a note is shortened where
 * the next one starts. Notes starting together either collapse to one (preferring `prefer` ids, then the
 * most recently added) or, in 'chord' mode on pulse/triangle, merge into one arpeggio note.
 * Works on immer drafts: returns the list to assign back.
 */
export function resolveOverlaps(notes: Note[], channel: number, prefer: Set<string> = new Set(), mode: OverlapMode = 'replace'): Note[] {
  const pitched = CHANNELS[channel].kind === 'pulse' || CHANNELS[channel].kind === 'triangle';
  // Stable sort keeps insertion order for equal ticks; preferred notes sort last so they win.
  const sorted = [...notes].sort((a, b) => a.tick - b.tick || Number(prefer.has(a.id)) - Number(prefer.has(b.id)));
  const kept: Note[] = [];
  for (const n of sorted) {
    const last = kept[kept.length - 1];
    if (!last || last.tick !== n.tick) {
      kept.push(n);
      continue;
    }
    if (mode === 'chord' && pitched) {
      // Merge into the existing note as an arpeggio chord.
      const pitches = new Set([last.pitch, ...(last.fx.arp ?? []).map((o) => last.pitch + o), n.pitch, ...(n.fx.arp ?? []).map((o) => n.pitch + o)]);
      const sortedPitches = [...pitches].sort((a, b) => a - b);
      const root = sortedPitches[0];
      last.pitch = root;
      last.length = Math.max(last.length, n.length);
      if (sortedPitches.length > 1) last.fx.arp = sortedPitches.map((p) => p - root).slice(0, 8);
    } else {
      kept[kept.length - 1] = n;
    }
  }
  for (let i = 0; i < kept.length - 1; i++) {
    const a = kept[i];
    const next = kept[i + 1].tick;
    if (a.tick + a.length > next) a.length = next - a.tick;
  }
  return kept;
}

/** Number of notes that would be shortened or dropped by resolveOverlaps. */
export function countOverlaps(notes: Note[]): number {
  const sorted = [...notes].sort((a, b) => a.tick - b.tick);
  let n = 0;
  for (let i = 0; i < sorted.length - 1; i++) if (sorted[i].tick + sorted[i].length > sorted[i + 1].tick) n++;
  return n;
}

export interface ClipConflict {
  clips: [string, string];
  start: number;
  end: number;
  channels: number[];
}

/** Playlist clips that play the same channel at the same time (only one note per channel can sound). */
export function clipConflicts(song: Song): ClipConflict[] {
  const placed = song.playlist
    .map((c) => {
      const p = song.patterns.find((x) => x.id === c.pattern);
      return p ? { clip: c, pattern: p, end: c.start + patternLength(song, p) } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  const out: ClipConflict[] = [];
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i], b = placed[j];
      const start = Math.max(a.clip.start, b.clip.start);
      const end = Math.min(a.end, b.end);
      if (start >= end) continue;
      const sounds = (x: typeof a, ch: number) =>
        x.pattern.notes[ch].some((n) => {
          const s = x.clip.start + n.tick;
          return s < end && s + n.length > start && n.tick < patternLength(song, x.pattern);
        });
      const channels = CHANNELS.map((c) => c.index).filter((ch) => sounds(a, ch) && sounds(b, ch));
      if (channels.length) out.push({ clips: [a.clip.id, b.clip.id], start, end, channels });
    }
  }
  return out;
}
