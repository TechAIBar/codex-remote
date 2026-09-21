"use strict";
// 只读探查 ~/.codex/state_5.sqlite：看本机桌面端与网关是否共用同一份线程存储
const { DatabaseSync } = require("node:sqlite");
const os = require("os");
const path = require("path");

const db = new DatabaseSync(path.join(os.homedir(), ".codex", "state_5.sqlite"), { readOnly: true });

const rows = db
  .prepare(
    "SELECT id, substr(cwd,1,60) cwd, substr(coalesce(name,title,preview,''),1,50) label, source, thread_source, updated_at_ms, rollout_path FROM threads ORDER BY updated_at_ms DESC LIMIT 12"
  )
  .all();
for (const r of rows) {
  console.log(
    new Date(Number(r.updated_at_ms)).toISOString(),
    "|", r.id.slice(0, 8),
    "|", r.source, "/", r.thread_source,
    "|", r.cwd,
    "|", JSON.stringify(r.label)
  );
  console.log("      rollout:", r.rollout_path);
}

console.log("\nenrollments:", JSON.stringify(db.prepare("SELECT * FROM remote_control_enrollments").all()));
db.close();
