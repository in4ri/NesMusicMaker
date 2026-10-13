import { useEffect, useState } from 'react';
import { currentPattern, useStore } from '../model/store';
import { CHANNELS, PPQ, type Note, type NoteFx } from '../model/types';

const SNAPS: { label: string; ticks: number }[] = [
  { label: 'Bar', ticks: PPQ * 4 },
  { label: '1/4 (beat)', ticks: PPQ },
  { label: '1/8', ticks: PPQ / 2 },
  { label: '1/16 (step)', ticks: PPQ / 4 },
  { label: '1/16 triplet', ticks: PPQ / 6 },
  { label: '1/32', ticks: PPQ / 8 },
  { label: 'None', ticks: 1 },
];

/** Value shared by all notes, or undefined if mixed. */
function common<T>(notes: Note[], get: (n: Note) => T): T | undefined {
  if (!notes.length) return undefined;
  const v = get(notes[0]);
  return notes.every((n) => get(n) === v) ? v : undefined;
}

function NumField(props: { label: string; value: number | undefined; min: number; max: number; title?: string; onChange: (v: number) => void }) {
  const [text, setText] = useState(props.value === undefined ? '' : String(props.value));
  useEffect(() => setText(props.value === undefined ? '' : String(props.value)), [props.value]);
  const commit = (t: string) => {
    if (t.trim() === '') return;
    const v = Math.max(props.min, Math.min(props.max, Math.round(Number(t))));
    if (!Number.isNaN(v)) props.onChange(v);
  };
  return (
    <div className="field" title={props.title}>
      <label>{props.label}</label>
      <input
        type="number"
        min={props.min}
        max={props.max}
        value={text}
        placeholder="mixed"
        onChange={(e) => {
          setText(e.target.value);
          commit(e.target.value);
        }}
        onFocus={() => useStore.getState().checkpoint()}
      />
    </div>
  );
}

export function NotePanel() {
  const s = useStore();
  const pattern = currentPattern(s);
  const ch = s.selectedChannel;
  const kind = CHANNELS[ch].kind;
  const pitched = kind === 'pulse' || kind === 'triangle';
  const sel = new Set(s.selectedNoteIds);
  const notes = pattern ? pattern.notes[ch].filter((n) => sel.has(n.id)) : [];

  const edit = (fn: (n: Note) => void, record = false) => {
    const apply = (song: Parameters<Parameters<typeof s.update>[0]>[0]) => {
      const p = song.patterns.find((x) => x.id === pattern!.id);
      if (p) for (const n of p.notes[ch]) if (sel.has(n.id)) fn(n as Note);
    };
    if (record) s.update(apply);
    else s.mutate(apply);
  };
  const setFx = <K extends keyof NoteFx>(key: K, value: NoteFx[K] | undefined, record = false) =>
    edit((n) => {
      if (value === undefined || value === 0) delete n.fx[key];
      else n.fx[key] = value;
    }, record);

  const arpText = common(notes, (n) => (n.fx.arp ?? []).join(' '));

  return (
    <div className="side-panel">
      <h4>Grid</h4>
      <div className="field">
        <label>Snap</label>
        <select value={s.snap} onChange={(e) => s.set({ snap: Number(e.target.value) })}>
          {SNAPS.map((o) => (
            <option key={o.ticks} value={o.ticks}>{o.label}</option>
          ))}
        </select>
      </div>
      {kind !== 'dmc' && (
        <div className="field" title="Instrument used for new notes on this channel">
          <label>Draw with</label>
          <select value={s.song.channels[ch].instrument} onChange={(e) => s.update((song) => void (song.channels[ch].instrument = e.target.value))}>
            {s.song.instruments.map((i) => (
              <option key={i.id} value={i.id}>{i.name}</option>
            ))}
          </select>
        </div>
      )}

      <h4>{notes.length ? `${notes.length} note${notes.length > 1 ? 's' : ''} selected` : 'No notes selected'}</h4>
      {notes.length > 0 && (
        <>
          {kind !== 'dmc' && (
            <div className="field">
              <label>Instrument</label>
              <select value={common(notes, (n) => n.instrument) ?? ''} onChange={(e) => edit((n) => void (n.instrument = e.target.value), true)}>
                {common(notes, (n) => n.instrument) === undefined && <option value="">(mixed)</option>}
                {s.song.instruments.map((i) => (
                  <option key={i.id} value={i.id}>{i.name}</option>
                ))}
              </select>
            </div>
          )}
          {kind === 'dmc' && (
            <div className="field">
              <label>Sample</label>
              <select value={common(notes, (n) => n.pitch) ?? ''} onChange={(e) => edit((n) => void (n.pitch = Number(e.target.value)), true)}>
                {common(notes, (n) => n.pitch) === undefined && <option value="">(mixed)</option>}
                {s.song.samples.map((smp, i) => (
                  <option key={smp.id} value={i}>{smp.name}</option>
                ))}
              </select>
            </div>
          )}
          {kind !== 'dmc' && (
            <NumField label="Volume" min={0} max={15} value={common(notes, (n) => n.volume)} onChange={(v) => edit((n) => void (n.volume = v))} title={kind === 'triangle' ? 'Triangle has no volume control: 0 = silent, anything else = full' : '0–15'} />
          )}
          {(kind === 'pulse' || kind === 'noise') && (
            <div className="field" title="Override the instrument's duty envelope">
              <label>{kind === 'noise' ? 'Mode' : 'Duty'}</label>
              <select
                value={common(notes, (n) => n.fx.duty ?? -1) ?? ''}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  edit((n) => {
                    if (v < 0) delete n.fx.duty;
                    else n.fx.duty = v;
                  }, true);
                }}
              >
                <option value="">(mixed)</option>
                <option value={-1}>From instrument</option>
                {kind === 'pulse' ? (
                  <>
                    <option value={0}>12.5% (thin)</option>
                    <option value={1}>25% (classic)</option>
                    <option value={2}>50% (square)</option>
                    <option value={3}>75%</option>
                  </>
                ) : (
                  <>
                    <option value={0}>Hiss (long)</option>
                    <option value={1}>Metallic (short)</option>
                  </>
                )}
              </select>
            </div>
          )}

          <h4>Effects</h4>
          {pitched && (
            <>
              <NumField label="Glide" min={0} max={64} value={common(notes, (n) => n.fx.glide ?? 0)} onChange={(v) => setFx('glide', v)} title="Frames to slide from the previous note (legato portamento)" />
              <NumField label="Bend" min={-24} max={24} value={common(notes, (n) => n.fx.bend ?? 0)} onChange={(v) => setFx('bend', v)} title="Semitones to bend over the note's length" />
              <div className="field" title="Vibrato depth (1/8 semitone) and speed">
                <label>Vibrato</label>
                <div className="pair">
                  <input
                    type="number" min={0} max={15} placeholder="depth"
                    value={common(notes, (n) => n.fx.vibratoDepth ?? 0) ?? ''}
                    onFocus={() => s.checkpoint()}
                    onChange={(e) => setFx('vibratoDepth', Math.max(0, Math.min(15, Number(e.target.value) || 0)))}
                  />
                  <input
                    type="number" min={0} max={15} placeholder="speed"
                    value={common(notes, (n) => n.fx.vibratoSpeed ?? 0) ?? ''}
                    onFocus={() => s.checkpoint()}
                    onChange={(e) => setFx('vibratoSpeed', Math.max(0, Math.min(15, Number(e.target.value) || 0)))}
                  />
                </div>
              </div>
            </>
          )}
          {kind !== 'dmc' && (
            <div className="field" title="Arpeggio chord: semitone offsets cycled every frame, e.g. 0 4 7 (major) or 0 3 7 (minor)">
              <label>Arp chord</label>
              <ArpInput value={arpText} onChange={(arp) => setFx('arp', arp.length ? arp : undefined, true)} />
            </div>
          )}
          <NumField label="Delay" min={0} max={30} value={common(notes, (n) => n.fx.delay ?? 0)} onChange={(v) => setFx('delay', v)} title="Frames to delay the note start (swing / flams)" />
          <NumField label="Cut" min={0} max={255} value={common(notes, (n) => n.fx.cut ?? 0)} onChange={(v) => setFx('cut', v)} title="Cut the note after N frames (0 = off)" />
        </>
      )}

      <h4>Mouse</h4>
      <ul className="help-list">
        <li>Click: add note, drag to move</li>
        <li>Drag right edge: resize</li>
        <li>Right-click: delete</li>
        <li>Shift/Ctrl-drag: select box</li>
        <li>Alt-drag / middle: pan</li>
        <li>Wheel: scroll · Ctrl+wheel: zoom · Alt+wheel: row height</li>
        <li>Bottom lane: drag to set volume</li>
      </ul>
      <h4>Keys</h4>
      <ul className="help-list">
        <li><span className="kbd">↑↓</span> transpose (Shift = octave)</li>
        <li><span className="kbd">←→</span> nudge by snap</li>
        <li><span className="kbd">Ctrl+C/X/V</span> copy/cut/paste</li>
        <li><span className="kbd">Ctrl+D</span> duplicate after</li>
        <li><span className="kbd">Del</span> delete selection</li>
      </ul>
    </div>
  );
}

function ArpInput({ value, onChange }: { value: string | undefined; onChange: (arp: number[]) => void }) {
  const [text, setText] = useState(value ?? '');
  useEffect(() => setText(value ?? ''), [value]);
  const commit = () => {
    const arp = text
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n) && Math.abs(n) <= 36)
      .map(Math.round)
      .slice(0, 8);
    onChange(arp);
  };
  return (
    <input
      type="text"
      placeholder={value === undefined ? 'mixed' : 'e.g. 0 4 7'}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  );
}
