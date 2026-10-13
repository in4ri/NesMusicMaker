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
  { index: 0, name: 'Pulse 1', short: 'P1', kind: 'pulse', color: '#ff6b6b' },
  { index: 1, name: 'Pulse 2', short: 'P2', kind: 'pulse', color: '#ffa94d' },
  { index: 2, name: 'Triangle', short: 'TRI', kind: 'triangle', color: '#69db7c' },
  { index: 3, name: 'Noise', short: 'NOI', kind: 'noise', color: '#74c0fc' },
  { index: 4, name: 'DMC', short: 'DMC', kind: 'dmc', color: '#da77f2' },
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

export interface NoteFx {
  glide?: number;        // frames to glide from the previous note's pitch (legato)
  bend?: number;         // semitones to bend over the length of the note
  vibratoDepth?: number; // 0..15, 1/8 semitone units
  vibratoSpeed?: number; // 0..15
  arp?: number[];        // chord offsets cycled each frame, e.g. [0, 4, 7]
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

export interface ChannelSettings {
  /** Default pitch for notes created from the step sequencer. */
  stepPitch: number;
  /** Default instrument for new notes on this channel. */
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
