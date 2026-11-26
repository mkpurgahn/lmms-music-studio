# Turnkey, idempotent, non-destructive Windows installer for LMMS Music Studio V3.
# Verifies prerequisites with plain-English remediation, installs stock LMMS 1.2.2 and FFmpeg via WinGet when missing,
# installs npm dependencies, compiles/verifies CC0-1.0 SoundFont packs, merges .mcp.json non-destructively,
# installs the Copilot skill, and runs the MCP server smoke test.
param(
    [string]$Workspace = "",
    [string]$SoundfontsDir = "",
    [ValidateSet('core', 'upright-bass', 'meta-piano', 'vsco-extended')][string[]]$Packs = @('core'),
    [switch]$SkipUserSkill,
    [switch]$SkipSmokeTest
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Fail-Step {
    param([string]$Message)
    throw "[LMMS Music Studio Installer] $Message"
}

function Refresh-ProcessPath {
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $combined = @($machinePath, $userPath) | Where-Object { $_ -and $_.Trim().Length -gt 0 }
    if ($combined.Count -gt 0) {
        $env:Path = ($combined -join ';')
    }
    if ($env:LOCALAPPDATA) {
        $wingetLinks = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'
        if ((Test-Path -LiteralPath $wingetLinks) -and ($env:Path -notlike "*$wingetLinks*")) {
            $env:Path = "$env:Path;$wingetLinks"
        }
    }
}

function Invoke-External {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @()
    )
    $prevEap = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $FilePath @Arguments | Out-Host
        $code = [int]$LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevEap
    }
    return $code
}

function Invoke-NodeJson {
    param(
        [string[]]$Arguments
    )
    $prevEap = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $stdoutLines = & node @Arguments
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevEap
    }
    if ($code -ne 0) {
        Fail-Step ("Node helper command failed (exit code $code): node " + ($Arguments -join ' '))
    }
    $raw = ($stdoutLines -join "`n").Trim()
    if (-not $raw) {
        Fail-Step ("Node helper returned empty output: node " + ($Arguments -join ' '))
    }
    return ($raw | ConvertFrom-Json)
}

Write-Output '=== LMMS Music Studio V3 - Windows Turnkey Setup ==='

# 1. Preflight: 64-bit Windows
if (-not [Environment]::Is64BitOperatingSystem) {
    Fail-Step 'LMMS Music Studio requires 64-bit Windows (x64). 32-bit operating systems are not supported.'
}

# 2. Preflight: Node.js (>= 20.0.0), npm, and git
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Fail-Step "Node.js 20.0.0 or newer is required, but 'node' was not found on PATH. Install it by running:`n  winget install OpenJS.NodeJS.LTS`nThen close and reopen PowerShell and re-run .\install-windows.ps1."
}

$prevEap = $ErrorActionPreference
try {
    $ErrorActionPreference = 'Continue'
    $nodeVersionRaw = (& node --version) -join ''
} finally {
    $ErrorActionPreference = $prevEap
}
$nodeMatch = [regex]::Match([string]$nodeVersionRaw, '^v?(\d+)\.(\d+)\.(\d+)')
if (-not $nodeMatch.Success) {
    Fail-Step "Could not read your Node.js version ('$nodeVersionRaw'). Install or repair Node.js LTS by running:`n  winget install OpenJS.NodeJS.LTS"
}
$nodeVersion = [version]("{0}.{1}.{2}" -f $nodeMatch.Groups[1].Value, $nodeMatch.Groups[2].Value, $nodeMatch.Groups[3].Value)
if ($nodeVersion -lt [version]'20.0.0') {
    Fail-Step "Node.js 20.0.0 or newer is required, but found v$nodeVersion. Upgrade Node.js by running:`n  winget install OpenJS.NodeJS.LTS`nThen close and reopen PowerShell and re-run .\install-windows.ps1."
}

$npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCmd) {
    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
}
if (-not $npmCmd) {
    Fail-Step "npm was not found on PATH. Reinstall Node.js LTS by running:`n  winget install OpenJS.NodeJS.LTS"
}

$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) {
    Fail-Step "Git is required to fetch verified CC0 SoundFont instrument sources, but 'git' was not found on PATH. Install it by running:`n  winget install Git.Git`nThen close and reopen PowerShell and re-run .\install-windows.ps1."
}

Write-Output "[preflight] 64-bit Windows, Node v$nodeVersion, npm, and git verified."

# 3. Resolve paths and inspect existing LMMS + SoundFont lock state
$installerHelper = Join-Path $repoRoot 'tools\installer-config.mjs'
$packCsv = ($Packs -join ',')
$preflightArgs = @(
    $installerHelper,
    '--mode', 'preflight',
    '--repo-root', $repoRoot,
    '--packs', $packCsv
)
if ($Workspace -and $Workspace.Trim().Length -gt 0) {
    $preflightArgs += @('--workspace', $Workspace.Trim())
}
if ($SoundfontsDir -and $SoundfontsDir.Trim().Length -gt 0) {
    $preflightArgs += @('--soundfonts', $SoundfontsDir.Trim())
}
$preflight = Invoke-NodeJson -Arguments $preflightArgs

$resolvedWorkspace = [string]$preflight.workspace
$resolvedSoundfonts = [string]$preflight.soundfontsDir
$resolvedLmms = [string]$preflight.lmmsExecutable
$alreadyVerified = [bool]($preflight.lmmsExists -and $preflight.lockExists -and $preflight.packsVerified)

# 4. Preflight: Free disk space (>= 1.5 GB on first-time install; skip when lmms.exe and soundfont-lock.json are already verified)
$minFreeBytes = [int64]1610612736 # 1.5 GiB
if ($alreadyVerified) {
    Write-Output '[preflight] Existing lmms.exe and soundfont-lock.json SHA-256 hashes verified; skipping 1.5 GB first-install space check.'
} else {
    $pathsToCheck = @($resolvedWorkspace, $resolvedSoundfonts)
    if (-not $preflight.lmmsExists -and [System.IO.Path]::IsPathRooted($resolvedLmms)) {
        $pathsToCheck += $resolvedLmms
    }
    $checkedRoots = @{}
    foreach ($targetPath in $pathsToCheck) {
        $driveRoot = [System.IO.Path]::GetPathRoot($targetPath)
        if (-not $driveRoot -or $driveRoot.StartsWith('\\')) { continue }
        $key = $driveRoot.ToUpperInvariant()
        if ($checkedRoots.ContainsKey($key)) { continue }
        $checkedRoots[$key] = $true
        try {
            $driveInfo = New-Object System.IO.DriveInfo($driveRoot)
            if ($driveInfo.IsReady -and $driveInfo.AvailableFreeSpace -lt $minFreeBytes) {
                $freeGb = [math]::Round($driveInfo.AvailableFreeSpace / 1GB, 2)
                Fail-Step "At least 1.5 GB of free disk space is required on drive $driveRoot for first-time setup, but only $freeGb GB is available. Free disk space or pass -Workspace / -SoundfontsDir on another drive."
            }
        } catch {
            if ($_.Exception.Message -like '*\[LMMS Music Studio Installer\]*') { throw }
        }
    }
    Write-Output '[preflight] Disk space verified (>= 1.5 GB free).'
}

# 5. Preflight: FFmpeg (required for SoundFont compilation and OGG export)
function Test-FfmpegAvailable {
    if ($env:LMMS_FFMPEG -and (Test-Path -LiteralPath $env:LMMS_FFMPEG)) {
        return $true
    }
    return [bool](Get-Command ffmpeg -ErrorAction SilentlyContinue)
}

if (-not (Test-FfmpegAvailable)) {
    $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $wingetCmd) {
        Fail-Step "FFmpeg was not found on PATH and 'winget' is unavailable. Install FFmpeg from https://ffmpeg.org/download.html (or install App Installer / WinGet and run: winget install --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements), then re-run .\install-windows.ps1."
    }
    Write-Output '[setup] Installing FFmpeg via WinGet...'
    $ffCode = Invoke-External -FilePath $wingetCmd.Source -Arguments @(
        'install', '--id', 'Gyan.FFmpeg', '--accept-source-agreements', '--accept-package-agreements'
    )
    Refresh-ProcessPath
    if (-not (Test-FfmpegAvailable)) {
        if ($env:LOCALAPPDATA) {
            $ffPkgDir = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
            if (Test-Path -LiteralPath $ffPkgDir) {
                $foundFf = Get-ChildItem -LiteralPath $ffPkgDir -Recurse -Filter 'ffmpeg.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($foundFf) {
                    $env:Path = "$env:Path;$($foundFf.DirectoryName)"
                }
            }
        }
    }
    if (-not (Test-FfmpegAvailable)) {
        Fail-Step "FFmpeg installation did not place ffmpeg on PATH (winget exit code $ffCode). Run manually:`n  winget install --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements`nThen close and reopen PowerShell and re-run .\install-windows.ps1."
    }
}
$ffmpegResolved = if ($env:LMMS_FFMPEG -and (Test-Path -LiteralPath $env:LMMS_FFMPEG)) {
    $env:LMMS_FFMPEG
} else {
    (Get-Command ffmpeg -ErrorAction Stop).Source
}
Write-Output "[preflight] FFmpeg verified: $ffmpegResolved"

# 6. Preflight: Stock LMMS 1.2.2
function Test-LmmsAvailable {
    param([string]$Candidate)
    if ([System.IO.Path]::IsPathRooted($Candidate)) {
        return (Test-Path -LiteralPath $Candidate)
    }
    return [bool](Get-Command $Candidate -ErrorAction SilentlyContinue)
}

if (-not (Test-LmmsAvailable -Candidate $resolvedLmms)) {
    if ($env:LMMS_EXECUTABLE -and ($resolvedLmms -ne 'C:\Program Files\LMMS\lmms.exe')) {
        Fail-Step "LMMS_EXECUTABLE is set to '$resolvedLmms', which does not exist. Update LMMS_EXECUTABLE to your lmms.exe path or clear LMMS_EXECUTABLE so the installer can install stock LMMS 1.2.2."
    }
    $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $wingetCmd) {
        Fail-Step "LMMS was not found at '$resolvedLmms' and 'winget' is unavailable. Download and install LMMS 1.2.2 (64-bit Windows) from https://lmms.io/download and re-run .\install-windows.ps1."
    }
    Write-Output '[setup] Installing stock LMMS 1.2.2 via WinGet...'
    $lmmsCode = Invoke-External -FilePath $wingetCmd.Source -Arguments @(
        'install', '--id', 'LMMS.LMMS', '--exact', '--version', '1.2.2', '--accept-source-agreements', '--accept-package-agreements'
    )
    if (-not (Test-LmmsAvailable -Candidate $resolvedLmms)) {
        Fail-Step "LMMS 1.2.2 installation failed or did not produce '$resolvedLmms' (winget exit code $lmmsCode). Install LMMS 1.2.2 manually by running:`n  winget install --id LMMS.LMMS --exact --version 1.2.2 --accept-source-agreements --accept-package-agreements"
    }
}
Write-Output "[preflight] LMMS verified: $resolvedLmms"

# 7. Dependencies, Workspace, and CC0-1.0 SoundFont Packs
Push-Location -LiteralPath $repoRoot
try {
    Write-Output '[setup] Installing Node.js dependencies (npm ci)...'
    $npmCode = Invoke-External -FilePath $npmCmd.Source -Arguments @('ci', '--no-audit', '--no-fund')
    if ($npmCode -ne 0) {
        Fail-Step "npm ci failed with exit code $npmCode. Check your network connection and ensure no running process has files locked under node_modules."
    }

    if (-not (Test-Path -LiteralPath $resolvedWorkspace)) {
        New-Item -ItemType Directory -Force -Path $resolvedWorkspace | Out-Null
        Write-Output "[setup] Created workspace directory: $resolvedWorkspace"
    } else {
        Write-Output "[setup] Workspace directory ready: $resolvedWorkspace"
    }

    $libScript = Join-Path $repoRoot 'setup-libraries-windows.ps1'
    Write-Output "[setup] Verifying CC0-1.0 SoundFont pack(s) ($packCsv)..."
    & $libScript -Pack $Packs -Destination $resolvedSoundfonts

    # 8. Non-destructive .mcp.json merge
    $mcpJsonPath = Join-Path $repoRoot '.mcp.json'
    $mcpResult = Invoke-NodeJson -Arguments @(
        $installerHelper,
        '--mode', 'merge-mcp',
        '--mcp-path', $mcpJsonPath,
        '--repo-root', $repoRoot,
        '--workspace', $resolvedWorkspace,
        '--soundfonts', $resolvedSoundfonts
    )
    $mcpState = if ($mcpResult.created) { 'created' } elseif ($mcpResult.changed) { 'updated' } else { 'unchanged (already up to date)' }
    Write-Output "[setup] MCP configuration ($mcpState): $($mcpResult.path)"

    # 9. Copilot Skill installation (project skill is tracked in .github\skills\lmms-music-studio\SKILL.md)
    $sourceSkillDir = Join-Path $repoRoot 'skills\lmms-music-studio'
    $projectSkillFile = Join-Path $repoRoot '.github\skills\lmms-music-studio\SKILL.md'
    $userSkillSummary = 'skipped (-SkipUserSkill)'

    if (-not $SkipUserSkill) {
        if (-not (Test-Path -LiteralPath $sourceSkillDir)) {
            Fail-Step "Skill source directory missing: $sourceSkillDir"
        }
        $targetSkillsRoot = if ($env:LMMS_INSTALLER_COPILOT_SKILLS_DIR) {
            $env:LMMS_INSTALLER_COPILOT_SKILLS_DIR
        } else {
            $userHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
            Join-Path $userHome '.copilot\skills'
        }
        $userSkillDir = Join-Path $targetSkillsRoot 'lmms-music-studio'
        New-Item -ItemType Directory -Force -Path $userSkillDir | Out-Null
        Get-ChildItem -LiteralPath $sourceSkillDir -Force | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $userSkillDir -Recurse -Force
        }
        $userSkillSummary = Join-Path $userSkillDir 'SKILL.md'
        Write-Output "[setup] User Copilot skill installed: $userSkillSummary"
    } else {
        Write-Output '[setup] Skipped user Copilot skill installation (-SkipUserSkill).'
    }

    # 10. Final MCP Server Smoke Check
    if (-not $SkipSmokeTest) {
        Write-Output '[verify] Running MCP server smoke test...'
        $smokeScript = Join-Path $repoRoot '.github\scripts\smoke-server.mjs'
        $smokeCode = Invoke-External -FilePath 'node' -Arguments @($smokeScript)
        if ($smokeCode -ne 0) {
            Fail-Step "MCP smoke test failed (exit code $smokeCode). Run 'node .github\scripts\smoke-server.mjs' for details."
        }
    } else {
        Write-Output '[verify] Skipped smoke test (-SkipSmokeTest).'
    }

    Write-Output ''
    Write-Output '=== LMMS Music Studio V3 Ready ==='
    Write-Output "LMMS Executable : $resolvedLmms"
    Write-Output "FFmpeg          : $ffmpegResolved"
    Write-Output "Workspace       : $resolvedWorkspace"
    Write-Output "SoundFonts      : $resolvedSoundfonts"
    Write-Output "MCP Config      : $($mcpResult.path)"
    Write-Output "Project Skill   : $projectSkillFile"
    Write-Output "User Skill      : $userSkillSummary"
    Write-Output ''
    Write-Output 'Next steps:'
    Write-Output "  1. Open this folder ($repoRoot) in GitHub Copilot, Claude Code, VS Code, or Cursor, or copy .mcp.json into your AI client config."
    Write-Output '  2. Ask your AI producer to create a song, render stems and master, and open the Browser Studio Timeline.'
} finally {
    Pop-Location
}
