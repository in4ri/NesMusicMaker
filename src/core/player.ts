// Plays a CompiledSong through the APU emulator. Shared by the realtime
// AudioWorklet and the offline WAV renderer.

import { Apu } from './apu';
import { INIT_WRITES, type CompiledSong } from './compiler';
import { dmcReader } from './dmc';
import { REGIONS } from './tables';

export class SongPlayer {
  apu: Apu | null = null;
  song: CompiledSong | null = null;
  frame = 0;
  playing = false;
  /** Set when a non-looping song has played its last frame. */
  ended = false;
  muteMask = 0;
  private dmcMemory = new Uint8Array(0x4000);
  private samplesPerFrame = 0;
  private untilNextFrame = 0;
  private readonly read = dmcReader(this.dmcMemory);

  constructor(private readonly sampleRate: number) {}

  private resetApu(song: CompiledSong) {
    this.apu = new Apu(song.region, this.sampleRate, (a) => this.read(a));
    this.apu.muteMask = this.muteMask;
    this.samplesPerFrame = this.sampleRate / REGIONS[song.region].frameRate;
    for (const [reg, v] of INIT_WRITES) this.apu.write(0x4000 + reg, v);
  }

  /** Replace the song data, keeping the playback position (used for live edits). */
  update(song: CompiledSong) {
    const regionChanged = this.song?.region !== song.region;
    this.song = song;
    this.dmcMemory.set(song.dmcMemory);
    if (this.frame >= song.frameCount) this.frame = song.loopFrame >= 0 ? song.loopFrame : song.frameCount;
    if (regionChanged && this.playing) this.start(this.frame);
  }

  /** Start playing from `frame`, fast-forwarding register state to that point. */
  start(frame: number) {
    const song = this.song;
    if (!song) return;
    this.resetApu(song);
    const apu = this.apu!;
    frame = Math.max(0, Math.min(frame, song.frameCount - 1));
    const end = song.frameIndex[frame];
    for (let i = 0; i < end; i += 2) {
      const reg = song.writes[i];
      // Skip one-shot DMC triggers/DAC loads while seeking.
      if (reg === 0x15 || reg === 0x11) continue;
      apu.write(0x4000 + reg, song.writes[i + 1]);
    }
    this.frame = frame;
    this.untilNextFrame = 0;
    this.playing = true;
    this.ended = false;
  }

  stop() {
    this.playing = false;
    if (this.apu) for (const [reg, v] of INIT_WRITES) this.apu.write(0x4000 + reg, v);
  }

  private applyFrame() {
    const song = this.song!;
    if (this.frame >= song.frameCount) {
      if (song.loopFrame < 0) {
        this.ended = true;
        this.stop();
        return;
      }
      this.frame = song.loopFrame;
    }
    const apu = this.apu!;
    for (let i = song.frameIndex[this.frame]; i < song.frameIndex[this.frame + 1]; i += 2) {
      apu.write(0x4000 + song.writes[i], song.writes[i + 1]);
    }
    this.frame++;
  }

  setMuteMask(mask: number) {
    this.muteMask = mask;
    if (this.apu) this.apu.muteMask = mask;
  }

  /** Render `count` samples. Keeps the APU running after stop so releases/filters decay naturally. */
  render(out: Float32Array, offset: number, count: number, gain = 1, add = false) {
    const apu = this.apu;
    if (!apu) {
      if (!add) out.fill(0, offset, offset + count);
      return;
    }
    let pos = 0;
    while (pos < count) {
      if (this.playing && this.untilNextFrame <= 0) {
        this.applyFrame();
        this.untilNextFrame += this.samplesPerFrame;
      }
      const n = this.playing ? Math.min(count - pos, Math.max(1, Math.ceil(this.untilNextFrame))) : count - pos;
      apu.render(out, offset + pos, n, gain, add);
      pos += n;
      if (this.playing) this.untilNextFrame -= n;
    }
  }
}
