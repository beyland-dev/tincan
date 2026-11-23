import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { sensitiveCopy } from "../sensitive.ts";

/**
 * A phone detail (a Bluetooth address, the iPhone's name, this computer's name) blurred until
 * clicked, and blurred again by another click. It starts blurred whenever it mounts, so closing and
 * reopening Settings hides it again. `what` names the value for screen readers, which don't get
 * the value itself while it's hidden. Never nest it in another button: put it beside one.
 */
export function Sensitive(props: { what: string; class?: string; children: ComponentChildren }) {
  const [revealed, setRevealed] = useState(false);
  const copy = sensitiveCopy(props.what, revealed);
  return (
    <button
      type="button"
      class={`sensitive ${revealed ? "revealed" : ""} ${props.class ?? ""}`}
      aria-pressed={revealed}
      aria-label={copy.label}
      data-tip={copy.tip}
      data-tip-delay="short"
      onClick={(e) => {
        // Inside a row that does something on click, this click only reveals.
        e.stopPropagation();
        setRevealed(!revealed);
      }}
    >
      <span class="sensitive-value" aria-hidden={!revealed}>
        {props.children}
      </span>
    </button>
  );
}
