// When the game client tries again after losing its connection (socket.ts attemptReconnect).
//
// A server restart or a deploy takes minutes: the server has to come back, register with the gateway again and load
// its maps, and until its heartbeat runs out the gateway still lists the old one as online. So the client keeps trying
// for RECONNECT_WINDOW_MS after the loss, waiting a little longer after each failed attempt, instead of giving up
// after a fixed number of quick tries.

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
