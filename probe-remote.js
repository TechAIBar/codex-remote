// 验证：通过 ssh + codex app-server proxy 连远程守护进程。
// 远程守护进程的 socket 说的是 WebSocket，所以这里在 stdio 上手工做握手和帧。
const { spawn } = require("child_process");
const crypto = require("crypto");

const host = process.argv[2];
const sock = process.argv[3];
if (!host || !sock) {
  console.error("Usage: node probe-remote.js <ssh-host> <remote-socket-path>");
  process.exit(1);
}

const child = spawn("C:\\Windows\\System32\\OpenSSH\\ssh.exe", [
  "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-T", host,
  "codex app-server proxy --sock " + sock,
], { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => process.stderr.write("[ssh-err] " + d));
child.on("exit", (c) => console.log("[ssh exit]", c));

// ---- minimal websocket client over a duplex stream ----
const key = crypto.randomBytes(16).toString("base64");
const expectAccept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
child.stdin.write(
  "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
  "Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n"
);

let handshaken = false;
let buf = Buffer.alloc(0);
let nextId = 1;
const pending = new Map();

function sendText(str) {
  const payload = Buffer.from(str, "utf8");
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
  else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
  child.stdin.write(Buffer.concat([header, mask, masked]));
}

function onMessage(text) {
  let msg;
  try { msg = JSON.parse(text); } catch { console.log("[raw]", text.slice(0, 200)); return; }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
  } else if (msg.method) {
    console.log("[notif]", msg.method, JSON.stringify(msg.params || {}).slice(0, 140));
  }
}

let fragments = [];
child.stdout.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  if (!handshaken) {
    const end = buf.indexOf("\r\n\r\n");
    if (end < 0) return;
    const head = buf.slice(0, end).toString();
    buf = buf.slice(end + 4);
    if (!/ 101 /.test(head) || !head.includes(expectAccept)) { console.error("[ws] bad handshake:\n" + head); process.exit(1); }
    handshaken = true;
    console.log("[ws] handshake ok");
    start().catch((e) => { console.error("[probe] error:", e.message); child.kill(); process.exit(1); });
  }
  while (buf.length >= 2) {
    const fin = (buf[0] & 0x80) !== 0;
    const op = buf[0] & 0x0f;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    const masked = (buf[1] & 0x80) !== 0;
    if (masked) off += 4;
    if (buf.length < off + len) return;
    let payload = buf.slice(off, off + len);
    if (masked) { const m = buf.slice(off - 4, off); payload = Buffer.from(payload.map((b, i) => b ^ m[i & 3])); }
    buf = buf.slice(off + len);
    if (op === 0x8) { console.log("[ws] close frame"); child.kill(); process.exit(0); }
    if (op === 0x9) { continue; } // ping: ignore for probe
    if (op === 0x1 || op === 0x0) {
      fragments.push(payload);
      if (fin) { onMessage(Buffer.concat(fragments).toString("utf8")); fragments = []; }
    }
  }
});

function request(method, params) {
  const id = nextId++;
  sendText(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function start() {
  const t0 = Date.now();
  const init = await request("initialize", { clientInfo: { name: "codex-remote-probe", version: "0.0.1" }, capabilities: { experimentalApi: true } });
  console.log("[init]", JSON.stringify(init).slice(0, 300), "(" + (Date.now() - t0) + "ms)");
  sendText(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }));
  const list = await request("thread/list", { limit: 10, sortKey: "updated_at", sortDirection: "desc" });
  console.log("[thread/list] count =", list.data.length);
  for (const t of list.data) {
    const when = new Date(t.updatedAt * 1000).toISOString().replace("T", " ").slice(0, 16);
    console.log("  ", when, "|", (t.name || "(no name)").slice(0, 36).padEnd(36), "|", t.cwd, "|", t.status && t.status.type);
  }
  child.kill();
  process.exit(0);
}
setTimeout(() => { console.error("[probe] timeout"); child.kill(); process.exit(2); }, 40000);
