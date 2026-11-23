import type { Kind } from "./tooleditor.js";

// The Dungeon Tool (/de, /dungeoneditor, /poe, /portaleditor): one window with a tab for each kind of record it edits.
// No DOM here, so the tests can read the tabs and the routing.

export type ToolKind = "dungeons" | "portals" | "stones";

/** The tabs, in the order the window lists them. */
export const TOOL_KINDS: Kind[] = [
  { id: "dungeons", label: "Dungeons", noun: "dungeon", icon: "layers" },
  { id: "portals", label: "Portals", noun: "portal", icon: "portal" },
  { id: "stones", label: "Summoning stones", noun: "summoning stone", plural: "summoning stones", icon: "pin" },
];

/** The part a packet of the tool belongs to, by its prefix. Null for any other packet: the game window sends no other. */
export function packetKind(type: string): ToolKind | null {
  if (typeof type !== "string") return null;
  if (type.startsWith("DUNGEON_EDITOR_")) return "dungeons";
  if (type.startsWith("PORTAL_EDITOR_")) return "portals";
  if (type.startsWith("SUMMON_STONE_EDITOR_")) return "stones";
  return null;
}

/** What a part is told by the window it lives in. */
export interface ToolHost {
  /** The tab in view. A part draws on the shared shell only while it is this one. */
  readonly kind: string;
  /** The part's number of records changed. */
  counted(): void;
  /** The part's save was answered: ok when the server confirmed it. A tab left with "Save" moves on after an ok one. */
  settled(kind: string, ok: boolean): void;
}

/** One tab of the tool: its records, its form, and its conversation with the server. */
export interface ToolPart {
  kind: string;
  /** Its tab is now in view: it draws the list and the page. */
  activate(): void;
  search(q: string): void;
  create(): void;
  save(): void;
  duplicate?(): void;
  remove(): void;
  onMessage(msg: { kind: "data" | "result" | "updated"; data: any }): void;
  /** How many records it lists (0 until its list came). */
  count(): number;
  /** The name of what is open with changes not saved, or null. Asked before leaving the tab. */
  unsaved(): string | null;
  /** A save or delete is waiting for the server. */
  busy(): boolean;
  /** Throws away what is open, changes and all ("Discard" on the way to another tab). */
  discard(): void;
  /** Asks the server for its list again. */
  ask(): void;
}
