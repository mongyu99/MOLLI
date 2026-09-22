# 네이티브 Ollama가 받아둔 모델을 도커 볼륨으로 옮긴다.
#
#   .\import-models.ps1
#
# 도커 Ollama를 처음 띄우면 볼륨이 비어 있어서 페이지에 "모델 없음"이 뜬다.
# 여기서 ollama pull 로 다시 받으면 7.6GB를 인터넷에서 또 받는 셈인데,
# 이미 디스크에 있으므로 그냥 복사하면 된다.
#
# 이 파일은 UTF-8 BOM 으로 저장해야 한다 (start.ps1 주석 참고).

$src = "$env:USERPROFILE\.ollama\models"
$volume = "molli_ollama-models"

if (-not (Test-Path $src)) {
    Write-Host "네이티브 Ollama 모델 폴더가 없습니다: $src" -ForegroundColor Red
    Write-Host "옮길 것이 없다면 컨테이너 안에서 직접 받으세요:" -ForegroundColor DarkGray
    Write-Host "  docker exec molli-ollama ollama pull gemma3:12b" -ForegroundColor DarkGray
    exit 1
}

if (-not (docker volume ls --format "{{.Name}}" | Select-String -Quiet "^$volume$")) {
    Write-Host "볼륨 $volume 이 없습니다. 먼저 한 번 띄우세요:" -ForegroundColor Red
    Write-Host "  docker compose --profile ollama up -d" -ForegroundColor DarkGray
    exit 1
}

$size = [math]::Round((Get-ChildItem $src -Recurse -File | Measure-Object Length -Sum).Sum / 1GB, 2)
Write-Host "$src  ($size GB)  ->  볼륨 $volume" -ForegroundColor Cyan
Write-Host "로컬 복사입니다. 인터넷에서 받지 않습니다.`n" -ForegroundColor DarkGray

# 컨테이너가 돌고 있어도 괜찮다. Ollama는 요청이 올 때마다 매니페스트를 다시 읽는다.
docker run --rm -v "${volume}:/dest" -v "${src}:/src:ro" alpine `
    sh -c "cp -a /src/. /dest/models/ && du -sh /dest/models"

if ($LASTEXITCODE -ne 0) {
    Write-Host "`n복사에 실패했습니다." -ForegroundColor Red
    exit 1
}

Write-Host "`n확인:" -ForegroundColor Cyan
try {
    $t = Invoke-RestMethod "http://localhost:11434/api/tags" -TimeoutSec 5
    $names = ($t.models | ForEach-Object { $_.name }) -join ", "
    if ($names) {
        Write-Host "  도커 Ollama 모델: $names" -ForegroundColor Green
    } else {
        Write-Host "  아직 목록이 비어 있습니다. docker restart molli-ollama 후 다시 확인하세요." -ForegroundColor Yellow
    }
} catch {
    Write-Host "  11434가 응답하지 않습니다. docker compose --profile ollama up -d 로 띄우세요." -ForegroundColor Yellow
}
