"use strict";
// 只读：区分"数据层没写进去" vs "写进去了但桌面端 UI 不刷新"
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const os = require("os");
const path = require("path");

const db = new DatabaseSync(path.join(os.homedir(), ".codex", "state_5.sqlite"), { readOnly: true });

console.log("== source 分布 ==");
for (const r of db.prepare("SELECT source, thread_source, COUNT(*) n, MAX(updated_at_ms) last FROM threads GROUP BY source, thread_source ORDER BY last DESC").all()) {
  console.log(String(r.n).padStart(5), "|", r.source, "/", r.thread_source, "| last", new Date(Number(r.last)).toISOString());
}

console.log("\n== 最近 6 小时内更新的会话 ==");
const since = Date.now() - 6 * 3600 * 1000;
const rows = db.prepare("SELECT id, rollout_path, updated_at_ms, source FROM threads WHERE updated_at_ms > ? ORDER BY updated_at_ms DESC").all(since);
for (const r of rows) {
  const p = String(r.rollout_path).replace(/^\\\\\?\\/, "");
  let st = null;
  try { st = fs.statSync(p); } catch {}
  console.log(
    r.id.slice(0, 8),
    "| db", new Date(Number(r.updated_at_ms)).toISOString(),
    "| file", st ? new Date(st.mtimeMs).toISOString() : "MISSING",
    "|", r.source
  );
}
db.close();
