// Live note input from a MIDI keyboard or the computer keyboard: auditioning,
// chords → arpeggios, live recording while playing, and step entry while stopped.

import { create } from 'zustand';
import { toast } from '../actions';
import { makeNote } from '../model/defaults';
import { currentPattern, useStore } from '../model/store';
import { CHANNELS, patternLength, type ArpStyle, type NoteFx, type Pattern } from '../model/types';
import { fitToChannel, resolveOverlaps } from '../core/hardware';
import { audibleTick, previewNoteHeld } from './sync';

export interface InputState {
  /** Record incoming notes into the selected pattern and channel. */
  record: boolean;
  /** Map key velocity to note volume (otherwise always 15). */
  velocity: boolean;
  /** Held chords on pulse/triangle become one arpeggio note instead of the last key winning. */
  chords: boolean;
  arpStyle: ArpStyle;
  arpSpeed: number;
  /** Where step entry (recording while stopped) puts the next note, in pattern ticks. */
  stepCursor: number;
}

export const useInput = create<InputState>(() => ({
  record: false,
  velocity: true,
  chords: true,
  arpStyle: 'up',
  arpSpeed: 1,
  stepCursor: 0,
}));

// Keys currently down: key id → channel pitch, in press order.
const held = new Map<string, number>();
let heldChannel = 0;
let heldVelocity = 127;
let releasePreview: (() => void) | null = null;

// Live recording state.
let tookCheckpoint = false;
let warnedNoClip = false;
let recording: { noteId: string; patternId: string; channel: number; start: number; startedAt: number } | null = null;
/** Keys pressed within this many ms of a recorded note's start join its chord, even across a grid line. */
const CHORD_WINDOW_MS = 60;
// Step entry accumulates every key pressed until all are released.
const stepPitches = new Set<number>();

interface Sounding {
  pitch: number;
  fx: NoteFx;
}

function chordable(channel: number) {
  const kind = CHANNELS[channel].kind;
  return useInput.getState().chords && (kind === 'pulse' || kind === 'triangle');
}

/** What the held keys should sound like: the chord as an arpeggio, or the most recent key. */
function sounding(pitches: Iterable<number>, channel: number): Sounding | null {
  const list = [...pitches];
  if (!list.length) return null;
  if (!chordable(channel)) return { pitch: list[list.length - 1], fx: {} };
  const sorted = [...new Set(list)].sort((a, b) => a - b);
  const root = sorted[0];
  if (sorted.length === 1) return { pitch: root, fx: {} };
  const { arpStyle, arpSpeed } = useInput.getState();
  return { pitch: root, fx: { arp: sorted.map((p) => p - root), arpStyle, arpSpeed } };
}

function volumeFor(velocity: number) {
  return useInput.getState().velocity ? Math.max(1, Math.round((velocity / 127) * 15)) : 15;
}

/** Instrument for played/recorded notes: '' (the channel's sound), or the instrument open in the editor if it differs. */
function instrumentFor(channel: number) {
  const s = useStore.getState();
  if (CHANNELS[channel].kind === 'dmc') return '';
  if (s.view === 'instrument' && s.selectedInstrumentId !== s.song.channels[channel].instrument) return s.selectedInstrumentId;
  return '';
}

function restartPreview() {
  const snd = sounding(held.values(), heldChannel);
  if (!snd) {
    releasePreview?.();
    releasePreview = null;
    return;
  }
  releasePreview = previewNoteHeld(heldChannel, snd.pitch, instrumentFor(heldChannel), volumeFor(heldVelocity), snd.fx);
}

// ---------- Recording ----------

function editPattern(patternId: string, fn: (p: Pattern) => void) {
  const s = useStore.getState();
  if (!tookCheckpoint) {
    s.checkpoint();
    tookCheckpoint = true;
  }
  s.mutate((song) => {
    const p = song.patterns.find((x) => x.id === patternId);
    if (p) fn(p as Pattern);
  });
}

/** The pattern being recorded into and the current position inside it, or null. */
function recordTarget(): { pattern: Pattern; tick: number; length: number; wraps: boolean } | null {
  const s = useStore.getState();
  const pattern = currentPattern(s);
  if (!pattern) return null;
  const length = patternLength(s.song, pattern);
  const now = audibleTick();
  if (s.playMode === 'pattern') return { pattern, tick: now % length, length, wraps: true };
  const clip = s.song.playlist.find((c) => c.pattern === pattern.id && now >= c.start && now < c.start + length);
  if (!clip) {
    if (!warnedNoClip) toast('To record in song mode, the playhead must be over a clip of the selected pattern', 'error');
    warnedNoClip = true;
    return null;
  }
  return { pattern, tick: now - clip.start, length, wraps: false };
}

function quantize(tick: number) {
  const q = useStore.getState().snap;
  return Math.round(tick / q) * q;
}

function endRecording(target: ReturnType<typeof recordTarget>) {
  const rec = recording;
  recording = null;
  if (!rec || !target || target.pattern.id !== rec.patternId) return;
  const q = useStore.getState().snap;
  let end = quantize(target.tick);
  if (end <= rec.start) end = target.wraps && target.tick < rec.start ? target.length : rec.start + q;
  const length = Math.max(q, Math.min(end, target.length) - rec.start);
  editPattern(rec.patternId, (p) => {
    const n = p.notes[rec.channel].find((x) => x.id === rec.noteId);
    if (n) n.length = length;
    p.notes[rec.channel] = resolveOverlaps(p.notes[rec.channel], rec.channel, new Set([rec.noteId]));
  });
}

/** Called when a key goes down while recording during playback. */
function recordChange() {
  const target = recordTarget();
  if (!target) return;
  const snd = sounding(held.values(), heldChannel);
  let start = quantize(target.tick);
  if (start >= target.length) start = target.wraps ? 0 : target.length - useStore.getState().snap;

  const sameChord = recording && (recording.start === start || performance.now() - recording.startedAt < CHORD_WINDOW_MS);
  if (recording && sameChord && recording.patternId === target.pattern.id && snd) {
    // Still within the same grid step: just update the chord/pitch of the note being recorded.
    const rec = recording;
    editPattern(rec.patternId, (p) => {
      const n = p.notes[rec.channel].find((x) => x.id === rec.noteId);
      if (n) {
        n.pitch = snd.pitch;
        n.volume = volumeFor(heldVelocity);
        n.fx = { ...n.fx, ...snd.fx };
        if (!snd.fx.arp) delete n.fx.arp;
      }
    });
    return;
  }
  endRecording(target);
  if (!snd) return;
  const channel = heldChannel;
  const note = makeNote(start, useStore.getState().snap, snd.pitch, instrumentFor(channel), volumeFor(heldVelocity), snd.fx);
  editPattern(target.pattern.id, (p) => {
    // Overdub: the new note replaces one starting at the same time and shortens one it lands inside.
    p.notes[channel] = resolveOverlaps([...p.notes[channel], note], channel, new Set([note.id]));
  });
  recording = { noteId: note.id, patternId: target.pattern.id, channel, start, startedAt: performance.now() };
}

/** Step entry: insert the chord/note at the step cursor and advance it. */
function commitStep() {
  const s = useStore.getState();
  const pattern = currentPattern(s);
  const snd = sounding(stepPitches, heldChannel);
  stepPitches.clear();
  if (!pattern || !snd) return;
  const length = patternLength(s.song, pattern);
  const { stepCursor } = useInput.getState();
  const tick = stepCursor >= length ? 0 : stepCursor;
  const channel = heldChannel;
  const note = makeNote(tick, s.snap, snd.pitch, instrumentFor(channel), volumeFor(heldVelocity), snd.fx);
  s.update((song) => {
    const p = song.patterns.find((x) => x.id === pattern.id)!;
    p.notes[channel] = resolveOverlaps([...p.notes[channel], note], channel, new Set([note.id]));
  });
  useInput.setState({ stepCursor: (tick + s.snap) % length });
}

// ---------- Public API ----------

/** A key went down. `key` identifies the physical key; `pitch` is already mapped to the channel. */
export function inputNoteOn(key: string, pitch: number, velocity: number) {
  if (held.has(key)) return;
  const s = useStore.getState();
  // Keys below what a pulse channel can play are moved up an octave (or more).
  pitch = fitToChannel(pitch, held.size ? heldChannel : s.selectedChannel, s.song.region);
  if (!held.size) {
    heldChannel = s.selectedChannel;
    heldVelocity = velocity;
  } else {
    heldVelocity = Math.max(heldVelocity, velocity); // a chord is as loud as its loudest key
  }
  held.set(key, pitch);
  restartPreview();
  if (!useInput.getState().record) return;
  if (s.playing) recordChange();
  else stepPitches.add(pitch);
}

export function inputNoteOff(key: string) {
  if (!held.delete(key)) return;
  // Letting go of part of a chord keeps the note going; it ends when every key is up.
  if (held.size) return;
  releasePreview?.();
  releasePreview = null;
  if (!useInput.getState().record) return;
  if (useStore.getState().playing) endRecording(recordTarget());
  else commitStep();
}

/** Release every held key (e.g. when the window loses focus, so notes don't get stuck). */
export function releaseAll() {
  for (const key of [...held.keys()]) inputNoteOff(key);
}

export function resetTake() {
  if (recording) endRecording(recordTarget());
  recording = null;
  tookCheckpoint = false;
  warnedNoClip = false;
}

/** Map a MIDI note number to the selected channel's pitch space, or null if it has no meaning there. */
export function midiNoteToChannelPitch(note: number, channel: number): number | null {
  const kind = CHANNELS[channel].kind;
  if (kind === 'noise') return note % 16;
  if (kind === 'dmc') {
    const i = note % 12;
    return i < useStore.getState().song.samples.length ? i : null;
  }
  return note;
}

// Each play/stop or record toggle starts a new take (one undo step).
useStore.subscribe((s, prev) => {
  if (s.playing !== prev.playing) resetTake();
});
useInput.subscribe((s, prev) => {
  if (s.record !== prev.record) resetTake();
});
useStore.subscribe((s, prev) => {
  if (s.selectedPatternId !== prev.selectedPatternId) useInput.setState({ stepCursor: 0 });
});
