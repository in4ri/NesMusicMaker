import { describe, expect, it } from 'vitest';
import { clipConflicts, countOverlaps, fitToChannel, lowestPitch, resolveOverlaps } from '../src/core/hardware';
import { checkSong } from '../src/core/hardwareCheck';
import { pulsePeriod } from '../src/core/tables';
import { demoSong, emptyPattern, makeNote } from '../src/model/defaults';
import { PPQ, newId } from '../src/model/types';

describe('pitch range', () => {
  it('knows the lowest playable pulse note per region', () => {
    expect(lowestPitch(0, 'ntsc')).toBe(33); // A1
    expect(lowestPitch(0, 'pal')).toBe(32); // G#1 (slower PAL clock)
    expect(lowestPitch(2, 'ntsc')).toBe(21); // triangle reaches A0
    expect(pulsePeriod(33, 'ntsc')).toBeLessThanOrEqual(0x7ff);
    expect(fitToChannel(28, 0, 'ntsc')).toBe(40);
    expect(fitToChannel(28, 2, 'ntsc')).toBe(28);
  });
});

describe('overlap resolution', () => {
  const n = (tick: number, length: number, pitch = 60) => makeNote(tick, length, pitch, '');

  it('shortens a note where the next one starts', () => {
    const notes = [n(0, 48), n(24, 24)];
    expect(countOverlaps(notes)).toBe(1);
    const out = resolveOverlaps(notes, 0);
    expect(out.map((x) => [x.tick, x.length])).toEqual([[0, 24], [24, 24]]);
    expect(countOverlaps(out)).toBe(0);
  });

  it('keeps the preferred note when two start together', () => {
    const a = n(0, 12, 60), b = n(0, 12, 64);
    expect(resolveOverlaps([b, a], 0, new Set([b.id])).map((x) => x.pitch)).toEqual([64]);
    expect(resolveOverlaps([a, b], 0).map((x) => x.pitch)).toEqual([64]); // most recently added
  });

  it('merges stacked notes into an arpeggio chord in chord mode', () => {
    const out = resolveOverlaps([n(0, 24, 64), n(0, 24, 60), n(0, 12, 67)], 0, new Set(), 'chord');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ pitch: 60, length: 24, fx: { arp: [0, 4, 7] } });
    // Noise can't hold chords: the newest note simply wins.
    expect(resolveOverlaps([n(0, 12, 3), n(0, 12, 9)], 3, new Set(), 'chord').map((x) => x.pitch)).toEqual([9]);
  });
});

describe('hardware check', () => {
  it('passes the demo song', () => {
    expect(checkSong(demoSong()).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('finds and fixes problems', () => {
    const song = demoSong();
    const p = song.patterns[0];
    p.notes[0].push(makeNote(0, 96, 28, '')); // overlaps the melody, and is below A1
    p.notes[1].push(makeNote(10 * 4 * PPQ, 12, 60, '')); // past the end of a 2-bar pattern
    const issues = checkSong(song);
    const keys = issues.map((i) => i.key.split(':')[0]);
    expect(keys).toEqual(expect.arrayContaining(['overlap', 'low', 'past']));
    for (const issue of issues) issue.fix?.apply(song);
    expect(checkSong(song).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('flags playlist clips that play the same channel at once', () => {
    const song = demoSong();
    const drumsOnly = emptyPattern('Drums', 1, 2);
    drumsOnly.notes[3].push(makeNote(0, 12, 6, ''));
    song.patterns.push(drumsOnly);
    song.playlist.push({ id: newId(), pattern: drumsOnly.id, track: 1, start: 0 });
    const conflicts = clipConflicts(song);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].channels).toEqual([3]);
    expect(checkSong(song).some((i) => i.key.startsWith('clips'))).toBe(true);
  });
});

describe('transpose song', () => {
  it('moves every pattern on the chosen channels and keeps notes playable', async () => {
    const { transposeSong, previewTranspose } = await import('../src/core/transpose');
    const song = demoSong();
    const before = song.patterns.map((p) => p.notes.map((l) => l.map((n) => n.pitch)));
    const stepBefore = song.channels.map((c) => c.stepPitch);
    const r = transposeSong(song, 2, [0, 1, 2]);
    expect(r.moved).toBe(before[0][0].length + before[0][1].length + before[0][2].length);
    song.patterns.forEach((p, pi) => {
      [0, 1, 2].forEach((ch) => p.notes[ch].forEach((n, i) => expect(n.pitch).toBe(before[pi][ch][i] + 2)));
      p.notes[3].forEach((n, i) => expect(n.pitch).toBe(before[pi][3][i])); // drums untouched
    });
    expect(song.channels[0].stepPitch).toBe(stepBefore[0] + 2);
    expect(song.channels[3].stepPitch).toBe(stepBefore[3]);
    // Arpeggio chord shapes are relative, so they're unchanged.
    expect(song.patterns[0].notes[1][0].fx.arp).toEqual([0, 3, 7]);

    // Going down far enough to leave the pulse range moves those notes up an octave instead.
    const low = demoSong();
    low.patterns[0].notes[0].push(makeNote(0, 12, 34, ''));
    expect(previewTranspose(low, -3, [0]).adjusted).toBe(1);
    transposeSong(low, -3, [0]);
    expect(low.patterns[0].notes[0].every((n) => n.pitch >= lowestPitch(0, 'ntsc'))).toBe(true);
  });
});

describe('quantise', () => {
  it('snaps starts (keeping length), ends, or both', async () => {
    const { quantizeNotes } = await import('../src/core/quantize');
    const mk = () => [makeNote(13, 20, 60, ''), makeNote(47, 10, 62, '')];
    const starts = mk();
    quantizeNotes(starts, 12, 'start', 384);
    expect(starts.map((n) => [n.tick, n.length])).toEqual([[12, 20], [48, 10]]);
    const ends = mk();
    quantizeNotes(ends, 12, 'end', 384);
    expect(ends.map((n) => [n.tick, n.tick + n.length])).toEqual([[13, 36], [47, 60]]);
    const both = mk();
    expect(quantizeNotes(both, 12, 'both', 384)).toBe(2);
    expect(both.map((n) => [n.tick, n.length])).toEqual([[12, 24], [48, 12]]);
  });

  it('quantises a whole song and keeps channels one-note-at-a-time', async () => {
    const { quantizeSong } = await import('../src/core/quantize');
    const song = demoSong();
    const p = song.patterns[0];
    p.notes[0] = [makeNote(1, 20, 60, ''), makeNote(23, 12, 62, '')]; // will both want to start near 0/24
    const changed = quantizeSong(song, 'song', { grid: 12, what: 'both', patternId: p.id, channel: 0, selected: new Set() });
    expect(changed).toBeGreaterThan(0);
    expect(p.notes[0].map((n) => [n.tick, n.length])).toEqual([[0, 24], [24, 12]]);
    expect(checkSong(song).filter((i) => i.key.startsWith('overlap'))).toEqual([]);
  });
});

describe('palette', () => {
  it('maps old project colours to the nearest NES colour', async () => {
    const { adoptPalette } = await import('../src/model/migrate');
    const { INSTRUMENT_PALETTE, PATTERN_PALETTE } = await import('../src/model/palette');
    const song = demoSong();
    song.instruments[0].color = '#ff6b6b'; // an old pre-palette colour
    song.patterns[0].color = '#F6F6F7'; // the earlier off-white (not allowed for patterns)
    adoptPalette(song);
    expect(INSTRUMENT_PALETTE).toContain(song.instruments[0].color);
    expect(PATTERN_PALETTE).toContain(song.patterns[0].color);
  });
});
