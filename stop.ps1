# 도커 서비스를 내린다. 브릿지는 start.ps1 을 띄운 창에서 Ctrl+C 로 멈춘다.
#
#   .\stop.ps1           컨테이너만 내린다 (Ollama 모델 볼륨은 남는다)
#   .\stop.ps1 -Purge    Ollama 모델 볼륨까지 지운다 (다시 받아야 한다)

param([switch]$Purge)

$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $root

if ($Purge) {
    Write-Host "컨테이너와 Ollama 모델 볼륨까지 내립니다 (모델은 다시 받아야 합니다)" -ForegroundColor Yellow
    docker compose --profile ollama down -v
} else {
    docker compose --profile ollama down
    Write-Host "내렸습니다. Ollama 모델 볼륨은 그대로 남아 있습니다." -ForegroundColor Green
}
