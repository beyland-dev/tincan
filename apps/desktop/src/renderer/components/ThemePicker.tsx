import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Theme } from "../../shared/bridge.ts";
import { NAMED_THEMES, PLAIN_THEMES, type ThemeInfo } from "../../shared/themes.ts";
import { changeTheme, previewTheme, theme } from "../store.ts";
import { Icon } from "./Icon.tsx";

const WIDTH = 260;
const HEIGHT = 360;

interface Option {
  id: Theme;
  label: string;
  hint?: string;
}

const isContrast = (id: string) => id.startsWith("contrast-");

const GROUPS: { title: string; options: Option[] }[] = [
  {
    title: "Tincan",
    options: [
      { id: "system", label: "System", hint: "Follows your desktop" },
      ...PLAIN_THEMES.map((t) => ({ id: t.id, label: t.label })),
    ],
  },
  {
    title: "Light",
    options: NAMED_THEMES.filter((t) => t.scheme === "light" && !isContrast(t.id)).map((t) => ({
      id: t.id,
      label: t.label,
    })),
  },
  {
    title: "Dark",
    options: NAMED_THEMES.filter((t) => t.scheme === "dark" && !isContrast(t.id)).map((t) => ({
      id: t.id,
      label: t.label,
    })),
  },
  {
    title: "High contrast",
    options: NAMED_THEMES.filter((t) => isContrast(t.id)).map((t) => ({
      id: t.id,
      label: t.label,
    })),
  },
];

const OPTIONS = GROUPS.flatMap((g) => g.options);

/** Settings ▸ Appearance: every theme in one dropdown; arrowing or hovering previews each. */
export function ThemePicker() {
  const value = theme.value;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const previewing = useRef(false);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const current = OPTIONS.find((o) => o.id === value);

  const close = (refocus = true) => {
    if (previewing.current) {
      previewing.current = false;
      previewTheme(null);
    }
    setOpen(false);
    setPos(null);
    if (refocus) button.current?.focus();
  };

  const pick = (o: Option | undefined) => {
    if (!o) return;
    previewing.current = false;
    if (o.id !== value) void changeTheme(o.id);
    else previewTheme(null);
    close();
  };

  const move = (i: number) => {
    setActive(i);
    const o = OPTIONS[i];
    if (!o) return;
    previewing.current = true;
    previewTheme(o.id);
  };

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const above =
      window.innerHeight - r.bottom < HEIGHT + 12 && r.top > window.innerHeight - r.bottom;
    const left = Math.max(8, Math.min(r.right - WIDTH, window.innerWidth - WIDTH - 8));
    setPos({ left, top: above ? r.top - 6 : r.bottom + 6, above });
    setActive(
      Math.max(
        0,
        OPTIONS.findIndex((o) => o.id === value),
      ),
    );
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !button.current?.contains(t)) close(false);
    };
    const onScroll = (e: Event) => {
      if (!pop.current?.contains(e.target as Node)) close(false);
    };
    const onResize = () => close(false);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", onResize);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", onResize);
    };
  }, [open]);

  // Leaving Settings mid-preview shows the saved theme again.
  useEffect(() => () => void (previewing.current && previewTheme(null)), []);

  useEffect(() => {
    if (pos) list.current?.focus({ preventScroll: true });
  }, [pos]);

  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, pos]);

  const onKey = (e: KeyboardEvent) => {
    const last = OPTIONS.length - 1;
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 5, PageUp: -5 }[e.key];
    if (step !== undefined) {
      e.preventDefault();
      move(Math.max(0, Math.min(last, active + step)));
    } else if (e.key === "Home") {
      e.preventDefault();
      move(0);
    } else if (e.key === "End") {
      e.preventDefault();
      move(last);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(OPTIONS[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  let index = 0;
  return (
    <>
      <button
        ref={button}
        type="button"
        class="select-button theme-select"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Theme: ${current?.label ?? value}`}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <ThemeChip theme={value} size={16} />
        <span class="select-label">{current?.label ?? value}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      {open && pos && (
        <div
          ref={pop}
          class={`select-popover${pos.above ? " above" : ""}`}
          style={{ left: `${pos.left}px`, top: `${pos.top}px`, width: `${WIDTH}px` }}
        >
          <ul
            ref={list}
            role="listbox"
            tabIndex={-1}
            aria-label="Theme"
            aria-activedescendant={`theme-option-${OPTIONS[active]?.id}`}
            class="select-list theme-list"
            onKeyDown={onKey}
          >
            {GROUPS.map((g) => (
              <li key={g.title} role="presentation" class="select-group">
                <span class="select-group-title" aria-hidden="true">
                  {g.title}
                </span>
                <ul role="group" aria-label={g.title}>
                  {g.options.map((o) => {
                    const i = index++;
                    return (
                      <li
                        key={o.id}
                        id={`theme-option-${o.id}`}
                        role="option"
                        data-index={i}
                        aria-selected={o.id === value}
                        class={i === active ? "active" : undefined}
                        onPointerMove={(e) => {
                          // Scrolling the list under a still pointer isn't a hover.
                          const last = pointer.current;
                          pointer.current = { x: e.screenX, y: e.screenY };
                          if (last && last.x === e.screenX && last.y === e.screenY) return;
                          if (i !== active) move(i);
                        }}
                        onClick={() => pick(o)}
                      >
                        <ThemeChip theme={o.id} size={18} />
                        <span class="select-label">{o.label}</span>
                        {o.hint && <span class="select-hint">{o.hint}</span>}
                        {o.id === value && <Icon name="check" size={14} />}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/** A theme's swatch: its accents blended into its background; System is half light, half dark. */
export function ThemeChip({ theme: id, size = 22 }: { theme: Theme; size?: number }) {
  const info = themeInfo(id);
  const fill = (t: ThemeInfo) =>
    `linear-gradient(135deg, ${t.accent} 10%, ${t.accent2} 50%, ${t.bg} 90%)`;
  const background = info
    ? fill(info)
    : `linear-gradient(135deg, ${PLAIN_THEMES[0].bg} 50%, ${PLAIN_THEMES[1].bg} 50%)`;
  return (
    <span
      class="theme-chip"
      style={{ background, width: `${size}px`, height: `${size}px` }}
      aria-hidden="true"
    />
  );
}

export function themeInfo(id: Theme): ThemeInfo | undefined {
  return [...PLAIN_THEMES, ...NAMED_THEMES].find((t) => t.id === id);
}
