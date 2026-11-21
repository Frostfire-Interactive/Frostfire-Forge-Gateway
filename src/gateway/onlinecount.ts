/** A heartbeat's `hiddenConnections`: a whole number of players, 0 when missing (an older game server) or odd. */
export function hiddenOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** The player count the realm list shows for a game server. */
export function shownConnections(server: { activeConnections: number; hiddenConnections?: number }): number {
  return Math.max(0, (server.activeConnections || 0) - (server.hiddenConnections || 0));
}
