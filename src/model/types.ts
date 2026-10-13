import { PALETTE } from './palette';
import type { Region } from '../core/tables';

/** Pulses per quarter note. One 16th-note step = 12 ticks. */
export const PPQ = 48;
export const TICKS_PER_STEP = PPQ / 4;

export type ChannelKind = 'pulse' | 'triangle' | 'noise' | 'dmc';

export interface ChannelInfo {
  index: number;
  name: string;
  short: string;
  kind: ChannelKind;
  color: string;
}

export const CHANNELS: ChannelInfo[] = [
  { index: 0, name: 'Pulse 1', short: 'P1', kind: 'pulse', color: PALETTE.orange },
  { index: 1, name: 'Pulse 2', short: 'P2', kind: 'pulse', color: PALETTE.pink },
  { index: 2, name: 'Triangle', short: 'TRI', kind: 'triangle', color: PALETTE.green },
  { index: 3, name: 'Noise', short: 'NOI', kind: 'noise', color: PALETTE.blue },
  { index: 4, name: 'DMC', short: 'DMC', kind: 'dmc', color: PALETTE.cyan },
];

/**
 * A per-frame (60 Hz NTSC / 50 Hz PAL) sequence, FamiTracker style.
 * `loop` and `release` are indices into `values`, or -1 for none.
 * Before release: plays up to `release`-1 (looping from `loop` if set), then holds.
 * On note release: jumps to `release` and plays to the end, holding the last value.
 */
export interface Envelope {
  values: number[];
  loop: number;
  release: number;
}

export type EnvelopeKind = 'volume' | 'arpeggio' | 'pitch' | 'duty';

export interface Instrument {
  id: string;
  name: string;
  color: string;
  volume: Envelope;   // 0..15
  arpeggio: Envelope; // semitone offsets -24..24 (noise: period steps)
  pitch: Envelope;    // fine pitch offset in 1/16 semitones, -64..64
  duty: Envelope;     // 0..3 = 12.5/25/50/75%. Noise: odd = metallic mode
}

export interface DmcSample {
  id: string;
  name: string;
  /** Delta-modulated 1-bit sample bytes, base64, length is 16n+1. */
  data: string;
  rate: number; // 0..15
  loop: boolean;
  /** Value written to $4011 when the sample starts, or -1 to leave the DAC alone. */
  initialLevel: number;
}

export type ArpStyle = 'entered' | 'up' | 'down' | 'updown' | 'downup' | 'random';

export const ARP_STYLES: { value: ArpStyle; label: string }[] = [
  { value: 'entered', label: 'As entered' },
  { value: 'up', label: 'Up' },
  { value: 'down', label: 'Down' },
  { value: 'updown', label: 'Up-down' },
  { value: 'downup', label: 'Down-up' },
  { value: 'random', label: 'Random' },
];

export const CHORD_SHAPES: { name: string; arp: number[] }[] = [
  { name: 'Major', arp: [0, 4, 7] },
  { name: 'Minor', arp: [0, 3, 7] },
  { name: 'Major 7', arp: [0, 4, 7, 11] },
  { name: 'Minor 7', arp: [0, 3, 7, 10] },
  { name: 'Dominant 7', arp: [0, 4, 7, 10] },
  { name: 'Sus2', arp: [0, 2, 7] },
  { name: 'Sus4', arp: [0, 5, 7] },
  { name: 'Diminished', arp: [0, 3, 6] },
  { name: 'Augmented', arp: [0, 4, 8] },
  { name: 'Power (5th)', arp: [0, 7] },
  { name: 'Octave', arp: [0, 12] },
  { name: 'Major + octave', arp: [0, 4, 7, 12] },
  { name: 'Minor + octave', arp: [0, 3, 7, 12] },
];

/** The order chord offsets are played in for a given arpeggio style. */
export function arpSequence(arp: number[], style: ArpStyle = 'entered'): number[] {
  const up = [...arp].sort((a, b) => a - b);
  switch (style) {
    case 'up':
    case 'random':
      return up;
    case 'down':
      return up.reverse();
    case 'updown':
      return up.length < 3 ? up : [...up, ...up.slice(1, -1).reverse()];
    case 'downup': {
      const down = [...up].reverse();
      return down.length < 3 ? down : [...down, ...down.slice(1, -1).reverse()];
    }
    default:
      return arp;
  }
}

/** Chord offset at a given frame of a note. Random is deterministic so playback and exports match. */
export function arpOffsetAt(seq: number[], style: ArpStyle | undefined, speed: number | undefined, age: number): number {
  if (!seq.length) return 0;
  const step = Math.floor(age / Math.max(1, speed ?? 1));
  if (style === 'random') {
    let h = Math.imul(step + 1, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    return seq[((h ^ (h >>> 13)) >>> 0) % seq.length];
  }
  return seq[step % seq.length];
}

export interface NoteFx {
  glide?: number;        // frames to glide from the previous note's pitch (legato)
  bend?: number;         // semitones to bend over the length of the note
  vibratoDepth?: number; // 0..15, 1/8 semitone units
  vibratoSpeed?: number; // 0..15
  arp?: number[];        // chord offsets from the note's pitch, e.g. [0, 4, 7]
  arpStyle?: ArpStyle;   // order the chord is played in (default: as entered)
  arpSpeed?: number;     // frames per arpeggio step (default 1 = classic NES speed)
  delay?: number;        // frames to delay the note start
  cut?: number;          // frames after which the note is cut (0 = off)
  duty?: number;         // override instrument duty (0..3)
}

export interface Note {
  id: string;
  tick: number;
  length: number;
  /** MIDI pitch for pulse/triangle; 0..15 for noise (higher = higher pitch); sample index for DMC. */
  pitch: number;
  volume: number; // 0..15
  /** Instrument id for this note only, or '' to use the channel's sound (the normal case). */
  instrument: string;
  fx: NoteFx;
}

export interface Pattern {
  id: string;
  name: string;
  color: string;
  bars: number;
  /** Notes per channel, indexed by channel. */
  notes: Note[][];
}

export interface Clip {
  id: string;
  pattern: string;
  track: number;
  start: number; // tick
}

export interface AutomationPoint {
  id: string;
  tick: number;
  value: number; // volume 0..15, duty 0..3, detune in cents
}

export type AutomationParam = 'volume' | 'duty' | 'detune';

/** A song-timeline automation curve for one channel. Linear between points, flat before/after. */
export interface AutomationLane {
  channel: number;
  param: AutomationParam;
  points: AutomationPoint[];
}


export interface ChannelSettings {
  /** Pitch for notes created from the step sequencer. */
  stepPitch: number;
  /** The channel's sound: every note without its own instrument uses this. */
  instrument: string;
}

export interface Song {
  format: 'nes-music-maker';
  version: 1;
  title: string;
  author: string;
  copyright: string;
  bpm: number;
  region: Region;
  beatsPerBar: number;
  instruments: Instrument[];
  samples: DmcSample[];
  patterns: Pattern[];
  playlist: Clip[];
  /** Tick the song loops back to when it reaches the end. */
  loopStart: number;
  channels: ChannelSettings[];
  /** Song-mode automation lanes (applied in song playback and exports, not pattern mode). */
  automation: AutomationLane[];
  /** Exact end of the song in ticks (set by NSF import so it loops at the right moment). Ignored once a clip starts after it. */
  endTick?: number;
}

export const PLAYLIST_TRACKS = 8;

export function ticksPerBar(song: Song) {
  return PPQ * song.beatsPerBar;
}

export function patternLength(song: Song, pattern: Pattern) {
  return pattern.bars * ticksPerBar(song);
}

let idCounter = 0;
export function newId(prefix = ''): string {
  idCounter = (idCounter + 1) % 1e6;
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + idCounter.toString(36);
}
