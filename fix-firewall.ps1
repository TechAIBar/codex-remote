# Remove Windows-generated inbound Block rules for node.exe and add allow rules for the gateway.
# Run as Administrator. Called by allow-firewall.cmd.
$node = $env:CR_NODE
if (-not $node) {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($nodeCommand) { $node = $nodeCommand.Source }
}
if (-not $node) {
  $node = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
}
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
  throw 'Node.js was not found. Install Node.js or set CR_NODE to its full path.'
}

$blocked = Get-NetFirewallRule -Direction Inbound -Action Block -ErrorAction SilentlyContinue | Where-Object {
  $f = $_ | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue
  $f -and $f.Program -and ($f.Program -ieq $node)
}
if ($blocked) {
  foreach ($r in $blocked) {
    Write-Host ('removing block rule: ' + $r.DisplayName + ' [' + $r.Profile + '] ' + $r.Name)
    Remove-NetFirewallRule -Name $r.Name
  }
} else {
  Write-Host 'no block rule for node.exe'
}

if (Get-NetFirewallRule -DisplayName 'codex-remote 8443' -ErrorAction SilentlyContinue) {
  Write-Host 'port allow rule already exists'
} else {
  New-NetFirewallRule -DisplayName 'codex-remote 8443' -Direction Inbound -Protocol TCP -LocalPort 8443 -Action Allow -Profile Any | Out-Null
  Write-Host 'TCP 8443 allowed'
}

if (Get-NetFirewallRule -DisplayName 'codex-remote node.exe' -ErrorAction SilentlyContinue) {
  Write-Host 'program allow rule already exists'
} else {
  New-NetFirewallRule -DisplayName 'codex-remote node.exe' -Direction Inbound -Program $node -Protocol TCP -LocalPort 8443 -Action Allow -Profile Any | Out-Null
  Write-Host 'program allow rule for node.exe added'
}

Write-Host ''
Write-Host 'Remaining inbound rules for node.exe:'
Get-NetFirewallRule -Direction Inbound -ErrorAction SilentlyContinue | Where-Object {
  $f = $_ | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue
  $f -and $f.Program -and ($f.Program -ieq $node)
} | ForEach-Object { Write-Host ('  ' + $_.DisplayName + '  ' + $_.Action + '  ' + $_.Profile) }
