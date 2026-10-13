// Snap note starts and/or ends to a grid.

import { patternLength, type Note, type Song } from '../model/types';
import { resolveOverlaps } from './hardware';

export type QuantizeWhat = 'start' | 'end' | 'both';
export type QuantizeScope = 'selection' | 'channel' | 'pattern' | 'song';

const snap = (t: number, grid: number) => Math.round(t / grid) * grid;

/**
 * Quantise notes in place. 'start' moves a note so it starts on the grid (keeping its length);
 * 'end' changes its length so it ends on the grid; 'both' does both. Returns how many notes changed.
 */
export function quantizeNotes(notes: Note[], grid: number, what: QuantizeWhat, patternTicks: number, only?: Set<string>): number {
  let changed = 0;
  for (const n of notes) {
    if (only && !only.has(n.id)) continue;
    const start0 = n.tick;
    const end0 = n.tick + n.length;
    let start = what === 'end' ? start0 : snap(start0, grid);
    start = Math.max(0, Math.min(start, patternTicks - grid));
    let end = what === 'start' ? start + n.length : snap(end0, grid);
    if (end <= start) end = start + grid;
    if (start !== start0 || end - start !== n.length) changed++;
    n.tick = start;
    n.length = end - start;
  }
  return changed;
}

/** Quantise a whole scope of a song (an immer draft). Overlaps created by snapping are resolved afterwards. */
export function quantizeSong(
  song: Song,
  scope: QuantizeScope,
  opts: { grid: number; what: QuantizeWhat; patternId: string; channel: number; selected: Set<string> },
): number {
  let changed = 0;
  const patterns = scope === 'song' ? song.patterns : song.patterns.filter((p) => p.id === opts.patternId);
  for (const p of patterns) {
    const plen = patternLength(song, p);
    const channels = scope === 'selection' || scope === 'channel' ? [opts.channel] : p.notes.map((_, ch) => ch);
    for (const ch of channels) {
      const only = scope === 'selection' ? opts.selected : undefined;
      const n = quantizeNotes(p.notes[ch], opts.grid, opts.what, plen, only);
      if (n) {
        changed += n;
        p.notes[ch] = resolveOverlaps(p.notes[ch], ch, only ?? new Set());
      }
    }
  }
  return changed;
}
