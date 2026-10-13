import { useMemo } from 'react';
import { create } from 'zustand';
import { toast } from '../actions';
import { previewTranspose, transposeSong } from '../core/transpose';
import { NOTE_NAMES } from '../core/tables';
import { useStore } from '../model/store';
import { CHANNELS } from '../model/types';

interface TransposeState {
  open: boolean;
  semitones: number;
  channels: number[];
}

const useTranspose = create<TransposeState>(() => ({ open: false, semitones: 2, channels: [0, 1, 2] }));

export function openTranspose() {
  useTranspose.setState({ open: true });
}

const INTERVALS: Record<number, string> = {
  1: 'semitone', 2: 'whole tone', 3: 'minor 3rd', 4: 'major 3rd', 5: '4th', 6: 'tritone',
  7: '5th', 8: 'minor 6th', 9: 'major 6th', 10: 'minor 7th', 11: 'major 7th', 12: 'octave',
};

function describe(semis: number) {
  if (semis === 0) return 'no change';
  const name = INTERVALS[Math.abs(semis)];
  const example = `C → ${NOTE_NAMES[(((semis % 12) + 12) % 12)]}`;
  return `${semis > 0 ? 'up' : 'down'} a ${name} (${example})`;
}

export function TransposeDialog() {
  const t = useTranspose();
  const song = useStore((s) => s.song);
  const preview = useMemo(() => (t.open ? previewTranspose(song, t.semitones, t.channels) : null), [t.open, song, t.semitones, t.channels]);
  if (!t.open || !preview) return null;

  const close = () => useTranspose.setState({ open: false });
  const setSemis = (v: number) => useTranspose.setState({ semitones: Math.max(-12, Math.min(12, v)) });
  const toggle = (ch: number) =>
    useTranspose.setState({ channels: t.channels.includes(ch) ? t.channels.filter((c) => c !== ch) : [...t.channels, ch].sort() });
  const apply = () => {
    let result = { moved: 0, adjusted: 0 };
    useStore.getState().update((draft) => {
      result = transposeSong(draft, t.semitones, t.channels);
    });
    close();
    toast(
      `Transposed ${result.moved} notes ${describe(t.semitones)}` +
        (result.adjusted ? `; ${result.adjusted} moved an octave to stay playable.` : '.') +
        ' Cmd+Z to undo.',
    );
  };

  return (
    <div className="modal-bg" onMouseDown={close}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Transpose song</h2>
        <p>Move every note in every pattern up or down, on the channels you choose. Chords and arpeggios keep their shape.</p>

        <div className="field">
          <label>Move by</label>
          <div className="pair">
            <button onClick={() => setSemis(t.semitones - 1)} aria-label="Down a semitone">−</button>
            <select value={t.semitones} onChange={(e) => setSemis(Number(e.target.value))}>
              {Array.from({ length: 25 }, (_, i) => i - 12).map((v) => (
                <option key={v} value={v}>
                  {v > 0 ? `+${v}` : v} semitone{Math.abs(v) === 1 ? '' : 's'}
                </option>
              ))}
            </select>
            <button onClick={() => setSemis(t.semitones + 1)} aria-label="Up a semitone">+</button>
          </div>
        </div>
        <p className="small" style={{ marginTop: -2 }}>{describe(t.semitones)}</p>

        <div className="field" style={{ alignItems: 'start' }}>
          <label>Channels</label>
          <div>
            {CHANNELS.filter((c) => c.kind !== 'dmc').map((c) => (
              <label key={c.index} className="check">
                <input type="checkbox" checked={t.channels.includes(c.index)} onChange={() => toggle(c.index)} />
                {c.name}
                {c.kind === 'noise' && <span className="small"> (drum sounds; usually left alone)</span>}
              </label>
            ))}
            <div className="small">DMC samples can't be transposed.</div>
          </div>
        </div>

        <p className={preview.adjusted ? 'warn-text' : 'small'}>
          {preview.moved} note{preview.moved === 1 ? '' : 's'} will move.
          {preview.adjusted > 0 &&
            ` ${preview.adjusted} would go outside what their channel can play, so they'll be moved an octave to stay on real NES hardware.`}
        </p>

        <div className="modal-actions">
          <button onClick={close}>Cancel</button>
          <button className="active" onClick={apply} disabled={!t.semitones || !t.channels.length}>
            Transpose
          </button>
        </div>
      </div>
    </div>
  );
}
