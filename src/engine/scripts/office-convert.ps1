# Sonika Converter - Office automation helper (Word / Excel / PowerPoint).
# Called by office-runner.js as:  powershell -NoProfile -ExecutionPolicy Bypass -File office-convert.ps1 -JobFile <job.json>
# The job file (UTF-8 JSON) says what to do. Output protocol, one line each on stdout:
#   SONIKA:PID:<n>            process id of the Office instance THIS script started (so Node can kill it on timeout)
#   SONIKA:PROGRESS:<0..1>:<text>
#   SONIKA:OK
#   SONIKA:ERR:<code>:<plain message>
# Rules: always start a NEW hidden instance when possible, open the source read-only (the caller hands us a private
# copy), never close or touch windows/documents the user already has open, always quit our own instance in finally.
# This file is ASCII only on purpose (Windows PowerShell 5.1 reads BOM-less files as ANSI).
param([Parameter(Mandatory = $true)][string]$JobFile)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Emit([string]$line) { [Console]::Out.WriteLine($line); [Console]::Out.Flush() }
function Progress([double]$f, [string]$t) {
    if ($env:SONIKA_TRACE) { [Console]::Error.WriteLine(('{0:HH:mm:ss.fff} {1}' -f (Get-Date), $t)) }
     Emit ("SONIKA:PROGRESS:{0}:{1}" -f ([string]::Format([Globalization.CultureInfo]::InvariantCulture, '{0:0.00}', $f)), $t) }
function Fail([string]$code, [string]$msg) { Emit ("SONIKA:ERR:{0}:{1}" -f $code, ($msg -replace '[\r\n]+', ' ')) }
function Get-Ids([string]$procName) { @(Get-Process -Name $procName -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) }
function Release($o) { if ($null -ne $o) { try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($o) } catch { } } }

$job = $null
try {
    $json = [System.IO.File]::ReadAllText($JobFile, [System.Text.Encoding]::UTF8)
    $job = $json | ConvertFrom-Json
} catch {
    Fail 'job' 'Internal error: the job description could not be read.'
    exit 2
}

$kind = [string]$job.app          # word | excel | powerpoint
$source = [string]$job.source
$dest = [string]$job.dest
$action = [string]$job.action     # pdf | saveas
$format = 0
if ($null -ne $job.format) { $format = [int]$job.format }

switch ($kind) {
    'word'       { $progId = 'Word.Application';       $procName = 'WINWORD';  $niceName = 'Microsoft Word' }
    'excel'      { $progId = 'Excel.Application';      $procName = 'EXCEL';    $niceName = 'Microsoft Excel' }
    'powerpoint' { $progId = 'PowerPoint.Application'; $procName = 'POWERPNT'; $niceName = 'Microsoft PowerPoint' }
    default      { Fail 'job' 'Internal error: unknown Office app.'; exit 2 }
}

if (-not (Test-Path -LiteralPath ('Registry::HKEY_CLASSES_ROOT\' + $progId))) {
    Fail 'notinstalled' ("$niceName does not seem to be installed on this PC, so this file cannot be converted.")
    exit 2
}

function Map-Error([string]$m) {
    if ($m -match 'password' -or $m -match 'encrypted') { return @('password', 'This file is protected by a password. Remove the password first, then try again.') }
    if ($m -match 'corrupt' -or $m -match 'unreadable' -or $m -match 'not valid' -or $m -match 'experienced an error trying to open' -or $m -match "can.t open this file" -or $m -match 'cannot open' -or $m -match 'could not be opened' -or $m -match 'damaged' -or $m -match 'repair' -or $m -match 'invalid') {
        return @('corrupt', 'This file could not be opened. It may be damaged or in a format it does not understand.')
    }
    if ($m -match 'Class not registered' -or $m -match '80040154') { return @('notinstalled', "$niceName does not seem to be installed on this PC.") }
    return @('other', ("$niceName reported a problem: " + $m.Trim()))
}

$app = $null; $docs = $null; $doc = $null
$owned = $false; $ownPid = 0; $ownPids = @()
$exitCode = 0
$missing = [Type]::Missing
$stage = 'start'

try {
    Progress 0.1 ("Starting $niceName")
    $stage = 'launch'
    $before = Get-Ids $procName
    $app = New-Object -ComObject $progId
    Start-Sleep -Milliseconds 250
    $after = Get-Ids $procName
    $new = @($after | Where-Object { $before -notcontains $_ })
    if ($new.Count -ge 1) {
        # Prefer processes that were started by COM automation (command line contains -Embedding).
        $cands = @()
        try {
            $cands = @(Get-CimInstance Win32_Process -Filter ("Name='{0}.EXE'" -f $procName) -ErrorAction Stop | Where-Object { $new -contains [int]$_.ProcessId -and $_.CommandLine -match 'Embedding' } | ForEach-Object { [int]$_.ProcessId })
        } catch { }
        if ($cands.Count -eq 0) { $cands = @($new) }
        $owned = $true
        $ownPids = @($cands)
        $ownPid = $ownPids[0]
        foreach ($op in $ownPids) { Emit ("SONIKA:PID:{0}" -f $op) }
    } else {
        Emit 'SONIKA:NOPID'
    }
    # If no new process appeared, the app is single-instance (PowerPoint) and we attached to the user's running copy.
    # In that case we only open/close our own private copy of the file and never quit, hide or change the app.

    if ($kind -eq 'word') {
        if ($owned) {
            $app.Visible = $false
            $app.DisplayAlerts = 0
            try { $app.AutomationSecurity = 3 } catch { }
        }
        $docs = $app.Documents
        Progress 0.3 'Opening the file'
        $stage = 'open'
        $pw = 'sonika-no-password'
        if ($job.encoding -and [int]$job.encoding -gt 0) {
            # FileName, ConfirmConversions, ReadOnly, AddToRecentFiles, PasswordDocument, PasswordTemplate, Revert,
            # WritePasswordDocument, WritePasswordTemplate, Format, Encoding, Visible
            $doc = $docs.Open($source, $false, $true, $false, $pw, $pw, $false, $pw, $pw, 0, [int]$job.encoding, $false)
        } else {
            $doc = $docs.Open($source, $false, $true, $false, $pw, $pw, $false, $pw, $pw, $missing, $missing, $false)
        }
        Progress 0.6 'Converting'
        $stage = 'convert'
        if ($action -eq 'pdf') {
            # OutputFileName, ExportFormat(17=PDF), OpenAfterExport, OptimizeFor(0=print), Range(0=all), From, To, Item,
            # IncludeDocProps, KeepIRM, CreateBookmarks(1=headings), DocStructureTags, BitmapMissingFonts, UseISO19005_1
            $doc.ExportAsFixedFormat($dest, 17, $false, 0, 0, 1, 1, 0, $true, $true, 1, $true, $true, $false)
        } else {
            $doc.SaveAs2($dest, $format)
        }
        Progress 0.9 'Saving'
        $doc.Close(0)
        Release $doc; $doc = $null
    }
    elseif ($kind -eq 'excel') {
        if ($owned) {
            $app.Visible = $false
            $app.DisplayAlerts = $false
            try { $app.AutomationSecurity = 3 } catch { }
            try { $app.AskToUpdateLinks = $false } catch { }
        }
        $docs = $app.Workbooks
        Progress 0.3 'Opening the file'
        $stage = 'open'
        # Filename, UpdateLinks(0=never), ReadOnly, Format, Password
        $doc = $docs.Open($source, 0, $true, $missing, 'sonika-no-password')
        if ($job.fitWidth -eq $true) {
            Progress 0.45 'Fitting sheets to page width'
            foreach ($ws in @($doc.Worksheets)) {
                try {
                    $ps = $ws.PageSetup
                    $ps.Zoom = $false
                    $ps.FitToPagesWide = 1
                    $ps.FitToPagesTall = $false
                } catch { }
            }
        }
        Progress 0.6 'Converting'
        $stage = 'convert'
        # Type(0=PDF), Filename, Quality(0=standard), IncludeDocProperties, IgnorePrintAreas, From, To, OpenAfterPublish
        $doc.ExportAsFixedFormat(0, $dest, 0, $true, $false, $missing, $missing, $false)
        Progress 0.9 'Saving'
        $doc.Close($false)
        Release $doc; $doc = $null
    }
    else {
        $docs = $app.Presentations
        Progress 0.3 'Opening the file'
        $stage = 'open'
        # FileName, ReadOnly(-1), Untitled(0), WithWindow(0)
        $doc = $docs.Open($source, -1, 0, 0)
        Progress 0.6 'Converting'
        $stage = 'convert'
        $doc.SaveAs($dest, 32)   # 32 = ppSaveAsPDF
        Progress 0.9 'Saving'
        $doc.Close()
        Release $doc; $doc = $null
    }

    if (-not (Test-Path -LiteralPath $dest)) {
        Fail 'nooutput' "$niceName finished but did not produce a file."
        $exitCode = 2
    } else {
        Emit 'SONIKA:OK'
    }
}
catch {
    $m = $_.Exception.Message
    if ($_.Exception.InnerException) { $m = $m + ' ' + $_.Exception.InnerException.Message }
    $mapped = Map-Error $m
    if ($stage -eq 'open' -and $mapped[0] -eq 'other') { $mapped = @('corrupt', 'This file could not be opened. It may be damaged or in a format it does not understand.') }
    Fail $mapped[0] $mapped[1]
    $exitCode = 2
}
finally {
    # Close our own document (never anything else), then quit ONLY an instance we started.
    if ($null -ne $doc) {
        try {
            if ($kind -eq 'word') { $doc.Close(0) } elseif ($kind -eq 'excel') { $doc.Close($false) } else { $doc.Close() }
        } catch { }
        Release $doc
    }
    Release $docs
    if ($null -ne $app) {
        if ($owned) {
            try {
                $app.Quit()
            } catch { }
        }
        Release $app
    }
    [GC]::Collect(); [GC]::WaitForPendingFinalizers(); [GC]::Collect()
    if ($owned -and $ownPids.Count -gt 0) {
        # Give the instance a moment to exit by itself, then make sure it is gone (only the PIDs we started).
        $deadline = (Get-Date).AddSeconds(10)
        while ((Get-Date) -lt $deadline -and (@($ownPids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }).Count -gt 0)) { Start-Sleep -Milliseconds 100 }
        foreach ($op in $ownPids) {
            $p = Get-Process -Id $op -ErrorAction SilentlyContinue
            if ($p) { try { $p.Kill() } catch { } }
        }
    }
}
exit $exitCode
