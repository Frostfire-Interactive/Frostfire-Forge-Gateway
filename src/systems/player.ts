import query, { transaction, type TransactionStatement } from "../controllers/sqldatabase";
import { verify, randomBytes, verifyGuestPassword } from "../modules/hash";
import log from "../modules/logger";

// An account token lasts this long from when it was issued, then a new password login is needed. Kept in the
// account row (token_expires, epoch ms), which the engine checks too. A token with no expiry has expired.
export const TOKEN_LIFETIME_MS = (Number(process.env.TOKEN_LIFETIME_HOURS) || 24 * 7) * 60 * 60 * 1000;

/** Whether an account row's token is still within its lifetime. */
export function tokenLive(row: { token_expires?: unknown } | undefined): boolean {
  const expires = Number(row?.token_expires);
  return Number.isFinite(expires) && expires > Date.now();
}

async function hasAccountsColumn(name: string): Promise<boolean> {
  if (process.env.DATABASE_ENGINE === "sqlite") {
    const rows = await query<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accounts'");
    return new RegExp(`\\b${name}\\b`).test(String(rows[0]?.sql || ""));
  }
  const rows = await query<{ count: number }>(
    "SELECT COUNT(*) AS count FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'accounts' AND COLUMN_NAME = ?",
    [name]
  );
  return Number(rows[0]?.count) > 0;
}

/**
 * Start-time step: accounts.token_expires, added if missing (the engine does the same; whichever starts first
 * does the work). Every login reads it, so it must be there before the first one. Never throws.
 */
export async function ensureTokenExpiryColumn(): Promise<boolean> {
  try {
    if (await hasAccountsColumn("token_expires")) return true;
    try {
      await query("ALTER TABLE accounts ADD COLUMN token_expires BIGINT DEFAULT NULL");
    } catch (error) {
      if (!(await hasAccountsColumn("token_expires"))) throw error;
    }
    return true;
  } catch (error: any) {
    log.error(`accounts.token_expires could not be added, so no login can succeed until it is: ${error?.message || error}`);
    return false;
  }
}

/** A guest to make: the account's name (also its character's), e-mail, and what the sign-up knows of it. */
interface NewGuest {
  username: string;
  email: string;
  password_hash: string;
  token: string | null;
  tokenExpires: number | null;
  ip: string | null;
  geo: string | null;
}

/**
 * The statements that make guests, to run as ONE transaction: each guest's account, its one character (named as
 * the account, with `classId`: null for a guest, who picks its class on the character page like any account; 0 for
 * benchmark guests, who go straight into the game), the account's active character, and the character's starting rows (keyed by the character's id, so
 * deleting the account removes them all: accounts.id -> characters -> every table of the character).
 * Names are lowercase and 30 characters at most, the width of characters.name.
 */
function newGuestStatements(guests: NewGuest[], classId: number | null): TransactionStatement[] {
  const multiInsert = (sql: string, perRow: (g: NewGuest) => any[]): TransactionStatement => {
    const group = `(${perRow(guests[0]).map(() => "?").join(", ")})`;
    return { sql: `${sql} VALUES ${guests.map(() => group).join(", ")}`, values: guests.flatMap(perRow) };
  };
  return [
    multiInsert(
      "INSERT INTO accounts (email, username, token, token_expires, password_hash, ip_address, geo_location, map, position, guest_mode, class_id)",
      (g) => [g.email, g.username, g.token, g.tokenExpires, g.password_hash, g.ip, g.geo, "", "0,0", 1, classId]
    ),
    ...firstCharacterStatements(guests.map((g) => g.username), classId),
  ];
}

/**
 * The statements that give each of the accounts named (already inserted, in the same transaction or before) its first
 * character, named as the account: the character, the account's active character, and the character's starting rows.
 * Used by guests and by create_admin.
 */
export function firstCharacterStatements(names: string[], classId: number | null): TransactionStatement[] {
  const marks = names.map(() => "?").join(", ");
  // A row for each of the new characters, found by name.
  const forEach = (table: string, columns: string, values: any[]): TransactionStatement => ({
    sql: `INSERT INTO ${table} (character_id${columns ? ", " + columns : ""}) SELECT id${values.map(() => ", ?").join("")} FROM characters WHERE name_key IN (${marks})`,
    values: [...values, ...names],
  });
  return [
    {
      sql: `INSERT INTO characters (account_id, name, name_key, class_id, map, position, created_at) SELECT id, username, username, ?, '', '0,0', ? FROM accounts WHERE username IN (${marks})`,
      values: [classId, Date.now(), ...names],
      mustChange: true,
    },
    {
      sql: `UPDATE accounts SET active_character_id = (SELECT c.id FROM characters c WHERE c.account_id = accounts.id) WHERE username IN (${marks})`,
      values: names,
      mustChange: true,
    },
    forEach("stats", "health, max_health, stamina, max_stamina, xp, max_xp, level, stat_critical_damage, stat_critical_chance", [100, 100, 100, 100, 0, 100, 1, 10, 10]),
    forEach("clientconfig", "fps, music_volume, effects_volume, ambience_volume, weather_volume, muted", [60, 50, 30, 50, 60, 0]),
    // (Nothing for the quest log: see register, below.)
    forEach("currency", "copper, silver, gold", [0, 0, 0]),
    forEach("equipment", "", []),
    forEach("collectables", "type, item", ["mount", "horse"]),
  ];
}

const player = {
  clear: async () => {

    await query(
      "UPDATE accounts SET session_id = NULL, online = 0, token = NULL, verified = 0, verification_code = NULL, party_id = NULL, twofa_pending = 0"
    );

    if (process.env.DATABASE_ENGINE === "sqlite") {
      await query("DELETE FROM parties");
    } else {
      await query("TRUNCATE TABLE parties");
    }

    // A guest is its account: deleting it deletes its characters and, by the foreign keys, every row of
    // theirs (stats, bags, mail, quests ...). Only the account's own permissions are keyed by name.
    await query("DELETE FROM permissions WHERE username IN (SELECT username FROM accounts WHERE guest_mode = 1)");

    await query("DELETE FROM accounts WHERE guest_mode = 1");
  },
  // The engine removes every guest when it starts (its player.clear). This removes, while it runs, the
  // guests nobody can be playing: offline with no session, a day past their last login, and in no party
  // or guild (the engine keeps those in memory). The rest wait for the engine's next start. Answers
  // with the number removed.
  purgeOldGuests: async () => {
    const engine = process.env.DATABASE_ENGINE || "mysql";
    const dayAgo = engine === "sqlite" ? "datetime('now', '-24 hours')" : engine === "postgres" ? "NOW() - INTERVAL '24 hours'" : "NOW() - INTERVAL 24 HOUR";
    // A guest in a party or guild is held by the character (characters.party_id, guild_id) as well as by the
    // account's own columns, and a leader by name in parties and guilds.
    const idle =
      "guest_mode = 1 AND online = 0 AND session_id IS NULL AND party_id IS NULL AND guild_id IS NULL" +
      " AND NOT EXISTS (SELECT 1 FROM characters c WHERE c.account_id = accounts.id AND (c.party_id IS NOT NULL OR c.guild_id IS NOT NULL))" +
      " AND NOT EXISTS (SELECT 1 FROM characters c WHERE c.account_id = accounts.id AND (c.name_key IN (SELECT LOWER(leader) FROM parties WHERE leader IS NOT NULL) OR c.name_key IN (SELECT LOWER(leader) FROM guilds WHERE leader IS NOT NULL)))";
    const found = (await query(
      `SELECT username FROM accounts WHERE ${idle} AND last_login IS NOT NULL AND last_login < ${dayAgo} LIMIT 500`
    )) as { username: string }[];
    if (found.length === 0) return 0;

    const names = found.map((row) => row.username);
    const marks = names.map(() => "?").join(", ");
    // The account goes first and only while still idle, so a guest who came back in the meantime is
    // kept. Deleting it deletes its characters and, by the foreign keys, every row of theirs; only the
    // permissions, keyed by the account's name, are removed for the names whose account is gone.
    const results = await transaction([
      { sql: `DELETE FROM accounts WHERE ${idle} AND username IN (${marks})`, values: names },
      { sql: `DELETE FROM permissions WHERE username IN (${marks}) AND username NOT IN (SELECT username FROM accounts)`, values: names },
    ]);
    const removed = results[0];
    return typeof removed?.affectedRows === "number" ? removed.affectedRows : removed?.count ?? 0;
  },
  // Bulk-provision N guest accounts for load testing. A normal guest signup is
  // ~15 serialised SQL round-trips (2 dup-check SELECTs + 7 child INSERTs +
  // login SELECT/UPDATEs); at benchmark ramp rates that saturates the DB worker
  // pool and clients time out. Guests use CSPRNG usernames so dup checks are
  // pointless, and the child rows are identical templates - so this does one
  // multi-row INSERT per table (7 queries total for the whole batch) and mints
  // the tokens directly instead of going through login().
  registerGuestBulk: async (count: number, ip?: string, geo?: string) => {
    const n = Math.max(1, Math.min(2000, Math.floor(count)));
    const rows = Array.from({ length: n }, () => {
      const username = `guest_${randomBytes(12)}`.toLowerCase();
      const domain = process.env.DOMAIN?.replace(/^https?:\/\//, "");
      return {
        username,
        email: `${username}@${domain}`,
        token: randomBytes(32),
      };
    });

    const expires = Date.now() + TOKEN_LIFETIME_MS;
    // One transaction: no guest is left with an account and not the character and rows a login reads.
    // Benchmark clients go straight into the game, past the character page: class 0, which the game server lets in.
    await transaction(
      newGuestStatements(rows.map((r) => ({ username: r.username, email: r.email, password_hash: "guest:benchmark", token: r.token, tokenExpires: expires, ip: ip ?? null, geo: geo ?? null })), 0)
    );

    return rows.map((r) => r.token);
  },
  register: async (
    username: string,
    password_hash: string,
    email: string,
    req: any,
    guest: boolean
  ) => {
    if (!username || !password_hash || !email)
      return { error: "Missing fields" };
    username = username.toLowerCase();
    email = email.toLowerCase();

    if (!guest && username.startsWith("guest_"))
      return { error: "Username cannot start with 'guest_'" };

    const usernameExists = (await player.findByUsername(username)) as string[];
    if (usernameExists && usernameExists.length != 0)
      return { error: "Username already exists" };

    // No login name may equal a character's name (any account's, a deleted one's too: names are never reused).
    // The engine's nameTaken makes the same check from the other side. Character names are compared in lowercase.
    const characterNamed = (await query("SELECT id FROM characters WHERE name_key = ? LIMIT 1", [username.toLowerCase()])) as any[];
    if (characterNamed && characterNamed.length != 0)
      return { error: "Username already exists" };

    const emailExists = (await player.findByEmail(email)) as string[];
    if (emailExists && emailExists.length != 0)
      return { error: "Email already exists" };

    // A guest has one character, made with the account (newGuestStatements), without a class: it picks one on the character page.
    if (guest) {
      try {
        await transaction(newGuestStatements([{ username, email, password_hash, token: null, tokenExpires: null, ip: req.ip ?? null, geo: req.headers?.["cf-ipcountry"] ?? null }], null));
      } catch (err: any) {
        log.error(err);
        return { error: "An unexpected error occurred" };
      }
      return username;
    }

    // The account only: it has no character yet (the character page makes the first one).
    try {
      await transaction([
        {
          sql: "INSERT INTO accounts (email, username, token, password_hash, ip_address, geo_location, map, position, guest_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          values: [email, username, null, password_hash, req.ip, req.headers["cf-ipcountry"], "", "0,0", 0],
        },
      ]);
    } catch (err: any) {
      log.error(err);
      return { error: "An unexpected error occurred" };
    }
    return username;
  },
  findByUsername: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = await query(
      "SELECT username FROM accounts WHERE username = ?",
      [username]
    );
    return response || [];
  },
  verify: async (session_id: string) => {

    const response = (await query(
      "SELECT verified FROM accounts WHERE session_id = ?",
      [session_id]
    )) as any[];

    if (response[0]?.verified) return true;
    return false;
  },
  findByEmail: async (email: string) => {
    if (!email) return;
    const response = await query("SELECT email FROM accounts WHERE email = ?", [
      email,
    ]);
    return response;
  },
  isBanned: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = await query(
      "SELECT banned FROM accounts WHERE username = ?",
      [username]
    );
    return response;
  },
  getSessionId: async (token: string) => {
    if (!token) return;
    const response = await query(
      "SELECT session_id FROM accounts WHERE token = ? AND token_expires > ?",
      [token, Date.now()]
    );
    return response;
  },
  logout: async (session_id: string) => {
    if (!session_id) return;
    const response = await query(
      "UPDATE accounts SET token = NULL, online = ?, session_id = NULL, verification_code = NULL, verified = ?, twofa_pending = 0 WHERE session_id = ?",
      [0, 0, session_id]
    );
    return response;
  },
  clearSessionId: async (session_id: string) => {
    if (!session_id) return;
    const response = await query(
      "UPDATE accounts SET session_id = NULL, online = ? WHERE session_id = ?",
      [0, session_id]
    );
    return response;
  },
  setToken: async (username: string) => {
    const token = randomBytes(32);
    if (!username || !token) return;

    const response = await query(
      "UPDATE accounts SET token = ?, token_expires = ? WHERE username = ?",
      [token, Date.now() + TOKEN_LIFETIME_MS, username]
    );
    if (!response) return;

    return token;
  },
  login: async (username: string, password: string) => {
    if (!username || !password) return;
    username = username.toLowerCase();

    const response = (await query(
      "SELECT username, banned, token, token_expires, password_hash FROM accounts WHERE username = ?",
      [username]
    )) as {
      username: string;
      banned: number;
      token: string;
      token_expires: number | null;
      password_hash: string;
    }[];
    if (response.length === 0 || response[0].banned === 1) {
      log.debug(`User ${username} failed to login`);
      return;
    }

    const isValid = response[0].password_hash?.startsWith("guest:")
      ? verifyGuestPassword(password, response[0].password_hash)
      : await verify(password, response[0].password_hash);
    if (!isValid) {
      log.debug(`User ${username} failed to login`);
      return;
    }

    // The token is shared by every device the player logs in on, until it expires: then a new one.
    const token = (response[0].token && tokenLive(response[0]) ? response[0].token : null) || (await player.setToken(username));

    log.debug(`User ${username} logged in`);

    await query(
      "UPDATE accounts SET last_login = CURRENT_TIMESTAMP WHERE username = ?",
      [username]
    );
    return token;
  },
  getUsernameBySession: async (session_id: string) => {
    if (!session_id) return;
    const response = await query(
      "SELECT username, id FROM accounts WHERE session_id = ?",
      [session_id]
    );
    return response;
  },
  getSessionIdByUsername: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = (await query(
      "SELECT session_id FROM accounts WHERE username = ?",
      [username]
    )) as any;
    return response[0]?.session_id;
  },
  getPartyIdByUsername: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = (await query(
      "SELECT party_id FROM accounts WHERE username = ?",
      [username]
    )) as any;
    return response[0]?.party_id;
  },
  getUsernameByToken: async (token: string) => {
    if (!token) return;
    const response = await query(
      "SELECT username FROM accounts WHERE token = ? AND token_expires > ?",
      [token, Date.now()]
    );
    return response;
  },
  getEmail: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = (await query(
      "SELECT email FROM accounts WHERE username = ?",
      [username]
    )) as any;
    return response[0]?.email;
  },
  getProfile: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = (await query(
      "SELECT username, email, totp_enabled, webauthn_enabled, webauthn_credentials, last_login, require_webauthn, require_totp, require_email_2fa FROM accounts WHERE username = ?",
      [username]
    )) as any[];
    if (!response || response.length === 0) return null;
    return response[0];
  },
  updateEmail: async (username: string, email: string) => {
    if (!username || !email) return;
    username = username.toLowerCase();
    email = email.toLowerCase();
    const response = await query(
      "UPDATE accounts SET email = ? WHERE username = ?",
      [email, username]
    );
    return response;
  },
  changePassword: async (username: string, newPasswordHash: string) => {
    if (!username || !newPasswordHash) return;
    username = username.toLowerCase();
    const response = await query(
      "UPDATE accounts SET password_hash = ? WHERE username = ?",
      [newPasswordHash, username]
    );
    return response;
  },
  getTOTPSecret: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = (await query(
      "SELECT totp_secret, totp_enabled FROM accounts WHERE username = ?",
      [username]
    )) as any[];
    if (!response || response.length === 0) return null;
    return response[0];
  },
  setTOTPSecret: async (username: string, secret: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = await query(
      "UPDATE accounts SET totp_secret = ?, totp_enabled = 0 WHERE username = ?",
      [secret, username]
    );
    return response;
  },
  enableTOTP: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = await query(
      "UPDATE accounts SET totp_enabled = 1 WHERE username = ?",
      [username]
    );
    return response;
  },
  disableTOTP: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = await query(
      "UPDATE accounts SET totp_secret = NULL, totp_enabled = 0 WHERE username = ?",
      [username]
    );
    return response;
  },
  getWebAuthnCredentials: async (username: string) => {
    if (!username) return [];
    username = username.toLowerCase();
    const response = (await query(
      "SELECT webauthn_credentials, webauthn_enabled FROM accounts WHERE username = ?",
      [username]
    )) as any[];
    if (!response || response.length === 0) return [];
    const row = response[0];
    if (!row.webauthn_credentials) return [];
    try {
      const decoded = Buffer.from(row.webauthn_credentials, "base64").toString("utf-8");
      const parsed = JSON.parse(decoded);
      return parsed;
    } catch {
      return [];
    }
  },
  addWebAuthnCredential: async (username: string, credential: { id: string; publicKey: string; name: string; createdAt: string }) => {
    if (!username) return;
    username = username.toLowerCase();
    const existing = await player.getWebAuthnCredentials(username);
    existing.push(credential);
    const json = JSON.stringify(existing);
    const encoded = Buffer.from(json).toString("base64");
    const response = await query(
      "UPDATE accounts SET webauthn_credentials = ?, webauthn_enabled = 1 WHERE username = ?",
      [encoded, username]
    );
    if (!response) {
      log.error(`Failed to store WebAuthn credential for ${username}`);
    }
    return response;
  },
  removeWebAuthnCredential: async (username: string, credentialId: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const existing = await player.getWebAuthnCredentials(username);
    const filtered = existing.filter((c: any) => c.id !== credentialId);
    const json = filtered.length > 0 ? JSON.stringify(filtered) : null;
    const encoded = json ? Buffer.from(json).toString("base64") : null;
    const enabled = filtered.length > 0 ? 1 : 0;
    const response = await query(
      "UPDATE accounts SET webauthn_credentials = ?, webauthn_enabled = ? WHERE username = ?",
      [encoded, enabled, username]
    );
    return response;
  },
  setTwoFactorPending: async (username: string, pending: boolean) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = await query(
      "UPDATE accounts SET twofa_pending = ? WHERE username = ?",
      [pending ? 1 : 0, username]
    );
    return response;
  },
  isTwoFactorPending: async (username: string) => {
    if (!username) return false;
    username = username.toLowerCase();
    const response = (await query(
      "SELECT twofa_pending FROM accounts WHERE username = ?",
      [username]
    )) as any[];
    if (!response || response.length === 0) return false;
    return response[0].twofa_pending === 1;
  },
  getTwoFactorRequirements: async (username: string) => {
    if (!username) return { requireWebAuthn: false, requireTotp: false, requireEmail2FA: false };
    username = username.toLowerCase();
    const response = (await query(
      "SELECT require_webauthn, require_totp, require_email_2fa, totp_enabled, webauthn_enabled FROM accounts WHERE username = ?",
      [username]
    )) as any[];
    if (!response || response.length === 0) return { requireWebAuthn: false, requireTotp: false, requireEmail2FA: false };
    return {
      requireWebAuthn: response[0].require_webauthn === 1,
      requireTotp: response[0].require_totp === 1,
      requireEmail2FA: response[0].require_email_2fa === 1,
    };
  },
  setTwoFactorRequirement: async (username: string, method: string, value: boolean) => {
    if (!username) return;
    username = username.toLowerCase();
    const col = method === 'webauthn' ? 'require_webauthn' : method === 'totp' ? 'require_totp' : 'require_email_2fa';
    const response = await query(
      `UPDATE accounts SET ${col} = ? WHERE username = ?`,
      [value ? 1 : 0, username]
    );
    return response;
  },
};

export default player;