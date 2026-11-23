export { nodeSqliteDb, type Db, type Row, type SqlParam, type SqlValue } from "./db.ts";
export {
  HybridClock,
  compareHlc,
  formatHlc,
  lastWriterWins,
  parseHlc,
  type HlcParts,
} from "./hlc.ts";
export {
  phoneContactId,
  phoneMessageId,
  uuidv7,
  type PhoneContactIdentity,
  type PhoneMessageIdentity,
} from "./ids.ts";
export {
  MIGRATIONS,
  migrate,
  schemaVersion,
  type Migration,
  type MigrationResult,
} from "./migrations.ts";
export {
  Store,
  type AgentScopeFilter,
  contentHash,
  type ContactInput,
  type ContactListOptions,
  type ContactsReplaced,
  type HiddenChange,
  CONNECTION_LOG_LIMIT,
  ftsQuery,
  type Gap,
  type InsertResult,
  type MapHandleState,
  type MessageListOptions,
  type NewMessage,
  type OutboxEntry,
  type ReactionKind,
  type ReadChange,
  type SearchOptions,
  type SyncState,
  type ThreadListOptions,
} from "./store.ts";
