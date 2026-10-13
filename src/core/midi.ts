// Standard MIDI File (.mid) parser: notes, tempo and time signature.

export interface MidiNote {
  tick: number;
  length: number;
  pitch: number;
  velocity: number; // 1..127
  channel: number;  // 0..15 (9 = General MIDI drums)
}

export interface MidiTrack {
  name: string;
  notes: MidiNote[];
}

export interface MidiFile {
  format: number;
  ppq: number;
  /** First tempo in the file, or null (120 BPM is the MIDI default). */
  bpm: number | null;
  tempoChanges: number;
  timeSignature: [number, number] | null;
  tracks: MidiTrack[];
}

class Reader {
  pos = 0;
  constructor(readonly bytes: Uint8Array) {}
  get done() {
    return this.pos >= this.bytes.length;
  }
  u8() {
    if (this.pos >= this.bytes.length) throw new Error('Unexpected end of MIDI data');
    return this.bytes[this.pos++];
  }
  u16() {
    return (this.u8() << 8) | this.u8();
  }
  u32() {
    return ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0;
  }
  str(n: number) {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8());
    return s;
  }
  vlq() {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.u8();
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
    throw new Error('Bad variable-length value in MIDI data');
  }
}

export function parseMidi(bytes: Uint8Array): MidiFile {
  const r = new Reader(bytes);
  if (r.str(4) !== 'MThd') throw new Error('Not a MIDI file');
  const headerLen = r.u32();
  const format = r.u16();
  const trackCount = r.u16();
  const division = r.u16();
  r.pos += headerLen - 6;
  if (division & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported');
  const ppq = division || 96;

  let bpm: number | null = null;
  let tempoChanges = 0;
  let timeSignature: [number, number] | null = null;
  const tracks: MidiTrack[] = [];

  for (let t = 0; t < trackCount && !r.done; t++) {
    const id = r.str(4);
    const len = r.u32();
    const end = r.pos + len;
    if (id !== 'MTrk') {
      r.pos = end;
      continue;
    }
    const track: MidiTrack = { name: '', notes: [] };
    const open = new Map<number, { tick: number; velocity: number }[]>(); // key = channel*128+pitch
    let tick = 0;
    let status = 0;

    const noteOff = (channel: number, pitch: number, at: number) => {
      const starts = open.get(channel * 128 + pitch);
      const start = starts?.shift();
      if (start && at > start.tick) track.notes.push({ tick: start.tick, length: at - start.tick, pitch, velocity: start.velocity, channel });
    };

    while (r.pos < end) {
      tick += r.vlq();
      let b = r.u8();
      if (b < 0x80) {
        // Running status: reuse the previous status byte.
        if (!status) throw new Error('Corrupt MIDI track (running status without status)');
        r.pos--;
        b = status;
      }
      if (b === 0xff) {
        const type = r.u8();
        const n = r.vlq();
        const dataStart = r.pos;
        if (type === 0x03 && !track.name) track.name = r.str(n).trim();
        else if (type === 0x51 && n === 3) {
          const us = (r.u8() << 16) | (r.u8() << 8) | r.u8();
          if (bpm === null) bpm = Math.round((60_000_000 / us) * 100) / 100;
          tempoChanges++;
        } else if (type === 0x58 && n >= 2 && !timeSignature) {
          timeSignature = [r.u8(), 1 << r.u8()];
        }
        r.pos = dataStart + n;
        if (type === 0x2f) break;
        continue;
      }
      if (b === 0xf0 || b === 0xf7) {
        r.pos += r.vlq();
        continue;
      }
      status = b;
      const type = b & 0xf0;
      const channel = b & 0x0f;
      if (type === 0x90 || type === 0x80) {
        const pitch = r.u8() & 0x7f;
        const velocity = r.u8() & 0x7f;
        if (type === 0x90 && velocity > 0) {
          const key = channel * 128 + pitch;
          if (!open.has(key)) open.set(key, []);
          open.get(key)!.push({ tick, velocity });
        } else {
          noteOff(channel, pitch, tick);
        }
      } else if (type === 0xc0 || type === 0xd0) {
        r.u8();
      } else {
        r.u8();
        r.u8();
      }
    }
    // Close any notes left hanging at the end of the track.
    for (const [key, starts] of open) for (const s of starts) if (tick > s.tick) track.notes.push({ tick: s.tick, length: tick - s.tick, pitch: key % 128, velocity: s.velocity, channel: Math.floor(key / 128) });
    track.notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
    tracks.push(track);
    r.pos = end;
  }

  return { format, ppq, bpm, tempoChanges, timeSignature, tracks };
}
