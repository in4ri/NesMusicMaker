import { useEffect, useState } from 'react';
import { addPattern, deletePattern, exportNsf, exportWav, newProject, openProject, saveProject } from '../actions';
import { playheadTick, stop, togglePlay } from '../audio/sync';
import { REGIONS } from '../core/tables';
import { currentPattern, usePlayhead, useStore } from '../model/store';
import { CHANNELS, PPQ, ticksPerBar } from '../model/types';
import { PATTERN_COLORS } from '../model/defaults';

function Position() {
  const frame = usePlayhead((s) => s.frame);
  const song = useStore((s) => s.song);
  const playing = useStore((s) => s.playing);
  const tick = playing ? playheadTick(frame) : 0;
  const bar = Math.floor(tick / ticksPerBar(song)) + 1;
  const beat = Math.floor((tick % ticksPerBar(song)) / PPQ) + 1;
  const step = Math.floor((tick % PPQ) / (PPQ / 4)) + 1;
  return <div className="lcd" title="Bar : Beat : Step">{`${String(bar).padStart(3, '0')}:${beat}:${step}`}</div>;
}

function Meters() {
  const meters = usePlayhead((s) => s.meters);
  return (
    <div className="meters" title="Channel levels">
      {CHANNELS.map((c, i) => (
        <div key={c.index} className="meter">
          <div style={{ height: `${Math.min(1, meters[i] ?? 0) * 100}%`, background: c.color }} />
        </div>
      ))}
    </div>
  );
}

export function Toolbar({ onHelp }: { onHelp: () => void }) {
  const s = useStore();
  const pattern = currentPattern(s);
  const [bpmText, setBpmText] = useState(String(s.song.bpm));
  useEffect(() => setBpmText(String(s.song.bpm)), [s.song.bpm]);

  const commitBpm = () => {
    const v = Math.max(30, Math.min(400, Math.round(Number(bpmText) || s.song.bpm)));
    setBpmText(String(v));
    if (v !== s.song.bpm) s.update((song) => void (song.bpm = v));
  };
  const framesPerStep = (REGIONS[s.song.region].frameRate * 60) / (s.song.bpm * 4);
  const exact = Math.abs(framesPerStep - Math.round(framesPerStep)) < 0.05;

  return (
    <div className="toolbar">
      <span className="logo">NES MUSIC MAKER</span>
      <div className="group">
        <button title="New project (Ctrl+N)" onClick={newProject}>New</button>
        <button title="Open project (Ctrl+O)" onClick={openProject}>Open</button>
        <button title="Save project (Ctrl+S)" onClick={() => saveProject()}>Save{s.dirty ? '*' : ''}</button>
        <button title="Export audio (Ctrl+E)" onClick={exportWav}>WAV</button>
        <button title="Export NES music file (Ctrl+Shift+E)" onClick={exportNsf}>NSF</button>
      </div>
      <div className="sep" />
      <div className="group transport">
        <button className={`play ${s.playing ? 'active' : ''}`} title="Play / Stop (Space)" onClick={togglePlay}>
          {s.playing ? '❚❚' : '▶'}
        </button>
        <button title="Stop" onClick={stop}>■</button>
      </div>
      <div className="group">
        <button className={s.playMode === 'pattern' ? 'active' : ''} onClick={() => s.set({ playMode: 'pattern' })} title="Play the selected pattern on loop">
          PAT
        </button>
        <button className={s.playMode === 'song' ? 'active' : ''} onClick={() => s.set({ playMode: 'song' })} title="Play the whole playlist">
          SONG
        </button>
      </div>
      <Position />
      <div className="group" title={`${framesPerStep.toFixed(2)} frames per 16th step${exact ? '' : ' (uneven: steps alternate lengths)'}`}>
        <label>BPM</label>
        <input
          type="number"
          value={bpmText}
          onChange={(e) => setBpmText(e.target.value)}
          onBlur={commitBpm}
          onKeyDown={(e) => e.key === 'Enter' && commitBpm()}
        />
        <span className="small" style={{ color: exact ? 'var(--green)' : 'var(--text-dim)' }}>
          {framesPerStep.toFixed(1)}f
        </span>
      </div>
      <div className="group">
        <select value={s.song.region} onChange={(e) => s.update((song) => void (song.region = e.target.value as 'ntsc' | 'pal'))} title="NTSC = 60 Hz (US/Japan), PAL = 50 Hz (Europe)">
          <option value="ntsc">NTSC</option>
          <option value="pal">PAL</option>
        </select>
      </div>
      <div className="sep" />
      <div className="group">
        <label>Pattern</label>
        <span style={{ width: 10, height: 10, borderRadius: 2, background: pattern?.color }} />
        <select value={s.selectedPatternId} onChange={(e) => s.set({ selectedPatternId: e.target.value, selectedNoteIds: [] })}>
          {s.song.patterns.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <button title="New pattern" onClick={() => addPattern(false)}>+</button>
        <button title="Clone pattern" onClick={() => addPattern(true)}>⧉</button>
        <button title="Delete pattern" onClick={deletePattern}>🗑</button>
        {pattern && (
          <>
            <input
              type="text"
              style={{ width: 90 }}
              value={pattern.name}
              onFocus={() => s.checkpoint()}
              onChange={(e) => s.mutate((song) => void (song.patterns.find((p) => p.id === pattern.id)!.name = e.target.value))}
              title="Pattern name"
            />
            <select
              value={pattern.bars}
              title="Pattern length in bars"
              onChange={(e) => s.update((song) => void (song.patterns.find((p) => p.id === pattern.id)!.bars = Number(e.target.value)))}
            >
              {[1, 2, 3, 4, 6, 8, 12, 16].map((b) => (
                <option key={b} value={b}>{b} bar{b > 1 ? 's' : ''}</option>
              ))}
            </select>
            <select
              value={pattern.color}
              title="Pattern colour"
              style={{ background: pattern.color, color: '#111', width: 34 }}
              onChange={(e) => s.update((song) => void (song.patterns.find((p) => p.id === pattern.id)!.color = e.target.value))}
            >
              {PATTERN_COLORS.map((c) => (
                <option key={c} value={c} style={{ background: c }}>■</option>
              ))}
            </select>
          </>
        )}
      </div>
      <div className="sep" />
      <div className="group">
        <input
          className="title-input"
          type="text"
          placeholder="Song title"
          value={s.song.title}
          onFocus={() => s.checkpoint()}
          onChange={(e) => s.mutate((song) => void (song.title = e.target.value))}
        />
        <input
          type="text"
          style={{ width: 110 }}
          placeholder="Author"
          value={s.song.author}
          onFocus={() => s.checkpoint()}
          onChange={(e) => s.mutate((song) => void (song.author = e.target.value))}
        />
      </div>
      <div style={{ flex: 1 }} />
      <div className="group" title="Master volume">
        <label>Vol</label>
        <input type="range" min={0} max={1} step={0.01} value={s.masterGain} onChange={(e) => s.set({ masterGain: Number(e.target.value) })} style={{ width: 70 }} />
      </div>
      <Meters />
      <button onClick={onHelp} title="NES sound basics and shortcuts">?</button>
    </div>
  );
}
