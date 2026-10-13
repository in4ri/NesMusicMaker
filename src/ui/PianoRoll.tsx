import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { playheadTick, previewNote } from '../audio/sync';
import { noteName } from '../core/tables';
import { makeNote } from '../model/defaults';
import { currentPattern, usePlayhead, useStore } from '../model/store';
import { CHANNELS, PPQ, TICKS_PER_STEP, newId, patternLength, type Note, type Pattern, type Song } from '../model/types';
import { NotePanel } from './NotePanel';

const KEYS_W = 64;
const RULER_H = 22;
const LANE_H = 84;
const EDGE_PX = 6;

interface Row {
  pitch: number;
  label: string;
  black: boolean;
  c: boolean;
}

export function channelRows(ch: number, song: Song): Row[] {
  const kind = CHANNELS[ch].kind;
  if (kind === 'noise') {
    return Array.from({ length: 16 }, (_, i) => {
      const p = 15 - i;
      return { pitch: p, label: `${p.toString(16).toUpperCase()}${p === 15 ? ' high' : p === 0 ? ' low' : ''}`, black: p % 2 === 1, c: p % 4 === 0 };
    });
  }
  if (kind === 'dmc') {
    if (!song.samples.length) return [{ pitch: 0, label: '(no samples)', black: false, c: false }];
    return song.samples.map((s, i) => ({ pitch: i, label: s.name, black: i % 2 === 1, c: false }));
  }
  const rows: Row[] = [];
  for (let p = 108; p >= 21; p--) {
    const n = p % 12;
    rows.push({ pitch: p, label: noteName(p), black: [1, 3, 6, 8, 10].includes(n), c: n === 0 });
  }
  return rows;
}

// Clipboard shared between patterns/channels.
let clipboard: { notes: Note[]; span: number } | null = null;

type Drag =
  | { kind: 'move'; startX: number; startY: number; hitId: string; orig: Map<string, { tick: number; pitch: number }>; lastPitch: number }
  | { kind: 'resize'; startX: number; orig: Map<string, number> }
  | { kind: 'box'; x0: number; y0: number; x1: number; y1: number; additive: string[] }
  | { kind: 'erase' }
  | { kind: 'velocity' }
  | { kind: 'pan'; startX: number; startY: number; sx: number; sy: number };

export function PianoRoll() {
  const s = useStore();
  const pattern = currentPattern(s);
  const ch = s.selectedChannel;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 800, h: 400 });
  const view = useRef({ scrollX: 0, scrollY: 0, pxPerTick: 2, rowH: 14 });
  const drag = useRef<Drag | null>(null);
  const lastLength = useRef(TICKS_PER_STEP * 2);
  const [, force] = useState(0);
  const rows = channelRows(ch, s.song);
  const kind = CHANNELS[ch].kind;
  const laneH = kind === 'dmc' ? 0 : LANE_H;
  const rowH = kind === 'dmc' ? 28 : kind === 'noise' ? 20 : view.current.rowH;

  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // When switching channel or pattern, scroll so the notes are visible.
  useEffect(() => {
    const st = useStore.getState();
    const p = currentPattern(st);
    const r = channelRows(ch, st.song);
    const notes = p?.notes[ch] ?? [];
    const target = notes.length ? notes.reduce((a, n) => a + n.pitch, 0) / notes.length : kind === 'triangle' ? 48 : 64;
    const idx = r.findIndex((row) => row.pitch <= Math.round(target));
    const gridH = size.h - RULER_H - laneH;
    view.current.scrollY = Math.max(0, idx * rowH - gridH / 2);
    view.current.scrollX = 0;
    force((x) => x + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ch, s.selectedPatternId]);

  const geometry = useCallback(() => {
    const v = view.current;
    const gridBottom = size.h - laneH;
    return {
      x: (tick: number) => KEYS_W + tick * v.pxPerTick - v.scrollX,
      tickAt: (x: number) => (x - KEYS_W + v.scrollX) / v.pxPerTick,
      y: (row: number) => RULER_H + row * rowH - v.scrollY,
      rowAt: (y: number) => Math.floor((y - RULER_H + v.scrollY) / rowH),
      gridBottom,
    };
  }, [size, rowH, laneH]);

  const clampScroll = useCallback(() => {
    const v = view.current;
    const maxY = Math.max(0, rows.length * rowH - (size.h - RULER_H - laneH));
    v.scrollY = Math.max(0, Math.min(maxY, v.scrollY));
    v.scrollX = Math.max(0, v.scrollX);
  }, [rows.length, rowH, size, laneH]);

  // ---------- Drawing ----------
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pattern) return;
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
    const geo = geometry();
    const v = view.current;
    const plen = patternLength(song, pattern);
    const tpb = song.beatsPerBar * PPQ;
    const W = size.w;
    const selected = new Set(st.selectedNoteIds);
    const instColor = new Map(song.instruments.map((i) => [i.id, i.color]));

    g.fillStyle = '#1e2128';
    g.fillRect(0, 0, W, size.h);

    // Rows
    g.save();
    g.beginPath();
    g.rect(KEYS_W, RULER_H, W - KEYS_W, geo.gridBottom - RULER_H);
    g.clip();
    rows.forEach((row, i) => {
      const y = geo.y(i);
      if (y + rowH < RULER_H || y > geo.gridBottom) return;
      g.fillStyle = row.black ? '#23262e' : '#2b2f38';
      g.fillRect(KEYS_W, y, W, rowH);
      g.fillStyle = row.c ? '#454b5a' : '#20232a';
      g.fillRect(KEYS_W, y + rowH - 1, W, 1);
    });

    // Vertical grid
    const t0 = Math.max(0, Math.floor(geo.tickAt(KEYS_W)));
    const t1 = Math.ceil(geo.tickAt(W));
    const gridStep = v.pxPerTick * st.snap >= 6 ? st.snap : TICKS_PER_STEP;
    for (let t = Math.floor(t0 / gridStep) * gridStep; t <= t1; t += gridStep) {
      const x = Math.round(geo.x(t)) + 0.5;
      g.fillStyle = t % tpb === 0 ? '#5a6275' : t % PPQ === 0 ? '#3f4554' : '#2a2e37';
      g.fillRect(x, RULER_H, 1, geo.gridBottom - RULER_H);
    }
    // Outside the pattern
    const endX = geo.x(plen);
    if (endX < W) {
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fillRect(endX, RULER_H, W - endX, geo.gridBottom);
      g.fillStyle = '#f7a440';
      g.fillRect(endX, RULER_H, 2, geo.gridBottom - RULER_H);
    }

    const rowIndex = new Map(rows.map((r, i) => [r.pitch, i]));

    // Ghost notes from other channels of the same type (pulse/triangle share a pitch layout).
    if (kind === 'pulse' || kind === 'triangle') {
      CHANNELS.forEach((c) => {
        if (c.index === ch || (c.kind !== 'pulse' && c.kind !== 'triangle')) return;
        g.fillStyle = c.color + '30';
        for (const n of pattern.notes[c.index]) {
          const ri = rowIndex.get(n.pitch);
          if (ri === undefined) continue;
          g.fillRect(geo.x(n.tick), geo.y(ri) + 1, n.length * v.pxPerTick, rowH - 2);
        }
      });
    }

    // Notes
    g.font = `${Math.min(11, rowH - 3)}px ${getComputedStyle(document.body).fontFamily}`;
    g.textBaseline = 'middle';
    for (const n of pattern.notes[ch]) {
      const ri = rowIndex.get(n.pitch);
      if (ri === undefined) continue;
      const x = geo.x(n.tick);
      const y = geo.y(ri);
      const w = Math.max(3, n.length * v.pxPerTick);
      if (x > W || x + w < KEYS_W || y > geo.gridBottom || y + rowH < RULER_H) continue;
      const color = kind === 'dmc' ? CHANNELS[4].color : instColor.get(n.instrument) ?? '#aaa';
      g.globalAlpha = 0.35 + (n.volume / 15) * 0.65;
      g.fillStyle = color;
      g.fillRect(x + 0.5, y + 1, w - 1, rowH - 2);
      g.globalAlpha = 1;
      g.strokeStyle = selected.has(n.id) ? '#ffffff' : 'rgba(0,0,0,0.5)';
      g.lineWidth = selected.has(n.id) ? 2 : 1;
      g.strokeRect(x + 0.5, y + 1.5, w - 1, rowH - 3);
      // right-edge grip
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.fillRect(x + w - 3, y + 2, 2, rowH - 4);
      const fx = n.fx;
      const marks = [
        fx.glide ? '⤴' : '',
        fx.bend ? (fx.bend > 0 ? '↗' : '↘') : '',
        fx.vibratoDepth && fx.vibratoSpeed ? '~' : '',
        fx.arp?.length ? '♯' : '',
        fx.delay ? '»' : '',
        fx.cut ? '✂' : '',
        fx.duty !== undefined && fx.duty >= 0 ? 'D' : '',
      ].join('');
      const label = (kind === 'pulse' || kind === 'triangle' ? noteName(n.pitch) : kind === 'noise' ? n.pitch.toString(16).toUpperCase() : rows[ri].label) + (marks ? ' ' + marks : '');
      if (w > 22 && rowH >= 10) {
        g.fillStyle = '#111';
        g.save();
        g.beginPath();
        g.rect(x, y, w - 3, rowH);
        g.clip();
        g.fillText(label, x + 3, y + rowH / 2 + 0.5);
        g.restore();
      }
    }

    const d = drag.current;
    if (d && d.kind === 'box') {
      g.fillStyle = 'rgba(92,124,250,0.15)';
      g.strokeStyle = '#5c7cfa';
      g.lineWidth = 1;
      const bx = Math.min(d.x0, d.x1), by = Math.min(d.y0, d.y1);
      g.fillRect(bx, by, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      g.strokeRect(bx + 0.5, by + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    }
    g.restore();

    // Velocity lane
    if (laneH) {
      const top = geo.gridBottom;
      g.fillStyle = '#17191e';
      g.fillRect(0, top, W, laneH);
      g.fillStyle = '#3a3f4d';
      g.fillRect(0, top, W, 1);
      g.fillStyle = '#8b93a7';
      g.font = `10px ${getComputedStyle(document.body).fontFamily}`;
      g.fillText('Volume', 8, top + 12);
      g.save();
      g.beginPath();
      g.rect(KEYS_W, top, W - KEYS_W, laneH);
      g.clip();
      for (const n of pattern.notes[ch]) {
        const x = geo.x(n.tick);
        const h = (n.volume / 15) * (laneH - 14);
        g.fillStyle = selected.has(n.id) ? '#ffffff' : instColor.get(n.instrument) ?? '#aaa';
        g.fillRect(x, top + laneH - h - 2, 3, h);
        g.beginPath();
        g.arc(x + 1.5, top + laneH - h - 2, 3, 0, Math.PI * 2);
        g.fill();
      }
      g.restore();
    }

    // Ruler
    g.fillStyle = '#22252d';
    g.fillRect(KEYS_W, 0, W, RULER_H);
    g.fillStyle = '#3a3f4d';
    g.fillRect(KEYS_W, RULER_H - 1, W, 1);
    g.font = `11px ${getComputedStyle(document.body).fontFamily}`;
    for (let t = Math.floor(t0 / PPQ) * PPQ; t <= t1; t += PPQ) {
      const x = geo.x(t);
      if (x < KEYS_W) continue;
      if (t % tpb === 0) {
        g.fillStyle = '#d8dce6';
        g.fillText(String(t / tpb + 1), x + 3, RULER_H / 2);
        g.fillRect(x, 4, 1, RULER_H - 4);
      } else {
        g.fillStyle = '#5a6275';
        g.fillRect(x, RULER_H - 7, 1, 6);
      }
    }

    // Keyboard
    g.fillStyle = '#15171c';
    g.fillRect(0, RULER_H, KEYS_W, geo.gridBottom - RULER_H);
    g.save();
    g.beginPath();
    g.rect(0, RULER_H, KEYS_W, geo.gridBottom - RULER_H);
    g.clip();
    g.font = `${Math.min(10, rowH - 3)}px ${getComputedStyle(document.body).fontFamily}`;
    rows.forEach((row, i) => {
      const y = geo.y(i);
      if (y + rowH < RULER_H || y > geo.gridBottom) return;
      const pitched = kind === 'pulse' || kind === 'triangle';
      g.fillStyle = pitched ? (row.black ? '#202228' : '#e9ecef') : row.black ? '#2b2f38' : '#353a46';
      g.fillRect(0, y, pitched && row.black ? KEYS_W * 0.62 : KEYS_W - 1, rowH - 1);
      if (!pitched || row.c || rowH >= 14) {
        g.fillStyle = pitched && !row.black ? '#333' : '#c8cdd8';
        if (!pitched || !row.black) g.fillText(row.label, 4, y + rowH / 2 + 0.5, KEYS_W - 8);
      }
    });
    g.restore();
    g.fillStyle = '#22252d';
    g.fillRect(0, 0, KEYS_W, RULER_H);

    // Playhead
    if (st.playing && st.playMode === 'pattern') {
      const tick = playheadTick(usePlayhead.getState().frame);
      const x = geo.x(tick);
      if (x >= KEYS_W) {
        g.fillStyle = '#9dfc9d';
        g.fillRect(x, 0, 2, size.h);
      }
    }
  }, [pattern, size, geometry, rows, rowH, ch, kind, laneH]);

  useEffect(() => {
    clampScroll();
    draw();
  });

  useEffect(() => usePlayhead.subscribe(() => useStore.getState().playing && draw()), [draw]);

  // ---------- Editing helpers ----------
  const snapTick = (t: number, mode: 'floor' | 'round' = 'floor') => {
    const sn = useStore.getState().snap;
    return mode === 'floor' ? Math.floor(t / sn) * sn : Math.round(t / sn) * sn;
  };

  const hitTest = (x: number, y: number): { note: Note; edge: boolean } | null => {
    if (!pattern) return null;
    const geo = geometry();
    const ri = geo.rowAt(y);
    const row = rows[ri];
    if (!row) return null;
    const notes = pattern.notes[ch];
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      if (n.pitch !== row.pitch) continue;
      const nx = geo.x(n.tick);
      const nw = Math.max(3, n.length * view.current.pxPerTick);
      if (x >= nx && x <= nx + nw) return { note: n, edge: x >= nx + nw - EDGE_PX && nw > EDGE_PX * 2 };
    }
    return null;
  };

  const editPattern = (fn: (p: Pattern) => void) =>
    useStore.getState().mutate((song) => {
      const p = song.patterns.find((x) => x.id === pattern!.id);
      if (p) fn(p as Pattern);
    });

  const audition = (n: Pick<Note, 'pitch' | 'instrument' | 'volume' | 'fx'>) => previewNote(ch, n.pitch, n.instrument, n.volume || 15, n.fx);

  const localPos = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const setVelocityAt = (x: number, y: number) => {
    const geo = geometry();
    const vol = Math.max(0, Math.min(15, Math.round(((geo.gridBottom + laneH - 2 - y) / (laneH - 14)) * 15)));
    const sel = new Set(useStore.getState().selectedNoteIds);
    editPattern((p) => {
      const list = p.notes[ch];
      const near = list.filter((n) => Math.abs(geo.x(n.tick) - x) < 5);
      const targets = near.some((n) => sel.has(n.id)) ? near.filter((n) => sel.has(n.id)) : near;
      for (const n of targets) n.volume = vol;
    });
  };

  // ---------- Pointer handling ----------
  const onPointerDown = (e: React.PointerEvent) => {
    if (!pattern) return;
    const { x, y } = localPos(e);
    const st = useStore.getState();
    const geo = geometry();
    (e.target as Element).setPointerCapture(e.pointerId);

    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      drag.current = { kind: 'pan', startX: x, startY: y, sx: view.current.scrollX, sy: view.current.scrollY };
      return;
    }
    if (y < RULER_H) return;
    if (y >= geo.gridBottom) {
      if (x < KEYS_W) return;
      st.checkpoint();
      drag.current = { kind: 'velocity' };
      setVelocityAt(x, y);
      return;
    }
    if (x < KEYS_W) {
      const row = rows[geo.rowAt(y)];
      if (row) audition({ pitch: row.pitch, instrument: st.song.channels[ch].instrument, volume: 15, fx: {} });
      return;
    }

    const hit = hitTest(x, y);
    if (e.button === 2) {
      st.checkpoint();
      drag.current = { kind: 'erase' };
      if (hit) {
        editPattern((p) => void (p.notes[ch] = p.notes[ch].filter((n) => n.id !== hit.note.id)));
        st.set({ selectedNoteIds: st.selectedNoteIds.filter((id) => id !== hit.note.id) });
      }
      return;
    }

    if (hit) {
      let sel = st.selectedNoteIds;
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        sel = sel.includes(hit.note.id) ? sel.filter((id) => id !== hit.note.id) : [...sel, hit.note.id];
        st.set({ selectedNoteIds: sel });
        return;
      }
      if (!sel.includes(hit.note.id)) {
        sel = [hit.note.id];
        st.set({ selectedNoteIds: sel });
      }
      st.checkpoint();
      const notes = pattern.notes[ch].filter((n) => sel.includes(n.id));
      if (hit.edge) {
        drag.current = { kind: 'resize', startX: x, orig: new Map(notes.map((n) => [n.id, n.length])) };
      } else {
        drag.current = { kind: 'move', startX: x, startY: y, hitId: hit.note.id, orig: new Map(notes.map((n) => [n.id, { tick: n.tick, pitch: n.pitch }])), lastPitch: hit.note.pitch };
        audition(hit.note);
      }
      return;
    }

    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      drag.current = { kind: 'box', x0: x, y0: y, x1: x, y1: y, additive: e.shiftKey ? st.selectedNoteIds : [] };
      return;
    }

    // Create a note and start moving it.
    const row = rows[geo.rowAt(y)];
    if (!row || (kind === 'dmc' && !st.song.samples.length)) return;
    const tick = Math.max(0, snapTick(geo.tickAt(x)));
    if (tick >= patternLength(st.song, pattern)) return;
    const instrument = kind === 'dmc' ? '' : st.song.channels[ch].instrument || st.song.instruments[0]?.id;
    const note = makeNote(tick, lastLength.current, row.pitch, instrument);
    st.checkpoint();
    editPattern((p) => void p.notes[ch].push(note));
    st.set({ selectedNoteIds: [note.id] });
    drag.current = { kind: 'move', startX: x, startY: y, hitId: note.id, orig: new Map([[note.id, { tick, pitch: row.pitch }]]), lastPitch: row.pitch };
    audition(note);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const { x, y } = localPos(e);
    const d = drag.current;
    const canvas = canvasRef.current!;
    if (!d) {
      const geo = geometry();
      if (y > RULER_H && y < geo.gridBottom && x > KEYS_W) {
        const hit = hitTest(x, y);
        canvas.style.cursor = hit ? (hit.edge ? 'ew-resize' : 'move') : 'default';
      } else canvas.style.cursor = y >= geo.gridBottom ? 'ns-resize' : 'default';
      return;
    }
    const v = view.current;
    const st = useStore.getState();
    switch (d.kind) {
      case 'pan':
        v.scrollX = d.sx - (x - d.startX);
        v.scrollY = d.sy - (y - d.startY);
        clampScroll();
        draw();
        break;
      case 'velocity':
        setVelocityAt(x, y);
        break;
      case 'erase': {
        const hit = hitTest(x, y);
        if (hit) editPattern((p) => void (p.notes[ch] = p.notes[ch].filter((n) => n.id !== hit.note.id)));
        break;
      }
      case 'box':
        d.x1 = x;
        d.y1 = y;
        draw();
        break;
      case 'resize': {
        const dt = (x - d.startX) / v.pxPerTick;
        const sn = st.snap;
        editPattern((p) => {
          for (const n of p.notes[ch]) {
            const o = d.orig.get(n.id);
            if (o === undefined) continue;
            n.length = Math.max(sn, Math.round((o + dt) / sn) * sn);
            if (n.id === [...d.orig.keys()][0]) lastLength.current = n.length;
          }
        });
        break;
      }
      case 'move': {
        const hitOrig = d.orig.get(d.hitId)!;
        const dt = snapTick(hitOrig.tick + (x - d.startX) / v.pxPerTick, 'round') - hitOrig.tick;
        const hitRow = rows.findIndex((r) => r.pitch === hitOrig.pitch);
        const newRow = Math.max(0, Math.min(rows.length - 1, hitRow + Math.round((y - d.startY) / rowH)));
        const dRow = newRow - hitRow;
        let minTick = Infinity;
        d.orig.forEach((o) => (minTick = Math.min(minTick, o.tick)));
        const dtClamped = Math.max(dt, -minTick);
        editPattern((p) => {
          for (const n of p.notes[ch]) {
            const o = d.orig.get(n.id);
            if (!o) continue;
            n.tick = o.tick + dtClamped;
            const ri = rows.findIndex((r) => r.pitch === o.pitch);
            n.pitch = rows[Math.max(0, Math.min(rows.length - 1, ri + dRow))].pitch;
          }
        });
        const newPitch = rows[newRow].pitch;
        if (newPitch !== d.lastPitch) {
          d.lastPitch = newPitch;
          const n = currentPattern(useStore.getState())?.notes[ch].find((x) => x.id === d.hitId);
          if (n) audition(n);
        }
        break;
      }
    }
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || !pattern) return;
    if (d.kind === 'box') {
      const geo = geometry();
      const t0 = geo.tickAt(Math.min(d.x0, d.x1));
      const t1 = geo.tickAt(Math.max(d.x0, d.x1));
      const r0 = geo.rowAt(Math.min(d.y0, d.y1));
      const r1 = geo.rowAt(Math.max(d.y0, d.y1));
      const pitches = new Set(rows.slice(Math.max(0, r0), r1 + 1).map((r) => r.pitch));
      const ids = pattern.notes[ch].filter((n) => pitches.has(n.pitch) && n.tick < t1 && n.tick + n.length > t0).map((n) => n.id);
      useStore.getState().set({ selectedNoteIds: [...new Set([...d.additive, ...ids])] });
      draw();
    }
    if (d.kind === 'move') {
      // Remove notes that ended up entirely outside the pattern.
      const st = useStore.getState();
      const plen = patternLength(st.song, pattern);
      if (currentPattern(st)!.notes[ch].some((n) => n.tick >= plen)) editPattern((p) => void (p.notes[ch] = p.notes[ch].filter((n) => n.tick < plen)));
    }
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const v = view.current;
    if (e.ctrlKey || e.metaKey) {
      const { x } = localPos(e);
      const geo = geometry();
      const tickAtMouse = geo.tickAt(x);
      const factor = Math.exp(-e.deltaY * 0.01);
      v.pxPerTick = Math.max(0.25, Math.min(12, v.pxPerTick * factor));
      v.scrollX = tickAtMouse * v.pxPerTick - (x - KEYS_W);
    } else if (e.altKey && kind !== 'dmc' && kind !== 'noise') {
      v.rowH = Math.max(8, Math.min(28, v.rowH - Math.sign(e.deltaY)));
      force((n) => n + 1);
    } else if (e.shiftKey) {
      v.scrollX += e.deltaY || e.deltaX;
    } else {
      v.scrollX += e.deltaX;
      v.scrollY += e.deltaY;
    }
    clampScroll();
    draw();
  };

  // Native non-passive listener so Ctrl+wheel zooms the roll instead of the page.
  const wheelRef = useRef(onWheel);
  wheelRef.current = onWheel;
  useEffect(() => {
    const c = canvasRef.current!;
    const handler = (e: WheelEvent) => wheelRef.current(e);
    c.addEventListener('wheel', handler, { passive: false });
    return () => c.removeEventListener('wheel', handler);
  }, []);

  // ---------- Keyboard ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      if (st.view !== 'pianoroll' || isTyping(e)) return;
      const p = currentPattern(st);
      if (!p) return;
      const sel = new Set(st.selectedNoteIds);
      const selected = p.notes[ch].filter((n) => sel.has(n.id));
      const mod = e.ctrlKey || e.metaKey;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!selected.length) return;
        e.preventDefault();
        st.update((song) => {
          const pp = song.patterns.find((x) => x.id === p.id)!;
          pp.notes[ch] = pp.notes[ch].filter((n) => !sel.has(n.id));
        });
        st.set({ selectedNoteIds: [] });
      } else if (e.key === 'Escape') {
        st.set({ selectedNoteIds: [] });
      } else if (mod && (e.key === 'c' || e.key === 'x')) {
        if (!selected.length) return;
        e.preventDefault();
        const min = Math.min(...selected.map((n) => n.tick));
        const max = Math.max(...selected.map((n) => n.tick + n.length));
        clipboard = { notes: selected.map((n) => ({ ...structuredClone(n), tick: n.tick - min })), span: Math.ceil((max - min) / PPQ) * PPQ };
        if (e.key === 'x') {
          st.update((song) => {
            const pp = song.patterns.find((x) => x.id === p.id)!;
            pp.notes[ch] = pp.notes[ch].filter((n) => !sel.has(n.id));
          });
          st.set({ selectedNoteIds: [] });
        }
      } else if (mod && e.key === 'v') {
        if (!clipboard) return;
        e.preventDefault();
        const at = selected.length ? Math.min(...selected.map((n) => n.tick)) + clipboard.span : 0;
        pasteNotes(p, clipboard.notes, at);
      } else if (mod && e.key === 'd') {
        if (!selected.length) return;
        e.preventDefault();
        const min = Math.min(...selected.map((n) => n.tick));
        const max = Math.max(...selected.map((n) => n.tick + n.length));
        const span = Math.ceil((max - min) / PPQ) * PPQ;
        pasteNotes(p, selected.map((n) => ({ ...n, tick: n.tick - min })), min + span);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (!selected.length) return;
        e.preventDefault();
        const dir = e.key === 'ArrowUp' ? 1 : -1;
        const amount = e.shiftKey && (kind === 'pulse' || kind === 'triangle') ? 12 : 1;
        const pitches = rows.map((r) => r.pitch);
        const lo = Math.min(...pitches), hi = Math.max(...pitches);
        st.update((song) => {
          const pp = song.patterns.find((x) => x.id === p.id)!;
          for (const n of pp.notes[ch]) if (sel.has(n.id)) n.pitch = Math.max(lo, Math.min(hi, n.pitch + dir * amount));
        });
        audition({ ...selected[0], pitch: Math.max(lo, Math.min(hi, selected[0].pitch + dir * amount)) });
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (!selected.length) return;
        e.preventDefault();
        const dt = (e.key === 'ArrowRight' ? 1 : -1) * st.snap;
        if (Math.min(...selected.map((n) => n.tick)) + dt < 0) return;
        st.update((song) => {
          const pp = song.patterns.find((x) => x.id === p.id)!;
          for (const n of pp.notes[ch]) if (sel.has(n.id)) n.tick += dt;
        });
      }
    };
    const pasteNotes = (p: Pattern, notes: Note[], at: number) => {
      const st = useStore.getState();
      const plen = patternLength(st.song, p);
      const fresh = notes.map((n) => ({ ...structuredClone(n), id: newId('n'), tick: n.tick + at })).filter((n) => n.tick < plen);
      if (kind === 'dmc') fresh.forEach((n) => (n.instrument = ''));
      st.update((song) => void song.patterns.find((x) => x.id === p.id)!.notes[ch].push(...fresh));
      st.set({ selectedNoteIds: fresh.map((n) => n.id) });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ch, rows, kind]);

  if (!pattern) return null;
  return (
    <div className="editor-body">
      <div className="canvas-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={(e) => e.preventDefault()}
        />
      </div>
      <NotePanel />
    </div>
  );
}

export function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}
