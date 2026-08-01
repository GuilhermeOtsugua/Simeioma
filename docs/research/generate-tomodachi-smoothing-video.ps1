Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSCommandPath
$media = Join-Path $root 'media'
$frames = Join-Path $media '.png-frames'
$width = 1080
$height = 640
$frameCount = 84
$fps = 24

Remove-Item -LiteralPath $frames -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $frames -Force | Out-Null

$raw = for ($index = 0; $index -lt $frameCount; $index++) {
  $t = $index / ($frameCount - 1)
  [PSCustomObject]@{
    X = 84 + $t * 914 + [Math]::Sin($index * 2.21) * 4.8 + [Math]::Sin($index * 0.47) * 2.1
    Y = 342 - [Math]::Sin($t * [Math]::PI * 1.92) * 126 + [Math]::Cos($index * 1.83) * 5.9 + [Math]::Sin($index * 0.31) * 3.4
    T = $index / $fps
  }
}

function Get-Alpha([double]$cutoff, [double]$dt) {
  $tau = 1 / (2 * [Math]::PI * $cutoff)
  return 1 / (1 + $tau / $dt)
}

function Get-OneEuro([object[]]$points) {
  $output = [System.Collections.Generic.List[object]]::new()
  $previousX = $null; $previousY = $null; $derivativeX = $null; $derivativeY = $null; $previousTime = $null
  foreach ($point in $points) {
    if ($null -eq $previousTime) {
      $previousX = $point.X; $previousY = $point.Y; $previousTime = $point.T
      $output.Add([PSCustomObject]@{ X = $point.X; Y = $point.Y })
      continue
    }
    $dt = [Math]::Max($point.T - $previousTime, 1 / 240)
    $dx = ($point.X - $previousX) / $dt; $dy = ($point.Y - $previousY) / $dt
    $derivativeAlpha = Get-Alpha 1.0 $dt
    $derivativeX = $derivativeX + $derivativeAlpha * ($dx - $derivativeX)
    $derivativeY = $derivativeY + $derivativeAlpha * ($dy - $derivativeY)
    $speed = [Math]::Sqrt($derivativeX * $derivativeX + $derivativeY * $derivativeY)
    $pointAlpha = Get-Alpha (1.35 + 0.012 * $speed) $dt
    $previousX = $previousX + $pointAlpha * ($point.X - $previousX)
    $previousY = $previousY + $pointAlpha * ($point.Y - $previousY)
    $previousTime = $point.T
    $output.Add([PSCustomObject]@{ X = $previousX; Y = $previousY })
  }
  return $output.ToArray()
}

function Get-Resampled([object[]]$points, [double]$spacing = 4.4) {
  if ($points.Count -lt 2) { return $points }
  $output = [System.Collections.Generic.List[object]]::new(); $output.Add($points[0])
  $carry = 0.0; $cursor = $points[0]
  foreach ($next in $points[1..($points.Count - 1)]) {
    $distance = [Math]::Sqrt(($next.X - $cursor.X) * ($next.X - $cursor.X) + ($next.Y - $cursor.Y) * ($next.Y - $cursor.Y))
    while (($carry + $distance -ge $spacing) -and ($distance -gt 0.0001)) {
      $ratio = ($spacing - $carry) / $distance
      $cursor = [PSCustomObject]@{ X = $cursor.X + ($next.X - $cursor.X) * $ratio; Y = $cursor.Y + ($next.Y - $cursor.Y) * $ratio }
      $output.Add($cursor)
      $distance = [Math]::Sqrt(($next.X - $cursor.X) * ($next.X - $cursor.X) + ($next.Y - $cursor.Y) * ($next.Y - $cursor.Y))
      $carry = 0.0
    }
    $carry += $distance; $cursor = $next
  }
  $output.Add($points[-1])
  return $output.ToArray()
}

function New-RoundedRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new(); $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90); $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90); $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure(); return $path
}

function Draw-MidpointPath($graphics, [object[]]$points, [int]$count, [float]$offsetY, $pen) {
  if ($count -lt 2) { return }
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $start = $points[0]; $currentX = $start.X; $currentY = $start.Y + $offsetY
  for ($i = 1; $i -lt $count; $i++) {
    $previous = $points[$i - 1]; $point = $points[$i]
    $endX = ($previous.X + $point.X) / 2; $endY = ($previous.Y + $point.Y) / 2 + $offsetY
    $controlX = $previous.X; $controlY = $previous.Y + $offsetY
    $c1X = $currentX + 2 / 3 * ($controlX - $currentX); $c1Y = $currentY + 2 / 3 * ($controlY - $currentY)
    $c2X = $endX + 2 / 3 * ($controlX - $endX); $c2Y = $endY + 2 / 3 * ($controlY - $endY)
    $path.AddBezier($currentX, $currentY, $c1X, $c1Y, $c2X, $c2Y, $endX, $endY)
    $currentX = $endX; $currentY = $endY
  }
  $last = $points[$count - 1]; $path.AddLine($currentX, $currentY, $last.X, $last.Y + $offsetY)
  $graphics.DrawPath($pen, $path); $path.Dispose()
}

$filtered = Get-OneEuro $raw
$target = Get-Resampled $filtered
$background = [System.Drawing.ColorTranslator]::FromHtml('#F6EFE5')
$panelFill = [System.Drawing.ColorTranslator]::FromHtml('#FFFAF1')
$panelBorder = [System.Drawing.ColorTranslator]::FromHtml('#E4D9CA')
$guide = [System.Drawing.ColorTranslator]::FromHtml('#EEE4D8')
$rawColor = [System.Drawing.ColorTranslator]::FromHtml('#A67C52')
$currentColor = [System.Drawing.ColorTranslator]::FromHtml('#B75A67')
$targetColor = [System.Drawing.ColorTranslator]::FromHtml('#2F7C69')
$ink = [System.Drawing.ColorTranslator]::FromHtml('#2E2923')
$copy = [System.Drawing.ColorTranslator]::FromHtml('#766B60')
$footer = [System.Drawing.ColorTranslator]::FromHtml('#86786C')
$titleFont = [System.Drawing.Font]::new('Cascadia Mono', 29, [System.Drawing.FontStyle]::Bold)
$eyebrowFont = [System.Drawing.Font]::new('Cascadia Mono', 13, [System.Drawing.FontStyle]::Bold)
$panelTitleFont = [System.Drawing.Font]::new('Cascadia Mono', 14, [System.Drawing.FontStyle]::Bold)
$bodyFont = [System.Drawing.Font]::new('Cascadia Mono', 12)
$footerFont = [System.Drawing.Font]::new('Cascadia Mono', 10)

for ($frame = 0; $frame -lt $frameCount; $frame++) {
  $bitmap = [System.Drawing.Bitmap]::new($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  $graphics.Clear($background)
  $graphics.DrawString('SIMEIOMA / SKETCH RESEARCH', $eyebrowFont, [System.Drawing.SolidBrush]::new($rawColor), 38, 28)
  $graphics.DrawString('Target: calm ink, not soft focus', $titleFont, [System.Drawing.SolidBrush]::new($ink), 38, 58)
  $graphics.DrawString('Same noisy gesture  |  current midpoint path  |  proposed adaptive input + spacing + coverage edge', $bodyFont, [System.Drawing.SolidBrush]::new($copy), 38, 106)

  $panels = @(
    @{ Y = 138; Title = '01 / RAW POINTER SAMPLES'; Detail = 'Every event is a visible wobble; no smoothing or spacing control.'; Color = $rawColor; Points = $raw; Count = $frame + 1; Offset = -116; Width = 3; Dots = $true },
    @{ Y = 302; Title = '02 / CURRENT SIMEIOMA'; Detail = 'Quadratic midpoints round corners, but preserve sample-rate chatter.'; Color = $currentColor; Points = $raw; Count = $frame + 1; Offset = 48; Width = 4; Dots = $false },
    @{ Y = 466; Title = '03 / ADAPTIVE SIMEIOMA STUDY'; Detail = 'A Simeioma candidate: stable when slow; responsive when fast. Not game-raster evidence.'; Color = $targetColor; Points = $target; Count = [Math]::Min($target.Count, [Math]::Round(($frame / ($frameCount - 1)) * ($target.Count - 1)) + 1); Offset = 212; Width = 6; Dots = $false }
  )
  foreach ($panel in $panels) {
    $shape = New-RoundedRect 34 $panel.Y 1012 144 20
    $graphics.FillPath([System.Drawing.SolidBrush]::new($panelFill), $shape); $graphics.DrawPath([System.Drawing.Pen]::new($panelBorder, 1), $shape); $shape.Dispose()
    $graphics.DrawString($panel.Title, $panelTitleFont, [System.Drawing.SolidBrush]::new($panel.Color), 64, $panel.Y + 22)
    $graphics.DrawString($panel.Detail, $bodyFont, [System.Drawing.SolidBrush]::new($copy), 64, $panel.Y + 51)
    $dash = [System.Drawing.Pen]::new($guide, 2); $dash.DashPattern = @(3, 8); $graphics.DrawLine($dash, 64, $panel.Y + 112, 1016, $panel.Y + 112); $dash.Dispose()
    if ($panel.Dots) {
      for ($i = 0; $i -lt $panel.Count; $i++) { $point = $panel.Points[$i]; $graphics.FillEllipse([System.Drawing.SolidBrush]::new($rawColor), $point.X - 2.3, $point.Y + $panel.Offset - 2.3, 4.6, 4.6) }
    } else {
      $pen = [System.Drawing.Pen]::new($panel.Color, $panel.Width); $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round; $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round; $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
      Draw-MidpointPath $graphics $panel.Points $panel.Count $panel.Offset $pen; $pen.Dispose()
    }
    $tip = $panel.Points[$panel.Count - 1]; $marker = [System.Drawing.Pen]::new($panel.Color, 3)
    $graphics.FillEllipse([System.Drawing.SolidBrush]::new($panelFill), $tip.X - 5, $tip.Y + $panel.Offset - 5, 10, 10); $graphics.DrawEllipse($marker, $tip.X - 5, $tip.Y + $panel.Offset - 5, 10, 10); $marker.Dispose()
  }
  $graphics.DrawString('Research visualisation — reconstructed target behaviour, not Nintendo footage or a claim of its internal implementation.', $footerFont, [System.Drawing.SolidBrush]::new($footer), 38, 612)
  $framePath = Join-Path $frames ('frame-{0:D3}.png' -f $frame)
  $bitmap.Save($framePath, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose(); $bitmap.Dispose()
}

Copy-Item (Join-Path $frames ('frame-{0:D3}.png' -f ($frameCount - 1))) (Join-Path $media 'tomodachi-smoothing-comparison.png') -Force
$ffmpeg = (Get-Command ffmpeg -ErrorAction Stop).Source
& $ffmpeg -y -framerate $fps -i (Join-Path $frames 'frame-%03d.png') -vf 'format=yuv420p' -movflags '+faststart' -c:v libx264 -crf 22 (Join-Path $media 'tomodachi-smoothing-comparison.mp4')
if ($LASTEXITCODE -ne 0) { throw 'ffmpeg MP4 encoding failed.' }
& $ffmpeg -y -framerate $fps -i (Join-Path $frames 'frame-%03d.png') -filter_complex '[0:v]fps=24,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4' -loop 0 (Join-Path $media 'tomodachi-smoothing-comparison.gif')
if ($LASTEXITCODE -ne 0) { throw 'ffmpeg GIF encoding failed.' }

Remove-Item -LiteralPath $frames -Recurse -Force
Write-Output "Generated PNG, MP4, and GIF smoothing study media in $media"
