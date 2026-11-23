# Test-fixture generator: asks Word / Excel / PowerPoint (own hidden instances) to save small sample files.
# ASCII only. Usage: powershell -NoProfile -ExecutionPolicy Bypass -File make-office-fixtures.ps1 -Dir <folder> -SourceDocx <existing.docx>
param([string]$Dir, [string]$SourceDocx)
$ErrorActionPreference = 'Stop'
# Plain .NET strings only: Join-Path output is a wrapped PSObject, which Word's SaveAs2 hangs on.
function P([string]$name) { return [string]::Concat($Dir.TrimEnd([char]92), [string][char]92, $name) }
function Ids($n) { @(Get-Process -Name $n -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) }
function Start-Own($prog, $proc) {
    $b = Ids $proc
    $a = New-Object -ComObject $prog
    Start-Sleep -Milliseconds 250
    $n = @((Ids $proc) | Where-Object { $b -notcontains $_ })
    return @{ App = $a; Pid = $(if ($n.Count -gt 0) { $n[0] } else { 0 }) }
}
function Stop-Own($h, $quitArg) {
    try { if ($h.Pid -gt 0) { $h.App.Quit() } } catch { }
    try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($h.App) } catch { }
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
    if ($h.Pid -gt 0) {
        Start-Sleep -Seconds 2
        $p = Get-Process -Id $h.Pid -ErrorAction SilentlyContinue
        if ($p) { $p.Kill() }
    }
}

Write-Output 'step word'
# Word: .doc .odt .rtf from the docx
$w = Start-Own 'Word.Application' 'WINWORD'
try {
    $w.App.Visible = $false; $w.App.DisplayAlerts = 0
    $d = $w.App.Documents.Open($SourceDocx, $false, $true)
    $d.SaveAs2((P 'sample-word.doc'), 0)
    $d.SaveAs2((P 'sample-word.odt'), 23)
    $d.SaveAs2((P 'sample-word.rtf'), 6)
    $d.SaveAs2((P 'sample-protected.docx'), 16, $false, 'secret123')
    $d.Close(0)
} finally { Stop-Own $w }

Write-Output 'step excel'
# Excel: .xlsx .xls with a wide table
$x = Start-Own 'Excel.Application' 'EXCEL'
try {
    $x.App.Visible = $false; $x.App.DisplayAlerts = $false
    $wb = $x.App.Workbooks.Add()
    $ws = $wb.Worksheets.Item(1)
    $ws.Cells.Item(1, 1).Value2 = 'Sonika Excel Fixture'
    for ($c = 2; $c -le 20; $c++) { $ws.Cells.Item(1, $c).Value2 = "Column$c" }
    for ($r = 2; $r -le 12; $r++) { for ($c = 1; $c -le 20; $c++) { $ws.Cells.Item($r, $c).Value2 = $r * $c } }
    $ws.Columns.Item(1).ColumnWidth = 32
    $wb.SaveAs((P 'sample-sheet.xlsx'), 51)
    $wb.SaveAs((P 'sample-sheet.xls'), 56)
    $wb.Close($false)
} finally { Stop-Own $x }

Write-Output 'step ppt'
# PowerPoint: .pptx .ppt, two slides
$pb = Ids 'POWERPNT'
$p = New-Object -ComObject 'PowerPoint.Application'
Start-Sleep -Milliseconds 250
$pn = @((Ids 'POWERPNT') | Where-Object { $pb -notcontains $_ })
$h = @{ App = $p; Pid = $(if ($pn.Count -gt 0) { $pn[0] } else { 0 }) }
try {
    $pres = $p.Presentations.Add(0)
    for ($i = 1; $i -le 2; $i++) {
        $s = $pres.Slides.Add($i, 12)   # ppLayoutBlank
        $tb = $s.Shapes.AddTextbox(1, 60, 100, 600, 80)
        $tb.TextFrame.TextRange.Text = "Sonika Slide Fixture $i"
        $tb.TextFrame.TextRange.Font.Size = 40
    }
    $pres.SaveAs((P 'sample-slides.pptx'), 24)
    $pres.SaveAs((P 'sample-slides.ppt'), 1)
    $pres.Close()
} finally { Stop-Own $h }
Write-Output 'FIXTURES-OK'
