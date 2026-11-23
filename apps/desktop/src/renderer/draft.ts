/**
 * What the composer should show when the saved draft changes (saved from another window or
 * the CLI while the conversation is open, say), or null to keep the user's text. The new draft goes in only when
 * the composer is empty or unchanged since it last took the saved draft, so text the user is
 * typing is never replaced.
 */
export function takeDraft(current: string, loaded: string | null, incoming: string): string | null {
  return current === "" || current === loaded || current === incoming ? incoming : null;
}
