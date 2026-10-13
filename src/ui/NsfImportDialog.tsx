import { create } from 'zustand';
import { toast } from '../actions';
import { engine } from '../audio/engine';
import { stop } from '../audio/sync';
import { parseNsf, type NsfFile } from '../core/nsfFile';
import { captureNsf, transcribe } from '../core/nsfImport';
import { useStore } from '../model/store';
import { ticksPerBar } from '../model/types';
import { pickFile } from '../platform/files';

interface NsfImportState {
  file: NsfFile | null;
  bytes: Uint8Array | null;
  track: number; // 0-based
  listening: boolean;
  busy: boolean;
  progress: number;
  barsPerPattern: number;
  maxMinutes: number;
}

const useNsfImport = create<NsfImportState>(() => ({
  file: null,
  bytes: null,
  track: 0,
  listening: false,
  busy: false,
  progress: 0,
  barsPerPattern: 4,
  maxMinutes: 3,
}));

export async function startNsfImport() {
  const picked = await pickFile('.nsf');
  if (picked) openNsfImport(new Uint8Array(await picked.arrayBuffer()));
}

/** Parse NSF bytes and open the import window. */
export function openNsfImport(bytes: Uint8Array) {
  try {
    const file = parseNsf(bytes);
    useNsfImport.setState({ file, bytes, track: file.header.startSong - 1, listening: false, busy: false, progress: 0 });
  } catch (e) {
    toast(`Could not read NSF file: ${(e as Error).message}`, 'error');
  }
}

function stopListening() {
  engine.stopNsf();
  useNsfImport.setState({ listening: false });
}

function close() {
  stopListening();
  useNsfImport.setState({ file: null, bytes: null });
}

async function listen() {
  const { bytes, track } = useNsfImport.getState();
  if (!bytes) return;
  stop(); // don't play the song at the same time
  await engine.playNsf(bytes, track);
  useNsfImport.setState({ listening: true });
}

async function runImport() {
  const st = useNsfImport.getState();
  if (!st.file) return;
  if (useStore.getState().dirty && !window.confirm('Importing makes a new project and replaces the current song. Discard unsaved changes?')) return;
  stopListening();
  useNsfImport.setState({ busy: true, progress: 0 });
  try {
    const capture = await captureNsf(st.file, st.track, st.maxMinutes * 60, (p) => useNsfImport.setState({ progress: p }));
    const result = transcribe(st.file, capture, { barsPerPattern: st.barsPerPattern });
    const store = useStore.getState();
    stop();
    store.loadSong(result.song, null);
    useStore.setState({ dirty: true, playMode: 'song', view: 'playlist' });
    const song = result.song;
    const loopBar = Math.floor(song.loopStart / ticksPerBar(song)) + 1;
    toast(
      `Imported ${result.noteCount} notes at ${song.bpm} BPM` +
        (result.loopFound ? `, looping from bar ${loopBar}.` : '. No loop found (the whole capture was used).') +
        ' Press Space to hear it.',
    );
    useNsfImport.setState({ file: null, bytes: null, busy: false });
  } catch (e) {
    useNsfImport.setState({ busy: false });
    toast(`NSF import failed: ${(e as Error).message}`, 'error');
  }
}

export function NsfImportDialog() {
  const st = useNsfImport();
  const file = st.file;
  if (!file) return null;
  const h = file.header;
  const set = (patch: Partial<NsfImportState>) => useNsfImport.setState(patch);

  return (
    <div className="modal-bg" onMouseDown={() => !st.busy && close()}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Import NSF</h2>
        <table>
          <tbody>
            <tr><th>Title</th><td>{h.title || '(untitled)'}</td></tr>
            {h.artist && <tr><th>Artist</th><td>{h.artist}</td></tr>}
            {h.copyright && <tr><th>Copyright</th><td>{h.copyright}</td></tr>}
            <tr><th>System</th><td>{h.region === 'pal' ? 'PAL (Europe)' : 'NTSC (US/Japan)'}, {h.songCount} track{h.songCount > 1 ? 's' : ''}</td></tr>
          </tbody>
        </table>
        {h.expansion.length > 0 && (
          <p className="warn-text">
            This music also uses the {h.expansion.join(' + ')} sound chip from a Japanese Famicom cartridge. Those parts can't be played or imported, so
            it will sound incomplete. Only the NES's own five channels come through.
          </p>
        )}

        <div className="field">
          <label>Track</label>
          <div className="pair">
            <select
              value={st.track}
              disabled={st.busy}
              onChange={(e) => {
                set({ track: Number(e.target.value) });
                if (st.listening) stopListening();
              }}
            >
              {Array.from({ length: h.songCount }, (_, i) => (
                <option key={i} value={i}>Track {i + 1}{i === h.startSong - 1 ? ' (default)' : ''}</option>
              ))}
            </select>
            {st.listening ? (
              <button onClick={stopListening}>■ Stop</button>
            ) : (
              <button onClick={listen} disabled={st.busy} title="Hear the original exactly as the NES plays it">▶ Listen</button>
            )}
          </div>
        </div>
        <div className="field" title="How long to record the track for. Most game tracks loop within 1–2 minutes; the loop is found automatically.">
          <label>Record up to</label>
          <select value={st.maxMinutes} disabled={st.busy} onChange={(e) => set({ maxMinutes: Number(e.target.value) })}>
            {[1, 2, 3, 4, 5].map((m) => (
              <option key={m} value={m}>{m} minute{m > 1 ? 's' : ''}</option>
            ))}
          </select>
        </div>
        <div className="field" title="Size of each pattern in the playlist. Repeated sections reuse the same pattern.">
          <label>Pattern size</label>
          <select value={st.barsPerPattern} disabled={st.busy} onChange={(e) => set({ barsPerPattern: Number(e.target.value) })}>
            {[2, 4, 8].map((b) => (
              <option key={b} value={b}>{b} bars</option>
            ))}
          </select>
        </div>

        <p>
          Importing turns this track into a <b>new editable project</b>: notes, volumes, arpeggio chords, drum hits and samples, with the tempo and
          loop worked out automatically. It's a close transcription rather than a perfect copy. Vibrato, slides and other fast tricks are
          simplified. Use ▶ Listen to compare with the original.
        </p>
        <p className="small">Game music is copyrighted. Imports are great for learning and remixing for yourself, but not for releasing as your own.</p>

        {st.busy && (
          <div className="progress">
            <div style={{ width: `${Math.round(st.progress * 100)}%` }} />
          </div>
        )}
        <div className="modal-actions">
          <button onClick={close} disabled={st.busy}>Cancel</button>
          <button className="active" onClick={runImport} disabled={st.busy}>
            {st.busy ? `Importing… ${Math.round(st.progress * 100)}%` : 'Import as new project'}
          </button>
        </div>
      </div>
    </div>
  );
}
