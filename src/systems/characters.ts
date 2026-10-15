import query, { GuardError, transaction, type TransactionStatement } from "../controllers/sqldatabase";
import log from "../modules/logger";

/**
 * USER REQUEST 2026-10-14 ("a character selection screen after realm selection if a character has not been created.
 * One character per account (same username)"): the character page (/character) and its API.
 *
 * An account's character is its class, `accounts.class_id` (the engine's systems/classes.ts makes the column and the
 * classes table, and the class editor fills the table). While it is NULL and there is a class to choose, the account
 * has no character: realm selection sends the player here before the game, and the game server refuses the login
 * (CHARACTER_REQUIRED) until one is made. With no class defined, every account plays as before.
 *
 * Making the character starts the account over (USER DECISION 2026-10-14, for the accounts made before characters
 * existed): level 1 with the class's base stats, no items, equipment, bags, spells, quests, gold or home, at the
 * world's starting point. What is not the character stays: the account, its friends, ignores, permissions, mounts
 * and sound settings. The game server reads the rows again at the next login and teaches the class's level 1 spells
 * then. Nothing is written while the account is in the game: the server holds its own copy of a player in play.
 */

/** A class as the character page shows it. */
export interface CharacterClassView {
  id: number;
  name: string;
  description: string;
  stats: { max_health: number; max_stamina: number; stat_damage: number; stat_armor: number; stat_critical_chance: number; stat_critical_damage: number; stat_avoidance: number };
  spells: { spell: string; level: number }[];
}

function parseSpells(raw: unknown): { spell: string; level: number }[] {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((e) => e && typeof e.spell === "string" && e.spell && Number.isFinite(Number(e.level)))
    .map((e) => ({ spell: String(e.spell), level: Math.max(1, Math.floor(Number(e.level))) }))
    .sort((a, b) => a.level - b.level || a.spell.localeCompare(b.spell));
}

function toView(row: any): CharacterClassView {
  const n = (v: unknown) => Number(v) || 0;
  return {
    id: Number(row.id),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    stats: {
      max_health: n(row.max_health), max_stamina: n(row.max_stamina), stat_damage: n(row.stat_damage), stat_armor: n(row.stat_armor),
      stat_critical_chance: n(row.stat_critical_chance), stat_critical_damage: n(row.stat_critical_damage), stat_avoidance: n(row.stat_avoidance),
    },
    spells: parseSpells(row.spells),
  };
}

/** Every class, by name. None when the table is not there (a game server that has not started since characters came). */
async function classList(): Promise<CharacterClassView[]> {
  try {
    const rows = (await query("SELECT * FROM classes ORDER BY name")) as any[];
    return (rows || []).map(toView);
  } catch {
    return [];
  }
}

export interface CharacterStatus {
  /** The account must make its character before it plays. */
  needed: boolean;
  /** Making it starts over a character that has come some way (a level, items or spells). */
  startsOver: boolean;
  /** The character's name: the account's. */
  username: string;
  classes: CharacterClassView[];
  /** What the classes' spells are, by name: their description and icon (a sprite name of the asset server). */
  spellInfo: Record<string, { description: string; icon: string | null }>;
}

const characters = {
  async status(username: string): Promise<CharacterStatus> {
    const none: CharacterStatus = { needed: false, startsOver: false, username, classes: [], spellInfo: {} };
    let account: any;
    try {
      account = ((await query("SELECT class_id FROM accounts WHERE username = ?", [username])) as any[])?.[0];
    } catch {
      return none; // no class_id column yet: characters are off
    }
    if (!account || (account.class_id !== null && account.class_id !== undefined)) return none;
    const classes = await classList();
    if (classes.length === 0) return none;
    const [stats, items, spells, spellRows] = await Promise.all([
      query("SELECT level, xp FROM stats WHERE username = ?", [username]).catch(() => []) as Promise<any[]>,
      query("SELECT COUNT(*) AS count FROM inventory WHERE username = ?", [username]).catch(() => []) as Promise<any[]>,
      query("SELECT COUNT(*) AS count FROM learned_spells WHERE username = ?", [username]).catch(() => []) as Promise<any[]>,
      query("SELECT name, description, icon FROM spells").catch(() => []) as Promise<any[]>,
    ]);
    const startsOver = Number(stats?.[0]?.level) > 1 || Number(stats?.[0]?.xp) > 0 || Number(items?.[0]?.count) > 0 || Number(spells?.[0]?.count) > 0;
    const named = new Set(classes.flatMap((c) => c.spells.map((s) => s.spell)));
    const spellInfo: CharacterStatus["spellInfo"] = {};
    for (const row of spellRows || []) {
      if (named.has(row.name)) spellInfo[row.name] = { description: String(row.description ?? ""), icon: row.icon ? String(row.icon) : null };
    }
    return { needed: true, startsOver, username, classes, spellInfo };
  },

  /** Makes the account's character of a class. An error message when it cannot be made. */
  async create(username: string, classId: unknown): Promise<{ ok: true; className: string } | { ok: false; error: string; status: number }> {
    const id = Number(classId);
    if (!Number.isInteger(id)) return { ok: false, error: "Choose a class.", status: 400 };
    const chosen = (await classList()).find((c) => c.id === id);
    if (!chosen) return { ok: false, error: "That class no longer exists. Choose another.", status: 409 };

    let account: any;
    try {
      account = ((await query("SELECT class_id, online FROM accounts WHERE username = ?", [username])) as any[])?.[0];
    } catch (error) {
      log.error(`Character for ${username}: ${error}`);
      return { ok: false, error: "Characters are not available yet. Try again in a moment.", status: 503 };
    }
    if (!account) return { ok: false, error: "Account not found.", status: 404 };
    if (account.class_id !== null && account.class_id !== undefined) return { ok: false, error: "This account already has its character.", status: 409 };
    if (Number(account.online) === 1) return { ok: false, error: "Your account is in the game right now. Leave the game first, then make your character.", status: 409 };

    const s = chosen.stats;
    const statements: TransactionStatement[] = [
      // the account first, and only while it has no character: two requests at once make one character
      {
        sql: "UPDATE accounts SET class_id = ?, map = ?, position = ?, is_dead = 0, corpse_map = NULL, corpse_x = NULL, corpse_y = NULL WHERE username = ? AND class_id IS NULL",
        values: [chosen.id, "", "0,0", username],
        mustChange: true,
      },
      { sql: "DELETE FROM stats WHERE username = ?", values: [username] },
      {
        sql: "INSERT INTO stats (username, health, max_health, stamina, max_stamina, xp, max_xp, level, stat_critical_damage, stat_critical_chance, stat_armor, stat_damage, stat_avoidance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        values: [username, s.max_health, s.max_health, s.max_stamina, s.max_stamina, 0, 100, 1, s.stat_critical_damage, s.stat_critical_chance, s.stat_armor, s.stat_damage, s.stat_avoidance],
      },
      { sql: "DELETE FROM inventory WHERE username = ?", values: [username] },
      { sql: "DELETE FROM bags WHERE username = ?", values: [username] },
      { sql: "DELETE FROM equipment WHERE username = ?", values: [username] },
      { sql: "INSERT INTO equipment (username) VALUES (?)", values: [username] },
      { sql: "DELETE FROM learned_spells WHERE username = ?", values: [username] },
      { sql: "DELETE FROM quest_log WHERE username = ?", values: [username] },
      { sql: "DELETE FROM quest_objective_progress WHERE username = ?", values: [username] },
      { sql: "DELETE FROM currency WHERE username = ?", values: [username] },
      { sql: "INSERT INTO currency (username, copper, silver, gold) VALUES (?, ?, ?, ?)", values: [username, 0, 0, 0] },
      { sql: "DELETE FROM player_home WHERE username = ?", values: [username] },
      { sql: "UPDATE clientconfig SET hotbar_config = NULL, inventory_config = NULL WHERE username = ?", values: [username] },
    ];
    try {
      await transaction(statements);
    } catch (error) {
      if (error instanceof GuardError) return { ok: false, error: "This account already has its character.", status: 409 };
      log.error(`Character for ${username} could not be made: ${error}`);
      return { ok: false, error: "The character could not be made. Nothing was changed. Try again.", status: 500 };
    }
    log.info(`${username} made their character: ${chosen.name}`);
    return { ok: true, className: chosen.name };
  },
};

export default characters;
