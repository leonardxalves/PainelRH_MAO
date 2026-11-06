<#
  Publica a versão desta pasta (git pull ou cópia feitos antes). Rode como administrador, na pasta do projeto:

    powershell -ExecutionPolicy Bypass -File .\deploy\atualizar.ps1

  1. npm ci (dependências do package-lock).
  2. Reinicia o serviço do Node.
  3. Confere o /health.
  O front (public\) é servido direto pelo IIS: alterou, a TV pega na próxima carga (sem cache).
  Vídeos/imagens: basta copiar para public\videos_mao, a TV atualiza sozinha (SSE / a cada 30 s).
#>
param(
  [string]$Servico = 'PainelRH_MAO',
  [int]$PortaNode = 8000
)

$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot

function Passo($texto) { Write-Host "`n==> $texto" -ForegroundColor Cyan }

Passo 'npm ci'
Push-Location $raiz
try {
  cmd /c 'npm ci --omit=dev --no-audit --no-fund'
  if ($LASTEXITCODE -ne 0) { throw 'npm ci falhou.' }
} finally { Pop-Location }

$svc = Get-Service -Name $Servico -ErrorAction SilentlyContinue
if ($svc) {
  Passo "Reiniciando o serviço $Servico"
  if ($svc.Status -ne 'Stopped') { Stop-Service $Servico }
  Start-Service $Servico
} else {
  Write-Warning "Serviço $Servico não existe: rode o deploy\instalar.ps1."
}

Passo 'Conferindo o backend'
$ok = $false
foreach ($tentativa in 1..15) {
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$PortaNode/health" -TimeoutSec 3 | Out-Null
    $ok = $true
    break
  } catch { Start-Sleep -Seconds 2 }
}
if ($ok) {
  Write-Host "`nPronto. Recarregue a página na TV." -ForegroundColor Green
} else {
  Write-Warning "O Node não respondeu em http://127.0.0.1:$PortaNode/health. Veja $raiz\logs\$Servico.err.log e $Servico.out.log."
}
