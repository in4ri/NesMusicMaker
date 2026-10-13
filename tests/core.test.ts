import { describe, expect, it } from 'vitest';
import { Apu } from '../src/core/apu';
import { compilePreview, compileSong, INIT_WRITES } from '../src/core/compiler';
import { bytesToBase64, decodeDmc, encodeDmc, layoutDmc } from '../src/core/dmc';
import { buildNsf, encodeStream } from '../src/core/nsf';
import { pulsePeriod } from '../src/core/tables';
import { renderWav } from '../src/core/wav';
import { demoSong, emptyPattern, makeNote } from '../src/model/defaults';
import { newId, PPQ } from '../src/model/types';
import { loadNsf } from './cpu6502';

function zeroCrossingFreq(samples: Float32Array, sampleRate: number) {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i - 1] < 0 && samples[i] >= 0) crossings++;
  return (crossings * sampleRate) / samples.length;
}

describe('APU', () => {
  it('pulse channel plays A440 at the right pitch', () => {
    const apu = new Apu('ntsc', 48000, () => 0);
    for (const [r, v] of INIT_WRITES) apu.write(0x4000 + r, v);
    const p = pulsePeriod(69, 'ntsc');
    apu.write(0x4000, 0xbf); // 50% duty, constant volume 15
    apu.write(0x4002, p & 0xff);
    apu.write(0x4003, 0xf8 | (p >> 8));
    const out = new Float32Array(48000);
    apu.render(out, 0, out.length);
    const tail = out.subarray(4800);
    expect(zeroCrossingFreq(tail, 48000)).toBeGreaterThan(435);
    expect(zeroCrossingFreq(tail, 48000)).toBeLessThan(445);
  });

  it('triangle plays one octave below pulse for the same pitch math', () => {
    const apu = new Apu('ntsc', 48000, () => 0);
    for (const [r, v] of INIT_WRITES) apu.write(0x4000 + r, v);
    const period = Math.round(1789773 / (32 * 220)) - 1;
    apu.write(0x4008, 0xff);
    apu.write(0x400a, period & 0xff);
    apu.write(0x400b, 0xf8 | (period >> 8));
    const out = new Float32Array(48000);
    apu.render(out, 0, out.length);
    const f = zeroCrossingFreq(out.subarray(4800), 48000);
    expect(f).toBeGreaterThan(215);
    expect(f).toBeLessThan(225);
  });
});

describe('compiler', () => {
  it('compiles the demo song and loops', () => {
    const song = demoSong();
    const c = compileSong(song, { mode: 'song' });
    // 4 bars at 150 BPM, NTSC ~60.1 fps: 16 beats * 0.4 s * 60.1 ≈ 384 frames
    expect(c.frameCount).toBeGreaterThan(380);
    expect(c.frameCount).toBeLessThan(390);
    expect(c.loopFrame).toBe(0);
    expect(c.writes.length).toBeGreaterThan(100);
  });

  it('renders audible audio to WAV', () => {
    const c = compileSong(demoSong(), { mode: 'song' });
    const wav = renderWav(c, { sampleRate: 22050 });
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
    const pcm = new Int16Array(wav.buffer, 44, (wav.length - 44) / 2);
    let peak = 0;
    for (const s of pcm) peak = Math.max(peak, Math.abs(s));
    expect(peak).toBeGreaterThan(3000);
    expect(peak).toBeLessThanOrEqual(32767);
  });

  it('applies the release section of a volume envelope after note off', () => {
    const song = demoSong();
    const lead = song.instruments.find((i) => i.name === 'Lead 25%')!;
    const note = makeNote(0, PPQ, 72, lead.id);
    const c = compilePreview(song, 0, note, 20);
    // Collect $4000 volume per frame.
    const vols: number[] = [];
    let vol = 0;
    for (let f = 0; f < c.frameCount; f++) {
      for (let i = c.frameIndex[f]; i < c.frameIndex[f + 1]; i += 2) if (c.writes[i] === 0) vol = c.writes[i + 1] & 15;
      vols.push(vol);
    }
    expect(vols[0]).toBe(15);
    expect(vols[10]).toBe(10); // held at the sustain value
    expect(vols[21]).toBeLessThan(10); // releasing
    expect(vols[40]).toBe(0);
  });
});

describe('DMC', () => {
  it('encodes and lays out samples on 64-byte boundaries', () => {
    const pcm = new Float32Array(4000).map((_, i) => Math.sin(i / 10));
    const bytes = encodeDmc(pcm, 22050, 15, 'ntsc');
    expect((bytes.length - 1) % 16).toBe(0);
    const decoded = decodeDmc(bytes);
    expect(decoded.length).toBe(bytes.length * 8);
    const s = { id: 'a', name: 'a', data: bytesToBase64(bytes), rate: 15, loop: false, initialLevel: -1 };
    const layout = layoutDmc([s, { ...s, id: 'b' }]);
    expect(layout.entries[0]!.addressReg).toBe(0);
    expect(layout.entries[1]!.offset % 64).toBe(0);
    expect(layout.entries[1]!.offset).toBeGreaterThanOrEqual(bytes.length);
  });
});

describe('NSF export', () => {
  function songWithEverything() {
    const song = demoSong();
    const pcm = new Float32Array(3000).map((_, i) => Math.sin(i / 7) * Math.exp(-i / 1000));
    song.samples.push({ id: 's', name: 'kick', data: bytesToBase64(encodeDmc(pcm, 22050, 15, 'ntsc')), rate: 15, loop: false, initialLevel: 32 });
    // A long pattern with a note every step so the stream spans several banks, plus DMC hits.
    const p = emptyPattern('Long', 1, 16);
    for (let s = 0; s < 16 * 16; s++) {
      p.notes[0].push(makeNote(s * 12, 12, 60 + (s % 24), song.instruments[0].id, 15, { vibratoDepth: 4, vibratoSpeed: 8 }));
      p.notes[1].push(makeNote(s * 12, 6, 50 + ((s * 7) % 30), song.instruments[1].id));
      if (s % 4 === 0) p.notes[4].push(makeNote(s * 12, 12, 0, ''));
    }
    song.patterns.push(p);
    song.playlist.push({ id: newId(), pattern: p.id, track: 1, start: 4 * 4 * PPQ });
    song.loopStart = 2 * 4 * PPQ;
    return song;
  }

  it('6502 player reproduces the compiled register writes exactly, across bank switches and the loop', () => {
    const song = songWithEverything();
    const c = compileSong(song, { mode: 'song' });
    const layout = layoutDmc(song.samples);
    const stream = encodeStream(c);
    expect(stream.length).toBeGreaterThan(0x2000); // crosses at least two bank boundaries

    const nsf = buildNsf(c, { title: 'Test', author: 'Me', copyright: '2026' }, layout.used);
    expect(new TextDecoder().decode(nsf.subarray(0, 4))).toBe('NESM');
    const { machine, init, play } = loadNsf(nsf);

    machine.call(init);
    expect(machine.apuWrites).toEqual(INIT_WRITES.map(([r, v]) => [r, v]));

    // Play through the song twice to exercise the loop.
    const loopLen = c.frameCount - c.loopFrame;
    const total = c.frameCount + loopLen;
    for (let f = 0; f < total; f++) {
      machine.apuWrites = [];
      machine.call(play);
      const cf = f < c.frameCount ? f : c.loopFrame + (f - c.frameCount);
      const expected: [number, number][] = [];
      for (let i = c.frameIndex[cf]; i < c.frameIndex[cf + 1]; i += 2) expected.push([c.writes[i], c.writes[i + 1]]);
      expect(machine.apuWrites, `frame ${f}`).toEqual(expected);
    }

    // DMC samples are visible at $C000 for the hardware to fetch.
    expect(machine.read(0xc000)).toBe(layout.memory[0]);
    expect(machine.read(0xc000 + 100)).toBe(layout.memory[100]);
  });
});
