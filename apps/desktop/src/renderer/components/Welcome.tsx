import type { ProfileState } from "@beyland/tincan-protocol";
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  backgroundService,
  changeSettings,
  openSettings,
  finishWelcome,
  installBackgroundService,
  linkPreviews,
  phoneInfo,
  refreshBackgroundService,
  refreshPhoneInfo,
  requestLinkPreviews,
  settings,
  startPairing,
  status,
} from "../store.ts";
import { Shortcuts } from "./Conversation.tsx";
import { AgentConnectionGuide } from "./AgentApps.tsx";
import { CountryPicker } from "./CountryPicker.tsx";
import { AgentDanger, AgentPermissions, PlacementPicker, Switch } from "./Dialogs.tsx";
import { Reveal } from "./Reveal.tsx";
import tincanIcon from "../assets/tincan-avatar.png";
import { Icon } from "./Icon.tsx";
import { ThemePicker } from "./ThemePicker.tsx";

const ANSWERS_KEY = "tincan.welcome.answers";

/** One thing Tincan says: a line of text, or an interactive card. */
interface Part {
  card?: boolean;
  body: ComponentChildren;
}

interface Reply {
  label: string;
  secondary?: boolean;
  /** Clears the conversation instead of answering. */
  restart?: boolean;
  run?: () => void;
}

/** A turn of the conversation: what Tincan says, then the replies that move it on. */
interface Beat {
  parts: Part[];
  replies: Reply[];
}

const say = (body: ComponentChildren): Part => ({ body });
const card = (body: ComponentChildren): Part => ({ card: true, body });

function loadAnswers(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(ANSWERS_KEY) ?? "[]") as unknown;
    return Array.isArray(saved) ? saved.filter((a): a is string => typeof a === "string") : [];
  } catch {
    return [];
  }
}

/** Tincan's own avatar, in the sidebar and the conversation's header. */
export function TincanAvatar({ size = 40 }: { size?: number }) {
  return (
    <img
      class="avatar photo tincan-avatar"
      src={tincanIcon}
      alt=""
      draggable={false}
      style={{ width: `${size}px`, height: `${size}px` }}
    />
  );
}

/** This computer's Bluetooth name (often its hostname). Not blurred here: onboarding is for you. */
function ComputerName() {
  const name = phoneInfo.value?.adapter?.name;
  return name ? <strong>{name}</strong> : <strong>this computer</strong>;
}

function beats(): Beat[] {
  const phone = status.value?.phone;
  const connected = phone?.state === "connected";
  const profiles = phone?.device?.profiles;
  const shared = profiles?.map === "ready" && profiles?.pbap === "ready";
  const service = backgroundService.value;
  const background = service?.installed && service.enabled === true;
  return [
    {
      parts: [
        say("Hi, I'm Tincan 👋"),
        say(
          "I bring your iPhone's messages to this computer, so you can read and reply without reaching for your phone.",
        ),
        say(
          "It all happens over Bluetooth. Your iPhone does the sending, and nothing goes through a server.",
        ),
      ],
      replies: [{ label: "How do I set it up?" }],
    },
    {
      parts: [
        say("First, let's pair your iPhone. Keep it unlocked and close by."),
        card(<PairCard />),
      ],
      replies: connected
        ? [{ label: "It's connected!" }]
        : phone && phone.state !== "unpaired"
          ? [{ label: "Next" }]
          : [{ label: "I'll pair it later", secondary: true }],
    },
    {
      parts: [
        say(
          <>
            Next, on your iPhone, go to Settings › Bluetooth and tap <Icon name="info" size={14} />{" "}
            next to <ComputerName />. Turn on these two switches so it can share your messages and
            contacts with me:
          </>,
        ),
        card(<IPhoneSettings />),
      ],
      replies: shared
        ? [{ label: "Both are on" }]
        : [{ label: "Done" }, { label: "Skip for now", secondary: true }],
    },
    {
      parts: [
        say(
          "Now let's make Tincan yours by picking a theme. You can hover over a theme menu item to preview it.",
        ),
        card(
          <WelcomeSetting label="Theme">
            <ThemePicker />
          </WelcomeSetting>,
        ),
        say("Where should notifications, like the one to undo a delete, appear in this window?"),
        card(
          <WelcomeSetting label="Notification position">
            <PlacementPicker />
          </WelcomeSetting>,
        ),
        say(
          "Which country are you in? I'll use it for phone numbers typed without a country code.",
        ),
        card(
          <WelcomeSetting label="Default country">
            <CountryPicker
              value={settings.value?.defaultRegion}
              onChange={(defaultRegion) => void changeSettings({ defaultRegion })}
            />
          </WelcomeSetting>,
        ),
        say("Want previews under links in messages?"),
        card(
          <WelcomeSetting label="Link previews">
            <Switch
              label="Link previews"
              checked={linkPreviews.value}
              onChange={requestLinkPreviews}
            />
          </WelcomeSetting>,
        ),
      ],
      replies: [{ label: "Looks good" }],
    },
    {
      parts: [
        say(
          background
            ? "I'm already set to start when you login, so messages keep arriving after you close this window."
            : "I can keep running after you close this window, so messages and notifications keep arriving.",
        ),
        // Always a card: the switch, or why there isn't one (a dev build or a test phone can't
        // install the service, and `service.status` is null then).
        ...(background ? [] : [card(<BackgroundSetting />)]),
      ],
      replies: background
        ? [{ label: "Great" }]
        : service === null
          ? [{ label: "Not now" }]
          : [{ label: "Not now", secondary: true }],
    },
    {
      parts: [
        say(
          <>
            AI agents can use Tincan too, through its MCP server or the <code>tincan</code> command.
            They're off unless you allow them. Pick how much they can do, and I can connect to the
            agents you use.
          </>,
        ),
        card(<AgentsSetting />),
      ],
      replies: [{ label: "Got it" }],
    },
    {
      parts: [
        say("That's everything! A few shortcuts to get around:"),
        card(
          <nav class="starters welcome-shortcuts" aria-label="Shortcuts">
            <Shortcuts />
          </nav>,
        ),
        say(
          "You can come back to this conversation any time from Settings or the command palette.",
        ),
      ],
      replies: [{ label: "Start using Tincan", run: finishWelcome }],
    },
  ];
}

/** The getting-started conversation with Tincan: it walks through setup, one reply at a time. */
export function Welcome() {
  const [answers, setAnswers] = useState(loadAnswers);
  const all = beats();
  const current = Math.min(answers.length, all.length - 1);
  const beat = answers.length < all.length ? all[current]! : null;
  const list = useRef<HTMLDivElement>(null);
  const first = useRef(true);

  useEffect(() => {
    void refreshPhoneInfo();
    void refreshBackgroundService();
  }, []);

  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: first.current ? "auto" : "smooth" });
    first.current = false;
  }, [answers.length]);

  const answer = (reply: Reply) => {
    const next = [...answers, reply.label];
    localStorage.setItem(ANSWERS_KEY, JSON.stringify(next));
    setAnswers(next);
    reply.run?.();
  };
  const restart = () => {
    localStorage.removeItem(ANSWERS_KEY);
    setAnswers([]);
  };

  const replies: Reply[] = beat
    ? beat.replies
    : [
        { label: "Start over", secondary: true, restart: true },
        { label: "Back to my messages", run: finishWelcome },
      ];

  return (
    <main class="conversation welcome-conversation">
      <header class="conversation-header">
        <div class="conversation-who">
          <TincanAvatar size={30} />
          <span class="conversation-title">
            <h2>Tincan</h2>
            <p>Getting started</p>
          </span>
        </div>
      </header>
      <div class="message-list welcome-list" ref={list} aria-live="polite">
        {all.slice(0, current + 1).map((b, i) => {
          return (
            <div key={i} class="welcome-beat">
              {b.parts.map((part, j) => (
                <TincanPart key={j} part={part} start={j === 0} />
              ))}
              {answers[i] !== undefined && (
                <div class="bubble-row out start">
                  <div class="bubble-line">
                    <div class="bubble">
                      <span class="body">{answers[i]}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div class="welcome-replies">
        {replies.map((reply) => (
          <button
            key={reply.label}
            class={`welcome-reply ${reply.secondary ? "secondary" : ""}`}
            onClick={() => {
              if (reply.restart) restart();
              else if (beat) answer(reply);
              else reply.run?.();
            }}
          >
            {reply.label}
          </button>
        ))}
      </div>
    </main>
  );
}

function TincanPart({ part, start }: { part: Part; start: boolean }) {
  return (
    <div class={`bubble-row in welcome-part ${start ? "start" : ""}`}>
      {part.card ? (
        <div class="welcome-card">{part.body}</div>
      ) : (
        <div class="bubble-line">
          <div class="bubble">
            <span class="body">{part.body}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function WelcomeSetting(props: { label: string; children: ComponentChildren }) {
  return (
    <div class="welcome-setting">
      <span class="setting-label">{props.label}</span>
      {props.children}
    </div>
  );
}

/** Pairing, with the phone's live state. */
function PairCard() {
  const phone = status.value?.phone;
  const device = phone?.device;
  const state = phone?.state ?? "unpaired";
  if (state === "unpaired" || !device) {
    return (
      <div class="welcome-pair">
        <span class="welcome-glyph">
          <Icon name="bluetooth" size={20} />
        </span>
        <div class="welcome-pair-text">
          <p class="setting-label">No iPhone yet</p>
          <p class="setting-hint">
            I'll look for it nearby. On the iPhone, open Settings › Bluetooth so it can be found.
          </p>
        </div>
        <button class="button primary" onClick={() => void startPairing()}>
          Pair iPhone…
        </button>
      </div>
    );
  }
  const tone = state === "connected" ? "ok" : state === "connecting" ? "warn" : "off";
  const text =
    state === "connected"
      ? "Connected"
      : state === "connecting"
        ? "Connecting…"
        : "Paired, not nearby";
  return (
    <div class="welcome-pair">
      <span class={`welcome-glyph ${tone}`}>
        <Icon name={state === "connected" ? "check" : "phone"} size={20} />
      </span>
      <div class="welcome-pair-text">
        <p class="setting-label">{device.name}</p>
        <p class="setting-hint">
          <span class={`status-dot ${tone}`} /> {text}
        </p>
      </div>
    </div>
  );
}

/** A look at the iPhone's own Bluetooth settings for this computer, with what it shares now. */
function IPhoneSettings() {
  const device = status.value?.phone.device;
  const connected = status.value?.phone.state === "connected";
  const rows: Array<[string, string, ProfileState | undefined]> = [
    ["Show Notifications", "Lets me read and send your messages", device?.profiles.map],
    ["Sync Contacts", "Shows names instead of numbers", device?.profiles.pbap],
  ];
  return (
    <div class="ios-settings">
      <div class="ios-group">
        {rows.map(([label, hint, state]) => {
          const on = connected && state === "ready";
          return (
            <div key={label} class="ios-row">
              <div>
                <p>{label}</p>
                <p class="setting-hint">{hint}</p>
              </div>
              <span class={`ios-switch ${on ? "on" : ""}`} aria-label={on ? "On" : "Off"} />
            </div>
          );
        })}
      </div>
      <p class="setting-hint">
        {connected
          ? "These mirror the switches on your iPhone, and turn on here once it starts sharing."
          : "Once your iPhone is connected, these show what it's sharing."}
      </p>
    </div>
  );
}

/**
 * Offers to run in the background. `backgroundService` is undefined until it's been asked, and
 * null when this daemon can't manage the service: then the card says so, and the flow goes on.
 */
function BackgroundSetting() {
  const [busy, setBusy] = useState(false);
  const service = backgroundService.value;
  if (service === null) {
    return (
      <div class="welcome-setting">
        <div>
          <p class="setting-label">Run in the background</p>
          <p class="setting-hint">
            I can't set that up here, so I'll stop checking for messages when you quit me.
            Development builds, and computers without systemd, can't run me in the background.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div class="welcome-setting">
      <div>
        <p class="setting-label">Run in the background</p>
        <p class="setting-hint">Start when you login, and restart if I stop.</p>
      </div>
      <button
        class="button primary"
        disabled={busy || service === undefined}
        onClick={async () => {
          setBusy(true);
          await installBackgroundService();
          setBusy(false);
        }}
      >
        {busy ? "Turning on…" : "Turn on"}
      </button>
    </div>
  );
}

function AgentsSetting() {
  const enabled = (settings.value?.agents.access ?? "off") !== "off";
  return (
    <div class="welcome-agents">
      <AgentPermissions
        variant="welcome"
        intro={
          <>
            You can change this any time in{" "}
            <button class="link" onClick={() => openSettings("agents")}>
              Settings
            </button>
            .
          </>
        }
      />
      <AgentDanger variant="welcome" />
      <Reveal open={enabled}>
        <div class="welcome-agent-options">
          <p class="settings-subhead">Connect an agent</p>
          <AgentConnectionGuide />
        </div>
      </Reveal>
    </div>
  );
}
