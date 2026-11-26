# Backwards-compatible wrapper that delegates to the turnkey V3 installer (install-windows.ps1).
param(
    [string]$Workspace = "",
    [string]$SoundfontsDir = "",
    [ValidateSet('core', 'upright-bass', 'meta-piano', 'vsco-extended')][string[]]$Packs = @('core'),
    [switch]$SkipUserSkill,
    [switch]$SkipSmokeTest
)

$ErrorActionPreference = 'Stop'
$installerPath = Join-Path $PSScriptRoot 'install-windows.ps1'
& $installerPath @PSBoundParameters

