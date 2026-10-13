// The "sound driver": turns a Song into a list of APU register writes per frame.
//
// Everything that makes sound goes through this: live playback, WAV export and
// NSF export all consume the same per-frame write list, so what you hear in
// the editor is exactly what the NES plays.

import {
  CHANNELS,
  PPQ,
  arpOffsetAt,
  arpSequence,
  patternLength,
  ticksPerBar,
  type Envelope,
  type Instrument,
  type Note,
  type Song,
} from '../model/types';
import { channelAutomation, modsAt, NO_MODS, type ChannelAutomation, type ChannelMods } from './automation';
import { layoutDmc, type DmcLayout } from './dmc';
import { REGIONS, pulsePeriod, trianglePeriod, type Region } from './tables';

/** Register writes ($40xx offsets) performed once before the first frame (the NSF INIT routine does the same). */
export const INIT_WRITES: ReadonlyArray<readonly [number, number]> = [
  [0x15, 0x0f],
  [0x17, 0x40],
  [0x00, 0x30], [0x01, 0x08], [0x02, 0x00], [0x03, 0xf8],
  [0x04, 0x30], [0x05, 0x08], [0x06, 0x00], [0x07, 0xf8],
  [0x08, 0x80], [0x0a, 0x00], [0x0b, 0xf8],
  [0x0c, 0x30], [0x0e, 0x00], [0x0f, 0xf8],
  [0x10, 0x00], [0x11, 0x00], [0x12, 0x00], [0x13, 0x00],
];

/** Registers whose value is tracked as per-frame state and written only when it changes. */
const STATE_REGS = [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x0a, 0x0b, 0x0c, 0x0e, 0x0f, 0x10, 0x12, 0x13];
const REG_COUNT = 0x18;

export interface CompiledSong {
  region: Region;
  frameCount: number;
  /** Frame to jump back to after the last frame, or -1 to stop. */
  loopFrame: number;
  framesPerTick: number;
  /** (reg, value) byte pairs for all frames, concatenated. */
  writes: Uint8Array;
  /** Byte offset into `writes` where each frame starts; length frameCount + 1. */
  frameIndex: Uint32Array;
  dmcMemory: Uint8Array;
}

export interface CompileOptions {
  mode: 'song' | 'pattern';
  patternId?: string;
}

interface NoteEvent {
  start: number; // frame
  end: number;   // frame (release)
  note: Note;
}

const DEFAULT_ENV: Record<'volume' | 'arpeggio' | 'pitch' | 'duty', number> = {
  volume: 15,
  arpeggio: 0,
  pitch: 0,
  duty: 2,
};

function envValue(env: Envelope, pos: number, fallback: number) {
  const n = env.values.length;
  if (n === 0) return fallback;
  return env.values[Math.min(pos, n - 1)];
}

/** Next position in an envelope, using FamiTracker-style loop/release semantics. */
function envAdvance(env: Envelope, pos: number, released: boolean) {
  const n = env.values.length;
  if (n === 0) return 0;
  const hasRelease = env.release > 0 && env.release < n;
  const end = !released && hasRelease ? env.release : n;
  const next = pos + 1;
  if (next < end) return next;
  const loopOk = env.loop >= 0 && env.loop < end && (!released || !hasRelease || env.loop >= env.release);
  if (loopOk) return env.loop;
  return end - 1;
}

class Voice {
  envPos = [0, 0, 0, 0]; // volume, arpeggio, pitch, duty
  noteAge = 0;
  released = false;
  glideFrom = 0;
  glideFrames = 0;
  lastPitch: number;
  readonly arpSeq: number[];

  constructor(public ev: NoteEvent, public inst: Instrument) {
    this.lastPitch = ev.note.pitch;
    this.arpSeq = ev.note.fx.arp?.length ? arpSequence(ev.note.fx.arp, ev.note.fx.arpStyle) : [];
  }

  release() {
    if (this.released) return;
    this.released = true;
    const envs = [this.inst.volume, this.inst.arpeggio, this.inst.pitch, this.inst.duty];
    envs.forEach((env, i) => {
      if (env.release > 0 && env.release < env.values.length) this.envPos[i] = env.release;
    });
  }

  /** Volume has finished (released with no release section, or released section ended on 0). */
  get finished() {
    if (!this.released) return false;
    const v = this.inst.volume;
    if (!(v.release > 0 && v.release < v.values.length)) return true;
    return this.envPos[0] >= v.values.length - 1 && envValue(v, this.envPos[0], 15) === 0;
  }

  step() {
    const { inst } = this;
    const envs = [inst.volume, inst.arpeggio, inst.pitch, inst.duty];
    for (let i = 0; i < 4; i++) this.envPos[i] = envAdvance(envs[i], this.envPos[i], this.released);
    this.noteAge++;
  }
}

interface FrameOutput {
  volume: number; // 0..15 (0 = silent)
  pitch: number;  // fractional MIDI pitch (noise: period index units)
  duty: number;
}

/** `mods` are the channel's automation values for this frame. */
function voiceOutput(v: Voice, mods: ChannelMods): FrameOutput {
  const scale = mods.volume;
  const { inst, ev } = v;
  const note = ev.note;
  const fx = note.fx;
  const envVol = envValue(inst.volume, v.envPos[0], DEFAULT_ENV.volume);
  const vol = envVol <= 0 || note.volume <= 0 || scale <= 0 ? 0 : Math.max(1, Math.round((envVol * note.volume * scale) / 225));

  let pitch = note.pitch + envValue(inst.arpeggio, v.envPos[1], 0);
  if (v.arpSeq.length) pitch += arpOffsetAt(v.arpSeq, fx.arpStyle, fx.arpSpeed, v.noteAge);
  pitch += envValue(inst.pitch, v.envPos[2], 0) / 16;
  pitch += mods.detune / 100;
  if (fx.vibratoDepth && fx.vibratoSpeed) {
    pitch += (Math.sin((2 * Math.PI * v.noteAge * fx.vibratoSpeed) / 64) * fx.vibratoDepth) / 8;
  }
  let bendOffset = 0;
  if (fx.bend) {
    bendOffset = fx.bend * Math.min(1, v.noteAge / Math.max(1, ev.end - ev.start));
    pitch += bendOffset;
  }
  if (v.glideFrames > 0 && v.noteAge < v.glideFrames) {
    pitch += (v.glideFrom - note.pitch) * (1 - v.noteAge / v.glideFrames);
  }
  v.lastPitch = note.pitch + bendOffset;

  // Most specific wins: the note's own duty, then duty automation, then the instrument envelope.
  const duty =
    fx.duty !== undefined && fx.duty >= 0 ? fx.duty : mods.duty >= 0 ? mods.duty : envValue(inst.duty, v.envPos[3], DEFAULT_ENV.duty);
  return { volume: vol, pitch, duty: duty & 3 };
}

interface ChannelContext {
  song: Song;
  region: Region;
  instruments: Map<string, Instrument>;
  fallbackInstrument: Instrument;
  dmc: DmcLayout;
}

/**
 * Simulate one channel over `frameCount` frames, writing its registers into `regs`
 * (frameCount * REG_COUNT, pre-filled with the carried-over state) and one-shot writes into `events`.
 */
function simulateChannel(
  ctx: ChannelContext,
  ch: number,
  evs: NoteEvent[],
  frameCount: number,
  regs: Uint8Array,
  events: [number, number][][],
  automation: ChannelAutomation | null,
) {
  const kind = CHANNELS[ch].kind;
  let evi = 0;
  let voice: Voice | null = null;
  let dmcLooping = false;

  for (let f = 0; f < frameCount; f++) {
    const r = f * REG_COUNT;
    if (f > 0) {
      // Carry the previous frame's state for this channel's registers.
      const prev = r - REG_COUNT;
      const base = kind === 'dmc' ? 0x10 : ch * 4;
      for (let i = 0; i < 4; i++) regs[r + base + i] = regs[prev + base + i];
    }

    while (evi < evs.length && evs[evi].start <= f) {
      const ev = evs[evi++];
      if (ev.start < f) continue;
      if (kind === 'dmc') {
        const sample = ctx.song.samples[ev.note.pitch];
        const entry = ctx.dmc.entries[ev.note.pitch];
        if (sample && entry) {
          regs[r + 0x10] = (sample.loop ? 0x40 : 0) | (sample.rate & 0x0f);
          regs[r + 0x12] = entry.addressReg;
          regs[r + 0x13] = entry.lengthReg;
          if (sample.initialLevel >= 0) events[f].push([0x11, sample.initialLevel & 0x7f]);
          events[f].push([0x15, 0x0f], [0x15, 0x1f]);
          dmcLooping = sample.loop;
          voice = new Voice(ev, ctx.fallbackInstrument);
        }
        continue;
      }
      const inst = ctx.instruments.get(ev.note.instrument || ctx.song.channels[ch]?.instrument) ?? ctx.fallbackInstrument;
      const glide = ev.note.fx.glide ?? 0;
      if (glide > 0 && voice && !voice.finished) {
        // Legato glide: keep the envelopes running, slide from the previous pitch.
        const from = voice.lastPitch;
        const keepEnv = voice.envPos;
        voice = new Voice(ev, inst);
        voice.envPos = keepEnv;
        voice.glideFrom = from;
        voice.glideFrames = glide;
      } else {
        voice = new Voice(ev, inst);
      }
    }

    if (kind === 'dmc') {
      if (voice && !voice.released && f >= voice.ev.end) {
        voice.released = true;
        if (dmcLooping) events[f].push([0x15, 0x0f]);
        dmcLooping = false;
      }
      continue;
    }

    if (voice && !voice.released && f >= voice.ev.end) voice.release();
    if (voice && voice.finished) voice = null;

    const out = voice ? voiceOutput(voice, automation ? modsAt(automation, f) : NO_MODS) : null;
    if (voice) {
      voice.step();
      if (voice.finished) voice = null;
    }

    if (kind === 'pulse') {
      const base = r + ch * 4;
      const period = out ? pulsePeriod(out.pitch, ctx.region) : 0;
      if (out && out.volume > 0 && period >= 8) {
        regs[base] = (out.duty << 6) | 0x30 | out.volume;
        regs[base + 2] = period & 0xff;
        regs[base + 3] = 0xf8 | (period >> 8);
      } else {
        regs[base] = (regs[base] & 0xc0) | 0x30;
      }
    } else if (kind === 'triangle') {
      const period = out ? trianglePeriod(out.pitch, ctx.region) : 0;
      if (out && out.volume > 0 && period >= 2) {
        regs[r + 0x08] = 0xff;
        regs[r + 0x0a] = period & 0xff;
        regs[r + 0x0b] = 0xf8 | (period >> 8);
      } else {
        regs[r + 0x08] = 0x80;
      }
    } else if (kind === 'noise') {
      if (out && out.volume > 0) {
        const idx = Math.max(0, Math.min(15, Math.round(out.pitch)));
        regs[r + 0x0c] = 0x30 | out.volume;
        regs[r + 0x0e] = ((out.duty & 1) << 7) | (15 - idx);
      } else {
        regs[r + 0x0c] = 0x30;
      }
    }
  }
}

function buildContext(song: Song): ChannelContext {
  const instruments = new Map(song.instruments.map((i) => [i.id, i]));
  const fallbackInstrument: Instrument = song.instruments[0] ?? {
    id: '',
    name: 'Default',
    color: '#888',
    volume: { values: [15], loop: -1, release: -1 },
    arpeggio: { values: [0], loop: -1, release: -1 },
    pitch: { values: [0], loop: -1, release: -1 },
    duty: { values: [2], loop: -1, release: -1 },
  };
  return { song, region: song.region, instruments, fallbackInstrument, dmc: layoutDmc(song.samples) };
}

export function framesPerTick(song: Song) {
  return (REGIONS[song.region].frameRate * 60) / (song.bpm * PPQ);
}

/** The end of the song in ticks: the end of the last clip, rounded up to a whole bar. */
export function songEndTick(song: Song) {
  let end = 0;
  let lastStart = -1;
  for (const clip of song.playlist) {
    const pattern = song.patterns.find((p) => p.id === clip.pattern);
    if (pattern) end = Math.max(end, clip.start + patternLength(song, pattern));
    lastStart = Math.max(lastStart, clip.start);
  }
  if (song.endTick && song.endTick > lastStart) return song.endTick;
  const bar = ticksPerBar(song);
  return Math.max(bar, Math.ceil(end / bar) * bar);
}

function collectEvents(song: Song, opts: CompileOptions, fpt: number) {
  const frameOf = (t: number) => Math.floor(t * fpt + 1e-6);
  const perChannel: { tick: number; len: number; note: Note }[][] = CHANNELS.map(() => []);
  let endTick: number;

  if (opts.mode === 'pattern') {
    const pattern = song.patterns.find((p) => p.id === opts.patternId) ?? song.patterns[0];
    endTick = pattern ? patternLength(song, pattern) : ticksPerBar(song);
    if (pattern) {
      pattern.notes.forEach((notes, ch) => {
        for (const n of notes) if (n.tick < endTick) perChannel[ch].push({ tick: n.tick, len: Math.min(n.length, endTick - n.tick), note: n });
      });
    }
  } else {
    endTick = songEndTick(song);
    for (const clip of song.playlist) {
      const pattern = song.patterns.find((p) => p.id === clip.pattern);
      if (!pattern) continue;
      const plen = patternLength(song, pattern);
      pattern.notes.forEach((notes, ch) => {
        for (const n of notes) {
          if (n.tick >= plen) continue;
          perChannel[ch].push({ tick: clip.start + n.tick, len: Math.min(n.length, plen - n.tick), note: n });
        }
      });
    }
  }

  const events = perChannel.map((list) =>
    list
      .map(({ tick, len, note }): NoteEvent => {
        const start = frameOf(tick) + Math.max(0, note.fx.delay ?? 0);
        let end = frameOf(tick + len);
        if (note.fx.cut && note.fx.cut > 0) end = Math.min(end, start + note.fx.cut);
        if (end <= start) end = start + 1;
        return { start, end, note };
      })
      .sort((a, b) => a.start - b.start),
  );
  return { events, endFrame: Math.max(1, frameOf(endTick)) };
}

/** Diff per-frame register state into a compact write list. */
function encodeWrites(regs: Uint8Array, events: [number, number][][], frameCount: number, loopFrame: number) {
  const init = new Uint8Array(REG_COUNT);
  for (const [reg, v] of INIT_WRITES) init[reg] = v;
  const out: number[] = [];
  const frameIndex = new Uint32Array(frameCount + 1);
  const lastBase = (frameCount - 1) * REG_COUNT;

  for (let f = 0; f < frameCount; f++) {
    frameIndex[f] = out.length;
    const base = f * REG_COUNT;
    for (const reg of STATE_REGS) {
      const v = regs[base + reg];
      const prev = f === 0 ? init[reg] : regs[base - REG_COUNT + reg];
      // At the loop point we may arrive from either the previous frame or the last frame.
      const changed = v !== prev || (f === loopFrame && v !== regs[lastBase + reg]);
      if (changed) out.push(reg, v);
    }
    for (const [reg, v] of events[f]) out.push(reg, v);
  }
  frameIndex[frameCount] = out.length;
  return { writes: Uint8Array.from(out), frameIndex };
}

export function compileSong(song: Song, opts: CompileOptions): CompiledSong {
  const fpt = framesPerTick(song);
  const { events, endFrame } = collectEvents(song, opts, fpt);
  const frameCount = endFrame;
  const loopFrame = opts.mode === 'pattern' ? 0 : Math.min(frameCount - 1, Math.floor(song.loopStart * fpt + 1e-6));
  // Automation lives on the song timeline, so it only applies in song mode.
  const automation = opts.mode === 'song' ? CHANNELS.map((_, ch) => channelAutomation(song, ch, frameCount, fpt)) : [];
  return compileEvents(song, events, frameCount, loopFrame, fpt, automation);
}

function compileEvents(
  song: Song,
  events: NoteEvent[][],
  frameCount: number,
  loopFrame: number,
  fpt: number,
  automation: ChannelAutomation[] = [],
): CompiledSong {
  const ctx = buildContext(song);
  const regs = new Uint8Array(frameCount * REG_COUNT);
  for (const [reg, v] of INIT_WRITES) regs[reg] = v;
  const frameEvents: [number, number][][] = Array.from({ length: frameCount }, () => []);
  CHANNELS.forEach((_, ch) => simulateChannel(ctx, ch, events[ch], frameCount, regs, frameEvents, automation[ch] ?? null));
  const { writes, frameIndex } = encodeWrites(regs, frameEvents, frameCount, loopFrame);
  return { region: song.region, frameCount, loopFrame, framesPerTick: fpt, writes, frameIndex, dmcMemory: ctx.dmc.memory };
}

/** Compile a single auditioned note (held for `holdFrames`, then released), played once. */
export function compilePreview(song: Song, channel: number, note: Note, holdFrames: number): CompiledSong {
  const fpt = framesPerTick(song);
  const tail = Math.round(REGIONS[song.region].frameRate * 1.5);
  const frameCount = holdFrames + tail;
  const events = CHANNELS.map((_, ch) => (ch === channel ? [{ start: 0, end: holdFrames, note }] : []));
  return compileEvents(song, events, frameCount, -1, fpt);
}
