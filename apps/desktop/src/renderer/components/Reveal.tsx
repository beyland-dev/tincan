import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { initialPhase, REVEAL_MS, revealInstant, revealNext, type RevealEvent } from "../reveal.ts";

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * Content that slides open (height and opacity, or width with `axis="x"`) when `open` turns on,
 * and slides closed before it unmounts, so what's below moves smoothly instead of jumping. The
 * first render, and changes just after it, don't animate. Collapsed content is `inert`.
 */
export function Reveal(props: { open: boolean; axis?: "x" | "y"; children?: ComponentChildren }) {
  const { open } = props;
  const [phase, setPhase] = useState(() => initialPhase(open));
  const ref = useRef<HTMLDivElement>(null);
  const mountedAt = useRef(Date.now());
  const wasOpen = useRef(open);
  // What it showed last while open, kept on screen as it slides closed.
  const kept = useRef(props.children);
  if (open) kept.current = props.children;

  const step = (event: RevealEvent, instant = false) =>
    setPhase((current) => revealNext(current, event, instant));

  useLayoutEffect(() => {
    if (wasOpen.current === open) return;
    wasOpen.current = open;
    step(open ? "open" : "close", revealInstant(reducedMotion(), mountedAt.current, Date.now()));
  }, [open]);

  useLayoutEffect(() => {
    if (phase !== "entering") return;
    // Style the collapsed start before opening, so the transition has somewhere to start from.
    ref.current?.getBoundingClientRect();
    step("frame");
  }, [phase]);

  useEffect(() => {
    if (phase !== "opening" && phase !== "leaving") return;
    // In case transitionend never comes (the element was hidden, say).
    const timer = setTimeout(() => step("done"), REVEAL_MS + 100);
    return () => clearTimeout(timer);
  }, [phase]);

  if (phase === "hidden") return null;
  return (
    <div
      ref={ref}
      class={`reveal ${props.axis ?? "y"}`}
      data-phase={phase}
      inert={!open}
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget && e.propertyName.startsWith("grid-template")) {
          step("done");
        }
      }}
    >
      <div class="reveal-inner">{open ? props.children : kept.current}</div>
    </div>
  );
}
