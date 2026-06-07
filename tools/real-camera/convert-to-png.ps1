# tools/real-camera/convert-to-png.ps1
# Pillar 7 real-camera kit (2): batch-convert phone JPEGs to PNG via System.Drawing.
#   Keeps the core dependency-zero (scanPhoto reads PNG). This is measurement infra only.
#   ASCII-only output on purpose (avoids PS 5.1 non-BOM mojibake; see memory environment note).
# Usage: powershell -ExecutionPolicy Bypass -File tools/real-camera/convert-to-png.ps1 <photosDir>
param([Parameter(Mandatory = $true)][string]$Dir)

if (-not (Test-Path -LiteralPath $Dir)) { Write-Error "Dir not found: $Dir"; exit 1 }
Add-Type -AssemblyName System.Drawing

$files = Get-ChildItem -Path (Join-Path $Dir '*') -Include *.jpg, *.jpeg -File
if (-not $files) { Write-Output "No .jpg/.jpeg found in $Dir"; exit 0 }

$n = 0
foreach ($f in $files) {
  $out = [System.IO.Path]::ChangeExtension($f.FullName, '.png')
  try {
    $img = [System.Drawing.Image]::FromFile($f.FullName)
    try { $img.Save($out, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $img.Dispose() }
    $n++
    Write-Output ("PNG: {0}" -f (Split-Path $out -Leaf))
  } catch {
    Write-Warning ("FAILED {0}: {1}" -f $f.Name, $_.Exception.Message)
  }
}
Write-Output ("Converted {0} file(s) to PNG. Now run: node tools/real-camera/measure.mjs {1}" -f $n, $Dir)
