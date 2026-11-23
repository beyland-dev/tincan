import { readFile } from "node:fs/promises";
import { ErrorCode, TincanError } from "@beyland/tincan-protocol";
import { z } from "zod";
import { FakePhone, type FakePhoneOptions } from "./phone.ts";

const Message = z.strictObject({
  from: z.string().min(1),
  name: z.string().optional(),
  body: z.string(),
  /** How long before the scenario starts it arrived (seeded messages). */
  minutesAgo: z.number().nonnegative().optional(),
  read: z.boolean().optional(),
});

const Incoming = z.strictObject({
  from: z.string().min(1),
  name: z.string().optional(),
  body: z.string(),
  /** ANCS subtitle: a group name, or "To you & …" for an unnamed group. */
  group: z.string().optional(),
  notify: z.boolean().optional(),
});

const Notification = z.strictObject({
  appId: z.string().optional(),
  appName: z.string().optional(),
  title: z.string(),
  subtitle: z.string().optional(),
  body: z.string().optional(),
  category: z
    .enum([
      "other",
      "incomingCall",
      "missedCall",
      "voicemail",
      "social",
      "schedule",
      "email",
      "news",
      "healthAndFitness",
      "businessAndFinance",
      "location",
      "entertainment",
    ])
    .optional(),
  hasPositiveAction: z.boolean().optional(),
  hasNegativeAction: z.boolean().optional(),
});

const delay = { afterMs: z.number().nonnegative().optional() };

const Step = z.union([
  z.strictObject({ ...delay, receive: Incoming }),
  z.strictObject({ ...delay, notify: Notification }),
  z.strictObject({ ...delay, disconnect: z.literal(true) }),
  z.strictObject({ ...delay, reconnect: z.literal(true) }),
  /** Turn "Show Message Notifications" on or off on the phone. */
  z.strictObject({ ...delay, shareMessages: z.boolean() }),
  /** Change this computer's Class of Device (0x7c010c is a laptop, 0x7c0408 hands-free). */
  z.strictObject({ ...delay, adapterClass: z.number().int().nonnegative() }),
  z.strictObject({
    ...delay,
    failNextPush: z.union([ErrorCode, z.enum(["unconfirmed", "pending"])]),
  }),
  /** Mark the newest message from this address read on the phone. */
  z.strictObject({ ...delay, readOnPhone: z.string().min(1) }),
]);

export const Scenario = z.strictObject({
  $schema: z.string().optional(),
  description: z.string().optional(),
  phone: z
    .strictObject({
      name: z.string().optional(),
      address: z.string().optional(),
      ownNumber: z.string().optional(),
      ownerName: z.string().optional(),
      reachable: z.boolean().optional(),
      /** False to start unpaired, so the scenario can show pairing (default true). */
      paired: z.boolean().optional(),
      shareNotifications: z.boolean().optional(),
      /** False: the iPhone doesn't offer messages, so MAP opens fail with NOT_FOUND. */
      shareMessages: z.boolean().optional(),
      /** This computer's Class of Device (default 0x7c0408, hands-free). */
      adapterClass: z.number().int().nonnegative().optional(),
      echoDelayMs: z.number().nonnegative().optional(),
    })
    .default({}),
  contacts: z
    .array(
      z.strictObject({
        name: z.string(),
        tels: z.array(z.string()).optional(),
        emails: z.array(z.string()).optional(),
        favorite: z.boolean().optional(),
        photo: z.strictObject({ mediaType: z.string(), data: z.string() }).optional(),
      }),
    )
    .default([]),
  /** Messages already on the phone, oldest first. */
  inbox: z.array(Message).default([]),
  /** Notifications already in the phone's Notification Center. */
  notifications: z.array(Notification).default([]),
  /** Steps played in order once the scenario starts. */
  script: z.array(Step).default([]),
});
export type Scenario = z.infer<typeof Scenario>;
export type ScenarioStep = z.infer<typeof Step>;

/** Read and validate a scenario file. Throws `TincanError` `INVALID_INPUT` on a bad file. */
export async function loadScenario(path: string): Promise<Scenario> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? "NOT_FOUND" : "INVALID_INPUT";
    throw new TincanError(code, `Can't read scenario ${path}: ${(error as Error).message}`);
  }
  return parseScenario(json);
}

export function parseScenario(json: unknown): Scenario {
  const parsed = Scenario.safeParse(json);
  if (!parsed.success) {
    throw new TincanError("INVALID_INPUT", `Invalid scenario: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** A phone in the scenario's starting state: contacts, inbox and notifications in place. */
export function phoneFromScenario(
  scenario: Scenario,
  options: Omit<FakePhoneOptions, keyof Scenario["phone"]> = {},
): FakePhone {
  const phone = new FakePhone({ ...options, ...scenario.phone });
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  phone.setContacts(scenario.contacts);
  const start = now();
  const count = scenario.inbox.length;
  phone.seed(
    scenario.inbox.map(({ minutesAgo, ...message }, index) => ({
      ...message,
      // Without `minutesAgo`, space the seeded messages a minute apart, the last one a minute ago.
      timestamp: start - Math.round((minutesAgo ?? count - index) * 60),
    })),
  );
  for (const notification of scenario.notifications) phone.notify(notification);
  return phone;
}

export interface Playback {
  /** Resolves when every step has run (or `stop` was called). */
  done: Promise<void>;
  stop(): void;
}

/** Run the scenario's script against `phone`, waiting `afterMs` (divided by `speed`) before each step. */
export function playScenario(
  phone: FakePhone,
  scenario: Scenario,
  options: { speed?: number } = {},
): Playback {
  const speed = options.speed ?? 1;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let wake: (() => void) | undefined;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, ms / speed);
    });
  const done = (async () => {
    for (const step of scenario.script) {
      if (step.afterMs) await sleep(step.afterMs);
      if (stopped) return;
      runStep(phone, step);
    }
  })();
  return {
    done,
    stop() {
      stopped = true;
      clearTimeout(timer);
      wake?.();
    },
  };
}

export function runStep(phone: FakePhone, step: ScenarioStep): void {
  if ("receive" in step) {
    const { group, notify, ...message } = step.receive;
    phone.receive({
      ...message,
      notification: notify === false ? false : group ? { subtitle: group } : undefined,
    });
  } else if ("notify" in step) {
    phone.notify(step.notify);
  } else if ("disconnect" in step) {
    phone.disconnect();
  } else if ("reconnect" in step) {
    phone.reconnect();
  } else if ("shareMessages" in step) {
    phone.setShareMessages(step.shareMessages);
  } else if ("adapterClass" in step) {
    phone.setAdapterClass(step.adapterClass);
  } else if ("failNextPush" in step) {
    phone.failNextPush(step.failNextPush);
  } else {
    const from = step.readOnPhone;
    const message = phone.messages.findLast((m) => m.from === from);
    if (message) phone.setReadOnPhone(message.handle);
  }
}
