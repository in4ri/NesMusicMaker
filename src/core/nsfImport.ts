// NSF → editable song. Runs the NSF's music code on an emulated NES, records
// what the sound chip does every frame, then transcribes that back into notes,
// instruments, drum hits, samples, a tempo and a loop point.
//
// This is a transcription, not a copy: melodies, bass, drums and arpeggios come
// through well; vibrato, slides and other per-frame tricks are simplified.

import { emptySong, env, INSTRUMENT_COLORS, PATTERN_COLORS } from '../model/defaults';
import { CHANNELS, PPQ, TICKS_PER_STEP, newId, type DmcSample, type Instrument, type Note, type Pattern, type Song } from '../model/types';
import { Apu } from './apu';
import { bytesToBase64 } from './dmc';
import { NsfMachine, type NsfFile } from './nsfFile';
import { REGIONS } from './tables';

const CAPTURE_RATE = 11025; // APU sample rate used while capturing (output is discarded)

interface PitchedTrack {
  vol: Uint8Array; // 0..15, 0 = silent
  pitch: Float32Array; // fractional MIDI pitch (noise: 0..15)
  duty: Uint8Array; // pulse duty / noise mode
  trig: Uint8Array; // 1 if the channel's "start note" register was written this frame
}

interface DmcEvent {
  frame: number;
  kind: 'start' | 'stop';
  addr: number;
  length: number; // bytes
  rate: number;
  loop: boolean;
}

export interface NsfCapture {
  frames: number;
  frameRate: number;
  tracks: PitchedTrack[]; // pulse 1, pulse 2, triangle, noise
  dmc: DmcEvent[];
  dmcBytes: Map<string, Uint8Array>;
  /** Hash of each frame's register writes (for loop detection). */
  hashes: Uint32Array;
  /** Frames where any channel is audible. */
  audible: Uint8Array;
}

function newTrack(n: number): PitchedTrack {
  return { vol: new Uint8Array(n), pitch: new Float32Array(n), duty: new Uint8Array(n), trig: new Uint8Array(n) };
}

function periodToPitch(cpuClock: number, divider: number, period: number) {
  const f = cpuClock / (divider * (period + 1));
  return 69 + 12 * Math.log2(f / 440);
}

/** Run a track for up to `maxSeconds`, recording the APU state each frame. */
export async function captureNsf(file: NsfFile, track: number, maxSeconds: number, onProgress?: (fraction: number) => void): Promise<NsfCapture> {
  const { header } = file;
  const region = header.region;
  const cpuClock = REGIONS[region].cpuClock;
  const frames = Math.round(maxSeconds * header.playRate);
  let machine: NsfMachine | null = null;
  const apu = new Apu(region, CAPTURE_RATE, (a) => (machine ? machine.read(a) : 0));
  machine = new NsfMachine(file, apu);
  let writes: number[] = [];
  machine.onApuWrite = (reg, v) => writes.push(reg, v);
  machine.init(track);

  const tracks = [newTrack(frames), newTrack(frames), newTrack(frames), newTrack(frames)];
  const hashes = new Uint32Array(frames);
  const audible = new Uint8Array(frames);
  const dmc: DmcEvent[] = [];
  const dmcBytes = new Map<string, Uint8Array>();
  const samplesPerFrame = CAPTURE_RATE / header.playRate;
  const scratch = new Float32Array(Math.ceil(samplesPerFrame) + 2);
  let sampleDebt = 0;
  let dmcLooping = false;

  for (let f = 0; f < frames; f++) {
    writes = [];
    const triggersBefore = apu.dmcTriggers;
    machine.play();

    // Let the frame run a little so envelope/linear-counter restarts take effect, then sample.
    sampleDebt += samplesPerFrame;
    const total = Math.floor(sampleDebt);
    sampleDebt -= total;
    const first = Math.max(1, Math.floor(total / 3));
    apu.render(scratch, 0, first);

    const pulses = [apu.pulse1, apu.pulse2];
    pulses.forEach((p, i) => {
      const t = tracks[i];
      const live = p.length > 0 && p.period >= 8 && p.sweepTarget() <= 0x7ff;
      t.vol[f] = live ? p.env.output : 0;
      t.pitch[f] = periodToPitch(cpuClock, 16, p.period);
      t.duty[f] = p.duty;
    });
    const tri = apu.triangle;
    tracks[2].vol[f] = tri.length > 0 && tri.linear > 0 && tri.period >= 2 ? 15 : 0;
    tracks[2].pitch[f] = periodToPitch(cpuClock, 32, tri.period);
    const noise = apu.noise;
    tracks[3].vol[f] = noise.length > 0 ? noise.env.output : 0;
    tracks[3].pitch[f] = 15 - noise.periodIndex;
    tracks[3].duty[f] = noise.mode ? 1 : 0;

    let h = 2166136261;
    for (let i = 0; i < writes.length; i += 2) {
      const reg = writes[i];
      if (reg === 0x03) tracks[0].trig[f] = 1;
      if (reg === 0x07) tracks[1].trig[f] = 1;
      if (reg === 0x0b) tracks[2].trig[f] = 1;
      if (reg === 0x0f) tracks[3].trig[f] = 1;
      if (reg === 0x15 && !(writes[i + 1] & 0x10) && dmcLooping) {
        dmc.push({ frame: f, kind: 'stop', addr: 0, length: 0, rate: 0, loop: false });
        dmcLooping = false;
      }
      h = Math.imul(h ^ reg, 16777619);
      h = Math.imul(h ^ writes[i + 1], 16777619);
    }
    hashes[f] = h >>> 0;

    if (apu.dmcTriggers > triggersBefore) {
      const d = apu.dmc;
      const ev: DmcEvent = { frame: f, kind: 'start', addr: d.sampleAddress, length: d.sampleLength, rate: d.rateIndex, loop: d.loop };
      dmc.push(ev);
      dmcLooping = d.loop;
      const key = `${ev.addr}:${ev.length}`;
      if (!dmcBytes.has(key)) {
        const bytes = new Uint8Array(ev.length);
        let a = ev.addr;
        for (let i = 0; i < ev.length; i++) {
          bytes[i] = machine.read(a);
          a = a === 0xffff ? 0x8000 : a + 1;
        }
        dmcBytes.set(key, bytes);
      }
    }

    audible[f] = tracks[0].vol[f] || tracks[1].vol[f] || tracks[2].vol[f] || tracks[3].vol[f] || apu.dmc.bytesRemaining > 0 ? 1 : 0;
    if (total > first) apu.render(scratch, 0, total - first);

    if (f % 600 === 599) {
      onProgress?.(f / frames);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  onProgress?.(1);
  return { frames, frameRate: header.playRate, tracks, dmc, dmcBytes, hashes, audible };
}

/** Find where the music starts repeating: the earliest start S and period L with frames S.. matching S+L.. to the end. */
export function findLoop(hashes: Uint32Array, audible: Uint8Array, frameRate: number): { start: number; length: number } | null {
  const n = hashes.length;
  const minLength = Math.round(frameRate * 4);
  let best: { start: number; length: number } | null = null;
  for (let L = minLength; L <= n / 2; L++) {
    let i = n - 1 - L;
    while (i >= 0 && hashes[i] === hashes[i + L]) i--;
    const start = i + 1;
    const run = n - L - start;
    if (run < L) continue; // need a full repeat to be sure
    if (!best || start < best.start) best = { start, length: L };
  }
  if (!best) return null;
  // A "loop" of pure silence means the track simply ended.
  let any = false;
  for (let f = best.start; f < best.start + best.length && !any; f++) any = !!audible[f];
  return any ? best : null;
}

/**
 * Frames per 16th-note step. Tries NES-style frame grids (whole and half frames, for swing/groove) and
 * exact BPM grids, keeps those that at least 90% of note starts land on (within a frame), and picks the
 * one giving the most typical tempo (90–180 BPM), preferring the coarsest grid.
 */
export function detectStep(starts: number[], frameRate: number): { step: number; origin: number } {
  const uniq = [...new Set(starts)].sort((a, b) => a - b);
  if (uniq.length < 4) return { step: Math.round(frameRate / 10), origin: 0 };
  const candidates = new Set<number>();
  for (let s = 3; s <= 15; s += 0.5) candidates.add(s);
  for (let bpm = 60; bpm <= 300; bpm++) candidates.add((frameRate * 60) / (bpm * 4));

  // Fraction of note starts within a frame of the step grid, and of the step-or-half-step grid (32nd notes are fine).
  const fitOf = (step: number) => {
    let best = { onStep: 0, onHalf: 0, origin: 0 };
    const origins = new Set([0, ...uniq.slice(0, 24).map((f) => f % step)]);
    for (const o of origins) {
      let onStep = 0, onHalf = 0;
      for (const f of uniq) {
        if (Math.abs(f - (o + Math.round((f - o) / step) * step)) <= 1) onStep++;
        if (Math.abs(f - (o + Math.round((f - o) / (step / 2)) * (step / 2))) <= 1) onHalf++;
      }
      if (onHalf > best.onHalf || (onHalf === best.onHalf && onStep > best.onStep)) best = { onStep, onHalf, origin: o };
    }
    return { stepFit: best.onStep / uniq.length, halfFit: best.onHalf / uniq.length, origin: best.origin };
  };

  const scored = [...candidates]
    .filter((s) => s >= 3 && s <= (frameRate * 60) / (60 * 4))
    .map((step) => {
      const bpm = (frameRate * 60) / (step * 4);
      return { step, bpm, ...fitOf(step), penalty: bpm < 90 ? 90 - bpm : bpm > 180 ? bpm - 180 : 0 };
    });
  const good = scored.filter((c) => c.halfFit >= 0.9);
  const pool = good.length ? good : scored.filter((c) => c.halfFit >= Math.max(...scored.map((x) => x.halfFit)) - 0.05);
  // Most typical tempo first, then the grid most notes sit exactly on, then the coarsest.
  pool.sort((a, b) => a.penalty - b.penalty || b.stepFit - a.stepFit || b.step - a.step);
  const { step } = pool[0];
  // Centre the grid on the notes (playback rounds times down to whole frames), keeping the offset near zero.
  let origin = pool[0].origin;
  const residuals = uniq
    .map((f) => f - (origin + Math.round((f - origin) / step) * step))
    .filter((r) => Math.abs(r) <= 1);
  if (residuals.length) origin += residuals.reduce((a, r) => a + r, 0) / residuals.length;
  origin = ((origin % step) + step) % step;
  if (origin > step / 2) origin -= step;
  return { step, origin };
}

interface RawNote {
  start: number;
  end: number;
  semis: number[];
  vols: number[];
  duties: number[];
}

/** Split a channel's frames into notes: on silence, volume re-attacks, held pitch changes and (if used sparingly) note-start writes. */
function segment(t: PitchedTrack, frames: number, kind: 'pulse' | 'triangle' | 'noise'): RawNote[] {
  let sounding = 0, trigs = 0;
  for (let f = 0; f < frames; f++) if (t.vol[f]) {
    sounding++;
    trigs += t.trig[f];
  }
  const trigMeaningful = sounding > 0 && trigs / sounding < 0.35;
  const semiAt = (f: number) => Math.round(t.pitch[f]);
  // Looks ahead into the whole capture (not just up to the loop point); too few frames left = not stable.
  const stableFor = (f: number, s: number, k: number) => {
    if (f + Math.min(k, 3) > t.vol.length) return false;
    for (let i = f; i < Math.min(t.vol.length, f + k); i++) if (!t.vol[i] || semiAt(i) !== s) return false;
    return true;
  };

  const notes: RawNote[] = [];
  let cur: (RawNote & { stable: number }) | null = null;
  const close = (f: number) => {
    if (cur) {
      cur.end = f;
      notes.push(cur);
      cur = null;
    }
  };
  for (let f = 0; f < frames; f++) {
    if (!t.vol[f]) {
      close(f);
      continue;
    }
    const s = semiAt(f);
    if (cur) {
      const reattack = kind !== 'triangle' && t.vol[f] >= t.vol[f - 1] + 3;
      // A note-start write only counts when the pitch is steady around it (arpeggios also cause these writes).
      const steadyBefore = f >= 2 && t.vol[f - 2] > 0 && semiAt(f - 1) === semiAt(f - 2);
      const trig = trigMeaningful && t.trig[f] === 1 && stableFor(f, s, 2) && (steadyBefore || kind === 'noise');
      const moved = s !== cur.stable && stableFor(f, s, kind === 'noise' ? 99 : 3);
      if (reattack || trig || moved) close(f);
    }
    if (!cur) cur = { start: f, end: f, semis: [], vols: [], duties: [], stable: s };
    if (stableFor(f, s, 3)) cur.stable = s;
    cur.semis.push(s);
    cur.vols.push(t.vol[f]);
    cur.duties.push(t.duty[f]);
  }
  close(frames);
  return notes;
}

interface Grid {
  step: number;
  origin: number;
}

function gridDistance(f: number, g: Grid) {
  return Math.abs(f - (g.origin + Math.round((f - g.origin) / g.step) * g.step));
}

/**
 * Inside an arpeggio, a chord change shows up as a pitch that wasn't in the recent cycle. Split there,
 * moving the cut back to the nearest beat (the new chord's cycle may start with notes shared with the old one).
 */
function splitChordChanges(notes: RawNote[], grid: Grid): RawNote[] {
  const out: RawNote[] = [];
  for (const n of notes) {
    const cuts: number[] = [];
    let last = 0;
    for (let i = 6; i < n.semis.length; i++) {
      const recent = new Set(n.semis.slice(Math.max(last, i - 6), i));
      if (recent.size < 2 || recent.has(n.semis[i])) continue;
      let best = i;
      for (let j = Math.max(last + 1, i - 3); j <= i; j++) if (gridDistance(n.start + j, grid) < gridDistance(n.start + best, grid)) best = j;
      cuts.push(best);
      last = best;
      i = best + 6;
    }
    let from = 0;
    for (const c of [...cuts, n.semis.length]) {
      if (c > from) {
        out.push({ start: n.start + from, end: c === n.semis.length ? n.end : n.start + c, semis: n.semis.slice(from, c), vols: n.vols.slice(from, c), duties: n.duties.slice(from, c) });
      }
      from = c;
    }
  }
  return out;
}

/** Recognise fast note cycling as an arpeggio chord. */
function arpeggioOf(semis: number[]): { root: number; offsets: number[]; speed: number } | null {
  const runs: { v: number; n: number }[] = [];
  for (const s of semis) {
    if (runs.length && runs[runs.length - 1].v === s) runs[runs.length - 1].n++;
    else runs.push({ v: s, n: 1 });
  }
  if (runs.length < 4) return null;
  const distinct = [...new Set(runs.map((r) => r.v))];
  if (distinct.length < 2 || distinct.length > 8) return null;
  const root = runs[0].v;
  const offsets = distinct.map((v) => v - root);
  if (!offsets.some((o) => Math.abs(o) >= 2)) return null; // ±1 flicker is vibrato, not a chord
  const lengths = runs.slice(0, -1).map((r) => r.n).sort((a, b) => a - b);
  const speed = Math.max(1, lengths[Math.floor(lengths.length / 2)] ?? 1);
  if (speed > 4) return null;
  return { root, offsets, speed };
}

function mode(values: number[]) {
  const counts = new Map<number, number>();
  let best = values[0], bestN = 0;
  for (const v of values) {
    const n = (counts.get(v) ?? 0) + 1;
    counts.set(v, n);
    if (n > bestN) [best, bestN] = [v, n];
  }
  return best;
}

interface InstrumentDraft {
  inst: Instrument;
  uses: number;
}

const ENV_MAX = 32;

/** Group notes with the same shape (volume curve, duty, drum pitch movement) into shared instruments. */
class InstrumentBuilder {
  private readonly drafts: InstrumentDraft[] = [];
  private count = 0;

  constructor(private readonly prefix: string, private readonly limit: number) {}

  private holdAt(values: number[], i: number) {
    return values[Math.min(i, values.length - 1)];
  }

  find(vol: number[], duty: number[], arp: number[]): Instrument {
    const n = Math.min(vol.length, 16);
    const matches = (d: InstrumentDraft) => {
      for (let i = 0; i < n; i++) {
        if (Math.abs(this.holdAt(d.inst.volume.values, i) - vol[i]) > 1) return false;
        if (this.holdAt(d.inst.duty.values, i) !== duty[i]) return false;
        if (this.holdAt(d.inst.arpeggio.values, i) !== arp[i]) return false;
      }
      return true;
    };
    let draft = this.drafts.find(matches);
    if (!draft && this.drafts.length >= this.limit) {
      // Out of room: use the closest existing shape.
      const err = (d: InstrumentDraft) => vol.slice(0, n).reduce((e, v, i) => e + (this.holdAt(d.inst.volume.values, i) - v) ** 2, 0);
      draft = this.drafts.reduce((a, b) => (err(a) <= err(b) ? a : b));
    }
    if (!draft) {
      this.count++;
      draft = {
        uses: 0,
        inst: {
          id: newId('i'),
          name: `${this.prefix} ${this.count}`,
          color: INSTRUMENT_COLORS[(this.count - 1) % INSTRUMENT_COLORS.length],
          volume: env(vol.slice(0, ENV_MAX)),
          arpeggio: env(arp.slice(0, ENV_MAX)),
          pitch: env([0]),
          duty: env(duty.slice(0, ENV_MAX)),
        },
      };
      this.drafts.push(draft);
    } else if (vol.length > draft.inst.volume.values.length && draft.inst.volume.values.length < ENV_MAX) {
      // A longer note shows more of the shape: extend it.
      draft.inst.volume.values = vol.slice(0, ENV_MAX);
      draft.inst.duty.values = duty.slice(0, ENV_MAX);
      draft.inst.arpeggio.values = arp.slice(0, ENV_MAX);
    }
    draft.uses++;
    return draft.inst;
  }

  instruments() {
    for (const d of this.drafts) {
      // Collapse constant envelopes to a single value for tidiness.
      for (const e of [d.inst.volume, d.inst.duty, d.inst.arpeggio]) if (e.values.every((v) => v === e.values[0])) e.values = [e.values[0]];
    }
    return this.drafts.map((d) => d.inst);
  }
}

export interface NsfImportOptions {
  barsPerPattern: number;
  /** Frames per 16th step; detected automatically if omitted. */
  framesPerStep?: number;
}

export interface NsfImportResult {
  song: Song;
  framesPerStep: number;
  loopFound: boolean;
  seconds: number;
  noteCount: number;
}

/** Turn a capture into a new song. */
export function transcribe(file: NsfFile, capture: NsfCapture, opts: NsfImportOptions): NsfImportResult {
  const { header } = file;
  const loop = findLoop(capture.hashes, capture.audible, capture.frameRate);
  let endFrame = loop ? loop.start + loop.length : capture.frames;
  if (!loop) {
    // No loop: stop shortly after the last sound.
    let last = capture.frames - 1;
    while (last > 0 && !capture.audible[last]) last--;
    endFrame = Math.min(capture.frames, last + Math.round(capture.frameRate / 2));
  }

  const kinds = ['pulse', 'pulse', 'triangle', 'noise'] as const;
  const firstPass = capture.tracks.map((t, ch) => segment(t, endFrame, kinds[ch]));
  const starts = firstPass.flat().map((n) => n.start).concat(capture.dmc.filter((e) => e.kind === 'start' && e.frame < endFrame).map((e) => e.frame));
  const detected = detectStep(starts, capture.frameRate);
  const step = opts.framesPerStep ?? detected.step;
  const origin = opts.framesPerStep ? 0 : detected.origin;
  const raw = firstPass.map((notes, ch) => (kinds[ch] === 'noise' ? notes : splitChordChanges(notes, { step, origin })));
  // Frame → tick, snapped to the step / half step / triplet grid when within a frame of it (playback rounds
  // note times down to whole frames, so exact positions come back slightly early). Off-grid notes keep their timing.
  const oneFrame = TICKS_PER_STEP / step;
  const toTick = (f: number) => {
    const exact = ((f - origin) / step) * TICKS_PER_STEP;
    for (const q of [TICKS_PER_STEP, TICKS_PER_STEP / 2, (TICKS_PER_STEP * 2) / 3]) {
      const near = Math.round(exact / q) * q;
      if (Math.abs(exact - near) <= oneFrame * 0.75) return Math.max(0, near);
    }
    return Math.max(0, Math.round(exact));
  };
  // Durations come from the frame count (not the snapped end), so identical notes get identical lengths.
  const toLength = (frames: number) => {
    const exact = (frames / step) * TICKS_PER_STEP;
    const near = Math.round(exact / (TICKS_PER_STEP / 2)) * (TICKS_PER_STEP / 2);
    return Math.max(1, Math.abs(exact - near) <= oneFrame * 0.75 ? near : Math.round(exact));
  };

  const song = emptySong();
  song.title = header.title || 'Imported NSF';
  song.author = header.artist;
  song.copyright = header.copyright;
  song.region = header.region;
  song.beatsPerBar = 4;
  song.bpm = Math.max(30, Math.min(400, Math.round((REGIONS[song.region].frameRate * 60) / (step * 4))));
  song.automation = [];

  const pulseInst = new InstrumentBuilder('NSF Pulse', 16);
  const noiseInst = new InstrumentBuilder('NSF Drum', 12);
  const triInst: Instrument = { id: newId('i'), name: 'NSF Triangle', color: '#8ce99a', volume: env([15]), arpeggio: env([0]), pitch: env([0]), duty: env([2]) };
  const channelNotes: Note[][] = CHANNELS.map(() => []);

  raw.forEach((notes, ch) => {
    for (const n of notes) {
      const tick = toTick(n.start);
      const length = toLength(n.end - n.start);
      const kind = kinds[ch];
      let pitch = mode(n.semis);
      let fx: Note['fx'] = {};
      let instrument: Instrument;
      let volume = 15;
      if (kind === 'noise') {
        pitch = n.semis[0];
        const peak = Math.max(...n.vols);
        volume = peak;
        instrument = noiseInst.find(
          n.vols.map((v) => Math.round((v * 15) / peak)),
          n.duties,
          n.semis.map((s) => s - pitch),
        );
      } else {
        const arp = arpeggioOf(n.semis);
        if (arp) {
          pitch = arp.root;
          fx = { arp: arp.offsets, arpStyle: 'entered', ...(arp.speed > 1 ? { arpSpeed: arp.speed } : {}) };
        }
        if (kind === 'triangle') instrument = triInst;
        else {
          const peak = Math.max(...n.vols);
          volume = peak;
          instrument = pulseInst.find(n.vols.map((v) => Math.round((v * 15) / peak)), n.duties, n.vols.map(() => 0));
        }
      }
      channelNotes[ch].push({ id: newId('n'), tick, length, pitch, volume, instrument: instrument.id, fx });
    }
  });

  // DMC samples and hits.
  const samples: DmcSample[] = [];
  const sampleIndex = new Map<string, number>();
  const dmcEvents = capture.dmc.filter((e) => e.frame < endFrame);
  dmcEvents.forEach((e, i) => {
    if (e.kind !== 'start') return;
    const key = `${e.addr}:${e.length}:${e.rate}:${e.loop}`;
    if (!sampleIndex.has(key)) {
      const bytes = capture.dmcBytes.get(`${e.addr}:${e.length}`) ?? new Uint8Array(1);
      sampleIndex.set(key, samples.length);
      samples.push({ id: newId('s'), name: `Sample ${samples.length + 1}`, data: bytesToBase64(bytes), rate: e.rate, loop: e.loop, initialLevel: -1 });
    }
    const next = dmcEvents.slice(i + 1).find((x) => x.frame > e.frame);
    const playFrames = Math.ceil(((e.length * 8 * REGIONS[header.region].dmcRates[e.rate]) / REGIONS[header.region].cpuClock) * capture.frameRate);
    const endF = e.loop ? next?.frame ?? endFrame : Math.min(next?.frame ?? endFrame, e.frame + playFrames);
    const tick = toTick(e.frame);
    channelNotes[4].push({ id: newId('n'), tick, length: toLength(endF - e.frame), pitch: sampleIndex.get(key)!, volume: 15, instrument: '', fx: {} });
  });

  // Instruments, with each channel's most-used one as its sound.
  song.instruments = [...pulseInst.instruments(), triInst, ...noiseInst.instruments()];
  song.samples = samples;
  CHANNELS.forEach((c, ch) => {
    if (c.kind === 'dmc') return;
    const counts = new Map<string, number>();
    for (const n of channelNotes[ch]) counts.set(n.instrument, (counts.get(n.instrument) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    song.channels[ch].instrument = top ?? (c.kind === 'triangle' ? triInst.id : song.instruments[0].id);
    for (const n of channelNotes[ch]) if (n.instrument === song.channels[ch].instrument) n.instrument = '';
  });

  // Slice into patterns, reusing identical ones.
  const patternTicks = opts.barsPerPattern * PPQ * song.beatsPerBar;
  const endTick = Math.max(TICKS_PER_STEP, Math.round(toTick(endFrame) / TICKS_PER_STEP) * TICKS_PER_STEP);
  const segments = Math.ceil(endTick / patternTicks);
  const byContent = new Map<string, Pattern>();
  song.patterns = [];
  song.playlist = [];
  for (let k = 0; k < segments; k++) {
    const s0 = k * patternTicks, s1 = s0 + patternTicks;
    const notes = channelNotes.map((list) =>
      list.filter((n) => n.tick >= s0 && n.tick < s1).map((n) => ({ ...n, id: newId('n'), tick: n.tick - s0, length: Math.min(n.length, s1 - n.tick) })),
    );
    if (notes.every((l) => !l.length)) continue;
    const key = JSON.stringify(notes.map((l) => l.map((n) => [n.tick, n.length, n.pitch, n.volume, n.instrument, n.fx])));
    let pattern = byContent.get(key);
    if (!pattern) {
      pattern = { id: newId('p'), name: `Part ${song.patterns.length + 1}`, color: PATTERN_COLORS[song.patterns.length % PATTERN_COLORS.length], bars: opts.barsPerPattern, notes };
      song.patterns.push(pattern);
      byContent.set(key, pattern);
    }
    song.playlist.push({ id: newId('c'), pattern: pattern.id, track: 0, start: s0 });
  }
  if (!song.patterns.length) throw new Error('No notes were found in this track');
  song.loopStart = loop ? Math.round(toTick(loop.start) / TICKS_PER_STEP) * TICKS_PER_STEP : 0;
  song.endTick = endTick;

  return {
    song,
    framesPerStep: step,
    loopFound: !!loop,
    seconds: endFrame / capture.frameRate,
    noteCount: channelNotes.reduce((a, l) => a + l.length, 0),
  };
}
