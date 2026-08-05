import fs from "node:fs";
import path from "node:path";

/**
 * Append-only JSONL audit log for write operations.
 * Each line: { ts, openId, action, detail, ok, error? }
 */
export function createAuditLog(logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  return {
    write(entry) {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
      try {
        fs.appendFileSync(logPath, line, "utf8");
      } catch (e) {
        console.error("[audit] write failed:", e.message);
      }
    },
  };
}
