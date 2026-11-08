<h1 align="center">prisma_server</h1>

<p align="center">
  Backend do <a href="https://github.com/IgorF-cloud/prisma">Prisma</a>: API, banco, LiveKit e site num único <code>docker compose</code>.
</p>

<p align="center">
  <img alt="Node" src="https://img.shields.io/badge/Node.js-20-339933" />
  <img alt="Postgres" src="https://img.shields.io/badge/Postgres-17-4169E1" />
  <img alt="LiveKit" src="https://img.shields.io/badge/LiveKit-1.13-FF6352" />
  <img alt="Docker" src="https://img.shields.io/badge/Docker-Compose-2496ED" />
</p>

---

O `prisma_server` é tudo o que o app [Prisma](https://github.com/IgorF-cloud/prisma)
precisa do lado do servidor: contas, salas, amigos, presença, chat,
publicação de versões do app e o servidor WebRTC ([LiveKit](https://livekit.io))
que leva as lives de quem transmite para quem assiste. Também serve o site,
o painel de administração e o **Prisma Web** (assistir e transmitir pelo
navegador).

Com uma VM Linux, um domínio e Docker, você sobe a sua própria instância.

## Sumário

- [Arquitetura](#arquitetura)
- [Requisitos](#requisitos)
- [Instalação](#instalação)
- [Configuração](#configuração)
- [Conectando o app](#conectando-o-app)
- [Administração](#administração)
- [API](#api)
- [Desenvolvimento local](#desenvolvimento-local)
- [Estrutura do projeto](#estrutura-do-projeto)
- [Documentação complementar](#documentação-complementar)
- [Segurança](#segurança)
- [Licença](#licença)

## Arquitetura

```
              Internet
                 │
   ┌─────────────┼───────────────────────────────────────────────────────────────┐
   │             │                     docker compose                            │
   │   :80/:443  ▼                                                               │
   │        ┌─────────┐   /api, /ws     ┌───────────────┐      ┌────────────┐    │
   │        │  nginx  ├────────────────►│ prisma_server ├─────►│  postgres  │    │
   │        │         │                 │ (Node/Express)│      └────────────┘    │
   │        │ www/site│                 └───┬───────▲───┘                        │
   │        │ www/app │      Server API     │       │ webhook                    │
   │        │www/admin│                     ▼       │                            │
   │        └────┬────┘  :5880 ws  ┌────────────────┴┐  RPC  ┌───────┐           │
   │   certbot ──┘   ─────────────►│ livekit-server  │◄─────►│ redis │           │
   │                 :5881 tcp     │     (SFU)       │       └───▲───┘           │
   │                 :60000-60100  └────────▲────────┘           │               │
   │                 udp (mídia)            │              ┌─────┴───────────┐   │
   │                                        └──────────────┤ livekit-ingress │   │
   │                                 :5080 WHIP (app) ────►│                 │   │
   │                                 :5885 udp            └──────────────────┘   │
   └─────────────────────────────────────────────────────────────────────────────┘
```

| Serviço           | Função                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `prisma_server`   | API REST + WebSockets (salas e presença em tempo real). Não publica porta: só é alcançado pelo nginx. |
| `postgres`        | Contas, amizades, configurações, versões. As migrations rodam sozinhas no boot.                  |
| `livekit-server`  | SFU WebRTC. Os clientes conectam **direto** nele (não passa pelo nginx).                         |
| `livekit-ingress` | Recebe a transmissão do app por WHIP (GStreamer) e a publica na sala.                            |
| `redis`           | Comunicação entre o LiveKit e o Ingress.                                                         |
| `nginx`           | HTTPS, site (`www/site`), Prisma Web (`www/app`), painel (`admin.` → `www/admin`) e proxy da API. |
| `certbot`         | Emite e renova os certificados do Let's Encrypt.                                                 |

**Quem cria as salas é a API**, nunca o cliente (`auto_create: false` no
LiveKit). O fluxo de uma live:

1. O app pede ao `prisma_server` para transmitir. A API cria a sala e um
   *ingress* WHIP no LiveKit e devolve a URL.
2. O GStreamer do app publica a tela nessa URL (porta 5080).
3. Quem assiste pede um token à API (`GET /token`) e conecta no LiveKit
   (porta 5880) com o `livekit-client`.
4. O LiveKit avisa a API por webhook (`POST /webhook`) quando alguém entra,
   sai ou a sala esvazia. A API repassa às listas de salas pelos WebSockets.

## Requisitos

- Uma VM Linux com IP público (2 vCPU / 4 GB já atende um grupo de amigos).
- [Docker](https://docs.docker.com/engine/install/) com o plugin Compose v2.
- Um domínio com três registros **A** apontando para o IP da VM: `@`, `www` e `admin`.
- Portas abertas no firewall:

| Porta           | Protocolo | Para                                  |
| --------------- | --------- | ------------------------------------- |
| 80, 443         | TCP       | Site, API, painel, Let's Encrypt      |
| 5880            | TCP       | Sinalização do LiveKit (WebSocket)    |
| 5881            | TCP       | Mídia WebRTC sobre TCP (fallback)     |
| 60000–60100     | UDP       | Mídia WebRTC                          |
| 5080            | TCP       | WHIP: transmissão vinda do app        |
| 5885            | UDP       | Mídia do Ingress                      |

- Opcional: uma conta no [Resend](https://resend.com) para enviar os e-mails de recuperação de senha.

## Instalação

```bash
# 1. Código na VM (o ops/ pressupõe /opt/prisma)
sudo git clone https://github.com/IgorF-cloud/prisma_server.git /opt/prisma
cd /opt/prisma

# 2. Configuração (veja a seção Configuração)
cp .env.example .env
cp livekit.example.yaml livekit.yaml
nano .env
nano livekit.yaml
```

### 3. Primeira subida, só com HTTP

O nginx se recusa a subir se o certificado não existir, e sem nginx o
Let's Encrypt não consegue validar o domínio. Por isso a primeira subida
usa a config só-HTTP:

```bash
cd nginx/templates
mv prisma-https.conf.template prisma-https.conf.template.off
mv prisma.conf.template.off   prisma.conf.template
cd ../..

docker compose up -d --build

# a API responde? (tem que vir JSON, não HTML)
curl -s http://localhost/version/public
```

### 4. Certificado

```bash
docker compose run --rm certbot certonly \
  --webroot -w /var/www/certbot \
  -d seu-dominio.com -d www.seu-dominio.com -d admin.seu-dominio.com \
  --email voce@seu-dominio.com --agree-tos --no-eff-email
```

> Use `--dry-run` primeiro se estiver em dúvida: o Let's Encrypt limita a
> 5 emissões por semana para o mesmo conjunto de domínios.

### 5. Ligar o HTTPS

```bash
cd nginx/templates
mv prisma.conf.template            prisma.conf.template.off
mv prisma-https.conf.template.off  prisma-https.conf.template
cd ../..
docker compose restart nginx
```

A renovação é automática: o `certbot` confere a cada 12 h e o `nginx`
recarrega a cada 24 h.

### 6. Primeiro administrador

Crie uma conta pelo app ou pelo Prisma Web (`https://seu-dominio.com/app`)
e promova essa conta a admin direto no banco. Isso só é preciso uma vez:
os próximos admins podem ser promovidos pelo painel.

```bash
docker compose exec postgres psql -U prisma -d prisma \
  -c "UPDATE users SET is_admin = true WHERE username = 'SEU_USUARIO';"
```

O painel fica em `https://admin.seu-dominio.com`.

### 7. (Opcional) Deploy pelo painel

A aba **Docker** do painel roda `docker compose up -d --build` na VM por
meio de uma unit do systemd, sem expor o socket do Docker ao container.
Para instalar, siga [`ops/README.md`](ops/README.md).

## Configuração

São dois arquivos, ambos **fora do git**, criados a partir dos modelos:

### `.env` (modelo: [`.env.example`](.env.example))

| Variável                          | Descrição                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `HOST`                            | IP público da VM (anunciado pelo Ingress)                                      |
| `PORT`                            | Porta interna da API (padrão `5000`, precisa bater com o webhook do `livekit.yaml`) |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | Credenciais do LiveKit, **iguais** às do bloco `keys:` do `livekit.yaml` |
| `LIVEKIT_SERVER_URL`              | `http://livekit-server:5880` (rede interna do Compose)                         |
| `PGHOST` … `PGPASSWORD`           | Banco. O serviço `postgres` é criado com esses valores                         |
| `JWT_SECRET` / `JWT_EXPIRES_IN`   | Assinatura e validade dos tokens de login                                      |
| `DOMAIN`                          | Domínio principal (o nginx atende `DOMAIN`, `www.` e `admin.`)                 |
| `LETSENCRYPT_EMAIL`               | E-mail de avisos do Let's Encrypt                                              |
| `RESEND_API_KEY` / `MAIL_FROM`    | Envio de e-mail. **Sem a chave, os códigos de recuperação vão para o log**     |

Para gerar segredos:

```bash
openssl rand -base64 48 | tr -d '/+='
```

### `livekit.yaml` (modelo: [`livekit.example.yaml`](livekit.example.yaml))

O binário do LiveKit lê esse arquivo direto e **não** expande `${VARS}`,
então três valores são copiados à mão:

- o nome e o segredo da chave em `keys:` (= `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`);
- o mesmo nome de chave em `webhook.api_key`;
- o IP público em `ingress.whip_base_url` (= `HOST`).

## Conectando o app

O app tem os endereços de produção compilados em `src/main/config.ts`.
Para a sua instância:

```ts
const PRODUCTION_API_BASE_URL = 'https://seu-dominio.com'
const PRODUCTION_LIVEKIT_WS_URL = 'ws://seu-dominio.com:5880'
```

Ou, sem recompilar, um `config.json` ao lado do `Prisma.exe`. Detalhes no
[README do app](https://github.com/IgorF-cloud/prisma#apontando-para-o-seu-servidor).

### Sobre a pasta `www/`

`www/` traz as builds **já compiladas** de três front-ends que vivem em
repositórios separados:

| Pasta        | O que é                                   | Servido em               |
| ------------ | ----------------------------------------- | ------------------------ |
| `www/site`   | Landing page                              | `https://DOMAIN/`        |
| `www/app`    | Prisma Web (assistir/transmitir no navegador) | `https://DOMAIN/app`  |
| `www/admin`  | Painel de administração                   | `https://admin.DOMAIN/`  |

O Prisma Web e o painel usam caminhos relativos e funcionam em qualquer
domínio. A landing page tem textos e links do Prisma oficial: troque a
pasta pelo seu próprio site, se quiser.

## Administração

Pelo painel (`admin.DOMAIN`), um administrador pode:

- **Usuários**: listar, suspender/reativar, promover a admin, apagar contas e definir o teto de contas ativas.
- **Versões**: enviar o `Prisma-Setup.exe`, publicar como versão atual (o app se atualiza sozinho), voltar para a anterior e definir a versão mínima obrigatória.
- **Docker**: rodar o build do compose e acompanhar o log (requer o [`ops/`](ops/README.md)).

## API

Todas as rotas abaixo, exceto as públicas, exigem `Authorization: Bearer <jwt>`.
O token vem do `/login` ou do `/register`.

| Área         | Rotas principais                                                                             |
| ------------ | -------------------------------------------------------------------------------------------- |
| Contas       | `POST /register`, `POST /login`, `GET /me`, `PUT /users/:id`, `PUT /users/:id/password`      |
| Senha        | `POST /password-reset/request`, `POST /password-reset/confirm`                               |
| Usuários     | `GET /users`, `PUT /users/:id/presence`, `POST/DELETE /users/:id/pin`                        |
| Amigos       | `GET /friends`, `POST /friends/:id/request`, `POST /friends/:id/accept`, `DELETE /friends/:id` |
| Salas        | `GET /rooms`, `GET /token`, `DELETE /rooms/:room`, `POST /rooms/:room/invite`, `/kick`, `/leave` |
| Transmissão  | `POST /ingress`, `DELETE /ingress/:room`, `POST/DELETE /rooms/:room/publish`, `POST /rooms/:room/game` |
| Chat         | `GET/POST /rooms/:room/chat`, `POST /rooms/:room/chat/mute`                                  |
| Versões      | `GET /version`, `GET /version/public`, `GET /version/android/public`                         |
| Admin        | `/admin/users`, `/admin/settings/max-users`, `/admin/version/*`, `/admin/docker/deploy`      |
| Infra        | `GET /ping`, `POST /webhook` (LiveKit, validado pela assinatura)                             |

A lista de salas e a presença chegam em tempo real por WebSocket (`/ws/rooms`).

## Desenvolvimento local

```bash
npm install

# Postgres, Redis e LiveKit pelo compose (sem o nginx)
docker compose up -d postgres redis livekit-server livekit-ingress

# Em dev, a API roda fora do Docker: no .env, aponte PGHOST e
# LIVEKIT_SERVER_URL para localhost e publique as portas que precisar.
npm start
```

Os front-ends (`www/`) são desenvolvidos nos seus próprios repositórios e
só a build entra aqui.

## Estrutura do projeto

```
prisma_server/
├── server.js              API: rotas, WebSockets, integração com o LiveKit
├── admin.js               rotas do painel de administração
├── friends.js, chat.js    amizades e chat das salas
├── presence.js            presença (online / ao vivo)
├── mail.js                envio de e-mail (Resend, ou log em modo teste)
├── pe.js                  leitura de metadados do instalador .exe enviado
├── androidRelease.js      versão do APK Android (downloads/android.json)
├── auth/                  JWT, hash de senha, rate limit
├── db/                    acesso ao Postgres + migrations/ (rodam no boot)
├── nginx/                 templates e snippets do nginx
├── ops/                   deploy pelo painel (script + units do systemd)
├── www/                   builds do site, Prisma Web e painel
├── docker-compose.yml
├── Dockerfile
├── livekit.example.yaml   modelo da config do LiveKit
└── .env.example           modelo das variáveis de ambiente
```

Pastas criadas em tempo de execução (fora do git): `data/` (avatares) e
`downloads/` (instaladores e APK).

## Documentação complementar

- [`DEPLOY-SITE.md`](DEPLOY-SITE.md): HTTPS, DNS, e-mail com Resend (SPF/DKIM/DMARC), APK Android e problemas comuns.
- [`ADMIN-PANEL.md`](ADMIN-PANEL.md): painel de administração em detalhe.
- [`ops/README.md`](ops/README.md): deploy pelo painel via systemd.

## Segurança

- Nunca versione o `.env` nem o `livekit.yaml`. Os dois já estão no `.gitignore`.
- Use segredos longos e aleatórios para `JWT_SECRET`, `LIVEKIT_API_SECRET` e `PGPASSWORD`.
- Em produção, configure o `RESEND_API_KEY`. Sem ele, os códigos de recuperação de senha aparecem no log, e quem lê o log consegue trocar a senha de qualquer conta.
- O Postgres e a API não publicam porta no host. Mantenha assim: a API confia no `X-Forwarded-For` do nginx (`trust proxy`) para o rate limit.

## Licença

Distribuído sob a licença [MIT](LICENSE): você pode usar, modificar e redistribuir, inclusive comercialmente, desde que mantenha o aviso de copyright.
