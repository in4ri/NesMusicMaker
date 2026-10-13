// NSF (NES Sound Format) export.
//
// The compiled per-frame register writes are packed into a byte stream and
// replayed by a tiny 6502 player. The NSF uses bank switching:
//   $8000-$8FFF  bank 0: player code + init table
//   $9000-$9FFF  stream window (slot 1, $5FF9), switched as the stream advances
//   $C000-$FFFF  DMC sample banks (where the hardware fetches samples from)
//
// Stream format, per frame:
//   $00-$1F vv   write vv to $4000+reg
//   $80-$FE      end of frame, then skip (byte & $7F) more frames
//   $FF bb ll hh loop: continue reading at bank bb, address hhll

import { Asm6502 } from './asm6502';
import { INIT_WRITES, type CompiledSong } from './compiler';
import { REGIONS } from './tables';

const BANK_SIZE = 0x1000;
const WINDOW = 0x9000;
const WINDOW_END_HI = 0xa0;
const FIRST_STREAM_BANK = 1;

// Zero page
const PTR = 0x00;
const BANK = 0x02;
const WAIT = 0x03;
const T0 = 0x04;
const T1 = 0x05;

export interface NsfInfo {
  title: string;
  author: string;
  copyright: string;
}

export function buildPlayer() {
  const a = new Asm6502(0x8000);

  a.label('init');
  a.ldxImm(0);
  a.label('init_loop');
  a.ldaAbsX('init_regs').cmpImm(0xff).beq('init_done');
  a.tay().ldaAbsX('init_vals').staAbsY(0x4000).inx().jmp('init_loop');
  a.label('init_done');
  a.ldaImm(FIRST_STREAM_BANK).staZp(BANK).staAbs(0x5ff9);
  a.ldaImm(WINDOW & 0xff).staZp(PTR).ldaImm(WINDOW >> 8).staZp(PTR + 1);
  a.ldaImm(0).staZp(WAIT);
  a.rts();

  a.label('play');
  a.ldaZp(WAIT).beq('read');
  a.decZp(WAIT).rts();
  a.label('read');
  a.jsr('getbyte').cmpImm(0x20).bcs('not_reg');
  a.tax().jsr('getbyte').staAbsX(0x4000).jmp('read');
  a.label('not_reg');
  a.cmpImm(0xff).beq('loop');
  a.andImm(0x7f).staZp(WAIT).rts();
  a.label('loop');
  a.jsr('getbyte').staZp(T0);
  a.jsr('getbyte').staZp(T1);
  a.jsr('getbyte').staZp(PTR + 1);
  a.ldaZp(T1).staZp(PTR);
  a.ldaZp(T0).staZp(BANK).staAbs(0x5ff9);
  a.jmp('read');

  // Read the next stream byte into A, advancing the pointer and switching banks at the window end.
  a.label('getbyte');
  a.ldyImm(0).ldaIndY(PTR);
  a.incZp(PTR).bne('gb_done');
  a.incZp(PTR + 1).ldyZp(PTR + 1).cpyImm(WINDOW_END_HI).bne('gb_done');
  a.ldyImm(WINDOW >> 8).styZp(PTR + 1);
  a.incZp(BANK).ldyZp(BANK).styAbs(0x5ff9);
  a.label('gb_done');
  a.rts();

  a.label('init_regs');
  a.byte(...INIT_WRITES.map(([r]) => r), 0xff);
  a.label('init_vals');
  a.byte(...INIT_WRITES.map(([, v]) => v));

  const code = a.assemble();
  return { code, initAddr: a.addr('init'), playAddr: a.addr('play') };
}

/** Pack the compiled frames into the player's stream format. */
export function encodeStream(song: CompiledSong): Uint8Array {
  const out: number[] = [];
  let loopOffset = -1;
  let f = 0;
  while (f < song.frameCount) {
    if (f === song.loopFrame) loopOffset = out.length;
    for (let i = song.frameIndex[f]; i < song.frameIndex[f + 1]; i += 2) out.push(song.writes[i], song.writes[i + 1]);
    // Merge following empty frames into this frame's terminator, but never across the loop point.
    let skip = 0;
    while (
      skip < 126 &&
      f + 1 + skip < song.frameCount &&
      f + 1 + skip !== song.loopFrame &&
      song.frameIndex[f + 1 + skip] === song.frameIndex[f + 2 + skip]
    ) skip++;
    out.push(0x80 | skip);
    f += 1 + skip;
  }

  if (loopOffset < 0) {
    // Not looping: silence everything, then idle forever.
    out.push(0x00, 0x30, 0x04, 0x30, 0x08, 0x80, 0x0c, 0x30, 0x15, 0x0f);
    loopOffset = out.length;
    out.push(0xfe);
  }
  const bank = FIRST_STREAM_BANK + Math.floor(loopOffset / BANK_SIZE);
  const addr = WINDOW + (loopOffset % BANK_SIZE);
  out.push(0xff, bank, addr & 0xff, addr >> 8);
  return Uint8Array.from(out);
}

function writeString(dst: Uint8Array, offset: number, s: string) {
  const ascii = s.replace(/[^\x20-\x7e]/g, '?').slice(0, 31);
  for (let i = 0; i < ascii.length; i++) dst[offset + i] = ascii.charCodeAt(i);
}

export function buildNsf(song: CompiledSong, info: NsfInfo, dmcBytesUsed: number): Uint8Array {
  const { code, initAddr, playAddr } = buildPlayer();
  if (code.length > BANK_SIZE) throw new Error('Player code too large');
  const stream = encodeStream(song);
  const streamBanks = Math.max(1, Math.ceil(stream.length / BANK_SIZE));
  const dmcBanks = dmcBytesUsed > 0 ? Math.ceil(dmcBytesUsed / BANK_SIZE) : 0;
  const totalBanks = 1 + streamBanks + dmcBanks;
  if (totalBanks > 256) throw new Error('Song is too long to fit in an NSF file');

  const data = new Uint8Array(totalBanks * BANK_SIZE);
  data.set(code, 0);
  data.set(stream, BANK_SIZE);
  const dmcFirstBank = 1 + streamBanks;
  if (dmcBanks) data.set(song.dmcMemory.subarray(0, dmcBanks * BANK_SIZE), dmcFirstBank * BANK_SIZE);

  const header = new Uint8Array(0x80);
  header.set([0x4e, 0x45, 0x53, 0x4d, 0x1a], 0); // "NESM\x1A"
  header[0x05] = 1; // version
  header[0x06] = 1; // songs
  header[0x07] = 1; // starting song
  const le16 = (o: number, v: number) => {
    header[o] = v & 0xff;
    header[o + 1] = (v >> 8) & 0xff;
  };
  le16(0x08, 0x8000);
  le16(0x0a, initAddr);
  le16(0x0c, playAddr);
  writeString(header, 0x0e, info.title);
  writeString(header, 0x2e, info.author);
  writeString(header, 0x4e, info.copyright);
  le16(0x6e, REGIONS.ntsc.nsfSpeedUs);
  const banks = [0, FIRST_STREAM_BANK, 0, 0];
  for (let i = 0; i < 4; i++) banks.push(i < dmcBanks ? dmcFirstBank + i : 0);
  header.set(banks, 0x70);
  le16(0x78, REGIONS.pal.nsfSpeedUs);
  header[0x7a] = song.region === 'pal' ? 1 : 0;

  const file = new Uint8Array(header.length + data.length);
  file.set(header, 0);
  file.set(data, header.length);
  return file;
}
