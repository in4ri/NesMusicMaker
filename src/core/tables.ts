// NES 2A03 hardware constants (NTSC and PAL variants).

export type Region = 'ntsc' | 'pal';

export interface RegionInfo {
  cpuClock: number;   // CPU cycles per second
  frameRate: number;  // driver ticks per second (NSF play rate)
  nsfSpeedUs: number; // NSF header play speed in microseconds
  noisePeriods: number[];
  dmcRates: number[]; // CPU cycles per DMC output bit
  frameCounterStep: number; // CPU cycles between quarter-frame clocks (approx.)
}

export const REGIONS: Record<Region, RegionInfo> = {
  ntsc: {
    cpuClock: 1789773,
    frameRate: 1789773 / 29780.5,
    nsfSpeedUs: 16639,
    noisePeriods: [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068],
    dmcRates: [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54],
    frameCounterStep: 7457,
  },
  pal: {
    cpuClock: 1662607,
    frameRate: 1662607 / 33247.5,
    nsfSpeedUs: 19997,
    noisePeriods: [4, 8, 14, 30, 60, 88, 118, 148, 188, 236, 354, 472, 708, 944, 1890, 3778],
    dmcRates: [398, 354, 316, 298, 276, 236, 210, 198, 176, 148, 132, 118, 98, 78, 66, 50],
    frameCounterStep: 8313,
  },
};

export const LENGTH_TABLE = [
  10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14,
  12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30,
];

export const DUTY_SEQUENCES = [
  [0, 1, 0, 0, 0, 0, 0, 0], // 12.5%
  [0, 1, 1, 0, 0, 0, 0, 0], // 25%
  [0, 1, 1, 1, 1, 0, 0, 0], // 50%
  [1, 0, 0, 1, 1, 1, 1, 1], // 25% negated (75%)
];

export const TRIANGLE_SEQUENCE = [
  15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
];

/** DMC sample memory lives at $C000-$FFFF (as on real hardware). */
export const DMC_BASE = 0xc000;
export const DMC_MEMORY_SIZE = 0x4000;

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function noteName(midi: number): string {
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

export function midiToFreq(pitch: number): number {
  return 440 * Math.pow(2, (pitch - 69) / 12);
}

/** 11-bit timer period for a pulse channel at the given (fractional) MIDI pitch. */
export function pulsePeriod(pitch: number, region: Region): number {
  const p = Math.round(REGIONS[region].cpuClock / (16 * midiToFreq(pitch))) - 1;
  return Math.max(0, Math.min(0x7ff, p));
}

/** Triangle runs one octave lower than pulse for the same period. */
export function trianglePeriod(pitch: number, region: Region): number {
  const p = Math.round(REGIONS[region].cpuClock / (32 * midiToFreq(pitch))) - 1;
  return Math.max(0, Math.min(0x7ff, p));
}
