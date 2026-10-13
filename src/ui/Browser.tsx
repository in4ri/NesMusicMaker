import { useEffect, useRef } from 'react';
import { saveInstrumentPreset, saveSamplePreset } from '../library';
import { PresetLibrary } from './PresetLibrary';
import { addInstrument, deleteInstrument, deleteSample, importSample } from '../actions';
import { previewNote } from '../audio/sync';
import { base64ToBytes, decodeDmc, dmcSampleRate, layoutDmc } from '../core/dmc';
import { DMC_MEMORY_SIZE } from '../core/tables';
import { useStore } from '../model/store';
import type { DmcSample } from '../model/types';

function Waveform({ sample }: { sample: DmcSample }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const w = (c.width = c.clientWidth * devicePixelRatio);
    const h = (c.height = c.clientHeight * devicePixelRatio);
    const g = c.getContext('2d')!;
    const pcm = decodeDmc(base64ToBytes(sample.data));
    g.clearRect(0, 0, w, h);
    g.strokeStyle = '#ffffff';
    g.beginPath();
    for (let x = 0; x < w; x++) {
      const i = Math.floor((x / w) * pcm.length);
      const y = h / 2 - pcm[i] * (h / 2) * 0.9;
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }, [sample.data]);
  return <canvas ref={ref} />;
}

export function Browser() {
  const song = useStore((s) => s.song);
  const selectedInstrumentId = useStore((s) => s.selectedInstrumentId);
  const view = useStore((s) => s.view);
  const set = useStore((s) => s.set);
  const update = useStore((s) => s.update);
  const selectedChannel = useStore((s) => s.selectedChannel);
  const layout = layoutDmc(song.samples);

  const setSample = (i: number, fn: (s: DmcSample) => void) => update((song) => fn(song.samples[i]));

  return (
    <div className="browser">
      <h3>
        Instruments
        <button onClick={() => addInstrument()} title="New instrument">+ New</button>
      </h3>
      {song.instruments.map((inst) => (
        <div
          key={inst.id}
          className={`list-item ${inst.id === selectedInstrumentId && view === 'instrument' ? 'selected' : ''}`}
          onClick={() => {
            set({ selectedInstrumentId: inst.id, view: 'instrument' });
            const ch = selectedChannel === 4 ? 0 : selectedChannel;
            previewNote(ch, ch === 3 ? 12 : ch === 2 ? 48 : 60, inst.id);
          }}
          title="Click to edit and audition"
        >
          <span className="swatch" style={{ background: inst.color }} />
          <span className="name">{inst.name}</span>
          <button className="mini" title="Save to your preset library (use it in any song)" onClick={(e) => (e.stopPropagation(), saveInstrumentPreset(inst))}>☆</button>
          <button className="mini" title="Duplicate" onClick={(e) => (e.stopPropagation(), addInstrument(inst))}>⧉</button>
          <button className="mini" title="Delete" onClick={(e) => (e.stopPropagation(), deleteInstrument(inst.id))}>✕</button>
        </div>
      ))}

      <h3 style={{ marginTop: 10 }}>
        DMC Samples
        <button onClick={importSample} title="Import a WAV/MP3/OGG file">+ Import</button>
      </h3>
      <div className="usage" title={`DMC memory: ${layout.used} / ${DMC_MEMORY_SIZE} bytes`}>
        <div style={{ width: `${Math.min(100, (layout.used / DMC_MEMORY_SIZE) * 100)}%` }} />
      </div>
      {song.samples.length === 0 && (
        <div className="hint">Import short drum hits or bass sounds. They are converted to the NES's 1-bit delta format (16 KB total).</div>
      )}
      {song.samples.map((sample, i) => (
        <div key={sample.id} className="sample-item">
          <div className="row" style={{ marginTop: 0 }}>
            <button className="rack-btn" title="Play" onClick={() => previewNote(4, i, '')}>▶</button>
            <input
              type="text"
              value={sample.name}
              style={{ flex: 1, minWidth: 0 }}
              onFocus={() => useStore.getState().checkpoint()}
              onChange={(e) => useStore.getState().mutate((song) => void (song.samples[i].name = e.target.value))}
            />
            <button className="rack-btn" title="Save to your preset library (use it in any song)" onClick={() => saveSamplePreset(sample)}>☆</button>
            <button className="rack-btn" title="Delete sample" onClick={() => deleteSample(i)}>✕</button>
          </div>
          <Waveform sample={sample} />
          <div className="row">
            <label>Rate</label>
            <select
              value={sample.rate}
              onChange={(e) => setSample(i, (s) => void (s.rate = Number(e.target.value)))}
              title="Playback rate (pitch). Imported at rate 15."
            >
              {Array.from({ length: 16 }, (_, r) => (
                <option key={r} value={r}>{r} ({(dmcSampleRate(r, song.region) / 1000).toFixed(1)}k)</option>
              ))}
            </select>
            <label title="Loop the sample while the note is held">
              <input type="checkbox" checked={sample.loop} onChange={(e) => setSample(i, (s) => void (s.loop = e.target.checked))} /> Loop
            </label>
          </div>
          {!layout.entries[i] && <div className="small" style={{ color: 'var(--red)' }}>Doesn't fit in DMC memory</div>}
        </div>
      ))}

      <PresetLibrary />
    </div>
  );
}
