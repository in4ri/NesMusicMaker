import { describe, expect, it } from 'vitest';
import {
  addInstrumentToLibrary,
  addSampleToLibrary,
  emptyLibrary,
  instrumentIntoSong,
  mergeLibraries,
  normalizeLibrary,
  sampleIntoSong,
  uniqueName,
} from '../src/model/library';
import { demoSong } from '../src/model/defaults';

describe('preset library', () => {
  it('saves instruments once per sound (names and colours ignored)', () => {
    const lib = emptyLibrary();
    const song = demoSong();
    const lead = song.instruments[0];
    expect(addInstrumentToLibrary(lib, lead)).toBe(true);
    expect(addInstrumentToLibrary(lib, { ...lead, id: 'other', name: 'Renamed', color: '#000000' })).toBe(false);
    expect(addInstrumentToLibrary(lib, song.instruments[1])).toBe(true);
    expect(lib.instruments.map((e) => e.instrument.name)).toEqual([song.instruments[1].name, lead.name]);
    expect('id' in lib.instruments[0].instrument).toBe(false);
  });

  it('adds presets to a song with fresh ids and unique names', () => {
    const song = demoSong();
    const lead = song.instruments.find((i) => i.name === 'Lead 25%')!;
    const id = instrumentIntoSong(song, { ...lead });
    const added = song.instruments.find((i) => i.id === id)!;
    expect(added.name).toBe('Lead 25% 2');
    expect(added.id).not.toBe(lead.id);
    expect(uniqueName('Kick', ['Kick', 'Kick 2'])).toBe('Kick 3');

    const sample = { name: 'Kick', data: 'AAAA', rate: 15, loop: false, initialLevel: -1 };
    expect(sampleIntoSong(song, sample)).toBe(0);
    expect(sampleIntoSong(song, sample)).toBe(1);
    expect(song.samples.map((s) => s.name)).toEqual(['Kick', 'Kick 2']);
  });

  it('merges imported libraries without duplicates and rejects junk', () => {
    const a = emptyLibrary();
    const b = emptyLibrary();
    const song = demoSong();
    addInstrumentToLibrary(a, song.instruments[0]);
    addInstrumentToLibrary(b, song.instruments[0]);
    addInstrumentToLibrary(b, song.instruments[2]);
    addSampleToLibrary(b, { id: 's', name: 'Snare', data: 'BBBB', rate: 14, loop: false, initialLevel: -1 });
    expect(mergeLibraries(a, b)).toBe(2);
    expect(a.instruments).toHaveLength(2);
    expect(a.samples).toHaveLength(1);
    expect(normalizeLibrary({ format: 'something-else' }).instruments).toEqual([]);
    expect(normalizeLibrary(JSON.parse(JSON.stringify(a))).instruments).toHaveLength(2);
  });
});
