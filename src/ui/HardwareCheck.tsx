import { useMemo } from 'react';
import { exportNsf, exportSoundEffects, exportWav, useCheck } from '../actions';
import { checkSong, exportSummary } from '../core/hardwareCheck';
import { useStore } from '../model/store';

/** Toolbar badge: green when everything plays on real hardware as drawn, amber with a count otherwise. */
export function HardwareButton() {
  const song = useStore((s) => s.song);
  const errors = useMemo(() => checkSong(song).filter((i) => i.severity === 'error').length, [song]);
  return (
    <button
      className={`hw-badge ${errors ? 'warn' : 'ok'}`}
      title={errors ? `${errors} thing${errors > 1 ? 's' : ''} won't play on a real NES as drawn. Click to review.` : 'Everything plays on a real NES as you hear it. Click for details.'}
      onClick={() => useCheck.setState({ open: true, pendingExport: null })}
    >
      {errors ? `⚠ ${errors}` : '✓ NES'}
    </button>
  );
}

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  return `${m}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
}

export function HardwareCheckDialog() {
  const { open, pendingExport } = useCheck();
  const song = useStore((s) => s.song);
  const update = useStore((s) => s.update);
  const issues = useMemo(() => (open ? checkSong(song) : []), [open, song]);
  const summary = useMemo(() => (open ? exportSummary(song) : null), [open, song]);
  if (!open || !summary) return null;

  const close = () => useCheck.setState({ open: false, pendingExport: null });
  const errors = issues.filter((i) => i.severity === 'error');
  const fixable = issues.filter((i) => i.fix);
  const doExport = () => {
    const kind = pendingExport;
    close();
    if (kind === 'wav') void exportWav(true);
    if (kind === 'nsf') void exportNsf(true);
    if (kind === 'sfx') exportSoundEffects(true);
  };

  return (
    <div className="modal-bg" onMouseDown={close}>
      <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Hardware check</h2>
        <p>
          {summary.region === 'ntsc' ? 'NTSC: for US/Japan consoles (60 Hz).' : 'PAL: for UK/European consoles (50 Hz).'} Song length {formatTime(summary.seconds)}, then
          it loops. NSF file about {Math.ceil(summary.nsfBytes / 1024)} KB.
        </p>
        {issues.length === 0 ? (
          <p className="hw-ok">✓ Everything will play on a real NES exactly as you hear it.</p>
        ) : (
          <div className="hw-list">
            {issues.map((issue) => (
              <div key={issue.key} className={`hw-issue ${issue.severity}`}>
                <div className="hw-icon">{issue.severity === 'error' ? '⚠' : 'ℹ'}</div>
                <div className="hw-text">
                  <div className="hw-title">{issue.title}</div>
                  <div className="small">{issue.detail}</div>
                </div>
                {issue.fix && (
                  <button onClick={() => update((draft) => issue.fix!.apply(draft))}>{issue.fix.label}</button>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="modal-actions">
          {fixable.length > 1 && (
            <button onClick={() => update((draft) => fixable.forEach((i) => i.fix!.apply(draft)))} style={{ marginRight: 'auto' }}>
              Fix all ({fixable.length})
            </button>
          )}
          <button onClick={close}>{pendingExport ? 'Cancel' : 'Close'}</button>
          {pendingExport && (
            <button className="active" onClick={doExport}>
              {errors.length ? `Export ${pendingExport.toUpperCase()} anyway` : `Export ${pendingExport.toUpperCase()}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
