// "Export sound effects…": every pattern as its own NSF, named after the pattern.
//
// Each file is an ordinary NSF from buildNsf (the same player, header and stream as the NSF button),
// compiled in pattern mode and titled with the pattern name. NES Game Builder imports these files as
// sound effects and recognises them by that player and stream format, so nothing here changes them.
// Game Builder cuts each effect off after its last audible frame and plays it once; the facts and
// warnings below use its rules, so the user hears about a problem before adding the folder there.

import { CHANNELS, type Song } from '../model/types';
import { compileSong, INIT_WRITES, type CompiledSong } from './compiler';
import { layoutDmc } from './dmc';
import { buildNsf } from './nsf';
import { REGIONS } from './tables';

/** NES Game Builder's limits for one sound effect. */
export const SFX_MAX_CHANNELS = 2;
export const SFX_MAX_FRAMES = 240; // 4 seconds at 60 Hz (NTSC)

export interface SfxFacts {
  /** Tone channels (0-3) that make sound in at least one frame. */
  channels: number[];
  /** Frames up to and including the last one with sound on a tone channel (0 = silent). */
  frames: number;
  seconds: number;
  /** The pattern writes DMC registers (sample notes), which game sound effects can't use. */
  usesDmc: boolean;
}

export interface SoundEffect {
  patternId: string;
  /** NSF title: the pattern name. */
  title: string;
  fileName: string;
  compiled: CompiledSong;
  facts: SfxFacts;
  warnings: string[];
}

/** Replay the compiled writes and measure what Game Builder keeps of the effect. */
export function sfxFacts(c: CompiledSong): SfxFacts {
  const regs = new Uint8Array(0x18);
  for (const [r, v] of INIT_WRITES) regs[r] = v;
  const heard = [false, false, false, false];
  let frames = 0;
  let usesDmc = false;
  for (let f = 0; f < c.frameCount; f++) {
    for (let i = c.frameIndex[f]; i < c.frameIndex[f + 1]; i += 2) {
      regs[c.writes[i]] = c.writes[i + 1];
      if (c.writes[i] >= 0x10) usesDmc = true;
    }
    // Pulse and noise: constant-volume nibble; triangle: $4008 = $80 is NMM's "off".
    const audible = [(regs[0x00] & 15) !== 0, (regs[0x04] & 15) !== 0, regs[0x08] !== 0x80, (regs[0x0c] & 15) !== 0];
    audible.forEach((a, ch) => (heard[ch] ||= a));
    if (audible.some(Boolean)) frames = f + 1;
  }
  const channels = heard.flatMap((h, ch) => (h ? [ch] : []));
  return { channels, frames, seconds: frames / REGIONS[c.region].frameRate, usesDmc };
}

/** Plain-English problems with using this pattern as a game sound effect (none = fine). */
export function sfxWarnings(facts: SfxFacts): string[] {
  const warnings: string[] = [];
  const n = facts.channels.length;
  if (n > SFX_MAX_CHANNELS) {
    const names = facts.channels.map((ch) => CHANNELS[ch].name).join(', ');
    warnings.push(`Uses ${n} channels (${names}). A sound effect can use at most ${SFX_MAX_CHANNELS}: remove a part, or use it as a song that plays once.`);
  }
  if (facts.frames > SFX_MAX_FRAMES) {
    const seconds = Math.ceil(facts.seconds * 10) / 10;
    warnings.push(`Lasts ${seconds.toFixed(1)} seconds. A sound effect can last at most 4 seconds: shorten it, or use it as a song that plays once.`);
  }
  if (facts.usesDmc) {
    warnings.push(
      n
        ? "Uses DMC samples, which sound effects can't use. That part is left out in the game."
        : "Only uses DMC samples, which sound effects can't use. Make it on the Noise channel instead.",
    );
  } else if (!n) {
    warnings.push('Makes no sound.');
  }
  return warnings;
}

const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A file name (without extension) that is safe on Windows, macOS and Linux. */
export function safeFileBase(name: string) {
  const clean = (s: string) => s.replace(/[\x00-\x1f\\/:*?"<>|]+/g, '_').replace(/^[. ]+|[. ]+$/g, '');
  const base = clean(clean(name).slice(0, 80)) || 'Untitled';
  // Windows device names (CON, NUL, COM1…) can't be file names, even with an extension.
  return RESERVED_NAMES.test(base.split('.')[0].trim()) ? `_${base}` : base;
}

/** `<name>.nsf` for each name, made unique (ignoring case) with " (2)", " (3)", … in list order. */
export function sfxFileNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const base = safeFileBase(name);
    let file = `${base}.nsf`;
    for (let n = 2; used.has(file.toLowerCase()); n++) file = `${base} (${n}).nsf`;
    used.add(file.toLowerCase());
    return file;
  });
}

/**
 * One sound effect per pattern of the song, in pattern order. File names are made from all the
 * patterns, so a pattern keeps its file name whichever patterns are exported.
 */
export function soundEffects(song: Song): SoundEffect[] {
  const fileNames = sfxFileNames(song.patterns.map((p) => p.name));
  return song.patterns.map((p, i) => {
    const compiled = compileSong(song, { mode: 'pattern', patternId: p.id });
    const facts = sfxFacts(compiled);
    return { patternId: p.id, title: p.name.trim(), fileName: fileNames[i], compiled, facts, warnings: sfxWarnings(facts) };
  });
}

/** The NSF file of one sound effect. DMC sample banks are included only when the pattern plays samples. */
export function soundEffectNsf(song: Song, sfx: SoundEffect): Uint8Array {
  const dmcBytes = sfx.facts.usesDmc ? layoutDmc(song.samples).used : 0;
  return buildNsf(sfx.compiled, { title: sfx.title, author: song.author, copyright: song.copyright }, dmcBytes);
}
