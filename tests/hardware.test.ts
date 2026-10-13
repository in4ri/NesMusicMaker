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
