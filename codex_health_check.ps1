param(
  [int]$SlowThresholdMs = 3000
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Invoke-Check {
  param(
    [string]$Name,
    [scriptblock]$Action
  )

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  & $Action | Out-Null
  $sw.Stop()

  [pscustomobject]@{
    Check = $Name
    Status = if ($sw.ElapsedMilliseconds -gt $SlowThresholdMs) { "SLOW" } else { "OK" }
    ElapsedMs = $sw.ElapsedMilliseconds
  }
}

$results = @()
$results += Invoke-Check "shell" { Get-Date }
$results += Invoke-Check "workspace-root" { Get-Item -LiteralPath $root }
$results += Invoke-Check "rules-md" { Get-Item -LiteralPath (Join-Path $root "rules.md") }
$results += Invoke-Check "agents-dir" { Get-ChildItem -LiteralPath (Join-Path $root ".codex\agents") -File }
$results += Invoke-Check "skills-dir" { Get-ChildItem -LiteralPath (Join-Path $root ".agents\skills") -Directory }

$results | Format-Table -AutoSize

if ($results.Status -contains "SLOW") {
  Write-Error "Codex health check completed, but one or more checks were slow. Restart IDE/Codex before spawning subagents."
  exit 2
}

Write-Output "Codex health check OK."
