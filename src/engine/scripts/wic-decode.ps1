# Decodes a picture with Windows' own codecs (WIC) and saves it as PNG. Used as a fallback for iPhone HEIC photos
# when sharp/FFmpeg cannot decode them. Needs the Microsoft "HEIF Image Extensions" + "HEVC Video Extensions" (installed
# on most Windows 11 PCs). Output protocol: SONIKA:OK:<width>x<height>  or  SONIKA:ERR:<message>.
# ASCII only.
param([Parameter(Mandatory = $true)][string]$InFile, [Parameter(Mandatory = $true)][string]$OutFile)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName PresentationCore
    $in = [System.IO.File]::OpenRead($InFile)
    try {
        $dec = [System.Windows.Media.Imaging.BitmapDecoder]::Create($in, [System.Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat, [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad)
        $frame = $dec.Frames[0]
        $enc = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
        $enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($frame))
        $out = [System.IO.File]::Create($OutFile)
        try { $enc.Save($out) } finally { $out.Close() }
        [Console]::Out.WriteLine(('SONIKA:OK:{0}x{1}' -f $frame.PixelWidth, $frame.PixelHeight))
    } finally { $in.Close() }
} catch {
    $m = ($_.Exception.Message -replace '[\r\n]+', ' ')
    [Console]::Out.WriteLine('SONIKA:ERR:' + $m)
    exit 2
}
