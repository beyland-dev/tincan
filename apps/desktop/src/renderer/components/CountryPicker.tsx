import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { countries, filterCountries, type Country } from "../countries.ts";
import { Icon } from "./Icon.tsx";

const WIDTH = 300;
const HEIGHT = 340;

export function CountryPicker({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const current = countries().find((c) => c.code === value);
  const shown = useMemo(() => filterCountries(countries(), query), [query]);

  const close = (refocus = true) => {
    setOpen(false);
    setPos(null);
    if (refocus) button.current?.focus();
  };

  const pick = (c: Country | undefined) => {
    if (!c) return;
    if (c.code !== value) onChange(c.code);
    close();
  };

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const above =
      window.innerHeight - r.bottom < HEIGHT + 12 && r.top > window.innerHeight - r.bottom;
    const left = Math.max(8, Math.min(r.right - WIDTH, window.innerWidth - WIDTH - 8));
    setPos({ left, top: above ? r.top - 6 : r.bottom + 6, above });
    setQuery("");
    const i = countries().findIndex((c) => c.code === value);
    setActive(Math.max(0, i));
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

  useEffect(() => {
    if (pos) search.current?.focus({ preventScroll: true });
  }, [pos]);

  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, pos, shown]);

  const onKey = (e: KeyboardEvent) => {
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 }[e.key];
    if (step !== undefined) {
      e.preventDefault();
      setActive((i) => Math.max(0, Math.min(shown.length - 1, i + step)));
    } else if (e.key === "Home" && !query) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End" && !query) {
      e.preventDefault();
      setActive(shown.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(shown[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        class="select-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Default country: ${current?.name ?? "not set"}`}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {current ? (
          <>
            <span class="country-flag" aria-hidden="true">
              {current.flag}
            </span>
            <span class="select-label">{current.name}</span>
            <span class="country-dial">+{current.dial}</span>
          </>
        ) : (
          <span class="select-label muted">Choose a country</span>
        )}
        <Icon name="chevronDown" size={14} />
      </button>
      {open && pos && (
        <div
          ref={pop}
          class={`select-popover${pos.above ? " above" : ""}`}
          style={{ left: `${pos.left}px`, top: `${pos.top}px`, width: `${WIDTH}px` }}
        >
          <div class="select-search">
            <Icon name="search" size={14} />
            <input
              ref={search}
              value={query}
              placeholder="Search countries or codes"
              aria-label="Search countries"
              aria-controls="country-list"
              aria-activedescendant={shown[active] ? `country-${shown[active].code}` : undefined}
              role="combobox"
              aria-expanded="true"
              onInput={(e) => {
                setQuery(e.currentTarget.value);
                setActive(0);
              }}
              onKeyDown={onKey}
            />
          </div>
          <ul ref={list} id="country-list" role="listbox" class="select-list">
            {shown.length === 0 && <li class="select-empty">No matching countries</li>}
            {shown.map((c, i) => (
              <li
                key={c.code}
                id={`country-${c.code}`}
                role="option"
                data-index={i}
                aria-selected={c.code === value}
                class={i === active ? "active" : undefined}
                onPointerMove={() => i !== active && setActive(i)}
                onClick={() => pick(c)}
              >
                <span class="country-flag" aria-hidden="true">
                  {c.flag}
                </span>
                <span class="select-label">{c.name}</span>
                <span class="country-dial">+{c.dial}</span>
                {c.code === value && <Icon name="check" size={14} />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
