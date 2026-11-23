import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { notify } from "../store.ts";
import { Icon } from "./Icon.tsx";

/** True while text is selected, so a click that ends a selection doesn't also copy. */
function selectingText(): boolean {
  return Boolean(window.getSelection()?.toString());
}

/** Copies `text`; true for "copied" for a moment afterwards. */
export function useCopy(): [boolean, (text: string) => Promise<void>] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async (text: string) => {
    const ok = await window.tincan.copyText(text).catch(() => false);
    if (!ok) {
      notify("Couldn't copy", "error");
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1400);
  };
  return [copied, copy];
}

/**
 * A detail row that copies `text` when clicked anywhere on it. A copy button shows on hover and
 * keeps it reachable by keyboard; both flip to "Copied" for a moment.
 */
export function CopyRow({
  text,
  label,
  what,
  leading,
  actions,
  children,
}: {
  text: string;
  /** Small caption above the value ("mobile", "home", "Company"). */
  label?: ComponentChildren;
  /** What's copied, for the button's accessible name ("phone number"). */
  what: string;
  leading?: ComponentChildren;
  /** More buttons beside Copy, shown the same way (on hover or focus). They don't copy. */
  actions?: ComponentChildren;
  children?: ComponentChildren;
}) {
  const [copied, copy] = useCopy();
  return (
    <li
      class={`copy-row ${copied ? "copied" : ""}`}
      onClick={() => !selectingText() && void copy(text)}
    >
      {leading}
      <span class="copy-row-text">
        {label && <span class="copy-row-label">{label}</span>}
        <span class="copy-row-value">{children ?? text}</span>
      </span>
      <span class="copy-row-actions" onClick={(e) => e.stopPropagation()}>
        {actions}
        <button
          type="button"
          class="copy-row-button"
          aria-label={copied ? "Copied" : `Copy ${what}`}
          onClick={() => void copy(text)}
        >
          <Icon name={copied ? "check" : "copy"} size={13} />
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </span>
    </li>
  );
}
