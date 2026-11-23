import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nodeSqliteDb, Store, type Db, type SystemFacts } from "@beyland/tincan-core";
import { TincanError } from "@beyland/tincan-protocol";
import type { LoadedNative } from "./native.ts";

/** The database file under the data directory. */
export const STORE_FILE = "tincan.db";

export interface OpenedStore {
  store: Store;
  /** Where the database key lives, for `doctor`. */
  keyStorage: NonNullable<SystemFacts["keyStorage"]>;
  close(): void;
}

interface VaultHandle extends Db {
  readonly keyStorage: "keyring" | "file" | "memory";
  close(): void;
}

interface VaultClass {
  open(file: string): Promise<VaultHandle>;
  openInMemory(): VaultHandle;
}

function vaultClass(native: LoadedNative | null | undefined): VaultClass | null {
  const vault = native?.module?.Vault;
  return typeof vault === "function" ? (vault as unknown as VaultClass) : null;
}

function wrap(vault: VaultHandle): OpenedStore {
  try {
    return { store: Store.open(vault), keyStorage: vault.keyStorage, close: () => vault.close() };
  } catch (error) {
    vault.close();
    throw error;
  }
}

/**
 * Opens the encrypted store at `<dataDir>/tincan.db`, creating the directory (0700) if needed. The key
 * comes from the Secret Service, which may show an unlock prompt.
 */
export async function openVaultStore(native: LoadedNative, dataDir: string): Promise<OpenedStore> {
  const Vault = vaultClass(native);
  if (!Vault) {
    throw new TincanError(
      "INTERNAL",
      "The encrypted store needs the native addon (run `pnpm build:native`)",
    );
  }
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  return wrap(await Vault.open(path.join(dataDir, STORE_FILE)));
}

/** A store that lasts as long as the process (the fake phone, tests): encrypted when the addon loads. */
export function openMemoryStore(native?: LoadedNative | null): OpenedStore {
  const Vault = vaultClass(native);
  if (Vault) return wrap(Vault.openInMemory());
  const db = new DatabaseSync(":memory:");
  try {
    return { store: Store.open(nodeSqliteDb(db)), keyStorage: "memory", close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}
