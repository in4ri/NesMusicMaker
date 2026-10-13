// Turns a parsed MIDI file into NES patterns. Each NES channel plays one note
// at a time, so chords are reduced to their highest (melody) or lowest (bass) note.

import { emptyPattern, makeNote } from '../model/defaults';
import { CHANNELS, PPQ, newId, type ArpStyle, type Clip, type Note, type NoteFx, type Pattern, type Song } from '../model/types';
import { songEndTick } from './compiler';
import type { MidiFile, MidiNote } from './midi';

export interface MidiSource {
  key: string;
  name: string;
  channel: number; // MIDI channel 0..15
  notes: MidiNote[];
  low: number;
  high: number;
  average: number;
  isDrums: boolean;
  /** Fraction of note onsets that are chords (2+ notes starting together). */
  chordRatio: number;
}

/** How a polyphonic part is squeezed onto a one-note-at-a-time NES channel. */
export type Polyphony = 'highest' | 'lowest' | 'arpeggio';

export interface SourceMapping {
  /** NES channel index, or -1 to ignore. DMC is not a target. */
  target: number;
  polyphony: Polyphony;
  instrument: string;
}

export interface MidiImportOptions {
  quantize: number; // ticks (1 = off)
  barsPerPattern: number;
  useVelocity: boolean;
  useTempo: boolean;
  placement: 'append' | 'replace';
  name: string;
  /** Style and speed given to chords imported as arpeggios (editable per note afterwards). */
  arpStyle: ArpStyle;
  arpSpeed: number;
}

export interface MidiImportResult {
  patterns: Pattern[];
  clips: Clip[];
  bpm: number;
  beatsPerBar: number;
  replace: boolean;
  droppedNotes: number;
}

/** General MIDI drum notes → noise pitch + a default instrument name. */
const GM_DRUMS: Record<number, [number, string]> = {
  35: [6, 'Noise Kick'], 36: [6, 'Noise Kick'],
  37: [11, 'Noise Snare'], 38: [9, 'Noise Snare'], 39: [10, 'Noise Snare'], 40: [9, 'Noise Snare'],
  41: [5, 'Noise Snare'], 43: [5, 'Noise Snare'], 45: [7, 'Noise Snare'], 47: [7, 'Noise Snare'], 48: [8, 'Noise Snare'], 50: [8, 'Noise Snare'],
  42: [15, 'Closed Hat'], 44: [15, 'Closed Hat'], 46: [15, 'Open Hat'],
  49: [13, 'Open Hat'], 52: [13, 'Open Hat'], 55: [13, 'Open Hat'], 57: [13, 'Open Hat'],
  51: [14, 'Closed Hat'], 53: [14, 'Closed Hat'], 59: [14, 'Closed Hat'],
};

/** Split tracks by MIDI channel into importable sources. */
export function midiSources(file: MidiFile): MidiSource[] {
  const out: MidiSource[] = [];
  file.tracks.forEach((track, ti) => {
    const byChannel = new Map<number, MidiNote[]>();
    for (const n of track.notes) {
      if (!byChannel.has(n.channel)) byChannel.set(n.channel, []);
      byChannel.get(n.channel)!.push(n);
    }
    for (const [channel, notes] of byChannel) {
      const pitches = notes.map((n) => n.pitch);
      const isDrums = channel === 9;
      const onsets = new Map<number, number>();
      for (const n of notes) onsets.set(n.tick, (onsets.get(n.tick) ?? 0) + 1);
      const chords = [...onsets.values()].filter((c) => c > 1).length;
      const base = track.name || `Track ${ti + 1}`;
      out.push({
        key: `${ti}:${channel}`,
        name: byChannel.size > 1 ? `${base} (ch ${channel + 1})` : base,
        channel,
        notes,
        low: Math.min(...pitches),
        high: Math.max(...pitches),
        average: pitches.reduce((a, b) => a + b, 0) / pitches.length,
        isDrums,
        chordRatio: onsets.size ? chords / onsets.size : 0,
      });
    }
  });
  return out;
}

/** Guess a sensible NES channel for each source: drums → noise, lowest part → triangle, top parts → pulses. */
export function suggestMappings(sources: MidiSource[], song: Song): SourceMapping[] {
  const mappings: SourceMapping[] = sources.map(() => ({ target: -1, polyphony: 'highest', instrument: '' }));
  const assign = (i: number, target: number) => {
    const chordy = sources[i].chordRatio >= 0.25;
    const polyphony: Polyphony = target === 2 ? 'lowest' : chordy && target < 2 ? 'arpeggio' : 'highest';
    mappings[i] = { target, polyphony, instrument: song.channels[target].instrument };
  };
  const drums = sources.findIndex((s) => s.isDrums);
  if (drums >= 0) assign(drums, 3);
  const melodic = sources.map((s, i) => ({ s, i })).filter((x) => !x.s.isDrums && x.s.notes.length);
  melodic.sort((a, b) => a.s.average - b.s.average);
  if (melodic.length >= 2 && melodic[0].s.average < 60) assign(melodic.shift()!.i, 2);
  melodic.sort((a, b) => b.s.average - a.s.average || b.s.notes.length - a.s.notes.length);
  if (melodic[0]) assign(melodic[0].i, 0);
  if (melodic[1]) assign(melodic[1].i, 1);
  return mappings;
}

function fitPitch(pitch: number, target: number): number {
  const kind = CHANNELS[target].kind;
  if (kind === 'noise') return ((pitch % 16) + 16) % 16;
  const lo = kind === 'triangle' ? 21 : 33; // lowest note the hardware period can reach
  while (pitch < lo) pitch += 12;
  while (pitch > 108) pitch -= 12;
  return pitch;
}

interface Candidate {
  tick: number;
  length: number;
  pitch: number;
  velocity: number;
  volume: number;
  instrument: string;
  priority: number; // higher wins when notes start together
  arp?: number[];
}

/** Collapse notes that start together into one root note carrying the chord as arpeggio offsets. */
function chordsToArpeggios(list: Candidate[]): Candidate[] {
  const byTick = new Map<number, Candidate[]>();
  for (const c of list) {
    if (!byTick.has(c.tick)) byTick.set(c.tick, []);
    byTick.get(c.tick)!.push(c);
  }
  return [...byTick.values()].map((group) => {
    group.sort((a, b) => a.pitch - b.pitch);
    const root = group[0];
    const offsets = [...new Set(group.map((c) => c.pitch - root.pitch))].filter((o) => o <= 36).slice(0, 8);
    return {
      ...root,
      length: Math.max(...group.map((c) => c.length)),
      volume: Math.max(...group.map((c) => c.volume)),
      priority: 1000 + offsets.length, // a chord beats single notes from other parts
      arp: offsets.length > 1 ? offsets : undefined,
    };
  });
}

export function buildMidiImport(song: Song, file: MidiFile, sources: MidiSource[], mappings: SourceMapping[], opts: MidiImportOptions): MidiImportResult {
  const replace = opts.placement === 'replace';
  const bpm = opts.useTempo && file.bpm ? Math.max(30, Math.min(400, Math.round(file.bpm))) : song.bpm;
  let beatsPerBar = song.beatsPerBar;
  if (replace && opts.useTempo && file.timeSignature) {
    const [num, den] = file.timeSignature;
    beatsPerBar = Math.max(1, Math.min(16, Math.round((num * 4) / den)));
  }
  const scale = PPQ / file.ppq;
  const q = Math.max(1, Math.round(opts.quantize));
  const instByName = new Map(song.instruments.map((i) => [i.name, i.id]));
  let droppedNotes = 0;

  // Gather candidates per NES channel.
  const perChannel: Candidate[][] = CHANNELS.map(() => []);
  sources.forEach((src, si) => {
    const m = mappings[si];
    if (!m || m.target < 0 || m.target >= 4) return;
    const fromSource: Candidate[] = [];
    for (const n of src.notes) {
      let pitch = fitPitch(n.pitch, m.target);
      let instrument = m.instrument;
      if (CHANNELS[m.target].kind === 'noise' && src.isDrums) {
        const drum = GM_DRUMS[n.pitch];
        pitch = drum ? drum[0] : 12;
        instrument = (drum && instByName.get(drum[1])) || instrument;
      }
      const tick = Math.round((n.tick * scale) / q) * q;
      const length = Math.max(q, Math.round((n.length * scale) / q) * q);
      const volume = opts.useVelocity ? Math.max(1, Math.round((n.velocity / 127) * 15)) : 15;
      const priority = CHANNELS[m.target].kind === 'noise' ? n.velocity : m.polyphony === 'highest' ? n.pitch : -n.pitch;
      fromSource.push({ tick, length, pitch, velocity: n.velocity, volume, instrument: instrument || song.instruments[0]?.id || '', priority });
    }
    const arpeggiate = m.polyphony === 'arpeggio' && CHANNELS[m.target].kind !== 'noise';
    perChannel[m.target].push(...(arpeggiate ? chordsToArpeggios(fromSource) : fromSource));
  });

  // Make each channel monophonic: one note per start time, and a note ends when the next begins.
  const mono: Candidate[][] = perChannel.map((list) => {
    list.sort((a, b) => a.tick - b.tick || b.priority - a.priority);
    const out: Candidate[] = [];
    for (const c of list) {
      if (out.length && out[out.length - 1].tick === c.tick) {
        droppedNotes++;
        continue;
      }
      out.push({ ...c });
    }
    for (let i = 0; i < out.length - 1; i++) out[i].length = Math.min(out[i].length, out[i + 1].tick - out[i].tick);
    return out;
  });

  // Slice into patterns, reusing identical ones.
  const patternTicks = opts.barsPerPattern * PPQ * beatsPerBar;
  const end = mono.reduce((m, list) => list.reduce((mm, c) => Math.max(mm, c.tick + c.length), m), 0);
  const segments = Math.ceil(end / patternTicks);
  const startTick = replace || !song.playlist.length ? 0 : songEndTick(song);
  const patterns: Pattern[] = [];
  const clips: Clip[] = [];
  const byContent = new Map<string, Pattern>();
  const firstColor = replace ? 0 : song.patterns.length;

  for (let k = 0; k < segments; k++) {
    const s0 = k * patternTicks;
    const s1 = s0 + patternTicks;
    const notes: Note[][] = mono.map((list) =>
      list
        .filter((c) => c.tick >= s0 && c.tick < s1)
        .map((c) => {
          const fx: NoteFx = c.arp ? { arp: c.arp, arpStyle: opts.arpStyle, arpSpeed: opts.arpSpeed } : {};
          return makeNote(c.tick - s0, Math.min(c.length, s1 - c.tick), c.pitch, c.instrument, c.volume, fx);
        }),
    );
    if (notes.every((l) => !l.length)) continue;
    const key = JSON.stringify(notes.map((l) => l.map((n) => [n.tick, n.length, n.pitch, n.volume, n.instrument, n.fx])));
    let pattern = byContent.get(key);
    if (!pattern) {
      pattern = emptyPattern(`${opts.name} ${patterns.length + 1}`, firstColor + patterns.length, opts.barsPerPattern);
      pattern.notes = notes;
      patterns.push(pattern);
      byContent.set(key, pattern);
    }
    clips.push({ id: newId('c'), pattern: pattern.id, track: 0, start: startTick + s0 });
  }

  return { patterns, clips, bpm, beatsPerBar, replace, droppedNotes };
}
