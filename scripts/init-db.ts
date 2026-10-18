/**
 * Initialise the Ryomen SQLite database (creates tables if missing).
 * Usage: npm run db:init
 */
import { closeDb, getDb } from "../src/lib/db/index";
import { COINS } from "../src/lib/coins";
import { STRATEGIES } from "../src/lib/strategies";
import { config } from "../src/lib/config";

const db = getDb();
const tables = db
  .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
  .all() as { name: string }[];

console.log("Ryomen database ready");
console.log("  path       :", config.db.path);
console.log("  tables     :", tables.map((t) => t.name).join(", "));
console.log("  coins      :", COINS.length);
console.log("  strategies :", STRATEGIES.length, `(${STRATEGIES.map((s) => s.id).join(", ")})`);
closeDb();
