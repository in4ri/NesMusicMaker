// Song-timeline automation curves.

import type { AutomationLane, AutomationParam, AutomationPoint, Song } from '../model/types';

export interface ParamInfo {
  param: AutomationParam;
  label: string;
  short: string;
  min: number;
  max: number;
  /** Value with no effect, used when a lane has no points. */
  neutral: number;
  /** True if the curve only applies between its first and last point (otherwise it holds flat beyond them). */
  spanOnly: boolean;
  channels: number[];
  format: (v: number) => string;
  help: string;
}

const DUTY_LABELS = ['12.5%', '25%', '50%', '75%'];

export const AUTOMATION_PARAMS: ParamInfo[] = [
  {
    param: 'volume',
    label: 'Volume',
    short: 'Vol',
    min: 0,
    max: 15,
    neutral: 15,
    spanOnly: false,
    channels: [0, 1, 2, 3],
    format: (v) => String(v),
    help: 'Scales the channel volume (15 = unchanged, 0 = silent). Triangle: on/off only.',
  },
  {
    param: 'duty',
    label: 'Duty sweep',
    short: 'Duty',
    min: 0,
    max: 3,
    neutral: -1,
    spanOnly: true,
    channels: [0, 1],
    format: (v) => DUTY_LABELS[v] ?? String(v), // 75% sounds the same as 25% (it's the inverted wave)
    help: "Sets the pulse width between the first and last point, overriding the instrument's duty. Outside that span the instrument plays as normal. 25% and 75% sound the same on a NES, so sweep through 12.5% and 50%.",
  },
  {
    param: 'detune',
    label: 'Detune',
    short: 'Det',
    min: -50,
    max: 50,
    neutral: 0,
    spanOnly: false,
    channels: [0, 1, 2],
    format: (v) => `${v > 0 ? '+' : ''}${v}c`,
    help: 'Fine pitch offset in cents. Detune one pulse a little against the other for a chorus effect.',
  },
];

export function paramInfo(param: AutomationParam): ParamInfo {
  return AUTOMATION_PARAMS.find((p) => p.param === param)!;
}

/** Curve value at `tick`: linear between points, flat before the first and after the last. */
export function automationValueAt(points: AutomationPoint[], tick: number, neutral = 15): number {
  if (!points.length) return neutral;
  if (tick <= points[0].tick) return points[0].value;
  const last = points[points.length - 1];
  if (tick >= last.tick) return last.value;
  for (let i = 1; i < points.length; i++) {
    const b = points[i];
    if (tick <= b.tick) {
      const a = points[i - 1];
      if (b.tick === a.tick) return b.value;
      return a.value + ((b.value - a.value) * (tick - a.tick)) / (b.tick - a.tick);
    }
  }
  return last.value;
}

/** Whether a lane affects `tick` (span-only lanes are active from the first point to the last, or to the end if only one). */
export function automationActiveAt(info: ParamInfo, points: AutomationPoint[], tick: number): boolean {
  if (!points.length) return false;
  if (!info.spanOnly) return true;
  if (tick < points[0].tick) return false;
  return points.length === 1 || tick <= points[points.length - 1].tick;
}

export function findLane(song: Song, channel: number, param: AutomationParam): AutomationLane | undefined {
  return song.automation.find((l) => l.channel === channel && l.param === param);
}

export function sortedLanePoints(song: Song, channel: number, param: AutomationParam): AutomationPoint[] {
  return [...(findLane(song, channel, param)?.points ?? [])].sort((a, b) => a.tick - b.tick);
}

/**
 * Per-frame values for a channel's lane (rounded to whole units), or null when the lane has no points.
 * Frames where a span-only lane is inactive hold the param's neutral value.
 */
export function automationFrames(song: Song, channel: number, param: AutomationParam, frameCount: number, framesPerTick: number): Int16Array | null {
  const points = sortedLanePoints(song, channel, param);
  if (!points.length) return null;
  const info = paramInfo(param);
  const out = new Int16Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    const tick = f / framesPerTick;
    if (!automationActiveAt(info, points, tick)) {
      out[f] = info.neutral;
      continue;
    }
    const v = Math.round(automationValueAt(points, tick, info.neutral));
    out[f] = Math.max(info.min, Math.min(info.max, v));
  }
  return out;
}

/** Automation values applied to a channel for one frame. */
export interface ChannelMods {
  volume: number; // 0..15
  duty: number;   // 0..3, or -1 for "use the instrument"
  detune: number; // cents
}

export const NO_MODS: ChannelMods = { volume: 15, duty: -1, detune: 0 };

export interface ChannelAutomation {
  volume: Int16Array | null;
  duty: Int16Array | null;
  detune: Int16Array | null;
}

export function channelAutomation(song: Song, channel: number, frameCount: number, framesPerTick: number): ChannelAutomation {
  return {
    volume: automationFrames(song, channel, 'volume', frameCount, framesPerTick),
    duty: automationFrames(song, channel, 'duty', frameCount, framesPerTick),
    detune: automationFrames(song, channel, 'detune', frameCount, framesPerTick),
  };
}

export function modsAt(a: ChannelAutomation | null, frame: number): ChannelMods {
  if (!a) return NO_MODS;
  return {
    volume: a.volume ? a.volume[frame] : 15,
    duty: a.duty ? a.duty[frame] : -1,
    detune: a.detune ? a.detune[frame] : 0,
  };
}
