"use strict";
// 登录鉴权：口令 -> 随机 token(cookie)。含失败锁定、token 持久化、一键作废。
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SCRYPT_N = 16384;

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64, { N: SCRYPT_N }).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const h = crypto.scryptSync(password, rec.salt, 64, { N: SCRYPT_N });
  const a = Buffer.from(rec.hash, "hex");
  return a.length === h.length && crypto.timingSafeEqual(a, h);
}

class Auth {
  constructor(dataDir, opts) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, "auth.json");
    this.ttlMs = (opts && opts.tokenTtlDays ? opts.tokenTtlDays : 30) * 86400000;
    this.maxFails = (opts && opts.maxFails) || 5;
    this.lockMs = (opts && opts.lockMinutes ? opts.lockMinutes : 15) * 60000;
    this.fails = new Map(); // ip -> { count, until }
    this.attempts = []; // recent login attempts for display
    this._load();
  }
  _load() {
    try {
      this.state = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      this.state = { password: null, tokens: {} };
    }
    if (!this.state.tokens) this.state.tokens = {};
  }
  _save() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }
  hasPassword() {
    return !!this.state.password;
  }
  setPassword(pw) {
    this.state.password = hashPassword(pw);
    this.state.tokens = {};
    this._save();
  }
  isLocked(ip) {
    const f = this.fails.get(ip);
    if (!f) return false;
    if (f.until && Date.now() < f.until) return true;
    if (f.until && Date.now() >= f.until) this.fails.delete(ip);
    return false;
  }
  login(pw, ip, ua) {
    if (this.isLocked(ip)) return { ok: false, reason: "locked" };
    const ok = verifyPassword(pw || "", this.state.password);
    this.attempts.unshift({ at: Date.now(), ip, ua: (ua || "").slice(0, 80), ok });
    this.attempts = this.attempts.slice(0, 50);
    if (!ok) {
      const f = this.fails.get(ip) || { count: 0 };
      f.count++;
      if (f.count >= this.maxFails) {
        f.until = Date.now() + this.lockMs;
        f.count = 0;
      }
      this.fails.set(ip, f);
      return { ok: false, reason: "bad" };
    }
    this.fails.delete(ip);
    const token = crypto.randomBytes(32).toString("hex");
    this.state.tokens[token] = { at: Date.now(), ip, ua: (ua || "").slice(0, 80) };
    this._gc();
    this._save();
    return { ok: true, token };
  }
  check(token) {
    if (!token) return false;
    const rec = this.state.tokens[token];
    if (!rec) return false;
    if (Date.now() - rec.at > this.ttlMs) {
      delete this.state.tokens[token];
      this._save();
      return false;
    }
    return true;
  }
  revokeAll() {
    this.state.tokens = {};
    this._save();
  }
  _gc() {
    const now = Date.now();
    for (const [t, r] of Object.entries(this.state.tokens)) if (now - r.at > this.ttlMs) delete this.state.tokens[t];
  }
  sessions() {
    return Object.values(this.state.tokens).map((r) => ({ at: r.at, ip: r.ip, ua: r.ua }));
  }
}

module.exports = { Auth, hashPassword, verifyPassword };
