import type { IconName } from "./toolicons.js";

/** A tool the staff bar can open: what it is called, its icon, and the chat command that opens it today. */
export interface StaffTool {
  /** As the server names it in STAFF_TOOLS (the engine's systems/stafftools.ts). */
  id: string;
  name: string;
  icon: IconName;
  /** What is typed in the chat to open it. The player editor's names a player: see commandFor. */
  command: string;
  /** Tools of one group stand together on the bar, with a line between groups. */
  group: "admin" | "world" | "content" | "effects";
}

/** Every tool, in the order the bar shows them. */
export const STAFF_TOOLS: readonly StaffTool[] = [
  { id: "control_panel", name: "Control Panel", icon: "dashboard", command: "/cp", group: "admin" },
  { id: "player_editor", name: "Player Editor", icon: "user", command: "/player edit", group: "admin" },
  { id: "game_settings", name: "Game Settings", icon: "gauge", command: "/gs", group: "admin" },
  { id: "tile_editor", name: "Map Editor", icon: "map", command: "/te", group: "world" },
  { id: "dungeon_editor", name: "Dungeon Tool", icon: "layers", command: "/de", group: "world" },
  { id: "weather_editor", name: "Weather Editor", icon: "cloud", command: "/we", group: "world" },
  { id: "gathering_editor", name: "Gathering Editor", icon: "pin", command: "/gathering", group: "world" },
  { id: "mailbox_editor", name: "Mailbox Editor", icon: "send", command: "/mailbox", group: "world" },
  { id: "npc_editor", name: "NPC Editor", icon: "megaphone", command: "/ne", group: "content" },
  { id: "creature_editor", name: "Creature Editor", icon: "target", command: "/ce", group: "content" },
  { id: "item_editor", name: "Item Editor", icon: "box", command: "/ie", group: "content" },
  { id: "loot_editor", name: "Loot Editor", icon: "bag", command: "/le", group: "content" },
  { id: "spell_editor", name: "Spell Editor", icon: "wand", command: "/se", group: "content" },
  { id: "class_editor", name: "Class Editor", icon: "sword", command: "/cle", group: "content" },
  { id: "mount_editor", name: "Mount Editor", icon: "paw", command: "/me", group: "content" },
  { id: "quest_editor", name: "Quest Editor", icon: "scroll", command: "/qe", group: "content" },
  { id: "achievement_editor", name: "Achievement Editor", icon: "sparkle", command: "/achievements", group: "content" },
  { id: "particle_editor", name: "Particle Editor", icon: "flame", command: "/pe", group: "effects" },
  { id: "cutscene_editor", name: "Cutscene Editor", icon: "play", command: "/cse", group: "effects" },
];

/**
 * The tools the bar shows for the ids the server sent, in the bar's order and grouped.
 * Ids it does not know are left out, as is anything that is not a list of ids. No groups: no bar.
 */
export function staffToolGroups(ids: unknown): StaffTool[][] {
  const allowed = new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
  const groups: StaffTool[][] = [];
  for (const tool of STAFF_TOOLS) {
    if (!allowed.has(tool.id)) continue;
    const last = groups[groups.length - 1];
    if (last && last[0].group === tool.group) last.push(tool);
    else groups.push([tool]);
  }
  return groups;
}

/** The chat command a button sends. The player editor opens on a player: on yourself, from where you can search for another. */
export function commandFor(tool: StaffTool, username: string | null | undefined): string {
  const name = String(username ?? "").trim();
  return tool.id === "player_editor" && name ? `${tool.command} ${name}` : tool.command;
}
