// What a node taking the player over (a resumed handoff) sends again that the client already shows. The world's clock
// and weather are one world: a packet from the new node that says the same, or says less, must not move the sky.

/** The shift from UTC, in ms, the day/night clock uses: the one held, unless the packet brings a (new) one. */
export function nextPlaceOffset(held: number | null, utcOffset: unknown, keepHeld: boolean): number | null {
  if (typeof utcOffset === "number" && Number.isFinite(utcOffset)) return utcOffset * 1000;
  // A node that has not read its weather yet sends no offset; the client would fall back to the browser's own clock
  // and light the map for another hour of the day until the next reading.
  return keepHeld ? held : null;
}

/** A stable key of a WEATHER packet's content: equal keys are the same weather with the same values. */
export function weatherKey(data: any): string {
  try {
    return JSON.stringify([data?.weather ?? null, data?.weatherData ?? null]);
  } catch {
    return "";
  }
}

/** Whether a WEATHER packet may be skipped: right after a handoff, with the same content as what is applied. */
export function skipSameWeather(applied: string | null, data: any, inHandoff: boolean): boolean {
  if (!inHandoff || applied === null) return false;
  const key = weatherKey(data);
  return key !== "" && key === applied;
}

/** How long after HANDOFF_DONE the new node's first packets are taken as repeats of what the client shows. */
export const HANDOFF_WINDOW_MS = 3000;

/** Whether a resumed handoff is under way (`resuming`) or finished within the window (`doneStamp`, null: none). */
export function inHandoffWindow(resuming: boolean, doneStamp: number | null, now: number): boolean {
  return resuming || (doneStamp !== null && now - doneStamp >= 0 && now - doneStamp < HANDOFF_WINDOW_MS);
}
