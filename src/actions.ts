// User-level commands: file operations, exports, sample import, pattern management.

import { create } from 'zustand';
import { engine } from './audio/engine';
import { compileSong } from './core/compiler';
import { checkSong } from './core/hardwareCheck';
import { bytesToBase64, encodeDmc, layoutDmc } from './core/dmc';
import { buildNsf } from './core/nsf';
import { renderWav } from './core/wav';
import { defaultInstruments, emptyPattern, emptySong, env, INSTRUMENT_COLORS } from './model/defaults';
import { currentPattern, fixSelection, useStore } from './model/store';
import { adoptChannelSounds, adoptPalette } from './model/migrate';
import { CHANNELS, newId, type Instrument, type Song } from './model/types';
import { openProjectFile, pickFile, saveBinaryFile, saveProjectFile } from './platform/files';

// ---------- Toasts ----------

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
}
export const useToasts = create<{ toasts: Toast[] }>(() => ({ toasts: [] }));
let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info') {
  const id = ++toastId;
  useToasts.setState((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
  setTimeout(() => useToasts.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 6000 : 3000);
}

// ---------- Projects ----------

function confirmDiscard() {
  return !useStore.getState().dirty || window.confirm('Discard unsaved changes?');
}

function fileBaseName(s: string) {
  return (s || 'Untitled').replace(/[\\/:*?"<>|]+/g, '_');
}

/** Fill in anything missing from an older or hand-edited project file. */
export function normalizeSong(raw: unknown): Song {
  const base = emptySong();
  const s = raw as Partial<Song>;
  if (!s || typeof s !== 'object' || s.format !== 'nes-music-maker') throw new Error('Not an NES Music Maker project');
  const song: Song = { ...base, ...s } as Song;
  song.instruments = (s.instruments?.length ? s.instruments : defaultInstruments()).map((i) => ({
    ...i,
    volume: i.volume ?? env([15]),
    arpeggio: i.arpeggio ?? env([0]),
    pitch: i.pitch ?? env([0]),
    duty: i.duty ?? env([2]),
  }));
  song.samples = s.samples ?? [];
  song.patterns = (s.patterns?.length ? s.patterns : base.patterns).map((p) => ({
    ...p,
    notes: CHANNELS.map((_, ch) => (p.notes?.[ch] ?? []).map((n) => ({ ...n, fx: n.fx ?? {} }))),
  }));
  song.playlist = s.playlist ?? [];
  song.channels = CHANNELS.map((_, ch) => s.channels?.[ch] ?? base.channels[ch]);
  song.automation = (s.automation ?? []).filter((l) => l && Array.isArray(l.points));
  adoptChannelSounds(song);
  adoptPalette(song);
  return song;
}

export function newProject() {
  if (!confirmDiscard()) return;
  useStore.getState().loadSong(emptySong(), null);
}

export function loadProjectText(text: string, path: string | null) {
  try {
    useStore.getState().loadSong(normalizeSong(JSON.parse(text)), path);
    toast('Project loaded');
  } catch (e) {
    toast(`Could not open project: ${(e as Error).message}`, 'error');
  }
}

export async function openProject() {
  if (!confirmDiscard()) return;
  const file = await openProjectFile();
  if (file) loadProjectText(file.text, file.path);
}

export async function saveProject(saveAs = false) {
  const s = useStore.getState();
  const text = JSON.stringify(s.song);
  const path = await saveProjectFile(saveAs ? null : s.filePath, text, `${fileBaseName(s.song.title)}.nesmm`);
  if (path === null) return;
  useStore.setState({ filePath: path || s.filePath, dirty: false });
  toast('Project saved');
}

// ---------- Export ----------

/** The hardware check window; `pendingExport` is set when it was opened by an export. */
export const useCheck = create<{ open: boolean; pendingExport: 'wav' | 'nsf' | null }>(() => ({ open: false, pendingExport: null }));

/** Show the hardware check instead of exporting if anything won't play as drawn. */
function blockedByCheck(kind: 'wav' | 'nsf') {
  if (!checkSong(useStore.getState().song).some((i) => i.severity === 'error')) return false;
  useCheck.setState({ open: true, pendingExport: kind });
  return true;
}

export async function exportWav(force = false) {
  if (!force && blockedByCheck('wav')) return;
  const { song } = useStore.getState();
  toast('Rendering WAV…');
  await new Promise((r) => setTimeout(r, 30));
  try {
    const compiled = compileSong(song, { mode: 'song' });
    const wav = renderWav(compiled);
    const path = await saveBinaryFile(`${fileBaseName(song.title)}.wav`, 'WAV audio', 'wav', wav);
    if (path !== null) toast('WAV exported');
  } catch (e) {
    toast(`WAV export failed: ${(e as Error).message}`, 'error');
  }
}

export async function exportNsf(force = false) {
  if (!force && blockedByCheck('nsf')) return;
  const { song } = useStore.getState();
  try {
    const compiled = compileSong(song, { mode: 'song' });
    const layout = layoutDmc(song.samples);
    const nsf = buildNsf(compiled, { title: song.title, author: song.author, copyright: song.copyright }, layout.used);
    const path = await saveBinaryFile(`${fileBaseName(song.title)}.nsf`, 'NES Sound Format', 'nsf', nsf);
    if (path !== null) toast(`NSF exported (${(nsf.length / 1024).toFixed(1)} KB)`);
  } catch (e) {
    toast(`NSF export failed: ${(e as Error).message}`, 'error');
  }
}

// ---------- Samples ----------

export async function importSample() {
  const file = await pickFile('audio/*,.wav,.mp3,.ogg,.flac,.aiff');
  if (!file) return;
  try {
    const { pcm, sampleRate } = await engine.decodeAudio(await file.arrayBuffer());
    const s = useStore.getState();
    const rate = 15;
    const bytes = encodeDmc(pcm, sampleRate, rate, s.song.region);
    const sample = { id: newId('s'), name: file.name.replace(/\.[^.]+$/, '').slice(0, 24), data: bytesToBase64(bytes), rate, loop: false, initialLevel: -1 };
    const layout = layoutDmc([...s.song.samples, sample]);
    s.update((song) => {
      song.samples.push(sample);
    });
    if (!layout.entries[layout.entries.length - 1]) toast('Sample added, but DMC memory (16 KB) is full: it will not play', 'error');
    else toast(`Imported "${sample.name}" (${bytes.length} bytes)`);
  } catch (e) {
    toast(`Could not import audio: ${(e as Error).message}`, 'error');
  }
}

export function deleteSample(index: number) {
  useStore.getState().update((song) => {
    song.samples.splice(index, 1);
    // DMC notes reference samples by index: drop notes for the removed sample and shift the rest.
    for (const p of song.patterns) {
      p.notes[4] = p.notes[4].filter((n) => n.pitch !== index);
      for (const n of p.notes[4]) if (n.pitch > index) n.pitch--;
    }
  });
}

// ---------- Patterns ----------

export function addPattern(clone = false) {
  const s = useStore.getState();
  const src = currentPattern(s);
  const id = newId('p');
  s.update((song) => {
    const n = song.patterns.length;
    const p = clone && src ? { ...structuredClone(src), id, name: `${src.name} copy` } : { ...emptyPattern(`Pattern ${n + 1}`, n, src?.bars ?? 1), id };
    if (clone) p.notes = p.notes.map((list) => list.map((note) => ({ ...note, id: newId('n') })));
    song.patterns.push(p);
  });
  s.set({ selectedPatternId: id, selectedNoteIds: [] });
}

export function deletePattern() {
  const s = useStore.getState();
  if (s.song.patterns.length <= 1) {
    toast('A song needs at least one pattern', 'error');
    return;
  }
  const id = s.selectedPatternId;
  s.update((song) => {
    song.patterns = song.patterns.filter((p) => p.id !== id);
    song.playlist = song.playlist.filter((c) => c.pattern !== id);
  });
  fixSelection();
}

// ---------- Instruments ----------

export function addInstrument(clone?: Instrument) {
  const s = useStore.getState();
  const id = newId('i');
  s.update((song) => {
    const n = song.instruments.length;
    const inst: Instrument = clone
      ? { ...structuredClone(clone), id, name: `${clone.name} copy` }
      : {
          id,
          name: `Instrument ${n + 1}`,
          color: INSTRUMENT_COLORS[n % INSTRUMENT_COLORS.length],
          volume: env([15, 14, 12, 10, 8, 6, 4, 2, 0], -1, 4),
          arpeggio: env([0]),
          pitch: env([0]),
          duty: env([2]),
        };
    song.instruments.push(inst);
  });
  s.set({ selectedInstrumentId: id, view: 'instrument' });
}

export function deleteInstrument(id: string) {
  const s = useStore.getState();
  if (s.song.instruments.length <= 1) {
    toast('You need at least one instrument', 'error');
    return;
  }
  const used =
    s.song.channels.some((c) => c.instrument === id) || s.song.patterns.some((p) => p.notes.some((list) => list.some((n) => n.instrument === id)));
  if (used && !window.confirm('This instrument is in use. Delete it anyway? Channels using it will switch to the first instrument.')) return;
  s.update((song) => {
    song.instruments = song.instruments.filter((i) => i.id !== id);
    const fallback = song.instruments[0].id;
    for (const p of song.patterns) for (const list of p.notes) for (const n of list) if (n.instrument === id) n.instrument = '';
    for (const c of song.channels) if (c.instrument === id) c.instrument = fallback;
  });
  fixSelection();
}
