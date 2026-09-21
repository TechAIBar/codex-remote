// 诊断：从 Node 里 spawn 的 powershell 是否有 Cert: 驱动器 / PKI 模块
const { spawnSync } = require("child_process");
const ps = "try { Import-Module Microsoft.PowerShell.Security -ErrorAction Stop; 'Security import ok' } catch { 'Security import fail: ' + $_ }; Get-Module | ForEach-Object { 'loaded ' + $_.Name + ' ' + $_.ModuleBase }; Get-PSDrive -PSProvider Certificate -ErrorAction SilentlyContinue | ForEach-Object { 'certdrive ' + $_.Name }; Get-ChildItem Cert:\\CurrentUser\\My -ErrorAction SilentlyContinue | Measure-Object | ForEach-Object { 'certs ' + $_.Count }";
const exe = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const envs = {
  inherit: Object.assign({}, process.env),
  sysmods: Object.assign({}, process.env, { PSModulePath: "C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules;C:\\Program Files\\WindowsPowerShell\\Modules" }),
};
for (const [name, env] of Object.entries(envs)) {
  const r = spawnSync(exe, ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true, env });
  console.log("=== env " + name + " status " + r.status);
  console.log(r.stdout);
  if (r.stderr) console.log("STDERR: " + r.stderr.slice(0, 800));
}
