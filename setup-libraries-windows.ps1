# Install and compile verified CC0-1.0 acoustic SoundFont packs (.sf2) for LMMS Music Studio.
# Packs:
#   core          < 80 MB total download (CC0-1.0 only):
#                   - upright-piano-kw.sf2    (Gary Wolk / FreePats Upright Piano KW, Bank 0 Patch 0)
#                   - meta-guitars.sf2        (Meta Open Sound Nylon & Steel Guitars, Bank 0 Patches 0-1)
#                   - virtuosity-drums.sf2    (Virtuosity Drums GM Kit, Bank 128 Patch 0)
#                   - vsco-orchestra-core.sf2 (VSCO 2 CE Violin, Contrabass, Horn, Flute, Harp, Timpani, Bank 0 Patches 0-5)
#   upright-bass  Rubner Double Bass pizzicato (dsmolken.double-bass, CC0-1.0)
#   meta-piano    Meta Open Sound Acoustic Piano (CC0-1.0)
#   vsco-extended Extended VSCO 2 CE articulations (CC0-1.0)
#
# Usage: ./setup-libraries-windows.ps1 [-Pack core] [-Destination <soundfontsFolder>] [-Force] [-UpdateLock]
param(
    [ValidateSet('core', 'upright-bass', 'meta-piano', 'vsco-extended')][string[]]$Pack = @('core'),
    [string]$Destination = $(if ($env:LMMS_SOUNDFONTS) { $env:LMMS_SOUNDFONTS } else { Join-Path $env:LOCALAPPDATA 'lmms-music-studio\soundfonts' }),
    [switch]$Force,
    [switch]$UpdateLock
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is required on PATH' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (>=20) is required on PATH' }
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue) -and -not $env:LMMS_FFMPEG) { throw 'ffmpeg is required on PATH (or set LMMS_FFMPEG)' }

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$packCli = Join-Path $scriptRoot 'tools\soundfont-pack.mjs'
$packArg = ($Pack -join ',')

$nodeArgs = @($packCli, '--pack', $packArg, '--destination', $Destination)
if ($Force) { $nodeArgs += '--force' }
if ($UpdateLock) { $nodeArgs += '--write-tracked-lock' }

& node @nodeArgs
if ($LASTEXITCODE -ne 0) {
    throw "SoundFont pack installation failed for pack(s): $packArg"
}
Write-Output "Verified CC0-1.0 SoundFont pack ($packArg) ready in $Destination"
