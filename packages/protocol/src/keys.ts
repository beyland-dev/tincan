import type { ThreadKey } from "./entities.ts";

/** Collapse case and whitespace so a display name is a stable key part (`Book Club` → `book-club`). */
export function slugify(name: string): string {
  return name.normalize("NFC").trim().toLowerCase().split(/\s+/).filter(Boolean).join("-");
}

/** The key of a named group (`group:name:<slug>`), or null for an empty name. */
export function groupNameKey(name: string): ThreadKey | null {
  const slug = slugify(name);
  return slug ? `group:name:${slug}` : null;
}
