import { describe, expect, it } from 'vitest';
import { compileSong } from '../src/core/compiler';
import { Cpu6502 } from '../src/core/cpu6502';
import { layoutDmc } from '../src/core/dmc';
import { buildNsf } from '../src/core/nsf';
import { parseNsf } from '../src/core/nsfFile';
import { captureNsf, transcribe } from '../src/core/nsfImport';
import { demoSong } from '../src/model/defaults';
import { PPQ } from '../src/model/types';

function cpuWith(program: number[], at = 0x8000) {
  const mem = new Uint8Array(0x10000);
  mem.set(program, at);
  const cpu = new Cpu6502((a) => mem[a], (a, v) => (mem[a] = v));
  cpu.pc = at;
  return { cpu, mem };
}

describe('6502 CPU', () => {
  it('adds with carry and overflow', () => {
    // LDA #$50; ADC #$50  -> $A0, V=1, C=0
    const { cpu } = cpuWith([0xa9, 0x50, 0x69, 0x50]);
    cpu.step();
    cpu.step();
    expect([cpu.a, cpu.v, cpu.c, cpu.n]).toEqual([0xa0, 1, 0, 1]);
  });

  it('subtracts with borrow', () => {
    // SEC; LDA #$10; SBC #$20 -> $F0, C=0
    const { cpu } = cpuWith([0x38, 0xa9, 0x10, 0xe9, 0x20]);
    for (let i = 0; i < 3; i++) cpu.step();
    expect([cpu.a, cpu.c]).toEqual([0xf0, 0]);
  });

  it('runs a loop with indexed stores, JSR/RTS and the indirect JMP page bug', () => {
    // LDX #4; loop: TXA; STA $0200,X; DEX; BNE loop; JSR sub; JMP ($10FF)
    // sub: LDY #$42; RTS
    const prog = [0xa2, 0x04, 0x8a, 0x9d, 0x00, 0x02, 0xca, 0xd0, 0xf9, 0x20, 0x20, 0x80, 0x6c, 0xff, 0x10];
    const { cpu, mem } = cpuWith(prog);
    mem.set([0xa0, 0x42, 0x60], 0x8020);
    mem[0x10ff] = 0x34; // low byte
    mem[0x1000] = 0x12; // high byte comes from $1000 (same page), not $1100
    mem[0x1100] = 0x99;
    for (let i = 0; i < 1 + 4 * 4 + 3 + 1; i++) cpu.step(); // LDX, 4 loops, JSR+LDY+RTS, JMP
    expect(Array.from(mem.subarray(0x201, 0x205))).toEqual([1, 2, 3, 4]);
    expect(cpu.y).toBe(0x42);
    expect(cpu.pc).toBe(0x1234);
  });

  it('supports unofficial opcodes used by some drivers', () => {
    // LAX $10 ; DCP $11 (dec then compare)
    const { cpu, mem } = cpuWith([0xa7, 0x10, 0xc7, 0x11]);
    mem[0x10] = 0x33;
    mem[0x11] = 0x34;
    cpu.step();
    cpu.step();
    expect([cpu.a, cpu.x, mem[0x11], cpu.z]).toEqual([0x33, 0x33, 0x33, 1]);
  });
});

describe('NSF import', () => {
  async function roundTrip() {
    const song = demoSong();
    const compiled = compileSong(song, { mode: 'song' });
    const nsf = buildNsf(compiled, { title: 'Demo Tune', author: 'Me', copyright: '' }, layoutDmc(song.samples).used);
    const file = parseNsf(nsf);
    const capture = await captureNsf(file, 0, 20);
    return { song, file, result: transcribe(file, capture, { barsPerPattern: 2 }) };
  }

  it('reads the header', async () => {
    const { file } = await roundTrip();
    expect(file.header.title).toBe('Demo Tune');
    expect(file.header.songCount).toBe(1);
    expect(file.header.bankswitched).toBe(true);
    expect(file.header.playRate).toBeCloseTo(60.1, 1);
  });

  it('recovers tempo, loop and the notes of our own exported song', async () => {
    const { song, result } = await roundTrip();
    const out = result.song;
    expect(result.framesPerStep).toBeCloseTo(6, 1);
    expect(out.bpm).toBe(150);
    expect(result.loopFound).toBe(true);
    expect(out.loopStart).toBe(0);
    expect(out.endTick).toBe(4 * 4 * PPQ); // the 4-bar demo
    expect(out.region).toBe('ntsc');

    // Flatten each channel's notes in song time.
    const flat = (s: typeof song, ch: number) =>
      s.playlist
        .flatMap((clip) => s.patterns.find((p) => p.id === clip.pattern)!.notes[ch].map((n) => ({ ...n, tick: n.tick + clip.start })))
        .sort((a, b) => a.tick - b.tick);

    // Melody (pulse 1) and bass (triangle): same pitches at the same times.
    for (const ch of [0, 2]) {
      const want = flat(song, ch).map((n) => [n.tick, n.pitch]);
      const got = flat(out, ch).map((n) => [n.tick, n.pitch]);
      expect(got, `channel ${ch}`).toEqual(want);
    }
    // Chords on pulse 2 come back as arpeggio notes with the right roots and chord shapes.
    const chords = flat(out, 1);
    expect(chords.map((n) => n.pitch)).toEqual(flat(song, 1).map((n) => n.pitch));
    expect(chords[0].fx.arp).toEqual([0, 3, 7]);
    // Drums: hits land on the same ticks.
    expect(flat(out, 3).map((n) => n.tick)).toEqual(flat(song, 3).map((n) => n.tick));
    // Identical bars are reused as one pattern.
    expect(out.patterns.length).toBe(1);
  });
});
