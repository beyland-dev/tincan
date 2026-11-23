import { AgentConnectionGuide } from "./AgentApps.tsx";
import { createPortal, type ComponentChildren } from "preact";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { call } from "../api.ts";
import { CountryPicker } from "./CountryPicker.tsx";
import { useCopy } from "./CopyRow.tsx";
import { diagnosticsText } from "../diagnostics.ts";
import type { Theme } from "../../shared/bridge.ts";
import { NAMED_THEMES } from "../../shared/themes.ts";
import { Reveal } from "./Reveal.tsx";
import { Sensitive } from "./Sensitive.tsx";
import { ThemeChip, ThemePicker, themeInfo } from "./ThemePicker.tsx";
import {
  agentDrafts,
  backgroundService,
  openNextDrafts,
  pendingList,
  pendingThread,
  changeLinkCardsOnly,
  changeSpellcheck,
  spellcheck,
  changeVideoSize,
  changeLinkPreviews,
  contactsSyncing,
  changeSettings,
  changeTheme,
  deleteThread,
  dialog,
  focusSearch,
  installBackgroundService,
  disableBackgroundService,
  infoOpen,
  linkCardsOnly,
  videoSize,
  linkPreviews,
  linkPreviewsConfirm,
  markRead,
  notify,
  openSettings,
  openWelcome,
  movePickedToGroup,
  deletePicked,
  pickMode,
  openInfo,
  cancelPairing,
  confirmPairing,
  pairing,
  pairingError,
  phoneAction,
  phoneInfo,
  startPairing,
  startRename,
  previewTheme,
  picked,
  refreshBackgroundService,
  refreshPhoneInfo,
  refreshToast,
  requestLinkPreviews,
  select,
  selectedThread,
  setFlag,
  agentHidden,
  contacts,
  contactsByHandle,
  hideFromAgents,
  photoFor,
  refreshAgentHidden,
  showToAgents,
  setToastPlacement,
  settings,
  settingsSection,
  sidebarCollapsed,
  startCompose,
  status,
  syncContacts,
  syncNow,
  theme,
  threads,
  TOAST_PLACEMENTS,
  toastPlacement,
  toggleSidebar,
  type ToastPlacement,
} from "../store.ts";
import {
  accessPatch,
  effectiveAgents,
  type AgentSettingsPatch,
  type ProfileState,
} from "@beyland/tincan-protocol";
import {
  ACCESS_OPTIONS,
  agentDelayHint,
  agentSummary,
  delayOptions,
  ownDelayHint,
  confirmCopy,
  confirmFor,
  parseSendLimitValue,
  readHint,
  readOptions,
  sectionsFor,
  sendHint,
  sendLimitHint,
  sendLimitOptions,
  sendLimitValue,
  sendOptions,
  type AgentConfirm,
  type ConfirmCopy,
} from "../agent-settings.ts";
import {
  agentsOn,
  hiddenList,
  hiddenPersonDetail,
  hiddenPersonLabel,
  hideCandidates,
  threadHideAction,
  type HideCandidate,
} from "../agent-hiding.ts";
import { clockTime, listTime } from "../format.ts";
import {
  agentLevelPill,
  PHONE_TONE_LABEL,
  phoneTone,
  sectionForKey,
  SETTINGS_SECTIONS,
  type SettingsSection,
} from "../settings-sections.ts";
import { Avatar, ThreadAvatar } from "./Avatar.tsx";
import { Icon, type IconName } from "./Icon.tsx";

function Modal(props: {
  title: string;
  children: ComponentChildren;
  wide?: boolean;
  class?: string;
}) {
  return (
    <div
      class="backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) dialog.value = null;
      }}
    >
      <div
        class={`modal ${props.wide ? "wide" : ""} ${props.class ?? ""}`}
        role="dialog"
        aria-label={props.title}
      >
        <header class="modal-header">
          <h2>{props.title}</h2>
          <button
            class="icon-button"
            data-tip="Close (Esc)"
            aria-label="Close"
            onClick={() => (dialog.value = null)}
          >
            <Icon name="close" />
          </button>
        </header>
        <div class="modal-body">{props.children}</div>
      </div>
    </div>
  );
}

export function Dialogs() {
  return (
    <>
      <CurrentDialog />
      {linkPreviewsConfirm.value && (
        <ConfirmDialog
          copy={LINK_PREVIEWS_CONFIRM}
          tone="primary"
          onCancel={() => (linkPreviewsConfirm.value = false)}
          onConfirm={() => {
            linkPreviewsConfirm.value = false;
            void changeLinkPreviews(true);
          }}
        />
      )}
    </>
  );
}

function CurrentDialog() {
  switch (dialog.value) {
    case "settings":
      return <SettingsDialog />;
    case "moveToGroup":
      return <MoveToGroupDialog />;
    case "palette":
      return <Palette />;
    case "confirmDeleteMessages":
      return <ConfirmDeleteMessagesDialog />;
    case "forgetPhone":
      return <ForgetPhoneDialog />;
    case "pair":
      return <PairDialog />;
    case "fixConnection":
      return <FixConnectionDialog />;
    default:
      return null;
  }
}

function Choice<T extends string>(props: {
  label: string;
  hint?: string;
  value: T | undefined;
  options: Array<[T, string]>;
  onChange: (value: T) => void;
}) {
  return (
    <div class="setting">
      <div>
        <p class="setting-label">{props.label}</p>
        {props.hint && <p class="setting-hint">{props.hint}</p>}
      </div>
      <Segmented
        label={props.label}
        value={props.value}
        options={props.options}
        onChange={props.onChange}
      />
    </div>
  );
}

/**
 * Arrow keys (and Home / End) move focus between the options of a radio group; Space, Enter or a
 * click picks one. Picking stays a separate step because some choices ask for confirmation.
 */
function moveRadioFocus(e: KeyboardEvent): void {
  const step: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  if (!(e.key in step) && e.key !== "Home" && e.key !== "End") return;
  const group = e.currentTarget as HTMLElement;
  const radios = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)')];
  if (radios.length === 0) return;
  e.preventDefault();
  const at = radios.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? radios.length - 1
        : (Math.max(at, 0) + step[e.key]! + radios.length) % radios.length;
  radios[next]?.focus();
}

/** A row of choices, one picked; only the picked one (or the first) is a Tab stop. */
function Segmented<T extends string>(props: {
  label?: string;
  labelledBy?: string;
  value: T | null | undefined;
  options: Array<[T, string]>;
  disabled?: boolean;
  class?: string;
  onChange: (value: T) => void;
}) {
  const picked = props.options.findIndex(([value]) => value === props.value);
  const stop = picked >= 0 ? picked : 0;
  return (
    <div
      class={`segmented ${props.class ?? ""}`}
      role="radiogroup"
      aria-label={props.labelledBy ? undefined : props.label}
      aria-labelledby={props.labelledBy}
      onKeyDown={moveRadioFocus}
    >
      {props.options.map(([value, label], i) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={props.value === value}
          tabIndex={i === stop ? 0 : -1}
          class={props.value === value ? "on" : ""}
          disabled={props.disabled}
          onClick={() => props.value !== value && props.onChange(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const OPTION_HEIGHT = 32;

/**
 * A dropdown of a few named choices, like the theme and country pickers: the list opens under the
 * button (above it near the bottom of the window), lined up with its right edge.
 */
function Select<T extends string>(props: {
  label: string;
  describedBy?: string;
  value: T | undefined;
  options: Array<[T, string, ...string[]]>;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{
    right: number;
    top: number;
    above: boolean;
    width: number;
  } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const current = props.options.find(([value]) => value === props.value);

  const close = (refocus = true) => {
    setOpen(false);
    setPos(null);
    if (refocus) button.current?.focus();
  };

  const pick = (option: [T, string, ...string[]] | undefined) => {
    if (!option) return;
    close();
    if (option[0] !== props.value) props.onChange(option[0]);
  };

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const height = props.options.length * OPTION_HEIGHT + 10;
    const above =
      window.innerHeight - r.bottom < height + 12 && r.top > window.innerHeight - r.bottom;
    setPos({
      right: Math.max(8, window.innerWidth - r.right),
      top: above ? r.top - 6 : r.bottom + 6,
      above,
      width: r.width,
    });
    setActive(
      Math.max(
        0,
        props.options.findIndex(([value]) => value === props.value),
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

  useEffect(() => {
    if (pos) list.current?.focus({ preventScroll: true });
  }, [pos]);

  const onKey = (e: KeyboardEvent) => {
    const last = props.options.length - 1;
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (step !== undefined) {
      e.preventDefault();
      setActive((i) => Math.max(0, Math.min(last, i + step)));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : last);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(props.options[active]);
    } else if (e.key === "Escape") {
      // Closes only the list, not the dialog it's in.
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
        aria-label={`${props.label}: ${current?.[1] ?? "not set"}`}
        aria-describedby={props.describedBy}
        disabled={props.disabled}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span class="select-label">{current?.[1] ?? "Choose…"}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      {open && pos && (
        <div
          ref={pop}
          class={`select-popover${pos.above ? " above" : ""}`}
          style={{ right: `${pos.right}px`, top: `${pos.top}px`, minWidth: `${pos.width}px` }}
        >
          <ul
            ref={list}
            role="listbox"
            tabIndex={-1}
            aria-label={props.label}
            aria-activedescendant={`${id}-${active}`}
            class="select-list"
            onKeyDown={onKey}
          >
            {props.options.map((option, i) => (
              <li
                key={option[0]}
                id={`${id}-${i}`}
                role="option"
                aria-selected={option[0] === props.value}
                class={i === active ? "active" : undefined}
                onPointerMove={() => i !== active && setActive(i)}
                onClick={() => pick(option)}
              >
                <span class="select-label">{option[1]}</span>
                {option[0] === props.value && <Icon name="check" size={14} />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/** A settings row whose choice is a dropdown at the right; the description says what it means. */
function SelectSetting<T extends string>(props: {
  label: string;
  hint: string;
  value: T | undefined;
  options: Array<[T, string, ...string[]]>;
  class?: string;
  onChange: (value: T) => void;
}) {
  const id = useId();
  return (
    <div class={`setting setting-select ${props.class ?? ""}`}>
      <div>
        <p class="setting-label">{props.label}</p>
        <p class="setting-hint" id={`${id}-hint`}>
          {props.hint}
        </p>
      </div>
      <Select
        label={props.label}
        describedBy={`${id}-hint`}
        value={props.value}
        options={props.options}
        onChange={props.onChange}
      />
    </div>
  );
}

/** An on/off setting: the whole row toggles the switch. */
function Toggle(props: {
  label: string;
  hint?: ComponentChildren;
  checked: boolean;
  disabled?: boolean;
  class?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label class={`setting setting-toggle ${props.class ?? ""}`}>
      <div>
        <p class="setting-label">{props.label}</p>
        {props.hint && <p class="setting-hint">{props.hint}</p>}
      </div>
      <Switch {...props} />
    </label>
  );
}

export function Switch(props: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      class="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="switch-thumb" />
    </button>
  );
}

/** A settings card: its title above a card of rows. */
function Card(props: {
  title: string;
  icon?: IconName;
  class?: string;
  children?: ComponentChildren;
}) {
  return (
    <section class={`settings-section ${props.class ?? ""}`}>
      <h3 class="settings-section-title">
        {props.icon && <Icon name={props.icon} size={14} />}
        {props.title}
      </h3>
      <div class="settings-card">{props.children}</div>
    </section>
  );
}

const PROFILE_TEXT: Record<ProfileState, string> = {
  ready: "Ready",
  idle: "Idle",
  connecting: "Connecting…",
  denied: "Not allowed",
  refused: "Not shared with this computer",
  unavailable: "Off",
};

function since(time: number | null): string {
  if (time === null) return "Never";
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const today = new Date(time).toDateString() === new Date().toDateString();
  return `${today ? "Today" : listTime(time)} at ${clockTime(time)}`;
}

function count(n: number, one: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : `${one}s`}`;
}

/** Settings › iPhone: the paired iPhone, its Bluetooth details, and help when it misbehaves. */
function IPhoneSection() {
  const info = phoneInfo.value;
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => void refreshPhoneInfo(), [status.value?.phone.state]);
  const phone = info?.phone;
  const run = async (action: "connect" | "disconnect") => {
    setBusy(action);
    await phoneAction(action);
    setBusy(null);
  };
  if (!phone) {
    return (
      <>
        <Card title="iPhone">
          <div class="setting">
            <div>
              <p class="setting-label">No iPhone paired</p>
              <p class="setting-hint">Pair your iPhone with this computer to see its messages.</p>
            </div>
            <button class="button primary" onClick={() => void startPairing()}>
              Pair iPhone…
            </button>
          </div>
        </Card>
        <TroubleshootingCard />
      </>
    );
  }
  const state = info.state;
  const blocked = phone.profiles.map === "refused" || phone.profiles.map === "denied";
  const tone = state === "connected" ? "ok" : state === "connecting" ? "warn" : "off";
  const stateText = phone.paused
    ? "Disconnected"
    : blocked
      ? "Messages blocked"
      : state === "connected"
        ? "Connected"
        : state === "connecting"
          ? "Connecting…"
          : state === "unpaired"
            ? "Not paired"
            : "Away";
  const profile = (supported: boolean, value: ProfileState) =>
    supported ? PROFILE_TEXT[value] : "Not supported";
  const adapter = info.adapter;
  return (
    <>
      <Card title="Paired iPhone">
        <div class="phone-summary">
          <span class="phone-glyph">
            <Icon name="phone" size={22} />
          </span>
          <div class="phone-name">
            <p class="setting-label">
              <Sensitive what="iPhone name">{phone.name}</Sensitive>
            </p>
            <p class="setting-hint">
              <span class={`status-dot ${tone}`} /> {stateText}
              {phone.deviceName && (
                <>
                  {" · calls itself "}
                  <Sensitive what="iPhone's own name">{phone.deviceName}</Sensitive>
                </>
              )}
            </p>
          </div>
          <div class="phone-actions">
            {!phone.paused && phone.connected && (
              <button
                class="button"
                data-tip="Check for new messages"
                onClick={() => void syncNow()}
              >
                Check now
              </button>
            )}
            {phone.paused || !phone.connected ? (
              <button class="button" disabled={busy !== null} onClick={() => void run("connect")}>
                {busy === "connect" ? "Connecting…" : "Connect"}
              </button>
            ) : (
              <button
                class="button"
                disabled={busy !== null}
                onClick={() => void run("disconnect")}
              >
                {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
              </button>
            )}
            <button class="button danger" onClick={() => (dialog.value = "forgetPhone")}>
              Forget…
            </button>
          </div>
        </div>
        <dl class="phone-facts">
          <dt>Messages</dt>
          <dd>{profile(phone.supports.map, phone.profiles.map)}</dd>
          <dt>Contacts</dt>
          <dd>{profile(phone.supports.pbap, phone.profiles.pbap)}</dd>
          <dt>Notifications</dt>
          <dd>{profile(phone.supports.ancs, phone.profiles.ancs)}</dd>
          <dt>Last checked</dt>
          <dd>{since(info.lastSync.messages)}</dd>
          <dt>Contacts synced</dt>
          <dd>
            {since(info.lastSync.contacts)}
            {phone.connected && !phone.paused && (
              <>
                {" · "}
                <button
                  class="link"
                  disabled={contactsSyncing.value}
                  data-tip="Read every contact from your iPhone again"
                  onClick={() => void syncContacts()}
                >
                  {contactsSyncing.value ? "Refreshing…" : "Refresh now"}
                </button>
              </>
            )}
          </dd>
          <dt>Kept in Tincan</dt>
          <dd>
            {count(info.stored.threads, "conversation")} · {count(info.stored.messages, "message")}{" "}
            · {count(info.stored.contacts, "contact")}
          </dd>
        </dl>
        {phone.paused && (
          <p class="setting-hint phone-note">
            You disconnected this iPhone. Tincan won't reconnect until you press Connect.
          </p>
        )}
        {!phone.paused && blocked && <MessagesBlocked refused={phone.profiles.map === "refused"} />}
        {adapter?.handsFree === false && <NotHandsFree paired={phone.paired} />}
      </Card>
      <Card title="Bluetooth details">
        <div class="setting">
          <p class="setting-label">Pairing</p>
          <p class="setting-value">
            {phone.paired ? "Paired" : "Not paired"}
            {phone.paired && (phone.trusted ? ", trusted" : ", not trusted")}
          </p>
        </div>
        <div class="setting">
          <p class="setting-label">Phone address</p>
          <p class="setting-value">
            <Sensitive what="iPhone's Bluetooth address" class="mono">
              {phone.address}
            </Sensitive>
          </p>
        </div>
        {adapter && (
          <div class="setting">
            <p class="setting-label">This computer</p>
            <p class="setting-value">
              <Sensitive what="This computer's Bluetooth name and address">
                {adapter.name} <span class="mono muted">{adapter.address}</span>
              </Sensitive>
              {!adapter.powered && " (Bluetooth is off)"}
            </p>
          </div>
        )}
      </Card>
      <TroubleshootingCard />
    </>
  );
}

/** Getting a stuck iPhone going again, and what to send with a bug report. */
function TroubleshootingCard() {
  return (
    <Card title="Troubleshooting">
      <div class="setting">
        <div>
          <p class="setting-label">Fix connection</p>
          <p class="setting-hint">
            Step by step, for an iPhone that won't share its messages or keeps dropping.
          </p>
        </div>
        <button class="button" onClick={() => (dialog.value = "fixConnection")}>
          Fix connection…
        </button>
      </div>
      <CopyDiagnostics />
    </Card>
  );
}

/** Copies the doctor's checks and the connection history, for a bug report. */
function CopyDiagnostics() {
  const [copied, copy] = useCopy();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    const [doctor, history] = await Promise.all([
      call("doctor", {}).catch(() => null),
      call("device.history", {}).catch(() => null),
    ]);
    setBusy(false);
    await copy(diagnosticsText({ version: status.value?.daemon.version ?? null, doctor, history }));
  };
  return (
    <div class="setting">
      <div>
        <p class="setting-label">Copy diagnostics</p>
        <p class="setting-hint">Setup checks and connection history. No messages or contacts.</p>
      </div>
      <button class="button" disabled={busy} onClick={() => void run()}>
        {copied ? "Copied" : busy ? "Checking…" : "Copy diagnostics"}
      </button>
    </div>
  );
}

/** What to do when the iPhone won't share its messages with this computer. */
function MessagesBlocked(props: { refused: boolean }) {
  return (
    <div class="phone-note blocked-note" role="alert">
      <p class="setting-label">
        {props.refused
          ? "The iPhone isn't sharing messages with this computer"
          : "The iPhone isn't allowing this computer to read messages"}
      </p>
      <ol class="pair-tips">
        <li>
          On the iPhone, open Settings › Bluetooth, tap the info button next to this computer and
          turn on Show Notifications.
        </li>
        <li>
          If that's already on, or missing: forget the iPhone here, forget this computer on the
          iPhone, restart the iPhone, then pair again.
        </li>
      </ol>
      <div class="blocked-actions">
        <button class="button" onClick={() => (dialog.value = "fixConnection")}>
          Fix connection…
        </button>
      </div>
    </div>
  );
}

const FIX_STEPS = ["Allow messages", "Forget on both sides", "Restart the iPhone", "Pair again"];
/** How long "Try again" waits for messages to open before suggesting the next step. */
const FIX_CHECK_MS = 20_000;

/**
 * Walks through getting an iPhone that won't share its messages working again: the setting on the
 * iPhone first, then a fresh pairing (forget both sides, restart the iPhone, pair).
 */
function FixConnectionDialog() {
  const device = status.value?.phone.device ?? null;
  const fixed = device?.profiles.map === "ready";
  const adapter = phoneInfo.value?.adapter?.name;
  const computer = adapter ? (
    <strong>
      <Sensitive what="This computer's Bluetooth name">{adapter}</Sensitive>
    </strong>
  ) : (
    "this computer"
  );
  const [step, setStep] = useState(device ? 0 : 1);
  const [check, setCheck] = useState<"idle" | "checking" | "failed">("idle");
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    void refreshPhoneInfo();
    return () => clearTimeout(timer.current);
  }, []);
  const close = () => (dialog.value = null);

  const tryAgain = async () => {
    setCheck("checking");
    clearTimeout(timer.current);
    if (!(await phoneAction("connect"))) return setCheck("failed");
    timer.current = setTimeout(
      () => setCheck((c) => (c === "checking" ? "failed" : c)),
      FIX_CHECK_MS,
    );
  };
  const forget = async () => {
    setBusy(true);
    await phoneAction("forget");
    setBusy(false);
  };

  if (fixed && step === 0) {
    return (
      <Modal title="Fix connection">
        <p class="pair-status ok">
          <Icon name="checkCircle" /> Your iPhone is sharing its messages again.
        </p>
        <footer class="modal-footer end">
          <button class="button primary" onClick={close}>
            Done
          </button>
        </footer>
      </Modal>
    );
  }

  const body: ComponentChildren[] = [
    <>
      <p class="setting-hint">
        On the iPhone, open Settings › Bluetooth, tap the info button next to {computer} and turn on{" "}
        <strong>Show Notifications</strong>. Turn on Sync Contacts too, for names.
      </p>
      {check === "checking" && (
        <p class="pair-status">
          <span class="spin pair-spinner">
            <Icon name="refresh" />
          </span>{" "}
          Asking the iPhone for its messages…
        </p>
      )}
      {check === "failed" && (
        <p class="pair-status error">
          <Icon name="alert" /> Still not sharing. If the setting was already on, or missing, pair
          it again from scratch.
        </p>
      )}
      <div class="fix-actions">
        <button class="button" disabled={check === "checking"} onClick={() => void tryAgain()}>
          {check === "checking" ? "Checking…" : "Try again"}
        </button>
        <button class={`button ${check === "failed" ? "primary" : ""}`} onClick={() => setStep(1)}>
          Next
        </button>
      </div>
    </>,
    <>
      <p class="setting-hint">
        The iPhone remembers whether it shares messages when it pairs, so pairing again from scratch
        resets it. Forget it on both sides first.
      </p>
      <ol class="pair-tips">
        <li>
          {device ? (
            <>
              Forget <Sensitive what="iPhone name">{device.name}</Sensitive> on this computer.{" "}
              <button class="link" disabled={busy} onClick={() => void forget()}>
                {busy ? "Forgetting…" : "Forget iPhone"}
              </button>
            </>
          ) : (
            <>
              <Icon name="check" size={14} /> Forgotten on this computer.
            </>
          )}
        </li>
        <li>
          On the iPhone, open Settings › Bluetooth, tap the info button next to {computer}, then
          Forget This Device.
        </li>
      </ol>
      <div class="fix-actions">
        <button class="button primary" disabled={!!device} onClick={() => setStep(2)}>
          Next
        </button>
      </div>
    </>,
    <>
      <p class="setting-hint">
        Restart the iPhone. Until it restarts it can hold on to the old pairing and refuse a new one
        with “Pairing Unsuccessful”.
      </p>
      <div class="fix-actions">
        <button class="button primary" onClick={() => setStep(3)}>
          It's restarted
        </button>
      </div>
    </>,
    <>
      <p class="setting-hint">
        Unlock the iPhone, open Settings › Bluetooth and keep it near this computer, then pair. When
        the iPhone asks, allow it to share notifications and contacts.
      </p>
      <div class="fix-actions">
        <button class="button primary" onClick={() => void startPairing()}>
          Pair iPhone…
        </button>
      </div>
    </>,
  ];

  return (
    <Modal title="Fix connection">
      <ol class="fix-steps">
        {FIX_STEPS.map((title, i) => (
          <li key={title} class={i === step ? "current" : i < step ? "done" : ""}>
            <button
              class="fix-step-title"
              disabled={i > step}
              aria-current={i === step ? "step" : undefined}
              onClick={() => setStep(i)}
            >
              <span class="fix-step-mark">
                {i < step ? <Icon name="check" size={12} /> : i + 1}
              </span>
              {title}
            </button>
            {i === step && <div class="fix-step-body">{body[i]}</div>}
          </li>
        ))}
      </ol>
      <footer class="modal-footer end">
        <button class="button" onClick={close}>
          Close
        </button>
      </footer>
    </Modal>
  );
}

/**
 * This computer's device class isn't hands-free (BlueZ resets it to Computer at times), so an
 * iPhone pairing now wouldn't offer to share messages or contacts.
 */
function NotHandsFree(props: { paired: boolean }) {
  return (
    <div class="phone-note warn-note" role="status">
      <p class="setting-label">This computer isn't showing itself as a hands-free device</p>
      <p class="setting-hint">
        {props.paired
          ? "Your iPhone keeps working, but pairing it again wouldn't offer to share messages."
          : "The iPhone would pair, but wouldn't offer to share messages or contacts."}{" "}
        To fix it permanently, run <code>tincan setup</code> in a terminal (or{" "}
        <code>sudo btmgmt class 4 8</code> until the next restart)
        {props.paired ? "." : ", then try again."}
      </p>
    </div>
  );
}

function ForgetPhoneDialog() {
  const name = phoneInfo.value?.phone?.name ?? status.value?.phone.device?.name;
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Forget iPhone?">
      <p class="setting-hint dialog-hint">
        Unpair{" "}
        {name ? (
          <strong>
            <Sensitive what="iPhone name">{name}</Sensitive>
          </strong>
        ) : (
          "this iPhone"
        )}{" "}
        from this computer? Tincan stops syncing, but keeps the messages and contacts it already
        has.
      </p>
      <p class="setting-hint dialog-hint">
        To use it again, choose <strong>Pair iPhone</strong> in Settings. If you also forget this
        computer on the iPhone, restart the iPhone before pairing again: until it restarts, it may
        refuse with “Pairing Unsuccessful”.
      </p>
      <footer class="modal-footer end">
        <button class="button" onClick={() => openSettings("iphone")}>
          Cancel
        </button>
        <button
          class="button danger-fill"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const done = await phoneAction("forget");
            setBusy(false);
            if (done) openSettings("iphone");
          }}
        >
          {busy ? "Forgetting…" : "Forget iPhone"}
        </button>
      </footer>
    </Modal>
  );
}

/** "123456" as "123 456", easier to compare at a glance. */
function spacedPasskey(passkey: string): string {
  return passkey.length === 6 ? `${passkey.slice(0, 3)} ${passkey.slice(3)}` : passkey;
}

/** Things to try when pairing fails, most likely first. */
function PairingTips() {
  return (
    <ul class="pair-tips">
      <li>Keep the iPhone unlocked on Settings › Bluetooth, near this computer.</li>
      <li>
        If the iPhone lists this computer under My Devices, tap the info button next to it, then
        Forget This Device.
      </li>
      <li>
        If the iPhone says “Pairing Unsuccessful” straight away, restart the iPhone and try again.
        It can hold on to an old pairing until it restarts.
      </li>
    </ul>
  );
}

function PairDialog() {
  const p = pairing.value;
  const error = pairingError.value;
  // Stop searching (and hide this computer again) when the dialog closes.
  useEffect(() => () => void cancelPairing(), []);
  const close = () => (dialog.value = null);
  const name = p?.name ? (
    <strong>
      <Sensitive what="iPhone name">{p.name}</Sensitive>
    </strong>
  ) : (
    "your iPhone"
  );

  let body: ComponentChildren;
  let footer: ComponentChildren = (
    <button class="button" onClick={close}>
      Cancel
    </button>
  );
  if (error || p?.state === "failed" || p?.state === "idle") {
    body = (
      <>
        <p class="pair-status error">
          <Icon name="alert" /> {error ?? p?.error?.message ?? "Pairing stopped"}
        </p>
        <PairingTips />
      </>
    );
    footer = (
      <>
        <button class="button" onClick={close}>
          Close
        </button>
        <button class="button primary" onClick={() => void startPairing()}>
          Try again
        </button>
      </>
    );
  } else if (!p || p.state === "searching") {
    body = (
      <>
        {p?.handsFree === false && <NotHandsFree paired={false} />}
        <ol class="pair-steps">
          <li>
            On your iPhone, open Settings › Bluetooth and keep it unlocked near this computer.
          </li>
          <li>Pick it below when it shows up.</li>
        </ol>
        <ul class="pair-candidates" aria-live="polite">
          {p?.candidates.map((c, i, all) => (
            <li key={c.address} class="pair-candidate">
              <Icon name="phone" />
              <span class="pair-candidate-name">
                <Sensitive what="iPhone name">{c.name}</Sensitive>
              </span>
              <Sensitive what="Bluetooth address" class="mono muted">
                {c.address}
              </Sensitive>
              <button
                class="button small primary"
                aria-label={all.length > 1 ? `Pair iPhone ${i + 1} of ${all.length}` : undefined}
                onClick={() => void startPairing(c.address)}
              >
                Pair
              </button>
            </li>
          ))}
          <li class="pair-looking muted">
            <span class="spin pair-spinner">
              <Icon name="refresh" size={14} />
            </span>{" "}
            Looking for iPhones…
          </li>
        </ul>
        {p?.discoverable && p.adapterName && (
          <p class="setting-hint">
            Or tap{" "}
            <strong>
              <Sensitive what="This computer's Bluetooth name">{p.adapterName}</Sensitive>
            </strong>{" "}
            under Other Devices on the iPhone, then confirm the code in your computer's Bluetooth
            prompt.
          </p>
        )}
      </>
    );
  } else if (p.state === "confirm" && p.passkey) {
    body = (
      <>
        <p class="dialog-hint">Check that {name} shows this code, then tap Pair on the iPhone.</p>
        <p class="pair-passkey mono">{spacedPasskey(p.passkey)}</p>
      </>
    );
    footer = (
      <>
        <button class="button" onClick={() => void confirmPairing(false)}>
          Doesn't match
        </button>
        <button class="button primary" onClick={() => void confirmPairing(true)}>
          Codes match
        </button>
      </>
    );
  } else if (p.state === "pairing") {
    body = (
      <p class="pair-status">
        <span class="spin pair-spinner">
          <Icon name="refresh" />
        </span>{" "}
        Pairing with {name}… If the iPhone asks, tap Pair.
      </p>
    );
  } else {
    body = (
      <p class="pair-status ok">
        <Icon name="checkCircle" /> Paired with {name}. Tincan is connecting to it now.
      </p>
    );
    footer = (
      <button class="button primary" onClick={close}>
        Done
      </button>
    );
  }
  return (
    <Modal title="Pair iPhone">
      {body}
      <footer class="modal-footer end">{footer}</footer>
    </Modal>
  );
}

const PLACEMENT_LABEL: Record<ToastPlacement, string> = {
  "top-left": "Top left",
  "top-center": "Top center",
  "top-right": "Top right",
  "bottom-left": "Bottom left",
  "bottom-center": "Bottom center",
  "bottom-right": "Bottom right",
};

/** The preview pop-up, kept so trying another spot moves it rather than stacking a new one. */
let placementToast: number | null = null;

/** A small window with a spot for each corner and edge notices can appear at. */
export function PlacementPicker() {
  return (
    <div class="placement-picker" role="radiogroup" aria-label="Notification position">
      {TOAST_PLACEMENTS.map((placement) => {
        const on = toastPlacement.value === placement;
        return (
          <button
            key={placement}
            role="radio"
            aria-checked={on}
            aria-label={PLACEMENT_LABEL[placement]}
            data-tip={PLACEMENT_LABEL[placement]}
            class={`placement-spot ${placement}${on ? " on" : ""}`}
            onClick={() => {
              setToastPlacement(placement);
              const body = PLACEMENT_LABEL[placement];
              if (placementToast === null || !refreshToast(placementToast, { body })) {
                placementToast = notify("Pop-ups appear here", { body });
              }
            }}
          >
            <span class="placement-toast" />
          </button>
        );
      })}
    </div>
  );
}

function BackgroundCard() {
  const service = backgroundService.value;
  const [busy, setBusy] = useState(false);
  useEffect(() => void refreshBackgroundService(), []);
  if (!service) return null;
  const on = service.installed && service.enabled === true;
  const toggle = async (next: boolean) => {
    setBusy(true);
    await (next ? installBackgroundService() : disableBackgroundService());
    setBusy(false);
  };
  return (
    <Card title="Background">
      <Toggle
        label="Run in the background"
        hint={
          on
            ? "Tincan starts when you login, keeps checking for messages after you close this window, and restarts if it stops."
            : "Start Tincan when you login, so messages and notifications keep arriving, and restart it if it stops."
        }
        checked={on}
        disabled={busy}
        onChange={(next) => void toggle(next)}
      />
    </Card>
  );
}

/** Below this window width the section list becomes a row of tabs above the section. */
const NARROW_SETTINGS = "(max-width: 680px)";

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const change = () => setMatches(list.matches);
    list.addEventListener("change", change);
    change();
    return () => list.removeEventListener("change", change);
  }, [query]);
  return matches;
}

function SettingsDialog() {
  const section = settingsSection.value;
  const narrow = useMedia(NARROW_SETTINGS);
  const id = useId();
  const tabs = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent) => {
    const next = sectionForKey(section, e.key);
    if (!next) return;
    e.preventDefault();
    settingsSection.value = next;
    tabs.current?.querySelector<HTMLElement>(`[data-section="${next}"]`)?.focus();
  };
  const tone = phoneTone(status.value?.phone);
  const level = agentLevelPill(settings.value);
  return (
    <Modal title="Settings" wide class="settings">
      <div class="settings-layout">
        <div
          ref={tabs}
          class="settings-nav"
          role="tablist"
          aria-label="Settings sections"
          aria-orientation={narrow ? "horizontal" : "vertical"}
          onKeyDown={onKeyDown}
        >
          {SETTINGS_SECTIONS.map((s) => {
            const on = s.id === section;
            return (
              <button
                key={s.id}
                type="button"
                role="tab"
                id={`${id}-tab-${s.id}`}
                data-section={s.id}
                aria-selected={on}
                aria-controls={`${id}-panel`}
                tabIndex={on ? 0 : -1}
                class={`settings-tab ${on ? "on" : ""}`}
                onClick={() => (settingsSection.value = s.id)}
              >
                <span class="settings-tab-label">{s.label}</span>
                {s.id === "iphone" && (
                  <span
                    class={`status-dot ${tone}`}
                    role="img"
                    aria-label={PHONE_TONE_LABEL[tone]}
                  />
                )}
                {s.id === "agents" && level && <span class="settings-pill">{level}</span>}
              </button>
            );
          })}
        </div>
        <div
          key={section}
          class="settings-panel"
          role="tabpanel"
          id={`${id}-panel`}
          aria-labelledby={`${id}-tab-${section}`}
          tabIndex={0}
        >
          <div class="settings-stack">
            <SettingsContent section={section} />
          </div>
        </div>
        <footer class="settings-foot">
          <button class="link" onClick={openWelcome}>
            Getting started with Tincan
          </button>
          <span class="muted">Tincan {status.value?.daemon.version ?? ""}</span>
        </footer>
      </div>
    </Modal>
  );
}

function SettingsContent(props: { section: SettingsSection }) {
  switch (props.section) {
    case "general":
      return <GeneralSection />;
    case "messages":
      return <MessagesSection />;
    case "iphone":
      return <IPhoneSection />;
    case "agents":
      return <AgentsSection />;
  }
}

function GeneralSection() {
  const s = settings.value;
  return (
    <>
      <Card title="Appearance">
        <div class="setting">
          <div>
            <p class="setting-label">Theme</p>
            <p class="setting-hint">Arrow through the list to preview a theme.</p>
          </div>
          <ThemePicker />
        </div>
      </Card>
      <Card title="Notifications">
        <Choice
          label="Desktop notifications"
          hint="What your computer's notifications show when a message arrives."
          value={s?.notifications.preview}
          options={[
            ["full", "Message"],
            ["sender", "Sender only"],
            ["hidden", "Nothing"],
          ]}
          onChange={(preview) => void changeSettings({ notifications: { preview } })}
        />
        <div class="setting">
          <div>
            <p class="setting-label">Notification position</p>
            <p class="setting-hint">
              Where in Tincan's window confirmations, errors, and undo notifications are shown.
            </p>
          </div>
          <PlacementPicker />
        </div>
      </Card>
      <BackgroundCard />
    </>
  );
}

function MessagesSection() {
  const s = settings.value;
  return (
    <>
      <Card title="Messages">
        <SelectSetting
          label="Send delay"
          hint={ownDelayHint(s?.sendDelaySeconds ?? 0)}
          value={s ? String(s.sendDelaySeconds ?? 0) : undefined}
          options={delayOptions(s?.sendDelaySeconds)}
          onChange={(value) => void changeSettings({ sendDelaySeconds: Number(value) })}
        />
        <div class="setting">
          <div>
            <p class="setting-label">Default country</p>
            <p class="setting-hint">
              Used to read numbers typed without a leading + and country code.
            </p>
          </div>
          <CountryPicker
            value={s?.defaultRegion}
            onChange={(defaultRegion) => void changeSettings({ defaultRegion })}
          />
        </div>
      </Card>
      <Card title="Privacy & network">
        <Toggle
          label="Link previews"
          hint={<LinkPreviewHint />}
          checked={linkPreviews.value}
          onChange={requestLinkPreviews}
        />
        <Reveal open={linkPreviews.value}>
          <Toggle
            label="Hide link-only messages"
            hint="When a message is just a link and its preview has loaded, show the preview (with the site's address) instead of the link's text."
            checked={linkCardsOnly.value}
            onChange={changeLinkCardsOnly}
          />
          <Choice
            label="YouTube player size"
            hint="How wide videos play in a conversation."
            value={videoSize.value}
            options={[
              ["small", "Small"],
              ["medium", "Medium"],
              ["large", "Large"],
            ]}
            onChange={changeVideoSize}
          />
        </Reveal>
        <Toggle
          label="Spell check"
          hint="Underlines misspelled words as you type. Turning it on downloads a spelling dictionary from Google the first time."
          checked={spellcheck.value}
          onChange={(on) => void changeSpellcheck(on)}
        />
      </Card>
    </>
  );
}

/** Settings › AI agents: what agents may do, who they can't see, connecting one, and the risky bits. */
function AgentsSection() {
  const on = agentsOn(settings.value);
  return (
    <>
      <Card title="Access & permissions">
        <AgentPermissions />
      </Card>
      <Reveal open={on}>
        <Card title="Hidden from agents">
          <HiddenFromAgents />
        </Card>
      </Reveal>
      <Reveal open={on}>
        <Card title="Connect an agent">
          <div class="settings-agents">
            <AgentConnectionGuide />
          </div>
        </Card>
      </Reveal>
      <AgentDanger />
    </>
  );
}

/**
 * The people and groups hidden from AI agents, each with a way to show them again, and a picker
 * to hide another. In Settings › AI agents while agents are on.
 */
function HiddenFromAgents() {
  const { people, groups } = hiddenList(agentHidden.value);
  const [picking, setPicking] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => void refreshAgentHidden(), []);
  const closePicker = () => {
    setPicking(false);
    toggle.current?.focus();
  };
  const both = people.length > 0 && groups.length > 0;
  return (
    <div class="hidden-agents">
      <div class="setting">
        <div>
          <p class="setting-hint" id={`${id}-label`}>
            Agents can't read, search or message hidden people and groups, or tell they exist.
            Hiding a contact covers all their numbers and emails, and every group they're in. Your
            list stays as it is.
          </p>
        </div>
        <button
          ref={toggle}
          class="button small"
          aria-expanded={picking}
          aria-controls={`${id}-picker`}
          onClick={() => setPicking(!picking)}
        >
          Hide person or group…
        </button>
      </div>
      <Reveal open={picking}>
        <HidePicker id={`${id}-picker`} onClose={closePicker} />
      </Reveal>
      {people.length === 0 && groups.length === 0 ? (
        <p class="hidden-agents-empty">No one is hidden from agents.</p>
      ) : (
        <div aria-label="Hidden from agents" aria-describedby={`${id}-label`} role="group">
          {people.length > 0 && (
            <>
              {both && <p class="hidden-agents-subhead">People</p>}
              <ul class="hidden-agents-list">
                {people.map((p) => {
                  const label = hiddenPersonLabel(p);
                  const contact = p.contactId
                    ? contacts.value.find((c) => c.id === p.contactId)
                    : undefined;
                  return (
                    <li key={p.id}>
                      <Avatar
                        name={label}
                        photo={contact ? photoFor(contact.handles[0]) : undefined}
                        size={28}
                      />
                      <span class="hidden-agents-name">
                        <span>{label}</span>
                        <small>{hiddenPersonDetail(p)}</small>
                      </span>
                      <button
                        class="button small"
                        aria-label={`Show ${label} to agents`}
                        onClick={() => void showToAgents({ personId: p.id })}
                      >
                        Show to agents
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {groups.length > 0 && (
            <>
              {both && <p class="hidden-agents-subhead">Groups</p>}
              <ul class="hidden-agents-list">
                {groups.map((g) => {
                  const thread = threads.value.find((t) => t.key === g.threadKey);
                  return (
                    <li key={g.threadKey}>
                      {thread ? (
                        <ThreadAvatar thread={thread} size={28} />
                      ) : (
                        <Avatar name={g.title} group size={28} />
                      )}
                      <span class="hidden-agents-name">
                        <span>{g.title}</span>
                      </span>
                      <button
                        class="button small"
                        aria-label={`Show ${g.title} to agents`}
                        onClick={() => void showToAgents({ groupKey: g.threadKey })}
                      >
                        Show to agents
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Search for someone to hide from agents: saved contacts (even ones never texted), conversations
 * with numbers that aren't contacts, groups, or a number or address typed in full.
 */
function HidePicker(props: { id: string; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const results = hideCandidates({ threads: threads.value, contacts: contacts.value }, query);
  const pick = async (candidate: HideCandidate | undefined) => {
    if (!candidate) return;
    if (!(await hideFromAgents(candidate.target))) return;
    setQuery("");
    setActive(0);
    props.onClose();
  };
  return (
    <div class="hide-picker" id={props.id}>
      <input
        ref={input}
        class="input"
        role="combobox"
        aria-label="Person or group to hide from agents"
        aria-expanded={results.length > 0}
        aria-controls={`${props.id}-list`}
        aria-activedescendant={results[active] ? `${props.id}-${active}` : undefined}
        placeholder="Search contacts and groups, or type a number or email"
        value={query}
        onInput={(e) => {
          setQuery(e.currentTarget.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            void pick(results[active]);
          } else if (e.key === "Escape") {
            // Closes only the picker, not Settings.
            e.preventDefault();
            e.stopPropagation();
            props.onClose();
          }
        }}
      />
      {results.length > 0 ? (
        <ul class="suggestions" role="listbox" id={`${props.id}-list`}>
          {results.map((c, i) => (
            <li key={c.id}>
              <button
                id={`${props.id}-${i}`}
                role="option"
                tabIndex={-1}
                aria-selected={i === active}
                class={i === active ? "active" : ""}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void pick(c)}
              >
                {c.thread ? (
                  <ThreadAvatar thread={c.thread} size={24} />
                ) : (
                  <Avatar
                    name={c.label}
                    photo={c.contact ? photoFor(c.contact.handles[0]) : undefined}
                    size={24}
                  />
                )}
                <span class="palette-label">{c.label}</span>
                {c.detail && <small class="muted">{c.detail}</small>}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p class="hidden-agents-empty">
          {query.trim()
            ? "No one matches. Type a whole number or email address to hide it."
            : "Everyone you've texted recently is already hidden from agents."}
        </p>
      )}
    </div>
  );
}

/** What link previews do, under their switch; the risks are in `LINK_PREVIEWS_CONFIRM`. */
export function LinkPreviewHint() {
  return <>Shows a page's title and image under links in your messages.</>;
}

/** Asked the first time link previews are turned on, from Settings or the command palette. */
const LINK_PREVIEWS_CONFIRM: ConfirmCopy = {
  title: "Turn on link previews?",
  body: [
    "To show a preview, this computer visits the link. That tells whoever runs the site your IP address and when the message first appeared on your screen.",
    "Once previews are on, they load on their own only in conversations with your contacts or people you've replied to. Anywhere else, you click Load preview to see one.",
  ],
  action: "Turn on previews",
};

/**
 * The agent policy and a way to change it that asks first when a change is risky: `request`
 * applies a patch, or opens `confirm` (render it) to ask about it.
 */
function useAgentPolicy() {
  const agents = settings.value?.agents;
  const effective = agents ? effectiveAgents(agents) : null;
  const [pending, setPending] = useState<{
    kind: AgentConfirm;
    patch: AgentSettingsPatch;
  } | null>(null);
  const request = (patch: AgentSettingsPatch) => {
    if (!agents) return;
    const kind = confirmFor(agents, patch);
    if (kind) setPending({ kind, patch });
    else void changeSettings({ agents: patch });
  };
  const confirm = pending && agents && (
    <ConfirmDialog
      copy={confirmCopy(pending.kind, agents, pending.patch)}
      onCancel={() => setPending(null)}
      onConfirm={() => {
        setPending(null);
        void changeSettings({ agents: pending.patch });
      }}
    />
  );
  return { agents, effective, access: effective?.access ?? "off", request, confirm };
}

/**
 * What AI agents may do: an access level, a line or two saying what it allows, and the settings
 * that level offers. In Settings and, narrower, in onboarding; the Danger switches are separate
 * (`AgentDanger`).
 */
export function AgentPermissions(props: { variant?: "welcome"; intro?: ComponentChildren }) {
  const { agents, effective, access, request, confirm } = useAgentPolicy();
  const welcome = props.variant === "welcome";
  const sections = sectionsFor(access);
  const id = useId();

  const levels = (
    <Segmented
      labelledBy={`${id}-access`}
      value={agents ? access : null}
      options={ACCESS_OPTIONS}
      disabled={!agents}
      class="agent-levels"
      onChange={(level) => agents && request(accessPatch(level, agents))}
    />
  );
  const summary = agents && (
    <p class="setting-hint agent-summary" aria-live="polite">
      {agentSummary(agents)}
    </p>
  );

  return (
    <>
      {welcome ? (
        <div class="setting agent-access stacked">
          <div>
            <p class="setting-label" id={`${id}-access`}>
              AI agents
            </p>
            {props.intro && <p class="setting-hint">{props.intro}</p>}
          </div>
          {levels}
          {summary}
        </div>
      ) : (
        <div class="setting agent-access">
          <div>
            <p class="setting-label" id={`${id}-access`}>
              Access
            </p>
            {props.intro && <p class="setting-hint">{props.intro}</p>}
            {summary}
          </div>
          {levels}
        </div>
      )}
      <Reveal open={!!effective && sections.read}>
        {effective && (
          <SelectSetting
            label="Reading"
            hint={readHint(effective)}
            value={effective.read}
            options={readOptions(access)}
            class="agent-setting"
            onChange={(read) => request({ read })}
          />
        )}
      </Reveal>
      <Reveal open={!!effective && sections.send}>
        {effective && (
          <>
            <SelectSetting
              label="Sending"
              hint={sendHint(effective)}
              value={effective.send}
              options={sendOptions(effective)}
              class="agent-setting"
              onChange={(send) => request({ send })}
            />
            <SelectSetting
              label="Agent message delay"
              hint={agentDelayHint(effective.sendDelaySeconds)}
              value={String(effective.sendDelaySeconds)}
              options={delayOptions(effective.sendDelaySeconds)}
              class="agent-setting"
              onChange={(value) => request({ sendDelaySeconds: Number(value) })}
            />
          </>
        )}
      </Reveal>
      <Reveal open={!!effective && sections.sendLimit}>
        {effective && (
          <SelectSetting
            label="Send limit"
            hint={sendLimitHint(effective.sendLimit)}
            value={sendLimitValue(effective.sendLimit)}
            options={sendLimitOptions(effective.sendLimit)}
            class="agent-setting"
            onChange={(value) => request({ sendLimit: parseSendLimitValue(value) })}
          />
        )}
      </Reveal>
      <Reveal open={!!effective && sections.inbox && effective.read !== "off"}>
        {effective && (
          <Toggle
            label="Manage conversations"
            hint="Agents can mark conversations as read, mute them and pin them."
            checked={effective.manage}
            class="agent-setting"
            onChange={(manage) => request({ manage })}
          />
        )}
      </Reveal>
      {confirm}
    </>
  );
}

/**
 * The privacy protections only Full access can turn off: in Settings a red-edged card of its
 * own at the foot of the AI agents section; in onboarding a red band under the permissions.
 */
export function AgentDanger(props: { variant?: "welcome" }) {
  const { effective, access, request, confirm } = useAgentPolicy();
  const id = useId();
  const open = !!effective && sectionsFor(access).danger;
  const toggles = effective && (
    <>
      <Toggle
        label="Show phone numbers & emails to agents"
        hint="Gives agents real phone numbers and email addresses. When off, they get opaque IDs instead, and can still look up contacts by name and reply."
        checked={effective.handles === "visible"}
        onChange={(show) => request({ handles: show ? "visible" : "hidden" })}
      />
      <Toggle
        label="Show verification codes to agents"
        hint="Shows agents short-code conversations and the one-time login codes in messages they read. When off, Tincan hides those conversations and redacts the codes."
        checked={!effective.hideCodes}
        onChange={(show) => request({ hideCodes: !show })}
      />
    </>
  );
  return (
    <>
      <Reveal open={open}>
        {props.variant === "welcome" ? (
          <div class="agent-danger" role="group" aria-labelledby={`${id}-danger`}>
            <div class="agent-danger-header">
              <p class="setting-label" id={`${id}-danger`}>
                <Icon name="alert" size={14} />
                Danger
              </p>
            </div>
            {toggles}
          </div>
        ) : (
          <Card title="Danger" icon="alert" class="danger">
            {toggles}
          </Card>
        )}
      </Reveal>
      {confirm}
    </>
  );
}

/**
 * Asks before a risky change, over whatever is open (Settings or onboarding). Cancel has focus,
 * so Enter or Escape leaves things as they were.
 */
function ConfirmDialog(props: {
  copy: ConfirmCopy;
  /** The confirm button: red for a risky change (the default), or the accent for a milder one. */
  tone?: "danger" | "primary";
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    return () => {
      if (back?.isConnected) back.focus();
    };
  }, []);
  const onKeyDown = (e: KeyboardEvent) => {
    // Escape closes only this, not the Settings dialog under it.
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onCancel();
    } else if (e.key === "Tab") {
      const buttons = [...(box.current?.querySelectorAll<HTMLElement>("button") ?? [])];
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  };
  return createPortal(
    <div
      class="backdrop confirm"
      onMouseDown={(e) => e.target === e.currentTarget && props.onCancel()}
      onKeyDown={onKeyDown}
    >
      <div
        ref={box}
        class="modal confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-body`}
      >
        <header class="modal-header">
          <h2 id={`${id}-title`}>{props.copy.title}</h2>
        </header>
        <div class="modal-body">
          <div id={`${id}-body`} class="confirm-body">
            {props.copy.body.map((line) => (
              <p key={line} class="setting-hint">
                {line}
              </p>
            ))}
          </div>
          <footer class="modal-footer end">
            <button ref={cancel} type="button" class="button" onClick={props.onCancel}>
              Cancel
            </button>
            <button
              type="button"
              class={`button ${props.tone === "primary" ? "primary" : "danger-fill"}`}
              onClick={props.onConfirm}
            >
              {props.copy.action}
            </button>
          </footer>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ConfirmDeleteMessagesDialog() {
  const [busy, setBusy] = useState(false);
  const count = picked.value?.size ?? 0;
  const noun = count === 1 ? "message" : "messages";
  return (
    <Modal title={`Delete ${count} ${noun}?`}>
      <p class="setting-hint dialog-hint">
        Delete {count === 1 ? "this message" : `these ${count} messages`} from Tincan? They stay on
        your iPhone, and Tincan won't bring them back when it syncs.
      </p>
      <footer class="modal-footer end">
        <button class="button" onClick={() => (dialog.value = null)}>
          Cancel
        </button>
        <button
          class="button danger-fill"
          disabled={busy || count === 0}
          onClick={async () => {
            setBusy(true);
            await deletePicked();
            setBusy(false);
          }}
        >
          {busy ? "Deleting…" : "Delete"}
        </button>
      </footer>
    </Modal>
  );
}

function MoveToGroupDialog() {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const count = picked.value?.size ?? 0;
  const groups = threads.value.filter((t) => t.kind === "group");
  const move = async (target: { key: string } | { name: string }) => {
    if (busy) return;
    setBusy(true);
    await movePickedToGroup(target);
    setBusy(false);
  };
  return (
    <Modal title={`Move ${count} message${count === 1 ? "" : "s"} to a group`}>
      <p class="setting-hint dialog-hint">
        Your iPhone doesn't say which group a text came from, so group texts arrive in the sender's
        conversation. Move them into the group to read them together.
      </p>
      {groups.length > 0 && (
        <ul class="group-choices">
          {groups.map((g) => (
            <li key={g.key}>
              <button disabled={busy} onClick={() => void move({ key: g.key })}>
                <ThreadAvatar thread={g} size={28} />
                <span>{g.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        class="new-group"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void move({ name });
        }}
      >
        <input
          class="input"
          placeholder="New group name, as it appears on your iPhone"
          value={name}
          maxLength={200}
          onInput={(e) => setName(e.currentTarget.value)}
        />
        <button class="button primary" type="submit" disabled={busy || !name.trim()}>
          {busy ? "Moving…" : "Create"}
        </button>
      </form>
    </Modal>
  );
}

interface PaletteItem {
  id: string;
  group: string;
  label: string;
  hint?: string;
  keywords?: string;
  icon?: IconName;
  /** Shown as a theme swatch instead of an icon, and previewed while highlighted. */
  theme?: Theme;
  checked?: boolean;
  /** Returning "theme" opens the theme list instead of closing the palette. */
  run: () => unknown;
}

function paletteItems(): PaletteItem[] {
  const items: PaletteItem[] = [];
  const thread = selectedThread.value;
  for (const t of threads.value) {
    items.push({
      id: `thread:${t.key}`,
      group: "Conversations",
      label: t.title,
      hint: t.kind === "group" ? "Group" : t.unread > 0 ? `${t.unread} unread` : undefined,
      run: () => void select(t.key),
    });
  }
  for (const p of pendingList.value) {
    const count = p.drafts.length + (p.own ? 1 : 0);
    items.push({
      id: `pending:${p.to}`,
      group: "Conversations",
      label: pendingThread(p).title,
      hint: count === 0 ? undefined : count === 1 ? "Draft" : `${count} drafts`,
      keywords: "new draft agent",
      run: () => void select(p.to),
    });
  }
  if (thread) {
    const here = "This Conversation";
    items.push(
      {
        id: "info",
        group: here,
        label: thread.kind === "group" ? "Group info" : "Contact info",
        hint: "Ctrl+Shift+B",
        icon: "info",
        keywords: "details members phone",
        run: () => void openInfo(thread.key),
      },
      {
        id: "pin",
        group: here,
        label: thread.pinned ? "Unpin" : "Pin",
        icon: "pin",
        run: () => void setFlag(thread.key, "pinned", !thread.pinned),
      },
      {
        id: "mute",
        group: here,
        label: thread.muted ? "Unmute notifications" : "Mute notifications",
        icon: thread.muted ? "bell" : "bellOff",
        run: () => void setFlag(thread.key, "muted", !thread.muted),
      },
    );
    const agents = threadHideAction(
      thread,
      contactsByHandle.value.get(thread.members[0] ?? thread.key),
      settings.value,
    );
    if (agents) {
      items.push({
        id: "agents",
        group: here,
        label: agents.label,
        icon: agents.icon,
        keywords: "ai agents privacy hide hidden show",
        run: () => {
          if (agents.kind === "hide") void hideFromAgents(agents.target);
          else if (agents.kind === "show") void showToAgents(agents.target);
          else void openInfo(thread.key);
        },
      });
    }
    items.push({
      id: "delete",
      group: here,
      label: "Delete conversation",
      icon: "trash",
      keywords: "remove spam",
      run: () => void deleteThread(thread.key),
    });
    if (thread.kind === "group") {
      items.push({
        id: "rename",
        group: here,
        label: "Rename group…",
        icon: "pencil",
        keywords: "name title",
        run: () => void startRename(thread.key),
      });
    }
    if (thread.kind !== "group") {
      items.push({
        id: "move",
        group: here,
        label: "Move messages to a group…",
        icon: "people",
        keywords: "pick group chat",
        run: () => {
          infoOpen.value = true;
          pickMode.value = "group";
          picked.value = new Set();
        },
      });
    }
    items.push({
      id: "deleteMessages",
      group: here,
      label: "Delete messages…",
      icon: "trash",
      keywords: "remove pick spam",
      run: () => {
        pickMode.value = "delete";
        picked.value = new Set();
      },
    });
    if (thread.unread > 0) {
      items.push({
        id: "read",
        group: here,
        label: "Mark as read",
        icon: "check",
        run: () => void markRead(thread.key),
      });
    }
  }
  const actions = "Actions";
  items.push(
    {
      id: "new",
      group: actions,
      label: "New message",
      hint: "Ctrl+N",
      icon: "compose",
      keywords: "compose write",
      run: startCompose,
    },
    {
      id: "search",
      group: actions,
      label: "Search messages",
      hint: "Ctrl+F",
      icon: "search",
      keywords: "find",
      run: focusSearch,
    },
    {
      id: "sidebar",
      group: actions,
      label: sidebarCollapsed.value ? "Show sidebar" : "Hide sidebar",
      hint: "Ctrl+B",
      icon: sidebarCollapsed.value ? "sidebar" : "sidebarFilled",
      keywords: "toggle collapse",
      run: toggleSidebar,
    },
    ...(agentDrafts.value.length > 0
      ? [
          {
            id: "drafts",
            group: actions,
            label: "Next conversation with agent drafts",
            hint: "Ctrl+Shift+D",
            icon: "pencil" as const,
            keywords: "draft agent review queue",
            run: openNextDrafts,
          },
        ]
      : []),
    {
      id: "sync",
      group: actions,
      label: "Check the phone for new messages",
      icon: "refresh",
      keywords: "sync refresh",
      run: () => void syncNow(),
    },
    {
      id: "contacts",
      group: actions,
      label: "Refresh contacts from the phone",
      icon: "syncContacts",
      keywords: "sync contacts names photos people pbap update",
      run: () => void syncContacts(),
    },
    {
      id: "settings",
      group: actions,
      label: "Settings",
      hint: "Ctrl+,",
      icon: "settings",
      keywords: "preferences options",
      run: () => openSettings(),
    },
    ...(agentsOn(settings.value)
      ? [
          {
            id: "agents:hidden",
            group: actions,
            label: "Hide a person or group from agents…",
            icon: "hide" as const,
            keywords: "ai agents privacy hidden show list",
            run: () => openSettings("agents"),
          },
        ]
      : []),
    {
      id: "welcome",
      group: actions,
      label: "Getting started with Tincan",
      icon: "info",
      keywords: "help about welcome onboarding setup what can't do",
      run: openWelcome,
    },
  );
  const device = status.value?.phone.device;
  items.push({
    id: "phone:pair",
    group: "iPhone",
    label: device ? "Pair another iPhone…" : "Pair iPhone…",
    icon: "bluetooth",
    keywords: "iphone phone pair bluetooth connect setup add",
    run: () => void startPairing(),
  });
  if (device) {
    const iphone = "iPhone";
    const away = device.paused || status.value?.phone.state !== "connected";
    items.push(
      away
        ? {
            id: "phone:connect",
            group: iphone,
            label: "Connect iPhone",
            icon: "bluetooth",
            keywords: "iphone phone reconnect bluetooth",
            run: () => void phoneAction("connect"),
          }
        : {
            id: "phone:disconnect",
            group: iphone,
            label: "Disconnect iPhone",
            icon: "power",
            keywords: "iphone phone bluetooth pause",
            run: () => void phoneAction("disconnect"),
          },
      {
        id: "phone:forget",
        group: iphone,
        label: "Forget iPhone…",
        icon: "trash",
        keywords: "iphone phone unpair remove bluetooth",
        run: () => (dialog.value = "forgetPhone"),
      },
      {
        id: "phone:fix",
        group: iphone,
        label: "Fix connection…",
        icon: "alert",
        keywords: "iphone phone messages troubleshoot not sharing blocked repair help",
        run: () => (dialog.value = "fixConnection"),
      },
      {
        id: "phone:info",
        group: iphone,
        label: "iPhone details",
        icon: "phone",
        keywords: "iphone phone device settings status bluetooth address",
        run: () => openSettings("iphone"),
      },
    );
  }
  const look = "Appearance";
  const current = themeInfo(theme.value)?.label ?? "System";
  items.push({
    id: "theme",
    group: look,
    label: "Change theme…",
    hint: current,
    icon: "palette",
    keywords: `appearance mode color colour dark light system ${NAMED_THEMES.map((t) => t.label).join(" ")}`,
    run: () => "theme",
  });
  items.push({
    id: "previews",
    group: look,
    label: linkPreviews.value ? "Turn off link previews" : "Turn on link previews",
    icon: "link",
    keywords: "url card privacy",
    run: () => requestLinkPreviews(!linkPreviews.value),
  });
  if (linkPreviews.value) {
    items.push({
      id: "link-cards-only",
      group: look,
      label: linkCardsOnly.value
        ? "Show link text above previews"
        : "Show only the preview for link messages",
      icon: "link",
      keywords: "url card hide raw link text",
      run: () => changeLinkCardsOnly(!linkCardsOnly.value),
    });
  }
  return items;
}

function themeItems(): PaletteItem[] {
  const modes: Array<[Theme, string]> = [
    ["system", "System"],
    ["light", "Light"],
    ["dark", "Dark"],
  ];
  return [
    ...modes.map(([id, label]) => ({ id, label, group: "Mode" })),
    ...NAMED_THEMES.map((t) => ({
      id: t.id,
      label: t.label,
      group: t.id.startsWith("contrast-")
        ? "High contrast"
        : t.scheme === "dark"
          ? "Dark themes"
          : "Light themes",
    })),
  ]
    .sort((a, b) => groupOrder(a.group) - groupOrder(b.group))
    .map(({ id, label, group }) => ({
      id: `theme:${id}`,
      group,
      label,
      theme: id,
      checked: theme.value === id,
      run: () => void changeTheme(id),
    }));
}

function groupOrder(group: string): number {
  return ["Mode", "Light themes", "Dark themes", "High contrast"].indexOf(group);
}

/** Matches when every word of the query is in the label or keywords. */
function filterItems(items: PaletteItem[], query: string): PaletteItem[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    let shown = 0;
    return items.filter((i) => i.group !== "Conversations" || shown++ < 6);
  }
  let conversations = 0;
  return items.filter((i) => {
    const text = `${i.label} ${i.keywords ?? ""}`.toLowerCase();
    if (!words.every((w) => text.includes(w))) return false;
    return i.group !== "Conversations" || conversations++ < 8;
  });
}

function Palette() {
  const [mode, setMode] = useState<"root" | "theme">("root");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const committed = useRef(false);
  // Scrolling the list under a still pointer fires mousemove too; only real moves pick an item.
  const pointer = useRef("");
  useEffect(() => ref.current?.focus(), [mode]);
  // Closing without choosing puts the saved theme back.
  useEffect(() => () => void (committed.current || previewTheme(null)), []);

  const items = useMemo(
    () => filterItems(mode === "theme" ? themeItems() : paletteItems(), query),
    [query, mode],
  );
  const current = items[active];
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, items]);
  useEffect(() => {
    if (mode === "theme" && current?.theme) previewTheme(current.theme);
  }, [mode, current?.id]);

  const openThemes = () => {
    setMode("theme");
    setQuery("");
    setActive(
      Math.max(
        0,
        themeItems().findIndex((i) => i.theme === theme.value),
      ),
    );
  };
  const back = () => {
    previewTheme(null);
    setMode("root");
    setQuery("");
    setActive(0);
  };
  const runItem = (item: PaletteItem | undefined) => {
    if (!item) return;
    if (item.run() === "theme") return openThemes();
    committed.current = true;
    dialog.value = null;
  };

  return (
    <div
      class="backdrop top"
      onMouseDown={(e) => e.target === e.currentTarget && (dialog.value = null)}
    >
      <div class="palette" role="dialog" aria-label="Command palette">
        <label class="palette-search">
          {mode === "theme" ? (
            <button
              class="icon-button palette-back"
              data-tip="Back (Esc)"
              aria-label="Back"
              onClick={back}
            >
              <Icon name="back" size={16} />
            </button>
          ) : (
            <Icon name="search" size={16} />
          )}
          <input
            ref={ref}
            class="palette-input"
            placeholder={
              mode === "theme" ? "Pick a theme…" : "Go to a conversation or run a command"
            }
            value={query}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, items.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                runItem(current);
              } else if (
                mode === "theme" &&
                (e.key === "Escape" || (e.key === "Backspace" && !query))
              ) {
                e.preventDefault();
                e.stopPropagation();
                back();
              }
            }}
          />
        </label>
        <ul class="palette-list" ref={list} role="listbox">
          {items.map((item, i) => (
            <li key={item.id}>
              {item.group !== items[i - 1]?.group && <p class="palette-group">{item.group}</p>}
              <button
                data-index={i}
                role="option"
                aria-selected={i === active}
                class={i === active ? "active" : ""}
                onMouseMove={(e) => {
                  const at = `${e.screenX},${e.screenY}`;
                  if (at === pointer.current) return;
                  pointer.current = at;
                  if (i !== active) setActive(i);
                }}
                onClick={() => runItem(item)}
              >
                {item.group === "Conversations" ? (
                  <PaletteThreadAvatar id={item.id} />
                ) : (
                  <span class="palette-icon">
                    {item.theme ? (
                      <ThemeChip theme={item.theme} size={16} />
                    ) : (
                      item.icon && <Icon name={item.icon} size={16} />
                    )}
                  </span>
                )}
                <span class="palette-label">{item.label}</span>
                {item.checked && <Icon name="check" size={15} />}
                {item.hint && <small>{item.hint}</small>}
              </button>
            </li>
          ))}
          {items.length === 0 && <li class="muted pad">Nothing matches.</li>}
        </ul>
      </div>
    </div>
  );
}

function PaletteThreadAvatar({ id }: { id: string }) {
  const pending = pendingList.value.find((p) => `pending:${p.to}` === id);
  const thread =
    threads.value.find((t) => `thread:${t.key}` === id) ?? (pending && pendingThread(pending));
  return thread ? <ThreadAvatar thread={thread} size={22} /> : <span class="palette-icon" />;
}
