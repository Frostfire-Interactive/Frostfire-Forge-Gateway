/** Pure rules of the game settings editor, kept apart from the page so they can be tested alone. */

/**
 * Formula previews, one request in flight per key. The server's answer carries the key and the text it was asked
 * for, so an answer is matched on both: one for a text that is not the one in flight is ignored, and one for a text
 * that is no longer the latest is dropped and the latest is sent. A request never answered is given up after
 * `timeoutMs`.
 */
export class PreviewTracker {
  private flying: Record<string, { text: string; at: number }> = {};
  private wanted: Record<string, string> = {};

  constructor(private timeoutMs = 5000) {}

  /** The text now wanted for `key`. Returns the text to send now, or null when nothing should be sent. */
  want(key: string, text: string, now = Date.now()): string | null {
    this.wanted[key] = text;
    const f = this.flying[key];
    if (f && now - f.at < this.timeoutMs) return null;
    this.flying[key] = { text, at: now };
    return text;
  }

  /** True when the same text is already being asked for. */
  asking(key: string, text: string, now = Date.now()): boolean {
    const f = this.flying[key];
    return !!f && f.text === text && now - f.at < this.timeoutMs;
  }

  /**
   * An answer for `key` and the text `value` it was computed for arrived. `apply` is true when it is for the latest
   * text; `next` is a text to send. An answer for any other text than the one in flight changes nothing.
   */
  answer(key: string, value: string, now = Date.now()): { apply: boolean; next: string | null } {
    const f = this.flying[key];
    if (!f || String(value ?? "").trim() !== f.text.trim()) return { apply: false, next: null };
    delete this.flying[key];
    if (this.wanted[key] === f.text) return { apply: true, next: null };
    const next = this.wanted[key] ?? null;
    if (next !== null) this.flying[key] = { text: next, at: now };
    return { apply: false, next };
  }

  /** Forget everything asked (the page is rebuilt from new values). */
  reset(): void {
    this.flying = {};
    this.wanted = {};
  }
}

/**
 * Whether a reload can be shown by changing values in place. `patch` are the settings whose values to put in;
 * `refresh` are those with unsaved edits, which keep their text but still get a new meta line and preview.
 */
export function patchPlan(
  before: Array<{ key: string; section: string }>,
  after: Array<{ key: string; section: string }>,
  keep: Set<string>,
): { rebuild: boolean; patch: string[]; refresh: string[] } {
  if (before.length !== after.length || before.some((s, i) => s.key !== after[i].key || s.section !== after[i].section)) {
    return { rebuild: true, patch: [], refresh: [] };
  }
  const keys = after.map((s) => s.key);
  return { rebuild: false, patch: keys.filter((k) => !keep.has(k)), refresh: keys.filter((k) => keep.has(k)) };
}

/**
 * What an input shows after the server's value is put in. A patched field has no unsaved edits, so it always takes
 * the server's text, including the focused one; its caret and selection stay where they were, within the new text.
 */
export function patchedInput(
  server: string,
  input: { value: string; start: number | null; end: number | null; focused: boolean },
): { value: string; start: number | null; end: number | null } {
  if (!input.focused || input.start === null || input.end === null) return { value: server, start: null, end: null };
  const clamp = (n: number): number => Math.min(Math.max(n, 0), server.length);
  return { value: server, start: clamp(input.start), end: clamp(input.end) };
}

/** The note under a field about a saved row the server did not use, or null. */
export function metaNote(s: { refused?: string }): string | null {
  return typeof s.refused === "string" && s.refused ? `Saved value not used: ${s.refused}` : null;
}
