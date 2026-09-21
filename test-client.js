// 端到端自测：模拟手机浏览器走 HTTPS 登录 -> WebSocket -> hosts/thread list/resume/read。
// 用法: node test-client.js <口令> [host] [--send "消息"]
const https = require("https");
const crypto = require("crypto");
const { acceptKey, encodeFrame, FrameParser } = require("./lib/wsframe");

const PW = process.argv[2];
const HOST = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : "local";
const sendIdx = process.argv.indexOf("--send");
const SEND = sendIdx > 0 ? process.argv[sendIdx + 1] : null;
const threadIdx = process.argv.indexOf("--thread");
const THREAD = threadIdx > 0 ? process.argv[threadIdx + 1] : null;
if (!PW) { console.error("用法: node test-client.js <口令> [host] [--thread id] [--send 消息]"); process.exit(1); }

function post(path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({ host: "127.0.0.1", port: 8443, path, method: "POST", rejectUnauthorized: false, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), Cookie: cookie || "" } }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on("error", reject); req.end(data);
  });
}
function get(path, cookie) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: "127.0.0.1", port: 8443, path, method: "GET", rejectUnauthorized: false, headers: { Cookie: cookie || "" } }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    req.on("error", reject); req.end();
  });
}

(async () => {
  const bad = await post("/api/login", { password: "wrong-password" });
  console.log("[login wrong]", bad.status, bad.body);
  const ok = await post("/api/login", { password: PW });
  console.log("[login ok]", ok.status, ok.body);
  if (ok.status !== 200) process.exit(1);
  const cookie = (ok.headers["set-cookie"] || [])[0].split(";")[0];
  const noauth = await get("/app.js");
  console.log("[GET /app.js no cookie]", noauth.status);
  const withauth = await get("/app.js", cookie);
  console.log("[GET /app.js cookie]", withauth.status, withauth.body.length + " bytes");
  const cer = await get("/cert.cer");
  console.log("[GET /cert.cer]", cer.status, cer.body.length + " bytes");

  // websocket
  const key = crypto.randomBytes(16).toString("base64");
  const req = https.request({ host: "127.0.0.1", port: 8443, path: "/ws", method: "GET", rejectUnauthorized: false, headers: { Cookie: cookie, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13" } });
  const socket = await new Promise((resolve, reject) => {
    req.on("upgrade", (res, sock) => { if (res.headers["sec-websocket-accept"] !== acceptKey(key)) return reject(new Error("bad accept")); resolve(sock); });
    req.on("response", (res) => reject(new Error("no upgrade, status " + res.statusCode)));
    req.on("error", reject); req.end();
  });
  console.log("[ws] upgraded");
  const parser = new FrameParser(); const pending = new Map(); let reqId = 1;
  const events = [];
  socket.on("data", (chunk) => {
    for (const f of parser.push(chunk)) {
      if (f.opcode === 9) { socket.write(encodeFrame(f.data, 10, true)); continue; }
      if (f.opcode !== 1) continue;
      const msg = JSON.parse(f.data.toString("utf8"));
      if (msg.kind === "reply") { const p = pending.get(msg.reqId); if (p) { pending.delete(msg.reqId); msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result); } }
      else { events.push(msg); const s = JSON.stringify(msg.params || msg).slice(0, 160); console.log("  <-", msg.kind, msg.method || msg.status || "", s); }
    }
  });
  const call = (type, payload) => new Promise((resolve, reject) => { const id = reqId++; pending.set(id, { resolve, reject }); socket.write(encodeFrame(JSON.stringify(Object.assign({ type, reqId: id }, payload || {})), 1, true)); });
  const rpc = (method, params) => call("rpc", { host: HOST, method, params });

  console.log("[hosts]", JSON.stringify(await call("hosts")));
  try { await rpc("fs/readFile", { path: "C:\\x" }); console.log("[whitelist] FAIL: fs/readFile allowed"); } catch (e) { console.log("[whitelist] ok:", e.message); }
  const list = await rpc("thread/list", { limit: 8, sortKey: "updated_at", sortDirection: "desc" });
  console.log("[thread/list]", list.data.length, "threads, nextCursor", !!list.nextCursor);
  for (const t of list.data) console.log("   ", t.id.slice(0, 8), "|", (t.name || t.preview || "").replace(/\s+/g, " ").slice(0, 40).padEnd(40), "|", t.cwd, "|", t.status.type);
  // --thread 允许只给前缀
  const target = THREAD ? ((list.data.find((t) => t.id.startsWith(THREAD)) || {}).id || THREAD) : (list.data[0] && list.data[0].id);
  if (!target) return socket.end();
  const t0 = Date.now();
  const rs = await rpc("thread/resume", { threadId: target });
  const th = rs.thread;
  console.log("[thread/resume]", (Date.now() - t0) + "ms", "turns", th.turns.length, "itemsView", th.turns.map((t) => t.itemsView).slice(-3), "status", th.status.type, "cwd", rs.cwd);
  const rd = await rpc("thread/read", { threadId: target, includeTurns: true });
  console.log("[thread/read] turns", rd.thread.turns.length, "items in last turn", rd.thread.turns.length ? rd.thread.turns[rd.thread.turns.length - 1].items.length : 0);
  const last = rd.thread.turns[rd.thread.turns.length - 1];
  if (last) for (const it of last.items.slice(-4)) console.log("    [" + it.type + "]", (it.text || (it.content && it.content.map((c) => c.text).join(" ")) || it.command || "").replace(/\s+/g, " ").slice(0, 100));

  if (SEND) {
    console.log("[turn/start] sending:", SEND);
    const ts = await rpc("turn/start", { threadId: target, input: [{ type: "text", text: SEND }] });
    console.log("[turn/start] turn", ts.turn.id, ts.turn.status);
    await new Promise((resolve) => {
      const t = setTimeout(() => { console.log("[turn] timeout, interrupting"); rpc("turn/interrupt", { threadId: target, turnId: ts.turn.id }).catch(() => {}); setTimeout(resolve, 3000); }, 90000);
      const iv = setInterval(() => { if (events.some((e) => e.method === "turn/completed" && e.params.turn && e.params.turn.id === ts.turn.id)) { clearInterval(iv); clearTimeout(t); resolve(); } }, 300);
    });
    const done = events.find((e) => e.method === "turn/completed");
    if (done) for (const it of done.params.turn.items) console.log("    [" + it.type + "]", (it.text || it.command || "").replace(/\s+/g, " ").slice(0, 300));
  }

  if (process.argv.includes("--approval-test")) {
    // 新开一条 untrusted 策略的对话，让它跑一条命令，验证审批请求能到浏览器、拒绝后轮次能结束
    const st = await rpc("thread/start", { cwd: __dirname, approvalPolicy: "untrusted" });
    console.log("[thread/start]", st.thread.id, "approvalPolicy", JSON.stringify(st.approvalPolicy));
    const ts = await rpc("turn/start", { threadId: st.thread.id, input: [{ type: "text", text: "请用 shell 执行命令 node -e \"console.log(42)\" 并告诉我输出。不要解释，直接执行。" }] });
    console.log("[turn/start]", ts.turn.id);
    const reqEv = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 90000);
      const iv = setInterval(() => { const e = events.find((x) => x.kind === "serverRequest" && x.params && x.params.threadId === st.thread.id); if (e) { clearInterval(iv); clearTimeout(t); resolve(e); } }, 300);
    });
    if (!reqEv) { console.log("[approval] no server request within 90s; interrupting"); await rpc("turn/interrupt", { threadId: st.thread.id, turnId: ts.turn.id }).catch(() => {}); }
    else {
      console.log("[approval] got", reqEv.method, "command:", reqEv.params.command, "reason:", reqEv.params.reason);
      const pend = await call("pendingRequests");
      console.log("[pendingRequests]", pend.length, pend.map((p) => p.method));
      const rr = await call("respond", { host: HOST, requestId: reqEv.requestId, result: { decision: "decline" } });
      console.log("[respond decline]", rr);
      await new Promise((resolve) => { const t = setTimeout(resolve, 60000); const iv = setInterval(() => { if (events.some((e) => e.method === "turn/completed" && e.params.turn.id === ts.turn.id)) { clearInterval(iv); clearTimeout(t); resolve(); } }, 300); });
      const done = events.find((e) => e.method === "turn/completed" && e.params.turn.id === ts.turn.id);
      console.log("[turn] status", done ? done.params.turn.status : "(no completion)");
      if (done) for (const it of done.params.turn.items) console.log("    [" + it.type + "]", (it.text || it.command || "").replace(/\s+/g, " ").slice(0, 200), it.status || "");
    }
  }
  socket.end();
  process.exit(0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
