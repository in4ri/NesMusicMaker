// DMC (delta modulation channel) sample conversion and memory layout.

import type { DmcSample } from '../model/types';
import { DMC_BASE, DMC_MEMORY_SIZE, REGIONS, type Region } from './tables';

/** Maximum bytes a single DMC sample can play ($4013 = $FF). */
export const DMC_MAX_BYTES = 255 * 16 + 1;

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function dmcSampleRate(rate: number, region: Region) {
  return REGIONS[region].cpuClock / REGIONS[region].dmcRates[rate];
}

/**
 * Convert mono PCM (-1..1) to 1-bit delta-modulated DMC bytes at the given DMC rate.
 * The output is normalised, padded to a valid length (16n+1) and capped at the hardware maximum.
 */
export function encodeDmc(pcm: Float32Array, sourceRate: number, rate: number, region: Region): Uint8Array {
  const targetRate = dmcSampleRate(rate, region);
  const outLen = Math.min(Math.floor((pcm.length * targetRate) / sourceRate), DMC_MAX_BYTES * 8);

  let peak = 0;
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
  const norm = peak > 0 ? 1 / peak : 1;

  const byteCount = Math.min(DMC_MAX_BYTES, Math.max(1, Math.ceil(outLen / 8 / 16) * 16 + 1));
  const bytes = new Uint8Array(byteCount).fill(0x55); // 0x55 alternates up/down = silence
  let level = 64;
  for (let i = 0; i < outLen; i++) {
    // Linear interpolation resample, mapped to the 7-bit DAC range.
    const pos = (i * sourceRate) / targetRate;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = pcm[i0] ?? 0;
    const b = pcm[i0 + 1] ?? a;
    const target = 64 + (a + (b - a) * frac) * norm * 60;
    const bit = target > level ? 1 : 0;
    level += bit ? 2 : -2;
    level = Math.max(0, Math.min(127, level));
    if (bit) bytes[i >> 3] |= 1 << (i & 7);
    else bytes[i >> 3] &= ~(1 << (i & 7));
  }
  return bytes;
}

/** Decode DMC bytes back to PCM for waveform display. */
export function decodeDmc(bytes: Uint8Array): Float32Array {
  const out = new Float32Array(bytes.length * 8);
  let level = 64;
  for (let i = 0; i < out.length; i++) {
    const bit = (bytes[i >> 3] >> (i & 7)) & 1;
    if (bit) {
      if (level <= 125) level += 2;
    } else if (level >= 2) level -= 2;
    out[i] = (level - 64) / 64;
  }
  return out;
}

export interface DmcLayoutEntry {
  addressReg: number; // $4012 value
  lengthReg: number;  // $4013 value
  offset: number;     // byte offset into the $C000 memory image
  size: number;
}

export interface DmcLayout {
  memory: Uint8Array; // DMC_MEMORY_SIZE bytes mapped at $C000
  entries: (DmcLayoutEntry | null)[]; // null = did not fit
  used: number;
}

/** Pack samples into $C000-$FFFF, each aligned to 64 bytes as the hardware requires. */
export function layoutDmc(samples: DmcSample[]): DmcLayout {
  const memory = new Uint8Array(DMC_MEMORY_SIZE);
  const entries: (DmcLayoutEntry | null)[] = [];
  let offset = 0;
  for (const s of samples) {
    let bytes = base64ToBytes(s.data);
    if (bytes.length > DMC_MAX_BYTES) bytes = bytes.subarray(0, DMC_MAX_BYTES);
    const lengthReg = Math.max(0, Math.floor((bytes.length - 1) / 16));
    const size = lengthReg * 16 + 1;
    if (offset + size > DMC_MEMORY_SIZE) {
      entries.push(null);
      continue;
    }
    memory.set(bytes.subarray(0, size), offset);
    entries.push({ addressReg: offset / 64, lengthReg, offset, size });
    offset = Math.ceil((offset + size) / 64) * 64;
  }
  return { memory, entries, used: offset };
}

export function dmcReader(memory: Uint8Array) {
  return (addr: number) => (addr >= DMC_BASE ? memory[addr - DMC_BASE] : 0);
}
