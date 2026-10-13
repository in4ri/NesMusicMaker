// Cycle-accurate-enough emulation of the NES 2A03 APU.
//
// Each output sample advances every channel by the number of CPU cycles that
// elapse in that sample period, and box-filters (time-averages) the channel
// output over those cycles. This is cheap and removes most aliasing. The
// averaged channel levels then go through the real non-linear mixer and the
// NES output filter chain (HP 90 Hz, HP 440 Hz, LP 14 kHz).

import { DMC_BASE, DUTY_SEQUENCES, LENGTH_TABLE, REGIONS, TRIANGLE_SEQUENCE, type Region } from './tables';

class Envelope {
  start = false;
  loop = false;
  constant = false;
  volume = 0; // also the divider period
  divider = 0;
  decay = 0;

  write(v: number) {
    this.loop = (v & 0x20) !== 0;
    this.constant = (v & 0x10) !== 0;
    this.volume = v & 0x0f;
  }

  clock() {
    if (this.start) {
      this.start = false;
      this.decay = 15;
      this.divider = this.volume;
    } else if (this.divider === 0) {
      this.divider = this.volume;
      if (this.decay > 0) this.decay--;
      else if (this.loop) this.decay = 15;
    } else {
      this.divider--;
    }
  }

  get output() {
    return this.constant ? this.volume : this.decay;
  }
}

class Pulse {
  enabled = false;
  duty = 0;
  seq = 0;
  period = 0;
  timer = 0; // CPU cycles until the next sequencer step
  length = 0;
  env = new Envelope();
  sweepEnabled = false;
  sweepPeriod = 0;
  sweepNegate = false;
  sweepShift = 0;
  sweepDivider = 0;
  sweepReload = false;

  constructor(private readonly onesComplement: boolean) {}

  write(reg: number, v: number) {
    switch (reg) {
      case 0:
        this.duty = v >> 6;
        this.env.write(v);
        break;
      case 1:
        this.sweepEnabled = (v & 0x80) !== 0;
        this.sweepPeriod = (v >> 4) & 7;
        this.sweepNegate = (v & 0x08) !== 0;
        this.sweepShift = v & 7;
        this.sweepReload = true;
        break;
      case 2:
        this.period = (this.period & 0x700) | v;
        break;
      case 3:
        this.period = (this.period & 0xff) | ((v & 7) << 8);
        if (this.enabled) this.length = LENGTH_TABLE[v >> 3];
        this.seq = 0;
        this.env.start = true;
        break;
    }
  }

  sweepTarget() {
    const delta = this.period >> this.sweepShift;
    if (this.sweepNegate) return this.period - delta - (this.onesComplement ? 1 : 0);
    return this.period + delta;
  }

  clockHalf() {
    if (!this.env.loop && this.length > 0) this.length--;
    const target = this.sweepTarget();
    if (this.sweepDivider === 0 && this.sweepEnabled && this.sweepShift > 0 && this.period >= 8 && target <= 0x7ff) {
      this.period = Math.max(0, target);
    }
    if (this.sweepDivider === 0 || this.sweepReload) {
      this.sweepDivider = this.sweepPeriod;
      this.sweepReload = false;
    } else {
      this.sweepDivider--;
    }
  }

  level() {
    if (this.length === 0 || this.period < 8 || this.sweepTarget() > 0x7ff) return 0;
    return DUTY_SEQUENCES[this.duty][this.seq] * this.env.output;
  }

  /** Advance by n CPU cycles, returning the time-weighted mean output. */
  advance(n: number) {
    let sum = 0;
    let remaining = n;
    let out = this.level();
    const step = (this.period + 1) * 2;
    while (this.timer <= remaining) {
      sum += out * this.timer;
      remaining -= this.timer;
      this.seq = (this.seq + 1) & 7;
      out = this.level();
      this.timer = step;
    }
    this.timer -= remaining;
    sum += out * remaining;
    return sum / n;
  }
}

class Triangle {
  enabled = false;
  period = 0;
  timer = 0;
  seq = 0;
  length = 0;
  control = false;
  linearReloadValue = 0;
  linear = 0;
  linearReload = false;

  write(reg: number, v: number) {
    switch (reg) {
      case 0:
        this.control = (v & 0x80) !== 0;
        this.linearReloadValue = v & 0x7f;
        break;
      case 2:
        this.period = (this.period & 0x700) | v;
        break;
      case 3:
        this.period = (this.period & 0xff) | ((v & 7) << 8);
        if (this.enabled) this.length = LENGTH_TABLE[v >> 3];
        this.linearReload = true;
        break;
    }
  }

  clockQuarter() {
    if (this.linearReload) this.linear = this.linearReloadValue;
    else if (this.linear > 0) this.linear--;
    if (!this.control) this.linearReload = false;
  }

  clockHalf() {
    if (!this.control && this.length > 0) this.length--;
  }

  advance(n: number) {
    const running = this.length > 0 && this.linear > 0 && this.period >= 2;
    if (!running) return TRIANGLE_SEQUENCE[this.seq];
    let sum = 0;
    let remaining = n;
    const step = this.period + 1;
    while (this.timer <= remaining) {
      sum += TRIANGLE_SEQUENCE[this.seq] * this.timer;
      remaining -= this.timer;
      this.seq = (this.seq + 1) & 31;
      this.timer = step;
    }
    this.timer -= remaining;
    sum += TRIANGLE_SEQUENCE[this.seq] * remaining;
    return sum / n;
  }
}

class Noise {
  enabled = false;
  mode = false;
  periodIndex = 0;
  timer = 0;
  shift = 1;
  length = 0;
  env = new Envelope();

  constructor(private readonly periods: number[]) {}

  write(reg: number, v: number) {
    switch (reg) {
      case 0:
        this.env.write(v);
        break;
      case 2:
        this.mode = (v & 0x80) !== 0;
        this.periodIndex = v & 0x0f;
        break;
      case 3:
        if (this.enabled) this.length = LENGTH_TABLE[v >> 3];
        this.env.start = true;
        break;
    }
  }

  clockHalf() {
    if (!this.env.loop && this.length > 0) this.length--;
  }

  level() {
    if (this.length === 0 || (this.shift & 1) === 1) return 0;
    return this.env.output;
  }

  advance(n: number) {
    let sum = 0;
    let remaining = n;
    let out = this.level();
    const step = this.periods[this.periodIndex];
    const tap = this.mode ? 6 : 1;
    while (this.timer <= remaining) {
      sum += out * this.timer;
      remaining -= this.timer;
      const fb = (this.shift ^ (this.shift >> tap)) & 1;
      this.shift = (this.shift >> 1) | (fb << 14);
      out = this.level();
      this.timer = step;
    }
    this.timer -= remaining;
    sum += out * remaining;
    return sum / n;
  }
}

class Dmc {
  loop = false;
  rateIndex = 0;
  timer = 0;
  level = 0;
  sampleAddress = DMC_BASE;
  sampleLength = 1;
  address = DMC_BASE;
  bytesRemaining = 0;
  buffer = -1; // -1 = empty
  shift = 0;
  bitsRemaining = 8;
  silence = true;

  constructor(private readonly rates: number[], private readonly read: (addr: number) => number) {}

  write(reg: number, v: number) {
    switch (reg) {
      case 0:
        this.loop = (v & 0x40) !== 0;
        this.rateIndex = v & 0x0f;
        break;
      case 1:
        this.level = v & 0x7f;
        break;
      case 2:
        this.sampleAddress = 0xc000 + v * 64;
        break;
      case 3:
        this.sampleLength = v * 16 + 1;
        break;
    }
  }

  restart() {
    this.address = this.sampleAddress;
    this.bytesRemaining = this.sampleLength;
  }

  fill() {
    if (this.buffer >= 0 || this.bytesRemaining === 0) return;
    this.buffer = this.read(this.address);
    this.address = this.address === 0xffff ? 0x8000 : this.address + 1;
    this.bytesRemaining--;
    if (this.bytesRemaining === 0 && this.loop) this.restart();
  }

  clockOutput() {
    if (!this.silence) {
      if (this.shift & 1) {
        if (this.level <= 125) this.level += 2;
      } else if (this.level >= 2) {
        this.level -= 2;
      }
    }
    this.shift >>= 1;
    if (--this.bitsRemaining === 0) {
      this.bitsRemaining = 8;
      if (this.buffer < 0) {
        this.silence = true;
      } else {
        this.silence = false;
        this.shift = this.buffer;
        this.buffer = -1;
        this.fill();
      }
    }
  }

  advance(n: number) {
    let sum = 0;
    let remaining = n;
    const step = this.rates[this.rateIndex];
    while (this.timer <= remaining) {
      sum += this.level * this.timer;
      remaining -= this.timer;
      this.clockOutput();
      this.timer = step;
    }
    this.timer -= remaining;
    sum += this.level * remaining;
    return sum / n;
  }
}

/** First-order high/low-pass filter. */
class Filter {
  private prevIn = 0;
  private prevOut = 0;
  private readonly a: number;

  constructor(private readonly highpass: boolean, cutoff: number, sampleRate: number) {
    const rc = 1 / (2 * Math.PI * cutoff);
    const dt = 1 / sampleRate;
    this.a = highpass ? rc / (rc + dt) : dt / (rc + dt);
  }

  process(x: number) {
    const y = this.highpass
      ? this.a * (this.prevOut + x - this.prevIn)
      : this.prevOut + this.a * (x - this.prevOut);
    this.prevIn = x;
    this.prevOut = y;
    return y;
  }
}

export const CHANNEL_COUNT = 5;

export class Apu {
  readonly pulse1 = new Pulse(true);
  readonly pulse2 = new Pulse(false);
  readonly triangle = new Triangle();
  readonly noise: Noise;
  readonly dmc: Dmc;

  /** Bit mask of muted channels (bit 0 = pulse 1 ... bit 4 = DMC). Mutes only the output, not the emulation. */
  muteMask = 0;
  /** Most recent per-channel levels, normalised 0..1 (for meters). */
  readonly meters = new Float32Array(CHANNEL_COUNT);
  /** Counts DMC sample starts triggered via $4015 (used by the NSF importer). */
  dmcTriggers = 0;

  private readonly cyclesPerSample: number;
  private cycleFraction = 0;
  private frameCounterTimer: number;
  private frameStep = 0;
  private fiveStep = false;
  private readonly frameCounterStep: number;
  private readonly filters: Filter[];

  constructor(region: Region, sampleRate: number, read: (addr: number) => number) {
    const info = REGIONS[region];
    this.cyclesPerSample = info.cpuClock / sampleRate;
    this.frameCounterStep = info.frameCounterStep;
    this.frameCounterTimer = info.frameCounterStep;
    this.noise = new Noise(info.noisePeriods);
    this.dmc = new Dmc(info.dmcRates, read);
    this.filters = [
      new Filter(true, 90, sampleRate),
      new Filter(true, 440, sampleRate),
      new Filter(false, 14000, sampleRate),
    ];
  }

  write(addr: number, v: number) {
    const reg = addr & 0x1f;
    if (reg < 0x04) this.pulse1.write(reg, v);
    else if (reg < 0x08) this.pulse2.write(reg - 4, v);
    else if (reg < 0x0c) this.triangle.write(reg - 8, v);
    else if (reg < 0x10) this.noise.write(reg - 12, v);
    else if (reg < 0x14) this.dmc.write(reg - 16, v);
    else if (reg === 0x15) {
      this.pulse1.enabled = (v & 1) !== 0;
      this.pulse2.enabled = (v & 2) !== 0;
      this.triangle.enabled = (v & 4) !== 0;
      this.noise.enabled = (v & 8) !== 0;
      if (!this.pulse1.enabled) this.pulse1.length = 0;
      if (!this.pulse2.enabled) this.pulse2.length = 0;
      if (!this.triangle.enabled) this.triangle.length = 0;
      if (!this.noise.enabled) this.noise.length = 0;
      if (v & 0x10) {
        if (this.dmc.bytesRemaining === 0) {
          this.dmc.restart();
          this.dmc.fill();
          this.dmcTriggers++;
        }
      } else {
        this.dmc.bytesRemaining = 0;
      }
    } else if (reg === 0x17) {
      this.fiveStep = (v & 0x80) !== 0;
      this.frameStep = 0;
      this.frameCounterTimer = this.frameCounterStep;
      if (this.fiveStep) {
        this.clockQuarter();
        this.clockHalf();
      }
    }
  }

  /** $4015 read: which channels are still sounding (length counters / DMC bytes left). */
  readStatus() {
    return (
      (this.pulse1.length > 0 ? 1 : 0) |
      (this.pulse2.length > 0 ? 2 : 0) |
      (this.triangle.length > 0 ? 4 : 0) |
      (this.noise.length > 0 ? 8 : 0) |
      (this.dmc.bytesRemaining > 0 ? 0x10 : 0)
    );
  }

  private clockQuarter() {
    this.pulse1.env.clock();
    this.pulse2.env.clock();
    this.noise.env.clock();
    this.triangle.clockQuarter();
  }

  private clockHalf() {
    this.pulse1.clockHalf();
    this.pulse2.clockHalf();
    this.triangle.clockHalf();
    this.noise.clockHalf();
  }

  private clockFrameCounter() {
    const step = this.frameStep;
    if (this.fiveStep) {
      this.frameStep = (step + 1) % 5;
      if (step === 3) return;
      this.clockQuarter();
      if (step === 1 || step === 4) this.clockHalf();
    } else {
      this.frameStep = (step + 1) % 4;
      this.clockQuarter();
      if (step === 1 || step === 3) this.clockHalf();
    }
  }

  /** Render `count` mono samples into `out` starting at `offset`, optionally adding to existing content. */
  render(out: Float32Array, offset: number, count: number, gain = 1, add = false) {
    const mute = this.muteMask;
    let m0 = 0, m1 = 0, m3 = 0, m4 = 0;
    for (let i = 0; i < count; i++) {
      this.cycleFraction += this.cyclesPerSample;
      let n = Math.floor(this.cycleFraction);
      this.cycleFraction -= n;

      // Split the sample period at frame-counter clocks so envelopes/linear counter land in the right place.
      let p1 = 0, p2 = 0, t = 0, ns = 0, d = 0;
      const total = n;
      while (n > 0) {
        const chunk = Math.min(n, this.frameCounterTimer);
        const w = chunk / total;
        p1 += this.pulse1.advance(chunk) * w;
        p2 += this.pulse2.advance(chunk) * w;
        t += this.triangle.advance(chunk) * w;
        ns += this.noise.advance(chunk) * w;
        d += this.dmc.advance(chunk) * w;
        n -= chunk;
        this.frameCounterTimer -= chunk;
        if (this.frameCounterTimer === 0) {
          this.frameCounterTimer = this.frameCounterStep;
          this.clockFrameCounter();
        }
      }

      if (mute & 1) p1 = 0;
      if (mute & 2) p2 = 0;
      if (mute & 4) t = 0;
      if (mute & 8) ns = 0;
      if (mute & 16) d = 0;
      if (p1 > m0) m0 = p1;
      if (p2 > m1) m1 = p2;
      if (ns > m3) m3 = ns;
      if (d > m4) m4 = d;

      const pulseSum = p1 + p2;
      const pulseOut = pulseSum > 0 ? 95.88 / (8128 / pulseSum + 100) : 0;
      const tndSum = t / 8227 + ns / 12241 + d / 22638;
      const tndOut = tndSum > 0 ? 159.79 / (1 / tndSum + 100) : 0;
      let s = pulseOut + tndOut;
      s = this.filters[0].process(s);
      s = this.filters[1].process(s);
      s = this.filters[2].process(s);
      s *= gain * 1.6;
      if (add) out[offset + i] += s;
      else out[offset + i] = s;
    }
    const meters = this.meters;
    meters[0] = m0 / 15;
    meters[1] = m1 / 15;
    const tri = this.triangle;
    meters[2] = !(mute & 4) && tri.length > 0 && tri.linear > 0 && tri.period >= 2 ? 1 : 0;
    meters[3] = m3 / 15;
    meters[4] = m4 / 127;
  }
}
