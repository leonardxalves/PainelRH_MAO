<#
  Instalação do Painel RH (Manaus) num servidor Windows com IIS - mesmo modelo do Portal de XML.
  Rode uma vez, como administrador, na pasta do projeto:

    powershell -ExecutionPolicy Bypass -File .\deploy\instalar.ps1 -HostName painel_mao.pce.br

  Pré-requisitos (o script confere e avisa o que faltar):
    - Node.js (LTS) no PATH
    - IIS com URL Rewrite e Application Request Routing (ARR) - os mesmos do Portal de XML
    - WinSW (por padrão, o mesmo .exe do serviço do Portal de XML)
    - Projeto FORA da pasta do usuário (ex.: C:\PainelRH_MAO). O pool do IIS não lê C:\Users\...\Desktop.

  O que faz:
    1. Liga o proxy do ARR e zera o buffer de resposta (para o SSE de "mídia atualizada" chegar na hora).
    2. Cria o serviço PainelRH_MAO com WinSW (node server.js, início automático, logs em logs\).
    3. Cria o pool e o site no IIS apontando para a pasta public\ e dá leitura ao pool.
    4. Instala as dependências e sobe o serviço (deploy\atualizar.ps1).
#>
param(
  [string]$HostName = '',
  [int]$Porta = 80,
  [int]$PortaNode = 8000,
  [string]$SiteName = 'PainelRH_MAO',
  [string]$Servico = 'PainelRH_MAO',
  # WinSW: reaproveita o mesmo executável do serviço do Portal de XML.
  [string]$WinswExe = 'E:\webroot\wwwroot\portal-xml\backend\service\PceXmlPortal.exe'
)

$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
$public = Join-Path $raiz 'public'
$videos = Join-Path $public 'videos_mao'
$appcmd = Join-Path $env:windir 'System32\inetsrv\appcmd.exe'

function Passo($texto) { Write-Host "`n==> $texto" -ForegroundColor Cyan }

# --- Conferências -------------------------------------------------------------------------------------------------
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'Rode o PowerShell como administrador.' }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js não encontrado. Instale o Node.js LTS (https://nodejs.org).' }

if (-not (Test-Path $appcmd)) { throw 'IIS não encontrado.' }
if (-not (Test-Path (Join-Path $env:windir 'System32\inetsrv\rewrite.dll'))) {
  throw 'Falta o módulo URL Rewrite do IIS: https://www.iis.net/downloads/microsoft/url-rewrite'
}
if (-not (Test-Path (Join-Path $env:ProgramFiles 'IIS\Application Request Routing\requestRouter.dll'))) {
  throw 'Falta o Application Request Routing (ARR): https://www.iis.net/downloads/microsoft/application-request-routing'
}
if ($raiz -like "$env:SystemDrive\Users\*") {
  throw "O projeto está em $raiz. Copie para fora da pasta do usuário (ex.: C:\PainelRH_MAO): o pool do IIS não tem acesso ao perfil."
}
if (-not (Test-Path (Join-Path $public 'web.config'))) { throw 'Falta o public\web.config.' }

# --- 1. Proxy do ARR ----------------------------------------------------------------------------------------------
Passo 'Ligando o proxy do ARR'
# Mesmos valores do Portal de XML (timeout 10 min, preserveHostHeader), mais responseBufferLimit 0 para o SSE.
# responseBufferLimit é global: no Portal de XML só faz o ARR repassar a resposta sem acumular, sem efeito visível.
& $appcmd set config -section:system.webServer/proxy /enabled:"True" /timeout:"00:10:00" /preserveHostHeader:"True" /responseBufferLimit:"0" /commit:apphost | Out-Null

# --- 2. Serviço do Node (WinSW, igual ao Portal de XML) -----------------------------------------------------------
if (Get-Service -Name $Servico -ErrorAction SilentlyContinue) {
  Write-Host "Serviço $Servico já existe: mantido."
} else {
  Passo "Criando o serviço $Servico (porta $PortaNode)"
  if (-not (Test-Path $WinswExe)) { throw "WinSW não encontrado em $WinswExe. Informe -WinswExe <caminho do WinSW .exe>." }
  $ocupada = Get-NetTCPConnection -LocalPort $PortaNode -State Listen -ErrorAction SilentlyContinue
  if ($ocupada) {
    throw "A porta $PortaNode já está em uso (PID $($ocupada[0].OwningProcess)). Feche o node que roda no Git Bash antes de instalar o serviço."
  }

  # O WinSW lê a configuração de um .xml com o mesmo nome do .exe, na mesma pasta.
  $serviceDir = Join-Path $raiz 'service'
  $logs = Join-Path $raiz 'logs'
  New-Item -ItemType Directory -Force -Path $serviceDir, $logs | Out-Null
  $serviceExe = Join-Path $serviceDir "$Servico.exe"
  Copy-Item $WinswExe $serviceExe -Force

  function Escape-Xml([string] $value) { [System.Security.SecurityElement]::Escape($value) }

  $config = @"
<service>
  <id>$Servico</id>
  <name>Painel RH - Manaus</name>
  <description>Painel de TV do RH (Manaus). O IIS repassa /api para http://127.0.0.1:$PortaNode.</description>
  <executable>$(Escape-Xml $node)</executable>
  <arguments>server.js</arguments>
  <workingdirectory>$(Escape-Xml $raiz)</workingdirectory>
  <env name="PORT" value="$PortaNode" />
  <env name="HOST" value="127.0.0.1" />
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
  <onfailure action="restart" delay="10 sec" />
  <onfailure action="restart" delay="30 sec" />
  <onfailure action="restart" delay="60 sec" />
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>15 sec</stoptimeout>
  <logpath>$(Escape-Xml $logs)</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>
</service>
"@
  Set-Content -Path (Join-Path $serviceDir "$Servico.xml") -Value $config -Encoding UTF8

  & $serviceExe install
  if ($LASTEXITCODE -ne 0) { throw "Falha ao instalar o serviço (código $LASTEXITCODE)." }
}

if ($PortaNode -ne 8000) {
  Write-Warning "Porta do Node = ${PortaNode}: troque 127.0.0.1:8000 por 127.0.0.1:$PortaNode no public\web.config."
}

# --- 3. Site no IIS -----------------------------------------------------------------------------------------------
Import-Module WebAdministration
New-Item -ItemType Directory -Force -Path $videos | Out-Null

if (-not (Test-Path "IIS:\AppPools\$SiteName")) {
  Passo "Criando o pool $SiteName"
  New-WebAppPool -Name $SiteName | Out-Null
  Set-ItemProperty "IIS:\AppPools\$SiteName" -Name managedRuntimeVersion -Value ''
}
if (Get-Website -Name $SiteName) {
  Write-Host "Site $SiteName já existe: mantido."
} else {
  $emUso = Get-WebBinding | Where-Object { $_.bindingInformation -eq "*:${Porta}:$HostName" }
  if ($emUso) {
    throw "A porta $Porta$(if ($HostName) { " com o host $HostName" }) já está em uso (Portal de XML / Default Web Site?). Informe -HostName ou -Porta."
  }
  Passo "Criando o site $SiteName (porta $Porta$(if ($HostName) { ", host $HostName" }))"
  New-Website -Name $SiteName -PhysicalPath $public -Port $Porta -HostHeader $HostName -ApplicationPool $SiteName | Out-Null
}

Passo 'Dando leitura da pasta public ao pool do IIS'
icacls $public /grant "IIS AppPool\${SiteName}:(OI)(CI)RX" | Out-Null

# --- 4. Dependências e subida -------------------------------------------------------------------------------------
& (Join-Path $PSScriptRoot 'atualizar.ps1') -Servico $Servico -PortaNode $PortaNode
