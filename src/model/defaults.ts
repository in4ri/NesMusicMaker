import {
  CHANNELS,
  TICKS_PER_STEP,
  newId,
  type Envelope,
  type Instrument,
  type Note,
  type NoteFx,
  type Pattern,
  type Song,
} from './types';

export const PATTERN_COLORS = ['#5c7cfa', '#20c997', '#f06595', '#fab005', '#845ef7', '#ff922b', '#15aabf', '#94d82d'];
export const INSTRUMENT_COLORS = ['#ff8787', '#ffc078', '#8ce99a', '#74c0fc', '#b197fc', '#faa2c1', '#ffe066', '#66d9e8'];

export function env(values: number[], loop = -1, release = -1): Envelope {
  return { values, loop, release };
}

export function makeInstrument(name: string, parts: Partial<Omit<Instrument, 'id' | 'name'>> = {}, colorIndex = 0): Instrument {
  return {
    id: newId('i'),
    name,
    color: parts.color ?? INSTRUMENT_COLORS[colorIndex % INSTRUMENT_COLORS.length],
    volume: parts.volume ?? env([15]),
    arpeggio: parts.arpeggio ?? env([0]),
    pitch: parts.pitch ?? env([0]),
    duty: parts.duty ?? env([2]),
  };
}

export function defaultInstruments(): Instrument[] {
  let c = 0;
  const mk = (name: string, parts: Partial<Omit<Instrument, 'id' | 'name'>>) => makeInstrument(name, parts, c++);
  return [
    mk('Lead 25%', { volume: env([15, 14, 13, 12, 11, 10, 8, 6, 4, 2, 0], -1, 6), duty: env([1]) }),
    mk('Pluck', { volume: env([15, 12, 10, 9, 8, 7, 6, 5, 4, 3, 3, 2, 2, 1, 1, 0]), duty: env([2, 2, 1]) }),
    mk('Square 50%', { volume: env([12, 12, 11, 11, 10, 8, 6, 4, 2, 0], -1, 4), duty: env([2]) }),
    mk('Thin 12.5%', { volume: env([13, 12, 11, 10, 9, 9, 6, 3, 0], -1, 6), duty: env([0]) }),
    mk('Vibrato Lead', {
      volume: env([14, 13, 12, 11, 11, 7, 4, 2, 0], -1, 5),
      pitch: env([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 4, 5, 4, 2, 0, -2, -4, -5, -4, -2], 15),
      duty: env([1]),
    }),
    mk('Chord Major', { volume: env([11, 10, 9, 9, 8, 8, 6, 4, 2, 0], -1, 6), arpeggio: env([0, 4, 7], 0), duty: env([2]) }),
    mk('Chord Minor', { volume: env([11, 10, 9, 9, 8, 8, 6, 4, 2, 0], -1, 6), arpeggio: env([0, 3, 7], 0), duty: env([2]) }),
    mk('Triangle Bass', { volume: env([15]) }),
    mk('Triangle Kick', { volume: env([15, 15, 15, 15, 15, 0]), arpeggio: env([24, 12, 5, 0, -5, -12]) }),
    mk('Noise Kick', { volume: env([15, 13, 10, 7, 4, 2, 0]), arpeggio: env([0, -3, -5, -7, -8, -9, -10]), duty: env([0]) }),
    mk('Noise Snare', { volume: env([15, 13, 11, 9, 7, 6, 5, 4, 3, 2, 1, 0]), arpeggio: env([2, 0]), duty: env([0]) }),
    mk('Closed Hat', { volume: env([10, 6, 3, 1, 0]), duty: env([0]) }),
    mk('Open Hat', { volume: env([10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]), duty: env([0]) }),
    mk('Metal Hit', { volume: env([14, 12, 10, 8, 6, 4, 2, 0]), duty: env([1]) }),
  ];
}

export function emptyPattern(name: string, colorIndex: number, bars = 1): Pattern {
  return {
    id: newId('p'),
    name,
    color: PATTERN_COLORS[colorIndex % PATTERN_COLORS.length],
    bars,
    notes: CHANNELS.map(() => []),
  };
}

export function makeNote(tick: number, length: number, pitch: number, instrument: string, volume = 15, fx: NoteFx = {}): Note {
  return { id: newId('n'), tick, length, pitch, volume, instrument, fx };
}

export function emptySong(): Song {
  const instruments = defaultInstruments();
  const byName = (n: string) => instruments.find((i) => i.name === n)!.id;
  return {
    format: 'nes-music-maker',
    version: 1,
    title: 'Untitled',
    author: '',
    copyright: '',
    bpm: 150,
    region: 'ntsc',
    beatsPerBar: 4,
    instruments,
    samples: [],
    patterns: [emptyPattern('Pattern 1', 0)],
    playlist: [],
    loopStart: 0,
    channels: [
      { stepPitch: 72, instrument: byName('Lead 25%') },
      { stepPitch: 67, instrument: byName('Pluck') },
      { stepPitch: 45, instrument: byName('Triangle Bass') },
      { stepPitch: 12, instrument: byName('Noise Snare') },
      { stepPitch: 0, instrument: '' },
    ],
    automation: [],
  };
}

/** A short demo tune so the app makes sound out of the box. */
export function demoSong(): Song {
  const song = emptySong();
  song.title = 'Demo Tune';
  const id = (n: string) => song.instruments.find((i) => i.name === n)!.id;
  const S = TICKS_PER_STEP;
  const pattern = emptyPattern('Groove', 0, 2);
  const [lead, chords, bass, drums] = pattern.notes;

  const melody: [number, number, number][] = [
    [0, 76, 4], [4, 72, 2], [6, 74, 2], [8, 77, 4], [12, 76, 2], [14, 74, 2],
    [16, 72, 4], [20, 74, 2], [22, 76, 2], [24, 74, 6], [30, 71, 2],
  ];
  for (const [step, pitch, len] of melody) {
    const fx: NoteFx = len >= 4 ? { vibratoDepth: 3, vibratoSpeed: 6 } : {};
    lead.push(makeNote(step * S, len * S, pitch, '', 15, fx));
  }

  const progression: [number, number[]][] = [[69, [0, 3, 7]], [65, [0, 4, 7]], [72, [0, 4, 7]], [67, [0, 4, 7]]];
  progression.forEach(([pitch, arp], i) => {
    chords.push(makeNote(i * 8 * S, 8 * S, pitch, '', 7, { arp }));
  });

  const roots = [45, 41, 48, 43];
  roots.forEach((root, i) => {
    for (let k = 0; k < 4; k++) bass.push(makeNote((i * 8 + k * 2) * S, 2 * S, k % 2 ? root + 12 : root, ''));
  });

  for (let bar = 0; bar < 2; bar++) {
    const o = bar * 16;
    for (const s of [0, 8, 10]) drums.push(makeNote((o + s) * S, S, 6, id('Noise Kick')));
    for (const s of [4, 12]) drums.push(makeNote((o + s) * S, S, 9, ''));
    for (const s of [2, 6, 14]) drums.push(makeNote((o + s) * S, S, 15, id('Closed Hat'), 12));
  }

  song.channels[1].instrument = id('Square 50%');
  song.patterns = [pattern];
  song.playlist = [
    { id: newId('c'), pattern: pattern.id, track: 0, start: 0 },
    { id: newId('c'), pattern: pattern.id, track: 0, start: 2 * 4 * 48 },
  ];
  return song;
}
