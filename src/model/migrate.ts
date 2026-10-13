// Upgrades for project files saved by older versions.

import { CHANNELS, type Song } from './types';

/**
 * Older projects stored an instrument on every note. Convert them so notes follow their channel's sound:
 * if every note on a channel uses one instrument, that becomes the channel's sound.
 */
export function adoptChannelSounds(song: Song) {
  CHANNELS.forEach((c, ch) => {
    if (c.kind === 'dmc') return;
    const notes = song.patterns.flatMap((p) => p.notes[ch]);
    // Only adopt when every note names the same instrument (old format); notes already following the channel ('') rule it out.
    const only = notes[0]?.instrument;
    if (only && notes.every((n) => n.instrument === only) && song.instruments.some((i) => i.id === only)) {
      song.channels[ch].instrument = only;
    }
    for (const n of notes) if (n.instrument === song.channels[ch].instrument) n.instrument = '';
  });
}
