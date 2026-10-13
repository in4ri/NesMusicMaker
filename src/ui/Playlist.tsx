import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { playheadTick } from '../audio/sync';
import { songEndTick } from '../core/compiler';
import { usePlayhead, useStore } from '../model/store';
import { CHANNELS, PLAYLIST_TRACKS, newId, patternLength, ticksPerBar, type Clip } from '../model/types';

const HEAD_W = 92;
const RULER_H = 26;
const TRACK_H = 46;

type Drag =
  | { kind: 'move'; clipId: string; startX: number; startY: number; origStart: number; origTrack: number }
  | { kind: 'erase' }
  | { kind: 'pan'; startX: number; sx: number; startY: number; sy: number };

export function Playlist() {
  const s = useStore();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 800, h: 400 });
  const view = useRef({ scrollX: 0, scrollY: 0, pxPerTick: 80 / 192 });
  const drag = useRef<Drag | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const geo = useCallback(() => {
    const v = view.current;
    return {
      x: (t: number) => HEAD_W + t * v.pxPerTick - v.scrollX,
      tickAt: (x: number) => (x - HEAD_W + v.scrollX) / v.pxPerTick,
      y: (track: number) => RULER_H + track * TRACK_H - v.scrollY,
      trackAt: (y: number) => Math.floor((y - RULER_H + v.scrollY) / TRACK_H),
    };
  }, []);

  const clampScroll = () => {
    const v = view.current;
    v.scrollX = Math.max(0, v.scrollX);
    v.scrollY = Math.max(0, Math.min(Math.max(0, PLAYLIST_TRACKS * TRACK_H - (size.h - RULER_H)), v.scrollY));
  };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = devicePixelRatio;
    if (canvas.width !== size.w * dpr || canvas.height !== size.h * dpr) {
      canvas.width = size.w * dpr;
      canvas.height = size.h * dpr;
      canvas.style.width = `${size.w}px`;
      canvas.style.height = `${size.h}px`;
    }
    const g = canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const st = useStore.getState();
    const song = st.song;
    const G = geo();
    const v = view.current;
    const W = size.w, H = size.h;
    const bar = ticksPerBar(song);
    const font = getComputedStyle(document.body).fontFamily;

    g.fillStyle = '#1e2128';
    g.fillRect(0, 0, W, H);

    g.save();
    g.beginPath();
    g.rect(HEAD_W, RULER_H, W - HEAD_W, H - RULER_H);
    g.clip();
    for (let t = 0; t < PLAYLIST_TRACKS; t++) {
      const y = G.y(t);
      g.fillStyle = t % 2 ? '#262931' : '#2b2f38';
      g.fillRect(HEAD_W, y, W, TRACK_H);
      g.fillStyle = '#1b1d23';
      g.fillRect(HEAD_W, y + TRACK_H - 1, W, 1);
    }
    const b0 = Math.max(0, Math.floor(G.tickAt(HEAD_W) / bar));
    const b1 = Math.ceil(G.tickAt(W) / bar);
    for (let b = b0; b <= b1; b++) {
      const x = Math.round(G.x(b * bar)) + 0.5;
      g.fillStyle = b % 4 === 0 ? '#4a5060' : '#353a46';
      g.fillRect(x, RULER_H, 1, H);
      if (v.pxPerTick * song.beatsPerBar * 48 > 60) {
        for (let k = 1; k < song.beatsPerBar; k++) {
          g.fillStyle = '#2d313b';
          g.fillRect(x + (k * bar * v.pxPerTick) / song.beatsPerBar, RULER_H, 1, H);
        }
      }
    }

    // Clips
    for (const clip of song.playlist) {
      const p = song.patterns.find((x) => x.id === clip.pattern);
      if (!p) continue;
      const x = G.x(clip.start);
      const w = patternLength(song, p) * v.pxPerTick;
      const y = G.y(clip.track);
      if (x > W || x + w < HEAD_W) continue;
      const selected = p.id === st.selectedPatternId;
      g.fillStyle = p.color + (selected ? 'ee' : 'aa');
      g.fillRect(x + 1, y + 2, w - 2, TRACK_H - 5);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(x + 1, y + 2, w - 2, 13);
      g.fillStyle = '#fff';
      g.font = `bold 10px ${font}`;
      g.textBaseline = 'middle';
      g.save();
      g.beginPath();
      g.rect(x, y, w - 2, TRACK_H);
      g.clip();
      g.fillText(p.name, x + 4, y + 9);
      // Mini preview: one lane per channel
      const plen = patternLength(song, p);
      const laneH = (TRACK_H - 20) / CHANNELS.length;
      p.notes.forEach((notes, ch) => {
        g.fillStyle = 'rgba(0,0,0,0.55)';
        for (const n of notes) {
          if (n.tick >= plen) continue;
          g.fillRect(x + n.tick * v.pxPerTick, y + 16 + ch * laneH, Math.max(1, Math.min(n.length, plen - n.tick) * v.pxPerTick - 1), Math.max(1, laneH - 1));
        }
      });
      g.restore();
      if (selected) {
        g.strokeStyle = '#fff';
        g.lineWidth = 1;
        g.strokeRect(x + 1.5, y + 2.5, w - 3, TRACK_H - 6);
      }
    }

    // Song end + loop
    const end = songEndTick(song);
    g.fillStyle = '#f7a440';
    g.fillRect(G.x(end), RULER_H, 2, H);
    g.restore();

    // Ruler
    g.fillStyle = '#22252d';
    g.fillRect(HEAD_W, 0, W, RULER_H);
    g.font = `11px ${font}`;
    g.textBaseline = 'middle';
    const labelEvery = v.pxPerTick * bar < 30 ? 4 : 1;
    for (let b = b0; b <= b1; b++) {
      const x = G.x(b * bar);
      if (x < HEAD_W) continue;
      g.fillStyle = '#5a6275';
      g.fillRect(x, RULER_H - 8, 1, 8);
      if (b % labelEvery === 0) {
        g.fillStyle = '#d8dce6';
        g.fillText(String(b + 1), x + 3, 9);
      }
    }
    // Loop marker
    const lx = G.x(song.loopStart);
    if (lx >= HEAD_W) {
      g.fillStyle = '#51cf66';
      g.fillRect(lx, 12, 2, RULER_H - 12);
      g.beginPath();
      g.moveTo(lx, 12);
      g.lineTo(lx + 22, 12);
      g.lineTo(lx + 22, 24);
      g.lineTo(lx, 24);
      g.fill();
      g.fillStyle = '#111';
      g.font = `bold 9px ${font}`;
      g.fillText('LOOP', lx + 2, 18.5);
    }
    // Start marker
    const sx = G.x(st.songStartTick);
    if (sx >= HEAD_W) {
      g.fillStyle = '#f7a440';
      g.beginPath();
      g.moveTo(sx - 6, 0);
      g.lineTo(sx + 6, 0);
      g.lineTo(sx, 9);
      g.fill();
    }

    // Track headers
    g.fillStyle = '#22252d';
    g.fillRect(0, 0, HEAD_W, H);
    g.save();
    g.beginPath();
    g.rect(0, RULER_H, HEAD_W, H - RULER_H);
    g.clip();
    for (let t = 0; t < PLAYLIST_TRACKS; t++) {
      const y = G.y(t);
      g.fillStyle = '#2a2e38';
      g.fillRect(2, y + 2, HEAD_W - 4, TRACK_H - 4);
      g.fillStyle = '#8b93a7';
      g.font = `11px ${font}`;
      g.fillText(`Track ${t + 1}`, 10, y + TRACK_H / 2);
    }
    g.restore();

    // Playhead
    if (st.playing && st.playMode === 'song') {
      const x = G.x(playheadTick(usePlayhead.getState().frame));
      if (x >= HEAD_W) {
        g.fillStyle = '#9dfc9d';
        g.fillRect(x, 0, 2, H);
      }
    }
  }, [size, geo]);

  useEffect(() => {
    clampScroll();
    draw();
  });
  useEffect(() => usePlayhead.subscribe(() => useStore.getState().playing && draw()), [draw]);

  const localPos = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const clipAt = (x: number, y: number): Clip | null => {
    const st = useStore.getState();
    const G = geo();
    const track = G.trackAt(y);
    for (let i = st.song.playlist.length - 1; i >= 0; i--) {
      const c = st.song.playlist[i];
      if (c.track !== track) continue;
      const p = st.song.patterns.find((pp) => pp.id === c.pattern);
      if (!p) continue;
      if (x >= G.x(c.start) && x <= G.x(c.start + patternLength(st.song, p))) return c;
    }
    return null;
  };

  const snapStart = (t: number, fine: boolean) => {
    const st = useStore.getState();
    const unit = fine ? 48 : ticksPerBar(st.song);
    return Math.max(0, Math.round(t / unit) * unit);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const { x, y } = localPos(e);
    const st = useStore.getState();
    const G = geo();
    (e.target as Element).setPointerCapture(e.pointerId);
    if (e.button === 1 || (e.button === 0 && e.altKey && y > RULER_H)) {
      drag.current = { kind: 'pan', startX: x, sx: view.current.scrollX, startY: y, sy: view.current.scrollY };
      return;
    }
    if (x < HEAD_W) return;
    if (y < RULER_H) {
      const bar = ticksPerBar(st.song);
      const t = Math.max(0, Math.floor(G.tickAt(x) / bar) * bar);
      if (e.shiftKey || e.button === 2) st.update((song) => void (song.loopStart = t));
      else st.set({ songStartTick: t });
      return;
    }
    const track = G.trackAt(y);
    if (track < 0 || track >= PLAYLIST_TRACKS) return;
    const hit = clipAt(x, y);
    if (e.button === 2) {
      st.checkpoint();
      drag.current = { kind: 'erase' };
      if (hit) st.mutate((song) => void (song.playlist = song.playlist.filter((c) => c.id !== hit.id)));
      return;
    }
    st.checkpoint();
    if (hit) {
      st.set({ selectedPatternId: hit.pattern, selectedNoteIds: [] });
      let clip = hit;
      if (e.shiftKey) {
        clip = { ...hit, id: newId('c') };
        st.mutate((song) => void song.playlist.push(clip));
      }
      drag.current = { kind: 'move', clipId: clip.id, startX: x, startY: y, origStart: clip.start, origTrack: clip.track };
      return;
    }
    const pattern = st.song.patterns.find((p) => p.id === st.selectedPatternId);
    if (!pattern) return;
    const start = Math.max(0, Math.floor(G.tickAt(x) / ticksPerBar(st.song)) * ticksPerBar(st.song));
    const clip: Clip = { id: newId('c'), pattern: pattern.id, track, start };
    st.mutate((song) => void song.playlist.push(clip));
    drag.current = { kind: 'move', clipId: clip.id, startX: x, startY: y, origStart: start, origTrack: track };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const { x, y } = localPos(e);
    const d = drag.current;
    const canvas = canvasRef.current!;
    if (!d) {
      canvas.style.cursor = y < RULER_H && x > HEAD_W ? 'pointer' : clipAt(x, y) ? 'move' : 'default';
      return;
    }
    const st = useStore.getState();
    if (d.kind === 'pan') {
      view.current.scrollX = d.sx - (x - d.startX);
      view.current.scrollY = d.sy - (y - d.startY);
      clampScroll();
      draw();
    } else if (d.kind === 'erase') {
      const hit = clipAt(x, y);
      if (hit) st.mutate((song) => void (song.playlist = song.playlist.filter((c) => c.id !== hit.id)));
    } else if (d.kind === 'move') {
      const start = snapStart(d.origStart + (x - d.startX) / view.current.pxPerTick, e.ctrlKey || e.metaKey);
      const track = Math.max(0, Math.min(PLAYLIST_TRACKS - 1, d.origTrack + Math.round((y - d.startY) / TRACK_H)));
      const cur = st.song.playlist.find((c) => c.id === d.clipId);
      if (cur && (cur.start !== start || cur.track !== track)) {
        st.mutate((song) => {
          const c = song.playlist.find((cc) => cc.id === d.clipId)!;
          c.start = start;
          c.track = track;
        });
      }
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const { x, y } = localPos(e);
    const hit = clipAt(x, y);
    if (hit) useStore.getState().set({ selectedPatternId: hit.pattern, view: 'pianoroll' });
  };

  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  wheelRef.current = (e: WheelEvent) => {
    e.preventDefault();
    const v = view.current;
    if (e.ctrlKey || e.metaKey) {
      const { x } = localPos(e);
      const t = geo().tickAt(x);
      v.pxPerTick = Math.max(0.05, Math.min(3, v.pxPerTick * Math.exp(-e.deltaY * 0.01)));
      v.scrollX = t * v.pxPerTick - (x - HEAD_W);
    } else if (e.shiftKey) {
      v.scrollX += e.deltaY || e.deltaX;
    } else {
      v.scrollX += e.deltaX;
      v.scrollY += e.deltaY;
    }
    clampScroll();
    draw();
  };
  useEffect(() => {
    const c = canvasRef.current!;
    const h = (e: WheelEvent) => wheelRef.current(e);
    c.addEventListener('wheel', h, { passive: false });
    return () => c.removeEventListener('wheel', h);
  }, []);

  return (
    <div className="editor-body">
      <div className="canvas-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
          onDoubleClick={onDoubleClick}
          onContextMenu={(e) => e.preventDefault()}
        />
      </div>
      <div className="side-panel">
        <h4>Place pattern</h4>
        {s.song.patterns.map((p) => (
          <div
            key={p.id}
            className={`list-item ${p.id === s.selectedPatternId ? 'selected' : ''}`}
            onClick={() => s.set({ selectedPatternId: p.id, selectedNoteIds: [] })}
            onDoubleClick={() => s.set({ selectedPatternId: p.id, view: 'pianoroll' })}
          >
            <span className="swatch" style={{ background: p.color }} />
            <span className="name">{p.name}</span>
            <span className="small">{p.bars} bar{p.bars > 1 ? 's' : ''}</span>
          </div>
        ))}
        <h4>Song</h4>
        <div className="field">
          <label>Loop from bar</label>
          <input
            type="number"
            min={1}
            value={s.song.loopStart / ticksPerBar(s.song) + 1}
            onChange={(e) => {
              const b = Math.max(1, Math.round(Number(e.target.value) || 1));
              s.update((song) => void (song.loopStart = (b - 1) * ticksPerBar(song)));
            }}
          />
        </div>
        <div className="small" style={{ marginBottom: 8 }}>
          Length: {Math.round(songEndTick(s.song) / ticksPerBar(s.song))} bars. NSF exports loop forever from the loop point, like game music.
        </div>
        <h4>Mouse</h4>
        <ul className="help-list">
          <li>Click empty: place selected pattern</li>
          <li>Drag clip: move (Ctrl = beat snap)</li>
          <li>Shift-drag clip: duplicate</li>
          <li>Right-click: delete clip</li>
          <li>Double-click clip: edit pattern</li>
          <li>Click ruler: set play start</li>
          <li>Shift/right-click ruler: set loop point</li>
          <li>Ctrl+wheel: zoom</li>
        </ul>
      </div>
    </div>
  );
}
