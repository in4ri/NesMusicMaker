// AudioWorklet processor: runs the APU emulator on the audio thread.

import { Apu } from '../core/apu';
import type { CompiledSong } from '../core/compiler';
import { NsfMachine, parseNsf } from '../core/nsfFile';
import { SongPlayer } from '../core/player';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

export type WorkletMessage =
  | { type: 'song'; song: CompiledSong }
  | { type: 'play'; frame: number }
  | { type: 'stop' }
  | { type: 'preview'; song: CompiledSong; id: number }
  | { type: 'previewUpdate'; song: CompiledSong; id: number }
  | { type: 'mute'; mask: number }
  | { type: 'gain'; gain: number }
  | { type: 'nsfPlay'; bytes: Uint8Array; track: number }
  | { type: 'nsfStop' };

/** Plays an NSF file live by running its music code every frame (exactly what an NSF player on a NES does). */
class NsfLivePlayer {
  readonly apu: Apu;
  private readonly machine: NsfMachine;
  private readonly samplesPerFrame: number;
  private untilNextFrame = 0;

  constructor(bytes: Uint8Array, track: number, rate: number) {
    const file = parseNsf(bytes);
    let machine: NsfMachine | null = null;
    this.apu = new Apu(file.header.region, rate, (a) => (machine ? machine.read(a) : 0));
    machine = new NsfMachine(file, this.apu);
    this.machine = machine;
    this.samplesPerFrame = rate / file.header.playRate;
    machine.init(track);
  }

  render(out: Float32Array, count: number, gain: number) {
    let pos = 0;
    while (pos < count) {
      if (this.untilNextFrame <= 0) {
        this.machine.play();
        this.untilNextFrame += this.samplesPerFrame;
      }
      const n = Math.min(count - pos, Math.max(1, Math.ceil(this.untilNextFrame)));
      this.apu.render(out, pos, n, gain, true);
      pos += n;
      this.untilNextFrame -= n;
    }
  }
}

export type WorkletEvent = { type: 'pos'; frame: number; playing: boolean; meters: number[] };

class NesProcessor extends AudioWorkletProcessor {
  private readonly player = new SongPlayer(sampleRate);
  private readonly preview = new SongPlayer(sampleRate);
  private gain = 0.8;
  private previewId = 0;
  private nsf: NsfLivePlayer | null = null;
  private reportCountdown = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<WorkletMessage>) => {
      const m = e.data;
      switch (m.type) {
        case 'song':
          this.player.update(m.song);
          break;
        case 'play':
          this.player.start(m.frame);
          break;
        case 'stop':
          this.player.stop();
          this.report();
          break;
        case 'preview':
          this.previewId = m.id;
          this.preview.update(m.song);
          this.preview.start(0);
          break;
        case 'previewUpdate':
          // Same note, shorter hold: swapping keeps the position so it flows into the release.
          if (this.preview.playing && m.id === this.previewId) this.preview.update(m.song);
          break;
        case 'mute':
          this.player.setMuteMask(m.mask);
          break;
        case 'gain':
          this.gain = m.gain;
          break;
        case 'nsfPlay':
          try {
            this.nsf = new NsfLivePlayer(m.bytes, m.track, sampleRate);
          } catch {
            this.nsf = null;
          }
          break;
        case 'nsfStop':
          this.nsf = null;
          break;
      }
    };
  }

  private report() {
    const apu = this.nsf?.apu ?? this.player.apu;
    const meters = apu ? Array.from(apu.meters) : [0, 0, 0, 0, 0];
    const ev: WorkletEvent = { type: 'pos', frame: this.player.frame, playing: this.player.playing, meters };
    this.port.postMessage(ev);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0];
    const left = out[0];
    if (!left) return true;
    this.player.render(left, 0, left.length, this.gain);
    this.preview.render(left, 0, left.length, this.gain, true);
    this.nsf?.render(left, left.length, this.gain);
    for (let c = 1; c < out.length; c++) out[c].set(left);

    if (--this.reportCountdown <= 0) {
      this.reportCountdown = 8; // ~every 20 ms at 48 kHz
      this.report();
    }
    return true;
  }
}

registerProcessor('nes-apu', NesProcessor);
