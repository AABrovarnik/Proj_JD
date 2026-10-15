[CmdletBinding()]
param(
  [string]$Message,
  [switch]$Push,
  [switch]$DryRun,
  [switch]$SkipPreflight
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

function Invoke-Git {
  param([string[]]$Arguments)

  $ErrorActionPreference = 'Continue'
  $PSNativeCommandUseErrorActionPreference = $false
  $output = & git @Arguments 2>&1
  $gitExitCode = $LASTEXITCODE
  if ($gitExitCode -ne 0) {
    throw "git $($Arguments -join ' ') failed: $output"
  }
  return $output
}

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $repoRoot

$branch = (Invoke-Git -Arguments @('branch', '--show-current') | Select-Object -First 1).Trim()
if ([string]::IsNullOrWhiteSpace($branch)) {
  throw 'Detached HEAD is not supported. Switch to a named branch first.'
}

$remoteUrl = (Invoke-Git -Arguments @('remote', 'get-url', 'origin') | Select-Object -First 1).Trim()
if ([string]::IsNullOrWhiteSpace($remoteUrl)) {
  throw 'Git remote "origin" is not configured.'
}

$indexCheck = & git diff --cached --quiet
if ($LASTEXITCODE -eq 1) {
  throw 'The index already contains staged changes. Commit or unstage them before using this script.'
}
if ($LASTEXITCODE -ne 0) {
  throw 'Could not inspect the Git index.'
}

$status = @(Invoke-Git -Arguments @('status', '--short', '--untracked-files=all'))
if ($status.Count -eq 0) {
  Write-Host 'Working tree is clean; nothing to publish.'
  exit 0
}

Write-Host "Repository: $repoRoot"
Write-Host "Branch: $branch"
Write-Host "Remote: $remoteUrl"
Write-Host 'Pending files:'
$status | ForEach-Object { Write-Host "  $_" }

$trackedPaths = @(Invoke-Git -Arguments @('ls-files'))
$trackedSensitive = @($trackedPaths | Where-Object {
  $_ -match '(^|/)(\.env|data|uploads|exports)(/|$)' -or
  $_ -match '(^|/)docs/договоры_Аренды(/|$)' -or
  $_ -match '\.(docx|pdf|p12|pfx|pem|key)$'
})
if ($trackedSensitive.Count -gt 0) {
  throw "Sensitive paths are tracked by Git; review them before publishing: $($trackedSensitive -join ', ')"
}

if ($DryRun) {
  Write-Host 'Dry run only: no files staged, committed, or pushed.'
  exit 0
}

$confirmation = Read-Host 'Stage all non-ignored project changes shown above? Type Y to continue'
if ($confirmation -cne 'Y') {
  Write-Host 'Cancelled; no changes staged.'
  exit 0
}

if (-not $SkipPreflight) {
  Write-Host 'Running npm run preflight...'
  & npm run preflight
  if ($LASTEXITCODE -ne 0) {
    throw 'Preflight failed; nothing was staged or committed.'
  }
}

Invoke-Git -Arguments @('diff', '--check') | Out-Null
Invoke-Git -Arguments @('fetch', 'origin', $branch) | Out-Null

& git merge-base --is-ancestor "origin/$branch" HEAD
if ($LASTEXITCODE -ne 0) {
  throw "Local HEAD is behind or has diverged from origin/$branch. Reconcile the branch before publishing."
}

Invoke-Git -Arguments @('add', '-A') | Out-Null

$stagedPaths = @(Invoke-Git -Arguments @('diff', '--cached', '--name-only'))
$stagedSensitive = @($stagedPaths | Where-Object {
  $_ -match '(^|/)(\.env|data|uploads|exports)(/|$)' -or
  $_ -match '(^|/)docs/договоры_Аренды(/|$)' -or
  $_ -match '\.(docx|pdf|p12|pfx|pem|key)$'
})
if ($stagedSensitive.Count -gt 0) {
  & git reset --quiet --
  throw "Sensitive paths were staged and have been unstaged for safety: $($stagedSensitive -join ', ')"
}

$stagedDiff = @(Invoke-Git -Arguments @('diff', '--cached', '--no-ext-diff', '--unified=0'))
$secretPatterns = @(
  '(?i)\bsk-(?:proj|live)-[A-Za-z0-9_-]{20,}\b',
  '(?i)\bsk-[A-Za-z0-9]{32,}\b',
  '(?i)\bgh[pousr]_[A-Za-z0-9]{30,}\b',
  '(?i)\bgithub_pat_[A-Za-z0-9_]{40,}\b',
  '\bAKIA[0-9A-Z]{16}\b',
  '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'
)
$secretMatches = @($stagedDiff | Select-String -Pattern $secretPatterns)
if ($secretMatches.Count -gt 0) {
  & git reset --quiet --
  throw 'A possible credential was detected in the staged diff. Changes were unstaged; inspect locally and do not publish until resolved.'
}

Invoke-Git -Arguments @('diff', '--cached', '--check') | Out-Null
if ($stagedPaths.Count -eq 0) {
  Write-Host 'No non-ignored changes to commit.'
  exit 0
}

Write-Host 'Staged summary:'
Invoke-Git -Arguments @('diff', '--cached', '--stat') | ForEach-Object { Write-Host $_ }
Write-Host 'Staged files:'
$stagedPaths | ForEach-Object { Write-Host "  $_" }

if ([string]::IsNullOrWhiteSpace($Message)) {
  $Message = Read-Host 'Commit message'
}
if ([string]::IsNullOrWhiteSpace($Message)) {
  & git reset --quiet --
  throw 'Commit message is required; staged changes were unstaged.'
}

$confirmation = Read-Host 'Commit the staged changes? Type Y to continue'
if ($confirmation -cne 'Y') {
  & git reset --quiet --
  Write-Host 'Cancelled; staged changes were unstaged.'
  exit 0
}

Invoke-Git -Arguments @('commit', '-m', $Message) | ForEach-Object { Write-Host $_ }

if ($Push) {
  Invoke-Git -Arguments @('push', 'origin', $branch) | ForEach-Object { Write-Host $_ }
  Write-Host "Published to origin/$branch."
} else {
  Write-Host "Committed locally. To publish, rerun with -Push after reviewing the commit."
}
