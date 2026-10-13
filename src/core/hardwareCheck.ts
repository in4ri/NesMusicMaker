// "Will this play on a real NES as drawn?" — lists problems, most with an automatic fix.

import { CHANNELS, patternLength, type Song } from '../model/types';
import { sortedLanePoints } from './automation';
import { compileSong } from './compiler';
import { layoutDmc } from './dmc';
import { clipConflicts, countOverlaps, lowestPitch, resolveOverlaps } from './hardware';
import { encodeStream } from './nsf';
import { noteName, REGIONS } from './tables';

export interface HardwareIssue {
  key: string;
  severity: 'error' | 'warning';
  title: string;
  detail: string;
  /** Mutates a draft of the song to fix the problem. */
  fix?: { label: string; apply: (song: Song) => void };
}

export function checkSong(song: Song): HardwareIssue[] {
  const issues: HardwareIssue[] = [];
  const name = (ch: number) => CHANNELS[ch].name;

  for (const p of song.patterns) {
    const plen = patternLength(song, p);
    p.notes.forEach((notes, ch) => {
      const overlaps = countOverlaps(notes);
      if (overlaps) {
        issues.push({
          key: `overlap:${p.id}:${ch}`,
          severity: 'error',
          title: `${overlaps} overlapping note${overlaps > 1 ? 's' : ''} in "${p.name}" › ${name(ch)}`,
          detail: 'A channel plays one note at a time, so a note is cut off when the next one starts.',
          fix: {
            label: 'Trim overlaps',
            apply: (s) => {
              const pp = s.patterns.find((x) => x.id === p.id)!;
              pp.notes[ch] = resolveOverlaps(pp.notes[ch], ch);
            },
          },
        });
      }

      const past = notes.filter((n) => n.tick >= plen).length;
      if (past) {
        issues.push({
          key: `past:${p.id}:${ch}`,
          severity: 'error',
          title: `${past} note${past > 1 ? 's' : ''} past the end of "${p.name}" › ${name(ch)}`,
          detail: `They start after the pattern's ${p.bars} bar${p.bars > 1 ? 's' : ''} and never play.`,
          fix: {
            label: 'Delete them',
            apply: (s) => {
              const pp = s.patterns.find((x) => x.id === p.id)!;
              pp.notes[ch] = pp.notes[ch].filter((n) => n.tick < plen);
            },
          },
        });
      }

      if (CHANNELS[ch].kind === 'pulse') {
        const lo = lowestPitch(ch, song.region);
        const low = notes.filter((n) => n.pitch < lo).length;
        if (low) {
          issues.push({
            key: `low:${p.id}:${ch}`,
            severity: 'error',
            title: `${low} note${low > 1 ? 's' : ''} below ${noteName(lo)} in "${p.name}" › ${name(ch)}`,
            detail: `The pulse channels can't play lower than ${noteName(lo)} (the triangle can).`,
            fix: {
              label: 'Move up an octave',
              apply: (s) => {
                const pp = s.patterns.find((x) => x.id === p.id)!;
                for (const n of pp.notes[ch]) while (n.pitch < lo) n.pitch += 12;
              },
            },
          });
        }

        // Effects that bend the pitch below the range (arpeggios, bends, vibrato, instrument envelopes, detune).
        const detuneMin = Math.min(0, ...sortedLanePoints(song, ch, 'detune').map((pt) => pt.value)) / 100;
        const dips = notes.filter((n) => {
          if (n.pitch < lo) return false;
          const inst = song.instruments.find((i) => i.id === (n.instrument || song.channels[ch].instrument));
          const offsets = [
            0,
            ...(n.fx.arp ?? []),
            n.fx.bend ?? 0,
            -((n.fx.vibratoDepth ?? 0) / 8),
            ...(inst?.arpeggio.values ?? []),
            ...(inst?.pitch.values ?? []).map((v) => v / 16),
          ];
          return n.pitch + Math.min(...offsets) + detuneMin < lo - 0.5;
        }).length;
        if (dips) {
          issues.push({
            key: `dip:${p.id}:${ch}`,
            severity: 'warning',
            title: `${dips} note${dips > 1 ? 's' : ''} in "${p.name}" › ${name(ch)} may dip below ${noteName(lo)}`,
            detail: 'Their arpeggio, bend, vibrato or instrument pitch goes lower than the pulse channel can play; those moments will sound at the lowest note.',
          });
        }
      }

      if (CHANNELS[ch].kind === 'dmc') {
        const missing = notes.filter((n) => n.pitch >= song.samples.length).length;
        if (missing) {
          issues.push({
            key: `nosample:${p.id}`,
            severity: 'error',
            title: `${missing} DMC note${missing > 1 ? 's' : ''} in "${p.name}" use a sample that no longer exists`,
            detail: 'They are silent.',
            fix: {
              label: 'Delete them',
              apply: (s) => {
                const pp = s.patterns.find((x) => x.id === p.id)!;
                pp.notes[4] = pp.notes[4].filter((n) => n.pitch < s.samples.length);
              },
            },
          });
        }
      }
    });
  }

  for (const c of clipConflicts(song)) {
    const bar = song.beatsPerBar * 48;
    issues.push({
      key: `clips:${c.clips.join(':')}`,
      severity: 'error',
      title: `Playlist clips overlap on ${c.channels.map(name).join(', ')} (bar ${Math.floor(c.start / bar) + 1})`,
      detail: 'Two clips play the same channel at the same time; only the most recent note can sound. Move one clip or clear that channel in one pattern.',
    });
  }

  const layout = layoutDmc(song.samples);
  const dropped = layout.entries.map((e, i) => (e ? null : song.samples[i].name)).filter(Boolean);
  if (dropped.length) {
    issues.push({
      key: 'dmc-memory',
      severity: 'error',
      title: `${dropped.length} sample${dropped.length > 1 ? 's' : ''} don't fit in the 16 KB of DMC memory`,
      detail: `${dropped.join(', ')} won't play. Remove samples or re-import them shorter.`,
    });
  }

  return issues;
}

/** Facts about the exported result (not problems). */
export function exportSummary(song: Song) {
  const compiled = compileSong(song, { mode: 'song' });
  const seconds = compiled.frameCount / REGIONS[song.region].frameRate;
  const nsfBytes = 0x80 + 0x1000 * (1 + Math.ceil(encodeStream(compiled).length / 0x1000) + Math.ceil(layoutDmc(song.samples).used / 0x1000));
  return { seconds, nsfBytes, region: song.region };
}
