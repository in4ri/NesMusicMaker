import { useEffect, useRef, useState } from 'react';
import { useInput } from '../audio/liveInput';
import { disableMidi, enableMidi, useMidi } from '../audio/midiInput';
import { useStore } from '../model/store';
import { ARP_STYLES, type ArpStyle } from '../model/types';
import { startMidiImport } from './MidiImportDialog';

export function RecordButton() {
  const record = useInput((s) => s.record);
  const playing = useStore((s) => s.playing);
  return (
    <button
      className={`rec ${record ? 'armed' : ''}`}
      title={
        record
          ? playing
            ? 'Recording into the selected pattern/channel (click to disarm)'
            : 'Step entry: play notes to enter them at the cursor (click to disarm)'
          : 'Arm recording. While playing: records live. While stopped: step entry.'
      }
      onClick={() => useInput.setState({ record: !record })}
    >
      ●
    </button>
  );
}

function ActivityLed() {
  const activity = useMidi((s) => s.activity);
  const [lit, setLit] = useState(false);
  useEffect(() => {
    if (!activity) return;
    setLit(true);
    const t = setTimeout(() => setLit(false), 120);
    return () => clearTimeout(t);
  }, [activity]);
  return <span className="led" style={{ background: lit ? 'var(--green)' : '#333333' }} />;
}

export function MidiMenu() {
  const midi = useMidi();
  const input = useInput();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const value = midi.status === 'on' ? midi.inputId : 'off';
  const statusText: Record<string, string> = {
    requesting: 'Waiting for permission…',
    unsupported: 'Web MIDI is not available here',
    denied: 'MIDI access was denied',
  };

  return (
    <div className="group popover-anchor" ref={ref}>
      <ActivityLed />
      <select
        value={value}
        title={statusText[midi.status] ?? 'MIDI keyboard input (plays the selected channel)'}
        onChange={(e) => (e.target.value === 'off' ? disableMidi() : void enableMidi(e.target.value))}
      >
        <option value="off">MIDI off</option>
        <option value="all">MIDI: all inputs{midi.status === 'on' && !midi.inputs.length ? ' (none found)' : ''}</option>
        {midi.inputs.map((i) => (
          <option key={i.id} value={i.id}>MIDI: {i.name}</option>
        ))}
      </select>
      <button title="Input settings" onClick={() => setOpen(!open)}>⚙</button>
      <button title="Import a MIDI file (Ctrl+I)" onClick={startMidiImport}>Import MIDI</button>
      {open && (
        <div className="popover">
          <h4>Note input</h4>
          <p className="small">Applies to MIDI keyboards and the computer keyboard (Z–M, Q–U). Notes play on the selected channel.</p>
          <label className="check">
            <input type="checkbox" checked={input.velocity} onChange={(e) => useInput.setState({ velocity: e.target.checked })} />
            Velocity controls note volume
          </label>
          <label className="check">
            <input type="checkbox" checked={input.chords} onChange={(e) => useInput.setState({ chords: e.target.checked })} />
            Chords become arpeggios (pulse &amp; triangle)
          </label>
          <div className="field">
            <label>Arp style</label>
            <select value={input.arpStyle} disabled={!input.chords} onChange={(e) => useInput.setState({ arpStyle: e.target.value as ArpStyle })}>
              {ARP_STYLES.map((a) => (
                <option key={a.value} value={a.value}>{a.label}</option>
              ))}
            </select>
          </div>
          <div className="field" title="Frames per arpeggio step: 1 is the classic fast NES arpeggio">
            <label>Arp speed</label>
            <input
              type="number"
              min={1}
              max={16}
              disabled={!input.chords}
              value={input.arpSpeed}
              onChange={(e) => useInput.setState({ arpSpeed: Math.max(1, Math.min(16, Math.round(Number(e.target.value) || 1))) })}
            />
          </div>
          <p className="small">
            Recording (●): while playing, notes are recorded at the playhead and quantised to the piano roll snap. While stopped, each note or chord is
            entered at the step cursor, which then advances by one snap.
          </p>
        </div>
      )}
    </div>
  );
}
