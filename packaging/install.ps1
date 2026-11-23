# Sonika Converter - per-user install (no admin needed).
# Run:  powershell -NoProfile -ExecutionPolicy Bypass -File packaging\install.ps1
#       optional: -Source "<path to Sonika Converter-win32-x64>"
#
# What it changes (all for the current user only):
#   1. Copies the packaged app to  %LOCALAPPDATA%\Programs\Sonika Converter
#   2. Creates shortcuts: Desktop\Sonika Converter.lnk and Start Menu\Programs\Sonika Converter.lnk
#      (the Start Menu shortcut carries the app ID com.sonika.converter so Windows notifications work)
#   3. Adds the Explorer right-click menu "Sonika Converter" for the supported file types under
#      HKCU\Software\Classes\SystemFileAssociations\<ext>\shell\SonikaConverter
#   4. Writes install-manifest.json in the install folder so uninstall.ps1 removes exactly these things.
# It never touches HKLM, never changes execution policy and never enables Start with Windows.
[CmdletBinding()]
param(
  [string]$Source = '',   # default: <project>\dist\Sonika Converter-win32-x64
  [switch]$DryRun   # print what would be installed and registered, change nothing
)

$ErrorActionPreference = 'Stop'
$AppName  = 'Sonika Converter'
$ExeName  = 'Sonika Converter.exe'
$AppId    = 'com.sonika.converter'
$KeyName  = 'SonikaConverter'
$Dest     = Join-Path $env:LOCALAPPDATA "Programs\$AppName"
$SFA      = 'HKCU:\Software\Classes\SystemFileAssociations'

function Say($text) { Write-Host "  $text" }

# ---------------------------------------------------------------- checks
if (-not $Source) {
  $here = Split-Path -Parent $MyInvocation.MyCommand.Path
  $Source = Join-Path (Split-Path -Parent $here) 'dist\Sonika Converter-win32-x64'
}
$resolved = Resolve-Path -LiteralPath $Source -ErrorAction SilentlyContinue
if (-not $resolved -or -not (Test-Path -LiteralPath (Join-Path $resolved.Path $ExeName))) {
  Write-Host "Could not find the packaged app at $Source. Run 'npm.cmd run pack' first." -ForegroundColor Red
  exit 1
}
$Source = $resolved.Path
Write-Host "Installing $AppName"
Say "from $Source"
Say "to   $Dest"

# Keep the list of registry keys a previous install created, so uninstall can still clean them.
$manifestPath = Join-Path $Dest 'install-manifest.json'
$created = New-Object System.Collections.Generic.List[string]
if (Test-Path -LiteralPath $manifestPath) {
  try {
    $old = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    foreach ($k in @($old.createdParentKeys)) { if ($k -and -not $created.Contains($k)) { $created.Add($k) } }
  } catch { }
}

# ---------------------------------------------------------------- Explorer menu definition
$menuFile = Join-Path $Source 'context-menu.json'
$verbs = @()
if (Test-Path -LiteralPath $menuFile) {
  $verbs = @((Get-Content -LiteralPath $menuFile -Raw | ConvertFrom-Json).verbs)
} else {
  # Fallback if the packaged definition is missing.
  $videoExts = '.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.mts', '.m2ts', '.mxf', '.wmv'
  $audioExts = '.wav', '.mp3', '.m4a', '.aac', '.flac'
  $verbs = @(
    [pscustomobject]@{ key = '10-audio'; label = 'Extract audio (MP3)'; args = '--tool video-to-audio --opt format=mp3-320'; exts = $videoExts },
    [pscustomobject]@{ key = '20-transcript'; label = 'Make transcript'; args = '--tool transcribe'; exts = $videoExts + $audioExts },
    [pscustomobject]@{ key = '30-pdf'; label = 'Convert to PDF'; args = '--tool word-to-pdf'; exts = @('.docx', '.doc', '.rtf', '.odt') },
    [pscustomobject]@{ key = '90-open'; label = 'Open in Sonika Converter'; args = ''; exts = $videoExts + $audioExts + @('.pdf', '.docx', '.doc', '.png', '.jpg', '.jpeg') }
  )
}
# Group verbs by extension.
$byExt = @{}
foreach ($v in $verbs) {
  foreach ($e in @($v.exts)) {
    $ext = ([string]$e).ToLower()
    if (-not $ext.StartsWith('.')) { continue }
    if (-not $byExt.ContainsKey($ext)) { $byExt[$ext] = New-Object System.Collections.ArrayList }
    if (-not ($byExt[$ext] | Where-Object { $_.key -eq $v.key })) { [void]$byExt[$ext].Add($v) }
  }
}
$Exe = Join-Path $Dest $ExeName

if ($DryRun) {
  Write-Host 'DRY RUN - nothing will be changed.' -ForegroundColor Yellow
  Say "Would copy the app to $Dest"
  Say "Would create $(Join-Path ([Environment]::GetFolderPath('Desktop')) "$AppName.lnk")"
  Say "Would create $(Join-Path ([Environment]::GetFolderPath('Programs')) "$AppName.lnk")  (app ID $AppId)"
  foreach ($ext in ($byExt.Keys | Sort-Object)) {
    $root = "$SFA\$ext\shell\$KeyName"
    $parentNote = if (Test-Path -LiteralPath "$SFA\$ext\shell") { '' } else { '  (creates parent keys)' }
    Say "$root$parentNote"
    foreach ($v in ($byExt[$ext] | Sort-Object key)) {
      $argPart = if ($v.args) { " $($v.args)" } else { '' }
      Say ("    {0,-26} -> `"{1}`"{2} `"%1`"" -f $v.label, $Exe, $argPart)
    }
  }
  Say "$($byExt.Keys.Count) file types in total."
  exit 0
}

# ---------------------------------------------------------------- 1. stop a running copy
$running = Get-Process -Name $AppName -ErrorAction SilentlyContinue
if ($running) {
  Say 'Closing the running Sonika Converter...'
  $running | Stop-Process -Force -ErrorAction SilentlyContinue
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Process -Name $AppName -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
}

# ---------------------------------------------------------------- 2. copy files
New-Item -ItemType Directory -Path $Dest -Force | Out-Null
& robocopy.exe $Source $Dest /MIR /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) {
  Write-Host "Copying failed (robocopy code $LASTEXITCODE). Is a file still open?" -ForegroundColor Red
  exit 1
}
Say 'Files copied.'

# ---------------------------------------------------------------- 3. shortcuts (with app ID)
$shortcutCode = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

namespace SonikaInstall {
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class CShellLink { }

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
  interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, uint fFlags);
    void GetIDList(out IntPtr ppidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
    void GetHotkey(out short pwHotkey);
    void SetHotkey(short wHotkey);
    void GetShowCmd(out int piShowCmd);
    void SetShowCmd(int iShowCmd);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cch, out int piIcon);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
    void Resolve(IntPtr hwnd, uint fFlags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  struct PROPERTYKEY { public Guid fmtid; public uint pid; }

  [StructLayout(LayoutKind.Explicit, Size = 24)]
  struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
  interface IPropertyStore {
    void GetCount(out uint cProps);
    void GetAt(uint iProp, out PROPERTYKEY pkey);
    void GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
    void SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
    void Commit();
  }

  public static class Shortcut {
    public static void Create(string lnk, string target, string args, string workDir, string icon, string desc, string appId) {
      IShellLinkW link = (IShellLinkW)new CShellLink();
      link.SetPath(target);
      link.SetArguments(args ?? "");
      link.SetWorkingDirectory(workDir);
      link.SetIconLocation(icon, 0);
      link.SetDescription(desc);
      if (!String.IsNullOrEmpty(appId)) {
        IPropertyStore store = (IPropertyStore)link;
        PROPERTYKEY key = new PROPERTYKEY();
        key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
        key.pid = 5; // PKEY_AppUserModel_ID
        PROPVARIANT pv = new PROPVARIANT();
        pv.vt = 31;  // VT_LPWSTR
        pv.p = Marshal.StringToCoTaskMemUni(appId);
        try { store.SetValue(ref key, ref pv); store.Commit(); }
        finally { Marshal.FreeCoTaskMem(pv.p); }
      }
      ((IPersistFile)link).Save(lnk, true);
    }
  }
}
'@
if (-not ('SonikaInstall.Shortcut' -as [type])) { Add-Type -TypeDefinition $shortcutCode -Language CSharp }

$desktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) "$AppName.lnk"
$startLnk   = Join-Path ([Environment]::GetFolderPath('Programs')) "$AppName.lnk"
$desc = 'Convert video to audio, transcripts, PDF, Word, video and image files'
foreach ($lnk in @($desktopLnk, $startLnk)) {
  [SonikaInstall.Shortcut]::Create($lnk, $Exe, '', $Dest, $Exe, $desc, $AppId)
}
Say 'Shortcuts created on the Desktop and in the Start Menu.'

# ---------------------------------------------------------------- 4. Explorer right-click menu
function Ensure-Key([string]$path) {
  # Creates missing keys one level at a time and remembers which ones we created.
  if (Test-Path -LiteralPath $path) { return }
  $parent = Split-Path -Parent $path
  Ensure-Key $parent
  New-Item -Path $path | Out-Null
  if (-not $created.Contains($path)) { $created.Add($path) }
}

$menuKeys = New-Object System.Collections.Generic.List[string]
foreach ($ext in ($byExt.Keys | Sort-Object)) {
  $shellKey = "$SFA\$ext\shell"
  $root = "$shellKey\$KeyName"
  if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }   # our own key from an older install
  Ensure-Key $shellKey
  New-Item -Path $root | Out-Null
  New-ItemProperty -LiteralPath $root -Name 'MUIVerb' -Value $AppName -PropertyType String | Out-Null
  New-ItemProperty -LiteralPath $root -Name 'Icon' -Value "`"$Exe`",0" -PropertyType String | Out-Null
  New-ItemProperty -LiteralPath $root -Name 'SubCommands' -Value '' -PropertyType String | Out-Null
  New-Item -Path "$root\shell" | Out-Null
  foreach ($v in ($byExt[$ext] | Sort-Object key)) {
    $vk = "$root\shell\$($v.key)"
    New-Item -Path $vk | Out-Null
    New-ItemProperty -LiteralPath $vk -Name 'MUIVerb' -Value $v.label -PropertyType String | Out-Null
    New-ItemProperty -LiteralPath $vk -Name 'Icon' -Value "`"$Exe`",0" -PropertyType String | Out-Null
    # "Player": the entry shows for any number of selected files; Explorer starts one process per
    # file and the running app gathers them into one batch.
    New-ItemProperty -LiteralPath $vk -Name 'MultiSelectModel' -Value 'Player' -PropertyType String | Out-Null
    $argPart = if ($v.args) { " $($v.args)" } else { '' }
    $cmd = "`"$Exe`"$argPart `"%1`""
    New-Item -Path "$vk\command" -Value $cmd | Out-Null
  }
  $menuKeys.Add($root)
}
Say "Right-click menu added for $($menuKeys.Count) file types (Windows 11: under 'Show more options')."

# ---------------------------------------------------------------- 5. manifest for uninstall
$manifest = [ordered]@{
  app               = $AppName
  installedAt       = (Get-Date).ToString('s')
  installDir        = $Dest
  shortcuts         = @($desktopLnk, $startLnk)
  menuKeys          = @($menuKeys)
  createdParentKeys = @($created)
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
Say 'Install manifest written.'
Write-Host "Done. Start it from the Desktop or Start Menu shortcut." -ForegroundColor Green
