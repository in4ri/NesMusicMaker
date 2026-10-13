import { useRef } from 'react';
import { playheadTick, previewNote } from '../audio/sync';
import { lowestPitch, resolveOverlaps } from '../core/hardware';
import { noteName } from '../core/tables';
import { makeNote } from '../model/defaults';
import { currentPattern, usePlayhead, useStore } from '../model/store';
import { CHANNELS, TICKS_PER_STEP, type ChannelInfo } from '../model/types';

export function pitchOptions(kind: ChannelInfo['kind'], sampleNames: string[], lowest = 24) {
  if (kind === 'noise') return Array.from({ length: 16 }, (_, i) => ({ value: i, label: `Noise ${i.toString(16).toUpperCase()}` }));
  if (kind === 'dmc') return sampleNames.map((n, i) => ({ value: i, label: n }));
  const out = [];
  for (let p = 96; p >= Math.max(24, lowest); p--) out.push({ value: p, label: noteName(p) });
  return out;
}

function Led({ ch }: { ch: number }) {
  const level = usePlayhead((s) => s.meters[ch] ?? 0);
  const color = CHANNELS[ch].color;
  return <span className="led" style={{ background: level > 0.01 ? color : '#333', opacity: 0.35 + Math.min(1, level) * 0.65 }} />;
}

function PlayingStep({ steps }: { steps: number }) {
  const frame = usePlayhead((s) => s.frame);
  const playing = useStore((s) => s.playing && s.playMode === 'pattern');
  const step = playing ? Math.floor(playheadTick(frame) / TICKS_PER_STEP) : -1;
  return <style>{step >= 0 && step < steps ? `.steps .step[data-step="${step}"] { border-color: #fff; }` : ''}</style>;
}

export function ChannelRack() {
  const s = useStore();
  const pattern = currentPattern(s);
  const paintMode = useRef<'add' | 'remove' | null>(null);
  if (!pattern) return null;
  const steps = pattern.bars * s.song.beatsPerBar * 4;

  const toggleStep = (ch: number, step: number, mode: 'add' | 'remove') => {
    const tick = step * TICKS_PER_STEP;
    const settings = s.song.channels[ch];
    s.mutate((song) => {
      const p = song.patterns.find((x) => x.id === pattern.id)!;
      const list = p.notes[ch];
      const existing = list.filter((n) => n.tick >= tick && n.tick < tick + TICKS_PER_STEP);
      if (mode === 'remove') {
        p.notes[ch] = list.filter((n) => !existing.includes(n));
      } else if (!existing.length) {
        // '' = use the channel's sound. A step inside a longer note shortens that note (one note at a time).
        const note = makeNote(tick, TICKS_PER_STEP, settings.stepPitch, '');
        p.notes[ch] = resolveOverlaps([...list, note], ch, new Set([note.id]));
      }
    });
    if (mode === 'add') previewNote(ch, settings.stepPitch, '');
  };

  const onStepDown = (e: React.MouseEvent, ch: number, step: number, on: boolean) => {
    e.preventDefault();
    s.checkpoint();
    const mode = on || e.button === 2 ? 'remove' : 'add';
    paintMode.current = mode;
    toggleStep(ch, step, mode);
    const up = () => {
      paintMode.current = null;
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mouseup', up);
  };

  const toggleMute = (ch: number) => s.set({ mutes: s.mutes.map((m, i) => (i === ch ? !m : m)) });
  const toggleSolo = (ch: number) => s.set({ solo: s.solo === ch ? -1 : ch });

  /** Change the step note, and re-pitch this pattern's plain one-step notes that were on the old step note. */
  const setStepNote = (ch: number, v: number) => {
    const old = s.song.channels[ch].stepPitch;
    s.update((song) => {
      song.channels[ch].stepPitch = v;
      const p = song.patterns.find((x) => x.id === pattern.id)!;
      for (const n of p.notes[ch]) if (n.pitch === old && n.length === TICKS_PER_STEP) n.pitch = v;
      p.notes[ch] = resolveOverlaps(p.notes[ch], ch);
    });
    previewNote(ch, v, '');
  };

  return (
    <div className="rack" onContextMenu={(e) => e.preventDefault()}>
      <PlayingStep steps={steps} />
      <div className="rack-row rack-header">
        <span className="rack-header-gap" />
        <span className="rack-select" title="The instrument this whole channel plays with">Sound</span>
        <span className="rack-pitch" title="The note a step plays">Step note</span>
        <span>Steps: click to add or remove, drag to paint</span>
      </div>
      {CHANNELS.map((c) => {
        const notes = pattern.notes[c.index];
        const settings = s.song.channels[c.index];
        const options = pitchOptions(c.kind, s.song.samples.map((x) => x.name), lowestPitch(c.index, s.song.region));
        return (
          <div key={c.index} className="rack-row">
            <Led ch={c.index} />
            <button
              className={`rack-btn mute ${s.mutes[c.index] ? 'off' : ''}`}
              title="Mute"
              onClick={() => toggleMute(c.index)}
            >
              {s.mutes[c.index] ? '○' : '●'}
            </button>
            <button className={`rack-btn solo ${s.solo === c.index ? 'on' : ''}`} title="Solo" onClick={() => toggleSolo(c.index)}>
              S
            </button>
            <button
              className={`rack-name ${s.selectedChannel === c.index && s.view === 'pianoroll' ? 'selected' : ''}`}
              style={{ borderLeftColor: c.color }}
              title="Open in piano roll"
              onClick={() => s.set({ selectedChannel: c.index, view: 'pianoroll', selectedNoteIds: [] })}
            >
              {c.name}
            </button>
            {c.kind !== 'dmc' ? (
              <select
                className="rack-select"
                value={settings.instrument}
                title={
                  c.kind === 'triangle'
                    ? "This channel's sound. The NES triangle has no volume or tone control, so instruments only change its pitch effects (arpeggio, pitch) and note length."
                    : "This channel's sound: every note on it plays with this instrument (unless a note has its own)"
                }
                onChange={(e) => {
                  const inst = e.target.value;
                  s.update((song) => void (song.channels[c.index].instrument = inst));
                  previewNote(c.index, settings.stepPitch, inst);
                }}
              >
                {s.song.instruments.map((i) => (
                  <option key={i.id} value={i.id}>{i.name}</option>
                ))}
              </select>
            ) : (
              <span className="rack-select small" style={{ display: 'inline-block' }}>Samples →</span>
            )}
            <select
              className="rack-pitch"
              value={settings.stepPitch}
              title={
                c.kind === 'dmc'
                  ? 'The sample a step plays'
                  : "The note a step plays. Changing it also moves this pattern's one-step notes that were on the old note."
              }
              onChange={(e) => setStepNote(c.index, Number(e.target.value))}
            >
              {options.length === 0 && <option value={0}>(none)</option>}
              {options.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <div className="steps">
              {Array.from({ length: steps / 4 }, (_, beat) => (
                <div className="beat" key={beat}>
                  {[0, 1, 2, 3].map((k) => {
                    const step = beat * 4 + k;
                    const tick = step * TICKS_PER_STEP;
                    const here = notes.filter((n) => n.tick >= tick && n.tick < tick + TICKS_PER_STEP);
                    const on = here.length > 0;
                    const long = here.some((n) => n.length > TICKS_PER_STEP);
                    return (
                      <div
                        key={k}
                        data-step={step}
                        className={`step ${on ? (long ? 'long' : 'on') : ''}`}
                        title={on ? here.map((n) => (c.kind === 'pulse' || c.kind === 'triangle' ? noteName(n.pitch) : n.pitch)).join(', ') : ''}
                        onMouseDown={(e) => onStepDown(e, c.index, step, on)}
                        onMouseEnter={() => {
                          if (!paintMode.current) return;
                          if ((paintMode.current === 'add') !== on) toggleStep(c.index, step, paintMode.current);
                        }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
