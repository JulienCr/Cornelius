# Production : serveur et perception locale sur le seul port du serveur (PORT de .env, 3000 par
# défaut), sans Vite. Compile l'interface si elle manque ou si le code a changé, puis arrête une instance
# précédente, développement compris.
# Usage : powershell -ExecutionPolicy Bypass -File scripts\start.ps1 [-Build] [-NoPerception] [-TimeoutSeconds 60]
#   -Build   recompile l'interface même si elle existe déjà
# Arrêt : scripts\stop.ps1. Développement (Vite, rechargement à chaud) : scripts\dev.ps1.
[CmdletBinding()]
param(
  [switch]$Build,
  [switch]$NoPerception,
  [int]$TimeoutSeconds = 60
)

. (Join-Path $PSScriptRoot 'lib.ps1')
Initialize-CorneliusDirs

$node = Assert-CorneliusPrerequisites
Sync-CorneliusDependencies
$port = Get-CorneliusPort

# --- Interface compilée (dist\web) -------------------------------------------------
# Après une mise à jour (git pull), une source plus récente que la compilation la relance.
function Test-CorneliusBuildStale {
  $index = Join-Path $Root 'dist\web\index.html'
  if (-not (Test-Path -LiteralPath $index)) { return $true }
  $builtAt = (Get-Item -LiteralPath $index).LastWriteTime
  $sources = @('web', 'shared', 'package.json', 'pnpm-lock.yaml', 'vite.config.ts') |
    ForEach-Object { Join-Path $Root $_ } |
    Where-Object { Test-Path -LiteralPath $_ }
  $newer = Get-ChildItem -LiteralPath $sources -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -gt $builtAt } |
    Select-Object -First 1
  return [bool]$newer
}
if ($Build -or (Test-CorneliusBuildStale)) {
  $pnpm = Resolve-CorneliusPnpm
  if (-not $pnpm) { throw 'pnpm est introuvable : lancez corepack enable (livré avec Node.js 24) ou installez pnpm 10.' }
  Push-Location $Root
  try {
    & $pnpm run build
    if ($LASTEXITCODE -ne 0) { throw "La compilation a échoué (code $LASTEXITCODE)." }
  } finally {
    Pop-Location
  }
}

# --- Instance précédente, développement compris -------------------------------------
& (Join-Path $PSScriptRoot 'stop.ps1')

$state = @{}
$backendProcess = Start-CorneliusBackend -State $state -Port $port -Node $node
if ($NoPerception) {
  Write-Host 'Perception ignorée (-NoPerception).'
} else {
  Start-CorneliusPerception -State $state
}
Set-CorneliusState -State $state

# --- Vérification de disponibilité -------------------------------------------------
Write-Host ''
if (-not (Wait-CorneliusBackend -Port $port -TimeoutSeconds $TimeoutSeconds -Process $backendProcess)) {
  Write-Host "Journaux complets : $LogDir"
  exit 1
}
exit 0
