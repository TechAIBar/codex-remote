"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

function defaultCodexBinDir(env = process.env, home = os.homedir()) {
  return env.CODEX_BIN_DIR || path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "OpenAI", "Codex", "bin");
}

function loadConfig(file) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("Missing config.json. Copy config.example.json to config.json and customize it locally.");
    }
    throw error;
  }
  if (!Array.isArray(config.hosts)) throw new Error("config.hosts must be an array");
  return {
    ...config,
    hosts: config.hosts.map((host) => host.type === "local" && !host.codexBin && !host.codexBinDir
      ? { ...host, codexBinDir: defaultCodexBinDir() }
      : host),
  };
}
module.exports = { loadConfig, defaultCodexBinDir };
