import { describe, expect, it } from 'vitest';
import { automationValueAt } from '../src/core/automation';
import { compileSong } from '../src/core/compiler';
import { parseMidi } from '../src/core/midi';
import { buildMidiImport, midiSources, suggestMappings, type MidiImportOptions } from '../src/core/midiImport';
import { demoSong } from '../src/model/defaults';
import { PPQ, arpOffsetAt, arpSequence, newId } from '../src/model/types';

/** Build a minimal format-1 MIDI file. Events: [deltaTicks, ...bytes]. */
function smf(ppq: number, tracks: number[][][]): Uint8Array {
  const vlq = (v: number) => {
    const out = [v & 0x7f];
    while ((v >>= 7)) out.unshift((v & 0x7f) | 0x80);
    return out;
  };
  const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const bytes = [...'MThd'].map((c) => c.charCodeAt(0)).concat(u32(6), [0, 1, 0, tracks.length, ppq >> 8, ppq & 255]);
  for (const events of tracks) {
    const body = events.flatMap(([delta, ...data]) => [...vlq(delta), ...data]).concat([0, 0xff, 0x2f, 0]);
    bytes.push(...[...'MTrk'].map((c) => c.charCodeAt(0)), ...u32(body.length), ...body);
  }
  return Uint8Array.from(bytes);
}

const name = (s: string) => [0xff, 0x03, s.length, ...[...s].map((c) => c.charCodeAt(0))];
const opts: MidiImportOptions = {
  quantize: 12, barsPerPattern: 1, useVelocity: true, useTempo: true, placement: 'replace', name: 'Imported', arpStyle: 'up', arpSpeed: 2,
};

function testFile() {
  const ppq = 96;
  return smf(ppq, [
    // Conductor: 140 BPM (428571 µs/quarter), 4/4
    [[0, 0xff, 0x51, 3, 0x06, 0x89, 0xfb], [0, 0xff, 0x58, 4, 4, 2, 24, 8]],
    // Lead with a chord at tick 0 (C5+E5+G5), then D5 using running status
    [[0, ...name('Lead')], [0, 0x90, 72, 100], [0, 76, 100], [0, 79, 100], [96, 0x80, 72, 0], [0, 76, 0], [0, 79, 0],
     [0, 0x90, 74, 64], [96, 74, 0]],
    // Bass, low notes
    [[0, ...name('Bass')], [0, 0x91, 36, 90], [192, 0x81, 36, 0], [0, 0x91, 43, 90], [192, 0x81, 43, 0]],
    // GM drums on channel 10: kick, then closed hat, in bar 3
    [[0, ...name('Drums')], [768, 0x99, 36, 120], [48, 0x89, 36, 0], [0, 0x99, 42, 80], [48, 0x89, 42, 0]],
  ]);
}

describe('MIDI parsing', () => {
  it('reads notes, tempo, time signature and running status', () => {
    const f = parseMidi(testFile());
    expect(f.ppq).toBe(96);
    expect(f.bpm).toBeCloseTo(140, 0);
    expect(f.timeSignature).toEqual([4, 4]);
    expect(f.tracks[1].name).toBe('Lead');
    expect(f.tracks[1].notes.map((n) => n.pitch)).toEqual([72, 76, 79, 74]);
    expect(f.tracks[1].notes[3]).toMatchObject({ tick: 96, length: 96, velocity: 64 });
    expect(f.tracks[3].notes[0].channel).toBe(9);
  });

  it('rejects non-MIDI data', () => {
    expect(() => parseMidi(new Uint8Array([1, 2, 3, 4, 5]))).toThrow();
  });
});

describe('MIDI import', () => {
  it('maps drums to noise, bass to triangle, lead to pulse, and reduces chords', () => {
    const song = demoSong();
    const file = parseMidi(testFile());
    const sources = midiSources(file);
    const mappings = suggestMappings(sources, song);
    const byName = (n: string) => mappings[sources.findIndex((s) => s.name === n)].target;
    expect(byName('Lead')).toBe(0);
    expect(byName('Bass')).toBe(2);
    expect(byName('Drums')).toBe(3);

    mappings[sources.findIndex((s) => s.name === 'Lead')].polyphony = 'highest';
    const r = buildMidiImport(song, file, sources, mappings, opts);
    expect(r.bpm).toBe(140);
    expect(r.droppedNotes).toBe(2); // E5 and G5 of the chord
    const first = r.patterns[0];
    expect(first.notes[0].map((n) => n.pitch)).toEqual([79, 74]); // highest chord note, then D5
    expect(first.notes[0][0]).toMatchObject({ tick: 0, length: PPQ });
    expect(first.notes[2].map((n) => n.pitch)).toEqual([36, 43]);
    // Bar 3 has the drums only.
    const bar3 = r.clips.find((c) => c.start === 2 * 4 * PPQ)!;
    const drums = r.patterns.find((p) => p.id === bar3.pattern)!.notes[3];
    const kick = song.instruments.find((i) => i.name === 'Noise Kick')!.id;
    expect(drums[0]).toMatchObject({ tick: 0, pitch: 6, instrument: kick });
    expect(drums[1].pitch).toBe(15);
  });

  it('reuses identical patterns and skips empty bars', () => {
    const ppq = 96;
    // Quarter notes at the start of bars 1, 2 and 4 (absolute ticks 0, 384, 1152).
    const ev = [[0, 0x90, 60, 100], [96, 0x80, 60, 0], [288, 0x90, 60, 100], [96, 0x80, 60, 0], [672, 0x90, 60, 100], [96, 0x80, 60, 0]];
    const file = parseMidi(smf(ppq, [ev]));
    const song = demoSong();
    const sources = midiSources(file);
    const r = buildMidiImport(song, file, sources, suggestMappings(sources, song), opts);
    // Bar 3 is empty, and the other bars have identical content.
    expect(r.patterns).toHaveLength(1);
    expect(r.clips.map((c) => c.start / (4 * PPQ))).toEqual([0, 1, 3]);
  });
});

describe('chords as arpeggios', () => {
  it('collapses chords into a root note with arpeggio offsets', () => {
    const song = demoSong();
    const file = parseMidi(testFile());
    const sources = midiSources(file);
    const mappings = suggestMappings(sources, song);
    const lead = sources.findIndex((s) => s.name === 'Lead');
    mappings[lead].polyphony = 'arpeggio';
    const r = buildMidiImport(song, file, sources, mappings, opts);
    expect(r.droppedNotes).toBe(0);
    const [chord, single] = r.patterns[0].notes[0];
    expect(chord).toMatchObject({ pitch: 72, fx: { arp: [0, 4, 7], arpStyle: 'up', arpSpeed: 2 } });
    expect(single.fx.arp).toBeUndefined();
  });

  it('suggests arpeggio mode for chord-heavy parts', () => {
    const file = parseMidi(smf(96, [[[0, 0x90, 60, 90], [0, 64, 90], [0, 67, 90], [96, 0x80, 60, 0], [0, 64, 0], [0, 67, 0]]]));
    const sources = midiSources(file);
    expect(sources[0].chordRatio).toBe(1);
    expect(suggestMappings(sources, demoSong())[0]).toMatchObject({ target: 0, polyphony: 'arpeggio' });
  });

  it('plays styles in the expected order', () => {
    expect(arpSequence([0, 7, 4], 'up')).toEqual([0, 4, 7]);
    expect(arpSequence([0, 4, 7], 'down')).toEqual([7, 4, 0]);
    expect(arpSequence([0, 4, 7, 12], 'updown')).toEqual([0, 4, 7, 12, 7, 4]);
    expect(arpSequence([0, 4, 7], 'downup')).toEqual([7, 4, 0, 4]);
    expect(arpSequence([0, 7, 4], 'entered')).toEqual([0, 7, 4]);
    const seq = arpSequence([0, 4, 7], 'up');
    expect([0, 1, 2, 3, 4, 5].map((age) => arpOffsetAt(seq, 'up', 2, age))).toEqual([0, 0, 4, 4, 7, 7]);
    const rnd = [...Array(50).keys()].map((age) => arpOffsetAt(seq, 'random', 1, age));
    expect(new Set(rnd).size).toBe(3);
    expect(rnd).toEqual([...Array(50).keys()].map((age) => arpOffsetAt(seq, 'random', 1, age))); // deterministic
  });
});

describe('volume automation', () => {
  it('interpolates linearly and holds flat outside the points', () => {
    const pts = [{ id: 'a', tick: 100, value: 4 }, { id: 'b', tick: 200, value: 12 }];
    expect(automationValueAt([], 50)).toBe(15);
    expect(automationValueAt(pts, 0)).toBe(4);
    expect(automationValueAt(pts, 150)).toBe(8);
    expect(automationValueAt(pts, 999)).toBe(12);
  });

  it('scales channel volume in song mode only', () => {
    const song = demoSong();
    const pulse1Volumes = (mode: 'song' | 'pattern') => {
      const c = compileSong(song, { mode, patternId: song.patterns[0].id });
      const vols: number[] = [];
      for (let i = 0; i < c.writes.length; i += 2) if (c.writes[i] === 0x00) vols.push(c.writes[i + 1] & 15);
      return vols.length ? Math.max(...vols) : 0; // no writes = still silent from init
    };
    expect(pulse1Volumes('song')).toBe(15);
    song.automation = [{ channel: 0, param: 'volume', points: [{ id: newId(), tick: 0, value: 5 }] }];
    expect(pulse1Volumes('song')).toBeLessThanOrEqual(5);
    expect(pulse1Volumes('pattern')).toBe(15);
    song.automation[0].points[0].value = 0;
    expect(pulse1Volumes('song')).toBe(0);
  });
});

describe('duty and detune automation', () => {
  /** Per-frame Pulse 1 register values from a song-mode compile ($4000 duty bits, $4002/$4003 period). */
  function pulse1(song: ReturnType<typeof demoSong>) {
    const c = compileSong(song, { mode: 'song' });
    const regs = [0x30, 0x08, 0, 0xf8];
    const frames: { duty: number; period: number }[] = [];
    for (let f = 0; f < c.frameCount; f++) {
      for (let i = c.frameIndex[f]; i < c.frameIndex[f + 1]; i += 2) if (c.writes[i] < 4) regs[c.writes[i]] = c.writes[i + 1];
      frames.push({ duty: regs[0] >> 6, period: regs[2] | ((regs[3] & 7) << 8) });
    }
    return { frames, fpt: c.framesPerTick };
  }

  it('overrides the instrument duty only inside the sweep span', () => {
    const song = demoSong();
    const bar = 4 * PPQ;
    // The demo lead instrument uses 25% duty (1). Sweep 12.5% → 75% across bar 2.
    song.automation = [{ channel: 0, param: 'duty', points: [{ id: 'a', tick: bar, value: 0 }, { id: 'b', tick: 2 * bar, value: 3 }] }];
    const { frames, fpt } = pulse1(song);
    const at = (tick: number) => frames[Math.floor(tick * fpt) + 1].duty;
    expect(at(bar / 2)).toBe(1); // before the span: instrument
    expect(at(bar + 4)).toBe(0); // start of sweep
    expect(at(2 * bar - 4)).toBe(3); // end of sweep
    expect(at(2.5 * bar)).toBe(1); // after the span: instrument again
  });

  it('a note-level duty setting beats duty automation', () => {
    const song = demoSong();
    for (const n of song.patterns[0].notes[0]) n.fx.duty = 2;
    song.automation = [{ channel: 0, param: 'duty', points: [{ id: 'a', tick: 0, value: 0 }, { id: 'b', tick: 16 * PPQ, value: 0 }] }];
    const { frames } = pulse1(song);
    expect(new Set(frames.slice(1, 300).map((f) => f.duty))).toEqual(new Set([2]));
  });

  it('detune shifts the pulse period by the right amount', () => {
    const plain = pulse1(demoSong()).frames;
    const song = demoSong();
    song.automation = [{ channel: 0, param: 'detune', points: [{ id: 'a', tick: 0, value: 50 }] }];
    const detuned = pulse1(song).frames;
    // +50 cents raises pitch, so the period shrinks by ~2.9% (2^(-50/1200)).
    const ratio = detuned[2].period / plain[2].period;
    expect(ratio).toBeGreaterThan(0.965);
    expect(ratio).toBeLessThan(0.978);
  });
});

