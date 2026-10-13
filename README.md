# NES Music Maker

An FL Studio-style sequencer for writing music for the Nintendo Entertainment System. It has a channel rack with a step sequencer, a piano roll, a playlist and an instrument editor, all limited to the real NES sound chip (the 2A03 APU).

It runs on macOS, Windows and Linux (Electron + TypeScript + React).

## The NES sound chip in 30 seconds

| Channel | Sound | Notes |
|---|---|---|
| Pulse 1 & 2 | Square wave, 4 duty cycles (12.5 / 25 / 50 / 75%) | 16 volume levels. Melody and harmony. |
| Triangle | Soft 4-bit triangle, an octave lower than pulse | **No volume control** (on/off). Bass, kicks. |
| Noise | 16 pitches, "hiss" or "metallic" mode | 16 volume levels. Hats, snares, explosions. |
| DMC | 1-bit delta-encoded samples, 16 rates | 16 KB total. Drum hits, bass, voice. |

Each channel plays one note at a time. The chip has no hardware effects: vibrato, slides, arpeggio chords and echo are produced by the music code changing the sound every video frame (60 Hz NTSC / 50 Hz PAL). This app does the same.

## Features

- **Channel rack**: FL-style step sequencer for all 5 channels, with mute/solo, a level LED, and a default instrument and pitch per channel.
- **Piano roll**: draw, move, resize and delete notes; box-select, copy/paste, duplicate and transpose; a per-note volume lane; ghost notes from the other melodic channels.
- **Per-note effects**: glide (legato portamento), pitch bend, vibrato, delay, cut, and duty/noise-mode override.
- **Arpeggio chords**: give any note a chord shape (major, minor, 7ths, sus, power, octave… or custom offsets), a style (up, down, up-down, down-up, random, as entered) and a speed in frames per step. Change them later on any selection.
- **Playlist**: arrange patterns on 8 tracks, set the play start and the loop point.
- **Volume automation**: a volume lane per channel under the playlist (NES levels 0–15), with linear segments between points. You can show or hide lanes per channel. It applies in song playback and in WAV/NSF exports.
- **MIDI keyboard input** (Web MIDI, any connected device):
  - Plays the selected channel, with velocity → volume.
  - Held chords become arpeggio notes.
  - Arm **●** to record live while playing (quantised to the snap), or to step-enter notes and chords while stopped.
  - The computer keyboard piano works the same way.
- **MIDI file import**:
  - Map each MIDI part to an NES channel. Parts are suggested automatically: drums → noise, bass → triangle, top parts → pulses.
  - Chords can be reduced to the highest or lowest note, or kept as arpeggios.
  - General MIDI drums map to noise kick, snare and hat sounds.
  - Imports are quantised and sliced into reusable patterns.
- **Instruments**: frame-by-frame volume, arpeggio, pitch and duty envelopes with loop and release points (FamiTracker-style), plus presets.
- **DMC samples**: import WAV/MP3/OGG and convert to 1-bit delta PCM, with rate and loop settings and a memory usage meter.
- **Accurate playback**: a cycle-stepped APU emulation with the real non-linear mixer and NES output filters, running on the audio thread.
- **Export**:
  - **WAV**: renders the song.
  - **NSF**: a real NES music file that plays in NSF players and emulators (NSFPlay, Game Music Emu, Mesen, etc.), or on hardware via a flash cart. It loops from the song's loop point.
- Undo/redo, a computer-keyboard piano (Z–M and Q–U rows; `-`/`=` change octave), NTSC/PAL, and `.nesmm` project files (JSON).

### Why there's no panning

The NES outputs **mono**: all five channels are mixed into one signal, so there's nothing to pan, and an NSF file can't carry stereo. Some emulators fake stereo, but it wouldn't play back that way on real hardware. The automation that maps onto real hardware is volume (done). Pulse duty-cycle sweeps, fine detune and tempo changes would also be possible.

## Getting started

Requires [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm run dev        # run the app with hot reload
```

Other scripts:

```bash
npm start          # build and run the production app
npm test           # unit tests (APU, compiler, DMC, NSF player via a 6502 emulator)
npm run typecheck
npm run web        # run in a browser at http://localhost:5173 (no Electron)
```

### Building installers

```bash
npm run dist:mac     # .dmg + .zip
npm run dist:win     # NSIS installer + portable .exe
npm run dist:linux   # AppImage + .deb
```

Output goes to `release/`. Build each platform on its own OS, or push to GitHub: `.github/workflows/build.yml` builds all three and uploads them as workflow artifacts.

The builds are **unsigned**. On macOS, right-click the app and choose *Open* the first time. On Windows, choose *More info → Run anyway* in SmartScreen.

## How it works

```
Song (patterns, notes, instruments)
   │  src/core/compiler.ts   "sound driver": per-frame envelopes and effects → APU register writes
   ▼
CompiledSong (register writes per frame)
   ├── src/core/player.ts + apu.ts → AudioWorklet (live playback)
   ├── src/core/wav.ts             → WAV export
   └── src/core/nsf.ts             → NSF export (6502 player replays the same writes)
```

Every output path consumes the same compiled register stream, so the editor, the WAV and the NSF sound identical. The test suite runs the generated NSF through a small 6502 emulator and checks that it produces exactly the same register writes, frame by frame, including across bank switches and the loop.

| Path | What |
|---|---|
| `src/core/apu.ts` | 2A03 APU emulation (pulse, triangle, noise, DMC, mixer, filters) |
| `src/core/compiler.ts` | Song → per-frame register writes (envelopes, effects, DMC triggers) |
| `src/core/nsf.ts`, `asm6502.ts` | NSF builder and the 6502 player, written in a tiny assembler DSL |
| `src/core/dmc.ts` | Audio → 1-bit delta PCM conversion, $C000 memory layout |
| `src/core/midi.ts`, `midiImport.ts` | MIDI file parser; mapping parts to NES channels, chord reduction/arpeggios |
| `src/core/automation.ts` | Song-timeline volume automation curves |
| `src/audio/liveInput.ts`, `midiInput.ts` | MIDI/computer keyboard input, chords → arpeggios, live recording, step entry |
| `src/audio/` | AudioWorklet, engine, and editor ↔ audio sync |
| `src/model/` | Song types, defaults (instruments, demo tune), store with undo |
| `src/ui/` | Toolbar, browser, channel rack, piano roll, playlist, instrument editor |
| `electron/` | Main process (window, menu, file dialogs) and preload bridge |

## Limitations and ideas for later

- The NSF uses a register-dump player. It's exact and simple, but file size grows with song length (up to about 1 MB), and it isn't meant to be dropped into a homebrew game engine.
- MIDI import uses the file's first tempo, and notes that cross a pattern boundary are cut at the boundary.
- Volume automation follows the song timeline, so you don't hear it in PAT (single pattern) mode.
- No Famicom expansion chips (VRC6, FDS, N163, etc.).
- The pulse channels' hardware sweep unit isn't used. Pitch slides are done in software, as most drivers do.
