import {
  locateVerificationCode,
  parseTapback,
  type LocatedCode,
  type Message,
  type Thread,
} from "@beyland/tincan-protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { scheduledAnnouncement, scheduledLine, secondsLeft } from "../countdown.ts";
import {
  asciiUrl,
  clockTime,
  dayLabel,
  firstLink,
  formatHandle,
  isJumboEmoji,
  linkify,
  linkSummary,
  messageTime,
  onlyLink,
  attachmentSummary,
  placeholders,
  sameDay,
  sendFailureText,
  startsGroup,
} from "../format.ts";
import { gapBreaks, linkSpans } from "../link.ts";
import {
  autoPreviews,
  cancelScheduled,
  conversations,
  detail,
  dialog,
  openSettings,
  focusSearch,
  infoOpen,
  isPending,
  linkCardsOnly,
  linkLog,
  loadOlder,
  markRead,
  messageMenu,
  names,
  notify,
  pickFrom,
  picked,
  pickMode,
  retry,
  selectedThread,
  sendNow,
  startCompose,
  threads,
  togglePicked,
  toggleSidebar,
} from "../store.ts";
import { ThreadAvatar } from "./Avatar.tsx";
import { GapDivider } from "./ConnectionDock.tsx";
import { CodeChip, CopyCodePill } from "./CodeCopy.tsx";
import { Composer } from "./Composer.tsx";
import { groupTapbacks, TapbackIcon, Tapbacks } from "./Tapback.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import { InfoPanel } from "./InfoPanel.tsx";
import {
  AttachmentCard,
  attachmentParts,
  hasPreviewCard,
  LocationCard,
  PreviewCard,
  SummaryCard,
} from "./Rich.tsx";

export function Conversation() {
  const thread = selectedThread.value;
  if (!thread) {
    return (
      <main class="conversation">
        <header class="conversation-header blank" />
        <EmptyState />
      </main>
    );
  }
  return (
    <main class="conversation" key={thread.key}>
      <Header thread={thread} />
      <div class="conversation-body">
        <div class="conversation-column">
          <GroupNotice thread={thread} />
          <MessageList thread={thread} />
          <SendAnnouncer thread={thread} />
          {picked.value ? <PickBar /> : <Composer thread={thread} />}
        </div>
        {infoOpen.value && !isNew(thread) && <InfoPanel thread={thread} />}
      </div>
      <MessageMenu thread={thread} />
    </main>
  );
}

/** A new recipient with drafts waiting: no conversation with them yet. */
function isNew(thread: Thread): boolean {
  return isPending(thread.key) && !threads.value.some((t) => t.key === thread.key);
}

function subtitle(thread: Thread): string {
  if (isNew(thread)) {
    const handle = thread.members[0] ?? thread.key;
    return names.value.has(handle)
      ? `${formatHandle(handle)} · New conversation`
      : "New conversation";
  }
  if (thread.kind === "direct") {
    const handle = thread.members[0] ?? thread.key;
    return names.value.has(handle) ? formatHandle(handle) : "";
  }
  const group = detail.value?.group;
  if (group?.roster?.length) {
    return group.roster.map((h) => names.value.get(h) ?? formatHandle(h)).join(", ");
  }
  if (group?.participants.length) return group.participants.join(", ");
  return thread.members.map((h) => names.value.get(h) ?? formatHandle(h)).join(", ");
}

function Header({ thread }: { thread: Thread }) {
  const shown = subtitle(thread);
  // An unnamed group is already called by its members.
  const sub = shown === thread.title ? "" : shown;
  const infoLabel = thread.kind === "group" ? "Group info" : "Contact info";
  const toggleInfo = () => (infoOpen.value = !infoOpen.value);
  return (
    <header class="conversation-header">
      <div class="conversation-who">
        <ThreadAvatar thread={thread} size={30} />
        <span class="conversation-title">
          <h2>{thread.title}</h2>
          {sub && <p>{sub}</p>}
        </span>
      </div>
      <div class="toolbar">
        {isNew(thread) ? null : (
          <>
            {thread.unread > 0 && (
              <button
                class="icon-button"
                data-tip="Mark as read"
                aria-label="Mark as read"
                onClick={() => void markRead(thread.key)}
              >
                <Icon name="check" />
              </button>
            )}
            <button
              class={`icon-button ${infoOpen.value ? "on" : ""}`}
              data-tip={`${infoLabel} (Ctrl+Shift+B)`}
              aria-label={infoLabel}
              aria-pressed={infoOpen.value}
              onClick={toggleInfo}
            >
              <Icon name="info" />
            </button>
          </>
        )}
      </div>
    </header>
  );
}

function GroupNotice({ thread }: { thread: Thread }) {
  if (thread.kind !== "group") return null;
  const group = detail.value?.group;
  if (group?.routeInvalidated) {
    return (
      <div class="notice warn">
        Someone outside this group's saved members wrote here. Check the members on your iPhone.
      </div>
    );
  }
  return null;
}

/** Messages from a person (not a business's short code) can be moved to a group. */
function canMoveFrom(thread: Thread): boolean {
  return thread.kind === "direct" && !thread.key.startsWith("sender:");
}

/** Right-click actions for a message: copy it or its code, move it to a group, delete it. */
function MessageMenu({ thread }: { thread: Thread }) {
  const menu = messageMenu.value;
  const message = menu && conversations.value[thread.key]?.messages.find((m) => m.id === menu.id);
  if (!menu || !message) return null;
  const close = () => (messageMenu.value = null);
  const act = (work: () => void) => () => {
    close();
    work();
  };
  const copy = (text: string, what: string) =>
    void window.tincan
      .copyText(text)
      .then((ok) => notify(ok ? `Copied ${what}` : "Couldn't copy", ok ? "success" : "error"));
  const code = message.direction === "incoming" ? locateVerificationCode(message.body)?.code : null;
  const movable = message.direction === "incoming" && canMoveFrom(thread);
  return (
    <div
      class="menu-backdrop"
      onClick={close}
      onContextMenu={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div
        class="context-menu"
        role="menu"
        style={{
          left: `${Math.min(menu.x, window.innerWidth - 210)}px`,
          top: `${Math.min(menu.y, window.innerHeight - 170)}px`,
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && close()}
      >
        {code && (
          <button role="menuitem" onClick={act(() => copy(code, "code"))}>
            Copy Code
          </button>
        )}
        {message.body.trim() && (
          <button role="menuitem" onClick={act(() => copy(message.body, "message"))}>
            Copy Text
          </button>
        )}
        {movable && (
          <button role="menuitem" onClick={act(() => pickFrom("group", message.id))}>
            Move to a Group…
          </button>
        )}
        <button role="menuitem" class="danger" onClick={act(() => pickFrom("delete", message.id))}>
          Delete…
        </button>
      </div>
    </div>
  );
}

/** Shown instead of the composer while picking messages to move to a group or delete. */
function PickBar() {
  const count = picked.value?.size ?? 0;
  const deleting = pickMode.value === "delete";
  return (
    <div class="composer pick-bar">
      <span class="muted">
        {count > 0
          ? `${count} message${count === 1 ? "" : "s"} picked`
          : deleting
            ? "Pick the messages to delete from Tincan."
            : "Pick the messages that came from a group conversation."}
      </span>
      <button class="button" onClick={() => (picked.value = null)}>
        Cancel
      </button>
      {deleting ? (
        <button
          class="button danger-fill"
          disabled={count === 0}
          onClick={() => (dialog.value = "confirmDeleteMessages")}
        >
          Delete…
        </button>
      ) : (
        <button
          class="button primary"
          disabled={count === 0}
          onClick={() => (dialog.value = "moveToGroup")}
        >
          Move to group…
        </button>
      )}
    </div>
  );
}

export function MessageList({ thread }: { thread: Thread }) {
  const ref = useRef<HTMLDivElement>(null);
  const state = conversations.value[thread.key];
  const messages = state?.messages ?? [];
  const lastId = messages.at(-1)?.id;
  const firstId = messages[0]?.id;
  const anchor = useRef<{ height: number; top: number; firstId?: string; lastId?: string }>({
    height: 0,
    top: 0,
  });

  // Keep the view pinned to the bottom for new messages, and steady when older ones load above.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const prev = anchor.current;
    if (prev.firstId && firstId !== prev.firstId && lastId === prev.lastId) {
      el.scrollTop = el.scrollHeight - prev.height + prev.top;
    } else {
      const wasNearBottom = !prev.lastId || prev.height - prev.top - el.clientHeight < 120;
      if (wasNearBottom || messages.at(-1)?.direction === "outgoing")
        el.scrollTop = el.scrollHeight;
    }
    anchor.current = { height: el.scrollHeight, top: el.scrollTop, firstId, lastId };
  }, [firstId, lastId, messages.length]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    anchor.current = { ...anchor.current, height: el.scrollHeight, top: el.scrollTop };
    if (el.scrollTop < 200) void loadOlder(thread.key);
  };

  // "Sent" goes under the last message that went; one still waiting has its own status line.
  const lastOutgoing = messages.findLast(
    (m) => m.direction === "outgoing" && m.status !== "scheduled",
  )?.id;
  const autoPreview = autoPreviews(thread, messages);
  const items = withGhosts(messages);
  const times = items.map((item) => messageTime(item.message));
  const breaks = gapBreaks(times, linkSpans(linkLog.value, Date.now()));
  const heard = messages.filter((m) => m.direction === "incoming").map((m) => messageTime(m));
  const closedAfter = breaks.after.filter((gap) => !gap.open);
  const openAfter = breaks.after.find((gap) => gap.open);

  return (
    <div class="message-list" ref={ref} onScroll={onScroll}>
      {state?.complete && messages.length > 0 && (
        <p class="history-start">Earlier messages are only on your iPhone.</p>
      )}
      {state?.loading && <p class="history-start">Loading…</p>}
      {items.map((item, i) => {
        const message = item.message;
        const previous = items[i - 1]?.message;
        const newDay = !previous || !sameDay(messageTime(previous), messageTime(message));
        const gaps = breaks.before.get(i);
        if (item.ghost) {
          return (
            <div key={message.id}>
              {gaps && <GapDivider gaps={gaps} times={heard} />}
              {newDay && <p class="day-divider">{dayLabel(messageTime(message))}</p>}
              <Ghost quote={item.ghost.quote} tapbacks={item.ghost.tapbacks} />
            </div>
          );
        }
        const group = newDay || startsGroup(previous, message) || !!items[i - 1]?.ghost || !!gaps;
        return (
          <div key={message.id}>
            {gaps && <GapDivider gaps={gaps} times={heard} />}
            {newDay && <p class="day-divider">{dayLabel(messageTime(message))}</p>}
            <Bubble
              message={message}
              thread={thread}
              showSender={group && thread.kind === "group" && message.direction === "incoming"}
              start={group}
              picking={!!picked.value}
              isPicked={picked.value?.has(message.id) ?? false}
              autoPreview={autoPreview}
              showStatus={
                message.id === lastOutgoing ||
                message.status === "scheduled" ||
                message.status === "failed" ||
                message.status === "unknown"
              }
            />
          </div>
        );
      })}
      {closedAfter.length > 0 && <GapDivider gaps={closedAfter} times={heard} />}
      {openAfter && <GapDivider gaps={[openAfter]} times={heard} />}
      {state && !state.loading && messages.length === 0 && (
        <p class="history-start">
          {isNew(thread) ? "No messages yet." : "No messages on this computer yet."}
        </p>
      )}
    </div>
  );
}

interface Item {
  message: Message;
  /** Tapbacks on a message Tincan doesn't have, shown in its place. */
  ghost?: { quote: string; tapbacks: Message[] };
}

/** Folds tapbacks Tincan couldn't attach into one stand-in per message they quote. */
function withGhosts(messages: Message[]): Item[] {
  const items: Item[] = [];
  const ghosts = new Map<string, NonNullable<Item["ghost"]>>();
  for (const message of messages) {
    const tapback = message.reaction && !message.reactionTo ? parseTapback(message.body) : null;
    if (!tapback || tapback.removed) {
      items.push({ message });
      continue;
    }
    const existing = ghosts.get(tapback.target);
    if (existing) {
      existing.tapbacks.push(message);
      continue;
    }
    const ghost = { quote: tapback.target, tapbacks: [message] };
    ghosts.set(tapback.target, ghost);
    items.push({ message, ghost });
  }
  return items;
}

function reactorName(message: Message): string {
  if (message.direction === "outgoing") return "You";
  return parseTapback(message.body)?.actor ?? senderName(message);
}

/**
 * A message Tincan doesn't have, known only from tapbacks quoting it: sent or received on the
 * iPhone before Tincan synced. Someone else's tapback is most likely on one of yours, so it sits
 * on your side; yours sits on theirs.
 */
function Ghost({ quote, tapbacks }: { quote: string; tapbacks: Message[] }) {
  const mine = tapbacks[0]!.direction === "incoming";
  const who = [...new Set(tapbacks.map(reactorName))].join(", ");
  const explain =
    "This message was sent or received while Tincan wasn't connected to your iPhone, so only " +
    "the reaction reached this computer.";
  const reactions = groupTapbacks(
    tapbacks.map((t) => ({
      kind: t.reaction!,
      from: t.direction === "outgoing" ? null : t.sender,
      text: t.body,
    })),
  );
  return (
    <div class={`bubble-row ghost-row ${mine ? "out" : "in"} start`}>
      <div class="bubble ghost" data-tip={explain} aria-label={`${quote}. ${explain}`}>
        <span class="body">{quote}</span>
        <Tapbacks groups={reactions} title={who} />
      </div>
      <p class="ghost-caption" data-tip={explain}>
        <Icon name="info" size={11} /> Not in Tincan · {who} reacted
      </p>
    </div>
  );
}

const SUGGESTIONS: Array<{ label: string; icon: IconName; keys: string; run: () => void }> = [
  { label: "New message", icon: "compose", keys: "Ctrl N", run: startCompose },
  { label: "Search messages", icon: "search", keys: "Ctrl F", run: focusSearch },
  {
    label: "Command palette",
    icon: "command",
    keys: "Ctrl K",
    run: () => (dialog.value = "palette"),
  },
  { label: "Toggle sidebar", icon: "sidebar", keys: "Ctrl B", run: toggleSidebar },
  { label: "Settings", icon: "settings", keys: "Ctrl ,", run: () => openSettings() },
];

/** Shown when no conversation is open: a few places to start, with their shortcuts. */
function EmptyState() {
  return (
    <div class="empty-state">
      <nav class="starters" aria-label="Get started">
        <h2>Pick a conversation, or start here</h2>
        <Shortcuts />
      </nav>
    </div>
  );
}

/** A few places to start, each with its shortcut; also in the getting-started conversation. */
export function Shortcuts() {
  return (
    <ul>
      {SUGGESTIONS.map((s) => (
        <li key={s.label}>
          <button class="starter" onClick={s.run}>
            <Icon name={s.icon} size={18} />
            <span class="starter-label">{s.label}</span>
            <span class="starter-keys">
              {s.keys.split(" ").map((k) => (
                <kbd key={k}>{k}</kbd>
              ))}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function senderName(message: Message): string {
  if (!message.sender) return "Unknown";
  return names.value.get(message.sender) ?? formatHandle(message.sender);
}

function Bubble(props: {
  message: Message;
  thread: Thread;
  showSender: boolean;
  start: boolean;
  showStatus: boolean;
  picking?: boolean;
  isPicked?: boolean;
  /** Fetch this conversation's link previews without asking (see `autoPreviews`). */
  autoPreview?: boolean;
}) {
  const { message, showSender, start, showStatus, picking, isPicked } = props;
  const outgoing = message.direction === "outgoing";
  // A link you sent yourself is safe to preview; anyone else's waits unless the conversation is trusted.
  const auto = outgoing || !!props.autoPreview;
  if (message.reaction && !message.reactionTo) {
    return (
      <p class="reaction-note">
        {outgoing ? "You" : senderName(message)} reacted{" "}
        <TapbackIcon kind={message.reaction} size={11} /> · {message.body}
      </p>
    );
  }
  const failed = message.status === "failed" || message.status === "unknown";
  const reactions = groupTapbacks(message.reactions);
  const found = placeholders(message.body);
  const described = found ? null : attachmentSummary(message.body);
  const text = found ? found.text : described ? "" : message.body;
  const attachments = Math.max(found?.attachments ?? 0, message.attachmentHint ? 1 : 0);
  const parts =
    described ?? (attachments > 0 ? attachmentParts(attachments, message.attachmentHint) : null);
  const appItems = found?.appItems ?? 0;
  const summary = text && !found ? linkSummary(text) : null;
  const jumbo = !found && !failed && !message.attachmentHint && isJumboEmoji(text);
  const cardOnly = !text && (parts !== null || appItems > 0);
  const link = text && !summary ? firstLink(text) : undefined;
  const linkOnly =
    linkCardsOnly.value &&
    !found &&
    !!link &&
    onlyLink(text) === link &&
    hasPreviewCard(link, auto);
  const kind = jumbo
    ? "jumbo"
    : summary
      ? "summary"
      : cardOnly
        ? "card-only"
        : linkOnly
          ? "preview-only"
          : "";
  const time = messageTime(message);
  // Group texts arrive in the sender's own conversation; these move them by hand.
  const movable =
    !outgoing && !picking && props.thread.kind === "direct" && canMoveFrom(props.thread);
  const located =
    !outgoing && !picking && text && !summary && !linkOnly ? locateVerificationCode(text) : null;
  return (
    <div
      class={`bubble-row ${outgoing ? "out" : "in"} ${start ? "start" : ""} ${picking ? "picking" : ""} ${isPicked ? "picked" : ""}`}
      role={picking ? "checkbox" : undefined}
      aria-checked={picking ? isPicked : undefined}
      tabIndex={picking ? 0 : undefined}
      onClick={picking ? () => togglePicked(message.id) : undefined}
      onContextMenu={
        picking
          ? undefined
          : (e) => {
              if (window.getSelection()?.toString()) return;
              e.preventDefault();
              messageMenu.value = { id: message.id, x: e.clientX, y: e.clientY };
            }
      }
      onKeyDown={
        picking
          ? (e) => {
              if (e.key === " " || e.key === "Enter") {
                e.preventDefault();
                togglePicked(message.id);
              }
            }
          : undefined
      }
    >
      {picking && (
        <span class="pick-mark" aria-hidden="true">
          {isPicked && <Icon name="check" size={12} />}
        </span>
      )}
      {showSender && <p class="sender">{senderName(message)}</p>}
      <div class="bubble-line">
        <div
          class={`bubble ${kind} ${failed ? "failed" : ""} ${message.status === "pending" ? "pending" : ""} ${message.status === "scheduled" ? "scheduled" : ""}`}
        >
          {parts && (
            <AttachmentCard
              parts={parts}
              known={described !== null || !!message.attachmentHint?.kinds}
            />
          )}
          {Array.from({ length: appItems }, (_, i) => (
            <LocationCard key={i} />
          ))}
          {summary ? (
            <SummaryCard title={summary.title} host={summary.host} />
          ) : linkOnly && link ? (
            <PreviewCard url={link} auto={auto} />
          ) : (
            text && (
              <span class="body">
                {located ? <CodeText text={text} located={located} /> : <Linked text={text} />}
              </span>
            )
          )}
          <Tapbacks
            groups={reactions}
            title={message.reactions
              .map((r) => (r.from ? (names.value.get(r.from) ?? formatHandle(r.from)) : "You"))
              .join(", ")}
          />
        </div>
        {!picking && (
          <time class="bubble-time" dateTime={new Date(time).toISOString()}>
            {clockTime(time)}
          </time>
        )}
        {movable && (
          <button
            type="button"
            class="icon-button small bubble-action"
            data-tip="Move to a group…"
            aria-label="Move to a group"
            onClick={() => pickFrom("group", message.id)}
          >
            <Icon name="people" size={14} />
          </button>
        )}
      </div>
      {located && Date.now() - time < FRESH_CODE_MS && <CopyCodePill code={located.code} />}
      {link && !linkOnly && <PreviewCard url={link} auto={auto} />}
      {outgoing &&
        message.agent &&
        !(message.status === "scheduled" && message.agent.via === "policy") && (
          <p class="agent-caption">
            Drafted by {message.agent.name ?? "an AI agent"}
            {message.agent.edited && " · edited"}
          </p>
        )}
      {outgoing && showStatus && <SendStatus message={message} />}
    </div>
  );
}

/** Codes expire within minutes, so only a recent one gets a Copy code button under it. */
const FRESH_CODE_MS = 10 * 60_000;

/** Message text whose one-time code copies when clicked; the rest as `Linked`. */
function CodeText({ text, located }: { text: string; located: LocatedCode }) {
  const out = [];
  let last = 0;
  for (const [start, end] of located.spans) {
    if (start > last) out.push(<Linked key={last} text={text.slice(last, start)} />);
    out.push(
      <CodeChip key={start} code={located.code}>
        {text.slice(start, end)}
      </CodeChip>,
    );
    last = end;
  }
  if (last < text.length) out.push(<Linked key={last} text={text.slice(last)} />);
  return <>{out}</>;
}

/** Message text with its web links clickable (they open in the browser). */
function Linked({ text }: { text: string }) {
  const parts = linkify(text);
  return (
    <>
      {parts.map((part, i) =>
        typeof part === "string" ? (
          part
        ) : (
          <a
            key={i}
            href={part.url}
            target="_blank"
            rel="noreferrer noopener"
            data-tip={asciiUrl(part.url)}
          >
            {part.text}
          </a>
        ),
      )}
    </>
  );
}

function SendStatus({ message }: { message: Message }) {
  switch (message.status) {
    case "scheduled":
      return <ScheduledStatus message={message} />;
    case "pending":
      return <p class="send-status">Sending…</p>;
    case "sent":
      return <p class="send-status">Sent</p>;
    case "failed":
    case "unknown":
      return (
        <p class="send-status error">
          {sendFailureText(message)}{" "}
          <button class="link" onClick={() => void retry(message.id)}>
            Try again
          </button>
        </p>
      );
    default:
      return null;
  }
}

/** What a screen reader hears when a message doesn't send, with why when there's a reason. */
function notSentAnnouncement(message: Message): string {
  const why = sendFailureText(message);
  return why === "Not sent." ? "Message not sent." : `Message not sent. ${why}`;
}

/** The agent's name on its own direct send (not one the user sent from a draft). */
function directAgent(message: Message): string | undefined {
  return message.agent?.via === "policy" ? (message.agent.name ?? "An AI agent") : undefined;
}

/**
 * Under a message held for its send delay: the countdown and how to stop it. The countdown is
 * hidden from screen readers, which hear `SendAnnouncer` once instead of every second.
 */
function ScheduledStatus({ message }: { message: Message }) {
  const sendAt = message.sendAt;
  const [left, setLeft] = useState(() => (sendAt ? secondsLeft(sendAt, Date.now()) : null));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!sendAt) return;
    const tick = () => setLeft(secondsLeft(sendAt, Date.now()));
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [sendAt]);
  const agent = directAgent(message);
  const act = (work: () => Promise<void>) => async () => {
    if (busy) return;
    setBusy(true);
    await work();
    setBusy(false);
  };
  const dot = <span aria-hidden="true"> · </span>;
  return (
    <p class="send-status scheduled-status">
      <span aria-hidden="true">{scheduledLine(left, agent)}</span>
      {agent ? (
        <>
          {dot}
          <button
            class="link"
            disabled={busy}
            aria-label={`Edit ${agent}'s message before it sends`}
            data-tip="Stop it and put it in the message box (Ctrl+Shift+Z)"
            onClick={act(() => cancelScheduled(message, true))}
          >
            Edit
          </button>
          {dot}
          <button
            class="link"
            disabled={busy}
            aria-label={`Cancel ${agent}'s message`}
            onClick={act(() => cancelScheduled(message, false))}
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          {dot}
          <button
            class="link"
            disabled={busy}
            aria-label="Undo send"
            data-tip="Undo (Ctrl+Shift+Z)"
            onClick={act(() => cancelScheduled(message, !!message.agent))}
          >
            Undo
          </button>
          {dot}
          <button
            class="link"
            disabled={busy}
            aria-label="Send now"
            onClick={act(() => sendNow(message))}
          >
            Send now
          </button>
        </>
      )}
    </p>
  );
}

/**
 * Tells screen readers once when a message starts its send delay, and once when it goes or is
 * cancelled; the countdown itself stays quiet.
 */
function SendAnnouncer({ thread }: { thread: Thread }) {
  const state = conversations.value[thread.key];
  const [text, setText] = useState("");
  // Held messages as last seen; null until the conversation's first load, which is never announced.
  const held = useRef<Map<string, Message> | null>(null);
  useEffect(() => {
    if (!state || state.loading) return;
    const now = new Map(
      state.messages.filter((m) => m.status === "scheduled").map((m) => [m.id, m] as const),
    );
    const before = held.current;
    held.current = now;
    if (!before) return;
    const fresh = [...now.values()].find((m) => !before.has(m.id));
    if (fresh) {
      const seconds = fresh.sendAt ? secondsLeft(fresh.sendAt, Date.now()) : null;
      setText(scheduledAnnouncement(thread.title, seconds, directAgent(fresh)));
      return;
    }
    for (const id of before.keys()) {
      if (now.has(id)) continue;
      const after = state.messages.find((m) => m.id === id);
      setText(
        after
          ? after.status === "failed"
            ? notSentAnnouncement(after)
            : "Message sent."
          : "Message cancelled.",
      );
      return;
    }
  }, [state]);
  return (
    <p class="sr-only" role="status" aria-live="polite">
      {text}
    </p>
  );
}
