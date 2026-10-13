import { useMemo, useState } from 'react';
import { saveSoundEffects, useSfxExport } from '../actions';
import { soundEffects, type SoundEffect } from '../core/sfxExport';
import { useStore } from '../model/store';
import { CHANNELS } from '../model/types';
import { isElectron } from '../platform/files';

/** Silent patterns start unticked: they can't be sound effects. */
const makesSound = (e: SoundEffect) => e.facts.channels.length > 0 || e.facts.usesDmc;

export function SoundEffectsDialog() {
  const open = useSfxExport((s) => s.open);
  const song = useStore((s) => s.song);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const effects = useMemo(() => (open ? soundEffects(song) : []), [open, song]);
  if (!open) return null;

  const isPicked = (e: SoundEffect) => picked[e.patternId] ?? makesSound(e);
  const chosen = effects.filter(isPicked);
  const close = () => useSfxExport.setState({ open: false });
  const doExport = async () => {
    setBusy(true);
    const done = await saveSoundEffects(chosen.map((e) => e.patternId));
    setBusy(false);
    if (done) close();
  };

  return (
    <div className="modal-bg" onMouseDown={close}>
      <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Export sound effects</h2>
        <p>
          Saves each ticked pattern as its own NSF file, named after the pattern, into a folder you choose. Files with the same names are
          replaced. In NES Game Builder, add the folder once under Music &amp; Sounds; when you export again, it picks up the changes.
        </p>
        <p className="small">
          A game sound effect can use at most 2 channels, last at most 4 seconds and can't use DMC samples. The game cuts off the silent rest
          of the pattern, so the length shown is up to the last sound.
        </p>
        {song.region === 'pal' && (
          <p className="warn-text">
            This project is set to PAL. NES Game Builder only accepts NTSC sound effects: switch the Region box in the toolbar to NTSC, then
            export.
          </p>
        )}
        <table>
          <thead>
            <tr>
              <th />
              <th>Pattern</th>
              <th>File</th>
              <th>Length</th>
              <th>Channels</th>
            </tr>
          </thead>
          <tbody>
            {effects.map((e) => (
              <tr key={e.patternId}>
                <td>
                  <input type="checkbox" checked={isPicked(e)} onChange={() => setPicked({ ...picked, [e.patternId]: !isPicked(e) })} />
                </td>
                <td>
                  {e.title || <span className="small">(no name)</span>}
                  {e.warnings.map((w) => (
                    <div key={w} className="small" style={{ color: 'var(--accent)' }}>
                      ⚠ {w}
                    </div>
                  ))}
                </td>
                <td className="small">{e.fileName}</td>
                <td>{e.facts.frames ? `${e.facts.seconds.toFixed(2)} s` : '–'}</td>
                <td>{[...e.facts.channels.map((ch) => CHANNELS[ch].short), ...(e.facts.usesDmc ? ['DMC'] : [])].join(' + ') || '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="modal-actions">
          <button onClick={close}>Cancel</button>
          <button className="active" disabled={!chosen.length || busy} onClick={() => void doExport()}>
            {isElectron() ? `Export ${chosen.length} to folder…` : `Download ${chosen.length} file${chosen.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
