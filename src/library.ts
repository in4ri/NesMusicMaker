// The user's preset library (instruments + samples), kept outside any one song and saved automatically.

import { create } from 'zustand';
import { toast } from './actions';
import { layoutDmc } from './core/dmc';
import {
  addInstrumentToLibrary,
  addSampleToLibrary,
  emptyLibrary,
  instrumentIntoSong,
  mergeLibraries,
  normalizeLibrary,
  sampleIntoSong,
  type PresetLibrary,
} from './model/library';
import { useStore } from './model/store';
import type { DmcSample, Instrument } from './model/types';
import { loadLibraryText, pickFile, saveBinaryFile, saveLibraryText } from './platform/files';

export const useLibrary = create<{ library: PresetLibrary; loaded: boolean }>(() => ({ library: emptyLibrary(), loaded: false }));

export async function loadLibrary() {
  try {
    const text = await loadLibraryText();
    useLibrary.setState({ library: text ? normalizeLibrary(JSON.parse(text)) : emptyLibrary(), loaded: true });
  } catch {
    useLibrary.setState({ library: emptyLibrary(), loaded: true });
  }
}

/** Apply a change to the library and save it. */
function change(fn: (lib: PresetLibrary) => void) {
  const lib = structuredClone(useLibrary.getState().library);
  fn(lib);
  useLibrary.setState({ library: lib });
  void saveLibraryText(JSON.stringify(lib)).then((ok) => !ok && toast('Could not save the preset library', 'error'));
}

export function saveInstrumentPreset(inst: Instrument) {
  let added = false;
  change((lib) => (added = addInstrumentToLibrary(lib, inst)));
  toast(added ? `Saved "${inst.name}" to your preset library` : `"${inst.name}" is already in your library (same sound)`);
}

export function saveSamplePreset(sample: DmcSample) {
  let added = false;
  change((lib) => (added = addSampleToLibrary(lib, sample)));
  toast(added ? `Saved sample "${sample.name}" to your preset library` : `"${sample.name}" is already in your library`);
}

export function removePreset(libId: string) {
  change((lib) => {
    lib.instruments = lib.instruments.filter((e) => e.libId !== libId);
    lib.samples = lib.samples.filter((e) => e.libId !== libId);
  });
}

export function renamePreset(libId: string, name: string) {
  const clean = name.trim().slice(0, 32);
  if (!clean) return;
  change((lib) => {
    for (const e of lib.instruments) if (e.libId === libId) e.instrument.name = clean;
    for (const e of lib.samples) if (e.libId === libId) e.sample.name = clean;
  });
}

/** Add a library (or built-in) instrument to the current song and open it. */
export function addPresetInstrumentToSong(preset: Omit<Instrument, 'id'>) {
  let id = '';
  useStore.getState().update((song) => {
    id = instrumentIntoSong(song, preset);
  });
  useStore.getState().set({ selectedInstrumentId: id, view: 'instrument' });
  toast(`Added "${preset.name}" to this song`);
}

export function addPresetSampleToSong(preset: Omit<DmcSample, 'id'>) {
  let index = 0;
  useStore.getState().update((song) => {
    index = sampleIntoSong(song, preset);
  });
  const fits = layoutDmc(useStore.getState().song.samples).entries[index];
  toast(fits ? `Added sample "${preset.name}" to this song` : `Added "${preset.name}", but DMC memory (16 KB) is full: it won't play`, fits ? 'info' : 'error');
}

export async function exportLibrary() {
  const lib = useLibrary.getState().library;
  const bytes = new TextEncoder().encode(JSON.stringify(lib, null, 1));
  const path = await saveBinaryFile('NES Presets.nesmm-presets', 'NES Music Maker presets', 'nesmm-presets', bytes);
  if (path !== null) toast(`Exported ${lib.instruments.length} instruments and ${lib.samples.length} samples`);
}

export async function importLibrary() {
  const file = await pickFile('.nesmm-presets,.json');
  if (!file) return;
  try {
    const incoming = normalizeLibrary(JSON.parse(await file.text()));
    if (!incoming.instruments.length && !incoming.samples.length) throw new Error('No presets found in that file');
    let added = 0;
    change((lib) => (added = mergeLibraries(lib, incoming)));
    toast(added ? `Imported ${added} preset${added === 1 ? '' : 's'}` : 'Those presets are already in your library');
  } catch (e) {
    toast(`Could not import presets: ${(e as Error).message}`, 'error');
  }
}
