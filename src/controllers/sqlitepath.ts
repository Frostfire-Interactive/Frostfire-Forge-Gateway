import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export function resolveSqlitePath(env: Record<string, string | undefined> = process.env): string {
  const custom = env.DATABASE_PATH?.trim();
  if (custom) {
    const dir = path.dirname(custom);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return custom;
  }

  const dbDir = path.join(os.tmpdir(), "frostfire_forge");
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  return env.DATABASE_NAME ? path.join(dbDir, `${env.DATABASE_NAME}.sqlite`) : "./database.sqlite";
}
