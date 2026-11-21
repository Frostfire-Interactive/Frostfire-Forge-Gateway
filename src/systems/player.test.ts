import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { SQL } from "bun";
import { GuardError, runTransaction } from "../controllers/sqltransaction";
import { sqlWrapper } from "../controllers/sqlescape";

const engineBefore = process.env.DATABASE_ENGINE;
process.env.DATABASE_ENGINE = "sqlite";
process.env.DOMAIN = "example.test";
afterAll(() => {
  if (engineBefore === undefined) delete process.env.DATABASE_ENGINE;
  else process.env.DATABASE_ENGINE = engineBefore;
});

let db: any;
let failCharacterLookup = false;

mock.module("../controllers/sqldatabase", () => ({
  default: async (sql: string, values: any[] = []) => {
    if (failCharacterLookup && sql.includes("FROM characters c JOIN accounts a")) throw new Error("connection lost");
    return db.unsafe(sqlWrapper(sql, values, "sqlite"));
  },
  transaction: async (statements: any[]) => runTransaction(db, statements, "sqlite"),
  GuardError,
}));

const { default: player, firstCharacterStatements } = await import("./player");
const { transaction } = await import("../controllers/sqldatabase");
const { default: characters } = await import("./characters");

// Own copy of the engine list (src/utility/charactertables.ts): the repos share no code.
const CHARACTER_TABLES = [
  "inventory", "stats", "clientconfig", "quest_log", "quest_objective_progress", "friendslist", "ignores",
  "player_home", "currency", "guild_members", "cutscene_views", "collectables", "learned_spells", "equipment",
  "bags", "player_achievements", "parties", "mail", "trade_log", "reports",
];

const n = async (sql: string, values: any[] = []): Promise<number> => Number((await db.unsafe(sqlWrapper(sql, values, "sqlite")))[0].n);

beforeEach(async () => {
  db = new SQL({ adapter: "sqlite", filename: ":memory:" });
  await db.unsafe("PRAGMA foreign_keys = ON");
  const statements = [
    `CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, username TEXT UNIQUE, token TEXT, token_expires INTEGER,
      password_hash TEXT, ip_address TEXT, geo_location TEXT, map TEXT, position TEXT, guest_mode INTEGER DEFAULT 0, online INTEGER DEFAULT 0,
      session_id TEXT, verified INTEGER DEFAULT 0, verification_code TEXT, twofa_pending INTEGER DEFAULT 0, party_id INTEGER, guild_id INTEGER, is_dead INTEGER DEFAULT 0, corpse_map TEXT, corpse_x INTEGER, corpse_y INTEGER, last_login TEXT, class_id INTEGER DEFAULT NULL, active_character_id INTEGER DEFAULT NULL)`,
    `CREATE TABLE characters (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, class_id INTEGER DEFAULT NULL, map TEXT DEFAULT 'overworld' NOT NULL,
      position TEXT DEFAULT '0,0' NOT NULL, party_id INTEGER DEFAULT NULL, guild_id INTEGER DEFAULT NULL, is_dead INTEGER DEFAULT 0, corpse_map TEXT, corpse_x INTEGER, corpse_y INTEGER, created_at INTEGER NOT NULL, deleted_at INTEGER DEFAULT NULL)`,
    "CREATE TABLE permissions (username TEXT PRIMARY KEY, permissions TEXT)",
    "CREATE TABLE guilds (id INTEGER PRIMARY KEY AUTOINCREMENT, leader TEXT)",
    "CREATE TABLE classes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, description TEXT, max_health INTEGER, max_stamina INTEGER, stat_damage INTEGER, stat_armor INTEGER, stat_critical_chance INTEGER, stat_critical_damage INTEGER, stat_avoidance INTEGER, spells TEXT, items TEXT)",
    "CREATE TABLE items (name TEXT, description TEXT, icon TEXT)",
    "CREATE TABLE spells (name TEXT, description TEXT, icon TEXT)",
  ];
  for (const sql of statements) await db.unsafe(sql);
  for (const table of CHARACTER_TABLES) {
    const extra = table === "parties" ? ", leader TEXT" : table === "stats" ? ", health INTEGER, max_health INTEGER, stamina INTEGER, max_stamina INTEGER, xp INTEGER, max_xp INTEGER, level INTEGER, stat_critical_damage INTEGER, stat_critical_chance INTEGER, stat_armor INTEGER, stat_damage INTEGER, stat_avoidance INTEGER" : table === "clientconfig" ? ", fps INTEGER, music_volume INTEGER, effects_volume INTEGER, ambience_volume INTEGER, weather_volume INTEGER, muted INTEGER, hotbar_config TEXT, inventory_config TEXT" : table === "currency" ? ", copper INTEGER, silver INTEGER, gold INTEGER" : table === "collectables" ? ", type TEXT, item TEXT" : table === "inventory" ? ", item TEXT, quantity INTEGER" : "";
    await db.unsafe(`CREATE TABLE ${table} (username TEXT, character_id INTEGER REFERENCES characters(id) ON DELETE CASCADE${extra})`);
  }
});

/** The account's active character id. */
const activeOf = async (account: number): Promise<number> => Number((await db.unsafe("SELECT active_character_id AS id FROM accounts WHERE id = " + account))[0].id);

const req = { ip: "203.0.113.5", headers: {} };

/** A guest made as the sign-up makes it, then aged so the purge may take it. */
async function guest(name: string, { old = true }: { old?: boolean } = {}): Promise<number> {
  expect(await player.register(name, "guest:x", `${name}@example.test`, req, true)).toBe(name);
  if (old) await db.unsafe("UPDATE accounts SET last_login = datetime('now', '-48 hours') WHERE username = '" + name + "'");
  return Number((await db.unsafe("SELECT id FROM accounts WHERE username = '" + name + "'"))[0].id);
}

test("a new guest has one active character named guest_...", async () => {
  const name = "guest_abc123";
  const account = await guest(name, { old: false });
  const characters = await db.unsafe("SELECT id, account_id, name, name_key, class_id FROM characters");
  expect(characters.length).toBe(1);
  expect(characters[0]).toMatchObject({ account_id: account, name, name_key: name });
  const row = (await db.unsafe("SELECT active_character_id, class_id FROM accounts WHERE id = " + account))[0];
  expect(Number(row.active_character_id)).toBe(Number(characters[0].id));
  // the rows a login reads are the character's
  for (const table of ["stats", "clientconfig", "currency", "equipment", "collectables"]) {
    expect(await n(`SELECT COUNT(*) AS n FROM ${table} WHERE character_id = ?`, [characters[0].id]), table).toBe(1);
  }
  // the pause menu's sliders as a player starts with them
  const config = (await db.unsafe("SELECT fps, music_volume, effects_volume, ambience_volume, weather_volume FROM clientconfig WHERE character_id = " + characters[0].id))[0];
  expect({ ...config }).toEqual({ fps: 60, music_volume: 50, effects_volume: 30, ambience_volume: 50, weather_volume: 60 });
});

const addMage = async (): Promise<number> => {
  await db.unsafe("INSERT INTO classes (name, description, max_health, max_stamina, stat_damage, stat_armor, stat_critical_chance, stat_critical_damage, stat_avoidance, spells, items) VALUES ('Mage', 'Casts.', 80, 150, 3, 1, 12, 40, 5, '[]', '[]')");
  return Number((await db.unsafe("SELECT id FROM classes WHERE name = 'Mage'"))[0].id);
};

test("a new guest's character has no class until it picks one", async () => {
  const account = await guest("guest_noclass", { old: false });
  expect((await db.unsafe("SELECT class_id FROM characters WHERE account_id = " + account))[0].class_id).toBeNull();
  expect((await db.unsafe("SELECT class_id FROM accounts WHERE id = " + account))[0].class_id).toBeNull();
});

test("realm selection sends a fresh guest to /character", async () => {
  await addMage();
  const account = await guest("guest_fresh", { old: false });
  const character = await activeOf(account);
  // realm selection asks /api/character and goes to /character when `needed`
  expect(await characters.status(account, character)).toMatchObject({ needed: true });
});

test("picking a class sets the active character's class_id", async () => {
  const mage = await addMage();
  const account = await guest("guest_picks", { old: false });
  const other = await guest("guest_other", { old: false });
  const character = await activeOf(account);
  expect(await characters.create(account, character, mage)).toEqual({ ok: true, className: "Mage" });
  expect((await db.unsafe("SELECT class_id FROM characters WHERE account_id = " + account))[0].class_id).toBe(mage);
  // the starting rows are the character's, one each, and no row is left keyed by name
  expect(await n("SELECT COUNT(*) AS n FROM stats WHERE character_id = ? AND max_health = 80", [character])).toBe(1);
  expect(await n("SELECT COUNT(*) AS n FROM stats WHERE username IS NOT NULL")).toBe(0);
  // another guest's character is not touched
  expect((await db.unsafe("SELECT class_id FROM characters WHERE account_id = " + other))[0].class_id).toBeNull();
  expect((await characters.status(account, character)).needed).toBe(false);
  expect(await characters.create(account, character, mage)).toMatchObject({ ok: false, status: 409 });
});

test("a failed character lookup refuses the class pick and writes nothing", async () => {
  const mage = await addMage();
  const account = await guest("guest_lost", { old: false });
  const character = await activeOf(account);
  failCharacterLookup = true;
  try {
    expect(await characters.create(account, character, mage)).toMatchObject({ ok: false, status: 503 });
  } finally {
    failCharacterLookup = false;
  }
  expect((await db.unsafe("SELECT class_id FROM characters WHERE account_id = " + account))[0].class_id).toBeNull();
  expect(await n("SELECT COUNT(*) AS n FROM stats WHERE username IS NOT NULL")).toBe(0);
});

test("the guest, its character and its active character are made together or not at all", async () => {
  await db.unsafe("DROP TABLE equipment");
  await db.unsafe("CREATE TABLE equipment (username TEXT, character_id INTEGER, must_fail INTEGER NOT NULL)");
  const made = await player.register("guest_broken", "guest:x", "guest_broken@example.test", req, true);
  expect(made).toMatchObject({ error: expect.any(String) });
  expect(await n("SELECT COUNT(*) AS n FROM accounts")).toBe(0);
  expect(await n("SELECT COUNT(*) AS n FROM characters")).toBe(0);
});

test("bulk guests each have one active character, in class 0", async () => {
  const tokens = await player.registerGuestBulk(3, "203.0.113.9");
  expect(tokens.length).toBe(3);
  expect(await n("SELECT COUNT(*) AS n FROM characters WHERE class_id = 0")).toBe(3);
  expect(await n("SELECT COUNT(*) AS n FROM characters")).toBe(3);
  expect(await n("SELECT COUNT(*) AS n FROM accounts a JOIN characters c ON c.id = a.active_character_id AND c.account_id = a.id AND c.name = a.username")).toBe(3);
  expect(await n("SELECT COUNT(*) AS n FROM stats WHERE character_id IS NOT NULL")).toBe(3);
});

test("purge leaves no row of the guest in any CHARACTER_TABLES table", async () => {
  const account = await guest("guest_old1");
  const character = Number((await db.unsafe("SELECT id FROM characters WHERE account_id = " + account))[0].id);
  for (const table of CHARACTER_TABLES) {
    if (["stats", "clientconfig", "currency", "collectables"].includes(table)) continue; // made by the sign-up
    await db.unsafe(`INSERT INTO ${table} (character_id) VALUES (${character})`);
  }
  await db.unsafe("INSERT INTO permissions VALUES ('guest_old1', '')");
  const keeper = await guest("guest_kept", { old: false });
  const keptCharacter = Number((await db.unsafe("SELECT id FROM characters WHERE account_id = " + keeper))[0].id);

  expect(await player.purgeOldGuests()).toBe(1);

  expect(await n("SELECT COUNT(*) AS n FROM accounts WHERE id = ?", [account])).toBe(0);
  expect(await n("SELECT COUNT(*) AS n FROM characters WHERE account_id = ?", [account])).toBe(0);
  for (const table of CHARACTER_TABLES) {
    expect(await n(`SELECT COUNT(*) AS n FROM ${table} WHERE character_id = ?`, [character]), table).toBe(0);
  }
  expect(await n("SELECT COUNT(*) AS n FROM permissions WHERE username = 'guest_old1'")).toBe(0);
  // a guest signed in less than a day ago is not touched
  expect(await n("SELECT COUNT(*) AS n FROM stats WHERE character_id = ?", [keptCharacter])).toBe(1);
  expect(await n("SELECT COUNT(*) AS n FROM accounts WHERE id = ?", [keeper])).toBe(1);
});

test("purge skips a guest in a party", async () => {
  const inParty = await guest("guest_party");
  await db.unsafe("UPDATE characters SET party_id = 7 WHERE account_id = " + inParty);
  const leader = await guest("guest_leader");
  await db.unsafe("INSERT INTO parties (username, leader) VALUES (NULL, 'guest_leader')");
  const inGuild = await guest("guest_guild");
  await db.unsafe("UPDATE accounts SET guild_id = 3 WHERE id = " + inGuild);
  const online = await guest("guest_online");
  await db.unsafe("UPDATE accounts SET online = 1 WHERE id = " + online);
  const gone = await guest("guest_gone");

  expect(await player.purgeOldGuests()).toBe(1);

  for (const id of [inParty, leader, inGuild, online]) expect(await n("SELECT COUNT(*) AS n FROM accounts WHERE id = ?", [id])).toBe(1);
  expect(await n("SELECT COUNT(*) AS n FROM accounts WHERE id = ?", [gone])).toBe(0);
  expect(await n("SELECT COUNT(*) AS n FROM characters WHERE account_id = ?", [inParty])).toBe(1);
});

test("clear removes every guest with its character and rows, and keeps real accounts", async () => {
  const g = await guest("guest_start", { old: false });
  await db.unsafe("INSERT INTO accounts (email, username, guest_mode) VALUES ('real@example.test', 'real', 0)");
  await db.unsafe("INSERT INTO permissions VALUES ('guest_start', '')");
  await player.clear();
  expect(await n("SELECT COUNT(*) AS n FROM accounts WHERE id = ?", [g])).toBe(0);
  expect(await n("SELECT COUNT(*) AS n FROM characters")).toBe(0);
  expect(await n("SELECT COUNT(*) AS n FROM stats")).toBe(0);
  expect(await n("SELECT COUNT(*) AS n FROM permissions")).toBe(0);
  expect(await n("SELECT COUNT(*) AS n FROM accounts WHERE username = 'real'")).toBe(1);
});

/** A non-guest account as the sign-up form makes it. */
const signUp = (name: string) => player.register(name, "hash", `${name}@example.test`, req, false);

test("a new account has no characters", async () => {
  expect(await signUp("hero")).toBe("hero");
  const account = Number((await db.unsafe("SELECT id FROM accounts WHERE username = 'hero'"))[0].id);
  expect(await n("SELECT COUNT(*) AS n FROM characters")).toBe(0);
  expect((await db.unsafe("SELECT active_character_id FROM accounts WHERE id = " + account))[0].active_character_id).toBeNull();
  for (const table of CHARACTER_TABLES) expect(await n(`SELECT COUNT(*) AS n FROM ${table}`), table).toBe(0);
  expect(await characters.activeOf("hero")).toEqual({ accountId: account, characterId: null });
});

test("create_admin's first character is named after the account, active, with the starting rows", async () => {
  expect(await signUp("boss")).toBe("boss");
  await transaction([...firstCharacterStatements(["boss"], null)]);
  const account = Number((await db.unsafe("SELECT id FROM accounts WHERE username = 'boss'"))[0].id);
  const rows = await db.unsafe("SELECT id, account_id, name, name_key, class_id FROM characters");
  expect(rows.length).toBe(1);
  expect(rows[0]).toMatchObject({ account_id: account, name: "boss", name_key: "boss", class_id: null });
  expect(await activeOf(account)).toBe(Number(rows[0].id));
  for (const table of ["stats", "clientconfig", "currency", "equipment", "collectables"]) {
    expect(await n(`SELECT COUNT(*) AS n FROM ${table} WHERE character_id = ?`, [rows[0].id]), table).toBe(1);
    expect(await n(`SELECT COUNT(*) AS n FROM ${table} WHERE username IS NOT NULL`), table).toBe(0);
  }
});

test("registration refuses a username that is another account's character name", async () => {
  await signUp("owner");
  // a character of the account, made the way the engine makes one
  const account = Number((await db.unsafe("SELECT id FROM accounts WHERE username = 'owner'"))[0].id);
  await db.unsafe(`INSERT INTO characters (account_id, name, name_key, created_at) VALUES (${account}, 'Sir_Alt', 'sir_alt', 1)`);
  expect(await signUp("SIR_ALT")).toEqual({ error: "Username already exists" });
  expect(await n("SELECT COUNT(*) AS n FROM accounts")).toBe(1);
  expect(await n("SELECT COUNT(*) AS n FROM characters")).toBe(1);
  // an unused name still works, and so does a guest whose name is its own
  expect(await signUp("fresh")).toBe("fresh");
});

test("create_admin's character and its rows are made together or not at all", async () => {
  expect(await signUp("boss2")).toBe("boss2");
  await db.unsafe("DROP TABLE currency");
  await db.unsafe("CREATE TABLE currency (username TEXT, character_id INTEGER, copper INTEGER, silver INTEGER, gold INTEGER, must_fail INTEGER NOT NULL)");
  await expect(transaction([...firstCharacterStatements(["boss2"], null)])).rejects.toThrow();
  expect(await n("SELECT COUNT(*) AS n FROM characters")).toBe(0);
  expect((await db.unsafe("SELECT active_character_id FROM accounts WHERE username = 'boss2'"))[0].active_character_id).toBeNull();
});
