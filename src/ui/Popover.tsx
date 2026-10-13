import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Open/close state for a popover that closes on an outside click, Escape or window resize. */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) => !!t && (anchorRef.current?.contains(t as Node) || panelRef.current?.contains(t as Node));
    const onDown = (e: MouseEvent) => !inside(e.target) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onResize = () => setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);
  return { open, setOpen, anchorRef, panelRef };
}

/**
 * A panel floating under its anchor. Rendered into <body> so containers that scroll or clip
 * (like the channel rack) can't cut it off.
 */
function FloatingPanel(props: { anchor: HTMLElement | null; panelRef: React.RefObject<HTMLDivElement | null>; align: 'left' | 'right'; className: string; children: ReactNode }) {
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  useLayoutEffect(() => {
    if (!props.anchor) return;
    const r = props.anchor.getBoundingClientRect();
    setStyle(
      props.align === 'left'
        ? { position: 'fixed', top: r.bottom + 6, left: Math.max(8, r.left), right: 'auto' }
        : { position: 'fixed', top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right), left: 'auto' },
    );
  }, [props.anchor, props.align]);
  return createPortal(
    <div ref={props.panelRef} className={`popover ${props.className}`} style={style}>
      {props.children}
    </div>,
    document.body,
  );
}

/** A colour swatch button that opens a grid of colours to choose from. */
export function ColorPicker(props: { value: string; colors: string[]; title: string; onChange: (color: string) => void; align?: 'left' | 'right' }) {
  const { open, setOpen, anchorRef, panelRef } = usePopover();
  return (
    <div className="popover-anchor" ref={anchorRef}>
      <button className="swatch-btn" style={{ background: props.value }} title={props.title} aria-label={props.title} onClick={() => setOpen(!open)} />
      {open && (
        <FloatingPanel anchor={anchorRef.current} panelRef={panelRef} align={props.align ?? 'right'} className="swatch-pop">
          {props.colors.map((c) => (
            <button
              key={c}
              className={`swatch-choice ${c === props.value ? 'on' : ''}`}
              style={{ background: c }}
              aria-label={`Colour ${c}`}
              onClick={() => {
                props.onChange(c);
                setOpen(false);
              }}
            />
          ))}
        </FloatingPanel>
      )}
    </div>
  );
}

/** A small "?" button that shows a plain-language explanation. */
export function HelpButton(props: { title: string; children: ReactNode; align?: 'left' | 'right' }) {
  const { open, setOpen, anchorRef, panelRef } = usePopover();
  return (
    <div className="popover-anchor help-anchor" ref={anchorRef}>
      <button className={`help-btn ${open ? 'active' : ''}`} title={`What is this? (${props.title})`} onClick={() => setOpen(!open)}>
        ?
      </button>
      {open && (
        <FloatingPanel anchor={anchorRef.current} panelRef={panelRef} align={props.align ?? 'right'} className="help-pop">
          <div className="help-head">
            <h4>{props.title}</h4>
            <button className="help-close" onClick={() => setOpen(false)} aria-label="Close help">✕</button>
          </div>
          <div className="help-body">{props.children}</div>
        </FloatingPanel>
      )}
    </div>
  );
}
