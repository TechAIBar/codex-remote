"use strict";
// codex-remote 网关：HTTPS + 登录鉴权 + 浏览器 WebSocket，桥接到本机/远程 app-server。
// 零外部依赖，只用 Node 内置模块。
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { acceptKey, encodeFrame, FrameParser } = require("./lib/wsframe");
const { createConnection } = require("./lib/appserver");
const { Auth } = require("./lib/auth");
const { ensureCert } = require("./lib/cert");
const { loadConfig } = require("./lib/config");

const ROOT = __dirname;
const DATA = path.join(ROOT, "data");
const PUBLIC = path.join(ROOT, "public");
const CONFIG_PATH = path.join(ROOT, "config.json");

function log(...a) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log("[" + ts + "]", ...a);
}

const config = loadConfig(CONFIG_PATH);
const auth = new Auth(DATA, config.auth || {});

// ---------- CLI: set-password / revoke ----------
const argv = process.argv.slice(2);
if (argv[0] === "set-password") {
  const pw = argv[1];
  if (!pw || pw.length < 8) {
    console.error("用法: node server.js set-password <至少8位口令>");
    process.exit(1);
  }
  auth.setPassword(pw);
  console.log("口令已设置，所有已登录设备已被注销。");
  process.exit(0);
}
if (argv[0] === "revoke") {
  auth.revokeAll();
  console.log("所有登录 token 已作废。");
  process.exit(0);
}
if (!auth.hasPassword()) {
  console.error("尚未设置登录口令。先运行: node server.js set-password <口令>");
  process.exit(1);
}

// ---------- host connections ----------
const hosts = new Map(); // hostId -> { cfg, conn, clients:Set }
for (const h of config.hosts) hosts.set(h.id, { cfg: h, conn: null, connecting: null, lastError: null });

async function getConn(hostId) {
  const h = hosts.get(hostId);
  if (!h) throw new Error("unknown host " + hostId);
  if (h.conn && !h.conn.closed) return h.conn;
  if (h.connecting) return h.connecting;
  const conn = createConnection(h.cfg, (m) => log("[" + hostId + "]", m));
  h.connecting = conn
    .connect()
    .then(() => {
      h.conn = conn;
      h.connecting = null;
      h.lastError = null;
      conn.on("notification", (msg) => broadcast(hostId, { kind: "notification", host: hostId, method: msg.method, params: msg.params }));
      // 桌面端或别的客户端在同一 app-server 上答了审批，这里同步清理
      conn.on("notification", (msg) => {
        if (msg.method === "serverRequest/resolved" && msg.params) {
          const key = hostId + ":" + msg.params.requestId;
          if (pendingServerRequests.delete(key)) broadcast(hostId, { kind: "serverRequestResolved", host: hostId, requestId: msg.params.requestId });
        }
      });
      conn.on("serverRequest", (msg) => onServerRequest(hostId, conn, msg));
      conn.on("close", () => {
        h.conn = null;
        for (const [rid, r] of pendingServerRequests) if (r.host === hostId) pendingServerRequests.delete(rid);
        broadcast(hostId, { kind: "hostStatus", host: hostId, status: "disconnected" });
      });
      broadcast(hostId, { kind: "hostStatus", host: hostId, status: "connected" });
      return conn;
    })
    .catch((e) => {
      h.connecting = null;
      h.lastError = e.message;
      broadcast(hostId, { kind: "hostStatus", host: hostId, status: "error", error: e.message });
      throw e;
    });
  return h.connecting;
}

// server -> client requests (approvals etc.) are held until a browser answers
const pendingServerRequests = new Map(); // key host:id -> { host, conn, msg, at }
function onServerRequest(hostId, conn, msg) {
  const key = hostId + ":" + msg.id;
  // 自动处理不需要人的请求
  if (msg.method === "currentTime/read") {
    conn.respond(msg.id, { currentTime: new Date().toISOString() });
    return;
  }
  // 只有 ChatGPT 桌面端能答的请求（token 刷新、attestation、动态工具），这里直接回错，避免卡住整轮
  if (msg.method === "account/chatgptAuthTokens/refresh" || msg.method === "attestation/generate" || msg.method === "item/tool/call") {
    conn.respondError(msg.id, "not supported by codex-remote");
    log("[" + hostId + "] auto-declined server request", msg.method);
    return;
  }
  pendingServerRequests.set(key, { host: hostId, conn, msg, at: Date.now() });
  broadcast(hostId, { kind: "serverRequest", host: hostId, requestId: msg.id, method: msg.method, params: msg.params });
  log("[" + hostId + "] server request", msg.method, "id", msg.id);
}

// ---------- browser websocket clients ----------
const clients = new Set(); // { socket, send(obj) }
function broadcast(hostId, obj) {
  const text = JSON.stringify(obj);
  for (const c of clients) c.send(text);
}

async function handleClientMessage(client, msg) {
  const reply = (obj) => client.send(JSON.stringify(Object.assign({ kind: "reply", reqId: msg.reqId }, obj)));
  try {
    switch (msg.type) {
      case "hosts": {
        const list = [];
        for (const [id, h] of hosts) list.push({ id, label: h.cfg.label || id, type: h.cfg.type, status: h.conn && !h.conn.closed ? "connected" : h.connecting ? "connecting" : "idle", lastError: h.lastError });
        return reply({ result: list });
      }
      case "connect": {
        await getConn(msg.host);
        return reply({ result: true });
      }
      case "rpc": {
        if (!ALLOWED_METHODS.has(msg.method)) return reply({ error: "method not allowed: " + msg.method });
        const conn = await getConn(msg.host);
        const params = msg.params || {};
        // 协议要求 text 输入带 text_elements，浏览器端不填时这里补齐
        if ((msg.method === "turn/start" || msg.method === "turn/steer") && Array.isArray(params.input)) {
          for (const it of params.input) if (it && it.type === "text" && !Array.isArray(it.text_elements)) it.text_elements = [];
        }
        const result = await conn.request(msg.method, params);
        return reply({ result });
      }
      case "respond": {
        const key = msg.host + ":" + msg.requestId;
        const p = pendingServerRequests.get(key);
        if (!p) return reply({ error: "request no longer pending" });
        pendingServerRequests.delete(key);
        p.conn.respond(msg.requestId, msg.result);
        broadcast(msg.host, { kind: "serverRequestResolved", host: msg.host, requestId: msg.requestId });
        return reply({ result: true });
      }
      case "pendingRequests": {
        const out = [];
        for (const [, p] of pendingServerRequests) out.push({ host: p.host, requestId: p.msg.id, method: p.msg.method, params: p.msg.params, at: p.at });
        return reply({ result: out });
      }
      case "loginAttempts":
        return reply({ result: { attempts: auth.attempts, sessions: auth.sessions() } });
      case "revokeAll":
        auth.revokeAll();
        return reply({ result: true });
      default:
        return reply({ error: "unknown type " + msg.type });
    }
  } catch (e) {
    reply({ error: e.message, rpc: e.rpc });
  }
}

// 只放行对话相关的方法，不暴露文件系统 / 进程 / 配置写入等能力
const ALLOWED_METHODS = new Set([
  "thread/list", "thread/read", "thread/resume", "thread/start", "thread/turns/list", "thread/items/list",
  "thread/name/set", "thread/loaded/list", "thread/unsubscribe", "threadSection/list",
  "turn/start", "turn/interrupt", "turn/steer",
  "model/list", "collaborationMode/list", "account/read", "account/rateLimits/read",
]);

// ---------- HTTP ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function clientIp(req) {
  return (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (d) => { b += d; if (b.length > (limit || 65536)) { reject(new Error("body too large")); req.destroy(); } });
    req.on("end", () => resolve(b));
  });
}
function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, headers || {}));
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}
function serveFile(res, file) {
  const ext = path.extname(file);
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: "not found" });
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  });
}

const tls = ensureCert(DATA, [config.hostname, os.hostname()].concat(config.extraNames || []), log);
const server = https.createServer({ pfx: tls.pfx, passphrase: tls.passphrase, minVersion: "TLSv1.2" }, async (req, res) => {
  const url = new URL(req.url, "https://x");
  const ip = clientIp(req);
  const cookies = parseCookies(req);
  const authed = auth.check(cookies.crt);
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");

  if (req.method === "POST" && url.pathname === "/api/login") {
    let body;
    try { body = JSON.parse(await readBody(req, 4096)); } catch { return send(res, 400, { error: "bad json" }); }
    const r = auth.login(body.password, ip, req.headers["user-agent"]);
    log("login from", ip, r.ok ? "OK" : "FAIL(" + r.reason + ")");
    if (!r.ok) return send(res, 401, { error: r.reason === "locked" ? "尝试次数过多，请 15 分钟后再试" : "口令错误" });
    return send(res, 200, { ok: true }, { "Set-Cookie": "crt=" + r.token + "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=" + Math.floor(auth.ttlMs / 1000) });
  }
  if (req.method === "POST" && url.pathname === "/api/logout") {
    return send(res, 200, { ok: true }, { "Set-Cookie": "crt=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0" });
  }
  if (url.pathname === "/api/me") return send(res, 200, { authed });
  // 证书公钥下载：装到手机的"受信任的 CA"后浏览器不再警告。放在登录前也无妨（公钥不是秘密）。
  if (url.pathname === "/cert.cer") {
    if (!tls.cerPath) return send(res, 404, { error: "no cer" });
    res.writeHead(200, { "Content-Type": "application/x-x509-ca-cert", "Content-Disposition": "attachment; filename=codex-remote.cer", "Cache-Control": "no-store" });
    return fs.createReadStream(tls.cerPath).pipe(res);
  }

  // 登录页与静态资源：未登录只给登录页
  if (!authed) {
    if (url.pathname === "/" || url.pathname === "/login" || url.pathname === "/index.html") return serveFile(res, path.join(PUBLIC, "login.html"));
    if (url.pathname === "/style.css") return serveFile(res, path.join(PUBLIC, "style.css"));
    return send(res, 401, { error: "unauthorized" });
  }
  let file = url.pathname === "/" ? "/index.html" : url.pathname;
  file = path.normalize(file).replace(/^([.][.][\\/])+/, "");
  const abs = path.join(PUBLIC, file);
  if (!abs.startsWith(PUBLIC)) return send(res, 403, { error: "forbidden" });
  return serveFile(res, abs);
});

// ---------- WebSocket upgrade ----------
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "https://x");
  const cookies = parseCookies(req);
  if (url.pathname !== "/ws" || !auth.check(cookies.crt)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + acceptKey(key) + "\r\n\r\n");
  const parser = new FrameParser();
  const client = {
    ip: clientIp(req),
    send(text) { if (!socket.destroyed) socket.write(encodeFrame(text, 1, false)); },
  };
  clients.add(client);
  log("ws client connected from", client.ip, "(total " + clients.size + ")");
  const onData = (chunk) => {
    for (const f of parser.push(chunk)) {
      if (f.opcode === 8) { socket.end(encodeFrame(Buffer.alloc(0), 8, false)); return; }
      if (f.opcode === 9) { socket.write(encodeFrame(f.data, 10, false)); continue; }
      if (f.opcode !== 1) continue;
      let msg;
      try { msg = JSON.parse(f.data.toString("utf8")); } catch { continue; }
      handleClientMessage(client, msg);
    }
  };
  if (head && head.length) onData(head);
  socket.on("data", onData);
  const bye = () => { clients.delete(client); log("ws client left", client.ip, "(total " + clients.size + ")"); };
  socket.on("close", bye);
  socket.on("error", bye);
  // keepalive ping
  const ping = setInterval(() => { if (socket.destroyed) clearInterval(ping); else socket.write(encodeFrame(Buffer.alloc(0), 9, false)); }, 25000);
});

server.listen(config.port, config.bind || "0.0.0.0", () => {
  log("codex-remote listening on https://" + (config.bind || "0.0.0.0") + ":" + config.port);
  const nets = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(nets)) for (const a of addrs) if (a.family === "IPv4" && !a.internal) log("  " + name + ": https://" + a.address + ":" + config.port);
});

// 预连本机，远程按需
for (const [id, h] of hosts) if (h.cfg.type === "local" && h.cfg.autoConnect !== false) getConn(id).catch((e) => log("[" + id + "] connect failed:", e.message));

process.on("SIGINT", () => { for (const [, h] of hosts) if (h.conn) h.conn.close(); process.exit(0); });
