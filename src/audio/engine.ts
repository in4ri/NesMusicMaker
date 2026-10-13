// Main-thread side of the audio engine: owns the AudioContext and talks to the worklet.

import type { CompiledSong } from '../core/compiler';
import workletUrl from './worklet.ts?worker&url';
import type { WorkletEvent, WorkletMessage } from './worklet';

type PosListener = (ev: WorkletEvent) => void;

class AudioEngine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private starting: Promise<void> | null = null;
  private pending: WorkletMessage[] = [];
  private listeners = new Set<PosListener>();
  private lastSong: CompiledSong | null = null;
  private mask = 0;
  private gain = 0.8;

  /** Lazily create the AudioContext (browsers require a user gesture first). */
  ensureStarted(): Promise<void> {
    if (this.node) {
      if (this.ctx!.state === 'suspended') void this.ctx!.resume();
      return Promise.resolve();
    }
    if (!this.starting) {
      this.starting = (async () => {
        const ctx = new AudioContext({ latencyHint: 'interactive' });
        await ctx.audioWorklet.addModule(workletUrl);
        const node = new AudioWorkletNode(ctx, 'nes-apu', { numberOfInputs: 0, outputChannelCount: [2] });
        node.port.onmessage = (e: MessageEvent<WorkletEvent>) => this.listeners.forEach((l) => l(e.data));
        node.connect(ctx.destination);
        this.ctx = ctx;
        this.node = node;
        this.post({ type: 'mute', mask: this.mask });
        this.post({ type: 'gain', gain: this.gain });
        if (this.lastSong) this.post({ type: 'song', song: this.lastSong });
        for (const m of this.pending) this.post(m);
        this.pending = [];
        if (ctx.state === 'suspended') await ctx.resume();
      })();
    }
    return this.starting;
  }

  private post(m: WorkletMessage) {
    if (this.node) this.node.port.postMessage(m);
    else this.pending.push(m);
  }

  setSong(song: CompiledSong) {
    this.lastSong = song;
    if (this.node) this.post({ type: 'song', song });
  }

  async play(frame: number) {
    await this.ensureStarted();
    this.post({ type: 'play', frame });
  }

  stop() {
    if (this.node) this.post({ type: 'stop' });
  }

  private previewCounter = 0;

  /** Play a one-off preview; returns its id for `previewUpdate`. */
  preview(song: CompiledSong): number {
    const id = ++this.previewCounter;
    void this.ensureStarted().then(() => this.post({ type: 'preview', song, id }));
    return id;
  }

  previewUpdate(id: number, song: CompiledSong) {
    if (this.node) this.post({ type: 'previewUpdate', song, id });
  }

  /** Play an NSF track exactly, by running its code on the audio thread. */
  async playNsf(bytes: Uint8Array, track: number) {
    await this.ensureStarted();
    this.post({ type: 'nsfPlay', bytes, track });
  }

  stopNsf() {
    if (this.node) this.post({ type: 'nsfStop' });
  }

  setMuteMask(mask: number) {
    this.mask = mask;
    if (this.node) this.post({ type: 'mute', mask });
  }

  setGain(gain: number) {
    this.gain = gain;
    if (this.node) this.post({ type: 'gain', gain });
  }

  /** Seconds between rendering a sample and hearing it. */
  latency() {
    const ctx = this.ctx;
    return ctx ? ctx.baseLatency + (ctx.outputLatency || 0) : 0;
  }

  onPosition(l: PosListener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Decode any browser-supported audio file to mono PCM. */
  async decodeAudio(bytes: ArrayBuffer): Promise<{ pcm: Float32Array; sampleRate: number }> {
    const ctx = new OfflineAudioContext(1, 1, 44100);
    const buf = await ctx.decodeAudioData(bytes);
    const pcm = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const data = buf.getChannelData(c);
      for (let i = 0; i < data.length; i++) pcm[i] += data[i] / buf.numberOfChannels;
    }
    return { pcm, sampleRate: buf.sampleRate };
  }
}

export const engine = new AudioEngine();
