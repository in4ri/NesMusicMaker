import { produce, type Draft } from 'immer';
import { create } from 'zustand';
import { demoSong } from './defaults';
import { CHANNELS, TICKS_PER_STEP, type Song } from './types';

export type View = 'pianoroll' | 'playlist' | 'instrument';
export type PlayMode = 'pattern' | 'song';

const HISTORY_LIMIT = 200;

export interface AppState {
  song: Song;
  filePath: string | null;
  dirty: boolean;
  past: Song[];
  future: Song[];

  selectedPatternId: string;
  selectedChannel: number;
  selectedInstrumentId: string;
  selectedNoteIds: string[];
  view: View;
  playMode: PlayMode;
  playing: boolean;
  /** Tick playback starts from in song mode. */
  songStartTick: number;
  snap: number; // ticks
  mutes: boolean[];
  solo: number; // -1 = none
  masterGain: number;

  /** Save an undo point (call once at the start of a drag, then use `mutate`). */
  checkpoint: () => void;
  /** Change the song without recording an undo point. */
  mutate: (fn: (song: Draft<Song>) => void) => void;
  /** Change the song, recording an undo point. */
  update: (fn: (song: Draft<Song>) => void) => void;
  undo: () => void;
  redo: () => void;
  set: (partial: Partial<AppState>) => void;
  loadSong: (song: Song, filePath: string | null) => void;
}

export const useStore = create<AppState>((set, get) => {
  const initial = demoSong();
  return {
    song: initial,
    filePath: null,
    dirty: false,
    past: [],
    future: [],

    selectedPatternId: initial.patterns[0].id,
    selectedChannel: 0,
    selectedInstrumentId: initial.instruments[0].id,
    selectedNoteIds: [],
    view: 'pianoroll',
    playMode: 'pattern',
    playing: false,
    songStartTick: 0,
    snap: TICKS_PER_STEP,
    mutes: CHANNELS.map(() => false),
    solo: -1,
    masterGain: 0.8,

    checkpoint: () => {
      const { song, past } = get();
      set({ past: [...past.slice(-HISTORY_LIMIT + 1), song], future: [] });
    },
    mutate: (fn) => set({ song: produce(get().song, fn), dirty: true }),
    update: (fn) => {
      const { song, past } = get();
      const next = produce(song, fn);
      if (next === song) return;
      set({ song: next, past: [...past.slice(-HISTORY_LIMIT + 1), song], future: [], dirty: true });
    },
    undo: () => {
      const { past, song, future } = get();
      if (!past.length) return;
      set({ song: past[past.length - 1], past: past.slice(0, -1), future: [song, ...future], dirty: true });
      fixSelection();
    },
    redo: () => {
      const { past, song, future } = get();
      if (!future.length) return;
      set({ song: future[0], past: [...past, song], future: future.slice(1), dirty: true });
      fixSelection();
    },
    set: (partial) => set(partial),
    loadSong: (song, filePath) => {
      set({
        song,
        filePath,
        dirty: false,
        past: [],
        future: [],
        selectedPatternId: song.patterns[0]?.id ?? '',
        selectedInstrumentId: song.instruments[0]?.id ?? '',
        selectedNoteIds: [],
        songStartTick: 0,
      });
    },
  };
});

/** Keep selections pointing at things that still exist (after undo/redo/deletes). */
export function fixSelection() {
  const s = useStore.getState();
  const patch: Partial<AppState> = {};
  if (!s.song.patterns.some((p) => p.id === s.selectedPatternId)) patch.selectedPatternId = s.song.patterns[0]?.id ?? '';
  if (!s.song.instruments.some((i) => i.id === s.selectedInstrumentId)) patch.selectedInstrumentId = s.song.instruments[0]?.id ?? '';
  if (Object.keys(patch).length) useStore.setState(patch);
}

export function muteMask(mutes: boolean[], solo: number) {
  let mask = 0;
  mutes.forEach((m, i) => {
    if (m || (solo >= 0 && solo !== i)) mask |= 1 << i;
  });
  return mask;
}

/** Fast-changing playback state, kept separate so it doesn't re-render the whole app. */
export interface PlayheadState {
  frame: number;
  meters: number[];
}
export const usePlayhead = create<PlayheadState>(() => ({ frame: 0, meters: [0, 0, 0, 0, 0] }));

export function currentPattern(s: AppState) {
  return s.song.patterns.find((p) => p.id === s.selectedPatternId) ?? s.song.patterns[0];
}
