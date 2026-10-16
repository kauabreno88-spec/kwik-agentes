# Análise: o prompt do Habblaud e o `habblaud.localhost`

## O que o prompt original faz

É um **prompt de instalação para agentes**: em vez de um tutorial para pessoas, ele manda o Claude Code (ou o
Codex) instalar um app inteiro na máquina, sozinho. Ele funciona por quatro escolhas:

| Escolha | Por que funciona |
| --- | --- |
| **Fatos no topo** (repositório, pasta, endereço, sistemas, agentes) | O agente sabe o resultado final antes de começar e não precisa adivinhar nada. |
| **Regras de autonomia** ("faça tudo sozinho", "peça permissão em vez de pular", "versão completa", "deu erro, leia o README") | Evita as duas falhas comuns de agentes: parar para perguntar o óbvio e pular um passo bloqueado pelo sandbox. |
| **Passo 0: descubra o sistema e os agentes** | Um prompt só serve para macOS, Linux e Windows (via WSL) e para quem usa Claude Code, Codex ou os dois. |
| **Formato fixo da resposta** (Pronto / Sua vez / Como usar / Manutenção) | O que só a pessoa pode fazer (senha, reiniciar, aprovar `/hooks` no Codex) chega separado, em passos numerados. |

## O que o Habblaud instala

1. **Servidor no Docker** (porta 4747) que lê, em modo somente leitura, as pastas `projects/` e `sessions/` do
   Claude Code e `sessions/` do Codex. Nunca a pasta inteira, porque lá ficam as credenciais.
2. **Mod/plugins no Claude Code** (via `claude plugin`), para uso do plano, aprovar permissões e mandar mensagens
   pelo escritório.
3. **Hooks no Codex** (`hooks.json`), que o Codex só roda depois de você aprovar em `/hooks`.
4. **`codex:bridge`**, um serviço no computador que entrega mensagens ao Codex (o container não alcança o Codex).
5. **portless**, para trocar `http://localhost:4747` por `https://habblaud.localhost`.

## Como funciona o `habblaud.localhost`

- Todo nome terminado em **`.localhost`** aponta para o próprio computador (127.0.0.1). Os navegadores já fazem
  isso sozinhos, sem mexer em DNS nem no `/etc/hosts`.
- O **portless** sobe um proxy HTTPS na porta 443, cria uma autoridade certificadora local (`~/.portless/ca.pem`) e
  a coloca na lista de confiança do sistema. Por isso o cadeado aparece verde.
- `portless alias habblaud 4747` registra uma rota fixa: o que chega para `habblaud.localhost` vai para
  `127.0.0.1:4747`, onde o Docker publica o container.
- O app só precisa **aceitar o cabeçalho `Host: *.localhost`**. O Habblaud (e o KWIK Agentes) recusam outros nomes
  para se proteger de DNS rebinding.

Caminho completo: navegador → `https://habblaud.localhost` (443, portless) → `127.0.0.1:4747` (Docker) → servidor.

## O que mudou na versão KWIK

| | Habblaud | KWIK Agentes |
| --- | --- | --- |
| Visual | escritório em pixel art | painel com a identidade KWIK: Montserrat + Inter, Verde KWIK, Grafite, Noite e Névoa, sobrelinhas, etiquetas retas, textura do símbolo |
| Endereço | `habblaud.localhost` → 4747 | `kwik.localhost` → **5945** (K-W-I-K no teclado do telefone) |
| Claude Code | mod + 2 plugins (uso, permissões, mensagens) | 1 plugin com hooks que só **avisam** o painel |
| Codex | hooks + `codex:bridge` sempre rodando | só hooks (sem serviço extra) |
| Proxy no boot | LaunchAgent / systemd escritos à mão | `portless service install` (com o plano B à mão) |
| Dependências | Vite, TypeScript, tsx… | nenhuma (Node puro; fontes da marca dentro do repositório) |
| Tom do prompt | direto | direto, no "a gente", sem juridiquês (Tom de voz do manual: próxima, direta, didática) |

O que ficou de fora de propósito: aprovar permissões e mandar mensagens pelo painel. Isso exige o agente esperar
uma resposta do painel (e, no Codex, um serviço extra sempre ligado). O KWIK Agentes **mostra** quem precisa de
você e o motivo; a resposta continua no terminal. Fica mais simples de instalar e não há como o painel aprovar algo
por engano.
