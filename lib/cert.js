"use strict";
// 自签证书：用 Windows 自带的 PowerShell New-SelfSignedCertificate 生成并导出 pfx，
// 存到 data/cert.pfx（口令随机生成存在 data/cert.pass），存在就直接复用。
// 同时导出 data/cert.cer（仅公钥），网关在 /cert.cer 提供下载，手机装成信任证书后就没有警告。
// Node 的 https 直接加载 pfx，不需要 openssl。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { spawnSync } = require("child_process");

function localIPv4s() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) for (const a of addrs) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  return out;
}

function ensureCert(dataDir, hostnames, log) {
  const pfxPath = path.join(dataDir, "cert.pfx");
  const passPath = path.join(dataDir, "cert.pass");
  const cerPath = path.join(dataDir, "cert.cer");
  if (fs.existsSync(pfxPath) && fs.existsSync(passPath)) {
    return { pfx: fs.readFileSync(pfxPath), passphrase: fs.readFileSync(passPath, "utf8").trim(), cerPath: fs.existsSync(cerPath) ? cerPath : null };
  }
  fs.mkdirSync(dataDir, { recursive: true });
  // SAN 里放：localhost、本机所有 IPv4（含 VPN 网卡）、配置里的 hostname/extraNames
  const names = Array.from(new Set(["localhost", "127.0.0.1"].concat(localIPv4s(), hostnames.filter(Boolean))));
  const san = names.map((h) => (/^\d+\.\d+\.\d+\.\d+$/.test(h) ? "IPAddress=" + h : "DNS=" + h)).join("&");
  const passphrase = crypto.randomBytes(18).toString("base64url");
  const ps = [
    "$ErrorActionPreference='Stop'",
    "$c = New-SelfSignedCertificate -Subject 'CN=codex-remote' -TextExtension @('2.5.29.17={text}" + san + "') -KeyAlgorithm RSA -KeyLength 2048 -NotAfter (Get-Date).AddYears(5) -CertStoreLocation 'Cert:\\CurrentUser\\My' -KeyExportPolicy Exportable -FriendlyName 'codex-remote'",
    "$pw = ConvertTo-SecureString -String '" + passphrase + "' -Force -AsPlainText",
    "Export-PfxCertificate -Cert $c -FilePath '" + pfxPath.replace(/'/g, "''") + "' -Password $pw | Out-Null",
    "Export-Certificate -Cert $c -FilePath '" + cerPath.replace(/'/g, "''") + "' -Type CERT | Out-Null",
    "Remove-Item -LiteralPath ('Cert:\\CurrentUser\\My\\' + $c.Thumbprint)",
    "'OK'",
  ].join("; ");
  log("generating self-signed certificate (SAN: " + names.join(", ") + ")");
  // 用系统自带的 Windows PowerShell 5.1，并把 PSModulePath 重置成系统模块目录：
  // 如果继承了 PowerShell 7 的模块路径，5.1 会加载失败导致没有 Cert: 驱动器。
  const psExe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const env = Object.assign({}, process.env, {
    PSModulePath: path.join(process.env.SystemRoot || "C:\\Windows", "system32", "WindowsPowerShell", "v1.0", "Modules") + ";" + path.join(process.env.ProgramFiles || "C:\\Program Files", "WindowsPowerShell", "Modules"),
  });
  const r = spawnSync(psExe, ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true, env });
  if (r.status !== 0 || !fs.existsSync(pfxPath)) {
    throw new Error("certificate generation failed: " + (r.stderr || r.stdout || "").slice(0, 500));
  }
  fs.writeFileSync(passPath, passphrase);
  return { pfx: fs.readFileSync(pfxPath), passphrase, cerPath: fs.existsSync(cerPath) ? cerPath : null };
}

module.exports = { ensureCert };
