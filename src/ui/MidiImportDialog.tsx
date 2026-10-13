import { create } from 'zustand';
import { toast } from '../actions';
import { parseMidi, type MidiFile } from '../core/midi';
import { buildMidiImport, midiSources, suggestMappings, type MidiImportOptions, type MidiSource, type Polyphony, type SourceMapping } from '../core/midiImport';
import { noteName } from '../core/tables';
import { useStore } from '../model/store';
import { ARP_STYLES, CHANNELS, PPQ, type ArpStyle } from '../model/types';
import { pickFile } from '../platform/files';

interface ImportState {
  file: MidiFile | null;
  sources: MidiSource[];
  mappings: SourceMapping[];
  options: MidiImportOptions;
}

const useImport = create<ImportState>(() => ({
  file: null,
  sources: [],
  mappings: [],
  options: { quantize: PPQ / 4, barsPerPattern: 4, useVelocity: true, useTempo: true, placement: 'append', name: 'MIDI', arpStyle: 'up', arpSpeed: 1 },
}));

export async function startMidiImport() {
  const picked = await pickFile('.mid,.midi,audio/midi');
  if (picked) openMidiImport(new Uint8Array(await picked.arrayBuffer()), picked.name);
}

/** Parse MIDI bytes and open the import dialog. */
export function openMidiImport(bytes: Uint8Array, fileName: string) {
  try {
    const file = parseMidi(bytes);
    const sources = midiSources(file).filter((s) => s.notes.length);
    if (!sources.length) throw new Error('The file has no notes');
    const song = useStore.getState().song;
    const name = fileName.replace(/\.midi?$/i, '').slice(0, 20) || 'MIDI';
    useImport.setState((s) => ({
      file,
      sources,
      mappings: suggestMappings(sources, song),
      options: { ...s.options, name, placement: song.playlist.length ? 'append' : 'replace' },
    }));
  } catch (e) {
    toast(`Could not read MIDI file: ${(e as Error).message}`, 'error');
  }
}

function applyImport() {
  const { file, sources, mappings, options } = useImport.getState();
  if (!file) return;
  const s = useStore.getState();
  const r = buildMidiImport(s.song, file, sources, mappings, options);
  if (!r.patterns.length) {
    toast('Nothing to import: map at least one part to an NES channel', 'error');
    return;
  }
  s.update((song) => {
    song.bpm = r.bpm;
    if (r.replace) {
      song.beatsPerBar = r.beatsPerBar;
      song.patterns = r.patterns;
      song.playlist = r.clips;
      song.loopStart = 0;
      song.automation = [];
    } else {
      song.patterns.push(...r.patterns);
      song.playlist.push(...r.clips);
    }
  });
  s.set({ selectedPatternId: r.patterns[0].id, selectedNoteIds: [], playMode: 'song', view: 'playlist', songStartTick: r.clips[0].start });
  useImport.setState({ file: null });
  toast(`Imported ${r.patterns.length} pattern${r.patterns.length > 1 ? 's' : ''}${r.droppedNotes ? ` (${r.droppedNotes} chord notes dropped)` : ''}`);
}

const QUANTIZE = [
  { label: '1/4', ticks: PPQ },
  { label: '1/8', ticks: PPQ / 2 },
  { label: '1/16', ticks: PPQ / 4 },
  { label: '1/16 triplet', ticks: PPQ / 6 },
  { label: '1/32', ticks: PPQ / 8 },
  { label: 'Off', ticks: 1 },
];

export function MidiImportDialog() {
  const { file, sources, mappings, options } = useImport();
  const song = useStore((s) => s.song);
  if (!file) return null;
  const close = () => useImport.setState({ file: null });
  const setMapping = (i: number, patch: Partial<SourceMapping>) =>
    useImport.setState((st) => ({ mappings: st.mappings.map((m, k) => (k === i ? { ...m, ...patch } : m)) }));
  const setOption = (patch: Partial<MidiImportOptions>) => useImport.setState((st) => ({ options: { ...st.options, ...patch } }));
  const anyArp = mappings.some((m) => m.polyphony === 'arpeggio' && m.target >= 0 && m.target <= 2);

  return (
    <div className="modal-bg" onMouseDown={close}>
      <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Import MIDI</h2>
        <p>
          The NES plays one note per channel. Choose which parts go to which channel and how chords are handled.
          Drums on MIDI channel 10 are mapped to noise kicks, snares and hats automatically.
        </p>
        <table>
          <thead>
            <tr>
              <th>Part</th>
              <th>Notes</th>
              <th>NES channel</th>
              <th>Chords</th>
              <th>Instrument</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((src, i) => {
              const m = mappings[i];
              const kind = m.target >= 0 ? CHANNELS[m.target].kind : null;
              return (
                <tr key={src.key}>
                  <td>
                    {src.name}
                    {src.isDrums && <span className="small"> · drums</span>}
                  </td>
                  <td className="small">
                    {src.notes.length} · {src.isDrums ? 'GM kit' : `${noteName(src.low)}–${noteName(src.high)}`}
                    {src.chordRatio > 0.05 && ` · ${Math.round(src.chordRatio * 100)}% chords`}
                  </td>
                  <td>
                    <select
                      value={m.target}
                      onChange={(e) => {
                        const target = Number(e.target.value);
                        setMapping(i, { target, instrument: target >= 0 ? song.channels[target].instrument : '', polyphony: target === 2 ? 'lowest' : m.polyphony });
                      }}
                    >
                      <option value={-1}>— ignore —</option>
                      {CHANNELS.filter((c) => c.kind !== 'dmc').map((c) => (
                        <option key={c.index} value={c.index}>{c.name}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select value={m.polyphony} disabled={m.target < 0 || kind === 'noise'} onChange={(e) => setMapping(i, { polyphony: e.target.value as Polyphony })}>
                      <option value="highest">Highest note</option>
                      <option value="lowest">Lowest note</option>
                      <option value="arpeggio">Arpeggio</option>
                    </select>
                  </td>
                  <td>
                    <select value={m.instrument} disabled={m.target < 0} onChange={(e) => setMapping(i, { instrument: e.target.value })}>
                      {song.instruments.map((inst) => (
                        <option key={inst.id} value={inst.id}>{inst.name}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="options-grid">
          <div className="field">
            <label>Quantise</label>
            <select value={options.quantize} onChange={(e) => setOption({ quantize: Number(e.target.value) })}>
              {QUANTIZE.map((q) => (
                <option key={q.ticks} value={q.ticks}>{q.label}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Pattern size</label>
            <select value={options.barsPerPattern} onChange={(e) => setOption({ barsPerPattern: Number(e.target.value) })}>
              {[1, 2, 4, 8, 16].map((b) => (
                <option key={b} value={b}>{b} bar{b > 1 ? 's' : ''}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Placement</label>
            <select value={options.placement} onChange={(e) => setOption({ placement: e.target.value as MidiImportOptions['placement'] })}>
              <option value="append">Append to song</option>
              <option value="replace">Replace patterns &amp; playlist</option>
            </select>
          </div>
          <div className="field">
            <label>Arp style</label>
            <select value={options.arpStyle} disabled={!anyArp} onChange={(e) => setOption({ arpStyle: e.target.value as ArpStyle })}>
              {ARP_STYLES.map((a) => (
                <option key={a.value} value={a.value}>{a.label}</option>
              ))}
            </select>
          </div>
          <div className="field" title="Frames per arpeggio step">
            <label>Arp speed</label>
            <input type="number" min={1} max={16} disabled={!anyArp} value={options.arpSpeed} onChange={(e) => setOption({ arpSpeed: Math.max(1, Math.min(16, Number(e.target.value) || 1)) })} />
          </div>
          <label className="check">
            <input type="checkbox" checked={options.useVelocity} onChange={(e) => setOption({ useVelocity: e.target.checked })} />
            Velocity → volume
          </label>
          <label className="check" title={file.tempoChanges > 1 ? `The file has ${file.tempoChanges} tempo changes; only the first is used` : ''}>
            <input type="checkbox" checked={options.useTempo} disabled={!file.bpm} onChange={(e) => setOption({ useTempo: e.target.checked })} />
            {file.bpm ? `Use MIDI tempo (${Math.round(file.bpm)} BPM${file.tempoChanges > 1 ? ', first of several' : ''})` : 'No tempo in file (keeps song BPM)'}
          </label>
        </div>
        <p className="small">Arpeggio style and speed can be changed later per note in the piano roll.</p>
        <div className="modal-actions">
          <button onClick={close}>Cancel</button>
          <button className="active" onClick={applyImport}>Import</button>
        </div>
      </div>
    </div>
  );
}
