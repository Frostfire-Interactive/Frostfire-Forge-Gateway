// Request limits for the website's sign-in routes (webserver/server.ts). Each limit counts the requests
// of one key (a client address, or an address and a username) in a moving window. The counts live in
// this process only: a restart of the Gateway starts them again from nothing.

const SWEEP_MS = 60_000;
const limits = new Set<RateLimit>();

export class RateLimit {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly max: number, private readonly windowMs: number) {
    limits.add(this);
  }

  /** Seconds until `key` may go again, or 0 when it may now. Counts nothing. */
  wait(key: string, now = Date.now()): number {
    const times = this.recent(key, now);
    if (times.length < this.max) return 0;
    return Math.max(1, Math.ceil((times[0] + this.windowMs - now) / 1000));
  }

  /** Counts one for `key`. */
  add(key: string, now = Date.now()): void {
    const times = this.recent(key, now);
    times.push(now);
    // Only the newest `max` can change an answer.
    if (times.length > this.max) times.splice(0, times.length - this.max);
    this.hits.set(key, times);
  }

  /** Counts one when `key` is under the limit. Answers as `wait` does: 0 when it was counted. */
  take(key: string, now = Date.now()): number {
    const seconds = this.wait(key, now);
    if (seconds === 0) this.add(key, now);
    return seconds;
  }

  clear(key: string): void {
    this.hits.delete(key);
  }

  /** Forgets every key with nothing left in the window. */
  sweep(now = Date.now()): void {
    for (const [key, times] of this.hits) {
      if (times.length === 0 || times[times.length - 1] <= now - this.windowMs) this.hits.delete(key);
    }
  }

  /** The times of `key` still inside the window, oldest first. */
  private recent(key: string, now: number): number[] {
    const times = this.hits.get(key);
    if (!times) return [];
    const from = now - this.windowMs;
    let gone = 0;
    while (gone < times.length && times[gone] <= from) gone++;
    if (gone > 0) times.splice(0, gone);
    if (times.length === 0) this.hits.delete(key);
    return times;
  }
}

// Keys come from outside, so the tables are swept and cannot grow for ever.
setInterval(() => {
  const now = Date.now();
  for (const limit of limits) limit.sweep(now);
}, SWEEP_MS).unref();

/** The answer over a limit: 429, the wait in Retry-After, and a { message } like the routes' other errors. */
export function tooMany(seconds: number, message = "Too many attempts"): Response {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return new Response(JSON.stringify({ message: `${message}. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` }), {
    status: 429,
    headers: { "Retry-After": String(seconds) },
  });
}
