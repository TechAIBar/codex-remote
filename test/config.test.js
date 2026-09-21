"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadConfig, defaultCodexBinDir } = require("../lib/config");

function fixture(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config.json");
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
}

test("example configuration starts with a portable local host", () => {
  const config = loadConfig(path.join(__dirname, "..", "config.example.json"));
  assert.equal(config.hosts.length, 1);
  assert.equal(config.hosts[0].type, "local");
  assert.equal(config.hosts[0].codexBinDir, defaultCodexBinDir());
});

test("machine overrides and remote hosts are preserved", (t) => {
  const hosts = [
    { id: "custom", type: "local", codexBinDir: "custom-bin" },
    { id: "binary", type: "local", codexBin: "custom-codex.exe" },
    { id: "remote", type: "ssh", ssh: "my-remote", sock: "/path/to/control.sock" },
  ];
  const config = loadConfig(fixture(t, "\uFEFF" + JSON.stringify({ hosts })));
  assert.deepEqual(config.hosts, hosts);
});

test("missing local configuration gives setup instructions", (t) => {
  assert.throws(() => loadConfig(fixture(t)), /Copy config\.example\.json/);
});

test("invalid configuration fails instead of falling back silently", (t) => {
  assert.throws(() => loadConfig(fixture(t, "{")), SyntaxError);
  assert.throws(() => loadConfig(fixture(t, "{}")), /hosts must be an array/);
});

test("Codex location respects environment overrides and home fallback", () => {
  assert.equal(defaultCodexBinDir({ CODEX_BIN_DIR: "override" }, "home"), "override");
  assert.equal(defaultCodexBinDir({ LOCALAPPDATA: "local-app-data" }, "home"), path.join("local-app-data", "OpenAI", "Codex", "bin"));
  assert.equal(defaultCodexBinDir({}, "home"), path.join("home", "AppData", "Local", "OpenAI", "Codex", "bin"));
});
