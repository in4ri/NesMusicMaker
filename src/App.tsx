import { useEffect, useState } from 'react';
import { exportNsf, exportWav, loadProjectText, newProject, openProject, saveProject, toast, useToasts } from './actions';
import { inputNoteOff, inputNoteOn, releaseAll } from './audio/liveInput';
import { togglePlay } from './audio/sync';
import { currentPattern, useStore } from './model/store';
import { CHANNELS } from './model/types';
import { isElectron } from './platform/files';
import { Browser } from './ui/Browser';
import { ChannelRack } from './ui/ChannelRack';
import { InstrumentEditor } from './ui/InstrumentEditor';
import { isTyping, PianoRoll } from './ui/PianoRoll';
import { Playlist } from './ui/Playlist';
import { HardwareCheckDialog } from './ui/HardwareCheck';
import { InstrumentHelp, PianoRollHelp, PlaylistHelp } from './ui/HelpContent';
import { HelpButton } from './ui/Popover';
import { MidiImportDialog, startMidiImport } from './ui/MidiImportDialog';
import { NsfImportDialog, startNsfImport } from './ui/NsfImportDialog';
import { openTranspose, TransposeDialog } from './ui/TransposeDialog';
import { Toolbar } from './ui/Toolbar';

// Computer keyboard piano (layout-independent key codes), FL/tracker style.
const PIANO_KEYS = [
  'KeyZ', 'KeyS', 'KeyX', 'KeyD', 'KeyC', 'KeyV', 'KeyG', 'KeyB', 'KeyH', 'KeyN', 'KeyJ', 'KeyM', 'Comma', 'KeyL', 'Period', 'Semicolon', 'Slash',
];
const PIANO_KEYS_UPPER = [
  'KeyQ', 'Digit2', 'KeyW', 'Digit3', 'KeyE', 'KeyR', 'Digit5', 'KeyT', 'Digit6', 'KeyY', 'Digit7', 'KeyU', 'KeyI', 'Digit9', 'KeyO', 'Digit0', 'KeyP',
];

function selectAllNotes() {
  const s = useStore.getState();
  const p = currentPattern(s);
  if (p && s.view === 'pianoroll') s.set({ selectedNoteIds: p.notes[s.selectedChannel].map((n) => n.id) });
}

function runCommand(cmd: string) {
  const s = useStore.getState();
  const typing = document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
  switch (cmd) {
    case 'new': return newProject();
    case 'open': return void openProject();
    case 'save': return void saveProject();
    case 'save-as': return void saveProject(true);
    case 'export-wav': return void exportWav();
    case 'export-nsf': return void exportNsf();
    case 'undo': return typing ? void document.execCommand('undo') : s.undo();
    case 'redo': return typing ? void document.execCommand('redo') : s.redo();
    case 'select-all': return typing ? void document.execCommand('selectAll') : selectAllNotes();
    case 'import-midi': return void startMidiImport();
    case 'import-nsf': return void startNsfImport();
    case 'transpose': return openTranspose();
  }
}

function useGlobalKeys() {
  useEffect(() => {
    let octave = 4;

    const down = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.code === 'Space') {
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur?.();
        if (!e.repeat) togglePlay();
        return;
      }
      if (mod) {
        // In Electron the app menu handles these accelerators.
        if (isElectron()) return;
        const k = e.key.toLowerCase();
        const map: Record<string, string> = { s: e.shiftKey ? 'save-as' : 'save', o: 'open', i: 'import-midi', e: e.shiftKey ? 'export-nsf' : 'export-wav', z: e.shiftKey ? 'redo' : 'undo', y: 'redo', a: 'select-all' };
        if (map[k]) {
          e.preventDefault();
          runCommand(map[k]);
        }
        return;
      }
      if (e.altKey || e.repeat) return;
      if (e.code === 'Minus' || e.code === 'Equal') {
        octave = Math.max(1, Math.min(7, octave + (e.code === 'Equal' ? 1 : -1)));
        toast(`Keyboard octave ${octave}`);
        return;
      }
      let semis = PIANO_KEYS.indexOf(e.code);
      if (semis < 0) {
        semis = PIANO_KEYS_UPPER.indexOf(e.code);
        if (semis >= 0) semis += 12;
      }
      if (semis < 0) return;
      const s = useStore.getState();
      const kind = CHANNELS[s.selectedChannel].kind;
      let pitch = (octave + 1) * 12 + semis;
      if (kind === 'noise') pitch = Math.min(15, semis);
      if (kind === 'dmc') {
        if (semis >= s.song.samples.length) return;
        pitch = semis;
      }
      inputNoteOn(`kbd:${e.code}`, pitch, 127);
    };
    const up = (e: KeyboardEvent) => inputNoteOff(`kbd:${e.code}`);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', releaseAll);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', releaseAll);
    };
  }, []);
}

function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>
      ))}
    </div>
  );
}

function Help({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>The NES sound chip</h2>
        <table>
          <tbody>
            <tr><th>Pulse 1 &amp; 2</th><td>Square waves with 4 duty cycles (12.5/25/50/75%), 16 volume levels. Melodies and harmony.</td></tr>
            <tr><th>Triangle</th><td>Soft, bass-heavy tone with <b>no volume control</b> (on or off). Bass lines and kick drums.</td></tr>
            <tr><th>Noise</th><td>16 pitches, hiss or metallic mode, 16 volume levels. Hi-hats, snares, explosions.</td></tr>
            <tr><th>DMC</th><td>1-bit delta samples at 16 rates, 16 KB total. Drum hits, bass, voice.</td></tr>
          </tbody>
        </table>
        <p>
          Every channel plays <b>one note at a time</b>. Chords are faked with fast arpeggios (instrument arpeggio envelopes or a note's Arp chord).
          Effects like vibrato, slides and echo are done by changing the sound every frame, exactly as real NES games did.
        </p>
        <h2>Shortcuts</h2>
        <table>
          <tbody>
            <tr><th>Space</th><td>Play / stop</td></tr>
            <tr><th>Z–M, Q–U rows</th><td>Play notes on the selected channel (<span className="kbd">-</span>/<span className="kbd">=</span> change octave)</td></tr>
            <tr><th>Ctrl/Cmd+Z, Shift+Z</th><td>Undo / redo</td></tr>
            <tr><th>Ctrl/Cmd+S, O, N</th><td>Save, open, new</td></tr>
            <tr><th>Ctrl/Cmd+E, Shift+E</th><td>Export WAV, export NSF</td></tr>
            <tr><th>Ctrl/Cmd+I</th><td>Import a MIDI file</td></tr>
            <tr><th>● (record)</th><td>While playing: record live input. While stopped: step entry at the cursor.</td></tr>
          </tbody>
        </table>
        <p>NSF files play in NES music players and emulators (e.g. NSFPlay, Game Music Emu, Mesen), or on real hardware with a flash cart.</p>
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

export function App() {
  const view = useStore((s) => s.view);
  const set = useStore((s) => s.set);
  const selectedChannel = useStore((s) => s.selectedChannel);
  const title = useStore((s) => s.song.title);
  const filePath = useStore((s) => s.filePath);
  const dirty = useStore((s) => s.dirty);
  const pattern = useStore(currentPattern);
  const instName = useStore((s) => s.song.instruments.find((i) => i.id === s.selectedInstrumentId)?.name);
  const [help, setHelp] = useState(false);

  useGlobalKeys();

  useEffect(() => {
    if (!window.nesApi) return;
    return window.nesApi.onMenu((cmd) => {
      if (typeof cmd === 'string') runCommand(cmd);
      else if (cmd.open) loadProjectText(cmd.open.text, cmd.open.path);
    });
  }, []);

  useEffect(() => {
    const name = filePath ? filePath.split(/[\\/]/).pop() : title || 'Untitled';
    const t = `${name}${dirty ? ' •' : ''} — NES Music Maker`;
    document.title = t;
    window.nesApi?.setTitle(t);
  }, [title, filePath, dirty]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (useStore.getState().dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  const info =
    view === 'pianoroll'
      ? `${pattern?.name ?? ''} › ${CHANNELS[selectedChannel].name}`
      : view === 'instrument'
        ? instName ?? ''
        : 'Arrange patterns into a song';

  return (
    <div className="app">
      <Toolbar onHelp={() => setHelp(true)} />
      <div className="main">
        <Browser />
        <div className="workspace">
          <ChannelRack />
          <div className="editor">
            <div className="tabs">
              <button className={view === 'pianoroll' ? 'active' : ''} onClick={() => set({ view: 'pianoroll' })}>Piano Roll</button>
              <button className={view === 'playlist' ? 'active' : ''} onClick={() => set({ view: 'playlist' })}>Playlist</button>
              <button className={view === 'instrument' ? 'active' : ''} onClick={() => set({ view: 'instrument' })}>Instrument</button>
              <div className="spacer" />
              <span className="tab-info">{info}</span>
              {view === 'pianoroll' && (
                <HelpButton title="The piano roll">
                  <PianoRollHelp />
                </HelpButton>
              )}
              {view === 'playlist' && (
                <HelpButton title="The playlist">
                  <PlaylistHelp />
                </HelpButton>
              )}
              {view === 'instrument' && (
                <HelpButton title="Instruments">
                  <InstrumentHelp />
                </HelpButton>
              )}
            </div>
            {view === 'pianoroll' && <PianoRoll key="pr" />}
            {view === 'playlist' && <Playlist />}
            {view === 'instrument' && <InstrumentEditor />}
          </div>
        </div>
      </div>
      <MidiImportDialog />
      <HardwareCheckDialog />
      <NsfImportDialog />
      <TransposeDialog />
      <Toasts />
      {help && <Help onClose={() => setHelp(false)} />}
    </div>
  );
}
