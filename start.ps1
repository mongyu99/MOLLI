# 몰리 한 방에 띄우기
#
#   .\start.ps1          안전모드 - 실제 키는 누르지 않고 무엇을 누르려 했는지만 찍는다
#   .\start.ps1 -Live    실제로 키를 누른다
#   .\start.ps1 -Remote  폰으로 보기 창구도 연다 (보기 + 정지·시작·말 지시, 연결 코드로 등록한 기기만)
#                        -Live 와 같이 쓸 수 있다: .\start.ps1 -Live -Remote
#
# 도커(게임 페이지 + 선택적으로 Ollama)를 먼저 올리고, 도커에 담을 수 없는 브릿지만
# 이 창에서 띄운다. 브릿지는 호스트 윈도우 데스크톱에 키를 보내야 해서 컨테이너에
# 넣을 수 없다 (docker-compose.yml 의 설명 참고).
#
# 이 파일은 반드시 UTF-8 BOM 으로 저장해야 한다. Windows PowerShell 5.1 은 BOM 이 없으면
# .ps1 을 ANSI(CP949)로 읽어서 한글이 깨지고 파싱까지 실패한다.

param([switch]$Live, [switch]$Remote)

$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $root

# 출력 인코딩은 건드리지 않는다. 콘솔로 바로 나갈 때는 PowerShell 도 파이썬도
# 콘솔 API 를 쓰므로 한글이 그대로 나온다. 여기서 [Console]::OutputEncoding 을
# UTF-8 로 바꾸면 오히려 다른 셸이 감싸 실행할 때 전부 깨진다 (실제로 겪었다).

function Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }

# 도커는 진행 상황을 stderr 로 찍는다. 그대로 두면 정상 동작인데도 PowerShell 이
# 빨간 에러로 보여주므로, 성공 여부는 종료 코드로만 판단한다.
function Invoke-Docker {
    param([string[]]$DockerArgs)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & docker @DockerArgs 2>&1 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev
    return $code
}

# ---------------------------------------------------------------- 1. 도커
Step 1 "게임 페이지 컨테이너 올리는 중"
if ((Invoke-Docker @("compose", "up", "-d")) -ne 0) {
    Write-Host "  도커를 띄우지 못했습니다. Docker Desktop이 실행 중인지 확인하세요." -ForegroundColor Red
    exit 1
}

# 컨테이너가 떴다고 해서 nginx가 바로 응답하는 건 아니다. 실제로 받아질 때까지 기다린다.
# 주소는 127.0.0.1 로 묻는다. 페이지는 127.0.0.1 에만 묶여 있어서, localhost 로 물으면 IPv6(::1)
# 쪽으로 먼저 가서 매번 2초씩 기다리다 끝난다 — 20번이면 50초 가까이 멈춘 것처럼 보였다 (실제로 겪었다).
# 브라우저는 알아서 IPv4 로 넘어가므로 사용자에게는 그대로 localhost 주소를 알려준다
# (주소를 바꾸면 브라우저에 저장된 설정이 다른 사이트 것으로 취급돼 안 보인다).
$ok = $false
Write-Host "  페이지 응답 기다리는 중" -NoNewline -ForegroundColor DarkGray
foreach ($i in 1..20) {
    try {
        if ((Invoke-WebRequest "http://127.0.0.1:8743/" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) {
            $ok = $true; break
        }
    } catch {
        Write-Host "." -NoNewline -ForegroundColor DarkGray
        Start-Sleep -Milliseconds 400
    }
}
Write-Host ""
if ($ok) {
    Write-Host "  게임 페이지  http://localhost:8743  (브릿지 없이도 향기추적/지뢰찾기는 됩니다)" -ForegroundColor Green
} else {
    Write-Host "  게임 페이지가 응답하지 않습니다. docker compose logs web 으로 확인하세요." -ForegroundColor Red
}

# ---------------------------------------------------------------- 2. Ollama
# 네이티브든 도커든 상관없다. 브릿지는 주소만 보고 부른다.
Step 2 "Ollama 확인"
try {
    $tags = Invoke-RestMethod "http://127.0.0.1:11434/api/tags" -TimeoutSec 3
    $where = if (docker ps --format "{{.Names}}" | Select-String -Quiet "molli-ollama") { "도커" } else { "네이티브" }
    $names = ($tags.models | ForEach-Object { $_.name }) -join ", "
    if (-not $names) { $names = "없음" }
    Write-Host "  $where · 모델: $names" -ForegroundColor Green

    # 모델이 VRAM에 없으면 첫 판별이 수십 초 걸린다. 올라가 있는지 알려만 준다.
    $ps = (Invoke-RestMethod "http://127.0.0.1:11434/api/ps" -TimeoutSec 3).models
    if ($ps) {
        foreach ($m in $ps) {
            $gpu = if ($m.size -gt 0) { [math]::Round(100 * $m.size_vram / $m.size) } else { 0 }
            Write-Host ("  올라가 있음: {0}  VRAM {1}GB  GPU {2}%" -f $m.name, [math]::Round($m.size_vram / 1GB, 1), $gpu) -ForegroundColor Green
        }
    } else {
        Write-Host "  아직 VRAM에 올라간 모델이 없습니다 - 페이지에서 체크박스를 켜면 예열합니다" -ForegroundColor DarkGray
    }
} catch {
    Write-Host "  Ollama가 응답하지 않습니다. 레벨업 LLM 기능만 안 됩니다 - 나머지는 그대로 돕니다." -ForegroundColor Yellow
    Write-Host "  도커로 띄우려면: docker compose --profile ollama up -d" -ForegroundColor DarkGray
}

# ---------------------------------------------------------------- 3. 브릿지
Step 3 "브릿지 (호스트에서 실행 - 도커 불가)"
$py = Join-Path $root "bot\.venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
    # 새 PC 에서 처음 띄울 때. 가상환경은 깃에 올리지 않으므로 여기서 만든다.
    $sysPy = Get-Command python -ErrorAction SilentlyContinue
    if (-not $sysPy) {
        Write-Host "  파이썬이 없습니다. python.org 에서 3.10 이상을 설치하고 다시 실행하세요." -ForegroundColor Red
        exit 1
    }
    Write-Host "  bot\.venv 가 없어서 만듭니다 (처음 한 번만)" -ForegroundColor Yellow
    & $sysPy.Source -m venv (Join-Path $root "bot\.venv")
    & $py -m pip install --disable-pip-version-check -q -r (Join-Path $root "bot\requirements.txt")
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  패키지를 설치하지 못했습니다. 인터넷 연결을 확인하세요." -ForegroundColor Red
        exit 1
    }
}

# --no-web: 페이지는 nginx 컨테이너가 서빙하므로 브릿지는 HTTP를 열지 않는다
$bridgeArgs = @("bot\bridge.py", "--no-web")
if ($Live) {
    Write-Host "  실제 입력 모드입니다. 게임 창을 활성화해 두세요." -ForegroundColor Yellow
    $bridgeArgs += "--live"
} else {
    Write-Host "  안전모드입니다. 실제로 키를 누르게 하려면 .\start.ps1 -Live" -ForegroundColor DarkGray
}
if ($Remote) {
    # 폰은 PC 와 같은 와이파이에서, 페이지의 '폰으로 보기' 에서 만든 코드로 등록한다.
    $bridgeArgs += "--remote"
    Write-Host "  폰으로 보기를 켭니다. 처음 켤 때 윈도우 방화벽이 물어보면 허용해야 폰이 닿습니다." -ForegroundColor Yellow
}
Write-Host "  멈추려면 이 창에서 Ctrl+C (도커는 계속 떠 있습니다 - 내리려면 .\stop.ps1)`n" -ForegroundColor DarkGray

& $py @bridgeArgs
