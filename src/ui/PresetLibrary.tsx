import { useMemo, useState } from 'react';
import { previewPresetInstrument, previewPresetSample } from '../audio/sync';
import {
  addPresetInstrumentToSong,
  addPresetSampleToSong,
  exportLibrary,
  importLibrary,
  removePreset,
  renamePreset,
  useLibrary,
} from '../library';
import { defaultInstruments } from '../model/defaults';
import { useStore } from '../model/store';
import type { Instrument } from '../model/types';

/** Channel and pitch to audition an instrument preset on (follows the selected channel). */
function auditionTarget() {
  const ch = useStore.getState().selectedChannel;
  const channel = ch === 4 ? 0 : ch;
  return { channel, pitch: channel === 3 ? 12 : channel === 2 ? 48 : 60 };
}

function NameCell({ libId, name }: { libId: string; name: string }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(name);
  if (!editing) {
    return (
      <span className="name" title="Double-click to rename" onDoubleClick={(e) => (e.stopPropagation(), setText(name), setEditing(true))}>
        {name}
      </span>
    );
  }
  const commit = () => {
    renamePreset(libId, text);
    setEditing(false);
  };
  return (
    <input
      className="name-edit"
      autoFocus
      value={text}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setEditing(false);
      }}
    />
  );
}

export function PresetLibrary() {
  const library = useLibrary((s) => s.library);
  const [tab, setTab] = useState<'instruments' | 'samples'>('instruments');
  const [showBuiltIn, setShowBuiltIn] = useState(false);
  const builtIns = useMemo(() => defaultInstruments(), []);

  const auditionInstrument = (preset: Omit<Instrument, 'id'>) => {
    const { channel, pitch } = auditionTarget();
    previewPresetInstrument(channel, pitch, preset);
  };

  return (
    <>
      <h3 style={{ marginTop: 10 }}>
        Preset library
        <span className="h3-buttons">
          <button onClick={importLibrary} title="Add presets from a file (yours or a friend's)">Import</button>
          <button onClick={exportLibrary} title="Save all your presets to a file (backup or sharing)">Export</button>
        </span>
      </h3>
      <div className="lib-tabs">
        <button className={tab === 'instruments' ? 'active' : ''} onClick={() => setTab('instruments')}>
          Instruments ({library.instruments.length})
        </button>
        <button className={tab === 'samples' ? 'active' : ''} onClick={() => setTab('samples')}>
          Samples ({library.samples.length})
        </button>
      </div>

      {tab === 'instruments' && (
        <>
          {library.instruments.length === 0 && (
            <div className="hint">Click ☆ on any instrument above to save it here. Saved presets are available in every song.</div>
          )}
          {library.instruments.map((e) => (
            <div key={e.libId} className="list-item" onClick={() => auditionInstrument(e.instrument)} title="Click to hear it">
              <span className="swatch" style={{ background: e.instrument.color }} />
              <NameCell libId={e.libId} name={e.instrument.name} />
              <button className="mini" title="Add to this song" onClick={(ev) => (ev.stopPropagation(), addPresetInstrumentToSong(e.instrument))}>+</button>
              <button className="mini" title="Remove from library" onClick={(ev) => (ev.stopPropagation(), removePreset(e.libId))}>✕</button>
            </div>
          ))}
          <div className="list-item lib-group" onClick={() => setShowBuiltIn(!showBuiltIn)}>
            <span className="name">{showBuiltIn ? '▾' : '▸'} Built-in instruments</span>
          </div>
          {showBuiltIn &&
            builtIns.map((inst) => (
              <div key={inst.name} className="list-item" onClick={() => auditionInstrument(inst)} title="Click to hear it">
                <span className="swatch" style={{ background: inst.color }} />
                <span className="name">{inst.name}</span>
                <button className="mini" title="Add to this song" onClick={(ev) => (ev.stopPropagation(), addPresetInstrumentToSong(inst))}>+</button>
              </div>
            ))}
        </>
      )}

      {tab === 'samples' && (
        <>
          {library.samples.length === 0 && <div className="hint">Click ☆ on a DMC sample to save it here for use in other songs.</div>}
          {library.samples.map((e) => (
            <div key={e.libId} className="list-item" onClick={() => previewPresetSample(e.sample)} title="Click to hear it">
              <span className="swatch" style={{ background: '#9cfcf0' }} />
              <NameCell libId={e.libId} name={e.sample.name} />
              <button className="mini" title="Add to this song" onClick={(ev) => (ev.stopPropagation(), addPresetSampleToSong(e.sample))}>+</button>
              <button className="mini" title="Remove from library" onClick={(ev) => (ev.stopPropagation(), removePreset(e.libId))}>✕</button>
            </div>
          ))}
        </>
      )}
    </>
  );
}
