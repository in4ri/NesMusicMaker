// The preset library: instruments and DMC samples saved for use in any song.

import { newId, type DmcSample, type Instrument, type Song } from './types';

export interface LibraryInstrument {
  libId: string;
  savedAt: number;
  instrument: Omit<Instrument, 'id'>;
}

export interface LibrarySample {
  libId: string;
  savedAt: number;
  sample: Omit<DmcSample, 'id'>;
}

export interface PresetLibrary {
  format: 'nes-music-maker-library';
  version: 1;
  instruments: LibraryInstrument[];
  samples: LibrarySample[];
}

export function emptyLibrary(): PresetLibrary {
  return { format: 'nes-music-maker-library', version: 1, instruments: [], samples: [] };
}

/** Accept a stored or imported library, dropping anything malformed. */
export function normalizeLibrary(raw: unknown): PresetLibrary {
  const lib = emptyLibrary();
  const r = raw as Partial<PresetLibrary> | null;
  if (!r || typeof r !== 'object' || r.format !== 'nes-music-maker-library') return lib;
  lib.instruments = (r.instruments ?? []).filter((e) => e && e.instrument && Array.isArray(e.instrument.volume?.values));
  lib.samples = (r.samples ?? []).filter((e) => e && e.sample && typeof e.sample.data === 'string');
  return lib;
}

/** Two instruments sound the same if all their envelopes match (names and colours don't matter). */
export function sameSound(a: Omit<Instrument, 'id'>, b: Omit<Instrument, 'id'>) {
  const key = (i: Omit<Instrument, 'id'>) => JSON.stringify([i.volume, i.arpeggio, i.pitch, i.duty]);
  return key(a) === key(b);
}

export function sameSample(a: Omit<DmcSample, 'id'>, b: Omit<DmcSample, 'id'>) {
  return a.data === b.data && a.rate === b.rate && a.loop === b.loop;
}

function stripId<T extends { id: string }>(x: T): Omit<T, 'id'> {
  const { id: _id, ...rest } = structuredClone(x);
  return rest;
}

/** Add an instrument to the library; returns false if the same sound is already there. */
export function addInstrumentToLibrary(lib: PresetLibrary, inst: Instrument): boolean {
  const entry = stripId(inst);
  if (lib.instruments.some((e) => sameSound(e.instrument, entry))) return false;
  lib.instruments.unshift({ libId: newId('L'), savedAt: Date.now(), instrument: entry });
  return true;
}

export function addSampleToLibrary(lib: PresetLibrary, sample: DmcSample): boolean {
  const entry = stripId(sample);
  if (lib.samples.some((e) => sameSample(e.sample, entry))) return false;
  lib.samples.unshift({ libId: newId('L'), savedAt: Date.now(), sample: entry });
  return true;
}

/** A name not already used in `names` ("Lead", "Lead 2", "Lead 3"…). */
export function uniqueName(name: string, names: string[]) {
  if (!names.includes(name)) return name;
  let n = 2;
  while (names.includes(`${name} ${n}`)) n++;
  return `${name} ${n}`;
}

/** Copy a library instrument into a song (a song draft); returns the new instrument's id. */
export function instrumentIntoSong(song: Song, preset: Omit<Instrument, 'id'>): string {
  const id = newId('i');
  song.instruments.push({ ...structuredClone(preset), id, name: uniqueName(preset.name, song.instruments.map((i) => i.name)) });
  return id;
}

/** Copy a library sample into a song (a song draft); returns the new sample's index. */
export function sampleIntoSong(song: Song, preset: Omit<DmcSample, 'id'>): number {
  song.samples.push({ ...structuredClone(preset), id: newId('s'), name: uniqueName(preset.name, song.samples.map((s) => s.name)) });
  return song.samples.length - 1;
}

/** Merge an imported library into an existing one, skipping duplicates. Returns how many were added. */
export function mergeLibraries(into: PresetLibrary, from: PresetLibrary) {
  let added = 0;
  for (const e of [...from.instruments].reverse()) {
    if (into.instruments.some((x) => sameSound(x.instrument, e.instrument))) continue;
    into.instruments.unshift({ ...e, libId: newId('L') });
    added++;
  }
  for (const e of [...from.samples].reverse()) {
    if (into.samples.some((x) => sameSample(x.sample, e.sample))) continue;
    into.samples.unshift({ ...e, libId: newId('L') });
    added++;
  }
  return added;
}
