# Generates resources/icon.png (256) and resources/icon.ico (multi-size)
# Draws the SubSync anchor logo using GDI+ (System.Drawing)
Add-Type -AssemblyName System.Drawing

$repoRoot = Split-Path -Parent $PSScriptRoot
$resDir   = Join-Path $repoRoot 'resources'
if (-not (Test-Path $resDir)) { New-Item -ItemType Directory -Path $resDir | Out-Null }

$accent = [System.Drawing.Color]::FromArgb(234, 252, 136)   # #EAFC88
$bg     = [System.Drawing.Color]::FromArgb(15,  15,  19)    # #0f0f13

# Quadratic Bezier (Q) -> Cubic Bezier conversion helper for GDI+
function ConvertTo-Cubic($p0x, $p0y, $cx, $cy, $p2x, $p2y) {
    # P1 = P0 + 2/3 (C - P0); P2 = Pend + 2/3 (C - Pend)
    $c1x = $p0x + (2.0/3.0) * ($cx - $p0x)
    $c1y = $p0y + (2.0/3.0) * ($cy - $p0y)
    $c2x = $p2x + (2.0/3.0) * ($cx - $p2x)
    $c2y = $p2y + (2.0/3.0) * ($cy - $p2y)
    @($c1x, $c1y, $c2x, $c2y)
}

function Draw-Anchor($size, $padPx = 0, $roundedBg = $true) {
    # SVG viewBox is 64x64 - logical coordinates we'll scale
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    # transparent background
    $g.Clear([System.Drawing.Color]::Transparent)

    # Rounded rectangle background (dark surface)
    if ($roundedBg) {
        $bgBrush = New-Object System.Drawing.SolidBrush($bg)
        $r = [int]([Math]::Round($size * 0.18))
        $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
        $path = New-Object System.Drawing.Drawing2D.GraphicsPath
        $path.AddArc($rect.X,                $rect.Y,                $r*2, $r*2, 180, 90)
        $path.AddArc($rect.Right - $r*2,     $rect.Y,                $r*2, $r*2, 270, 90)
        $path.AddArc($rect.Right - $r*2,     $rect.Bottom - $r*2,    $r*2, $r*2, 0,   90)
        $path.AddArc($rect.X,                $rect.Bottom - $r*2,    $r*2, $r*2, 90,  90)
        $path.CloseFigure()
        $g.FillPath($bgBrush, $path)
        $bgBrush.Dispose()
        $path.Dispose()
    }

    # Inset drawing area for the anchor so it doesn't crowd the rounded bg
    $inset = $size * 0.08
    $drawSize = $size - 2*$inset
    $scale = $drawSize / 64.0
    $ox = $inset
    $oy = $inset

    # Stroke width: SVG uses 2.5 at 64 - keep proportional
    $strokeW = [Math]::Max(2, 2.5 * $scale)
    $pen = New-Object System.Drawing.Pen($accent, [single]$strokeW)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

    function S($x) { return [single]($ox + $x * $scale) }
    function T($y) { return [single]($oy + $y * $scale) }

    # Circle: cx=32, cy=14, r=5
    $g.DrawEllipse($pen, (S 27), (T 9), [single](10 * $scale), [single](10 * $scale))

    # Vertical line: (32,19) -> (32,52)
    $g.DrawLine($pen, (S 32), (T 19), (S 32), (T 52))

    # Left fluke: M18 30 Q10 30 10 40 Q10 52 22 52
    $c = ConvertTo-Cubic 18 30 10 30 10 40
    $g.DrawBezier($pen, (S 18), (T 30), (S $c[0]), (T $c[1]), (S $c[2]), (T $c[3]), (S 10), (T 40))
    $c = ConvertTo-Cubic 10 40 10 52 22 52
    $g.DrawBezier($pen, (S 10), (T 40), (S $c[0]), (T $c[1]), (S $c[2]), (T $c[3]), (S 22), (T 52))

    # Right fluke: M46 30 Q54 30 54 40 Q54 52 42 52
    $c = ConvertTo-Cubic 46 30 54 30 54 40
    $g.DrawBezier($pen, (S 46), (T 30), (S $c[0]), (T $c[1]), (S $c[2]), (T $c[3]), (S 54), (T 40))
    $c = ConvertTo-Cubic 54 40 54 52 42 52
    $g.DrawBezier($pen, (S 54), (T 40), (S $c[0]), (T $c[1]), (S $c[2]), (T $c[3]), (S 42), (T 52))

    # Horizontal crossbar: (18,30) -> (46,30)
    $g.DrawLine($pen, (S 18), (T 30), (S 46), (T 30))

    $pen.Dispose()
    $g.Dispose()
    return $bmp
}

# --- Save PNG (256x256) ---
$pngPath = Join-Path $resDir 'icon.png'
$png = Draw-Anchor 256 0 $true
$png.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "Wrote $pngPath"

# Also save a 1024x1024 for high-DPI / packaging
$png1024 = Draw-Anchor 1024 0 $true
$png1024.Save((Join-Path $resDir 'icon-1024.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$png1024.Dispose()

# --- Build a multi-resolution ICO ---
# Sizes commonly bundled in a Windows .ico
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$pngStreams = @()
foreach ($s in $sizes) {
    $bm = Draw-Anchor $s 0 $true
    $ms = New-Object System.IO.MemoryStream
    $bm.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngStreams += ,@($s, $ms.ToArray())
    $bm.Dispose()
    $ms.Dispose()
}

$icoPath = Join-Path $resDir 'icon.ico'
$fs = [System.IO.File]::Open($icoPath, [System.IO.FileMode]::Create)
$bw = New-Object System.IO.BinaryWriter($fs)

# ICONDIR (6 bytes): reserved, type=1 (icon), count
$bw.Write([uint16]0)                       # reserved
$bw.Write([uint16]1)                       # type 1 = icon
$bw.Write([uint16]$pngStreams.Count)       # number of images

# Offset for first image data starts after dir (6) + entries (16 each)
$offset = 6 + 16 * $pngStreams.Count

foreach ($entry in $pngStreams) {
    $w = $entry[0]; $data = $entry[1]
    # ICONDIRENTRY (16 bytes)
    $bw.Write([byte]($(if ($w -ge 256) {0} else {$w})))   # width (0 means 256)
    $bw.Write([byte]($(if ($w -ge 256) {0} else {$w})))   # height
    $bw.Write([byte]0)                                    # color palette
    $bw.Write([byte]0)                                    # reserved
    $bw.Write([uint16]1)                                  # color planes
    $bw.Write([uint16]32)                                 # bits per pixel
    $bw.Write([uint32]$data.Length)                       # image data size
    $bw.Write([uint32]$offset)                            # offset of image data
    $offset += $data.Length
}
foreach ($entry in $pngStreams) {
    $bw.Write($entry[1])
}
$bw.Flush()
$bw.Close()
$fs.Close()

Write-Output "Wrote $icoPath"
$png.Dispose()
