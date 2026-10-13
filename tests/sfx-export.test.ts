import { describe, expect, it } from 'vitest';
import { compileSong, framesPerTick, type CompiledSong } from '../src/core/compiler';
import { bytesToBase64, encodeDmc } from '../src/core/dmc';
import { buildPlayer } from '../src/core/nsf';
import { NsfMachine, parseNsf } from '../src/core/nsfFile';
import { SFX_MAX_FRAMES, safeFileBase, sfxFileNames, soundEffectNsf, soundEffects } from '../src/core/sfxExport';
import { emptyPattern, emptySong, env, makeInstrument, makeNote } from '../src/model/defaults';
import type { Song } from '../src/model/types';

type Frame = [number, number][];

/** A project of effects. "Beep" is a constant-volume instrument, so its length is exactly its notes. */
function effectsProject() {
  const song = emptySong();
  song.title = 'My Effects';
  song.author = 'Scott';
  const beep = makeInstrument('Beep', { volume: env([15]) });
  song.instruments.push(beep);
  const pluck = song.instruments.find((i) => i.name === 'Pluck')!.id;
  const snare = song.instruments.find((i) => i.name === 'Noise Snare')!.id;

  const jump = emptyPattern('Jump', 0);
  jump.notes[0].push(makeNote(0, 12, 72, beep.id, 15, { bend: 7 }), makeNote(12, 36, 79, beep.id));
  const coin = emptyPattern('Coin', 1);
  coin.notes[0].push(makeNote(0, 6, 83, pluck), makeNote(6, 42, 88, pluck));
  coin.notes[1].push(makeNote(6, 42, 76, pluck));
  const hurt = emptyPattern('Hurt', 2);
  hurt.notes[3].push(makeNote(0, 24, 4, snare));
  song.patterns = [jump, coin, hurt];
  return { song, beep };
}

function compiledFrames(c: CompiledSong): Frame[] {
  return Array.from({ length: c.frameCount }, (_, f) => {
    const frame: Frame = [];
    for (let i = c.frameIndex[f]; i < c.frameIndex[f + 1]; i += 2) frame.push([c.writes[i], c.writes[i + 1]]);
    return frame;
  });
}

/** Run the NSF's own 6502 player and collect its APU writes per frame. */
function playNsf(nsf: Uint8Array, frames: number): Frame[] {
  const machine = new NsfMachine(parseNsf(nsf), null);
  let writes: Frame = [];
  machine.onApuWrite = (reg, v) => writes.push([reg, v]);
  machine.init(0);
  const out: Frame[] = [];
  for (let f = 0; f < frames; f++) {
    writes = [];
    machine.play();
    out.push(writes);
  }
  return out;
}

function effectOf(song: Song, name: string) {
  return soundEffects(song).find((e) => e.title === name)!;
}

describe('Export sound effects', () => {
  it('exports one ordinary NSF per pattern, titled after the pattern, holding exactly that pattern', () => {
    const { song } = effectsProject();
    const effects = soundEffects(song);
    expect(effects.map((e) => [e.title, e.fileName])).toEqual([
      ['Jump', 'Jump.nsf'],
      ['Coin', 'Coin.nsf'],
      ['Hurt', 'Hurt.nsf'],
    ]);
    const player = buildPlayer();

    for (const [i, sfx] of effects.entries()) {
      const nsf = soundEffectNsf(song, sfx);
      const { header } = parseNsf(nsf);
      expect(header.title).toBe(song.patterns[i].name);
      expect(header.artist).toBe('Scott');
      // The same header shape, player and NTSC timing as the NSF button's files.
      expect([header.version, header.songCount, header.startSong, header.loadAddr]).toEqual([1, 1, 1, 0x8000]);
      expect([header.initAddr, header.playAddr]).toEqual([player.initAddr, player.playAddr]);
      expect(header.region).toBe('ntsc');
      expect(Array.from(nsf.subarray(0x70, 0x74))).toEqual([0, 1, 0, 0]);
      expect(nsf[0x7a]).toBe(0);
      expect(Array.from(nsf.subarray(0x80, 0x80 + player.code.length))).toEqual(Array.from(player.code));
      expect((nsf.length - 0x80) % 0x1000).toBe(0);
      expect(nsf.length).toBeGreaterThanOrEqual(0x80 + 2 * 0x1000);

      // Frame for frame the writes of compileSong in pattern mode, then it loops to the start.
      const expected = compiledFrames(compileSong(song, { mode: 'pattern', patternId: song.patterns[i].id }));
      const played = playNsf(nsf, expected.length + 1);
      expect(played.slice(0, expected.length)).toEqual(expected);
      expect(played[expected.length]).toEqual(expected[0]);
    }

    // Only that pattern's channels are written: Jump is Pulse 1, Hurt is Noise.
    const regsOf = (name: string) => new Set(compiledFrames(effectOf(song, name).compiled).flat().map(([r]) => r));
    expect([...regsOf('Jump')].every((r) => r <= 0x03)).toBe(true);
    expect([...regsOf('Hurt')].every((r) => r >= 0x0c && r <= 0x0f)).toBe(true);
  });

  it('measures the length up to the last sound, the channels used and DMC use', () => {
    const { song } = effectsProject();
    const jump = effectOf(song, 'Jump');
    // Two notes over 48 ticks of a constant-volume instrument, then silence for the rest of the bar.
    expect(jump.facts.frames).toBe(Math.floor(48 * framesPerTick(song) + 1e-6));
    expect(jump.compiled.frameCount).toBeGreaterThan(jump.facts.frames);
    expect(jump.facts.seconds).toBeCloseTo(jump.facts.frames / 60.0988, 3);
    expect(jump.facts.channels).toEqual([0]);
    expect(jump.warnings).toEqual([]);

    const coin = effectOf(song, 'Coin');
    expect(coin.facts.channels).toEqual([0, 1]);
    expect(coin.facts.usesDmc).toBe(false);
    expect(coin.warnings).toEqual([]);
    expect(effectOf(song, 'Hurt').facts.channels).toEqual([3]);
  });

  it('warns in plain English about patterns that break the sound effect limits, without dropping them', () => {
    const { song, beep } = effectsProject();
    const f = framesPerTick(song);
    const long = (name: string, frames: number) => {
      const p = emptyPattern(name, 0, 4);
      p.notes[0].push(makeNote(0, Math.ceil(frames / f), 60, beep.id));
      return p;
    };
    const fanfare = emptyPattern('Fanfare', 0);
    fanfare.notes[0].push(makeNote(0, 24, 72, beep.id));
    fanfare.notes[1].push(makeNote(0, 24, 76, beep.id));
    fanfare.notes[2].push(makeNote(0, 24, 48, beep.id));
    const silent = emptyPattern('Blank', 0);
    song.patterns.push(fanfare, long('Four', SFX_MAX_FRAMES), long('Siren', 288), silent);

    const byName = Object.fromEntries(soundEffects(song).map((e) => [e.title, e]));
    expect(Object.keys(byName)).toHaveLength(7);
    expect(byName.Fanfare.warnings).toEqual([
      'Uses 3 channels (Pulse 1, Pulse 2, Triangle). A sound effect can use at most 2: remove a part, or use it as a song that plays once.',
    ]);
    expect(byName.Four.facts.frames).toBe(SFX_MAX_FRAMES);
    expect(byName.Four.warnings).toEqual([]);
    expect(byName.Siren.facts.frames).toBe(288);
    expect(byName.Siren.warnings).toEqual([
      'Lasts 4.8 seconds. A sound effect can last at most 4 seconds: shorten it, or use it as a song that plays once.',
    ]);
    expect(byName.Blank.facts.frames).toBe(0);
    expect(byName.Blank.warnings).toEqual(['Makes no sound.']);
    // Still exportable: a warning never blocks the file.
    expect(parseNsf(soundEffectNsf(song, byName.Siren)).header.title).toBe('Siren');
  });

  it('includes DMC sample banks only for patterns that play samples, and warns about them', () => {
    const { song } = effectsProject();
    const pcm = new Float32Array(3000).map((_, i) => Math.sin(i / 7) * Math.exp(-i / 1000));
    song.samples.push({ id: 's', name: 'kick', data: bytesToBase64(encodeDmc(pcm, 22050, 15, 'ntsc')), rate: 15, loop: false, initialLevel: 32 });
    const boom = emptyPattern('Boom', 0);
    boom.notes[3].push(makeNote(0, 24, 2, ''));
    boom.notes[4].push(makeNote(0, 24, 0, ''));
    const drum = emptyPattern('Drum', 0);
    drum.notes[4].push(makeNote(0, 24, 0, ''));
    song.patterns.push(boom, drum);

    const b = effectOf(song, 'Boom');
    expect(b.facts.usesDmc).toBe(true);
    expect(b.facts.channels).toEqual([3]);
    expect(b.warnings).toEqual(["Uses DMC samples, which sound effects can't use. That part is left out in the game."]);
    expect(effectOf(song, 'Drum').warnings).toEqual(["Only uses DMC samples, which sound effects can't use. Make it on the Noise channel instead."]);

    const withDmc = soundEffectNsf(song, b);
    expect(withDmc[0x74]).toBeGreaterThan(0); // a $C000 sample bank
    const expected = compiledFrames(b.compiled);
    expect(playNsf(withDmc, expected.length)).toEqual(expected);

    const plain = soundEffectNsf(song, effectOf(song, 'Jump'));
    expect(Array.from(plain.subarray(0x74, 0x78))).toEqual([0, 0, 0, 0]);
    expect(plain.length).toBeLessThan(withDmc.length);
  });

  it('makes safe, unique file names from pattern names', () => {
    expect(sfxFileNames(['Jump', 'jump', 'Coin/Big', '', 'CON', ' Hit. ', 'Jump (2)', 'a:b*c?', 'nul.wav'])).toEqual([
      'Jump.nsf',
      'jump (2).nsf',
      'Coin_Big.nsf',
      'Untitled.nsf',
      '_CON.nsf',
      'Hit.nsf',
      'Jump (2) (2).nsf',
      'a_b_c_.nsf',
      '_nul.wav.nsf',
    ]);
    expect(safeFileBase('x'.repeat(200))).toHaveLength(80);
    expect(safeFileBase('...')).toBe('Untitled');
    expect(safeFileBase('Tab\there')).toBe('Tab_here');
  });

  it('keeps file names stable whichever patterns are exported', () => {
    const { song } = effectsProject();
    song.patterns[2].name = 'Jump';
    expect(soundEffects(song).map((e) => e.fileName)).toEqual(['Jump.nsf', 'Coin.nsf', 'Jump (2).nsf']);
    // The NSF title stays the pattern name; Game Builder falls back to the file name for repeated titles.
    expect(parseNsf(soundEffectNsf(song, soundEffects(song)[2])).header.title).toBe('Jump');
  });
});
