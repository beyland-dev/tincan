import { parseTapback, type Reaction, type ReactionKind } from "@beyland/tincan-protocol";

const LABELS: Record<ReactionKind, string> = {
  love: "Loved",
  like: "Liked",
  dislike: "Disliked",
  laugh: "Laughed at",
  emphasize: "Emphasized",
  question: "Questioned",
  other: "Reacted to",
};

/** The iOS Messages tapback marks, drawn rather than shown as emoji. */
export function TapbackIcon({ kind, emoji, size = 14 }: TapbackProps & { size?: number }) {
  switch (kind) {
    case "love":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 21.2c-.3 0-.6-.1-.8-.3C6.4 16.8 2.5 13.4 2.5 8.9 2.5 5.9 4.8 3.6 7.7 3.6c1.8 0 3.3.9 4.3 2.3 1-1.4 2.5-2.3 4.3-2.3 2.9 0 5.2 2.3 5.2 5.3 0 4.5-3.9 7.9-8.7 12-.2.2-.5.3-.8.3Z"
          />
        </svg>
      );
    case "like":
    case "dislike":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          aria-hidden="true"
          style={kind === "dislike" ? { transform: "scale(1, -1)" } : undefined}
        >
          <path
            fill="currentColor"
            d="M2.5 10.6c0-.8.6-1.4 1.4-1.4h2.4c.8 0 1.4.6 1.4 1.4v9.2c0 .8-.6 1.4-1.4 1.4H3.9c-.8 0-1.4-.6-1.4-1.4v-9.2Zm6.6 9.6V10.4c0-.5.2-1 .5-1.4l4.6-5.6c.5-.6 1.4-.8 2.1-.3.6.4.9 1.1.7 1.8l-1 4.1h4.6c1.5 0 2.6 1.4 2.3 2.9l-1.4 6.9c-.3 1.4-1.5 2.4-2.9 2.4h-7.3c-1.2 0-2.2-.9-2.2-2Z"
          />
        </svg>
      );
    case "laugh":
      return (
        <span class="tapback-text haha" aria-hidden="true">
          HA
          <br />
          HA
        </span>
      );
    case "emphasize":
      return (
        <span class="tapback-text bang" aria-hidden="true">
          !!
        </span>
      );
    case "question":
      return (
        <span class="tapback-text ask" aria-hidden="true">
          ?
        </span>
      );
    default:
      return (
        <span class="tapback-emoji" aria-hidden="true">
          {emoji ?? "•"}
        </span>
      );
  }
}

interface TapbackProps {
  kind: ReactionKind;
  emoji?: string;
}

export interface TapbackGroup extends TapbackProps {
  count: number;
  /** One of the reactions is yours: iOS shows those in your accent colour. */
  mine: boolean;
}

/** Tapbacks of the same kind (or the same emoji) folded together, in the order they arrived. */
export function groupTapbacks(reactions: readonly Reaction[]): TapbackGroup[] {
  const groups = new Map<string, TapbackGroup>();
  for (const r of reactions) {
    const emoji = r.kind === "other" ? parseTapback(r.text)?.emoji : undefined;
    const key = emoji ? `other:${emoji}` : r.kind;
    const group = groups.get(key) ?? { kind: r.kind, emoji, count: 0, mine: false };
    group.count += 1;
    if (r.from === null) group.mine = true;
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function tapbackLabel(kind: ReactionKind): string {
  return LABELS[kind];
}

/** The badge iOS hangs on a bubble's top corner. */
export function Tapbacks({ groups, title }: { groups: TapbackGroup[]; title?: string }) {
  if (groups.length === 0) return null;
  return (
    <span class="tapbacks" data-tip={title}>
      {groups.map((g) => (
        <span
          key={g.emoji ?? g.kind}
          class={`tapback ${g.mine ? "mine" : ""} ${g.kind}`}
          aria-label={`${tapbackLabel(g.kind)}${g.count > 1 ? ` ×${g.count}` : ""}`}
        >
          <TapbackIcon kind={g.kind} emoji={g.emoji} />
          {g.count > 1 && <span class="tapback-count">{g.count}</span>}
        </span>
      ))}
    </span>
  );
}
