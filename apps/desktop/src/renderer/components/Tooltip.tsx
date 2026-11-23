import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

/**
 * One tooltip for the whole window. Anything with `data-tip` gets it on hover or keyboard focus;
 * `data-tip-delay="long"` waits longer, for tips on content rather than controls. A trailing
 * shortcut such as "(Ctrl+Shift+B)" is drawn as keys. Tips inside a message open beside it
 * (`data-tip-side` picks a side elsewhere), so they don't cover the messages below;
 * `data-tip-anchor="bubble"` centres one on its bubble rather than on the element.
 * `data-tip-delay="short"` opens almost at once, for tips that are the point of hovering.
 *
 * An element can draw a richer tip with `ref={richTip(() => …)}`; it still needs `data-tip`, which
 * is what screen readers get and what turns the tip on.
 */

const RICH = new WeakMap<HTMLElement, () => ComponentChildren>();

/** A ref that gives the element a rich tooltip drawn by `render`. */
export function richTip(render: () => ComponentChildren): (element: HTMLElement | null) => void {
  return (element) => {
    if (element) RICH.set(element, render);
  };
}

const DELAY = 450;
const LONG_DELAY = 900;
const SHORT_DELAY = 120;
/** Moving between tipped controls within this long shows the next tip at once. */
const WARM = 400;
const GAP = 6;
const MARGIN = 8;

interface Tip {
  target: HTMLElement;
  text: string;
}

type Side = "left" | "right";

interface Placement {
  left: number;
  top: number;
  below: boolean;
  side?: Side;
}

/** The side a tip prefers: its own `data-tip-side`, else away from the message's edge. */
function preferredSide(target: HTMLElement): Side | undefined {
  const own = target.dataset.tipSide;
  if (own === "left" || own === "right") return own;
  const row = target.closest(".bubble-row");
  if (!row) return undefined;
  return row.classList.contains("out") ? "left" : "right";
}

/**
 * Beside the bubble (or card) the target is in, centred on the target, or on the bubble with
 * `data-tip-anchor="bubble"` (where the time shows); null when it won't fit.
 */
function besides(target: HTMLElement, side: Side, width: number, height: number): Placement | null {
  const beside = (target.closest(".bubble") ?? target).getBoundingClientRect();
  const anchor = target.dataset.tipAnchor === "bubble" ? beside : target.getBoundingClientRect();
  const top = Math.min(
    Math.max(MARGIN, anchor.top + anchor.height / 2 - height / 2),
    window.innerHeight - height - MARGIN,
  );
  const right = beside.right + GAP;
  const left = beside.left - GAP - width;
  const fitsRight = right + width + MARGIN <= window.innerWidth;
  const fitsLeft = left >= MARGIN;
  if (side === "right" ? fitsRight : !fitsLeft) {
    return fitsRight ? { left: right, top, below: true, side: "right" } : null;
  }
  return fitsLeft ? { left, top, below: true, side: "left" } : null;
}

const SHORTCUT = /^(.*\S)\s+\(((?:Ctrl|Shift|Alt|Cmd|Esc|Enter|Tab)(?:\+[^)]+)?)\)$/;

export function splitShortcut(text: string): { label: string; keys: string[] } {
  const match = SHORTCUT.exec(text);
  if (!match) return { label: text, keys: [] };
  return { label: match[1]!, keys: match[2]!.split("+") };
}

function tipTarget(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const target = node.closest<HTMLElement>("[data-tip]");
  return target?.dataset.tip ? target : null;
}

export function Tooltip() {
  const [tip, setTip] = useState<Tip | null>(null);
  const [place, setPlace] = useState<Placement | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: HTMLElement | null = null;
    let hiddenAt = 0;

    const hide = () => {
      clearTimeout(timer);
      if (current) hiddenAt = Date.now();
      current = null;
      setTip(null);
    };

    const show = (target: HTMLElement) => {
      if (target === current) return;
      clearTimeout(timer);
      const warm = current !== null || Date.now() - hiddenAt < WARM;
      current = target;
      const kind = target.dataset.tipDelay;
      const delay = warm
        ? 0
        : kind === "long"
          ? LONG_DELAY
          : kind === "short"
            ? SHORT_DELAY
            : DELAY;
      setTip(null);
      timer = setTimeout(() => {
        if (current === target && target.isConnected && target.dataset.tip)
          setTip({ target, text: target.dataset.tip });
      }, delay);
    };

    const over = (e: PointerEvent) => {
      const target = tipTarget(e.target);
      if (target) show(target);
      else if (current) hide();
    };
    const out = (e: PointerEvent) => {
      if (current && !tipTarget(e.relatedTarget)) hide();
    };
    const focus = (e: FocusEvent) => {
      const target = tipTarget(e.target);
      if (target && target.matches(":focus-visible")) show(target);
    };

    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", hide);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", hide, true);
    document.addEventListener("wheel", hide, { capture: true, passive: true });
    document.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", hide, true);
      document.removeEventListener("wheel", hide, true);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  useLayoutEffect(() => {
    setPlace(null);
    if (!tip || !box.current) return;
    const { width, height } = box.current.getBoundingClientRect();
    const side = preferredSide(tip.target);
    const sideways = side && besides(tip.target, side, width, height);
    if (sideways) {
      setPlace(sideways);
      return;
    }
    const anchor = tip.target.getBoundingClientRect();
    const below = anchor.bottom + GAP + height + MARGIN <= window.innerHeight;
    const top = below ? anchor.bottom + GAP : Math.max(MARGIN, anchor.top - GAP - height);
    const left = Math.min(
      Math.max(MARGIN, anchor.left + anchor.width / 2 - width / 2),
      window.innerWidth - width - MARGIN,
    );
    setPlace({ left, top, below });
  }, [tip]);

  if (!tip) return null;
  const rich = RICH.get(tip.target);
  const classes = `tooltip ${place ? "shown" : ""} ${place?.below === false ? "above" : ""} ${place?.side ? `side-${place.side}` : ""}`;
  const style = place ? { left: `${place.left}px`, top: `${place.top}px` } : { left: 0, top: 0 };
  if (rich) {
    return (
      <div ref={box} class={`${classes} rich`} role="tooltip" style={style}>
        {rich()}
      </div>
    );
  }
  const { label, keys } = splitShortcut(tip.text);
  return (
    <div ref={box} class={classes} role="tooltip" style={style}>
      <span class="tooltip-label">{label}</span>
      {keys.length > 0 && (
        <span class="tooltip-keys">
          {keys.map((key) => (
            <kbd key={key}>{key}</kbd>
          ))}
        </span>
      )}
    </div>
  );
}
