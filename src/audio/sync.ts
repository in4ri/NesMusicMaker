// Keeps the audio engine in sync with the editor state: recompiles the song on
// every edit (cheap) and forwards playback position back to the UI.

import { compilePreview, compileSong, framesPerTick, type CompiledSong } from '../core/compiler';
import { REGIONS } from '../core/tables';
import { makeNote } from '../model/defaults';
import { muteMask, useStore, usePlayhead } from '../model/store';
import { CHANNELS, type NoteFx } from '../model/types';
import { engine } from './engine';

let compiled: CompiledSong | null = null;
let scheduled = false;

function recompile() {
  scheduled = false;
  const s = useStore.getState();
  compiled = compileSong(s.song, { mode: s.playMode, patternId: s.selectedPatternId });
  engine.setSong(compiled);
}

function scheduleRecompile() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(recompile);
}

export function startAudioSync() {
  recompile();
  useStore.subscribe((s, prev) => {
    if (s.song !== prev.song || s.playMode !== prev.playMode || s.selectedPatternId !== prev.selectedPatternId) {
      scheduleRecompile();
    }
    if (s.mutes !== prev.mutes || s.solo !== prev.solo) engine.setMuteMask(muteMask(s.mutes, s.solo));
    if (s.masterGain !== prev.masterGain) engine.setGain(s.masterGain);
  });
  engine.onPosition((ev) => {
    // Songs always loop, so playback only stops when the UI asks; `ev.playing` can lag a play request.
    lastReport = { frame: ev.frame, time: performance.now() };
    usePlayhead.setState({ frame: ev.frame, meters: ev.meters });
  });
}

let lastReport = { frame: 0, time: 0 };

/**
 * Best estimate of the tick the listener is hearing right now: extrapolates from the
 * last position report and subtracts the audio output latency. Used for recording.
 */
export function audibleTick(): number {
  if (!compiled) return 0;
  const frameRate = REGIONS[compiled.region].frameRate;
  const elapsed = (performance.now() - lastReport.time) / 1000;
  const frame = lastReport.frame - 1 + (elapsed - engine.latency()) * frameRate;
  const ticks = Math.max(0, frame) / compiled.framesPerTick;
  if (compiled.loopFrame < 0) return ticks;
  // Wrap around the loop like the player does.
  const end = compiled.frameCount / compiled.framesPerTick;
  const loop = compiled.loopFrame / compiled.framesPerTick;
  return ticks < end ? ticks : loop + ((ticks - loop) % (end - loop));
}

/** Current playback position in ticks (relative to the pattern in pattern mode). */
export function playheadTick(frame: number) {
  if (!compiled) return 0;
  return Math.max(0, frame - 1) / compiled.framesPerTick;
}

export async function play() {
  const s = useStore.getState();
  if (scheduled) recompile();
  const startFrame = s.playMode === 'song' ? Math.floor(s.songStartTick * framesPerTick(s.song) + 1e-6) : 0;
  useStore.setState({ playing: true });
  await engine.play(startFrame);
}

export function stop() {
  engine.stop();
  useStore.setState({ playing: false });
  usePlayhead.setState({ frame: 0, meters: [0, 0, 0, 0, 0] });
}

export function togglePlay() {
  if (useStore.getState().playing) stop();
  else void play();
}

/** Audition a note on a channel with the given instrument. */
export function previewNote(channel: number, pitch: number, instrument: string, volume = 15, fx: NoteFx = {}) {
  const s = useStore.getState();
  const hold = Math.round(REGIONS[s.song.region].frameRate * (CHANNELS[channel].kind === 'dmc' ? 2 : 0.35));
  const song = compilePreview(s.song, channel, makeNote(0, 1, pitch, instrument, volume, fx), hold);
  engine.preview(song);
}

/** Start a note that sounds until the returned release function is called. */
export function previewNoteHeld(channel: number, pitch: number, instrument: string, volume = 15, fx: NoteFx = {}): () => void {
  const s = useStore.getState();
  const frameRate = REGIONS[s.song.region].frameRate;
  const note = makeNote(0, 1, pitch, instrument, volume, fx);
  const started = performance.now();
  const id = engine.preview(compilePreview(s.song, channel, note, Math.round(frameRate * 30)));
  return () => {
    const held = Math.max(1, Math.round(((performance.now() - started) / 1000) * frameRate));
    engine.previewUpdate(id, compilePreview(useStore.getState().song, channel, note, held));
  };
}
