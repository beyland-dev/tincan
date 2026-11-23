import { z } from "zod";
import { defineContract } from "../contract.ts";
import { Timestamp } from "../entities.ts";

export const SyncStatus = z.object({
  messages: z.object({
    /** The MAP link: `off` until a phone is set up. */
    state: z.enum(["off", "connecting", "connected", "waiting", "paused", "stopped"]),
    syncing: z.boolean(),
    lastSyncAt: Timestamp.nullable(),
  }),
  contacts: z.object({
    state: z.enum(["off", "on"]),
    lastSyncAt: Timestamp.nullable(),
  }),
  notifications: z.object({
    /** The phone's notification subscription (ANCS). */
    state: z.enum(["off", "unavailable", "waiting", "ready", "closed"]),
    detail: z.string().optional(),
  }),
});
export type SyncStatus = z.infer<typeof SyncStatus>;

export const status = defineContract({
  name: "sync.status",
  title: "Sync status",
  description: "Whether messages, contacts and notifications are syncing with the phone.",
  kind: "query",
  input: z.object({}),
  output: SyncStatus,
});

export const now = defineContract({
  name: "sync.now",
  title: "Sync now",
  description: "Check the phone for new messages now, and optionally re-read its contacts.",
  kind: "mutation",
  input: z.object({
    contacts: z.boolean().optional().describe("Also sync contacts, even if unchanged"),
  }),
  output: z.object({
    /** False when the phone isn't connected; it syncs when it connects. */
    synced: z.boolean(),
    added: z.number().int().nonnegative(),
    contacts: z
      .object({
        skipped: z.boolean(),
        contacts: z.number().int().nonnegative(),
        changed: z.number().int().nonnegative(),
        removed: z.number().int().nonnegative(),
      })
      .nullable(),
  }),
});
