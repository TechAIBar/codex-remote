// 验证脚本：分别连本机 app-server（stdio）和远程主机（ssh proxy），跑 thread/list。
// 用法: node probe.js            -> 本机
//       node probe.js <ssh-host> -> remote host
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const CODEX_BIN_DIR = require("./lib/config").defaultCodexBinDir();

function findLocalCodex() {
  const dirs = fs.readdirSync(CODEX_BIN_DIR).map((d) => path.join(CODEX_BIN_DIR, d));
  const candidates = dirs
    .map((d) => path.join(d, "codex.exe"))
    .filter((p) => fs.existsSync(p))
    .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!candidates.length) throw new Error("no codex.exe under " + CODEX_BIN_DIR);
  return candidates[0].p;
}

const host = process.argv[2];
let child;
if (host) {
  child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, "codex app-server proxy"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  console.log("[probe] ssh", host, "codex app-server proxy");
} else {
  const bin = findLocalCodex();
  child = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
  console.log("[probe] local", bin);
}

child.stderr.on("data", (d) => process.stderr.write("[stderr] " + d));
child.on("exit", (code) => console.log("[probe] child exited", code));

let buf = "";
let nextId = 1;
const pending = new Map();

child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.log("[raw]", line.slice(0, 200));
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      console.log("[notif]", msg.method, JSON.stringify(msg.params || {}).slice(0, 160));
    }
  }
});

function request(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

(async () => {
  const t0 = Date.now();
  const init = await request("initialize", {
    clientInfo: { name: "codex-remote-probe", version: "0.0.1" },
    capabilities: { experimentalApi: true },
  });
  console.log("[init]", JSON.stringify(init).slice(0, 300), "(" + (Date.now() - t0) + "ms)");
  notify("initialized", {});

  const list = await request("thread/list", { limit: 12, sortKey: "updated_at", sortDirection: "desc" });
  console.log("[thread/list] count =", list.data.length, "nextCursor =", list.nextCursor);
  for (const t of list.data) {
    const when = new Date(t.updatedAt * 1000).toISOString().replace("T", " ").slice(0, 16);
    console.log("  ", when, "|", (t.name || "(no name)").slice(0, 40).padEnd(40), "|", t.cwd, "|", t.status && t.status.type, "| turns", t.turns.length);
  }

  if (list.data.length) {
    const first = list.data[0];
    const rd = await request("thread/read", { threadId: first.id, includeTurns: true });
    const th = rd.thread || rd;
    console.log("[thread/read]", first.id, "turns =", (th.turns || []).length);
    for (const turn of (th.turns || []).slice(-2)) {
      for (const it of turn.items) {
        let preview = "";
        if (it.type === "userMessage") preview = it.content.map((c) => c.text || "[" + c.type + "]").join(" ");
        else if (it.type === "agentMessage") preview = it.text;
        else if (it.type === "commandExecution") preview = it.command;
        else preview = "";
        console.log("    [" + it.type + "]", preview.replace(/\s+/g, " ").slice(0, 100));
      }
    }
  }
  child.kill();
  process.exit(0);
})().catch((e) => {
  console.error("[probe] error:", e.message);
  child.kill();
  process.exit(1);
});
