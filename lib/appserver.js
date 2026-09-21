"use strict";
// 统一的 app-server 客户端：
//   LocalHost  -> 拉起本机 codex.exe app-server（stdio, 每行一个 JSON-RPC）
//   RemoteHost -> ssh <host> "codex app-server proxy --sock <path>"，管道上说 WebSocket
// 对外暴露同一套接口：request(method, params) / on("notification") / on("serverRequest") / respond(id, result)
const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { acceptKey, encodeFrame, FrameParser } = require("./wsframe");

class AppServerConnection extends EventEmitter {
  constructor(hostCfg, log) {
    super();
    this.cfg = hostCfg;
    this.log = log || (() => {});
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.ready = null;
    this.closed = false;
    this.initInfo = null;
  }

  // 子类实现：spawn 子进程并接好 send/recv
  _spawn() {
    throw new Error("not implemented");
  }

  connect() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      try {
        this._spawn();
      } catch (e) {
        this.ready = null;
        return reject(e);
      }
      const timer = setTimeout(() => reject(new Error("initialize timeout")), 30000);
      this._handshake()
        .then(() => this.request("initialize", {
          clientInfo: { name: "codex-remote", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        }))
        .then((info) => {
          clearTimeout(timer);
          this.initInfo = info;
          this.notify("initialized", {});
          this.log("connected: " + (info && info.userAgent));
          resolve(info);
        })
        .catch((e) => {
          clearTimeout(timer);
          this.ready = null;
          this.close();
          reject(e);
        });
    });
    return this.ready;
  }

  _handshake() {
    return Promise.resolve();
  }

  _onLine(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      this.log("non-json: " + text.slice(0, 200));
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message || JSON.stringify(msg.error)), { rpc: msg.error }));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method && msg.id !== undefined) {
      // server -> client request (approvals, user input, ...)
      this.emit("serverRequest", msg);
      return;
    }
    if (msg.method) this.emit("notification", msg);
  }

  request(method, params) {
    if (this.closed) return Promise.reject(new Error("connection closed"));
    const id = this.nextId++;
    this._send(JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  notify(method, params) {
    this._send(JSON.stringify({ jsonrpc: "2.0", method, params: params || {} }));
  }
  respond(id, result) {
    this._send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }
  respondError(id, message) {
    this._send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }));
  }

  _onExit(code) {
    if (this.closed) return;
    this.closed = true;
    this.log("child exited " + code);
    for (const p of this.pending.values()) p.reject(new Error("connection closed"));
    this.pending.clear();
    this.emit("close", code);
  }

  close() {
    if (this.child && !this.closed) {
      try { this.child.kill(); } catch {}
    }
    this._onExit("killed");
  }
}

// ---------- 本机：stdio ----------
class LocalConnection extends AppServerConnection {
  static findCodex(binDir) {
    const dirs = fs.readdirSync(binDir).map((d) => path.join(binDir, d, "codex.exe"));
    const found = dirs.filter((p) => fs.existsSync(p)).map((p) => ({ p, m: fs.statSync(p).mtimeMs })).sort((a, b) => b.m - a.m);
    if (!found.length) throw new Error("codex.exe not found under " + binDir);
    return found[0].p;
  }
  _spawn() {
    const bin = this.cfg.codexBin || LocalConnection.findCodex(this.cfg.codexBinDir);
    this.log("spawn " + bin + " app-server");
    this.child = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let buf = "";
    this.child.stdout.on("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this._onLine(line);
      }
    });
    this.child.stderr.on("data", (d) => {
      const s = d.toString();
      if (!/state db discrepancy/.test(s)) this.log("stderr: " + s.trim().slice(0, 300));
    });
    this.child.on("exit", (c) => this._onExit(c));
    this.child.on("error", (e) => { this.log("spawn error " + e.message); this._onExit(-1); });
  }
  _send(text) {
    this.child.stdin.write(text + "\n");
  }
}

// ---------- 远程：ssh + proxy + websocket ----------
class RemoteConnection extends AppServerConnection {
  _spawn() {
    const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=30", "-T", this.cfg.ssh];
    const cmd = "codex app-server proxy" + (this.cfg.sock ? " --sock " + this.cfg.sock : "");
    args.push(cmd);
    this.log("spawn ssh " + this.cfg.ssh + " " + cmd);
    this.child = spawn(this.cfg.sshBin || "ssh", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.parser = new FrameParser();
    this.handshaken = false;
    this.head = Buffer.alloc(0);
    this.child.stderr.on("data", (d) => this.log("ssh: " + d.toString().trim().slice(0, 300)));
    this.child.on("exit", (c) => this._onExit(c));
    this.child.on("error", (e) => { this.log("spawn error " + e.message); this._onExit(-1); });
  }
  _handshake() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString("base64");
      const expect = acceptKey(key);
      const timer = setTimeout(() => reject(new Error("websocket handshake timeout (ssh/proxy)")), 25000);
      this.child.stdout.on("data", (chunk) => {
        if (!this.handshaken) {
          this.head = Buffer.concat([this.head, chunk]);
          const end = this.head.indexOf("\r\n\r\n");
          if (end < 0) return;
          const headText = this.head.subarray(0, end).toString();
          const rest = this.head.subarray(end + 4);
          this.head = null;
          if (!/ 101 /.test(headText) || !headText.includes(expect)) {
            clearTimeout(timer);
            return reject(new Error("bad websocket handshake: " + headText.slice(0, 200)));
          }
          this.handshaken = true;
          clearTimeout(timer);
          resolve();
          chunk = rest;
          if (!chunk.length) return;
        }
        for (const f of this.parser.push(chunk)) {
          if (f.opcode === 1) this._onLine(f.data.toString("utf8"));
          else if (f.opcode === 9) this.child.stdin.write(encodeFrame(f.data, 10, true));
          else if (f.opcode === 8) this.close();
        }
      });
      this.child.stdin.write(
        "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n"
      );
    });
  }
  _send(text) {
    this.child.stdin.write(encodeFrame(text, 1, true));
  }
}

function createConnection(hostCfg, log) {
  if (hostCfg.type === "local") return new LocalConnection(hostCfg, log);
  if (hostCfg.type === "ssh") return new RemoteConnection(hostCfg, log);
  throw new Error("unknown host type " + hostCfg.type);
}

module.exports = { createConnection, LocalConnection, RemoteConnection };
