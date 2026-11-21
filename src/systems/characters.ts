import query, { GuardError, transaction, type TransactionStatement } from "../controllers/sqldatabase";
import log from "../modules/logger";

/** A class as the character page shows it. */
export interface CharacterClassView {
  id: number;
  name: string;
  description: string;
  stats: { max_health: number; max_stamina: number; stat_damage: number; stat_armor: number; stat_critical_chance: number; stat_critical_damage: number; stat_avoidance: number };
  spells: { spell: string; level: number }[];
  items: { item: string; quantity: number }[];
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

/** The items column, as the engine's systems/classes.ts reads it. Absent on a table made before starter items. */
function parseItems(raw: unknown): { item: string; quantity: number }[] {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((e) => e && typeof e.item === "string" && e.item && Number.isFinite(Number(e.quantity)))
    .map((e) => ({ item: String(e.item), quantity: Math.max(1, Math.floor(Number(e.quantity))) }));
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
    items: parseItems(row.items),
  };
}

/** Every item the server has, by lower-case name: its name as the table has it, description and icon. */
async function itemTable(): Promise<Map<string, { name: string; description: string; icon: string | null }>> {
  const rows = (await query("SELECT name, description, icon FROM items").catch(() => [])) as any[];
  return new Map((rows || []).map((row) => [String(row.name).toLowerCase(), { name: String(row.name), description: String(row.description ?? ""), icon: row.icon ? String(row.icon) : null }]));
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
  /** The character's name (the page shows it). Empty when the character is not this account's. */
  username: string;
  classes: CharacterClassView[];
  /** What the classes' spells are, by name: their description and icon (a sprite name of the asset server). */
  spellInfo: Record<string, { description: string; icon: string | null }>;
  /** What the classes' starter items are, by name: their description and icon (an icon name of the asset server). */
  itemInfo: Record<string, { description: string; icon: string | null }>;
}

/** The account behind a session name and its active character (null before it has one). Null when there is no such account. */
async function activeOf(username: string): Promise<{ accountId: number; characterId: number | null } | null> {
  const row = ((await query("SELECT id, active_character_id FROM accounts WHERE username = ?", [username])) as any[])?.[0];
  if (!row) return null;
  const id = Number(row.active_character_id);
  return { accountId: Number(row.id), characterId: Number.isInteger(id) && id > 0 ? id : null };
}

/** The classes and what their spells and starter items are, as the character page shows them. */
async function catalog(): Promise<Pick<CharacterStatus, "classes" | "spellInfo" | "itemInfo">> {
  const classes = await classList();
  const [spellRows, itemRows] = await Promise.all([
    query("SELECT name, description, icon FROM spells").catch(() => []) as Promise<any[]>,
    itemTable(),
  ]);
  const named = new Set(classes.flatMap((c) => c.spells.map((s) => s.spell)));
  const spellInfo: CharacterStatus["spellInfo"] = {};
  for (const row of spellRows || []) {
    if (named.has(row.name)) spellInfo[row.name] = { description: String(row.description ?? ""), icon: row.icon ? String(row.icon) : null };
  }
  const itemInfo: CharacterStatus["itemInfo"] = {};
  for (const entry of classes.flatMap((c) => c.items)) {
    const found = itemRows.get(entry.item.toLowerCase());
    if (found) itemInfo[entry.item] = { description: found.description, icon: found.icon };
  }
  return { classes, spellInfo, itemInfo };
}

export interface CharacterSummary { id: number; name: string; classId: number | null; className: string | null; level: number }

/** A name a player picks: 3 to 15 letters, numbers or underscores. */
const NAME = /^[A-Za-z0-9_]{3,15}$/;

async function nameProblem(accountId: number, name: unknown): Promise<string | null> {
  const picked = String(name ?? "").trim();
  if (!NAME.test(picked)) return "Names are 3 to 15 letters, numbers or underscores.";
  const key = picked.toLowerCase();
  if (key.startsWith("guest_")) return "Names cannot start with guest_.";
  const owner = ((await query("SELECT id FROM accounts WHERE LOWER(username) = ? AND id <> ? LIMIT 1", [key, accountId])) as any[])?.[0];
  if (owner) return "That name is taken.";
  const used = ((await query("SELECT id FROM characters WHERE name_key = ? LIMIT 1", [key])) as any[])?.[0];
  if (used) return "That name is taken.";
  return null;
}

const characters = {
  activeOf,
  nameProblem,

  /** The account's characters (deleted ones left out), oldest first, and the classes a new one can take. */
  async list(accountId: number): Promise<{ characters: CharacterSummary[] } & Awaited<ReturnType<typeof catalog>>> {
    const rows = (await query(
      "SELECT c.id, c.name, c.class_id, cl.name AS class_name, s.level FROM characters c LEFT JOIN classes cl ON cl.id = c.class_id LEFT JOIN stats s ON s.character_id = c.id WHERE c.account_id = ? AND c.deleted_at IS NULL ORDER BY c.id",
      [accountId],
    )) as any[];
    const list = (rows || []).map((r) => ({
      id: Number(r.id),
      name: String(r.name),
      classId: r.class_id === null || r.class_id === undefined ? null : Number(r.class_id),
      className: r.class_name ? String(r.class_name) : null,
      level: Number(r.level) || 1,
    }));
    return { characters: list, ...(await catalog()) };
  },

  /** Makes a new character of the account with a name and a class, at most `limit` of them (deleted ones not counted). */
  async add(accountId: number, name: unknown, classId: unknown, limit: number): Promise<{ ok: true; id: number } | { ok: false; error: string; status: number }> {
    const picked = String(name ?? "").trim();
    if (!NAME.test(picked)) return { ok: false, error: "Names are 3 to 15 letters, numbers or underscores.", status: 400 };
    const key = picked.toLowerCase();
    if (key.startsWith("guest_")) return { ok: false, error: "Names cannot start with guest_.", status: 400 };
    const classes = await classList();
    // With no class defined, a character is made without one and plays as before.
    const chosen = classes.length === 0
      ? { id: null, name: "no class", items: [], stats: { max_health: 100, max_stamina: 100, stat_damage: 0, stat_armor: 0, stat_critical_chance: 10, stat_critical_damage: 10, stat_avoidance: 0 } }
      : classes.find((c) => c.id === Number(classId));
    if (!chosen) return { ok: false, error: "That class no longer exists. Choose another.", status: 409 };
    // Another account's username is its first character's name to other players: not a name to take.
    const owner = ((await query("SELECT id FROM accounts WHERE LOWER(username) = ? AND id <> ? LIMIT 1", [key, accountId])) as any[])?.[0];
    if (owner) return { ok: false, error: "That name is taken.", status: 409 };

    const known = await itemTable();
    const starterItems = chosen.items.flatMap((entry) => {
      const found = known.get(entry.item.toLowerCase());
      return found ? [{ item: found.name, quantity: entry.quantity }] : [];
    });
    const s = chosen.stats;
    const forIt = (table: string, columns: string, values: any[]): TransactionStatement => ({
      sql: `INSERT INTO ${table} (character_id${columns ? ", " + columns : ""}) SELECT id${values.map(() => ", ?").join("")} FROM characters WHERE name_key = ?`,
      values: [...values, key],
    });
    const statements: TransactionStatement[] = [
      // The limit is held in the insert itself, so two requests at once cannot pass it; the unique name_key holds the name.
      {
        sql: "INSERT INTO characters (account_id, name, name_key, class_id, map, position, created_at) SELECT id, ?, ?, ?, '', '0,0', ? FROM accounts WHERE id = ? AND (SELECT COUNT(*) FROM characters WHERE account_id = ? AND deleted_at IS NULL) < ?",
        values: [picked, key, chosen.id, Date.now(), accountId, accountId, limit],
        mustChange: true,
      },
      forIt("stats", "health, max_health, stamina, max_stamina, xp, max_xp, level, stat_critical_damage, stat_critical_chance, stat_armor, stat_damage, stat_avoidance",
        [s.max_health, s.max_health, s.max_stamina, s.max_stamina, 0, 100, 1, s.stat_critical_damage, s.stat_critical_chance, s.stat_armor, s.stat_damage, s.stat_avoidance]),
      ...starterItems.map((entry) => forIt("inventory", "item, quantity", [entry.item, entry.quantity])),
      forIt("equipment", "", []),
      forIt("currency", "copper, silver, gold", [0, 0, 0]),
      // The pause menu's sliders as a character starts with them (the engine's DEFAULT_CONFIG)
      forIt("clientconfig", "fps, music_volume, effects_volume, ambience_volume, weather_volume", [60, 50, 30, 50, 60]),
      forIt("collectables", "type, item", ["mount", "horse"]),
    ];
    try {
      await transaction(statements);
    } catch (error) {
      if (error instanceof GuardError) return { ok: false, error: "You have the most characters you can have.", status: 409 };
      if (/unique|duplicate/i.test(String(error))) return { ok: false, error: "That name is taken.", status: 409 };
      log.error(`A character of account ${accountId} could not be made: ${error}`);
      return { ok: false, error: "The character could not be made. Nothing was changed. Try again.", status: 500 };
    }
    const row = ((await query("SELECT id FROM characters WHERE name_key = ?", [key])) as any[])?.[0];
    log.info(`Account ${accountId} made the character ${picked} (${chosen.name})`);
    return { ok: true, id: Number(row?.id) };
  },

  /** Makes one of the account's own characters (not a deleted one) the one its next login plays. */
  async play(accountId: number, characterId: unknown): Promise<boolean> {
    const id = Number(characterId);
    if (!Number.isInteger(id)) return false;
    const mine = ((await query("SELECT id FROM characters WHERE id = ? AND account_id = ? AND deleted_at IS NULL", [id, accountId])) as any[])?.[0];
    if (!mine) return false;
    await query("UPDATE accounts SET active_character_id = ? WHERE id = ?", [id, accountId]);
    return true;
  },

  /** Deletes one of the account's characters: it leaves the list now and is removed for good after the grace period. */
  async remove(accountId: number, characterId: unknown, confirmName: unknown): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
    const id = Number(characterId);
    const row = Number.isInteger(id)
      ? ((await query("SELECT c.name, a.online, a.active_character_id FROM characters c JOIN accounts a ON a.id = c.account_id WHERE c.id = ? AND c.account_id = ? AND c.deleted_at IS NULL", [id, accountId])) as any[])?.[0]
      : null;
    if (!row) return { ok: false, error: "Character not found.", status: 404 };
    if (String(confirmName ?? "").trim().toLowerCase() !== String(row.name).toLowerCase()) {
      return { ok: false, error: "Type the character's name to delete it.", status: 400 };
    }
    // While the account is in the game, its character in play may not be the active one: refuse them all.
    if (Number(row.online) === 1) return { ok: false, error: "Leave the game first.", status: 409 };
    const led = ((await query(
      "SELECT g.id FROM guilds g WHERE g.leader_id = ? AND (SELECT COUNT(*) FROM guild_members m WHERE m.guild_id = g.id AND m.character_id <> ?) > 0 LIMIT 1",
      [id, id],
    ).catch(() => [])) as any[])?.[0];
    if (led) return { ok: false, error: "Pass on leadership of your guild first.", status: 409 };
    await transaction([
      { sql: "UPDATE characters SET deleted_at = ? WHERE id = ? AND account_id = ? AND deleted_at IS NULL", values: [Date.now(), id, accountId], mustChange: true },
      { sql: "UPDATE accounts SET active_character_id = NULL WHERE id = ? AND active_character_id = ?", values: [accountId, id] },
    ]).catch((error) => { if (!(error instanceof GuardError)) throw error; });
    log.info(`Account ${accountId} deleted the character ${row.name}`);
    return { ok: true };
  },

  /** Removes for good the characters deleted more than `graceMs` ago, and their names from friend and ignore lists. */
  async purgeDeleted(graceMs: number, now = Date.now()): Promise<number> {
    const cutoff = now - graceMs;
    const doomed = ((await query("SELECT id, name FROM characters WHERE deleted_at IS NOT NULL AND deleted_at < ?", [cutoff])) as any[]) || [];
    if (doomed.length === 0) return 0;
    const names = doomed.map((r) => String(r.name));
    const lower = new Set(names.map((n) => n.toLowerCase()));
    const marks = names.map(() => "?").join(", ");
    await query(`DELETE FROM characters WHERE id IN (${doomed.map(() => "?").join(", ")})`, doomed.map((r) => r.id));
    await query(`DELETE FROM ignores WHERE LOWER(ignored) IN (${marks})`, names.map((n) => n.toLowerCase())).catch(() => undefined);
    const lists = ((await query("SELECT character_id, friends FROM friendslist").catch(() => [])) as any[]) || [];
    for (const list of lists) {
      const friends = String(list.friends ?? "").split(",").map((f) => f.trim()).filter((f) => f !== "");
      const kept = friends.filter((f) => !lower.has(f.toLowerCase()));
      if (kept.length !== friends.length) {
        await query("UPDATE friendslist SET friends = ? WHERE character_id = ?", [kept.join(","), list.character_id]);
      }
    }
    return doomed.length;
  },

  async status(accountId: number, characterId: number): Promise<CharacterStatus> {
    const none: CharacterStatus = { needed: false, startsOver: false, username: "", classes: [], spellInfo: {}, itemInfo: {} };
    let character: any;
    try {
      // Only a character of this account, and not a deleted one.
      character = ((await query("SELECT name, class_id FROM characters WHERE id = ? AND account_id = ? AND deleted_at IS NULL", [characterId, accountId])) as any[])?.[0];
    } catch {
      return none; // no characters table yet: characters are off
    }
    if (!character) return none;
    const username = String(character.name);
    none.username = username;
    if (character.class_id !== null && character.class_id !== undefined) return none;
    const classes = await classList();
    if (classes.length === 0) return none;
    const [stats, items, spells, spellRows, itemRows] = await Promise.all([
      query(`SELECT level, xp FROM stats WHERE character_id = ?`, [characterId]).catch(() => []) as Promise<any[]>,
      query(`SELECT COUNT(*) AS count FROM inventory WHERE character_id = ?`, [characterId]).catch(() => []) as Promise<any[]>,
      query(`SELECT COUNT(*) AS count FROM learned_spells WHERE character_id = ?`, [characterId]).catch(() => []) as Promise<any[]>,
      query("SELECT name, description, icon FROM spells").catch(() => []) as Promise<any[]>,
      itemTable(),
    ]);
    const startsOver = Number(stats?.[0]?.level) > 1 || Number(stats?.[0]?.xp) > 0 || Number(items?.[0]?.count) > 0 || Number(spells?.[0]?.count) > 0;
    const named = new Set(classes.flatMap((c) => c.spells.map((s) => s.spell)));
    const spellInfo: CharacterStatus["spellInfo"] = {};
    for (const row of spellRows || []) {
      if (named.has(row.name)) spellInfo[row.name] = { description: String(row.description ?? ""), icon: row.icon ? String(row.icon) : null };
    }
    const itemInfo: CharacterStatus["itemInfo"] = {};
    for (const entry of classes.flatMap((c) => c.items)) {
      const found = itemRows.get(entry.item.toLowerCase());
      if (found) itemInfo[entry.item] = { description: found.description, icon: found.icon };
    }
    return { needed: true, startsOver, username, classes, spellInfo, itemInfo };
  },

  /** Chooses the class of one character of the account. An error message when it cannot be made. */
  async create(accountId: number, characterId: number, classId: unknown): Promise<{ ok: true; className: string } | { ok: false; error: string; status: number }> {
    const id = Number(classId);
    if (!Number.isInteger(id)) return { ok: false, error: "Choose a class.", status: 400 };
    const chosen = (await classList()).find((c) => c.id === id);
    if (!chosen) return { ok: false, error: "That class no longer exists. Choose another.", status: 409 };

    let character: any;
    try {
      character = ((await query("SELECT c.name, c.class_id, a.online FROM characters c JOIN accounts a ON a.id = c.account_id WHERE c.id = ? AND c.account_id = ? AND c.deleted_at IS NULL", [characterId, accountId])) as any[])?.[0];
    } catch (error) {
      log.error(`Character ${characterId} of account ${accountId}: ${error}`);
      return { ok: false, error: "Characters are not available yet. Try again in a moment.", status: 503 };
    }
    if (!character) return { ok: false, error: "Character not found.", status: 404 };
    if (character.class_id !== null && character.class_id !== undefined) return { ok: false, error: "This character already has its class.", status: 409 };
    if (Number(character.online) === 1) return { ok: false, error: "Your account is in the game right now. Leave the game first, then choose the class.", status: 409 };

    // the starter items still in the items table, by the name it has them under (one deleted since is passed over)
    const known = await itemTable();
    const starterItems = chosen.items.flatMap((entry) => {
      const found = known.get(entry.item.toLowerCase());
      return found ? [{ item: found.name, quantity: entry.quantity }] : [];
    });

    const s = chosen.stats;
    const who = characterId;
    const statements: TransactionStatement[] = [
      // the character first, and only while it has no class and is this account's: two requests at once make one
      {
        sql: "UPDATE characters SET class_id = ?, map = ?, position = ?, is_dead = 0, corpse_map = NULL, corpse_x = NULL, corpse_y = NULL WHERE id = ? AND account_id = ? AND class_id IS NULL AND deleted_at IS NULL",
        values: [chosen.id, "", "0,0", characterId, accountId],
        mustChange: true,
      },
      { sql: "DELETE FROM stats WHERE character_id = ?", values: [who] },
      {
        sql: "INSERT INTO stats (character_id, health, max_health, stamina, max_stamina, xp, max_xp, level, stat_critical_damage, stat_critical_chance, stat_armor, stat_damage, stat_avoidance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        values: [who, s.max_health, s.max_health, s.max_stamina, s.max_stamina, 0, 100, 1, s.stat_critical_damage, s.stat_critical_chance, s.stat_armor, s.stat_damage, s.stat_avoidance],
      },
      { sql: "DELETE FROM inventory WHERE character_id = ?", values: [who] },
      ...starterItems.map((entry) => ({ sql: "INSERT INTO inventory (character_id, item, quantity) VALUES (?, ?, ?)", values: [who, entry.item, entry.quantity] })),
      { sql: "DELETE FROM bags WHERE character_id = ?", values: [who] },
      { sql: "DELETE FROM equipment WHERE character_id = ?", values: [who] },
      { sql: "INSERT INTO equipment (character_id) VALUES (?)", values: [who] },
      { sql: "DELETE FROM learned_spells WHERE character_id = ?", values: [who] },
      { sql: "DELETE FROM quest_log WHERE character_id = ?", values: [who] },
      { sql: "DELETE FROM quest_objective_progress WHERE character_id = ?", values: [who] },
      { sql: "DELETE FROM currency WHERE character_id = ?", values: [who] },
      { sql: "INSERT INTO currency (character_id, copper, silver, gold) VALUES (?, ?, ?, ?)", values: [who, 0, 0, 0] },
      { sql: "DELETE FROM player_home WHERE character_id = ?", values: [who] },
      { sql: "UPDATE clientconfig SET hotbar_config = NULL, inventory_config = NULL WHERE character_id = ?", values: [who] },
    ];
    try {
      await transaction(statements);
    } catch (error) {
      if (error instanceof GuardError) return { ok: false, error: "This character already has its class.", status: 409 };
      log.error(`Class of character ${characterId} of account ${accountId} could not be set: ${error}`);
      return { ok: false, error: "The character could not be made. Nothing was changed. Try again.", status: 500 };
    }
    log.info(`${character.name} chose the class ${chosen.name}`);
    return { ok: true, className: chosen.name };
  },
};

export default characters;
