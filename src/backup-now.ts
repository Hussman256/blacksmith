import { Backup } from "./backup.js";
import { config } from "./config.js";
import { Db } from "./db.js";

/** One-off: upload the local database snapshot (e.g. to seed a fresh host). */
const backup = Backup.fromEnv(config.dataDir);
if (!backup) throw new Error("Set BACKUP_GITHUB_REPO and BACKUP_GITHUB_TOKEN first (see .env.example)");
await backup.save(new Db(config.dataDir));
