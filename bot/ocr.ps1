# 윈도우에 들어 있는 글자 인식(Windows.Media.Ocr)을 부른다. 설치할 것이 없다.
# 브릿지가 이 스크립트를 한 번 띄워두고, 한 줄에 이미지 하나씩 보낸다 ("b64:" + base64).
# 임시 파일을 쓰면 앞 요청이 파일을 붙잡고 있어 다음 요청이 덮어쓰지 못할 때가 있었다.
# 이미지마다 JSON 한 줄로 답한다: {"lines":[{"text","x","y","w","h"}], "w", "h", "ms"}
# 좌표는 이미지 픽셀 기준이다.
#
# 시험용: powershell -File bot\ocr.ps1 -Paths 그림.png  → 그 파일만 읽고 끝난다.
# (-File 로 부르면 쉼표로 여러 개를 넘겨도 한 덩어리 문자열이 되니 하나씩 넘긴다)
param([string[]]$Paths, [string]$Lang = "ko")

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

# WinRT 비동기를 PowerShell 5.1 에서 기다리는 방법
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, [Type]$type) {
    $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($Lang))
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }

# 입력: "b64:..." 이면 그 바이트, 아니면 파일 경로
function Read-Image([string]$src) {
    $t0 = [Diagnostics.Stopwatch]::StartNew()
    try {
        if ($src.StartsWith("b64:")) {
            $bytes = [Convert]::FromBase64String($src.Substring(4))
        } else {
            $bytes = [IO.File]::ReadAllBytes($src)
        }
        $mem = New-Object System.IO.MemoryStream (, $bytes)
        $stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($mem)
        $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        $lines = @()
        foreach ($line in $result.Lines) {
            # 줄의 사각형은 단어 사각형들을 합쳐서 만든다
            $x0 = [double]::MaxValue; $y0 = [double]::MaxValue; $x1 = 0; $y1 = 0
            foreach ($w in $line.Words) {
                $r = $w.BoundingRect
                if ($r.X -lt $x0) { $x0 = $r.X }; if ($r.Y -lt $y0) { $y0 = $r.Y }
                if ($r.X + $r.Width -gt $x1) { $x1 = $r.X + $r.Width }
                if ($r.Y + $r.Height -gt $y1) { $y1 = $r.Y + $r.Height }
            }
            $lines += [ordered]@{ text = $line.Text; x = [int]$x0; y = [int]$y0; w = [int]($x1 - $x0); h = [int]($y1 - $y0) }
        }
        $stream.Dispose()
        return [ordered]@{ lines = $lines; w = $bitmap.PixelWidth; h = $bitmap.PixelHeight; ms = $t0.ElapsedMilliseconds; lang = $engine.RecognizerLanguage.LanguageTag }
    } catch {
        # 비동기 예외는 여러 겹으로 싸여 온다. 맨 안쪽이 진짜 원인이다
        $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }
        return [ordered]@{ error = $e.Message; ms = $t0.ElapsedMilliseconds }
    }
}

if ($Paths) {
    foreach ($p in $Paths) { (Read-Image $p) | ConvertTo-Json -Depth 5 -Compress }
    exit
}

# 준비됐다고 한 줄 알린다
[ordered]@{ ready = $true; lang = $engine.RecognizerLanguage.LanguageTag } | ConvertTo-Json -Compress
while ($true) {
    $src = [Console]::In.ReadLine()
    if ($null -eq $src) { break }
    $src = $src.Trim()
    if (-not $src) { continue }
    (Read-Image $src) | ConvertTo-Json -Depth 5 -Compress
}
