import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { playheadTick } from '../audio/sync';
import { AUTOMATION_PARAMS, automationActiveAt, automationValueAt, findLane, sortedLanePoints, type ParamInfo } from '../core/automation';
import { songEndTick } from '../core/compiler';
import { clipConflicts } from '../core/hardware';
import { openTranspose } from './TransposeDialog';
import { laneKey, usePlayhead, useStore, type AppState } from '../model/store';
import { CHANNELS, PLAYLIST_TRACKS, TICKS_PER_STEP, newId, patternLength, ticksPerBar, type AutomationPoint, type Clip } from '../model/types';

const HEAD_W = 92;
const RULER_H = 26;
const TRACK_H = 46;
const AUTO_H = 76;
const AUTO_PAD = 12;
const POINT_HIT = 7;

type Drag =
  | { kind: 'move'; clipId: string; startX: number; startY: number; origStart: number; origTrack: number }
  | { kind: 'erase' }
  | { kind: 'pan'; startX: number; sx: number; startY: number; sy: number }
  | { kind: 'point'; lane: string; pointId: string }
  | { kind: 'erase-points'; lane: string };

interface LaneRef {
  key: string;
  channel: number;
  info: ParamInfo;
}

/** Every lane that can exist, grouped by channel. */
const ALL_LANES: LaneRef[] = CHANNELS.flatMap((c) =>
  AUTOMATION_PARAMS.filter((info) => info.channels.includes(c.index)).map((info) => ({ key: laneKey(c.index, info.param), channel: c.index, info })),
);

/** Lanes currently shown, in display order. */
function visibleLanes(st: AppState): LaneRef[] {
  return st.showAutomation ? ALL_LANES.filter((l) => st.automationVisible[l.key]) : [];
}

const LANE_BG: Record<string, string> = { volume: '#16231a', duty: '#211a2b', detune: '#16202b' };
const LANE_GUIDES: Record<string, number[]> = { volume: [0, 5, 10, 15], duty: [0, 1, 2, 3], detune: [-50, -25, 0, 25, 50] };

/** Apply a change to a lane's points, creating the lane if needed. */
function editLane(lane: LaneRef, fn: (points: AutomationPoint[]) => void) {
  const { channel } = lane;
  const param = lane.info.param;
  useStore.getState().mutate((song) => {
    let l = song.automation.find((x) => x.channel === channel && x.param === param);
    if (!l) {
      song.automation.push({ channel, param, points: [] });
      l = song.automation[song.automation.length - 1];
    }
    fn(l.points);
    l.points.sort((a, b) => a.tick - b.tick);
  });
}

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
      laneTop: (i: number) => RULER_H + PLAYLIST_TRACKS * TRACK_H + i * AUTO_H - v.scrollY,
      /** Index into the visible lanes at y, or -1. */
      laneAt: (y: number) => {
        const off = y - RULER_H + v.scrollY - PLAYLIST_TRACKS * TRACK_H;
        return off < 0 ? -1 : Math.floor(off / AUTO_H);
      },
      valueY: (info: ParamInfo, top: number, value: number) =>
        top + AUTO_PAD + (1 - (value - info.min) / (info.max - info.min)) * (AUTO_H - 2 * AUTO_PAD),
      yValue: (info: ParamInfo, top: number, y: number) =>
        Math.max(info.min, Math.min(info.max, Math.round(info.min + (1 - (y - top - AUTO_PAD) / (AUTO_H - 2 * AUTO_PAD)) * (info.max - info.min)))),
    };
  }, []);

  const clampScroll = () => {
    const v = view.current;
    const content = PLAYLIST_TRACKS * TRACK_H + visibleLanes(useStore.getState()).length * AUTO_H;
    v.scrollX = Math.max(0, v.scrollX);
    v.scrollY = Math.max(0, Math.min(Math.max(0, content - (size.h - RULER_H)), v.scrollY));
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

    // Clips that play the same channel at the same time: only one note per channel can sound.
    for (const c of clipConflicts(song)) {
      const x0 = Math.max(HEAD_W, G.x(c.start));
      const x1 = G.x(c.end);
      if (x1 < HEAD_W || x0 > W) continue;
      for (const id of c.clips) {
        const clip = song.playlist.find((cl) => cl.id === id);
        if (!clip) continue;
        const y = G.y(clip.track);
        g.fillStyle = 'rgba(255,60,60,0.35)';
        g.fillRect(x0, y + 2, x1 - x0, TRACK_H - 5);
        g.strokeStyle = '#ff6b6b';
        g.lineWidth = 2;
        g.strokeRect(x0 + 1, y + 3, x1 - x0 - 2, TRACK_H - 7);
        g.lineWidth = 1;
        g.fillStyle = '#ffe3e3';
        g.font = `bold 10px ${font}`;
        g.fillText(`⚠ ${c.channels.map((ch) => CHANNELS[ch].short).join(' ')}`, x0 + 4, y + TRACK_H - 10);
      }
    }

    // Automation lanes
    const lanes = visibleLanes(st);
    lanes.forEach((lane, i) => {
      const { info } = lane;
      const top = G.laneTop(i);
      if (top > H || top + AUTO_H < RULER_H) return;
      const color = CHANNELS[lane.channel].color;
      g.fillStyle = LANE_BG[info.param];
      g.fillRect(HEAD_W, top, W, AUTO_H);
      for (const lv of LANE_GUIDES[info.param]) {
        g.fillStyle = lv === 0 && info.min < 0 ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.04)';
        g.fillRect(HEAD_W, Math.round(G.valueY(info, top, lv)), W, 1);
      }
      g.fillStyle = '#0d150f';
      g.fillRect(HEAD_W, top, W, 1);

      const points = sortedLanePoints(song, lane.channel, info.param);
      g.font = `bold 10px ${font}`;
      if (!points.length) {
        if (!info.spanOnly) {
          g.strokeStyle = color + '80';
          g.setLineDash([4, 4]);
          g.beginPath();
          g.moveTo(HEAD_W, G.valueY(info, top, info.neutral) + 0.5);
          g.lineTo(W, G.valueY(info, top, info.neutral) + 0.5);
          g.stroke();
          g.setLineDash([]);
        }
        g.fillStyle = '#8b93a7';
        const what = info.spanOnly ? 'instrument duty' : info.format(info.neutral);
        g.fillText(`${what} · click to add ${info.label.toLowerCase()} points`, HEAD_W + 8, top + AUTO_H / 2 + 4);
        return;
      }
      const xs = points.map((p) => G.x(p.tick));
      const ys = points.map((p) => G.valueY(info, top, p.value));
      // Volume/detune hold flat beyond the points; a duty sweep only applies inside its span.
      const x0 = info.spanOnly ? xs[0] : HEAD_W;
      const x1 = info.spanOnly && points.length > 1 ? xs[xs.length - 1] : W;
      if (info.spanOnly) {
        g.fillStyle = 'rgba(0,0,0,0.25)';
        if (x0 > HEAD_W) g.fillRect(HEAD_W, top + 1, x0 - HEAD_W, AUTO_H - 1);
        if (x1 < W) g.fillRect(x1, top + 1, W - x1, AUTO_H - 1);
        g.fillStyle = '#6c7386';
        g.font = `10px ${font}`;
        if (x0 - HEAD_W > 70) g.fillText('instrument', Math.max(HEAD_W, x0 - 64), top + AUTO_H - 6);
        if (W - x1 > 70) g.fillText('instrument', x1 + 6, top + AUTO_H - 6);
        g.font = `bold 10px ${font}`;
      }
      const base = info.min < 0 ? G.valueY(info, top, 0) : top + AUTO_H;
      const trace = () => {
        g.moveTo(x0, ys[0]);
        xs.forEach((x, k) => g.lineTo(x, ys[k]));
        g.lineTo(x1, ys[ys.length - 1]);
      };
      g.beginPath();
      trace();
      g.lineTo(x1, base);
      g.lineTo(x0, base);
      g.closePath();
      g.fillStyle = color + '26';
      g.fill();
      g.beginPath();
      trace();
      g.strokeStyle = color;
      g.lineWidth = 2;
      g.stroke();
      g.lineWidth = 1;
      points.forEach((p, k) => {
        const x = xs[k], y = ys[k];
        if (x < HEAD_W - 10 || x > W + 10) return;
        g.beginPath();
        g.arc(x, y, 4, 0, Math.PI * 2);
        g.fillStyle = color;
        g.fill();
        g.strokeStyle = '#111';
        g.stroke();
        // Label above unless the point is near the top (like the reference screenshot).
        g.fillStyle = color;
        const above = y - top > 18;
        g.fillText(info.format(p.value), x + 4, above ? y - 7 : y + 13);
      });
    });

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
    lanes.forEach((lane, i) => {
      const { info } = lane;
      const top = G.laneTop(i);
      g.fillStyle = '#1f2329';
      g.fillRect(2, top + 2, HEAD_W - 4, AUTO_H - 4);
      g.fillStyle = CHANNELS[lane.channel].color;
      g.fillRect(2, top + 2, 3, AUTO_H - 4);
      g.font = `bold 11px ${font}`;
      g.fillText(CHANNELS[lane.channel].name, 10, top + 16);
      g.font = `10px ${font}`;
      g.fillStyle = '#8b93a7';
      g.fillText(info.param === 'volume' && CHANNELS[lane.channel].kind === 'triangle' ? 'Volume (on/off)' : info.label, 10, top + 30);
      if (st.playing && st.playMode === 'song') {
        const pts = sortedLanePoints(song, lane.channel, info.param);
        const tick = playheadTick(usePlayhead.getState().frame);
        const active = info.spanOnly ? automationActiveAt(info, pts, tick) : true;
        g.fillStyle = '#d8dce6';
        g.font = `bold 15px ${font}`;
        g.fillText(active ? info.format(Math.round(automationValueAt(pts, tick, info.neutral))) : 'inst.', 10, top + 54);
      }
    });
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

  const snapAuto = (t: number, free: boolean) => Math.max(0, free ? Math.round(t) : Math.round(t / TICKS_PER_STEP) * TICKS_PER_STEP);

  const pointAt = (lane: LaneRef, laneIndex: number, x: number, y: number): AutomationPoint | null => {
    const G = geo();
    const top = G.laneTop(laneIndex);
    const pts = sortedLanePoints(useStore.getState().song, lane.channel, lane.info.param);
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      if (Math.hypot(G.x(p.tick) - x, G.valueY(lane.info, top, p.value) - y) <= POINT_HIT) return p;
    }
    return null;
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
    const laneIndex = G.laneAt(y);
    const lanes = visibleLanes(st);
    if (laneIndex >= 0 && laneIndex < lanes.length) {
      const lane = lanes[laneIndex];
      const point = pointAt(lane, laneIndex, x, y);
      st.checkpoint();
      if (e.button === 2) {
        drag.current = { kind: 'erase-points', lane: lane.key };
        if (point) editLane(lane, (pts) => void pts.splice(pts.findIndex((p) => p.id === point.id), 1));
        return;
      }
      if (point) {
        drag.current = { kind: 'point', lane: lane.key, pointId: point.id };
        return;
      }
      const top = G.laneTop(laneIndex);
      const p: AutomationPoint = { id: newId('a'), tick: snapAuto(G.tickAt(x), e.ctrlKey || e.metaKey), value: G.yValue(lane.info, top, y) };
      editLane(lane, (pts) => void pts.push(p));
      drag.current = { kind: 'point', lane: lane.key, pointId: p.id };
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
    const st = useStore.getState();
    const G = geo();
    const lanes = visibleLanes(st);
    const laneIndex = G.laneAt(y);
    const inLane = laneIndex >= 0 && laneIndex < lanes.length && x > HEAD_W;
    if (!d) {
      canvas.style.cursor = y < RULER_H && x > HEAD_W
        ? 'pointer'
        : inLane
          ? pointAt(lanes[laneIndex], laneIndex, x, y) ? 'grab' : 'crosshair'
          : clipAt(x, y) ? 'move' : 'default';
      return;
    }
    if (d.kind === 'point') {
      const li = lanes.findIndex((l) => l.key === d.lane);
      if (li < 0) return;
      const tick = snapAuto(G.tickAt(x), e.ctrlKey || e.metaKey);
      const value = G.yValue(lanes[li].info, G.laneTop(li), y);
      editLane(lanes[li], (pts) => {
        const p = pts.find((pp) => pp.id === d.pointId);
        if (p) {
          p.tick = tick;
          p.value = value;
        }
      });
      return;
    }
    if (d.kind === 'erase-points') {
      const li = lanes.findIndex((l) => l.key === d.lane);
      const hit = li >= 0 ? pointAt(lanes[li], li, x, y) : null;
      if (hit) editLane(lanes[li], (pts) => void pts.splice(pts.findIndex((p) => p.id === hit.id), 1));
      return;
    }
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
    const st = useStore.getState();
    const lanes = visibleLanes(st);
    const li = geo().laneAt(y);
    if (li >= 0 && li < lanes.length) {
      const ref = lanes[li];
      const p = pointAt(ref, li, x, y);
      if (p) st.update((song) => {
        const lane = song.automation.find((l) => l.channel === ref.channel && l.param === ref.info.param);
        if (lane) lane.points = lane.points.filter((pp) => pp.id !== p.id);
      });
      return;
    }
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
        <button style={{ marginBottom: 8 }} onClick={openTranspose} title="Move the whole song up or down in pitch">
          Transpose song…
        </button>
        <div className="small" style={{ marginBottom: 8 }}>
          Length: {Math.round(songEndTick(s.song) / ticksPerBar(s.song))} bars. NSF exports loop forever from the loop point, like game music.
        </div>
        <h4>Automation</h4>
        <label className="check">
          <input type="checkbox" checked={s.showAutomation} onChange={(e) => s.set({ showAutomation: e.target.checked })} />
          Show automation lanes
        </label>
        {s.showAutomation &&
          CHANNELS.filter((c) => AUTOMATION_PARAMS.some((info) => info.channels.includes(c.index))).map((c) => (
            <div key={c.index} className="lane-row">
              <span className="lane-row-name" style={{ borderLeftColor: c.color }}>{c.short}</span>
              {ALL_LANES.filter((l) => l.channel === c.index).map((l) => {
                const has = !!findLane(s.song, l.channel, l.info.param)?.points.length;
                return (
                  <button
                    key={l.key}
                    className={s.automationVisible[l.key] ? 'active' : ''}
                    title={`Show/hide ${c.name} ${l.info.label.toLowerCase()}${has ? ' (has points)' : ''}. ${l.info.help}`}
                    onClick={() => s.set({ automationVisible: { ...s.automationVisible, [l.key]: !s.automationVisible[l.key] } })}
                  >
                    {l.info.short}
                    {has ? ' •' : ''}
                  </button>
                );
              })}
            </div>
          ))}
        {s.showAutomation && s.song.automation.some((l) => l.points.length) && (
          <div className="lane-toggles">
            {ALL_LANES.filter((l) => findLane(s.song, l.channel, l.info.param)?.points.length).map((l) => (
              <button
                key={l.key}
                style={{ borderLeftColor: CHANNELS[l.channel].color }}
                title={`Remove all ${CHANNELS[l.channel].name} ${l.info.label.toLowerCase()} points`}
                onClick={() =>
                  s.update((song) => void (song.automation = song.automation.filter((x) => !(x.channel === l.channel && x.param === l.info.param))))
                }
              >
                Clear {CHANNELS[l.channel].short} {l.info.short}
              </button>
            ))}
          </div>
        )}
        <div className="small" style={{ marginBottom: 8 }}>
          <b>Vol</b> scales volume (0–15; triangle is on/off only). <b>Duty</b> sweeps the pulse width (12.5–75%) between its first and last point. <b>Det</b>{' '}
          detunes in cents — try Pulse 2 at +8c against Pulse 1. Automation plays in SONG mode and in WAV/NSF exports.
        </div>
        <h4>Mouse</h4>
        <ul className="help-list">
          <li>Automation: click to add a point, drag to move (Ctrl = no snap), right-click or double-click to delete</li>
          <li>Click empty: place selected pattern</li>
          <li>Red ⚠ = two clips play the same channel at once (only one can sound)</li>
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
