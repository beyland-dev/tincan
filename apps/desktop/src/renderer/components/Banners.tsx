import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { dismissToast, toastPlacement, toasts, type Toast } from "../store.ts";
import { Icon, type IconName } from "./Icon.tsx";

const TONE_ICON: Record<Toast["tone"], IconName> = {
  info: "info",
  success: "checkCircle",
  error: "alert",
};

/** How far each notification behind the newest peeks out, collapsed. */
const PEEK = 10;
const GAP = 8;
/** Collapsed, only this many show; the rest wait behind them. */
const VISIBLE = 3;

/**
 * In-app notifications, stacked like a deck at the chosen corner. Hovering (or focusing) the stack
 * fans it out and pauses every timer.
 */
export function Toasts() {
  const [expanded, setExpanded] = useState(false);
  const [heights, setHeights] = useState<Record<number, number>>({});
  const list = toasts.value;
  const placement = toastPlacement.value;
  const top = placement.startsWith("top");

  useEffect(() => {
    if (list.length === 0) setExpanded(false);
  }, [list.length]);

  if (list.length === 0) return null;

  const newestFirst = [...list].reverse();
  const live = newestFirst.filter((t) => !t.leaving);
  const front = live[0];
  const frontHeight = (front && heights[front.id]) || 64;
  const offsets = new Map<number, number>();
  let position = 0;
  let total = 0;
  for (const [index, toast] of live.entries()) {
    offsets.set(toast.id, expanded ? position : index * PEEK);
    position += (heights[toast.id] ?? 64) + GAP;
    total = position - GAP;
  }
  const height = expanded ? total : frontHeight + (Math.min(live.length, VISIBLE) - 1) * PEEK;

  const onHeight = (id: number, h: number) =>
    setHeights((all) => (all[id] === h ? all : { ...all, [id]: h }));

  return (
    <section
      class={`toasts ${placement}`}
      aria-label="Notifications"
      style={{ height: `${Math.max(height, 0)}px` }}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      onFocusIn={() => setExpanded(true)}
      onFocusOut={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setExpanded(false);
      }}
    >
      {newestFirst.map((toast) => {
        const index = live.indexOf(toast);
        return (
          <ToastCard
            key={toast.id}
            toast={toast}
            index={index}
            offset={offsets.get(toast.id) ?? 0}
            top={top}
            expanded={expanded}
            frontHeight={frontHeight}
            onHeight={onHeight}
          />
        );
      })}
    </section>
  );
}

function ToastCard({
  toast,
  index,
  offset,
  top,
  expanded,
  frontHeight,
  onHeight,
}: {
  toast: Toast;
  index: number;
  offset: number;
  top: boolean;
  expanded: boolean;
  frontHeight: number;
  onHeight: (id: number, height: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [entered, setEntered] = useState(false);
  const remaining = useRef(toast.duration);
  const round = useRef(toast.round);
  const timed = Number.isFinite(toast.duration);

  useLayoutEffect(() => {
    if (ref.current) onHeight(toast.id, ref.current.scrollHeight);
  }, [toast.title, toast.body, toast.action]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (round.current !== toast.round) {
      round.current = toast.round;
      remaining.current = toast.duration;
    }
    if (expanded || !timed || toast.leaving) return;
    const started = Date.now();
    const timer = setTimeout(() => dismissToast(toast.id), Math.max(remaining.current, 0));
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - started;
    };
  }, [expanded, toast.leaving, toast.round]);

  const sign = top ? 1 : -1;
  const behind = !expanded && index > 0;
  const hidden = toast.leaving || index >= VISIBLE || index < 0;
  const scale = expanded || index <= 0 ? 1 : 1 - Math.min(index, VISIBLE) * 0.05;
  const y = !entered ? -sign * 24 : toast.leaving ? sign * offset - sign * 12 : sign * offset;
  const style = {
    transform: `translateY(${y}px) scale(${toast.leaving ? 0.96 : scale})`,
    opacity: !entered || (hidden && !expanded) || toast.leaving ? 0 : 1,
    zIndex: 100 - Math.max(index, 0),
    maxHeight: behind ? `${frontHeight}px` : undefined,
    pointerEvents: toast.leaving ? ("none" as const) : undefined,
    "--toast-duration": `${toast.duration}ms`,
  };

  return (
    <div
      ref={ref}
      class={`toast ${toast.tone} ${behind ? "behind" : ""}`}
      style={style}
      role={toast.tone === "error" ? "alert" : "status"}
      aria-hidden={behind ? "true" : undefined}
      inert={behind}
    >
      <span class="toast-icon">
        <Icon name={TONE_ICON[toast.tone]} size={18} />
      </span>
      <div class="toast-text">
        <strong class="toast-title">{toast.title}</strong>
        {toast.body && <span class="toast-body">{toast.body}</span>}
      </div>
      {toast.action && (
        <button
          class="button small toast-action"
          onClick={() => {
            const action = toast.action;
            dismissToast(toast.id, { acted: true });
            void action?.run();
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button
        class="icon-button small toast-close"
        data-tip="Dismiss"
        aria-label="Dismiss notification"
        onClick={() => dismissToast(toast.id)}
      >
        <Icon name="close" size={14} />
      </button>
      {timed && (
        <span
          key={toast.round ?? 0}
          class={`toast-progress ${expanded ? "paused" : ""}`}
          style={{ animationDuration: `${toast.duration}ms` }}
        />
      )}
    </div>
  );
}
