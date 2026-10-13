// Reading NSF files and running their music code: a 6502 with the NSF memory
// map (RAM, optional bank switching, $6000-$7FFF work RAM) wired to the APU.

import type { Apu } from './apu';
import { Cpu6502 } from './cpu6502';
import type { Region } from './tables';

export interface NsfHeader {
  version: number;
  songCount: number;
  startSong: number; // 1-based
  loadAddr: number;
  initAddr: number;
  playAddr: number;
  title: string;
  artist: string;
  copyright: string;
  /** Play routine rate in Hz for the chosen region. */
  playRate: number;
  region: Region;
  bankswitched: boolean;
  banks: number[];
  /** Names of Famicom expansion chips the file uses (their channels can't be played here). */
  expansion: string[];
}

export interface NsfFile {
  header: NsfHeader;
  data: Uint8Array;
}

const EXPANSION_CHIPS = ['VRC6', 'VRC7', 'FDS', 'MMC5', 'Namco 163', 'Sunsoft 5B'];

function str(bytes: Uint8Array, offset: number, len: number) {
  let s = '';
  for (let i = 0; i < len && bytes[offset + i]; i++) s += String.fromCharCode(bytes[offset + i]);
  return s.trim();
}

export function parseNsf(bytes: Uint8Array): NsfFile {
  if (bytes.length < 0x80 || str(bytes, 0, 4) !== 'NESM' || bytes[4] !== 0x1a) throw new Error('Not an NSF file');
  const le16 = (o: number) => bytes[o] | (bytes[o + 1] << 8);
  const banks = Array.from(bytes.subarray(0x70, 0x78));
  const regionBits = bytes[0x7a];
  const region: Region = (regionBits & 3) === 1 ? 'pal' : 'ntsc';
  const speed = region === 'pal' ? le16(0x78) : le16(0x6e);
  const defaultSpeed = region === 'pal' ? 19997 : 16639;
  const header: NsfHeader = {
    version: bytes[5],
    songCount: Math.max(1, bytes[6]),
    startSong: Math.max(1, bytes[7]),
    loadAddr: le16(8),
    initAddr: le16(0x0a),
    playAddr: le16(0x0c),
    title: str(bytes, 0x0e, 32),
    artist: str(bytes, 0x2e, 32),
    copyright: str(bytes, 0x4e, 32),
    playRate: 1_000_000 / (speed || defaultSpeed),
    region,
    bankswitched: banks.some((b) => b !== 0),
    banks,
    expansion: EXPANSION_CHIPS.filter((_, i) => bytes[0x7b] & (1 << i)),
  };
  return { header, data: bytes.subarray(0x80) };
}

/** Return address used to detect that INIT/PLAY has returned (never executed). */
const SENTINEL = 0x5ff0;

export class NsfMachine {
  readonly cpu: Cpu6502;
  private readonly ram = new Uint8Array(0x800);
  private readonly sram = new Uint8Array(0x2000);
  private readonly rom: Uint8Array;
  private banks: number[];
  /** Called for every APU register write ($4000-$4017, as 0x00-0x17). */
  onApuWrite: ((reg: number, value: number) => void) | null = null;

  constructor(readonly file: NsfFile, readonly apu: Apu | null) {
    const { header, data } = file;
    this.banks = [...header.banks];
    if (header.bankswitched) {
      const pad = header.loadAddr & 0xfff;
      this.rom = new Uint8Array(pad + data.length);
      this.rom.set(data, pad);
    } else {
      // Flat 32 KB at $8000 (anything loaded below $8000 goes to work RAM).
      this.rom = new Uint8Array(0x8000);
      this.loadFlat();
    }
    this.cpu = new Cpu6502(
      (a) => this.read(a),
      (a, v) => this.write(a, v),
    );
  }

  private loadFlat() {
    const { header, data } = this.file;
    for (let i = 0; i < data.length; i++) {
      const addr = header.loadAddr + i;
      if (addr >= 0x8000 && addr <= 0xffff) this.rom[addr - 0x8000] = data[i];
      else if (addr >= 0x6000 && addr < 0x8000) this.sram[addr - 0x6000] = data[i];
    }
  }

  read(addr: number): number {
    if (addr < 0x2000) return this.ram[addr & 0x7ff];
    if (addr === 0x4015) return this.apu ? this.apu.readStatus() : 0;
    if (addr >= 0x6000 && addr < 0x8000) return this.sram[addr - 0x6000];
    if (addr >= 0x8000) {
      if (!this.file.header.bankswitched) return this.rom[addr - 0x8000];
      const bank = this.banks[(addr - 0x8000) >> 12];
      const off = bank * 0x1000 + (addr & 0xfff);
      return off < this.rom.length ? this.rom[off] : 0;
    }
    return 0;
  }

  write(addr: number, v: number) {
    if (addr < 0x2000) this.ram[addr & 0x7ff] = v;
    else if (addr >= 0x4000 && addr <= 0x4017) {
      this.apu?.write(addr, v);
      this.onApuWrite?.(addr - 0x4000, v);
    } else if (addr >= 0x5ff8 && addr <= 0x5fff) this.banks[addr - 0x5ff8] = v;
    else if (addr >= 0x6000 && addr < 0x8000) this.sram[addr - 0x6000] = v;
    // Writes to ROM and expansion-chip registers are ignored.
  }

  private call(addr: number, maxCycles: number) {
    const cpu = this.cpu;
    cpu.s = 0xfd;
    cpu.i = 1;
    cpu.callFrom(addr, SENTINEL);
    const limit = cpu.cycles + maxCycles;
    while (cpu.pc !== SENTINEL && cpu.cycles < limit && !cpu.jammed) cpu.step();
  }

  /** Reset and run the INIT routine for a track (0-based), as an NSF player does. */
  init(track: number) {
    this.ram.fill(0);
    this.sram.fill(0);
    if (!this.file.header.bankswitched) this.loadFlat();
    this.banks = [...this.file.header.banks];
    for (let r = 0; r < 0x14; r++) this.write(0x4000 + r, 0);
    this.write(0x4015, 0);
    this.write(0x4015, 0x0f);
    this.write(0x4017, 0x40);
    const cpu = this.cpu;
    cpu.a = track;
    cpu.x = this.file.header.region === 'pal' ? 1 : 0;
    cpu.y = 0;
    this.call(this.file.header.initAddr, 2_000_000);
  }

  /** Run one frame of the PLAY routine. */
  play() {
    this.call(this.file.header.playAddr, 100_000);
  }
}
