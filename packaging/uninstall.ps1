# Sonika Converter - per-user uninstall. Removes exactly what install.ps1 added.
# Run:  powershell -NoProfile -ExecutionPolicy Bypass -File packaging\uninstall.ps1
#       optional: -RemoveSettings   also deletes your saved settings (%APPDATA%\Sonika Converter)
#
# What it removes:
#   1. The Explorer menu keys  HKCU\Software\Classes\SystemFileAssociations\<ext>\shell\SonikaConverter
#      (and the empty parent keys that install.ps1 itself created, as listed in install-manifest.json)
#   2. Desktop\Sonika Converter.lnk and Start Menu\Programs\Sonika Converter.lnk
#   3. The "Start with Windows" entry, if it was turned on in the app (HKCU ...\CurrentVersion\Run, value com.sonika.converter)
#   4. The program folder  %LOCALAPPDATA%\Programs\Sonika Converter
# Settings stay unless -RemoveSettings is given. Nothing outside HKCU and these paths is touched.
[CmdletBinding()]
param([switch]$RemoveSettings)

$ErrorActionPreference = 'Stop'
$AppName = 'Sonika Converter'
$AppId   = 'com.sonika.converter'
$KeyName = 'SonikaConverter'
$Dest    = Join-Path $env:LOCALAPPDATA "Programs\$AppName"
$SFA     = 'HKCU:\Software\Classes\SystemFileAssociations'
function Say($text) { Write-Host "  $text" }

Write-Host "Uninstalling $AppName"

# ---------------------------------------------------------------- read the manifest
$manifest = $null
$manifestPath = Join-Path $Dest 'install-manifest.json'
if (Test-Path -LiteralPath $manifestPath) {
  try { $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } catch { $manifest = $null }
}

# ---------------------------------------------------------------- stop a running copy
$running = Get-Process -Name $AppName -ErrorAction SilentlyContinue
if ($running) {
  Say 'Closing the running Sonika Converter...'
  $running | Stop-Process -Force -ErrorAction SilentlyContinue
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Process -Name $AppName -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
}

# ---------------------------------------------------------------- 1. Explorer menu
$removed = 0
$menuKeys = @()
if ($manifest -and $manifest.menuKeys) { $menuKeys = @($manifest.menuKeys) }
# Also sweep for our key name in case the manifest is missing or out of date.
if (Test-Path -LiteralPath $SFA) {
  foreach ($k in Get-ChildItem -LiteralPath $SFA -ErrorAction SilentlyContinue) {
    $candidate = "$SFA\$($k.PSChildName)\shell\$KeyName"
    if ((Test-Path -LiteralPath $candidate) -and -not ($menuKeys -contains $candidate)) { $menuKeys += $candidate }
  }
}
foreach ($key in $menuKeys) {
  # Safety: only ever delete keys that end in \shell\SonikaConverter under HKCU SystemFileAssociations.
  if ($key -notlike "$SFA\*\shell\$KeyName") { continue }
  if (Test-Path -LiteralPath $key) { Remove-Item -LiteralPath $key -Recurse -Force; $removed++ }
}
# Parent keys install.ps1 created (deepest first), removed only when now empty.
if ($manifest -and $manifest.createdParentKeys) {
  $parents = @($manifest.createdParentKeys) | Sort-Object { $_.Length } -Descending
  foreach ($p in $parents) {
    if ($p -notlike "$SFA\*") { continue }
    if (-not (Test-Path -LiteralPath $p)) { continue }
    $item = Get-Item -LiteralPath $p
    $hasChildren = @(Get-ChildItem -LiteralPath $p -ErrorAction SilentlyContinue).Count -gt 0
    $hasValues = @($item.Property | Where-Object { $_ -ne '' -and $_ -ne '(default)' }).Count -gt 0
    if (-not $hasChildren -and -not $hasValues) { Remove-Item -LiteralPath $p -Force }
  }
}
Say "Right-click menu removed from $removed file types."

# ---------------------------------------------------------------- 2. shortcuts
$shortcuts = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) "$AppName.lnk"),
  (Join-Path ([Environment]::GetFolderPath('Programs')) "$AppName.lnk")
)
if ($manifest -and $manifest.shortcuts) { $shortcuts = @($manifest.shortcuts) + $shortcuts | Select-Object -Unique }
foreach ($s in $shortcuts) {
  if ($s -like "*\$AppName.lnk" -and (Test-Path -LiteralPath $s)) { Remove-Item -LiteralPath $s -Force; Say "Removed $s" }
}

# ---------------------------------------------------------------- 3. Start with Windows (written by the app only if turned on)
$run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$approved = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
foreach ($k in @($run, $approved)) {
  if ((Test-Path -LiteralPath $k) -and ((Get-Item -LiteralPath $k).Property -contains $AppId)) {
    Remove-ItemProperty -LiteralPath $k -Name $AppId -Force
    Say "Removed the Start with Windows entry ($k)."
  }
}

# ---------------------------------------------------------------- 4. program folder
if (Test-Path -LiteralPath $Dest) {
  Remove-Item -LiteralPath $Dest -Recurse -Force
  Say "Removed $Dest"
}

if ($RemoveSettings) {
  $data = Join-Path $env:APPDATA $AppName
  if (Test-Path -LiteralPath $data) { Remove-Item -LiteralPath $data -Recurse -Force; Say "Removed settings $data" }
} else {
  Say "Your settings were kept in $(Join-Path $env:APPDATA $AppName)."
}
Write-Host 'Done.' -ForegroundColor Green
