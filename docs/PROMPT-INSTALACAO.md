# Instalar o KWIK Agentes (completo, com Docker)

Instale o **KWIK Agentes** na minha máquina (**não neste projeto**) e deixe tudo rodando e ligado aos meus agentes: **Claude Code**, **Codex** ou os dois.

- **Repositório:** https://github.com/SEU-USUARIO/kwik-agentes
- **Pasta:** `~/kwik-agentes` (no Windows, dentro do WSL)
- **Endereço final:** https://kwik.localhost
- **Porta local:** `5945` (K-W-I-K no teclado do telefone)
- **Sistemas:** macOS, Linux e Windows
- **Agentes:** Claude Code e Codex (ligue os que eu usar)

## Regras

- Este prompt vale igual no **Claude Code** e no **Codex**: siga do mesmo jeito em qualquer um dos dois.
- Faça tudo sozinho, na ordem abaixo. Só me interrompa para pedir permissão.
- Se o sandbox ou as permissões bloquearem algo (rede, pastas fora deste projeto, Docker, `sudo`), peça a minha aprovação para rodar fora dele. Nunca pule um passo por isso.
- Instale sempre a versão **completa**: painel no Docker, plugin do Claude Code, hooks do Codex e o endereço https://kwik.localhost.
- Não leia nem copie credenciais (`.credentials.json`, `auth.json`, `.claude.json`). O painel só precisa das pastas de sessões.
- Deu erro? Leia o README do repositório, corrija e siga até tudo funcionar.

## 0. Descubra o sistema e os agentes

### Sistema

Detecte o sistema operacional e a arquitetura (`uname -sm`; no Windows, `$env:OS` e `[Environment]::OSVersion`) e **adapte o fluxo inteiro a ele**. Os comandos estão em bash: traduza para o shell do sistema quando precisar.

- **macOS** (Intel ou Apple Silicon): roda direto, com o Homebrew.
- **Linux** (Ubuntu, Debian, Fedora, Arch…): roda direto, com o gerenciador de pacotes da distro (`apt`, `dnf`, `pacman`…).
- **Windows 10/11**: roda pelo **WSL2**, com o KWIK Agentes **dentro do Ubuntu do WSL**.
  - Sem WSL: `wsl --install -d Ubuntu` no PowerShell como administrador. Se pedir para reiniciar, pare e me explique em "Sua vez" que basta reiniciar e colar este mesmo prompt de novo.
  - Comandos do Windows (instalar programas, certificado, tarefa no login) rodam no PowerShell; os do KWIK Agentes rodam no WSL (`wsl -d Ubuntu -- bash -lc "..."`).
- **Qualquer outra situação**: use o equivalente mais próximo e siga em frente. O resultado final é sempre o mesmo.

### Agentes

Descubra quais agentes eu uso e ligue **todos** os que existirem:

- **Claude Code:** `claude --version` ou pastas `~/.claude*` (e `CLAUDE_CONFIG_DIR`).
- **Codex** (CLI ou app): `codex --version` ou pastas `~/.codex*` (e `CODEX_HOME`).
- Só um existe? Siga só com ele: não instale o outro. Nenhum existe? Pare e me diga.
- **Windows:** se o Claude Code ou o Codex rodam nativos no Windows (`%USERPROFILE%\.claude`, `%USERPROFILE%\.codex`), aponte o painel para essas pastas pelo WSL (`/mnt/c/Users/<usuário>/.claude`) com `KWIK_CLAUDE_DIRS` e `KWIK_CODEX_DIRS` (separadas por vírgula, junto com as do WSL, se houver) e grave essas variáveis no `~/.bashrc` do WSL, para valerem no `docker:up` de hoje e nos próximos. Nesse caso o painel acompanha pelos arquivos; o plugin e os hooks só valem para os agentes que rodam dentro do WSL.

## Passo a passo

### 1. Ferramentas

- Confira `git` e **Node.js 22.12+** (`node --version`). Instale ou atualize o que faltar (no Windows, dentro do WSL).
- **Claude Code** (se eu uso): atualize para a versão mais recente, do mesmo jeito que ele foi instalado (`claude update`, npm ou Homebrew).
- **Codex** (se eu uso): atualize para a versão mais recente, do mesmo jeito que ele foi instalado (npm `@openai/codex` ou Homebrew).
- Confira o Docker (`docker info`). Se não estiver instalado e rodando:
  - **macOS:** instale o Homebrew (se faltar) e rode `brew install --cask docker`. Abra o Docker Desktop, ative "iniciar com o login" e espere ficar pronto.
  - **Linux:** instale o Docker Engine com Compose v2 pelo script oficial (`get.docker.com`), ative o serviço no boot e coloque meu usuário no grupo `docker`.
  - **Windows:** `winget install -e --id Docker.DockerDesktop`. Abra o Docker Desktop, use o backend WSL2, ligue a integração com o Ubuntu (Settings → Resources → WSL integration), ative "iniciar com o login" e espere ficar pronto. Confira `docker info` de dentro do WSL.

### 2. Baixar

- `git clone https://github.com/SEU-USUARIO/kwik-agentes.git ~/kwik-agentes`
- `cd ~/kwik-agentes && npm install`
- Se a pasta já existir, atualize: `git pull && npm install`.

### 3. Subir

- `npm run docker:up`: acha as contas do Claude Code e as pastas do Codex, monta só `projects/` e `sessions/` (somente leitura), sobe o container na porta 5945 e espera ele responder. O container reinicia sozinho junto com o Docker.

### 4. Ligar o Claude Code (se eu uso)

- `npm run claude:install`: adiciona o marketplace `kwik` (a própria pasta do projeto) e instala o plugin `kwik-agentes` em todas as minhas contas, pelo próprio `claude plugin`.
- Confira com `npm run claude:status` que ele está "instalado e ligado" em todas as contas.

### 5. Ligar o Codex (se eu uso)

- `npm run codex:install`: acrescenta os hooks da KWIK no fim do `hooks.json` de cada pasta do Codex (com backup; os outros hooks ficam).
- Confira com `npm run codex:status`.
- Não tente aprovar os hooks por mim nem mexer no `config.toml` do Codex: ele só aceita essa aprovação dentro dele, em `/hooks`. Isso fica para mim, em "Sua vez".

### 6. Endereço bonito (portless)

- `npm install -g portless` e `portless alias kwik 5945` (no Windows, dentro do WSL).
- O KWIK Agentes já aceita endereços `*.localhost`: não mude nada nele.
- `portless service install`: o proxy HTTPS (porta 443) passa a subir sozinho com o computador. Pede `sudo`/administrador.
  - Se a versão do portless não tiver `service install`, crie o equivalente rodando `portless proxy start --foreground`: um LaunchAgent no **macOS**; um serviço systemd no **Linux**.
- Se o navegador não confiar no certificado, rode `portless trust`.
- **Windows:** ative `systemd=true` em `/etc/wsl.conf` (e `wsl --shutdown` para valer), crie no Agendador de Tarefas uma tarefa que inicia o WSL no login e confie no certificado também no Windows, para o navegador aceitar: copie `~/.portless/ca.pem` do WSL e importe com `certutil -addstore -user Root ca.pem`.

### 7. Testar

- `curl -s http://localhost:5945/api/health` responde `"ok": true` e lista em `accounts` as contas do Claude Code e do Codex que eu uso.
- `npm run claude:status` e `npm run codex:status` mostram tudo ligado.
- https://kwik.localhost abre o painel (no Windows, teste no navegador do Windows). O título da página é "KWIK Agentes" e o topo mostra "Conectado".
- Os campos `hooks.claude` e `hooks.codex` do `/api/health` ganham um horário assim que uma sessão nova começar. Não precisa forçar isso agora.

## Quando terminar, me responda assim

1. **Pronto:** o endereço para abrir, o sistema detectado e os agentes ligados (Claude Code, Codex ou os dois).
2. **Sua vez** (só se for necessário): se ficou algo que só eu posso fazer, como digitar a senha do computador, reiniciar, autorizar algo nas configurações do sistema, abrir o Docker Desktop pela primeira vez ou rodar um comando no terminal, liste cada ação em passos numerados, com o comando exato para copiar. **Se ligou o Codex, inclua sempre:** feche o Codex que estiver aberto (inclusive esta conversa, se ela for no Codex), abra de novo, digite `/hooks` e aprove os hooks da KWIK. Se não ficou nada, pule esta parte.
3. **Como usar:** abrir o Claude Code ou o Codex em qualquer projeto e ver o agente aparecer no cartão do projeto (**CC** = Claude Code, **CX** = Codex); clicar num agente para ver a linha do tempo e as tarefas (tecla `T` mostra a conversa); quem precisa de você aparece em vermelho no topo (tecla `P` abre o próximo); ver o Meu dia (tecla `M`); modo demonstração com `?mock=1`; e rodar `/reload-plugins` nas sessões do Claude Code que já estavam abertas.
4. **Manutenção:** status com `npm run claude:status` e `npm run codex:status`, logs com `npm run docker:logs` e atualizar com `git pull && npm run docker:up && npm run claude:install` (no Windows, dentro do WSL).

Responda no jeito KWIK: curto e direto, frases simples, sem juridiquês e com números quando ajudarem.
