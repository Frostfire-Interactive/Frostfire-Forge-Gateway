/** The wait before the first attempt. */
export const RECONNECT_FIRST_DELAY_MS = 2000;
/** The longest wait between two attempts. */
export const RECONNECT_MAX_DELAY_MS = 15000;
/** How long after the loss the client keeps trying. */
export const RECONNECT_WINDOW_MS = 10 * 60 * 1000;

/** The wait before attempt `attempt` (1 for the first): doubled after each failure, up to the cap. */
export function reconnectDelay(attempt: number): number {
  const doublings = Math.max(0, Math.min(attempt - 1, 16));
  return Math.min(RECONNECT_FIRST_DELAY_MS * 2 ** doublings, RECONNECT_MAX_DELAY_MS);
}

/** Whether another attempt is made: the connection was lost at `lostAt`, and it is `now`. */
export function keepReconnecting(lostAt: number, now: number): boolean {
  return now - lostAt < RECONNECT_WINDOW_MS;
}
