# Fetch open sample libraries for LMMS Music Studio.
# Uses git sparse checkout from github.com/sfzinstruments, so only the files each instrument needs are downloaded (about 1.1 GB with the default piano).
#   Piano   SalamanderGrandPiano   CC BY 3.0, credit Alexander Holm; Yamaha C5, 16 velocity layers, about 720 MB
#   Splendid SplendidGrandPiano    public domain; Steinway, 4 velocity layers, a smaller alternative (not fetched by default)
#   Bass    dsmolken.double-bass   CC0, pizzicato only
#   Sax     MTG.SoloSax            CC BY 4.0, credit MTG (freesound) and kinwie; alto and tenor only
#   Drums   virtuosity_drums       CC0, "mid" mic: kick, snare, hats, rides, crashes
# Read each library's LICENSE and README before you release anything made with it.
# Usage: ./setup-libraries-windows.ps1 [-Destination <folder>] [-Only piano,splendid,bass,sax,drums]
param(
    [string]$Destination = (Join-Path $env:LOCALAPPDATA 'lmms-music-studio/libraries'),
    [ValidateSet('piano', 'splendid', 'bass', 'sax', 'drums')][string[]]$Only = @('piano', 'bass', 'sax', 'drums')
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is required' }
New-Item -ItemType Directory -Force -Path $Destination | Out-Null

$libraries = [ordered]@{
    piano = @{ Repo = 'SalamanderGrandPiano'; Patterns = @('/*') }
    splendid = @{ Repo = 'SplendidGrandPiano'; Patterns = @('/*') }
    bass  = @{ Repo = 'dsmolken.double-bass'; Patterns = @('/*.sfz', '/*.txt', '/LICENSE*', '/pizz/*.wav') }
    sax   = @{ Repo = 'MTG.SoloSax'; Patterns = @('/LICENSE', '/README.md', '/MTG Solo Saxophones/*.sfz', '/MTG Solo Saxophones/Data/', '/MTG Solo Saxophones/Samples/alt_*', '/MTG Solo Saxophones/Samples/ten_*') }
    drums = @{ Repo = 'virtuosity_drums'; Patterns = @('/*.xml', '/LICENSE', '/README.md', '/notes.txt', '/Programs/', '/Samples/mid/kick/', '/Samples/mid/snare/', '/Samples/mid/snareoff/', '/Samples/mid/hh/', '/Samples/mid/ride/', '/Samples/mid/flatride/', '/Samples/mid/crash/') }
}

foreach ($name in $Only) {
    $library = $libraries[$name]
    $folder = Join-Path $Destination $library.Repo
    if (-not (Test-Path (Join-Path $folder '.git'))) {
        git clone --quiet --depth 1 --filter=blob:none --no-checkout "https://github.com/sfzinstruments/$($library.Repo).git" $folder
        if ($LASTEXITCODE -ne 0) { throw "Clone failed for $($library.Repo)" }
    }
    git -C $folder sparse-checkout set --no-cone @($library.Patterns)
    git -C $folder checkout --quiet HEAD
    if ($LASTEXITCODE -ne 0) { throw "Checkout failed for $($library.Repo)" }
    $size = (Get-ChildItem $folder -Recurse -File -Force | Where-Object { $_.FullName -notmatch '\\\.git\\' } | Measure-Object Length -Sum).Sum
    Write-Output ('{0}: {1:N0} MB in {2}' -f $library.Repo, ($size / 1MB), $folder)
}
Write-Output "Sample libraries ready in $Destination (mounted automatically by library-server.mjs or via LMMS_SAMPLE_LIBRARIES)."
