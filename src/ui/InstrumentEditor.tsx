import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { previewNote } from '../audio/sync';
import { noteName } from '../core/tables';
import { env, INSTRUMENT_COLORS } from '../model/defaults';
import { useStore } from '../model/store';
import { CHANNELS, type Envelope, type EnvelopeKind, type Instrument } from '../model/types';

const RANGES: Record<EnvelopeKind, [number, number]> = {
  volume: [0, 15],
  arpeggio: [-24, 24],
  pitch: [-64, 64],
  duty: [0, 3],
};

const INFO: Record<EnvelopeKind, { title: string; help: string; color: string }> = {
  volume: { title: 'Volume', help: '0–15 per frame. Without a release point the note is cut when it ends.', color: '#51cf66' },
  arpeggio: { title: 'Arpeggio', help: 'Semitone offset per frame. Loop 0 4 7 for a classic chiptune chord. On noise: shifts the noise pitch.', color: '#fab005' },
  pitch: { title: 'Pitch', help: 'Fine pitch offset in 1/16 semitones per frame: vibrato, drops, scoops.', color: '#74c0fc' },
  duty: { title: 'Duty / Noise mode', help: 'Pulse: 0 = 12.5%, 1 = 25%, 2 = 50%, 3 = 75%. Noise: even = hiss, odd = metallic. Ignored by triangle.', color: '#f783ac' },
};

const PRESETS: Record<EnvelopeKind, { name: string; env: Envelope }[]> = {
  volume: [
    { name: 'Flat', env: env([15]) },
    { name: 'Sustain + release', env: env([15, 14, 13, 12, 11, 10, 8, 6, 4, 2, 0], -1, 6) },
    { name: 'Pluck', env: env([15, 12, 10, 8, 7, 6, 5, 4, 3, 2, 2, 1, 1, 0]) },
    { name: 'Staccato', env: env([15, 13, 10, 6, 3, 0]) },
    { name: 'Swell', env: env([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 10, 6, 3, 0], -1, 14) },
    { name: 'Tremolo', env: env([14, 14, 12, 10, 8, 8, 10, 12, 4, 2, 0], 0, 8) },
    { name: 'Echo', env: env([15, 13, 11, 9, 7, 5, 0, 0, 0, 7, 6, 5, 4, 3, 0, 0, 0, 4, 3, 2, 1, 0]) },
  ],
  arpeggio: [
    { name: 'None', env: env([0]) },
    { name: 'Major chord', env: env([0, 4, 7], 0) },
    { name: 'Minor chord', env: env([0, 3, 7], 0) },
    { name: 'Octave', env: env([0, 12], 0) },
    { name: 'Power (5th)', env: env([0, 7, 12], 0) },
    { name: 'Kick drop', env: env([24, 12, 5, 0, -5, -12]) },
    { name: 'Zap', env: env([36, 30, 24, 18, 12, 6, 0]) },
  ],
  pitch: [
    { name: 'None', env: env([0]) },
    { name: 'Delayed vibrato', env: env([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 4, 5, 4, 2, 0, -2, -4, -5, -4, -2], 15) },
    { name: 'Fast vibrato', env: env([0, 4, 6, 4, 0, -4, -6, -4], 0) },
    { name: 'Scoop up', env: env([-32, -24, -16, -10, -6, -3, -1, 0]) },
    { name: 'Drop', env: env([0, -2, -4, -8, -12, -16, -24, -32, -40, -48, -56, -64]) },
  ],
  duty: [
    { name: '12.5%', env: env([0]) },
    { name: '25%', env: env([1]) },
    { name: '50%', env: env([2]) },
    { name: '75%', env: env([3]) },
    { name: 'Pluck 50→25', env: env([2, 2, 1]) },
    { name: 'PWM sweep', env: env([0, 0, 1, 1, 2, 2, 1, 1], 0) },
  ],
};

function EnvelopeEditor({ inst, kind }: { inst: Instrument; kind: EnvelopeKind }) {
  const envelope = inst[kind];
  const [min, max] = RANGES[kind];
  const ref = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(400);
  const painting = useRef<{ last: number } | null>(null);
  const info = INFO[kind];
  const store = useStore;
  const GRAPH_H = 132;
  const STRIP_H = 14;
  const H = GRAPH_H + STRIP_H * 2;
  const n = envelope.values.length;
  const barW = Math.max(6, Math.min(26, Math.floor((width - 4) / Math.max(n, 16))));

  useLayoutEffect(() => {
    const c = ref.current!;
    const ro = new ResizeObserver(() => setWidth(c.clientWidth));
    ro.observe(c);
    setWidth(c.clientWidth);
    return () => ro.disconnect();
  }, []);

  const setEnv = (fn: (e: Envelope) => void, record: boolean) => {
    const apply = (song: Parameters<Parameters<ReturnType<typeof store.getState>['mutate']>[0]>[0]) => {
      const i = song.instruments.find((x) => x.id === inst.id);
      if (i) fn(i[kind] as Envelope);
    };
    if (record) store.getState().update(apply);
    else store.getState().mutate(apply);
  };

  useEffect(() => {
    const c = ref.current!;
    const dpr = devicePixelRatio;
    c.width = width * dpr;
    c.height = H * dpr;
    c.style.height = `${H}px`;
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#15171c';
    g.fillRect(0, 0, width, H);
    const yOf = (v: number) => GRAPH_H - 4 - ((v - min) / (max - min)) * (GRAPH_H - 8);
    const zeroY = yOf(Math.max(min, Math.min(max, 0)));
    // guide lines
    g.fillStyle = '#262a33';
    const steps = max - min <= 15 ? 1 : max - min <= 48 ? 12 : 16;
    for (let v = min; v <= max; v += steps) g.fillRect(0, Math.round(yOf(v)), width, 1);
    if (min < 0) {
      g.fillStyle = '#4a5060';
      g.fillRect(0, Math.round(zeroY), width, 1);
    }
    const font = getComputedStyle(document.body).fontFamily;
    g.font = `9px ${font}`;
    g.textAlign = 'center';
    for (let i = 0; i < n; i++) {
      const v = envelope.values[i];
      const x = 2 + i * barW;
      const inLoop = envelope.loop >= 0 && i >= envelope.loop && (envelope.release < 0 || i < envelope.release || envelope.loop >= envelope.release);
      const inRelease = envelope.release >= 0 && i >= envelope.release;
      g.fillStyle = inRelease ? '#868e96' : info.color;
      g.globalAlpha = inLoop ? 1 : 0.8;
      const y = yOf(v);
      if (min < 0) g.fillRect(x, Math.min(y, zeroY), barW - 1, Math.max(2, Math.abs(zeroY - y)));
      else g.fillRect(x, y, barW - 1, GRAPH_H - 4 - y + 2);
      g.globalAlpha = 1;
      if (barW >= 14) {
        g.fillStyle = '#d8dce6';
        g.fillText(String(v), x + barW / 2, Math.max(9, Math.min(GRAPH_H - 6, (min < 0 && v < 0 ? y + 10 : y - 4))));
      }
    }
    // strips
    const strip = (row: number, label: string, idx: number, color: string) => {
      const y = GRAPH_H + row * STRIP_H;
      g.fillStyle = '#1e2128';
      g.fillRect(0, y, width, STRIP_H - 1);
      for (let i = 0; i < n; i++) {
        g.fillStyle = i === idx ? color : i % 2 ? '#262a33' : '#2b2f38';
        g.fillRect(2 + i * barW, y + 1, barW - 1, STRIP_H - 3);
      }
      g.fillStyle = '#8b93a7';
      g.textAlign = 'right';
      g.fillText(label, width - 4, y + 10);
      g.textAlign = 'center';
    };
    strip(0, 'loop', envelope.loop, '#51cf66');
    strip(1, 'release', envelope.release, '#f7a440');
  }, [envelope, width, barW, n, min, max, info.color, H]);

  const valueAt = (y: number) => Math.round(min + ((GRAPH_H - 4 - y) / (GRAPH_H - 8)) * (max - min));
  const pos = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const paint = (x: number, y: number) => {
    const i = Math.floor((x - 2) / barW);
    if (i < 0 || i >= n) return;
    const v = Math.max(min, Math.min(max, valueAt(y)));
    const last = painting.current?.last ?? i;
    setEnv((e) => {
      const [a, b] = last < i ? [last, i] : [i, last];
      for (let k = a; k <= b; k++) e.values[k] = v;
    }, false);
    painting.current = { last: i };
  };

  const onDown = (e: React.PointerEvent) => {
    const { x, y } = pos(e);
    const i = Math.floor((x - 2) / barW);
    if (y >= GRAPH_H) {
      if (i < 0 || i >= n) return;
      const isLoop = y < GRAPH_H + STRIP_H;
      setEnv((env) => {
        if (isLoop) env.loop = env.loop === i || e.button === 2 ? -1 : i;
        else env.release = env.release === i || e.button === 2 || i === 0 ? -1 : i;
      }, true);
      return;
    }
    (e.target as Element).setPointerCapture(e.pointerId);
    store.getState().checkpoint();
    painting.current = null;
    paint(x, y);
  };

  const setLength = (len: number) => {
    len = Math.max(1, Math.min(128, len));
    setEnv((e) => {
      const lastV = e.values[e.values.length - 1] ?? 0;
      while (e.values.length < len) e.values.push(lastV);
      e.values.length = len;
      if (e.loop >= len) e.loop = -1;
      if (e.release >= len) e.release = -1;
    }, true);
  };

  return (
    <div className="env-card">
      <div className="env-top">
        <strong style={{ color: info.color }}>{info.title}</strong>
        <label>Length</label>
        <input type="number" min={1} max={128} value={n} onChange={(e) => setLength(Number(e.target.value) || 1)} />
        <select
          value=""
          onChange={(e) => {
            const p = PRESETS[kind].find((x) => x.name === e.target.value);
            if (p) setEnv((env) => Object.assign(env, structuredClone(p.env)), true);
          }}
        >
          <option value="">Presets…</option>
          {PRESETS[kind].map((p) => (
            <option key={p.name} value={p.name}>{p.name}</option>
          ))}
        </select>
      </div>
      <canvas
        ref={ref}
        onPointerDown={onDown}
        onPointerMove={(e) => {
          if (!painting.current) return;
          const { x, y } = pos(e);
          paint(x, y);
        }}
        onPointerUp={() => (painting.current = null)}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div className="small" style={{ marginTop: 4 }}>{info.help}</div>
    </div>
  );
}

export function InstrumentEditor() {
  const s = useStore();
  const inst = s.song.instruments.find((i) => i.id === s.selectedInstrumentId);
  if (!inst) return <div className="inst-editor">Select an instrument in the browser.</div>;
  const ch = s.selectedChannel === 4 ? 0 : s.selectedChannel;
  const kind = CHANNELS[ch].kind;
  const pitches = kind === 'noise' ? [3, 6, 9, 12, 15] : kind === 'triangle' ? [36, 43, 48, 55, 60] : [48, 60, 67, 72, 84];

  const rename = (name: string) => s.mutate((song) => void (song.instruments.find((i) => i.id === inst.id)!.name = name));

  return (
    <div className="inst-editor">
      <div className="inst-header">
        <input type="text" value={inst.name} onFocus={() => s.checkpoint()} onChange={(e) => rename(e.target.value)} />
        <select
          value={inst.color}
          style={{ background: inst.color, color: '#111', width: 40 }}
          onChange={(e) => s.update((song) => void (song.instruments.find((i) => i.id === inst.id)!.color = e.target.value))}
        >
          {INSTRUMENT_COLORS.map((c) => (
            <option key={c} value={c} style={{ background: c }}>■</option>
          ))}
        </select>
        <div className="preview-keys">
          <label>Audition on</label>
          <select value={ch} onChange={(e) => s.set({ selectedChannel: Number(e.target.value) })}>
            {CHANNELS.filter((c) => c.kind !== 'dmc').map((c) => (
              <option key={c.index} value={c.index}>{c.name}</option>
            ))}
          </select>
          {pitches.map((p) => (
            <button key={p} onClick={() => previewNote(ch, p, inst.id)}>
              {kind === 'noise' ? `N${p.toString(16).toUpperCase()}` : noteName(p)}
            </button>
          ))}
        </div>
        <button
          title="Make this the sound of the whole channel"
          onClick={() => s.update((song) => void (song.channels[ch].instrument = inst.id))}
          disabled={s.song.channels[ch].instrument === inst.id}
        >
          {s.song.channels[ch].instrument === inst.id ? `${CHANNELS[ch].name} uses this` : `Use on ${CHANNELS[ch].name}`}
        </button>
      </div>
      {kind === 'triangle' && (
        <div className="small" style={{ marginBottom: 8, color: 'var(--accent)' }}>
          Heads up: the NES triangle has no volume or tone control. On the Triangle channel only the arpeggio and pitch envelopes are heard, and
          the volume envelope just switches the note off when it reaches 0. Audition on Pulse 1 to hear the full instrument.
        </div>
      )}
      <div className="small" style={{ marginBottom: 10 }}>
        Envelopes run once per frame (60 per second on NTSC, 50 on PAL). Draw values with the mouse. Click the <b>loop</b> strip to loop from a frame, and the <b>release</b> strip to set where the envelope jumps when the note ends. Tip: you can play notes with your computer keyboard (Z–M, Q–U rows).
      </div>
      <div className="env-grid">
        {(['volume', 'arpeggio', 'pitch', 'duty'] as EnvelopeKind[]).map((k) => (
          <EnvelopeEditor key={k} inst={inst} kind={k} />
        ))}
      </div>
    </div>
  );
}
