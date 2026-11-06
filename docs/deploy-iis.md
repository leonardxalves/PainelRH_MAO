# Deploy no servidor (IIS)

Mesmo modelo do Portal de XML: o **IIS** serve a pasta `public` (front + vídeos) e repassa `/api` ao **Node**, que roda como serviço do Windows (`PainelRH_MAO`, em `http://127.0.0.1:8000`). Acaba o "abrir o Git Bash e rodar `node server.js`".

```
TV → IIS (site PainelRH_MAO, pasta public\)
       ├─ /api/*, /health → http://127.0.0.1:8000 (serviço PainelRH_MAO: node server.js)
       ├─ /media/<arq>    → public\videos_mao\<arq>, servido pelo IIS (Range/206 nativo, com cache)
       └─ resto           → index.html, scripts.js, styles.css (sem cache)
```

## Pré-requisitos (os mesmos do Portal de XML)

1. Node.js LTS no PATH.
2. IIS com **URL Rewrite** e **ARR**.
3. NSSM em `C:\nssm\nssm.exe`.
4. Projeto **fora** de `C:\Users\...` (ex.: `C:\PainelRH_MAO`), senão o pool do IIS não lê os arquivos.
5. Os vídeos em `C:\PainelRH_MAO\public\videos_mao` (a pasta não vai pro git).

## Instalação (primeira vez)

PowerShell **como administrador**:

```
cd C:\PainelRH_MAO
powershell -ExecutionPolicy Bypass -File .\deploy\instalar.ps1 -HostName painelrh-mao.pce.br
```

| Parâmetro | Padrão | Uso |
|---|---|---|
| `-HostName` | (vazio) | Nome do site. Vazio = qualquer nome na porta (conflita com outro site na 80). |
| `-Porta` | `80` | Porta do site no IIS. Sem DNS, use outra porta, ex.: `-Porta 8081`. |
| `-PortaNode` | `8000` | Porta do Node. Se mudar, troque também no `public\web.config`. |
| `-Nssm` | `C:\nssm\nssm.exe` | Caminho do NSSM. |

Para Itu, a mesma coisa em outra pasta com `-SiteName PainelRH_ITU -Servico PainelRH_ITU -PortaNode 8001` (e o 8001 no web.config).

## Atualização

```
cd C:\PainelRH_MAO
git pull
powershell -ExecutionPolicy Bypass -File .\deploy\atualizar.ps1
```

Só vídeos/imagens? Copie para `public\videos_mao`. A TV atualiza sozinha.

## Problemas comuns

| Sintoma | Causa / solução |
|---|---|
| 502.3 em `/api` | Serviço parado: `Get-Service PainelRH_MAO`, `logs\servico.log`. |
| 404 em `/api` | Proxy do ARR desligado. Rode o `instalar.ps1` de novo. |
| 401/500.19 na página | Pool sem leitura na pasta, ou projeto dentro de `C:\Users`. |
| Vídeo novo demora a aparecer | SSE barrado: confira o `responseBufferLimit` do ARR = 0. O fallback de 30 s cobre. |

```
Get-Service PainelRH_MAO
Restart-Service PainelRH_MAO
Get-Content C:\PainelRH_MAO\logs\servico.log -Tail 50
```

Depois de migrar, o `web.config` da raiz do projeto (proxy de tudo para o 8000) não é mais usado e pode ser apagado.
