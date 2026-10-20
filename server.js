const envFile = process.env.NODE_ENV === "test" ? ".env.teste" : ".env";
require("dotenv").config({ path: envFile });

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const { WebSocketServer } = require("ws");
const {
  AccessToken,
  RoomServiceClient,
  IngressClient,
  IngressInput,
  WebhookReceiver,
} = require("livekit-server-sdk");

// Banco (2026-09-10) — substitui o data/userList.json e o version.json.
// Nenhuma SQL mora neste arquivo: as rotas chamam db/users.js e
// db/appVersion.js.
const db = require("./db");
const usersDb = require("./db/users");
const appVersionDb = require("./db/appVersion");
const settingsDb = require("./db/settings");
// A versão do APK Android NÃO vive no banco — ver o cabeçalho do
// androidRelease.js pro porquê.
const androidRelease = require("./androidRelease");
const resetsDb = require("./db/passwordResets");
const {
  sign: signToken,
  requireAuth,
  requireAdmin,
  requireSelf,
  invalidateTokenVersion,
} = require("./auth/jwt");
const rateLimit = require("./auth/rateLimit");
const mail = require("./mail");
const presence = require("./presence");
const { setupAdminRoutes } = require("./admin");
const { setupChatRoutes } = require("./chat");

// Situação da conta -> o que dizer pra pessoa no login (2026-09-16).
//
// Sobrou UMA (2026-09-18): `blocked`. As situações `pending` e `rejected`
// saíram junto com a aprovação manual — o controle de quem usa o app
// passou a ser o TETO DE CONTAS, conferido no cadastro. Quem cabe entra
// ativo; quem não cabe não vira conta. Não existe mais estado de espera.
//
// Continua um MAPA, e não um `if`, porque é o que faz uma situação nova
// um dia entrar só aqui — o login e o WebSocket já consultam por chave.
const STATUS_LOGIN_ERROR = {
  blocked: "Esta conta está bloqueada.",
};

const app = express();

// O nginx passou a ser a única porta de entrada (2026-09-10) — o
// prisma_server não publica mais a 5000 no host, ver docker-compose.yml.
// Sem esta linha, `req.ip` seria o IP do CONTAINER do nginx pra todo
// mundo, e o rate limiting por IP (auth/rateLimit.js) trancaria todos os
// usuários juntos no primeiro excesso de qualquer um — sem nada anormal
// no log.
//
// `1` e não `true`: `true` manda o Express confiar na cadeia INTEIRA do
// X-Forwarded-For, que é um header que o cliente escreve — qualquer um
// forjaria o próprio IP e ganharia um balde de rate limit novo por
// requisição. `1` confia em exatamente um salto, o nginx, que sobrescreve
// o header.
//
// ⚠️ Isso só é seguro porque NINGUÉM alcança a 5000 direto. Se um dia a
// porta voltar a ser publicada, esta linha vira o próprio buraco que ela
// existe pra fechar: bastaria bater em http://IP:5000 com um
// X-Forwarded-For inventado.
app.set("trust proxy", 1);

// CORS aberto continua valendo (2026-09-10): o Electron chama tudo do
// MAIN process, onde não existe Origin, e a landing page é servida pelo
// nginx na mesma origem da API. Vale apertar junto do painel web (item
// 4), quando houver um front de verdade num navegador.
app.use(cors());
// O webhook do LiveKit manda Content-Type: application/webhook+json (não
// application/json), e precisa do corpo cru (não já convertido em objeto)
// pra validar a assinatura — guarda ele em req.rawBody sem mudar o resto.
app.use(
  express.json({
    type: ["application/json", "application/webhook+json"],
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);

// O TOKEN_API_SECRET compartilhado saiu em 2026-09-10 (item 3 do
// ROADMAP): era o mesmo pra todo mundo e vinha em texto puro no
// installer/config.json de cada máquina. Agora cada usuário tem o
// próprio JWT, emitido no login (ver auth/jwt.js).

// Credenciais do LiveKit Server — em --dev sem --keys (ver start-livekit.bat
// em D:\MY PROJECTS\livekit), o próprio livekit-server usa devkey/secret
// fixos, então .env.teste aponta pra essas mesmas duas.
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

// URL HTTP (não ws) do LiveKit Server, usada só aqui no backend pra falar
// com a Server API (derrubar sala) — nunca exposta pro cliente Electron.
const LIVEKIT_SERVER_URL = process.env.LIVEKIT_SERVER_URL;

// Validade do token de sala (2026-09-29). O padrão do SDK são 6 HORAS, e
// esse prazo não é só "quando o token para de valer": o `livekit-client`
// reusa o MESMO token quando reconecta, então enquanto ele vale a pessoa
// volta pra sala — inclusive muito depois de a live ter acabado, que é o
// que alimentava as salas fantasma.
//
// Com o `auto_create: false` do livekit.yaml esse caminho já está
// fechado (token velho não fabrica mais sala nenhuma), então isto aqui é
// a SEGUNDA camada, não a primeira — e por isso o número pode ser
// escolhido pensando em quem usa, não em quem ataca.
//
// 4 horas cobre com folga uma sessão longa de jogo, e é o prazo em que
// uma reconexão DE VERDADE (queda de internet no meio da live) ainda
// funciona sem a pessoa precisar entrar na sala de novo. Passando disso,
// reconectar falha e o app cai no fluxo normal de "entrar na sala", que
// pede um token novo.
const LIVEKIT_TOKEN_TTL = "4h";
const roomService = new RoomServiceClient(LIVEKIT_SERVER_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
const webhookReceiver = new WebhookReceiver(LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
// Item GStreamer (2026-08-30): cria/derruba um endpoint WHIP por sala, pro
// GStreamer publicar com encode de hardware em vez do getDisplayMedia do
// Chromium (limitado a ~45fps na prática, ver MEMORIA.md do Electron).
const ingressClient = new IngressClient(LIVEKIT_SERVER_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
// A API de deletar Ingress exige o ingressId, não o nome da sala — guarda
// a relação aqui (em memória, mesmo padrão do roomsState acima; se o
// prisma_server reiniciar no meio de uma transmissão via GStreamer, o
// DELETE /ingress/:roomName correspondente vira no-op, mas isso é raro o
// bastante pra não valer a complexidade de persistir).
const ingressIdByRoom = new Map();

// Item novo (2026-09-04, "sala com senha"): o Electron manda a senha (se
// o host escolheu uma) junto do POST /ingress, mas a sala em si só passa
// a existir de verdade pro LiveKit (e pro roomsState) quando o
// webhook "room_started" chega (ver comentário no /ingress abaixo sobre
// esse intervalo) — essa senha fica guardada aqui até lá, consumida (e
// removida) assim que "room_started" a transfere pro roomsState. Mesma
// limitação já aceita pelo ingressIdByRoom acima: se o prisma_server
// reiniciar nesse meio-tempo, a senha pendente se perde (raro o
// bastante pra não valer a complexidade de persistir em disco).
// roomName -> true, enquanto a sala ainda não existe de fato no LiveKit.
// Substituiu o `pendingRoomPasswords` em 2026-09-10: a senha de sala saiu
// e no lugar entrou o checkbox "Transmissão privada" da tela de iniciar
// live. Mesma mecânica de antes — o host declara isso no /ingress, mas a
// sala só nasce quando o LiveKit avisa `room_started`, então o valor
// espera aqui no meio do caminho.
const pendingRoomPrivate = new Map();

// O MESMO meio-do-caminho, pro jogo/janela (2026-09-30).
//
// Existe porque a sala agora só aparece pra alguém quando fica pronta
// (ver markRoomReady), e seria um desperdício estranho ela ficar pronta
// sem o que está sendo transmitido — a informação estava ali desde o
// clique em "iniciar", só chegava por outro caminho, alguns instantes
// depois. O app manda no próprio /ingress o que já sabe da fonte
// escolhida, e isto espera aqui até o `room_started` transferir pro
// roomsState, exatamente como o `private` acima.
//
// Só o modo JANELA depende disto de verdade: ali a detecção é sobre a
// janela escolhida e já responde certo de primeira. Transmitindo um
// MONITOR, o que vai daqui é só o nome da tela ("Screen 1") — o jogo em
// si depende de varrer os processos da máquina, demora, e chega pelo
// POST /rooms/:roomName/game de sempre, trocando o nome da tela pelo do
// jogo no tile de quem assiste (decisão do usuário, 2026-09-30).
const pendingRoomGame = new Map();

// Item 15 do roadmap do Electron (2026-08-30): participante "hidden"
// (preview do próprio host, identity com sufixo "-preview") nunca deve
// contar como alguém assistindo — nem na lista inicial (abaixo, via API
// admin `listParticipants`, que devolve os hidden também — visibilidade
// admin é diferente de visibilidade pra outros clientes) nem nos updates
// via webhook (não confirmado se `permission.hidden` sempre vem
// preenchido no payload do webhook, por isso o sufixo de identity como
// defesa extra).
function isHiddenPreviewParticipant(identity, permission) {
  return Boolean(permission?.hidden) || Boolean(identity?.endsWith("-preview"));
}

// Roadmap item 42 (Electron): timer de duração da live — usa a hora de
// criação que o PRÓPRIO LiveKit grava no objeto Room (`creation_time_ms`,
// confirmado no proto `@livekit/protocol`), não `Date.now()` capturado
// aqui na hora do webhook. Duas vantagens sobre capturar localmente: (1)
// não depende do relógio de nenhuma máquina cliente (host podia estar com
// o relógio errado), e (2) sobrevive a um restart do prisma_server — o
// bloco de "estado inicial" abaixo (`listRooms()`) recupera a hora de
// início REAL de cada sala já em andamento, não uma hora "agora" errada.
// `creationTimeMs`/`creationTime` chegam como BigInt (campos int64 do
// protobuf) — precisa de Number() antes de ir pro JSON (BigInt não
// serializa direto). Fallback pra Date.now() só como último recurso
// (LiveKit sem esse campo por algum motivo), nunca deveria acontecer na
// prática.
function extractStartedAt(room) {
  const ms = room?.creationTimeMs ? Number(room.creationTimeMs) : 0;
  if (ms > 0) return ms;
  const seconds = room?.creationTime ? Number(room.creationTime) : 0;
  if (seconds > 0) return seconds * 1000;
  return Date.now();
}

// --- Lista de salas em tempo real (item 18 do roadmap do Electron) ---------
// Estado das salas mantido em memória, atualizado pelos webhooks do LiveKit
// (ver POST /webhook) em vez de perguntar pro LiveKit toda vez — é o que
// permite avisar o Electron na hora via WebSocket, sem polling.
//
// participants (lista de identities) substitui o truque do app antigo de o
// host entrar como um segundo participante "hidden" só pra saber quem tá na
// própria sala — os eventos participant_joined/participant_left já trazem a
// identidade de quem entrou/saiu, então o host consegue ver os participantes
// da própria sala filtrando essa mesma lista pelo nome da sala dele, sem
// precisar de conexão nenhuma a mais.
//
// De propósito SEM numParticipants aqui: o campo `event.room.numParticipants`
// que o LiveKit manda no webhook não fica sempre em sincronia com o
// participante específico do evento (marcado na prática: contador ficava
// zerado ao entrar um viewer, só "alcançava" depois que outro evento
// disparava) — contar o tamanho de `participants` (que é todo mantido por
// nós, a partir da identity de cada evento) é sempre consistente com o que
// a gente já sabe, sem depender desse campo do LiveKit.
const roomsState = new Map(); // roomName -> { name, hostName, participants, game, startedAt, private }
const roomsWsClients = new Set();

// --- Dados INTERNOS da sala (2026-09-29) ------------------------------
//
// Moram fora do `roomsState` de propósito: o `toPublicRoom` logo abaixo é
// um spread (`{ ...room }`), então todo campo que entrar lá vira campo no
// broadcast de salas. Nada aqui é segredo, mas nada aqui é assunto do
// app — e um campo interno que vaza pro protocolo é um campo do qual
// alguém passa a depender.
//
//   sid           — o id que o LiveKit dá a UMA encarnação da sala.
//                   Distingue "a sala 123 de agora" da "sala 123 de um
//                   minuto atrás"; sem ele um webhook atrasado apaga o
//                   estado da sala errada (ver `room_finished`).
//   ownerUserId   — quem pediu o /ingress, ou seja o DONO da live. Existe
//   ownerUsername   separado do `hostName` porque o hostName zera toda vez
//                   que o publisher sai (troca de fonte), e sem um dono
//                   estável não dá pra checar permissão no DELETE sem
//                   quebrar o "parar a própria transmissão".
//   ready         — a live está NO AR, e não só pedida (2026-09-30). É o
//                   que decide se a sala sai em broadcast; ver
//                   markRoomReady abaixo.
//   startedAtKept — esta sala é uma live que JÁ estava correndo e foi
//                   recriada (2026-09-30). O cronômetro dela não
//                   recomeça; ver beginRoomIncarnation.
//   publishing    — tem um publisher (o Ingress do host) na sala AGORA
//                   (2026-10-16). Era o `hostName !== null` que dizia
//                   isso; desde que a sala nasce com o dono como host
//                   (ver `room_started`), o `hostName` diz QUEM é o host,
//                   e é isto que diz se ele está transmitindo.
const roomInternals = new Map();
// roomName -> { sid, ownerUserId, ownerUsername, ready, startedAtKept, publishing }

function setRoomPublishing(roomName, publishing) {
  const prev = roomInternals.get(roomName) ?? {};
  roomInternals.set(roomName, { ...prev, publishing });
}

function isRoomPublishing(roomName) {
  return roomInternals.get(roomName)?.publishing === true;
}

function roomOwnerUsername(roomName) {
  return roomInternals.get(roomName)?.ownerUsername ?? null;
}

// ENCARNAÇÕES QUE JÁ ACABARAM (2026-10-16, "start instantâneo").
//
// O LiveKit não garante a ordem dos webhooks. Um `room_started` que
// chegue DEPOIS do `room_finished` da mesma sala — uma live encerrada
// logo depois de nascer, que é exatamente o caso de "iniciar e parar na
// hora" — recriaria o estado de uma sala que não existe mais. Até esta
// data isso ficava invisível (a sala só aparecia com publisher); agora
// ela apareceria na lista de todo mundo, como uma live sem vídeo.
//
// O `sid` identifica a encarnação, então um `room_started` de um sid que
// já terminou é evento velho. Dez minutos é muito mais que qualquer
// atraso de webhook, e o Map se poda sozinho a cada inserção.
const FINISHED_SID_TTL_MS = 10 * 60 * 1000;
const finishedRoomSids = new Map(); // sid -> instante em que deixa de valer

function rememberFinishedSid(sid) {
  if (!sid) return;
  const now = Date.now();
  for (const [known, expiresAt] of finishedRoomSids) {
    if (expiresAt <= now) finishedRoomSids.delete(known);
  }
  finishedRoomSids.set(sid, now + FINISHED_SID_TTL_MS);
}

function isFinishedSid(sid) {
  const expiresAt = sid ? finishedRoomSids.get(sid) : undefined;
  return expiresAt !== undefined && expiresAt > Date.now();
}

function setRoomSid(roomName, sid) {
  if (!sid) return;
  const prev = roomInternals.get(roomName) ?? {};
  roomInternals.set(roomName, { ...prev, sid });
}

// --- A SALA ESTÁ PRONTA PRA APARECER PRA ALGUÉM? (2026-09-30) ---------
//
// BUG RELATADO: uma sala entrava na lista SEM avatar e SEM nome ("Live de
// ???") e só 2-3 segundos depois ganhava os dois.
//
// A causa é a mudança de 2026-09-29 (ver "QUEM CRIA SALA É ESTE SERVIDOR"
// mais abaixo). Antes a sala nascia quando o GStreamer começava a
// publicar de verdade, então o `room_started` e o `participant_joined` do
// publisher chegavam com MILISSEGUNDOS de diferença e ninguém via o
// intervalo. Agora quem cria a sala é o `ensureRoom` do POST /ingress, e
// entre os dois cabem a escolha da fonte, o spawn do gst-launch e a
// negociação WHIP. O `room_started` mandava pra todo mundo uma sala com
// `hostName: null` e `game: null` — uma live que ainda não existe.
//
// `ready` separa "a sala foi PEDIDA" de "a live está NO AR". Quem marca é
// o primeiro publisher entrando, ou seja este servidor sabendo pelo
// LiveKit — e não o app afirmando que terminou de iniciar, que é uma
// promessa que ele não tem como cumprir (ele sabe que lançou o processo,
// não que o primeiro frame chegou).
//
// Enquanto for falso a sala existe aqui INTEIRA — convite, dono,
// demolição por falta de host, tudo continua funcionando em cima dela.
// Ela só não sai em broadcast nenhum (ver roomsVisibleTo/broadcastRooms).
//
// NUNCA volta a ser falso. Numa troca de fonte o publisher sai e o
// `hostName` zera por alguns segundos — despublicar a sala ali a faria
// PISCAR pra fora da lista de quem está assistindo, sintoma pior que o
// consertado aqui.
//
// Devolve `true` só na PRIMEIRA vez: é esse instante que vale como início
// da live (ver o `startedAt` no participant_joined).
//
// ⚠️ DESDE 2026-10-16 QUEM MARCA, NA LIVE NORMAL, É O `room_started`, e
// não mais o primeiro publisher: a sala já nasce com o dono como host
// (gravado no /ingress) e com o que está sendo transmitido, então não há
// mais "Live de ???" a esconder. O publisher só marca aqui a sala que
// nasceu SEM dono conhecido — que é justamente a que ainda precisa ficar
// escondida até provar que é uma live.
function markRoomReady(roomName) {
  const prev = roomInternals.get(roomName) ?? {};
  if (prev.ready) return false;
  roomInternals.set(roomName, { ...prev, ready: true });
  return true;
}

function isRoomReady(roomName) {
  return roomInternals.get(roomName)?.ready === true;
}

// COMEÇA UMA ENCARNAÇÃO NOVA DESTA SALA (2026-09-30).
//
// Zera o que vale por ENCARNAÇÃO, e não por código de sala. O código tem
// 6 dígitos e é reaproveitado: se o `room_finished` da anterior se
// perdeu, o que sobrou dela no `roomInternals` não vale pra esta — um
// `ready` herdado, por exemplo, publicaria a sala nova antes da hora,
// que é justamente o bug que o `ready` existe pra consertar. Mesmo
// cuidado que o `sid` já toma.
//
//   ready          sempre falso: a sala acabou de nascer e ninguém
//                  publicou nela ainda.
//   startedAtKept  verdadeiro só quando o metadata devolveu o início de
//                  uma live que JÁ estava correndo — ou seja, quando
//                  esta sala é uma RECRIAÇÃO no meio de uma troca de
//                  fonte, e não uma live nova. Aí o cronômetro dela não
//                  pode recomeçar quando o publisher entrar.
function beginRoomIncarnation(roomName, { startedAtKept }) {
  const prev = roomInternals.get(roomName) ?? {};
  roomInternals.set(roomName, { ...prev, ready: false, startedAtKept, publishing: false });
}

function keepsRoomStartedAt(roomName) {
  return roomInternals.get(roomName)?.startedAtKept === true;
}

// Chamado no /ingress, que é o único ponto do fluxo que sabe QUEM é o
// host de verdade (`req.userId`, autenticado).
function setRoomOwner(roomName, userId, username) {
  const prev = roomInternals.get(roomName) ?? {};
  roomInternals.set(roomName, {
    ...prev,
    ownerUserId: userId ?? null,
    ownerUsername: username ?? null,
  });
}

// Preenche o dono a partir de quem está publicando, e SÓ quando ainda
// não se sabe de ninguém. Cobre a sala que já estava no ar antes deste
// processo subir: o /ingress dela rodou noutra execução, então o userId
// se perdeu — mas a identity do publisher continua sendo o username do
// host. Nunca sobrescreve o que o /ingress gravou.
function rememberRoomPublisher(roomName, username) {
  if (!username) return;
  const prev = roomInternals.get(roomName) ?? {};
  if (prev.ownerUserId != null || prev.ownerUsername) return;
  roomInternals.set(roomName, { ...prev, ownerUserId: null, ownerUsername: username });
}

// "Essa pessoa é dona desta sala?" — `true`, `false`, ou `null` quando
// não dá pra saber (dono nunca gravado: sala nascida antes deste
// processo subir e sem publisher desde então, ou sala fantasma sem
// /ingress nenhum).
//
// `null` NÃO bloqueia (ver as rotas DELETE). Recusar no desconhecido
// trocaria um problema raro — alguém derrubando a live alheia — por um
// pior e mais comum: o host não conseguir parar a PRÓPRIA transmissão
// depois de um restart do servidor, sem nenhuma saída pela interface.
function roomOwnerCheck(roomName, req) {
  const internals = roomInternals.get(roomName);
  if (!internals) return null;
  const { ownerUserId, ownerUsername } = internals;
  if (ownerUserId == null && !ownerUsername) return null;
  if (ownerUserId != null && ownerUserId === req.userId) return true;
  if (ownerUsername && ownerUsername === req.username) return true;
  return false;
}

// Item novo (2026-09-04, "sala com senha"): NUNCA manda a senha em si pro
// cliente (nem pro host, nem pro viewer) — só se a sala TEM uma
// (`hasPassword`), o suficiente pra desenhar o cadeado no tile e pedir a
// senha antes de entrar. A conferência de verdade (senha certa ou não)
// acontece só no servidor, em /token.
// `private` sai inteiro, sem mascarar: ao contrário da senha antiga, ele
// não é segredo nenhum — é só "esta sala não aparece na lista pra quem
// não foi convidado". Quem NÃO pode ver a sala nem recebe o objeto (o
// filtro é no broadcast, abaixo).
// TUDO QUE PRECISA SOBREVIVER A UM RESTART DESTE PROCESSO VAI PRO
// METADATA DA SALA NO LIVEKIT.
//
// Começou com o `private` (2026-09-04) e ganhou o `game` em 2026-09-21,
// depois de um restart do servidor no meio de lives reais: as lives não
// caíram (o LiveKit é outro container), mas os tiles de quem assistia
// perderam o "Jogando: X" pra sempre. O boot reconstruía as salas com
// `game: null`, e o host nunca reenviava — o report do app é
// deduplicado por valor (ver gameDetection.ts), e o valor não mudou.
//
// Por que aqui e não numa tabela: o metadata tem exatamente o tempo de
// vida da sala, então morre sozinho quando a live acaba. Numa tabela
// sobrariam linhas órfãs toda vez que o servidor caísse sem processar o
// room_finished.
//
// ⚠️ `updateRoomMetadata` SOBRESCREVE O METADATA INTEIRO. Por isso existe
// UMA função que escreve, e ela monta o objeto inteiro a partir do
// `roomsState`. Duas funções escrevendo campos diferentes é o jeito
// garantido de o jogo apagar a privacidade da sala (ou vice-versa) — e o
// sintoma só apareceria no próximo restart.
const GAME_KINDS = ["game", "window", "screen"];

// O `iconUrl` de uma JANELA é o ícone do programa embutido como data URL
// (uns 3-6KB, ver windowIcon.ts no app) — cabe. Mas a rota aceita até
// 64KB, e metadata de sala não é lugar pra isso: o LiveKit tem limite
// próprio e uma escrita recusada levaria junto o `private`. Acima deste
// teto o nome sobrevive ao restart e o ícone não, que é a troca certa.
const METADATA_ICON_MAX_BYTES = 8 * 1024;

// Teto de tamanho do que o app pode reportar (2026-09-14). Este campo
// deixou de ser sempre um link curto do CDN do Discord: quando a
// transmissão é de uma JANELA, o app manda o ícone do programa embutido
// como data URL (uns 3-6KB).
//
// O que torna o teto necessário é pra onde este valor vai: ele fica no
// roomsState e é reenviado a TODO MUNDO em cada broadcast de salas. Sem
// limite, um cliente modificado poderia pendurar megabytes em cada
// pacote de todos os usuários. 64KB é folgado pro uso real e barato o
// suficiente pra não pesar no broadcast.
const GAME_ICON_MAX_BYTES = 64 * 1024;

// Valida o jogo/janela que o app reportou e devolve `{ game }` (que pode
// ser `null` — "nada sendo transmitido") ou `{ status, error }`.
//
// UMA função porque são DOIS pontos de entrada desde 2026-09-30: o
// POST /rooms/:roomName/game de sempre e o POST /ingress, que passou a
// aceitar a mesma informação já na criação da sala. Duas validações
// separadas pro mesmo campo é como uma delas fica pra trás — e a que
// ficasse pra trás seria a porta aberta.
//
// Sobre o `kind`: "screen" entrou como valor próprio a pedido do usuário
// (2026-09-05) — antes um monitor inteiro sem jogo detectado era
// reportado como "window" (o rótulo exibido é o mesmo, "Transmitindo:"),
// mas o app precisa distinguir os dois pra escolher o ícone do
// placeholder (monitor x janela, ver HomeScreen.tsx). A lista mora junto
// do metadata (GAME_KINDS, logo acima) desde 2026-09-21: quem lê o jogo
// de volta depois de um restart precisa validar contra exatamente os
// mesmos valores aceitos aqui.
function parseGameReport(input) {
  const { kind, name, iconUrl } = input ?? {};

  if (kind != null && !GAME_KINDS.includes(kind)) {
    return { status: 400, error: `kind deve ser um de ${GAME_KINDS.join("/")} ou null` };
  }
  if (name != null && typeof name !== "string") {
    return { status: 400, error: "name deve ser string ou null" };
  }
  if (iconUrl != null && typeof iconUrl !== "string") {
    return { status: 400, error: "iconUrl deve ser string ou null" };
  }
  if (typeof iconUrl === "string" && iconUrl.length > GAME_ICON_MAX_BYTES) {
    return { status: 413, error: "iconUrl grande demais" };
  }

  return { game: name ? { kind, name, iconUrl: iconUrl ?? null } : null };
}

// Dois reports são o MESMO report? Usado só pra decidir se vale um
// broadcast (2026-09-30): o app reafirma o valor atual de tempos em
// tempos mesmo sem mudança (ver REASSERT_INTERVAL_MS no gameDetection.ts
// dele), e antes disto cada reafirmação virava um pacote de salas pra
// todos os usuários conectados. Mesma comparação por valor que o app faz
// do lado dele.
function sameGameReport(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.name === b.name && (a.iconUrl ?? null) === (b.iconUrl ?? null);
}

// Best-effort: se falhar, a live continua funcionando e o estado desta
// execução (o `roomsState` em memória, que é o que vale no dia a dia)
// não muda — só não sobreviveria a um restart.
// TUDO O QUE A SALA É, num objeto só. Separado da escrita desde
// 2026-09-30 porque existem DOIS jeitos de gravar isto no LiveKit: o
// `updateRoomMetadata` de uma sala que já existe (logo abaixo) e o
// `createRoom` de uma sala que está sendo recriada no meio da live (ver
// POST /rooms/:roomName/reconnecting). Montar o objeto em dois lugares
// era como a sala recriada voltava sem saber que era privada.
function roomMetadataPayload(room) {
  const payload = {};
  if (!room) return payload;

  if (room.private) payload.private = true;
  if (room.game?.name) {
    const iconUrl = room.game.iconUrl ?? null;
    payload.game = {
      kind: room.game.kind,
      name: room.game.name,
      iconUrl: iconUrl && iconUrl.length <= METADATA_ICON_MAX_BYTES ? iconUrl : null,
    };
  }
  // Desde 2026-09-30 o `startedAt` é o instante do PRIMEIRO PUBLISHER, e
  // não mais a criação da sala (ver markRoomReady). Isso é um número que
  // só existe na memória deste processo, então precisa vir pra cá — senão
  // um restart no meio da live jogaria o timer de volta pro
  // `creationTimeMs`, que desde 2026-09-29 é o clique em "iniciar", 2-3s
  // antes do primeiro frame.
  if (room.startedAt) payload.startedAt = room.startedAt;

  return payload;
}

async function syncRoomMetadata(roomName) {
  const room = roomsState.get(roomName);
  if (!room) return;

  try {
    await roomService.updateRoomMetadata(roomName, JSON.stringify(roomMetadataPayload(room)));
  } catch (err) {
    console.error(`[rooms] não consegui gravar o metadata de ${roomName} no LiveKit:`, err);
  }
}

// Metadata é texto livre: pode vir vazio, de uma versão anterior deste
// servidor ou corrompido. Qualquer coisa que não seja um objeto JSON
// vira `{}`, e cada leitor abaixo decide o que fazer com a ausência.
function parseRoomMetadata(room) {
  if (!room?.metadata) return {};
  try {
    const parsed = JSON.parse(room.metadata);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function isRoomPrivateFromMetadata(room) {
  return parseRoomMetadata(room).private === true;
}

// O início REAL da live (primeiro publisher), gravado desde 2026-09-30 —
// ver syncRoomMetadata. `null` quando a sala é de antes disso ou ainda
// não chegou a ficar pronta; aí quem lê cai no `extractStartedAt`.
function startedAtFromMetadata(room) {
  const value = parseRoomMetadata(room).startedAt;
  return typeof value === "number" && value > 0 ? value : null;
}

// O que o app reportou antes do restart. Validado campo a campo em vez
// de devolvido cru: isto foi escrito por OUTRA execução deste servidor,
// possivelmente de outra versão, e vai direto pro broadcast de salas.
function gameFromMetadata(room) {
  const game = parseRoomMetadata(room).game;
  if (!game || typeof game !== "object") return null;
  if (typeof game.name !== "string" || !game.name) return null;
  return {
    // Um `kind` desconhecido vira "window": é o placeholder mais neutro
    // dos três no app, e melhor que descartar o nome por causa dele.
    kind: GAME_KINDS.includes(game.kind) ? game.kind : "window",
    name: game.name,
    iconUrl: typeof game.iconUrl === "string" ? game.iconUrl : null,
  };
}

function toPublicRoom(room) {
  return { ...room };
}

// Uma sala privada só vai pra quem está na lista de permissão dela (o
// host e quem aceitou convite). Pública vai pra todo mundo.
function canSeeRoom(room, userId) {
  if (!room.private) return true;
  return presence.isAllowedInRoom(room.name, userId);
}

// O `isRoomReady` vem PRIMEIRO porque é a pergunta mais barata e a que
// recusa mais: sala pedida e ainda não publicada não aparece pra
// ninguém, nem pro próprio dono (ver markRoomReady). É este filtro, e o
// gêmeo dele no broadcastRooms, que impedem a "Live de ???".
function roomsVisibleTo(userId) {
  return Array.from(roomsState.values())
    .filter((room) => isRoomReady(room.name) && canSeeRoom(room, userId))
    .map(toPublicRoom);
}

// Estado de presença de todo mundo que está conectado agora.
// online/offline vem dos sockets; "busy" é a preferência salva no banco,
// que o cache abaixo mantém em memória pra não consultar a cada
// broadcast.
function presenceSnapshot() {
  const map = {};
  for (const userId of presence.onlineUserIds()) {
    map[userId] = presencePreferenceCache.get(userId) === "busy" ? "busy" : "online";
  }
  return map;
}

// userId -> "available" | "busy". Alimentado no login/connect e em toda
// troca de status. Existe pelo mesmo motivo do cache de avatares: o
// broadcast é síncrono e chamado de dezenas de pontos, e consultar o
// banco em cada um deles transformaria tudo em async à toa.
const presencePreferenceCache = new Map();

// Um pacote POR USUÁRIO desde 2026-09-10, e não mais um `JSON.stringify`
// só mandado pra todo mundo: salas privadas não podem ir pra quem não foi
// convidado, então a lista muda de destinatário pra destinatário.
//
// A maioria vê exatamente a mesma coisa (só as públicas), então o caso
// comum é serializado UMA vez e reaproveitado — só quem tem convite
// ganha um pacote próprio. Nessa escala qualquer um dos dois serviria,
// mas assim não vira um problema se a lista de usuários crescer.
function broadcastRooms() {
  const userAvatars = buildUserAvatarsDirectory();
  const presenceMap = presenceSnapshot();
  const publicRooms = Array.from(roomsState.values())
    .filter((room) => isRoomReady(room.name) && !room.private)
    .map(toPublicRoom);

  const commonPayload = JSON.stringify({
    type: "rooms",
    rooms: publicRooms,
    userAvatars,
    presence: presenceMap,
  });

  const hasPrivateRooms = Array.from(roomsState.values()).some((r) => r.private);
  let sent = 0;

  presence.eachConnection((userId, ws) => {
    if (ws.readyState !== ws.OPEN) return;
    if (!hasPrivateRooms) {
      ws.send(commonPayload);
    } else {
      ws.send(
        JSON.stringify({
          type: "rooms",
          rooms: roomsVisibleTo(userId),
          userAvatars,
          presence: presenceMap,
        }),
      );
    }
    sent++;
  });

  console.log(`[rooms] broadcastRooms: enviado pra ${sent} conexão(ões)`);
}


// Roadmap item 46: se o HOST sai (participant_left) e ninguém reconecta
// como publisher dentro dessa folga, a sala é derrubada pra desconectar
// quem ainda estiver assistindo — sem isso, uma sala sem host ficava
// "viva" pro LiveKit indefinidamente enquanto tivesse QUALQUER viewer
// conectado (o `empty_timeout` dele só age quando a sala fica TOTALMENTE
// vazia, e "host" nem é um conceito que o LiveKit conhece nativamente).
// Folga de 3s (pedido do usuário, 2026-09-04) — dá tempo de uma
// instabilidade de rede curta se resolver sozinha (o host reconectando)
// sem derrubar a sala à toa; se o host reconectar a tempo,
// cancelPendingHostlessRoomTeardown() cancela essa derrubada.
const HOSTLESS_ROOM_GRACE_MS = 3000;

// UMA RECONEXÃO ANUNCIADA NÃO É UM HOST QUE CAIU (2026-09-20).
// ---------------------------------------------------------------------
// Bug real relatado pelo usuário: transmitindo o CLIENTE do LoL, a
// partida começou (o app trocou pra janela do jogo sozinho, ver
// gameWindowFollow.ts no Electron) e, no fim da partida, a live "parou e
// voltou sozinha no cliente", expulsando quem assistia.
//
// Quem expulsou foi este arquivo. O GStreamer não reconfigura um
// pipeline em andamento, então TODA troca de fonte — automática, ou o
// usuário mudando de monitor no modal — mata o processo e sobe outro. No
// intervalo o publisher do ingress sai da sala, e o `participant_left`
// lá embaixo dispara a folga de 3s como se o host tivesse caído. Só que
// o intervalo é maior que isso: são duas enumerações de janelas via
// PowerShell (450-800ms cada, medido), mais o spawn do gst-launch e a
// negociação WHIP — 2 a 4 segundos, e o fim de partida do LoL não é um
// momento ocioso da máquina. Passando dos 3s, a sala era apagada; quando
// o pipeline novo conectava, o LiveKit recriava a sala (`auto_create`) —
// daí a live "voltando sozinha", já sem os viewers.
//
// A correção NÃO é aumentar os 3s pra todo mundo: quem cai de verdade
// deve derrubar a sala rápido, senão os viewers ficam olhando pra um
// quadro congelado. Quem sabe a diferença é o app, porque a reconexão é
// decisão DELE — então ele avisa antes (POST /rooms/:roomName/
// reconnecting) e só a sala avisada ganha a folga longa.
const HOSTLESS_RECONNECT_GRACE_MS = 25000;

// Por quanto tempo um aviso continua valendo. Existe porque o aviso pode
// chegar ANTES do `participant_left` (troca manual: o app avisa e só
// então mata o processo) — nesse caso ele fica guardado esperando. Se o
// publisher nunca sair (a troca foi abortada, ou o app morreu antes de
// matar o pipeline), o aviso não pode valer pra sempre: a próxima queda
// REAL daquela sala, minutos depois, seria tratada como reconexão.
const RECONNECT_NOTICE_TTL_MS = 20000;
const reconnectNotices = new Map(); // roomName -> instante em que o aviso expira

// Bug real encontrado em produção (2026-09-06): uma sala pode NASCER sem
// host, não só ficar sem ele. `auto_create` do LiveKit é true por padrão
// (não sobrescrito no livekit.yaml), e o token JWT daquela sala continua
// válido por horas depois dela ser apagada — então qualquer cliente que
// (re)conecte com um token velho RECRIA a sala. Foi o que aconteceu: uma
// live foi encerrada certinho (room_finished confirmado) e 66s depois a
// sala voltou via room_started, sem publisher nenhum, virando uma
// "Live de ???" presa na lista pra todo mundo.
//
// A folga aqui é BEM maior que a de host que caiu (3s) porque o alvo é
// outro: numa live legítima é o próprio publisher do ingress que cria a
// sala, então o participant_joined com canPublish chega em milissegundos
// e cancela isso muito antes de 15s. O prazo só é generoso pra não
// derrubar uma sala legítima cujo publisher demore a aparecer por
// lentidão de rede/negociação WHIP.
//
// SUBIU DE 15s PRA 30s EM 2026-09-29, porque o que dispara isto mudou de
// significado. Antes a sala só nascia quando o GStreamer começava a
// publicar de verdade, então o `participant_joined` do publisher vinha
// milissegundos depois do `room_started` e 15s era uma eternidade. Agora
// quem cria a sala é o `ensureRoom` do POST /ingress (ver o comentário
// dele), e entre isso e o primeiro frame publicado ainda cabem a escolha
// da fonte, o spawn do gst-launch e a negociação WHIP.
//
// O prazo também deixou de ser a defesa principal contra sala fantasma:
// com `auto_create: false` ninguém mais consegue fabricar uma sala com
// um token velho. O que sobrou pra ele cobrir é uma live que foi PEDIDA
// e nunca chegou a publicar — e nesse caso esperar mais um pouco não
// custa nada a ninguém.
const HOSTLESS_NEW_ROOM_GRACE_MS = 30000;
const pendingHostlessRoomTimers = new Map(); // roomName -> Timeout

function cancelPendingHostlessRoomTeardown(roomName) {
  const timer = pendingHostlessRoomTimers.get(roomName);
  if (!timer) return;
  clearTimeout(timer);
  pendingHostlessRoomTimers.delete(roomName);
}

function scheduleHostlessRoomTeardown(roomName, graceMs = HOSTLESS_ROOM_GRACE_MS) {
  cancelPendingHostlessRoomTeardown(roomName);
  const timer = setTimeout(async () => {
    pendingHostlessRoomTimers.delete(roomName);
    const current = roomsState.get(roomName);
    // Sala já não existe mais (derrubada por outro caminho enquanto
    // esperava) ou já tem publisher de novo (reconectou a tempo) — nada
    // a fazer. Pergunta o `publishing`, e não o `hostName`, desde
    // 2026-10-16: a sala nasce com o dono como host, antes de ele
    // publicar qualquer coisa.
    if (!current || isRoomPublishing(roomName)) return;
    try {
      await roomService.deleteRoom(roomName);
      console.log(`[rooms] sala ${roomName} derrubada — sem host há ${graceMs}ms`);
    } catch (err) {
      console.error(`[rooms] falha ao derrubar sala ${roomName} sem host:`, err);
      // A SALA JÁ NÃO EXISTE NO LIVEKIT? (2026-10-16)
      //
      // Desde o "start instantâneo" a sala aparece na lista antes do
      // vídeo, então um estado local que sobreviva à sala de verdade é
      // uma live fantasma VISÍVEL. Sem isto ela esperaria a varredura
      // periódica (até ~105s) pra sumir. Na dúvida (o LiveKit não
      // respondeu), não mexe: a varredura continua de rede de proteção.
      try {
        const found = (await roomService.listRooms([roomName]))[0];
        if (!found && roomsState.has(roomName)) {
          console.warn(`[rooms] sala ${roomName} sem host já não existia no LiveKit — limpando`);
          cleanupFinishedRoom(roomName);
        }
      } catch (checkErr) {
        console.error(`[rooms] não consegui conferir se a sala ${roomName} ainda existe:`, checkErr);
      }
    }
  }, graceMs);
  pendingHostlessRoomTimers.set(roomName, timer);
}

// Consome o aviso de reconexão da sala, se houver um válido. Consumir (e
// não só ler) é de propósito: o aviso vale por UMA saída de publisher. A
// troca seguinte manda outro.
function takeReconnectNotice(roomName) {
  const expiresAt = reconnectNotices.get(roomName);
  if (expiresAt === undefined) return false;
  reconnectNotices.delete(roomName);
  return Date.now() < expiresAt;
}

// ---------------------------------------------------------------------
// QUEM CRIA SALA É ESTE SERVIDOR (2026-09-29)
//
// Até aqui ninguém criava sala nenhuma: o `auto_create` do LiveKit (true
// por padrão) materializava a sala sozinho assim que QUALQUER cliente
// conectasse com um token válido pra ela. Essa foi a causa raiz de três
// bugs diferentes, consertados um a um — o preview do host recriando a
// sala recém-apagada (2026-09-06), a "Live de ???" nascendo de um token
// velho (2026-09-06) e o código de sala inventado virando sala de
// verdade (2026-09-13). Cada conserto tapou UM caminho; a porta em si
// continuou aberta, e o sintoma voltou pelos VIEWERS: o
// `livekit-client` deles, desconectado no meio de uma reconexão, refaz o
// join com o mesmo token — e ressuscitava a sala que o host acabara de
// derrubar, que é a "sala que reaparece sem host" relatada pelo usuário.
//
// Agora o livekit.yaml tem `room: auto_create: false` e a sala só existe
// se ESTE arquivo mandar criar. Token velho reconectando recebe erro em
// vez de fabricar uma live fantasma.
//
// ⚠️ AS DUAS METADES ANDAM JUNTAS. Com `auto_create: false` e ninguém
// chamando isto, NENHUMA live sobe — nem o Ingress entra numa sala que
// não existe. Mexer num sem o outro derruba o app inteiro.
// ---------------------------------------------------------------------

// 60s cobre o intervalo entre este servidor criar a sala e o GStreamer do
// host realmente publicar nela (achar a janela/monitor, subir o
// gst-launch, negociar o WHIP). Menos que isso mataria a sala antes de a
// live começar; os 300s de fábrica deixam uma sala vazia de pé por 5
// minutos quando a live nem sobe.
const ROOM_EMPTY_TIMEOUT_S = 60;

// Fica nos 20s de fábrica DE PROPÓSITO: é ele que segura a sala viva
// durante uma troca de fonte sem viewer nenhum (o pipeline morre e outro
// sobe no lugar), e esse já era o número em vigor antes desta mudança —
// mexer aqui seria mudar um comportamento que ninguém pediu pra mudar.
const ROOM_DEPARTURE_TIMEOUT_S = 20;

// Cria a sala, ou devolve a que já existe: o `CreateRoom` do LiveKit é
// idempotente — sala existente volta como está, sem erro e sem reset.
async function ensureRoom(roomName, metadata) {
  return roomService.createRoom({
    name: roomName,
    emptyTimeout: ROOM_EMPTY_TIMEOUT_S,
    departureTimeout: ROOM_DEPARTURE_TIMEOUT_S,
    ...(metadata ? { metadata } : {}),
  });
}

// Quem está numa sala que já existe no LiveKit: os participantes visíveis
// e o publisher (o host). Lança se o LiveKit não responder — quem chama
// decide o que fazer com a dúvida.
async function readRoomPresence(roomName) {
  const roomParticipants = await roomService.listParticipants(roomName);
  const visibleParticipants = roomParticipants.filter(
    (p) => !isHiddenPreviewParticipant(p.identity, p.permission),
  );
  return {
    participants: visibleParticipants.map((p) => p.identity),
    hostName: visibleParticipants.find((p) => p.permission?.canPublish)?.identity ?? null,
  };
}

// Passa a conhecer uma sala que já existe no LiveKit, mas que não está no
// `roomsState`. Usado no boot e, desde 2026-10-16, também pela
// reconciliação (ver `reconcileRooms`).
function adoptExistingRoom(r, { hostName, participants }) {
  roomsState.set(r.name, {
    name: r.name,
    hostName,
    participants,
    // Recuperado do metadata da sala, igual ao `private` logo abaixo
    // (2026-09-21). Era `null` fixo aqui, e é o que fazia o
    // "Jogando: X" sumir do tile de quem assiste a cada restart
    // deste processo — pra não voltar nunca mais, já que o host não
    // reenvia o que não mudou.
    game: gameFromMetadata(r),
    // O começo REAL da live, do metadata (2026-09-30) — o
    // `extractStartedAt` é o fallback pra sala que nunca chegou a
    // ficar pronta ou que nasceu antes desta mudança. Ver
    // markRoomReady.
    startedAt: startedAtFromMetadata(r) ?? extractStartedAt(r),
    // Sala já em andamento ANTES deste restart: a privacidade é
    // recuperada do METADATA da sala no LiveKit (ver
    // syncRoomMetadata lá em cima), e não da memória — que se perdeu
    // junto com o processo. O `game` acima vem do mesmo lugar.
    private: isRoomPrivateFromMetadata(r),
  });
  // Os dois dados internos (2026-09-29, ver roomInternals lá em
  // cima). O `sid` vem pronto do listRooms; o dono, do publisher que
  // estiver lá — o userId de quem pediu o /ingress morreu junto com a
  // execução anterior, e a identity é o que sobrou pra reconhecer o
  // host quando ele mandar parar a live.
  setRoomSid(r.name, r.sid);
  rememberRoomPublisher(r.name, hostName);
  setRoomPublishing(r.name, hostName !== null);
  // Sala com publisher lá dentro é uma live que JÁ está no ar — ela
  // ficou pronta numa execução anterior deste processo, e o `ready`
  // morreu junto com a memória dela (2026-09-30, ver markRoomReady).
  // Sem isto, um restart do servidor sumiria com todas as lives em
  // andamento da lista de todo mundo.
  if (hostName !== null) markRoomReady(r.name);
}

// Estado inicial: se o prisma_server reiniciar com salas já em andamento, não
// fica sem saber delas até o próximo evento de webhook — busca os
// participantes de cada sala já ativa (listParticipants) pra saber hostName/
// participants desde já, em vez de esperar o próximo join/left de cada uma.
(async () => {
  try {
    const rooms = await roomService.listRooms();
    for (const r of rooms) {
      let presence = { hostName: null, participants: [] };
      try {
        presence = await readRoomPresence(r.name);
      } catch (err) {
        console.error(`Erro ao listar participantes da sala ${r.name}:`, err);
      }
      adoptExistingRoom(r, presence);
      // Item 46 do roadmap: cobre o caso do prisma_server reiniciar bem no
      // meio de uma sala já sem host (o host saiu antes do restart, só
      // sobraram viewers) — sem isso, essa sala ficaria sem a folga/
      // derrubada automática até o próximo participant_left de verdade
      // (que pode nunca vir, se só sobrarem viewers passivos).
      if (presence.hostName === null) scheduleHostlessRoomTeardown(r.name);
    }
    broadcastRooms();
  } catch (err) {
    console.error("Erro ao carregar estado inicial das salas:", err);
  }
})();

// --- Reconciliação periódica (2026-09-29) -----------------------------
//
// O bloco acima faz isto UMA vez, no boot. Daí em diante o `roomsState`
// vivia só de webhook — e webhook é uma mensagem de rede como outra
// qualquer: pode chegar fora de ordem, chegar duas vezes, ou não chegar.
// Quando não chegava, a divergência durava até alguém reiniciar o
// processo.
//
// As duas metades cobrem os dois lados da divergência, e nenhuma delas
// depende de a gente ter previsto a corrida que a causou. É essa a
// diferença entre isto e os consertos anteriores (a folga da sala sem
// host, a limpeza da sala órfã, o guard de `sid`): aqueles fecham
// caminhos conhecidos, um por um; este pega o resultado, venha de onde
// vier.
//
// Não substitui nenhum deles — é o último recurso, e um fantasma que só
// morre aqui já ficou até um minuto na tela de alguém. Quando este log
// aparecer, vale descobrir o caminho que produziu o fantasma em vez de
// aceitar que a varredura resolve.
const ROOM_RECONCILE_INTERVAL_MS = 45000;

// Idade mínima pra uma divergência ser considerada real. Existe por
// causa da corrida com a própria varredura: entre pedir o `listRooms` e
// comparar o resultado, uma live nova pode ter nascido — ela não estaria
// na lista que voltou, e seria apagada recém-criada. Um minuto é muito
// mais que qualquer uma dessas janelas (o `room_started` chega em
// milissegundos depois do `createRoom`) e não atrasa nada que importe:
// um fantasma a mais por 45 segundos não muda a vida de ninguém.
const ROOM_RECONCILE_MIN_AGE_MS = 60000;

async function reconcileRooms() {
  // Fotografa o que NÓS achamos que existe ANTES de perguntar pro
  // LiveKit. Comparar contra o `roomsState` de depois da chamada
  // incluiria as salas que nasceram durante ela — que, obviamente, não
  // estão na resposta.
  const knownBefore = new Map(roomsState);

  let live;
  try {
    live = await roomService.listRooms();
  } catch (err) {
    console.error("[rooms] reconciliação: falha ao listar salas no LiveKit:", err);
    return;
  }

  const liveNames = new Set(live.map((r) => r.name));

  // (A) O LiveKit tem, nós não conhecemos.
  //
  // É a sala fantasma no sentido mais literal: ninguém no app consegue
  // vê-la, então ninguém consegue encerrá-la, e as defesas que dependem
  // do `roomsState` (a derrubada por falta de host) não agem sobre ela.
  // O `empty_timeout` do LiveKit também não resolve — ele só conta com a
  // sala TOTALMENTE vazia, e basta um viewer preso lá dentro pra
  // segurá-la viva indefinidamente.
  //
  // EXCETO se tiver um publisher lá dentro (2026-10-16). Em 12/10 duas
  // lives no ar caíram juntas, no meio da transmissão: as salas sumiram
  // e o Ingress ficou ~20s tentando reentrar até desistir. Sala com
  // publisher não é fantasma — é uma live que este processo deixou de
  // conhecer (o carregamento do boot falhou, ou um webhook se perdeu), e
  // apagá-la derruba a transmissão de alguém. Essa a gente ADOTA, do
  // mesmo jeito que o boot faria.
  let adopted = false;
  for (const room of live) {
    if (roomsState.has(room.name)) continue;
    if (Date.now() - extractStartedAt(room) < ROOM_RECONCILE_MIN_AGE_MS) continue;

    let presence;
    try {
      presence = await readRoomPresence(room.name);
    } catch (err) {
      // Na dúvida, não apaga: tenta de novo na próxima varredura.
      console.error(`[rooms] reconciliação: falha ao ler os participantes de ${room.name}:`, err);
      continue;
    }
    // Pode ter chegado por webhook enquanto esperava a resposta acima.
    if (roomsState.has(room.name)) continue;
    if (presence.hostName !== null) {
      adoptExistingRoom(room, presence);
      adopted = true;
      console.warn(
        `[rooms] reconciliação: sala ${room.name} existia no LiveKit sem estado aqui, ` +
          `com ${presence.hostName} transmitindo — adotada`,
      );
      continue;
    }

    try {
      await roomService.deleteRoom(room.name);
      roomInternals.delete(room.name);
      console.warn(
        `[rooms] reconciliação: sala ${room.name} existia no LiveKit sem estado aqui ` +
          "— derrubada",
      );
    } catch (err) {
      console.error(`[rooms] reconciliação: falha ao derrubar a sala órfã ${room.name}:`, err);
    }
  }
  if (adopted) broadcastRooms();

  // (B) Nós temos, o LiveKit não tem mais.
  //
  // O oposto: uma live que acabou de verdade e continua na lista de todo
  // mundo, com o botão de assistir levando a lugar nenhum. Acontece
  // quando o `room_finished` se perde.
  for (const [name, room] of knownBefore) {
    if (liveNames.has(name)) continue;
    // Já limpou sozinha entre a foto e agora (o webhook chegou atrasado,
    // mas chegou) — nada a fazer.
    if (!roomsState.has(name)) continue;
    if (Date.now() - room.startedAt < ROOM_RECONCILE_MIN_AGE_MS) continue;
    console.warn(
      `[rooms] reconciliação: sala ${name} não existe mais no LiveKit — limpando o estado local`,
    );
    cleanupFinishedRoom(name);
  }
}

setInterval(() => {
  reconcileRooms().catch((err) => console.error("[rooms] reconciliação falhou:", err));
}, ROOM_RECONCILE_INTERVAL_MS);


app.get("/ping", (req, res) => {
  res.status(200).json("Successful Connection!");
});

// --- Contas de usuário (cadastro/login) -------------------------------------
// Guardadas no Postgres desde 2026-09-10 (antes: data/userList.json). O
// SQL fica em db/users.js — aqui só rotas. A senha continua nunca sendo
// guardada em texto puro, só hash+salt (crypto.scrypt), no mesmo formato
// de antes: a função hashPassword/verifyPassword abaixo não mudou.

// Roadmap item 43 (Electron): fotos de avatar customizadas (o usuário
// escolhe um preset OU faz upload de uma foto — presets são só
// ícone+cor, resolvidos 100% no cliente, nunca passam por aqui). Cada
// usuário com foto customizada tem um arquivo próprio, nomeado pelo id
// (não pelo nome — sobrevive a uma renomeação sem precisar mover
// arquivo). Rota pública (sem requireAuth) pelo mesmo motivo de
// /downloads logo abaixo: uma tag <img src> não manda Authorization
// header, então servir autenticado exigiria buscar o bytes via fetch no
// processo main e converter pra data URL — decisão confirmada com o
// usuário (2026-09-01): pública é aceitável, é só uma foto de perfil.
const AVATARS_DIR = path.join(__dirname, "data", "avatars");
if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true });


// hashPassword/verifyPassword saíram daqui pra auth/password.js em
// 2026-09-10 (a recuperação de senha também hasheia o código dela). O
// formato do hash não mudou — nenhuma senha já gravada foi invalidada.
const { hashPassword, verifyPassword } = require("./auth/password");

// Só letras (sem acento) e números — nenhum caractere especial (vírgula,
// ponto, "-", "_", "/" etc.), case sensitive (decisão de 2026-08-29).
const USERNAME_CHARSET_PATTERN = /^[A-Za-z0-9]+$/;

function isValidUsername(name) {
  return USERNAME_CHARSET_PATTERN.test(name);
}

// Checagem propositalmente frouxa: "tem algo, um @, algo, um ponto, algo".
// Validar e-mail por regex de verdade é um poço sem fundo, e o que prova
// que um endereço existe é mandar mensagem pra ele — o que vai acontecer
// quando a recuperação de senha (item 11.4) chegar. Aqui só barra erro de
// digitação óbvio.
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 255;
}

// O lock de escrita de usuário saiu junto com o arquivo (2026-09-10):
// ele existia porque dois cadastros simultâneos podiam ler o mesmo
// "próximo ID" do JSON antes de qualquer um salvar. No Postgres o id vem
// de uma IDENTITY e o nome duplicado esbarra na constraint UNIQUE — o
// banco resolve os dois casos sozinho.

// Roadmap item 43 (Electron): monta {nomeDoUsuário: avatarRef} do zero a
// partir do userList.json toda vez que é chamada — de propósito sem
// cache próprio, é sempre chamada logo antes de um broadcastRooms() (que
// já só roda em resposta a um evento real), então o custo de reler o
// arquivo é desprezível e evita qualquer chance de o diretório ficar
// desatualizado. Só entram usuários com avatar de fato definido (preset
// escolhido ou foto customizada) — sem entrada = cliente usa o
// placeholder local (mesmo ícone genérico de sempre).
// Avatar customizado é salvo em disco nomeado pelo ID (não pelo nome, ver
// POST /users/:id/avatar abaixo) — quem for montar a URL
// (/avatars/<id>.webp) precisa desse ID, então ele entra aqui na hora de
// mandar pro cliente (nunca gravado dentro do próprio objeto `avatar` no
// userList.json, que já vive dentro do registro do usuário — seria
// redundante guardar o id dentro dele mesmo).
// (avatarWithId foi pra db/users.js junto com o resto da forma do usuário.)

// --- Preferências por usuário ("settings") ---------------------------------
// Pedido do usuário (2026-09-06): cada conta ganha um objeto `settings`
// dentro do próprio registro em userList.json. Primeira chave:
// `alertForNewLives` — se o som de "sala nova apareceu na lista"
// (newLive.mp3) toca ou não pra esse usuário. Ligado por padrão.
//
// Contas criadas ANTES disso não têm o campo no arquivo, e não há
// migração em massa de propósito: `settingsOf` costura os defaults na
// leitura, então uma conta antiga se comporta exatamente como uma nova e
// o campo só é gravado de fato na primeira vez que o usuário mudar algo.
// Serve so pra VALIDAR o patch que vem do cliente (parseSettingsPatch
// abaixo): a chave tem que existir aqui e o tipo tem que bater. Os valores
// de verdade sao os DEFAULT das colunas no banco (ver as migrations) — os
// daqui nunca sao gravados.
const DEFAULT_USER_SETTINGS = {
  alertForNewLives: true,
  showViewersOverlay: false,
};

// Só as chaves conhecidas, com o default de cada uma preenchendo o que
// faltar — assim um `settings` antigo/parcial no arquivo nunca vaza
// `undefined` pro cliente, e uma chave estranha que alguém tenha posto
// no JSON à mão é descartada em vez de repassada.
function settingsOf(user) {
  const stored = user.settings ?? {};
  const result = {};
  for (const [key, fallback] of Object.entries(DEFAULT_USER_SETTINGS)) {
    result[key] = typeof stored[key] === typeof fallback ? stored[key] : fallback;
  }
  return result;
}

// Valida um `settings` PARCIAL vindo do cliente (só as chaves que ele
// quer mudar). Devolve `null` se algo não presta — a rota responde 400.
function parseSettingsPatch(patch) {
  if (patch === undefined) return {};
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return null;
  const result = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_USER_SETTINGS)) return null;
    if (typeof value !== typeof DEFAULT_USER_SETTINGS[key]) return null;
    result[key] = value;
  }
  return result;
}

// A forma do usuário que TODA rota devolve pro cliente. Existe como
// função única de propósito: /login, /register, PUT /users/:id e
// POST /users/:id/avatar montavam esse objeto cada um por conta própria,
// e era só questão de tempo até um deles esquecer um campo novo (foi
// exatamente o que aconteceu com o `settings`). A senha (hash) nunca
// entra aqui.
// (publicUser foi pra db/users.js — o formato devolvido pro app é
// exatamente o mesmo de antes.)

// Item 43 do roadmap (Electron): diretório {nome: avatarRef} que
// acompanha todo broadcast de salas.
//
// Virou CACHE em memória em 2026-09-10, e isso é necessário, não
// otimização: antes ele relia o userList.json a cada broadcast, o que era
// síncrono. Com Postgres a leitura é assíncrona, e broadcastRooms() é
// chamada de dezenas de pontos síncronos (webhooks do LiveKit, DELETE de
// sala, etc.) — transformar todos em async espalharia await por todo o
// arquivo à toa. Com o cache, broadcastRooms() continua síncrona.
//
// O cache é recarregado do banco em TODA escrita de usuário (cadastro,
// renomeação, troca de avatar) e no boot. Se alguém adicionar um caminho
// novo que muda nome ou avatar, precisa chamar refreshUserAvatars() lá —
// senão o avatar velho fica preso na lista de salas até o próximo
// restart.
let userAvatarsCache = {};

async function refreshUserAvatars() {
  try {
    userAvatarsCache = await usersDb.avatarsDirectory();
  } catch (err) {
    console.error("Erro ao recarregar o diretório de avatares:", err);
  }
}

function buildUserAvatarsDirectory() {
  return userAvatarsCache;
}

// REMOVIDA em 2026-09-17: `isUserActiveInAnyRoom(name)`.
//
// Ela decidia se uma troca de nome/foto merecia um broadcastRooms()
// imediato — a ideia era não broadcastar "à toa" quando a pessoa não
// estava em live nenhuma. A premissa estava errada: o diretório de
// avatares não serve só pra desenhar as salas, ele é a ÚNICA via de
// atualização da sidebar de usuários do app, que carrega a lista uma vez
// e vive dela. Com a condição, trocar a foto fora de uma live não
// chegava em ninguém — o defeito que o usuário relatou.
//
// Agora os dois caminhos (PUT /users/:id e POST /users/:id/avatar)
// broadcastam sempre. Trocar nome ou foto é raro; o custo é desprezível
// perto de um dado errado na tela de todo mundo.

// Roadmap item 43 (Electron, "atualização em tempo real"): o app antigo
// (Flutter) BLOQUEAVA renomear enquanto em live, porque a identity do
// participante no LiveKit é fixada na hora de conectar (trocar o nome no
// userList.json não muda quem o LiveKit acha que é aquele participante).
// Decisão confirmada com o usuário (2026-09-01): em vez de bloquear ou
// de refatorar pra uma identity baseada em ID (pesado — afetaria token,
// webhooks, tudo), corrige só o problema real: os nomes já guardados
// como STRING em roomsState (hostName, participants) — a identity de
// verdade dentro do LiveKit não muda (nem precisa), só a label que a UI
// mostra. Idempotente e barato: percorre as salas já em memória e troca
// as ocorrências do nome antigo pelo novo.
function propagateRename(oldName, newName) {
  for (const [roomName, room] of roomsState.entries()) {
    if (room.hostName !== oldName && !room.participants.includes(oldName)) continue;
    roomsState.set(roomName, {
      ...room,
      hostName: room.hostName === oldName ? newName : room.hostName,
      participants: room.participants.map((p) => (p === oldName ? newName : p)),
    });
  }
}

// POST /register { name, password } — cria uma conta nova.
// PÚBLICA desde 2026-09-10 (não tem mais `requireAuth`): com JWT por
// usuário, não existe token antes de existir conta. O que protege aqui é
// o rate limit.
app.post("/register", rateLimit.register, async (req, res) => {
  const { name, email, password } = req.body ?? {};

  if (
    typeof name !== "string" ||
    typeof email !== "string" ||
    typeof password !== "string" ||
    !name ||
    !email ||
    !password
  ) {
    return res
      .status(400)
      .json({ error: "Parâmetros obrigatórios: name, email, password" });
  }
  if (!isValidUsername(name)) {
    return res.status(400).json({ error: "Nome inválido. Use apenas letras e números." });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "E-mail inválido.", field: "email" });
  }

  try {
    // Pedido do usuário: dizer QUAL dos dois colidiu, pra tela de cadastro
    // marcar o campo certo em vez de um "já existe" genérico. O `field` na
    // resposta é o que o app usa pra isso.
    const conflict = await usersDb.findConflict(name, email);
    if (conflict.usernameTaken) {
      return res.status(409).json({ error: "Este nome de usuário já está em uso", field: "name" });
    }
    if (conflict.emailTaken) {
      return res.status(409).json({ error: "Este e-mail já está cadastrado", field: "email" });
    }

    // O TETO DE CONTAS (2026-09-18) — substituiu a aprovação manual.
    //
    // A contagem e o INSERT acontecem na MESMA transação, com um lock de
    // aplicação: sem isso, dois cadastros no mesmo instante leem "49 de
    // 50" e os dois entram. Ver `withUserSlot` em db/settings.js.
    //
    // Não havendo vaga, a linha NEM CHEGA A SER CRIADA. É a diferença
    // em relação ao modelo antigo, em que a conta nascia e ficava
    // esperando: aqui, ou entra, ou não existe.
    const slot = await settingsDb.withUserSlot((client) =>
      usersDb.createWith(client, {
        username: name,
        email,
        passwordHash: hashPassword(password),
      }),
    );

    if (!slot.ok) {
      console.log(
        `[register] cadastro de "${name}" recusado: limite de contas atingido ` +
          `(${slot.total}/${slot.maxUsers})`,
      );
      // 409 e não 403: não é falta de permissão de quem pede, é um
      // conflito com o estado atual do servidor — e amanhã o mesmo
      // pedido pode dar certo, se abrir vaga.
      //
      // O `code` é o que o app usa pra mostrar a tela explicando, em vez
      // de um erro de formulário genérico. Texto muda; código não.
      return res.status(409).json({
        code: "user_limit_reached",
        error:
          "O limite de contas do Prisma foi atingido. Entre em contato com o administrador " +
          "para pedir a liberação de uma vaga.",
      });
    }

    const created = slot.result;
    await refreshUserAvatars();

    console.log(`[register] conta "${name}" criada (${slot.total}/${slot.maxUsers} contas)`);

    // SEM TOKEN, como desde 2026-09-16 — mas por outro motivo agora. Não
    // é mais "a conta precisa ser aprovada": é que o cadastro e o login
    // são dois passos, e a tela de cadastro leva pro login com o usuário
    // já preenchido. Devolver token aqui duplicaria o caminho de entrada
    // sem necessidade.
    res.status(201).json({ user: usersDb.privateUser(created), status: created.status });
  } catch (err) {
    // A checagem acima não é atômica: entre o SELECT e o INSERT, outro
    // cadastro pode ter levado o mesmo nome. Quem garante de verdade é a
    // constraint do banco, e é ela que cai aqui (23505 = unique_violation).
    if (err.code === "23505") {
      const field = err.constraint === "users_email_lower_idx" ? "email" : "name";
      return res.status(409).json({ error: "Já cadastrado", field });
    }
    console.error("Erro ao cadastrar usuário:", err);
    res.status(500).json({ error: "Erro interno ao cadastrar usuário" });
  }
});

// Quem é o cliente que está falando (2026-09-21, migration 007).
//
// Um header só, `X-Prisma-Client: <plataforma>/<versão>` — ex.
// `windows/1.0.8`. HEADER e não campo no corpo porque os dois caminhos
// de entrada precisam mandar isso e um deles é o `GET /me`, que não tem
// corpo. De quebra, isto é propriedade de quem CHAMA e não do que está
// sendo pedido, então o contrato de cada rota fica como estava.
//
// ⚠️ O valor vem de fora e não é verificável: nada impede um cliente de
// anunciar uma versão que não é a dele. Serve pra saber quem já
// atualizou, NUNCA pra decidir acesso — pra isso existe o JWT.
//
// Ausente é um caso normal: o app Android e as versões do Windows
// anteriores a isto não mandam nada. Os dois campos viram `null`.
const CLIENT_HEADER = "x-prisma-client";
// Limites frouxos o suficiente pra qualquer cliente futuro e apertados o
// suficiente pra o banco não receber lixo: sem eles, o header é um campo
// de texto livre que qualquer um escreve.
const CLIENT_PLATFORM_RE = /^[a-z0-9]{1,16}$/;
const CLIENT_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,23}$/;

// SANITIZA em vez de conferir contra uma lista fechada de plataformas: um
// cliente novo (macOS, um front web) passa a ser registrado no dia em que
// nasce, sem migration nem deploy do servidor. O preço é aceitar um nome
// que ninguém escreveu ainda — e o pior que isso faz é aparecer escrito
// no painel.
//
// Qualquer coisa fora do formato devolve os dois campos nulos, e não
// metade do dado: "windows/versão inventada" é um cliente que não está
// falando o protocolo, e registrar só a plataforma dele daria a
// impressão de um acesso legítimo sem versão.
function parseClient(req) {
  const raw = req.headers[CLIENT_HEADER];
  if (typeof raw !== "string") return { platform: null, version: null };

  const slash = raw.indexOf("/");
  if (slash < 1) return { platform: null, version: null };

  const platform = raw.slice(0, slash).trim().toLowerCase();
  const version = raw.slice(slash + 1).trim();

  if (!CLIENT_PLATFORM_RE.test(platform)) return { platform: null, version: null };
  if (!CLIENT_VERSION_RE.test(version)) return { platform: null, version: null };

  return { platform, version };
}

// O PAINEL DE ADMINISTRAÇÃO NÃO CONTA COMO ACESSO (2026-09-21, pedido do
// usuário).
//
// Ele entra pelas MESMAS rotas — /login e /me, com uma conta normal que
// tem `is_admin` — então, sem isto, abrir o painel carimbava o próprio
// "último acesso" de quem abriu. A coluna passaria a responder "quando eu
// olhei o painel" em vez de "quando essa pessoa usou o app", e erraria
// justamente na conta de quem mais olha a tela.
//
// DOIS sinais, porque cada um cobre o furo do outro:
//
//   1. O HOSTNAME. O painel vive em `admin.<DOMAIN>` (ver
//      nginx/templates/prisma-https.conf.template) e é o nginx quem
//      preenche o Host — `proxy_set_header Host $host`. Este sinal não
//      exige NADA do cliente, e é o que mantém o app Android sendo
//      registrado sem precisar tocar no Flutter.
//   2. O HEADER do painel (`X-Prisma-Client: admin/<versão>`). Cobre
//      onde o hostname não diz nada: o `.env.teste` não define DOMAIN, e
//      o `npm run dev` do painel pode apontar pra qualquer alvo.
//
// ⚠️ Nenhum dos dois é à prova de mentira — os dois vêm do cliente, e
// quem quisesse esconder o próprio acesso conseguiria. Isto não é
// fronteira de segurança (essa é o JWT), é a diferença entre um número
// certo e um número que conta a coisa errada.
const ADMIN_PLATFORM = "admin";
const ADMIN_HOSTNAME = process.env.DOMAIN
  ? `admin.${process.env.DOMAIN}`.toLowerCase()
  : null;

function isAdminPanel(req, client) {
  if (client.platform === ADMIN_PLATFORM) return true;
  if (!ADMIN_HOSTNAME) return false;
  // `req.hostname` já descarta a porta. Com `trust proxy` ligado ele
  // prefere o X-Forwarded-Host, que o nginx daqui não manda — na
  // prática é o Host que o nginx repassou.
  return (req.hostname || "").toLowerCase() === ADMIN_HOSTNAME;
}

// Registra que esta conta acabou de entrar no app (2026-09-21, migrations
// 006 e 007). O painel mostra isso como "Último acesso", com a versão do
// app ao lado.
//
// SEM `await`, e com o erro engolido num log: gravar a data é
// escrituração, não parte de autenticar. Se o UPDATE falhar — ou demorar
// —, a pessoa tem que entrar do mesmo jeito; o preço de errar pro outro
// lado seria um login recusado por causa de um dado que ninguém além do
// admin olha.
//
// Chamado nos DOIS caminhos de entrada, /login e /me. Ver
// `touchLastLogin` em db/users.js pro porquê de não bastar o /login.
function recordAccess(userId, req) {
  const client = parseClient(req);

  // Só o APP carimba. Ver `isAdminPanel` logo acima.
  if (isAdminPanel(req, client)) return;

  usersDb.touchLastLogin(userId, client).catch((err) => {
    console.error(`Não foi possível gravar o último acesso do usuário ${userId}:`, err);
  });
}

// POST /login { name, password } — confere usuário+senha e devolve o JWT.
//
// PÚBLICA desde 2026-09-10, pelo mesmo motivo do /register. Duas camadas
// de rate limit: por IP e por username (ver auth/rateLimit.js).
//
// Mensagem igual pra "não existe" e "senha errada", de propósito: dizer
// qual dos dois falhou entregaria de graça a lista de quem tem conta.
app.post("/login", rateLimit.loginByIp, rateLimit.loginByUsername, async (req, res) => {
  const { name, password } = req.body ?? {};

  if (typeof name !== "string" || typeof password !== "string" || !name || !password) {
    return res.status(400).json({ error: "Parâmetros obrigatórios: name, password" });
  }

  try {
    const user = await usersDb.findByUsername(name);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(404).json({ error: "Usuário não encontrado" });
    }

    // Conta que não está ativa não recebe token (2026-09-16). A senha
    // é conferida ANTES desta checagem de propósito: responder
    // "aguardando aprovação" pra quem errou a senha contaria que aquele
    // nome de usuário existe.
    if (user.status !== "active") {
      return res.status(403).json({
        error: STATUS_LOGIN_ERROR[user.status] ?? "Esta conta não está ativa.",
        status: user.status,
      });
    }

    // Depois de TODAS as checagens (senha e situação da conta): só
    // conta como acesso o que virou token. Antes daqui, uma senha errada
    // ou uma conta bloqueada carimbariam a data de quem não entrou — e o
    // painel passaria a mostrar tentativa de invasão como "último
    // acesso".
    recordAccess(user.id, req);

    res.json({ user: usersDb.privateUser(user), token: signToken(user) });
  } catch (err) {
    console.error("Erro ao autenticar usuário:", err);
    res.status(500).json({ error: "Erro interno ao autenticar" });
  }
});

// GET /me — quem é o dono deste token, com os dados FRESCOS do banco.
//
// Chamado pelo app na abertura, quando o "manter conectado" restaura a
// sessão gravada em disco (2026-09-10). Resolve três coisas de uma vez:
//
//   1. VALIDA o token antes de a Home aparecer. Antes disso, um token
//      vencido levava o app pra Home, o primeiro request tomava 401 e
//      só então a pessoa voltava pro login — piscando uma tela que já
//      estava morta.
//   2. ATUALIZA nome/avatar/settings/presença. O session.json guarda o
//      que valia no login; trocar o avatar em outra máquina deixava
//      esta aqui exibindo o antigo.
//   3. Devolve `presence`, que o session.json NUNCA gravou — bug real:
//      quem entrava pelo "manter conectado" abria o seletor de status
//      com nenhuma opção marcada.
//
// O token novo na resposta faz a sessão ser DESLIZANTE: quem abre o app
// dentro dos 30 dias ganha mais 30, e na prática nunca é deslogado. Quem
// some por mais de 30 dias cai no login, que é o comportamento certo.
app.get("/me", requireAuth, async (req, res) => {
  try {
    const user = await usersDb.findById(req.userId);
    // O requireAuth já barra token de conta apagada; isto aqui só
    // sobrevive a uma corrida (conta apagada no meio do request).
    if (!user) return res.status(401).json({ error: "unauthorized" });

    // O "manter conectado" passa por aqui e NÃO pelo /login — quem tem a
    // sessão gravada em disco pode nunca mais digitar a senha. Sem este
    // carimbo, o painel mostraria os usuários mais assíduos como os mais
    // sumidos.
    recordAccess(user.id, req);

    res.json({ user: usersDb.privateUser(user), token: signToken(user) });
  } catch (err) {
    console.error("Erro ao carregar o usuário do token:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

// --- Recuperação de senha (2026-09-10, item 16.4) -----------------------
//
// Fluxo em dois passos: pede o código por e-mail, depois manda código +
// senha nova. Código de 6 dígitos, e não link mágico, porque o cliente é
// um app DESKTOP: um link teria que abrir o navegador e voltar pro
// Electron por protocolo customizado registrado no instalador — muito
// mais peça pra quebrar, pra resolver a mesma coisa.

// Seis dígitos com zeros à esquerda preservados. `randomInt` do crypto,
// não Math.random(): este número é uma credencial temporária, e
// Math.random não é imprevisível o suficiente pra isso.
function generateResetCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

// POST /password-reset/request { email }
//
// SEMPRE responde 204, exista o e-mail ou não. Sem isso a rota vira um
// oráculo de "esta pessoa tem conta aqui".
//
// (Ressalva honesta: o /register JÁ diz se um e-mail está em uso — foi
// decisão de UX, pra tela de cadastro apontar o campo certo. Então a
// enumeração é possível por lá de qualquer jeito. Isto aqui não conserta
// aquilo, só evita abrir um SEGUNDO caminho.)
app.post("/password-reset/request", rateLimit.passwordResetRequest, async (req, res) => {
  const { email } = req.body ?? {};

  if (typeof email !== "string" || !email.trim()) {
    return res.status(400).json({ error: "Parâmetro obrigatório: email" });
  }

  try {
    const user = await usersDb.findByEmail(email.trim());
    // Silêncio proposital: mesma resposta de quando existe.
    if (!user) return res.status(204).send();

    // Teto por CONTA, além do rate limit por IP. Sem ele, dá pra usar
    // esta rota pra encher a caixa de entrada de alguém — não é invasão
    // de conta, mas é abuso, e sai caro na cota do provedor.
    const recent = await resetsDb.countRecent(user.id);
    if (recent >= resetsDb.MAX_REQUESTS_PER_HOUR) {
      console.warn(`Muitos pedidos de recuperação para o usuário ${user.id} — ignorando`);
      return res.status(204).send();
    }

    const code = generateResetCode();
    await resetsDb.create(user.id, hashPassword(code));

    // `await` no envio, mas a falha NÃO vira erro pra quem chamou: a
    // resposta é 204 de qualquer jeito (ver o comentário do oráculo
    // acima). O log é onde isso aparece.
    try {
      await mail.sendPasswordResetCode({
        to: user.email,
        username: user.username,
        code,
        ttlMinutes: resetsDb.CODE_TTL_MINUTES,
      });
    } catch (err) {
      console.error("Falha ao enviar o e-mail de recuperação:", err);
    }

    res.status(204).send();
  } catch (err) {
    console.error("Erro ao gerar código de recuperação:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

// POST /password-reset/confirm { email, code, newPassword }
//
// Aqui o erro é ESPECÍFICO de propósito, ao contrário do request: quem
// chega com um código na mão já provou ter acesso à caixa de e-mail, e
// "código errado" x "código expirado" é a diferença entre digitar de
// novo e pedir outro.
app.post("/password-reset/confirm", rateLimit.passwordResetConfirm, async (req, res) => {
  const { email, code, newPassword } = req.body ?? {};

  if (
    typeof email !== "string" ||
    typeof code !== "string" ||
    typeof newPassword !== "string" ||
    !email.trim() ||
    !code.trim() ||
    !newPassword
  ) {
    return res.status(400).json({ error: "Parâmetros obrigatórios: email, code, newPassword" });
  }

  try {
    const user = await usersDb.findByEmail(email.trim());
    // Mesma mensagem de código inválido, e não "usuário não encontrado":
    // senão esta rota vira o oráculo que a outra evitou ser.
    if (!user) {
      return res.status(400).json({ error: "Código inválido ou expirado", code: "invalid_code" });
    }

    const reset = await resetsDb.findActive(user.id);
    if (!reset) {
      return res.status(400).json({ error: "Código inválido ou expirado", code: "invalid_code" });
    }

    if (!verifyPassword(code.trim(), reset.code_hash)) {
      // Conta a tentativa ANTES de responder. É este teto (5, ver
      // db/passwordResets.js) que impede varrer as 1.000.000
      // combinações de 6 dígitos dentro da validade — limite por IP
      // não resolve sozinho, porque o atacante pode trocar de IP.
      const attempts = await resetsDb.registerAttempt(reset.id);
      const left = Math.max(0, resetsDb.MAX_ATTEMPTS - attempts);
      return res.status(400).json({
        error: left
          ? `Código inválido. Tentativas restantes: ${left}`
          : "Código inválido. Peça um novo código.",
        code: "invalid_code",
        attemptsLeft: left,
      });
    }

    // Ordem importa: queima o código ANTES de trocar a senha. Se algo
    // falhar no meio, o pior caso é a pessoa pedir outro código — e não
    // um código válido sobrando por aí.
    await resetsDb.markUsed(reset.id);
    await usersDb.update(user.id, { passwordHash: hashPassword(newPassword) });

    // O ponto da feature: derruba TODA sessão da conta. Recuperar senha
    // é o cenário "perdi o controle da conta" — deixar o token de quem
    // invadiu vivo por mais 30 dias tornaria isso decorativo.
    await usersDb.bumpTokenVersion(user.id);
    invalidateTokenVersion(user.id);

    // Sem token na resposta de propósito: quem redefiniu a senha vai
    // pra tela de login e entra com ela. Emitir token aqui daria acesso
    // a quem só provou ter lido um e-mail.
    res.status(204).send();
  } catch (err) {
    console.error("Erro ao redefinir a senha:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

// Formato aceito pro campo `avatar` aqui é só o preset — upload de foto
// customizada tem rota própria (POST /users/:id/avatar) porque manda o
// arquivo em si, não um JSON pequeno. `key` não é validado contra uma
// lista fixa aqui de propósito: a lista de presets é só de UI (ícone+cor
// resolvidos no cliente), o server não precisa conhecê-la — só guarda a
// string.
function isValidPresetAvatar(avatar) {
  return (
    avatar &&
    typeof avatar === "object" &&
    avatar.type === "preset" &&
    typeof avatar.key === "string" &&
    avatar.key.length > 0
  );
}

// PUT /users/:id { name?, avatar? } — atualiza nome e/ou avatar (preset)
// de uma conta já cadastrada. Pelo menos um dos dois precisa vir. Nome
// mantém a mesma checagem de duplicado do cadastro.
//
// Roadmap item 43 ("atualização em tempo real"): ao contrário do app
// antigo (Flutter), aqui NÃO bloqueia alterar nome/avatar durante uma
// live — em vez disso, propaga a mudança pra quem já está vendo/na sala
// (propagateRename troca o nome já em memória em roomsState; avatar
// não precisa de patch equivalente porque nunca é guardado por sala, só
// resolvido ao vivo via buildUserAvatarsDirectory() a cada broadcast).
// `requireSelf` (2026-09-10): sem ele, qualquer conta autenticada poderia
// renomear/alterar OUTRA só trocando o id da URL — o token antigo era
// compartilhado, então "autenticado" não dizia QUEM era.
app.put("/users/:id", requireAuth, requireSelf, async (req, res) => {
  const id = Number(req.params.id);
  const { name, avatar, settings } = req.body ?? {};

  const hasName = name !== undefined;
  const hasAvatar = avatar !== undefined;
  const hasSettings = settings !== undefined;

  if (!Number.isInteger(id) || (!hasName && !hasAvatar && !hasSettings)) {
    return res.status(400).json({ error: "Informe ao menos um de: name, avatar, settings" });
  }
  if (hasName && (typeof name !== "string" || !name || !isValidUsername(name))) {
    return res.status(400).json({ error: "Nome inválido. Use apenas letras e números." });
  }
  if (hasAvatar && avatar !== null && !isValidPresetAvatar(avatar)) {
    return res.status(400).json({ error: "avatar deve ser {type:'preset', key} ou null" });
  }

  // Pedido do usuário (2026-09-06): preferências entram por aqui em vez
  // de numa rota nova — é o mesmo recurso (o usuário) e o mesmo lock de
  // escrita, então PUT parcial cobre o caso sem duplicar nada.
  const settingsPatch = parseSettingsPatch(settings);
  if (settingsPatch === null) {
    const conhecidas = Object.keys(DEFAULT_USER_SETTINGS).join(", ");
    return res
      .status(400)
      .json({ error: `settings inválido. Chaves aceitas: ${conhecidas}` });
  }

  try {
    const before = await usersDb.findById(id);
    if (!before) return res.status(404).json({ error: "Usuário não encontrado" });

    // O patch de settings vem só com as chaves que mudaram; db/users.js
    // atualiza apenas as colunas correspondentes, então as outras
    // preferências ficam intactas sem precisar de merge aqui.
    const updated = await usersDb.update(id, {
      username: hasName ? name : undefined,
      avatar: hasAvatar ? avatar : undefined,
      settings: hasSettings ? settingsPatch : undefined,
    });

    const user = usersDb.privateUser(updated);
    const renamed = hasName && before.username !== name;

    if (renamed || hasAvatar) await refreshUserAvatars();
    if (renamed) propagateRename(before.username, user.name);
    // Renomear invalida o cache do jwt.js (2026-09-23). Ele guarda o
    // NOME junto da token_version, e é de lá que sai o `req.username` de
    // toda rota autenticada — sem isto, a pessoa continuaria se
    // apresentando pelo nome antigo até o token vencer, e o `/invite` e
    // o `/kick` da própria live dela passariam a responder 403 (ver o
    // comentário do `req.username` em auth/jwt.js).
    //
    // NÃO sobe a token_version de propósito: trocar de nome não é
    // motivo pra deslogar ninguém. Só o cache cai.
    if (renamed) invalidateTokenVersion(id);
    // Sem a condição de estar numa live (2026-09-17) — mesmo motivo do
    // POST /users/:id/avatar logo abaixo: a sidebar de usuários do app
    // vive de uma lista carregada uma vez, e é este broadcast que
    // atualiza o nome e a foto nela pros OUTROS. Com a condição, mudar
    // qualquer um dos dois fora de uma live não chegava a ninguém.
    if (renamed || hasAvatar) broadcastRooms();

    res.json(user);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Este nome de usuário já está em uso", field: "name" });
    }
    console.error("Erro ao atualizar usuário:", err);
    res.status(500).json({ error: "Erro interno ao atualizar usuário" });
  }
});

// PUT /users/:id/password { currentPassword, newPassword } — novo em
// 2026-09-10. Antes não existia jeito de trocar a senha.
//
// Exige a senha ATUAL mesmo já estando autenticado: o JWT dura 30 dias e
// fica em disco, então uma máquina destravada por um minuto bastaria pra
// trocar a senha e tomar a conta. Pedir a atual custa pouco e fecha isso.
app.put("/users/:id/password", requireAuth, requireSelf, async (req, res) => {
  const id = Number(req.params.id);
  const { currentPassword, newPassword } = req.body ?? {};

  if (
    typeof currentPassword !== "string" ||
    typeof newPassword !== "string" ||
    !currentPassword ||
    !newPassword
  ) {
    return res
      .status(400)
      .json({ error: "Parâmetros obrigatórios: currentPassword, newPassword" });
  }

  try {
    const user = await usersDb.findById(id);
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });

    if (!verifyPassword(currentPassword, user.password_hash)) {
      return res
        .status(403)
        .json({ error: "Senha atual incorreta", field: "currentPassword" });
    }

    await usersDb.update(id, { passwordHash: hashPassword(newPassword) });

    // Invalida TODO token já emitido pra esta conta (2026-09-10,
    // migration 003) — inclusive o que está fazendo esta requisição.
    //
    // Antes daqui, trocar a senha não expulsava ninguém: o JWT é
    // stateless e vale 30 dias, então quem tivesse invadido a conta
    // continuaria dentro por até um mês DEPOIS da troca. Que é
    // exatamente o cenário em que alguém troca a senha.
    const updated = await usersDb.bumpTokenVersion(id);
    invalidateTokenVersion(id);

    // Token novo pra quem trocou, senão a própria pessoa seria
    // deslogada pela revogação que ela mesma disparou. Quem NÃO tem
    // este token (as outras sessões, o invasor) cai no login.
    res.json({ token: signToken(updated) });
  } catch (err) {
    console.error("Erro ao trocar a senha:", err);
    res.status(500).json({ error: "Erro interno ao trocar a senha" });
  }
});

// POST /users/:id/avatar — recebe a FOTO já comprimida pelo cliente
// (canvas -> WebP 96x96, ver UserProfileModal.tsx no Electron) como
// corpo binário cru (Content-Type: image/webp), grava em
// data/avatars/<id>.webp e marca o usuário como tendo avatar customizado.
// Nomeado pelo id (não pelo nome) — sobrevive a uma renomeação sem
// precisar mover/renomear o arquivo em disco.
//
// `version` é um contador simples que muda a cada upload, só pra servir
// de cache-buster na URL que o cliente monta
// (/avatars/<id>.webp?v=<version>) — sem isso, um <img> já teria
// cacheado a foto antiga do mesmo id e não atualizaria sozinho depois de
// trocar a foto.
app.post(
  "/users/:id/avatar",
  requireAuth,
  requireSelf,
  express.raw({ type: "image/webp", limit: "2mb" }),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "id inválido" });
    }
    if (!Buffer.isBuffer(req.body) || !isWebp(req.body)) {
      return res
        .status(400)
        .json({ error: "Corpo obrigatório: imagem WebP crua (Content-Type: image/webp)" });
    }

    try {
      const current = await usersDb.findById(id);
      if (!current) return res.status(404).json({ error: "Usuário não encontrado" });

      const nextVersion =
        (current.avatar?.type === "custom" ? current.avatar.version : 0) + 1;

      // Arquivo primeiro, banco depois: se a escrita em disco falhar, o
      // banco não fica apontando pra uma foto que não existe. Na ordem
      // inversa, o app tentaria carregar /avatars/<id>.webp e receberia 404.
      fs.writeFileSync(path.join(AVATARS_DIR, `${id}.webp`), req.body);
      const updated = await usersDb.update(id, {
        avatar: { type: "custom", version: nextVersion },
      });
      // Quem tinha GIF e voltou pra foto parada: o `.gif` velho não é
      // mais referenciado por ninguém. DEPOIS do banco — se apagar
      // falhar, sobra só um arquivo órfão, nunca uma URL quebrada.
      removeAvatarFile(id, "gif");

      const user = usersDb.privateUser(updated);
      await refreshUserAvatars();

      // Broadcast SEMPRE (2026-09-17), e não só quando quem trocou está
      // numa live.
      //
      // A condição que estava aqui (`isUserActiveInAnyRoom`) partia de
      // que o diretório de avatares só importava pra desenhar as salas.
      // Não é verdade: a SIDEBAR DE USUÁRIOS do app carrega a lista uma
      // vez (GET /users) e vive dela — quem atualiza a foto ali é este
      // broadcast. Sem ele, trocar a foto fora de uma live não chegava a
      // ninguém, e o sintoma era exatamente o relatado: a foto nova
      // aparecia em todo lugar, menos na lista de usuários dos outros.
      //
      // O custo é desprezível: trocar de foto é raro, e o payload já
      // seria montado de qualquer forma na próxima mudança de sala.
      broadcastRooms();

      res.json(user);
    } catch (err) {
      console.error("Erro ao salvar avatar customizado:", err);
      res.status(500).json({ error: "Erro interno ao salvar avatar" });
    }
  },
);

// POST /users/:id/avatar/animated — avatar em GIF (2026-10-19).
//
// Chegam DOIS arquivos num corpo só: a cópia PARADA em WebP (primeiro
// quadro, 96x96) seguida do GIF animado, os dois já prontos no cliente
// (ver lib/avatar.ts no app e no site) — o servidor continua sem
// biblioteca de imagem, só grava. O header `X-Avatar-Static-Bytes` diz
// onde um termina e o outro começa.
//
// Por que a cópia parada: as versões do app anteriores a isto montam
// SEMPRE `/avatars/<id>.webp`. Sem o arquivo lá, toda pessoa com GIF
// apareceria como imagem quebrada pra quem não atualizou. Com ele, essas
// versões mostram a foto parada e as novas (que leem `format`) a
// animada.
//
// Num corpo só, e não em dois uploads, pra os dois arquivos mudarem
// juntos: dois requests deixariam uma janela (ou um erro no meio) com o
// GIF de uma foto e a cópia parada de outra.
const MAX_ANIMATED_AVATAR_BYTES = 4 * 1024 * 1024;
app.post(
  "/users/:id/avatar/animated",
  requireAuth,
  requireSelf,
  express.raw({ type: "application/octet-stream", limit: MAX_ANIMATED_AVATAR_BYTES }),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "id inválido" });
    }

    const staticBytes = Number(req.get("X-Avatar-Static-Bytes"));
    const body = req.body;
    if (
      !Buffer.isBuffer(body) ||
      !Number.isInteger(staticBytes) ||
      staticBytes <= 0 ||
      staticBytes >= body.length
    ) {
      return res.status(400).json({
        error:
          "Corpo obrigatório: WebP parado + GIF (application/octet-stream, X-Avatar-Static-Bytes)",
      });
    }

    const webp = body.subarray(0, staticBytes);
    const gif = body.subarray(staticBytes);
    if (!isWebp(webp) || !isGif(gif)) {
      return res.status(400).json({ error: "Arquivos inválidos: esperado WebP + GIF" });
    }

    try {
      const current = await usersDb.findById(id);
      if (!current) return res.status(404).json({ error: "Usuário não encontrado" });

      const nextVersion =
        (current.avatar?.type === "custom" ? current.avatar.version : 0) + 1;

      // Arquivos primeiro, banco depois — mesmo motivo da rota acima.
      fs.writeFileSync(path.join(AVATARS_DIR, `${id}.webp`), webp);
      fs.writeFileSync(path.join(AVATARS_DIR, `${id}.gif`), gif);
      const updated = await usersDb.update(id, {
        avatar: { type: "custom", version: nextVersion, format: "gif" },
      });

      const user = usersDb.privateUser(updated);
      await refreshUserAvatars();
      // Broadcast sempre — ver o comentário da rota acima.
      broadcastRooms();

      res.json(user);
    } catch (err) {
      console.error("Erro ao salvar avatar animado:", err);
      res.status(500).json({ error: "Erro interno ao salvar avatar" });
    }
  },
);

// Assinaturas dos dois formatos aceitos. Conferidas porque a rota é
// pública pra qualquer usuário logado e o arquivo é servido de volta pra
// todo mundo: sem isto, dava pra gravar qualquer coisa em
// /avatars/<id>.gif.
function isWebp(buf) {
  return (
    buf.length > 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  );
}

function isGif(buf) {
  const head = buf.length > 6 ? buf.toString("ascii", 0, 6) : "";
  return head === "GIF87a" || head === "GIF89a";
}

// Apaga um arquivo de avatar que pode não existir. ENOENT é o caso
// normal (quem nunca mandou GIF não tem `.gif`), não erro.
function removeAvatarFile(id, ext) {
  const file = path.join(AVATARS_DIR, `${id}.${ext}`);
  fs.promises.unlink(file).catch((err) => {
    if (err.code !== "ENOENT") console.error(`Não foi possível apagar ${file}:`, err);
  });
}

// GET /token?roomName=123456&participantName=igor&role=host|viewer&hidden=true
//
// Gera o JWT que o livekit-client (renderer do Electron) usa pra
// conectar direto no LiveKit Server (ver src/main/livekit.ts do
// Electron) — o prisma_server nunca fala com o LiveKit ele mesmo aqui,
// só assina a permissão. roomName é o código de 6 dígitos gerado pelo
// host (ver roadmap item 12); o LiveKit cria a sala sozinho no primeiro
// participante a entrar, não precisa de um POST /rooms separado.
//
// `hidden` (query string, "true"/"false", default false) — readicionado
// em 2026-08-30 pro item 15 do roadmap (preview do host da própria live
// via GStreamer): mesmo grant "hidden" do LiveKit usado no token-server
// do app antigo (Flutter) — participante que não conta em
// numParticipants nem aparece pra mais ninguém, usado pro HOST entrar
// como um segundo participante (view-only, identity com sufixo
// "-preview", diferente da identity que publica via Ingress) só pra
// receber de volta o próprio vídeo publicado.
// GET /users — lista pra sidebar de usuários (item 11 do ROADMAP).
// Traz todo mundo do banco; o estado online/offline/ocupado vem por
// fora, no `presence` (o mesmo objeto que acompanha cada broadcast de
// salas). Quem não aparece no mapa está offline.
app.get("/users", requireAuth, async (req, res) => {
  try {
    // As duas consultas juntas: quem existe, e quem EU fixei
    // (migration 008). Em paralelo porque uma não depende da outra — a
    // segunda é uma leitura por chave primária e custa quase nada, mas
    // encadeá-las somaria os dois tempos de ida e volta ao banco à
    // abertura da lista.
    const [users, pinned] = await Promise.all([
      usersDb.listAll(),
      usersDb.listPinnedIds(req.userId),
    ]);
    // `pinned` é uma lista de ids, e não um campo dentro de cada
    // usuário: o `publicUser` é o MESMO objeto que vai pra todo mundo
    // (e que o Android também consome), e marcar nele um dado que só
    // vale pra quem pediu convidaria a confusão — um dia alguém cacheia
    // essa lista e serve a preferência de um pra outro.
    res.json({ users, presence: presenceSnapshot(), pinned });
  } catch (err) {
    console.error("Erro ao listar usuários:", err);
    res.status(500).json({ error: "Erro interno ao listar usuários" });
  }
});

// PUT /users/:id/presence { preference } — "available" ou "busy".
//
// Só a PREFERÊNCIA entra aqui. Não existe "ficar offline" por esta rota:
// offline é não ter socket aberto, e isso acontece fechando o app.
app.put("/users/:id/presence", requireAuth, requireSelf, async (req, res) => {
  const id = Number(req.params.id);
  const { preference } = req.body ?? {};

  if (preference !== "available" && preference !== "busy") {
    return res.status(400).json({ error: 'preference deve ser "available" ou "busy"' });
  }

  try {
    const updated = await usersDb.setPresencePreference(id, preference);
    if (!updated) return res.status(404).json({ error: "Usuário não encontrado" });

    presencePreferenceCache.set(id, preference);
    // Todo mundo precisa ver a mudança na hora — é o mesmo broadcast que
    // já carrega as salas, então não há canal novo.
    broadcastRooms();

    res.json(usersDb.privateUser(updated));
  } catch (err) {
    console.error("Erro ao mudar a presença:", err);
    res.status(500).json({ error: "Erro interno ao mudar a presença" });
  }
});

// POST /users/:id/pin — fixar alguém no topo da MINHA lista
// (migration 008, 2026-09-25).
//
// `requireAuth` e NÃO `requireSelf`: aqui o `:id` é a OUTRA pessoa, e o
// dono da preferência é quem está autenticado (`req.userId`). É o
// contrário da rota de presença logo acima — lá o `:id` sou eu.
//
// Não avisa ninguém, e não entra no broadcast de salas: fixar é uma
// escolha privada que só muda a ordem da lista de quem fixou. A pessoa
// fixada não fica sabendo, e nenhum outro cliente precisa ser
// notificado — o próprio app já atualiza a tela no clique.
app.post("/users/:id/pin", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });
  // O CHECK da migration recusaria isso com um 500 feio; aqui vira uma
  // resposta que explica.
  if (id === req.userId) {
    return res.status(400).json({ error: "Não dá para fixar a si mesmo" });
  }

  try {
    const pinned = await usersDb.pinUser(req.userId, id);
    // `false` = a conta não existe mais (chave estrangeira). Acontece
    // quando ela é apagada entre a lista carregar no app e o clique.
    if (!pinned) return res.status(404).json({ error: "Usuário não encontrado" });
    res.status(204).send();
  } catch (err) {
    console.error("Erro ao fixar usuário:", err);
    res.status(500).json({ error: "Erro interno ao fixar o usuário" });
  }
});

// DELETE /users/:id/pin — desfixar.
//
// Sempre 204, inclusive se a pessoa não estava fixada ou nem existe
// mais: o resultado pedido ("essa pessoa não está fixada pra mim") já é
// verdade nos três casos. Um 404 aqui só daria ao app um erro pra
// mostrar sobre algo que deu certo.
app.delete("/users/:id/pin", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });

  try {
    await usersDb.unpinUser(req.userId, id);
    res.status(204).send();
  } catch (err) {
    console.error("Erro ao desfixar usuário:", err);
    res.status(500).json({ error: "Erro interno ao desfixar o usuário" });
  }
});

// POST /rooms/:roomName/invite { userId } — o host convida alguém pra
// a live dele. Vale pra QUALQUER sala, privada ou não (decisão do
// usuário, 2026-09-10) — numa pública o convite é só um atalho, já que
// a pessoa poderia entrar pela lista; numa privada é o único caminho.
//
// O convite:
//
//   - só existe em memória, e morre junto com a sala (ver presence.js);
//   - só vai pra quem está ONLINE, por decisão do usuário — quem está
//     offline nem aparece na lista de convidáveis do app;
//   - é entregue pelo WebSocket que o app já mantém aberto.
//
// O convidado só entra na lista de permissão quando ACEITA (rota
// abaixo) — convidar não dá acesso, senão um convite recusado deixaria
// a sala visível pra ele mesmo assim.
//
// ---------------------------------------------------------------------
// UM CONVITE DE PÉ POR VEZ (2026-09-14, pedido do usuário)
//
// O host pode clicar em "convidar" o quanto quiser — o app não trava
// mais o botão. Quem garante que ninguém seja incomodado duas vezes é
// esta rota: com um convite já de pé pra essa pessoa nesta sala, ela
// responde OK e NÃO manda nada. Do lado do convidado nada muda, e o
// tempo que já estava correndo continua correndo.
//
// O bloqueio saiu do app e veio pra cá de propósito. Lá ele era um
// palpite sobre o estado do outro lado (e ficava errado: recusa não
// destravava, fechar o painel esquecia tudo); aqui é o próprio estado.
//
// Depois que o convite morre — recusado, aceito ou vencido — um clique
// novo manda um convite novo, que é exatamente o que o usuário pediu.
// ---------------------------------------------------------------------
app.post("/rooms/:roomName/invite", requireAuth, async (req, res) => {
  const { roomName } = req.params;
  const { userId } = req.body ?? {};

  if (!Number.isInteger(userId)) {
    return res.status(400).json({ error: "userId obrigatório" });
  }

  const room = roomsState.get(roomName);
  if (!room) return res.status(404).json({ error: "Sala não encontrada" });

  // Só o host convida. Sem isso, um viewer convidaria gente pra uma sala
  // privada que não é dele.
  if (room.hostName !== req.username) {
    return res.status(403).json({ error: "Só o host pode convidar." });
  }

  if (!presence.isOnline(userId)) {
    return res.status(409).json({ error: "Este usuário não está online." });
  }

  // Já tem um convite de pé: nada a fazer, e isso NÃO é erro. O host
  // vê o mesmo "convite enviado" de sempre — do ponto de vista dele o
  // convite está mesmo lá, de pé.
  if (presence.hasPendingInvite(roomName, userId)) {
    console.log(
      `[rooms] ${req.username} reconvidou userId=${userId} pra ${roomName} com convite pendente — ignorado`,
    );
    return res.status(204).send();
  }

  const sent = presence.sendToUser(userId, {
    type: "invite",
    roomName,
    hostName: room.hostName,
    game: room.game,
  });

  if (!sent) {
    // Saiu entre o isOnline() e o envio.
    return res.status(409).json({ error: "Este usuário não está online." });
  }

  // Registra o convite PENDENTE só depois de conseguir entregar. É ele
  // que autoriza o accept mais adiante.
  presence.invite(roomName, userId);

  res.status(204).send();
});

// Avisa o HOST o que aconteceu com um convite que ele mandou
// (2026-09-14, pedido do usuário): sem isso quem convida fica sem
// saber se a pessoa recusou ou só não viu, e o botão de convidar do
// app dele nunca destrava.
//
// O host é resolvido pelo NOME da sala (roomsState guarda hostName,
// não o id) — uma consulta por resposta de convite, o que é nada:
// isto roda no ritmo de alguém clicar num botão.
//
// Falhar aqui não pode derrubar a resposta do convidado: o aviso é
// uma conveniência pro host, e o que importa (entrar na sala ou não)
// já aconteceu. Por isso tudo dentro de try/catch e sem propagar.
async function notifyInviteResult(roomName, userId, userName, result) {
  const room = roomsState.get(roomName);
  if (!room?.hostName) return;

  try {
    const host = await usersDb.findByUsername(room.hostName);
    if (!host) return;
    presence.sendToUser(host.id, {
      type: "inviteResult",
      roomName,
      userId,
      userName,
      result,
    });
  } catch (err) {
    console.error(`Erro ao avisar o host sobre o convite de ${userName}:`, err);
  }
}

// POST /rooms/:roomName/invite/decline — o convidado recusa, ou o
// tempo do convite acabou no app dele (2026-09-14).
//
// Recusar não cria nem apaga permissão nenhuma: quem não aceitou
// nunca entrou na lista. O que esta rota faz é (1) consumir o convite
// pendente, pra um "sim" atrasado não valer depois de um "não", e
// (2) avisar o host.
//
// Responde 204 mesmo sem convite pendente — de propósito. O app manda
// isto de dois caminhos (o botão e o timer de 30s), e uma corrida
// entre eles não é erro nenhum: o resultado final é o mesmo.
app.post("/rooms/:roomName/invite/decline", requireAuth, async (req, res) => {
  const { roomName } = req.params;
  const { reason } = req.body ?? {};

  // "expired" é o timer do app do convidado; qualquer outra coisa é
  // recusa explícita. O host vê textos diferentes pros dois: "recusou"
  // e "não respondeu" dizem coisas bem diferentes sobre a pessoa.
  const result = reason === "expired" ? "expired" : "declined";

  presence.consumeInvite(roomName, req.userId);
  await notifyInviteResult(roomName, req.userId, req.username, result);

  res.status(204).send();
});

// POST /rooms/:roomName/invite/accept — o convidado aceita. A partir
// daqui a sala passa a aparecer na lista DELE (o broadcast filtra por
// essa lista de permissão) e o /token deixa ele entrar.
//
// EXIGE um convite pendente de verdade. Sem essa checagem, qualquer
// usuário autenticado que soubesse o código de uma sala privada se
// auto-liberava chamando esta rota direto — e com 6 dígitos dava pra
// varrer. O convite é consumido aqui: daqui em diante quem autoriza é a
// lista de permissão.
app.post("/rooms/:roomName/invite/accept", requireAuth, async (req, res) => {
  const { roomName } = req.params;
  if (!roomsState.has(roomName)) {
    return res.status(404).json({ error: "Esta transmissão já terminou." });
  }

  if (!presence.consumeInvite(roomName, req.userId)) {
    return res.status(403).json({ error: "Você não foi convidado para esta transmissão." });
  }

  presence.allowInRoom(roomName, req.userId);
  broadcastRooms();
  await notifyInviteResult(roomName, req.userId, req.username, "accepted");
  res.status(204).send();
});

// POST /rooms/:roomName/kick { username } — o host tira alguem da
// propria live (2026-09-13, pedido do usuario).
//
// Recebe o NOME e nao o id porque e o nome que o app tem em maos: a
// lista de viewers de uma sala (roomsState.participants) e uma lista de
// identities do LiveKit, que aqui sao os nomes de usuario. O id sai da
// busca no banco logo abaixo, porque a lista de permissao e por id.
//
// A ORDEM das tres etapas importa:
//
//   1. Sai da lista de permissao ANTES de ser desconectado. Se fosse
//      depois, existiria uma janela em que a pessoa ja caiu mas o
//      /token ainda a autorizaria a voltar.
//   2. E removida do LiveKit (removeParticipant) — e aqui que a
//      transmissao dela corta de verdade.
//   3. broadcastRooms() — e isto que faz a sala PRIVADA sumir da lista
//      dela, ja que o broadcast filtra pela lista de permissao.
//
// Numa sala PUBLICA o expulso pode entrar de novo pela lista: nao
// existe "banir" aqui, e a rota nao finge que existe. Numa privada,
// sim — sair da lista de permissao e definitivo ate um novo convite.
app.post("/rooms/:roomName/kick", requireAuth, async (req, res) => {
  const { roomName } = req.params;
  const { username } = req.body ?? {};

  if (typeof username !== "string" || !username) {
    return res.status(400).json({ error: "username obrigatório" });
  }

  const room = roomsState.get(roomName);
  if (!room) return res.status(404).json({ error: "Sala não encontrada" });

  // Só o host expulsa. Mesma checagem da rota de convite logo acima.
  if (room.hostName !== req.username) {
    return res.status(403).json({ error: "Só o host pode expulsar." });
  }

  // O host expulsando a si mesmo derrubaria a própria transmissão por
  // um caminho que não limpa o ingress nem o roomsState.
  if (username === room.hostName) {
    return res.status(400).json({ error: "O host não pode se expulsar." });
  }

  try {
    const target = await usersDb.findByUsername(username);

    // Sem usuário no banco ainda assim vale remover do LiveKit: a
    // identity é o que corta a conexão, e o id só serve pra lista de
    // permissão. Não achar o id não é motivo pra deixar a pessoa
    // assistindo.
    if (target) presence.disallowInRoom(roomName, target.id);

    // SEM opções, de propósito.
    //
    // O `revokeTokenTs` (invalidar os tokens já emitidos, pra pessoa não
    // reconectar sozinha com o que ela tem em mãos) é justamente o que
    // esta chamada precisa — mas o proto diz que ele já vem preenchido:
    // "defaults to now(server)+leeway(1min) if left empty". Passar um
    // valor aqui só traria risco: o campo é um timestamp UNIX em
    // SEGUNDOS (é comparado com o `nbf` do JWT), e mandar `Date.now()`,
    // que é em MILISSEGUNDOS, daria um instante ~50 mil anos no futuro —
    // nenhum token futuro dessa pessoa nesta sala voltaria a valer, e um
    // chute numa sala pública viraria banimento permanente sem ninguém
    // ter pedido isso.
    await roomService.removeParticipant(roomName, username);

    broadcastRooms();
    console.log(`[rooms] ${req.username} expulsou ${username} da sala ${roomName}`);
    res.status(204).send();
  } catch (err) {
    console.error(`Erro ao expulsar ${username} da sala ${roomName}:`, err);
    res.status(500).json({ error: "Não foi possível expulsar este usuário." });
  }
});

// Chat temporario da live (2026-09-23) — ver chat.js pro desenho
// inteiro (por que HTTP+WebSocket e nao data channel do LiveKit) e pra
// nota de que tudo aqui e aditivo: o app publicado hoje ignora os
// `type`s novos do WebSocket.
setupChatRoutes({
  app,
  requireAuth,
  chatSendRateLimit: rateLimit.chatSend,
  presence,
  usersDb,
  roomsState,
  canSeeRoom,
});

app.get("/token", requireAuth, async (req, res) => {
  const { roomName, participantName, role, hidden } = req.query;

  if (!roomName || !participantName || !role) {
    return res.status(400).json({
      error: "Parâmetros obrigatórios: roomName, participantName, role (host|viewer)",
    });
  }

  const isHost = role === "host";

  // Duas checagens, e as duas são AQUI e não no cliente de propósito:
  // é este endpoint que emite o token do LiveKit, então sem passar por
  // ele não há como conectar na sala.
  if (!isHost) {
    const room = roomsState.get(roomName);

    // 1) A SALA PRECISA EXISTIR.
    //
    // BUG REAL corrigido em 2026-09-13: entrar por código com um código
    // inventado CRIAVA uma sala. A checagem antiga era
    // `room?.private && ...` — com a sala inexistente, `room` é
    // `undefined`, o `?.` devolve `undefined`, a condição é falsa e o
    // token saía normalmente. O cliente conectava com um token válido e
    // o `auto_create` do LiveKit materializava a sala: nascia uma live
    // fantasma, sem host e sem ninguém publicando, que aparecia na lista
    // de todo mundo como "Live de ???".
    //
    // É o mesmo `auto_create` que já tinha mordido em 2026-09-06 (ver
    // HOSTLESS_NEW_ROOM_GRACE_MS). Lá o conserto foi limpar a sala
    // fantasma depois; aqui é não deixar ela nascer.
    //
    // A exceção da allow-list cobre UM caso legítimo: o preview do
    // próprio host (useHostPreview.ts) conecta como `viewer` na sala
    // dele mesmo, e pode chegar aqui antes do webhook `room_started`
    // propagar. O host entra na allow-list no POST /ingress, então ele
    // passa; um estranho com um código chutado, não.
    if (!room && !presence.isAllowedInRoom(roomName, req.userId)) {
      return res
        .status(404)
        .json({ error: "Sala não encontrada. Confira o código e tente de novo." });
    }

    // 2) SALA PRIVADA: só entra quem está na lista de permissão — o host
    // e quem aceitou um convite. Isso é o que torna o código de 6
    // dígitos inofensivo numa sala privada: adivinhar o código não
    // basta, e são só 900 mil combinações.
    if (room?.private && !presence.isAllowedInRoom(roomName, req.userId)) {
      return res.status(403).json({ error: "Esta transmissão é privada." });
    }
  }

  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: participantName,
    // 2026-09-29 — antes era o padrão do SDK (6h). Ver LIVEKIT_TOKEN_TTL.
    ttl: LIVEKIT_TOKEN_TTL,
  });

  at.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: isHost, // só o host pode publicar vídeo/áudio
    canSubscribe: true, // todo mundo pode assistir
    hidden: hidden === "true",
  });

  const token = await at.toJwt();

  res.json({ token });
});

// DELETE /rooms/:roomName — chamado quando o host para a transmissão de
// propósito (ver roadmap item 14): derruba a sala no LiveKit Server, o
// que desconecta forçadamente qualquer viewer ainda presente nela (o
// evento RoomEvent.Disconnected do livekit-client deles dispara com
// reason=ROOM_DELETED — é isso que faz o app do viewer voltar sozinho
// pro estado "padrão", ver useViewer.ts). Sem isso, a sala ficaria viva
// enquanto tivesse qualquer participante (o empty_timeout automático do
// LiveKit só conta quando TODOS saem, não só o host).
//
// deleteRoom numa sala que não existe mais não é um erro de verdade
// (idempotente do ponto de vista do host parando a live) — por isso
// sempre responde ok, só loga se der outro tipo de erro.
// Tira a sala do NOSSO estado e avisa todo mundo.
//
// Extraído em 2026-09-18 porque passou a ter dois chamadores. Antes só o
// webhook `room_finished` limpava — e isso bastava enquanto o LiveKit
// sempre conseguia derrubar a sala. Quando ele NÃO consegue (ver o
// DELETE abaixo), o webhook nunca chega, e a live ficava de fantasma na
// lista de todo mundo até o servidor reiniciar.
function cleanupFinishedRoom(roomName) {
  // A demolição agendada não tem mais o que demolir.
  cancelPendingHostlessRoomTeardown(roomName);
  // Idem pro aviso de reconexão: a sala acabou, ninguém vai voltar pra ela.
  reconnectNotices.delete(roomName);
  // Limpa o "privada" e o jogo pendentes órfãos, se sobrou algum (ex:
  // ingress criado mas o GStreamer nunca chegou a publicar).
  pendingRoomPrivate.delete(roomName);
  pendingRoomGame.delete(roomName);
  // Convites morrem com a sala. Sem isso o Map cresceria pra sempre, e um
  // código reaproveitado (são só 6 dígitos) herdaria a lista de
  // convidados da live anterior.
  presence.forgetRoom(roomName);
  // sid e dono morrem junto com a sala (2026-09-29). O sid porque ele
  // identifica UMA encarnação e a próxima terá outro; o dono porque o
  // código tem só 6 dígitos e é reaproveitado — herdar o dono da live
  // anterior deixaria um estranho encerrando a sala de outra pessoa.
  roomInternals.delete(roomName);
  roomsState.delete(roomName);
  broadcastRooms();
}

app.delete("/rooms/:roomName", requireAuth, async (req, res) => {
  const roomName = req.params.roomName;

  // SÓ O DONO DERRUBA A SALA (2026-09-29).
  //
  // Esta rota só exigia estar logado. Como o código da sala tem 6
  // dígitos e aparece na lista pra todo mundo, qualquer conta encerrava
  // a live de qualquer outra pessoa. O `/kick` confere o dono desde
  // 2026-09-13; os DELETE não conferiam — e são justamente eles que
  // acabam com a transmissão.
  //
  // A checagem NÃO pode ser `room.hostName !== req.username`, que é o
  // que o `/kick` faz. Quando o host clica em "parar", o app mata o
  // GStreamer ANTES de chamar esta rota, então o `participant_left` do
  // publisher já zerou o `hostName` — e o dono levaria 403 ao parar a
  // PRÓPRIA live. Por isso existe o `roomInternals`: ele guarda quem
  // pediu o /ingress, e não muda quando o publisher sai.
  const isOwner = roomOwnerCheck(roomName, req);
  if (isOwner === false) {
    console.warn(
      `[rooms] ${req.username} tentou derrubar a sala ${roomName}, que não é dele — recusado`,
    );
    return res
      .status(403)
      .json({ ok: false, error: "Só quem iniciou a transmissão pode encerrá-la." });
  }
  if (isOwner === null) {
    // Dono desconhecido — ver `roomOwnerCheck` pra por que isto PASSA
    // em vez de recusar. Fica no log porque, se começar a aparecer com
    // frequência, é sinal de que algum caminho deixou de gravar o dono.
    console.warn(
      `[rooms] DELETE da sala ${roomName} por ${req.username}: dono desconhecido — permitindo`,
    );
  }

  // 2026-08-31: voltou a reportar o resultado REAL (não é mais sempre
  // ok:true) — o Electron agora tenta de novo até confirmar que a sala
  // caiu de verdade (ver useGstreamerTransmission.ts, stop()), então
  // precisa saber quando realmente falhou. deleteRoom lançando erro nem
  // sempre é falha de verdade (pode ser "a sala já não existe", que já
  // era o objetivo) — por isso confere direto no LiveKit antes de
  // reportar erro pro cliente.
  try {
    await roomService.deleteRoom(roomName);
    console.log(`[rooms] sala ${roomName} derrubada com sucesso no LiveKit`);
    cleanupFinishedRoom(roomName);
    return res.json({ ok: true });
  } catch (err) {
    console.error(`[rooms] deleteRoom(${roomName}) lançou erro, conferindo se a sala já sumiu:`, err);
  }

  try {
    const found = (await roomService.listRooms([roomName]))[0];
    if (!found) {
      console.log(`[rooms] sala ${roomName} já não existia mais (ok)`);
      cleanupFinishedRoom(roomName);
      return res.json({ ok: true });
    }

    // SALA ÓRFÃ (2026-09-18) — o caso que trouxe este bloco à existência.
    //
    // Sintoma real: `DeleteRoom` falhando com "could not find object" e,
    // logo em seguida, `ListRooms` DEVOLVENDO a sala. Parece contradição,
    // mas não é: o registro da sala continua no Redis enquanto o nó que a
    // hospedava sumiu, então o LiveKit acha a linha e não acha pra quem
    // mandar o comando. Nesse estado o DeleteRoom nunca vai passar.
    //
    // Com a sala VAZIA, o objetivo de quem parou a live já está cumprido:
    // ninguém está assistindo, e o próprio LiveKit recolhe o registro
    // pelo `empty_timeout` (5 min, o padrão — não há seção `room:` no
    // livekit.yaml). Insistir em erro aqui deixava o app tentando parar a
    // transmissão pra sempre, contra um registro que nada consegue
    // apagar.
    //
    // Com gente dentro, é outra história: aí é falha de verdade e o
    // cliente precisa saber.
    const participants = Number(found.numParticipants ?? 0);
    if (participants === 0) {
      console.warn(
        `[rooms] sala ${roomName} ficou ÓRFÃ no LiveKit (sid=${found.sid ?? "?"}, 0 participantes) — ` +
          "tratando como encerrada; o empty_timeout do LiveKit recolhe o registro",
      );
      cleanupFinishedRoom(roomName);
      return res.json({ ok: true, orphaned: true });
    }

    console.error(
      `[rooms] sala ${roomName} AINDA EXISTE no LiveKit depois da falha ` +
        `(sid=${found.sid ?? "?"}, ${participants} participante(s))`,
    );
    return res.status(500).json({ ok: false, error: "Não foi possível derrubar a sala." });
  } catch (verifyErr) {
    console.error(`[rooms] falha ao verificar se a sala ${roomName} ainda existe:`, verifyErr);
    return res
      .status(500)
      .json({ ok: false, error: "Não foi possível confirmar se a sala foi derrubada." });
  }
});

// POST /ingress { roomName, participantName } — cria um endpoint WHIP pro
// host publicar via GStreamer usando o encoder de hardware da GPU, em vez
// do encode por software/limitado do getDisplayMedia do Chromium. Devolve
// { url, streamKey } que o Electron passa direto pro GStreamer
// (whip-endpoint / auth-token do elemento whipsink).
app.post("/ingress", requireAuth, async (req, res) => {
  const { roomName, participantName, private: isPrivate, game } = req.body ?? {};

  if (!roomName || !participantName) {
    return res.status(400).json({
      error: "Parâmetros obrigatórios: roomName, participantName",
    });
  }

  // O jogo/janela que o host já conhece da fonte escolhida (2026-09-30,
  // ver pendingRoomGame). Opcional: sem ele a sala nasce sem nada e a
  // informação chega pelo POST /rooms/:roomName/game de sempre, como
  // antes. Mesma validação daquela rota, de propósito — ver
  // parseGameReport.
  const parsedGame = parseGameReport(game);
  if (parsedGame.error) {
    return res.status(parsedGame.status).json({ error: parsedGame.error });
  }

  try {
    // ⚠️ A ORDEM DESTE BLOCO IMPORTA (2026-09-29).
    //
    // Antes desta data a sala só passava a existir quando o GStreamer
    // começava a publicar de verdade, segundos depois desta rota
    // responder — havia tempo de sobra pra gravar o resto. Agora é o
    // `ensureRoom` logo abaixo que cria a sala, e o webhook
    // `room_started` volta quase junto com ele: gravar a privacidade ou
    // a permissão do dono DEPOIS disso seria gravar tarde demais — uma
    // live privada nasceria pública, e o dono não veria a própria sala
    // no primeiro broadcast.
    //
    // Por isso tudo que o `room_started` consulta vem primeiro, e a
    // criação da sala é o último passo antes do ingress.

    // Checkbox "Transmissão privada" da tela de iniciar live
    // (2026-09-10, substituiu a senha de sala). Fica pendente até o
    // "room_started" chegar e transferir pro roomsState — a sala em si
    // ainda não existe neste ponto.
    if (isPrivate) {
      pendingRoomPrivate.set(roomName, true);
    } else {
      pendingRoomPrivate.delete(roomName);
    }

    // Idem pro jogo/janela. O `delete` no ramo vazio importa tanto
    // quanto o `set`: o código de sala tem 6 dígitos e é reaproveitado,
    // então um pendente órfão de uma live anterior viraria o "jogo" desta.
    if (parsedGame.game) {
      pendingRoomGame.set(roomName, parsedGame.game);
    } else {
      pendingRoomGame.delete(roomName);
    }

    // BUG REAL corrigido em 2026-09-13: o HOST nunca entrava na
    // allow-list da própria sala. O comentário do GET /token já dizia
    // que a lista contém "o host e quem aceitou um convite", mas
    // ninguém nunca o colocava lá — o /token não percebia porque pula a
    // checagem inteira quando `role === "host"`.
    //
    // Quem percebia era o `canSeeRoom`, que NÃO tem essa exceção: numa
    // live privada ele respondia "não pode ver" pro próprio dono. Com
    // isso a sala do host sumia do broadcast pra ele mesmo, e no app
    // `rooms.find(r => r.name === roomCode)` vinha `undefined` — daí o
    // timer da live parado (sem `startedAt`), a lista de espectadores
    // vazia e a sobreposição sem ninguém.
    //
    // Aqui é o único ponto do fluxo que sabe QUEM é o host (`req.userId`,
    // autenticado): o webhook `room_started` recebe só o nome da sala.
    // Incondicional, e não só quando `isPrivate`: "o dono pode ver a
    // própria sala" vale sempre, e numa sala pública o `canSeeRoom` nem
    // consulta a lista.
    presence.allowInRoom(roomName, req.userId);

    // Quem é o DONO desta live (2026-09-29). Mesmo motivo da linha
    // acima: este é o único ponto do fluxo que sabe o `req.userId` do
    // host. É o que as rotas DELETE conferem pra recusar alguém
    // encerrando a transmissão dos outros — e o que continua valendo
    // depois de o `hostName` zerar numa troca de fonte.
    setRoomOwner(roomName, req.userId, participantName);

    // A SALA EM SI. Ver o comentário do `ensureRoom` pro porquê de este
    // servidor ter passado a criar a sala em vez de deixar o
    // `auto_create` do LiveKit fazer isso sozinho no primeiro cliente
    // que conectar.
    //
    // O metadata já vai preenchido aqui, e não só no `syncRoomMetadata`
    // depois, porque o `private` precisa estar gravado na sala desde o
    // primeiro instante: é ele que sobrevive a um restart deste
    // processo, e entre criar a sala e o primeiro sync existe uma janela
    // em que uma live privada voltaria como pública.
    await ensureRoom(roomName, isPrivate ? JSON.stringify({ private: true }) : undefined);

    const ingress = await ingressClient.createIngress(IngressInput.WHIP_INPUT, {
      name: roomName,
      roomName,
      participantIdentity: participantName,
      participantName,
      // WHIP já chega pronto (H264 do encoder de hardware) — sem isso o
      // LiveKit recodificaria de novo no servidor à toa.
      enableTranscoding: false,
    });

    ingressIdByRoom.set(roomName, ingress.ingressId);

    res.json({ url: ingress.url, streamKey: ingress.streamKey });
  } catch (err) {
    console.error("Erro ao criar ingress:", err);
    // Não deixa rastro de uma live que não chegou a existir (2026-09-29).
    //
    // O código de sala tem 6 dígitos e é reaproveitado. Um dono ou uma
    // marca de "privada" órfãos aqui passariam pra PRÓXIMA live que
    // calhasse do mesmo código — e se fosse de outra pessoa, ela levaria
    // 403 ao tentar encerrar a própria transmissão, sem saída nenhuma
    // pela interface.
    //
    // Só quando a sala não chegou a nascer: se o `ensureRoom` passou e
    // quem falhou foi o ingress, a sala existe e quem limpa é o
    // `cleanupFinishedRoom` quando o LiveKit a recolher.
    if (!roomsState.has(roomName)) {
      pendingRoomPrivate.delete(roomName);
      pendingRoomGame.delete(roomName);
      roomInternals.delete(roomName);
    }
    res.status(500).json({ error: "Não foi possível criar o ingress." });
  }
});

// DELETE /ingress/:roomName — mesmo padrão idempotente do
// DELETE /rooms/:roomName acima: sem ingress registrado pra essa sala não
// é erro (idempotente do ponto de vista do host parando a live).
app.delete("/ingress/:roomName", requireAuth, async (req, res) => {
  const roomName = req.params.roomName;

  // Mesma checagem de dono do DELETE /rooms logo acima, e pelo mesmo
  // motivo (2026-09-29): remover o ingress alheio interrompe a
  // publicação de uma live que não é sua. As duas rotas andam juntas no
  // `teardownRoom` do app, então proteger só uma não protegeria nada.
  const isOwner = roomOwnerCheck(roomName, req);
  if (isOwner === false) {
    console.warn(
      `[ingress] ${req.username} tentou remover o ingress da sala ${roomName}, ` +
        "que não é dele — recusado",
    );
    return res
      .status(403)
      .json({ ok: false, error: "Só quem iniciou a transmissão pode encerrá-la." });
  }
  if (isOwner === null) {
    console.warn(
      `[ingress] DELETE da sala ${roomName} por ${req.username}: dono desconhecido — permitindo`,
    );
  }

  const ingressId = ingressIdByRoom.get(roomName);
  if (!ingressId) {
    console.log(`[ingress] DELETE pra sala ${roomName} sem ingress registrado (no-op)`);
    return res.json({ ok: true });
  }

  // 2026-08-31: mesmo motivo do DELETE /rooms acima — reporta o
  // resultado real pro cliente poder tentar de novo.
  try {
    await ingressClient.deleteIngress(ingressId);
    ingressIdByRoom.delete(roomName);
    console.log(`[ingress] ingress ${ingressId} (sala ${roomName}) removido com sucesso`);
    return res.json({ ok: true });
  } catch (err) {
    // 404 "ingress does not exist" NÃO é falha (2026-09-18): o objetivo
    // de quem está parando a live é não haver mais ingress, e não haver
    // mais ingress é exatamente o que essa resposta diz.
    //
    // Isto acontece de verdade — o ingress some sozinho quando o
    // GStreamer para de publicar, e aí o DELETE chega depois. Devolvendo
    // 500, o app ficava tentando remover pra sempre algo que já não
    // existia, e o log enchia de erro que não era erro.
    //
    // Tirar do mapa junto importa: sem isso o id morto ficaria lá, e uma
    // próxima live no mesmo código de sala tentaria removê-lo de novo.
    if (err?.status === 404 || err?.code === "not_found") {
      ingressIdByRoom.delete(roomName);
      console.log(
        `[ingress] ingress ${ingressId} (sala ${roomName}) já não existia (ok)`,
      );
      return res.json({ ok: true });
    }

    console.error(`[ingress] FALHA ao remover ingress ${ingressId} (sala ${roomName}):`, err);
    return res.status(500).json({ ok: false, error: "Não foi possível remover o ingress." });
  }
});

// GET /rooms — snapshot sob demanda da mesma lista que o WebSocket
// /ws/rooms transmite em tempo real (item novo, 2026-08-31: botão
// "atualizar lista" no Electron, ver src/main/rooms.ts). De propósito
// como um endpoint HTTP separado, não reaproveitando a conexão
// WebSocket — o pedido explícito era um jeito de atualizar que NÃO
// dependa da saúde da conexão em tempo real (que é justamente o que
// pode estar com problema quando o usuário aperta esse botão).
// GET /rooms — o botão "atualizar lista de salas" do app. Caminho HTTP
// paralelo ao broadcast em tempo real, pra funcionar mesmo se o
// WebSocket estiver com problema (ver useRooms.ts no Electron).
//
// BUG REAL corrigido em 2026-09-13: ele devolvia `roomsState` INTEIRO,
// sem passar pelo `canSeeRoom`. O broadcast filtrava, este não — então
// bastava alguém apertar "atualizar" pra ver toda sala privada do
// servidor, convidado ou não. O botão contornava a privacidade inteira.
//
// A regra de visibilidade vive num lugar só (`roomsVisibleTo`) e os
// DOIS caminhos chamam ela agora. Rota nova que devolva sala tem que
// usar a mesma função — montar a lista à mão é como este bug nasceu.
//
// O `presence` também faltava: o cliente faz `setPresence(snapshot.presence ?? {})`,
// então cada refresh zerava o mapa e todo mundo aparecia offline na
// lista de usuários até o próximo push do WebSocket.
app.get("/rooms", requireAuth, (req, res) => {
  res.json({
    rooms: roomsVisibleTo(req.userId),
    userAvatars: buildUserAvatarsDirectory(),
    presence: presenceSnapshot(),
  });
});

// POST /rooms/:roomName/game { kind, name } — reporta pro token-server o
// jogo/janela que o host está transmitindo agora (roadmap item 29). `kind`
// é "game" (detectado via Steam ou via processo/lista do Discord) ou
// "window" (transmissão de janela específica, usa o próprio título).
// `name: null` (ou omitido) limpa a info — jogo fechado, nenhum match
// achado no polling, ou host trocou pra uma fonte sem detecção. Propaga
// pra todo mundo (host incluso, via GET /rooms/lista de salas) através do
// mesmo broadcastRooms() de sempre.
//
// Responde ok:false (404) quando a sala ainda não existe em roomsState —
// de propósito NÃO idempotente como as rotas DELETE acima: pode ser uma
// corrida real com o webhook room_started, e o Electron tenta de novo
// nesse caso (ver gameDetection.ts), então precisa saber que não colou
// ainda.
//
// Essa corrida ENCOLHEU duas vezes. Em 2026-09-29 a sala passou a nascer
// no POST /ingress em vez de no primeiro frame do WHIP, então quando o
// app reporta o jogo ela quase sempre já existe. E em 2026-09-30 o
// próprio /ingress passou a levar o jogo junto (ver pendingRoomGame), o
// que dispensa a primeira chamada no caso que mais importava — o modo
// JANELA, onde a detecção já responde certo de primeira.
// O app vai reiniciar o pipeline desta sala — segura a demolição
// (2026-09-20). Ver HOSTLESS_RECONNECT_GRACE_MS lá em cima pro bug que
// isto conserta.
//
// Os dois lados da corrida, porque os dois acontecem de verdade:
//
//   - aviso ANTES do publisher sair (troca de fonte pelo modal: o app
//     avisa e só então mata o processo) — fica guardado no
//     `reconnectNotices` e o `participant_left` o consome;
//   - aviso DEPOIS (a janela do jogo fechou e levou o pipeline junto: o
//     app só descobre a morte quando ela já aconteceu, e ainda gasta uma
//     enumeração de janelas antes de avisar) — aí já existe uma
//     demolição de 3s correndo, e este handler a reagenda com o prazo
//     longo.
//
// Só exige estar autenticado, como o /game logo abaixo: o pior que um
// aviso indevido faz é uma sala de outra pessoa demorar 25s em vez de 3s
// pra cair quando o host dela sumir — não dá acesso a nada.
app.post("/rooms/:roomName/reconnecting", requireAuth, (req, res) => {
  const roomName = req.params.roomName;
  if (!roomsState.has(roomName)) {
    return res.status(404).json({ ok: false, error: "sala não encontrada" });
  }

  const pending = pendingHostlessRoomTimers.has(roomName);
  if (pending) {
    // Chegou atrasado: o publisher já saiu e a sala está a caminho da
    // demolição. Reagenda com o prazo longo em vez de guardar um aviso
    // que ninguém mais vai consumir.
    scheduleHostlessRoomTeardown(roomName, HOSTLESS_RECONNECT_GRACE_MS);
  } else {
    reconnectNotices.set(roomName, Date.now() + RECONNECT_NOTICE_TTL_MS);
  }
  // E GARANTE QUE A SALA VAI EXISTIR quando o pipeline novo chegar
  // (2026-09-29).
  //
  // Isto é a contrapartida do `auto_create: false`. Numa live sem viewer
  // nenhum, o publisher saindo deixa a sala vazia, e sala vazia é
  // recolhida pelo `departureTimeout` (20s) — antes o WHIP do GStreamer
  // novo simplesmente a recriava ao conectar (era a "live que voltava
  // sozinha"), e agora ele não consegue mais. Sem esta linha, uma troca
  // de fonte demorada deixaria de derrubar só os viewers pra derrubar a
  // live inteira.
  //
  // E VOLTA SABENDO O QUE ELA ERA (2026-09-30).
  //
  // BUG: isto criava a sala SEM metadata nenhum. Numa recriação de
  // verdade — a sala já tinha sido recolhida quando este pedido chegou —
  // ela renascia pública, porque o `room_started` lê a privacidade do
  // metadata e o `pendingRoomPrivate` do /ingress já foi consumido há
  // muito tempo. Uma live privada virava pública no meio dela, sem nada
  // na tela dizendo isso.
  //
  // O `roomsState` ainda tem a sala aqui (o 404 lá em cima garante), e é
  // dele que sai o metadata — o mesmo objeto que o `syncRoomMetadata`
  // grava, pra que os dois caminhos não divirjam.
  //
  // Quando a sala NÃO foi recolhida, isto não muda nada: o `createRoom`
  // do LiveKit devolve a sala existente como está, sem aplicar
  // parâmetro nenhum.
  //
  // Sem `await`: este handler está no caminho crítico de uma live
  // parada, e o pipeline novo ainda vai levar segundos pra negociar o
  // WHIP. Idempotente, então chamar à toa não custa nada.
  const knownMetadata = roomMetadataPayload(roomsState.get(roomName));
  ensureRoom(
    roomName,
    Object.keys(knownMetadata).length > 0 ? JSON.stringify(knownMetadata) : undefined,
  ).catch((err) =>
    console.error(`[rooms] falha ao garantir a sala ${roomName} durante a reconexão:`, err),
  );

  console.log(
    `[rooms] sala ${roomName}: reconexão anunciada (${pending ? "publisher já saiu" : "publisher ainda na sala"})`,
  );

  res.json({ ok: true });
});

app.post("/rooms/:roomName/game", requireAuth, (req, res) => {
  const roomName = req.params.roomName;
  // A validação mora no parseGameReport (lá em cima) desde 2026-09-30 —
  // o POST /ingress aceita exatamente o mesmo objeto, e um campo
  // validado num lugar só é um campo não validado no outro.
  const parsed = parseGameReport(req.body);
  if (parsed.error) {
    return res.status(parsed.status).json({ error: parsed.error });
  }

  const prev = roomsState.get(roomName);
  if (!prev) {
    return res.status(404).json({ ok: false, error: "sala não encontrada" });
  }

  const game = parsed.game;

  // O BROADCAST SÓ SAI QUANDO ALGO MUDA (2026-09-30).
  //
  // O app reafirma o valor atual de tempos em tempos mesmo sem mudança
  // nenhuma (o heartbeat do gameDetection.ts dele, pro caso de ESTE
  // servidor ter esquecido). Quando ele não esqueceu, o que sobrava era
  // um pacote de salas pra CADA usuário conectado dizendo exatamente o
  // que todos já sabiam — uma vez por minuto, por live no ar.
  //
  // O caminho que o heartbeat existe pra cobrir continua intacto: se o
  // servidor esqueceu, o valor é diferente e isto roda.
  if (!sameGameReport(prev.game, game)) {
    roomsState.set(roomName, { ...prev, game });
    broadcastRooms();
  }

  // E grava no metadata da sala, pra que isto sobreviva a um restart
  // deste processo (2026-09-21 — ver syncRoomMetadata). Sem await, pelo
  // mesmo motivo de sempre: o host já pode receber o `ok`, o estado que
  // vale agora está no roomsState, e uma chamada de rede ao LiveKit não
  // tem por que atrasar a resposta.
  //
  // ESTE roda mesmo quando nada mudou, ao contrário do broadcast acima
  // (2026-09-30). São dois esquecimentos diferentes: o broadcast repara
  // o que os CLIENTES sabem, e eles não esquecem sozinhos; o metadata
  // repara o que o LIVEKIT guarda, que é o que sobrevive a um restart
  // deste processo — e uma escrita que falhou lá em cima não tem outro
  // jeito de ser refeita. É uma chamada por minuto, por live no ar.
  syncRoomMetadata(roomName);

  res.json({ ok: true });
});

// --- Lista de jogos detectáveis (Discord) — cache/proxy ---------------------
// Roadmap item 29 (Electron): pra identificar jogos NÃO-Steam, o app
// compara o nome do processo rodando contra a mesma lista pública que o
// próprio cliente do Discord usa (endpoint não-oficial, mas é o mesmo que
// eles expõem pro cliente deles — sem autenticação). Como é grande (~MBs,
// milhares de entradas) e muda com frequência, o prisma_server busca e
// cacheia aqui (memória + arquivo, sobrevive a um restart do container) em
// vez de cada instalação do Electron bater direto no Discord — se o
// formato da resposta deles mudar, conserta só aqui, sem precisar de
// update no app. Trimada pra só o que o Electron precisa antes de mandar
// pro cliente (nome + executáveis Windows em minúsculo + id/ícone),
// descartando o resto (aliases, publishers, overlay, temas etc.).
//
// Pedido do usuário (2026-09-05): `id` + `icon` (o `icon_hash` do
// Discord) entram no trim — o app monta a URL do CDN a partir deles
// (https://cdn.discordapp.com/app-icons/<id>/<icon>.png) pra mostrar a
// arte do jogo no footer. Só o par id+hash viaja, não a URL inteira:
// ~83% dos apps têm ícone e a URL montada seria ~60 bytes a mais POR
// JOGO.
//
// Pedido do usuário (2026-09-06): `steamIds` também. Descoberta que
// motivou isso: 13.789 dos 24.238 apps da lista (56,9%) NÃO têm
// executável Windows nenhum — o trim antigo descartava todos eles. Era o
// caso do Forza Horizon 6, que o app nunca conseguia identificar mesmo
// aparecendo no cliente do Discord. O Discord não usa só o nome do
// processo: os `third_party_skus` ligam o app a um appid da Steam / id da
// Microsoft Store, e é por aí que ele reconhece esses jogos.
//
// Guardando os appids da Steam, o app passa a identificar +8.495 jogos
// (99,9% deles COM arte) lendo o RunningAppID do registro da Steam (ver
// gameDetection.ts). Por isso o filtro deixou de ser "tem executável" e
// virou "tem executável OU tem appid da Steam".
//
// Só `distributor === "steam"` e só ids numéricos: existe uma entrada com
// `id: null` na lista que, sem esse filtro, agruparia 4 jogos diferentes
// (For Honor / Tanki Online / VVVVVV / Bloons TD) sob a mesma chave. Com
// o filtro, os 19.238 appids restantes são todos inequívocos.
//
// Custo: o payload vai de ~1,5 MB pra ~2,8 MB (+81%). O app baixa isso
// uma vez a cada 3 dias, então é troca aceitável por quase dobrar a
// cobertura de detecção.
const DISCORD_GAMES_CACHE_FILE = path.join(__dirname, "data", "discordGamesCache.json");
const DISCORD_DETECTABLE_URL = "https://discord.com/api/v9/applications/detectable";

let discordGamesCache = { fetchedAt: 0, games: [] };

function loadDiscordGamesCacheFromDisk() {
  try {
    discordGamesCache = JSON.parse(fs.readFileSync(DISCORD_GAMES_CACHE_FILE, "utf-8"));
  } catch {
    // Sem cache em disco ainda (primeira vez rodando) — segue com lista
    // vazia até o primeiro refreshDiscordGamesCache() terminar.
  }
}

function saveDiscordGamesCacheToDisk() {
  try {
    const dir = path.dirname(DISCORD_GAMES_CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DISCORD_GAMES_CACHE_FILE, JSON.stringify(discordGamesCache));
  } catch (err) {
    console.error("Erro ao salvar cache da lista de jogos do Discord em disco:", err);
  }
}

async function refreshDiscordGamesCache() {
  try {
    const response = await fetch(DISCORD_DETECTABLE_URL);
    if (!response.ok) throw new Error(`status ${response.status}`);
    const raw = await response.json();

    const games = raw
      .map((entry) => {
        const executables = (entry.executables ?? [])
          .filter((exe) => exe?.os === "win32" && exe?.name)
          .map((exe) => exe.name.toLowerCase());

        // Ver o comentário grande acima pro porquê do filtro numérico.
        const steamIds = [
          ...new Set(
            (entry.third_party_skus ?? [])
              .filter((sku) => sku?.distributor === "steam" && /^[0-9]+$/.test(String(sku.id ?? "")))
              .map((sku) => String(sku.id)),
          ),
        ];

        // Sem nenhuma das duas formas de identificar, a entrada não serve
        // pra nada no app — é só peso no download.
        if (!executables.length && !steamIds.length) return null;

        const game = { name: entry.name };
        // Campos omitidos quando vazios (em vez de mandar [] ) — são
        // milhares de entradas, e um array vazio por jogo custa bytes à
        // toa num payload que já passou de 2 MB.
        if (executables.length) game.executables = executables;
        if (steamIds.length) game.steamIds = steamIds;
        // Nem todo app tem ícone (~17% não têm) — sem os DOIS campos não
        // dá pra montar a URL do CDN, então nesse caso nenhum dos dois
        // vai junto (o app cai no placeholder, ver gameDetectableCache.ts).
        if (entry.id && entry.icon_hash) {
          game.id = String(entry.id);
          game.icon = entry.icon_hash;
        }
        return game;
      })
      .filter(Boolean);

    discordGamesCache = { fetchedAt: Date.now(), games };
    saveDiscordGamesCacheToDisk();
    console.log(`[games] lista de jogos detectáveis do Discord atualizada: ${games.length} jogo(s)`);
  } catch (err) {
    console.error("Erro ao buscar lista de jogos detectáveis do Discord:", err);
  }
}

loadDiscordGamesCacheFromDisk();
refreshDiscordGamesCache();
// Refresca o cache do servidor 1x/dia — independente de quando cada
// instalação do Electron decide rebaixar o dela (ver ROADMAP.md item 29),
// isso aqui só mantém o cache do prisma_server em si sempre razoavelmente
// fresco.
setInterval(refreshDiscordGamesCache, 24 * 60 * 60 * 1000);

// GET /games/detectable — devolve a lista já cacheada/trimada. `fetchedAt`
// (epoch ms) deixa o Electron decidir, do lado dele, se ainda vale a pena
// usar o que já tem localmente antes de pedir de novo.
app.get("/games/detectable", requireAuth, (req, res) => {
  res.json(discordGamesCache);
});

// --- Auto-atualização do app -------------------------------------------
// version.json fica FORA do server.js de propósito (bind mount, ver
// docker-compose.yml). Desde 2026-09-10 a VERSÃO em si vive no banco
// (tabela app_version) e é publicada pelo PUT /version — só o .exe
// continua sendo arquivo, em downloads/.

// O .exe em si não é sensível (é o instalador público) — fica fora do
// requireAuth pra poder ser baixado direto com um GET simples, sem
// precisar implementar streaming autenticado.
// Rotas do painel de administração (2026-09-16) — ver admin.js.
//
// Montadas ANTES do /downloads estático por um motivo prático: o
// upload grava em downloads/.uploads/, e o `setupAdminRoutes` cria
// essa pasta no boot.
// Avisa todo mundo que uma versão nova do app foi publicada
// (2026-09-20, pedido do usuário).
//
// Vai pelo MESMO socket das salas porque ele já existe, já é
// autenticado e já fica aberto a sessão inteira — o app abre esse
// WebSocket logo depois do login e só fecha ao sair. Criar um canal
// novo (ou fazer o app perguntar de tempos em tempos) seria construir
// um caminho a mais pra uma informação que este aqui já entrega.
//
// A mensagem é só o AVISO, sem url nem sha256: quem responde "e isso é
// mais novo que a minha versão?" continua sendo o `GET /version`, que o
// app chama em seguida (ver src/main/rooms.ts e update.ts no Electron).
// Assim o formato da atualização mora num lugar só, e o botão de
// atualizar do app nunca aparece por um critério diferente do que o
// diálogo do login usa.
function broadcastAppVersion(version) {
  const payload = JSON.stringify({ type: "version", version });
  let sent = 0;
  presence.eachConnection((userId, ws) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(payload);
    sent++;
  });
  console.log(`[version] versão ${version} anunciada pra ${sent} conexão(ões)`);
}

setupAdminRoutes({
  app,
  requireAuth,
  requireAdmin,
  usersDb,
  appVersionDb,
  settingsDb,
  presence,
  invalidateTokenVersion,
  // Onde as fotos vivem. Passado, e não recalculado lá dentro, pra
  // existir UM caminho de avatares no servidor — dois `path.join` iguais
  // em arquivos diferentes é o começo de uma divergência silenciosa.
  avatarsDir: AVATARS_DIR,
  // Chamado quando o painel mexe na tabela de usuários de um jeito que o
  // resto do servidor precisa enxergar. Hoje é só a exclusão de conta: o
  // diretório nome -> avatar é cache em memória, e sem recarregar aqui a
  // conta apagada continuaria aparecendo na lista de salas até o próximo
  // restart.
  onUsersChanged: async () => {
    await refreshUserAvatars();
    broadcastRooms();
  },
  // Publicou uma versão nova: todo app aberto fica sabendo na hora, sem
  // precisar reiniciar nem relogar (ver broadcastAppVersion acima).
  onVersionPublished: broadcastAppVersion,
});

// ⚠️ `downloads/.uploads/` fica DENTRO da pasta servida aqui, mas o
// `express.static` ignora arquivos/pastas que começam com ponto
// (`dotfiles: "ignore"` é o padrão) — um upload em andamento não é
// baixável por ninguém.
app.use("/downloads", express.static(path.join(__dirname, "downloads")));

// GET /avatars/:id.webp e /avatars/:id.gif — fotos de avatar customizadas
// (roadmap item 43; o .gif desde 2026-10-19). O Content-Type sai da
// extensão, então o GIF já chega como image/gif sem configurar nada.
// Pública (sem requireAuth) pelo mesmo motivo de /downloads acima: uma
// tag <img src> não manda Authorization header (decisão confirmada com o
// usuário, 2026-09-01).
app.use("/avatars", express.static(AVATARS_DIR));

// GET /version — o app Electron consulta isso ao abrir (ver
// src/main/update.ts) pra saber se há uma versão mais nova disponível.
//
// Lê do banco desde 2026-09-10 (antes: version.json). O FORMATO DA
// RESPOSTA não mudou — `version`, `url` e `sha256` — porque todo app já
// instalado espera exatamente essas chaves.
app.get("/version", requireAuth, async (req, res) => {
  try {
    const info = await appVersionDb.get();
    if (!info) {
      return res.status(500).json({ error: "Não foi possível obter informações de versão." });
    }
    res.json({
      version: info.version,
      url: `/downloads/${info.installerFilename}`,
      sha256: info.sha256,
    });
  } catch (err) {
    console.error("Erro ao ler a versão publicada:", err);
    res.status(500).json({ error: "Não foi possível obter informações de versão." });
  }
});

// GET /version/public — mesma informação do GET acima, SEM autenticação,
// pra landing page (projeto prisma_webpage, em MY PROJECTS/react) montar
// o botão de download com o número da versão e o tamanho reais, em vez
// de um texto fixo que envelhece a cada release.
//
// Por que um endpoint separado em vez de tirar o requireAuth do de cima:
// aquele é o contrato do auto-update de TODO app já instalado, e mexer
// nele é mexer em software que já está na máquina de gente. Este aqui
// nasce livre pra crescer (tamanho, data) sem esse compromisso.
//
// Nada aqui é sigiloso: o .exe que ele descreve já é servido em
// /downloads sem autenticação nenhuma (ver o comentário lá em cima). O
// sha256 vai junto de propósito — é o que deixa alguém conferir que o
// arquivo baixado é o que a gente publicou.
app.get("/version/public", async (req, res) => {
  try {
    const info = await appVersionDb.get();
    if (!info) {
      return res.status(500).json({ error: "Não foi possível obter informações de versão." });
    }

    // Tamanho lido do arquivo na hora, e não guardado no banco: o .exe
    // é trocado por cópia direta em downloads/ (ver RELEASE.md passo
    // 10), sem passar por nenhum código nosso — um tamanho persistido
    // ficaria mentindo até alguém lembrar de atualizar.
    let sizeBytes = null;
    try {
      sizeBytes = fs.statSync(path.join(__dirname, "downloads", info.installerFilename)).size;
    } catch {
      // Instalador ainda não copiado pra downloads/. Não é erro: a
      // versão está publicada, o arquivo é que não chegou. A página
      // simplesmente não mostra o tamanho.
    }

    res.json({
      version: info.version,
      url: `/downloads/${info.installerFilename}`,
      filename: info.installerFilename,
      sha256: info.sha256,
      sizeBytes,
    });
  } catch (err) {
    console.error("Erro ao ler a versão pública:", err);
    res.status(500).json({ error: "Não foi possível obter informações de versão." });
  }
});

// GET /version/android/public — o mesmo, pro APK do app Android
// (2026-09-16). Público pela mesma razão: descreve um arquivo que já é
// servido em /downloads sem autenticação nenhuma.
//
// ⚠️ NÃO é contrato de auto-atualização. O app Flutter não consulta
// isto e não se atualiza sozinho — quem lê é a landing page, pra
// escrever a versão e o tamanho embaixo do botão. Por isso a informação
// vem de um arquivo (`downloads/android.json`) e não do banco; o
// cabeçalho do androidRelease.js explica a escolha.
//
// 404 quando nada foi publicado ainda, e isso é esperado: o site trata
// como "sem rótulo" e cai num link fixo, do mesmo jeito que faz quando
// o /version/public falha. O download nunca depende desta chamada.
app.get("/version/android/public", (req, res) => {
  try {
    const info = androidRelease.read();
    if (!info) {
      return res.status(404).json({ error: "Nenhuma versão Android publicada." });
    }
    res.json(info);
  } catch (err) {
    // Chega aqui com JSON malformado ou campo inválido — ou seja, erro
    // de quem publicou, não de quem pediu. Vale log alto: o sintoma no
    // site é discreto (some o rótulo da versão) e passaria despercebido.
    console.error("Erro ao ler a versão do Android:", err);
    res.status(500).json({ error: "Não foi possível obter informações de versão." });
  }
});

// PUT /version { version?, installerFilename?, sha256? } — publica uma
// versão nova. Quem vai usar é o painel web (item 4), que terá o próprio
// login e portanto o próprio JWT.
//
// ⚠️ Hoje QUALQUER usuário autenticado consegue chamar: ainda não existe
// noção de admin no banco. Amarrar isso a uma role é pré-requisito do
// item 4 — enquanto o painel não existe, o risco é teórico (só quem tem
// conta no app alcança), mas não pode ir pro ar junto com o painel.
app.put("/version", requireAuth, async (req, res) => {
  const { version, installerFilename, sha256 } = req.body ?? {};

  if (version === undefined && installerFilename === undefined && sha256 === undefined) {
    return res
      .status(400)
      .json({ error: "Informe ao menos um de: version, installerFilename, sha256" });
  }
  if (version !== undefined && (typeof version !== "string" || !version)) {
    return res.status(400).json({ error: "version deve ser string não vazia" });
  }
  if (
    installerFilename !== undefined &&
    (typeof installerFilename !== "string" || !installerFilename)
  ) {
    return res.status(400).json({ error: "installerFilename deve ser string não vazia" });
  }
  // Aceita vazio de propósito: entre compilar o instalador e assinar ele,
  // o SHA muda — dá pra publicar a versão antes e preencher o hash depois.
  if (sha256 !== undefined && (typeof sha256 !== "string" || !/^[0-9a-f]{0,64}$/i.test(sha256))) {
    return res.status(400).json({ error: "sha256 deve ser hexadecimal de até 64 caracteres" });
  }

  try {
    const info = await appVersionDb.set({ version, installerFilename, sha256 });

    // Anuncia pros apps abertos, igual ao publish do painel (ver
    // broadcastAppVersion) — esta rota é o caminho do publish-version.ps1,
    // e as duas formas de publicar precisam acender o botão de atualizar.
    //
    // Só quando ESTA chamada trouxe um sha256 e o registro ficou
    // completo. A condição parece exagerada, mas ela cobre o jeito que
    // esta rota pode ser usada: dá pra publicar a versão primeiro e
    // preencher o hash depois (ele muda entre compilar e assinar o
    // instalador — ver a validação que aceita sha vazio, acima). Num PUT
    // só com `version`, o sha256 guardado ainda é o da versão ANTERIOR e
    // o registro pareceria completo; anunciar ali mandaria todo mundo
    // baixar um arquivo cujo hash não confere — e o download aborta de
    // propósito quando isso acontece (ver update.ts no Electron).
    //
    // O publish-version.ps1 manda versão e hash juntos, então ele
    // anuncia na primeira chamada; quem publicar em duas etapas anuncia
    // na segunda, que é quando o instalador está realmente pronto.
    if (sha256 && info?.version && info?.sha256 && info?.installerFilename) {
      broadcastAppVersion(info.version);
    }

    res.json(info);
  } catch (err) {
    console.error("Erro ao atualizar a versão publicada:", err);
    res.status(500).json({ error: "Erro interno ao atualizar a versão" });
  }
});

// POST /webhook — o LiveKit Server chama isso sozinho (configurado em
// livekit.yaml) quando uma sala começa/termina ou participantes entram/saem.
// É o que deixa a lista de salas em tempo real pro Electron, em vez de
// cada app perguntar em loop (ver useRooms.ts no Electron).
app.post("/webhook", async (req, res) => {
  let event;
  try {
    event = await webhookReceiver.receive(req.rawBody, req.get("Authorization"));
  } catch (err) {
    console.error("Webhook do LiveKit com assinatura inválida:", err);
    return res.status(400).send();
  }

  // Log de diagnóstico temporário (2026-08-31, ver ROADMAP.md item 18) —
  // todo evento que chega aqui, processado ou não (ex: hidden preview
  // filtrado mais abaixo não aparece separado, mas dá pra cruzar com o
  // "sent webhook" do lado do livekit-server nos logs dele).
  console.log(
    `[webhook] evento=${event.event} room=${event.room?.name ?? "?"} ` +
      `participant=${event.participant?.identity ?? "-"}`,
  );

  switch (event.event) {
    case "room_started": {
      // Evento atrasado de uma sala que já acabou (ver finishedRoomSids).
      if (isFinishedSid(event.room?.sid)) {
        console.warn(
          `[webhook] room_started da sala ${event.room.name} chegou depois do room_finished ` +
            `(sid=${event.room.sid}) — ignorado`,
        );
        break;
      }
      // Item novo (2026-09-04, "sala com senha"): consome a senha
      // pendente (se o host escolheu uma no POST /ingress, ver
      // pendingRoomPrivate) — esse é o primeiro momento em que a sala
      // passa a existir de verdade, então é aqui que a senha "gruda" no
      // roomsState pra valer.
      // O fallback pro metadata entrou em 2026-09-29: desde que o
      // POST /ingress cria a sala com `{ private: true }` já gravado,
      // a privacidade existe em DOIS lugares, e ler o segundo custa
      // nada. Cobre o caso de este processo ter reiniciado entre criar
      // a sala e o webhook chegar — aí o `pendingRoomPrivate` se perdeu
      // e a sala voltaria pública.
      const isPrivate =
        pendingRoomPrivate.get(event.room.name) ?? isRoomPrivateFromMetadata(event.room);
      pendingRoomPrivate.delete(event.room.name);
      // O que o host já sabia da fonte na hora do /ingress (2026-09-30,
      // ver pendingRoomGame). Mesmo fallback pro metadata do `private`
      // logo acima, e pelo mesmo motivo.
      const pendingGame = pendingRoomGame.get(event.room.name) ?? null;
      pendingRoomGame.delete(event.room.name);
      // ESTA SALA JÁ ESTAVA NO AR? (2026-09-30)
      //
      // Só uma sala RECRIADA tem `startedAt` no metadata: ele é gravado
      // quando a live fica pronta (ver markRoomReady), então uma live
      // nova nunca tem. Achar um aqui significa que esta é a mesma live
      // de antes, recriada no meio de uma troca de fonte — e o
      // cronômetro dela continua de onde estava, em vez de voltar pro
      // zero na cara de quem está assistindo.
      const recoveredStartedAt = startedAtFromMetadata(event.room);
      // O id DESTA encarnação da sala — é ele que o `room_finished`
      // abaixo confere antes de apagar qualquer coisa.
      setRoomSid(event.room.name, event.room.sid);
      // E o que valia pra encarnação ANTERIOR não vale pra esta
      // (2026-09-30, ver beginRoomIncarnation).
      beginRoomIncarnation(event.room.name, { startedAtKept: recoveredStartedAt !== null });
      // QUEM É O HOST, JÁ NA CRIAÇÃO (2026-10-16, "start instantâneo").
      //
      // O evento não traz participante nenhum, mas o POST /ingress gravou
      // o dono ANTES de criar a sala (ver setRoomOwner) — e a identity do
      // publisher do Ingress é esse mesmo username. Antes isto era `null`
      // até o primeiro frame chegar, e era por isso que a sala só podia
      // aparecer depois dele.
      //
      // Sem dono (sala que ninguém pediu pelo /ingress) continua `null`,
      // e a sala continua escondida até alguém publicar — ver abaixo.
      const owner = roomOwnerUsername(event.room.name);
      roomsState.set(event.room.name, {
        name: event.room.name,
        hostName: owner,
        participants: [],
        game: pendingGame ?? gameFromMetadata(event.room),
        // Desde 2026-10-16 o cronômetro começa AQUI, na criação da sala —
        // que é o clique do host em "Compartilhar tela" — e não mais no
        // primeiro frame. É o mesmo instante em que a live passa a
        // aparecer pra todo mundo, logo abaixo: um tempo que começasse
        // depois dela estar na lista seria uma live "no ar há 0s" por
        // vários segundos.
        //
        // Numa sala RECRIADA o valor recuperado é o início real daquela
        // live, e nada o sobrescreve.
        startedAt: recoveredStartedAt ?? extractStartedAt(event.room),
        private: isPrivate,
      });

      // A LIVE APARECE AGORA (2026-10-16, pedido do usuário: "start
      // instantâneo").
      //
      // Entre 2026-09-30 e esta data a sala ficava escondida até o
      // primeiro publisher entrar (ver markRoomReady), porque até ali ela
      // não tinha host, nem avatar, nem jogo — era a "Live de ???". Agora
      // ela nasce com as três coisas: o dono logo acima, e o que está
      // sendo transmitido (a janela ou o monitor, que o app manda no
      // /ingress sem esperar detecção de jogo nenhuma).
      //
      // O vídeo ainda não chegou, e isso é aceito de propósito (decisão
      // do usuário): quem entrar agora vê "Aguardando transmissão" por
      // um ou dois segundos, até o pipeline do host publicar. A sala só
      // não pode ficar de pé se a live NUNCA subir — e disso cuida a
      // derrubada por falta de publisher logo abaixo.
      if (owner) {
        markRoomReady(event.room.name);
        // Sempre grava, agora: o `startedAt` acima precisa sobreviver a
        // um restart deste processo (ver syncRoomMetadata).
        syncRoomMetadata(event.room.name);
        broadcastRooms();
      } else if (isPrivate || pendingGame) {
        syncRoomMetadata(event.room.name);
      }
      // Bug real de produção (2026-09-06, ver HOSTLESS_NEW_ROOM_GRACE_MS
      // lá em cima): sala criada NUNCA é garantia de que existe um host.
      // Um cliente reconectando com token velho recria a sala apagada
      // (auto_create do LiveKit), e sem isso ela ficava presa na lista
      // como "Live de ???" pra sempre — o empty_timeout do LiveKit não
      // resolve, porque só age com a sala TOTALMENTE vazia (um viewer
      // conectado, ou o preview hidden do host, segura ela viva).
      // Numa live de verdade o publisher entra em milissegundos e
      // cancela essa derrubada (ver participant_joined abaixo).
      scheduleHostlessRoomTeardown(event.room.name, HOSTLESS_NEW_ROOM_GRACE_MS);
      break;
    }
    case "room_finished": {
      // Item 46: se a sala caiu por qualquer outro caminho (host parou
      // de propósito, timeout do LiveKit etc.), não deixa uma derrubada
      // "sem host" pendente tentando agir de novo em cima de uma sala
      // que já não existe mais.
      // A limpeza inteira virou `cleanupFinishedRoom` em 2026-09-18: o
      // DELETE /rooms/:roomName precisa fazer exatamente o mesmo quando
      // conclui que a sala acabou sem o LiveKit avisar (sala órfã). Duas
      // cópias da mesma limpeza é como uma delas fica pra trás.

      // ORDEM DE WEBHOOK NÃO É GARANTIA (2026-09-29).
      //
      // Tudo aqui é indexado por NOME da sala, e o nome é um código de 6
      // dígitos que pode morrer e renascer em segundos. Se o
      // `room_started` da sala nova chegar ANTES do `room_finished` da
      // velha — e nada no protocolo impede isso —, esta limpeza apagaria
      // o estado da sala NOVA: ela sumiria da lista de todo mundo e, sem
      // `roomsState`, nem a derrubada por falta de host agiria mais
      // sobre ela. Sobraria uma sala viva no LiveKit que este servidor
      // não conhece, segurada de pé pelos viewers, sem nada pra recolher
      // (o `empty_timeout` só conta com a sala TOTALMENTE vazia). Esse é
      // o fantasma que não morre sozinho.
      //
      // O `sid` é o que distingue as duas encarnações — evento de uma
      // sala que já não é a que está no ar é evento velho, e evento
      // velho não apaga nada.
      const knownSid = roomInternals.get(event.room.name)?.sid;
      const finishedSid = event.room?.sid;
      if (knownSid && finishedSid && knownSid !== finishedSid) {
        console.warn(
          `[webhook] room_finished da sala ${event.room.name} é de uma encarnação ANTIGA ` +
            `(sid=${finishedSid}, atual=${knownSid}) — ignorado`,
        );
        break;
      }
      rememberFinishedSid(finishedSid);
      cleanupFinishedRoom(event.room.name);
      break;
    }
    case "participant_joined":
    case "participant_left":
      if (event.room && roomsState.has(event.room.name)) {
        const identity = event.participant?.identity;

        if (isHiddenPreviewParticipant(identity, event.participant?.permission)) {
          break;
        }

        const prev = roomsState.get(event.room.name);
        const participants =
          event.event === "participant_joined"
            ? [...new Set([...prev.participants, identity])]
            : prev.participants.filter((p) => p !== identity);

        // O host é quem tem permissão de publicar (canPublish) — viewers
        // nunca têm essa flag. Não dá pra assumir "primeiro a entrar" porque
        // ordem de eventos não é garantida — usa a permissão em si.
        const isPublisher =
          event.event === "participant_joined" && event.participant?.permission?.canPublish;

        // Item 46 do roadmap: o HOST em si saiu — zera hostName JÁ (a
        // sala reflete a realidade: sem publisher agora), mas só derruba
        // a sala de verdade depois da folga (scheduleHostlessRoomTeardown),
        // dando um tempo curto pro host reconectar antes de expulsar
        // quem estiver assistindo.
        //
        // Também pela PERMISSÃO (2026-10-16), e não só pelo nome: só o
        // publisher do Ingress pode publicar, e o nome pode ter mudado no
        // meio da live (renomear a conta troca o `hostName`, mas não a
        // identity de quem já está conectado). Pelo nome só, a saída do
        // publisher passaria despercebida e a sala nunca seria derrubada.
        const hostLeft =
          event.event === "participant_left" &&
          (identity === prev.hostName || event.participant?.permission?.canPublish === true);

        // A LIVE ENTROU NO AR AGORA? (2026-09-30, ver markRoomReady)
        //
        // `true` só no PRIMEIRO publisher desta sala. Numa troca de fonte
        // o publisher entra de novo e isto devolve `false` — a sala já
        // estava no ar, e o cronômetro dela não pode reiniciar por causa
        // de uma troca de janela.
        const becameReady = isPublisher ? markRoomReady(event.room.name) : false;

        // E O CRONÔMETRO COMEÇA AGORA? Nem sempre que a sala fica pronta.
        //
        // Numa sala recriada no meio de uma troca de fonte, esta é a
        // primeira vez que ELA fica pronta, mas não a primeira vez que a
        // LIVE está no ar — o início verdadeiro veio do metadata no
        // `room_started`. Ver beginRoomIncarnation.
        const startsClock = becameReady && !keepsRoomStartedAt(event.room.name);

        // Quem diz se a live tem sinal é o `publishing`; o `hostName`
        // continua sendo o dono quando o publisher sai (2026-10-16). Antes
        // ele zerava numa troca de fonte, e a sala virava "Sala ao vivo"
        // sem nome nem avatar por alguns segundos, e o host não conseguia
        // convidar, expulsar nem silenciar ninguém nesse intervalo.
        if (isPublisher) setRoomPublishing(event.room.name, true);
        else if (hostLeft) setRoomPublishing(event.room.name, false);

        roomsState.set(event.room.name, {
          name: event.room.name,
          hostName: isPublisher ? identity : prev.hostName,
          participants,
          game: prev.game,
          // Item 42 do roadmap, corrigido em 2026-09-30: o começo da live
          // é o PRIMEIRO FRAME, não a criação da sala. Desde 2026-09-29
          // quem cria a sala é o POST /ingress, então o `creationTimeMs`
          // do LiveKit passou a ser o clique em "iniciar" — e o
          // cronômetro já nascia 2-3 segundos adiantado.
          startedAt: startsClock ? Date.now() : prev.startedAt,
          private: prev.private,
        });
        // E é ESTE broadcast que anuncia a sala pela primeira vez quando
        // `becameReady` — com host, avatar e jogo já preenchidos.
        broadcastRooms();

        // O `startedAt` de agora só existe na memória deste processo:
        // grava no metadata pra sobreviver a um restart (ver
        // syncRoomMetadata). Uma chamada por live, sem await como as
        // outras.
        if (becameReady) syncRoomMetadata(event.room.name);

        if (isPublisher) {
          // Host (re)conectou como publisher — cancela qualquer
          // derrubada "sem host" que ainda estivesse pendente pra essa
          // sala.
          cancelPendingHostlessRoomTeardown(event.room.name);
          // E, se ninguém souber de quem é esta sala, passa a saber
          // (2026-09-29): só preenche no vazio, então o dono gravado no
          // /ingress continua valendo. Ver rememberRoomPublisher.
          rememberRoomPublisher(event.room.name, identity);
        } else if (hostLeft) {
          // Avisado = o app está trocando de fonte e já está voltando;
          // sem aviso = o host caiu, e aí vale a folga curta de sempre.
          const reconnecting = takeReconnectNotice(event.room.name);
          if (reconnecting) {
            console.log(
              `[rooms] publisher da sala ${event.room.name} saiu durante uma reconexão ` +
                `anunciada — segurando a sala por ${HOSTLESS_RECONNECT_GRACE_MS}ms`,
            );
          }
          scheduleHostlessRoomTeardown(
            event.room.name,
            reconnecting ? HOSTLESS_RECONNECT_GRACE_MS : HOSTLESS_ROOM_GRACE_MS,
          );
        }
      }
      break;
    default:
      break;
  }

  res.status(200).send();
});

const PORT = process.env.PORT || 3000;

// O `app.listen` acontece dentro do start() lá no fim do arquivo, DEPOIS
// do banco estar de pé e das migrations aplicadas. Antes disso o servidor
// responderia requests com o schema ainda inexistente.
//
// O WebSocketServer abaixo precisa do `server` já criado, então ele é
// criado aqui (sem escutar) e o listen fica pro start().
const server = require("http").createServer(app);

// COMO O TOKEN CHEGA NO HANDSHAKE (2026-09-30, painel/app web)
// ---------------------------------------------------------------------
// São DOIS caminhos, e os dois desembocam no mesmo `token` logo abaixo:
//
//   1. `Authorization: Bearer <jwt>` — o app Electron (src/main/rooms.ts)
//      e o Android. Quem abre o socket lá é código fora do navegador (a
//      lib `ws` do Node, o Dart), que define header à vontade.
//
//   2. SUBPROTOCOLO `["prisma.bearer", "<jwt>"]` — o Prisma Web. O
//      `WebSocket` do NAVEGADOR não deixa definir header nenhum: a única
//      coisa que o construtor aceita além da URL é a lista de
//      subprotocolos, que viaja no header `Sec-WebSocket-Protocol`.
//
// A alternativa óbvia pro navegador seria `?token=<jwt>` na URL. Ela foi
// recusada de propósito: a URL inteira acaba gravada no access log do
// nginx, no histórico do navegador e no `Referer` — a credencial ficaria
// em disco em três lugares que ninguém pensou em proteger. O
// subprotocolo é um header como outro qualquer: não aparece em nenhum
// dos três.
//
// O `handleProtocols` é OBRIGATÓRIO nesse arranjo: quando o cliente
// oferece subprotocolos, o servidor precisa escolher um e devolvê-lo no
// handshake — senão o navegador derruba a conexão que ele mesmo acabou
// de abrir. Devolvemos sempre `prisma.bearer`, nunca o token (que não é
// um nome de protocolo e não tem por que voltar pela rede).
const BEARER_SUBPROTOCOL = "prisma.bearer";

function tokenDoHandshake(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7);

  // `Sec-WebSocket-Protocol` é uma lista separada por vírgula: o primeiro
  // item é o nome do esquema, o segundo é o token.
  const oferecidos = (req.headers["sec-websocket-protocol"] || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (oferecidos[0] !== BEARER_SUBPROTOCOL) return null;
  return oferecidos[1] || null;
}

// WebSocket em /ws/rooms — cada cliente (o app Electron via
// src/main/rooms.ts, o Prisma Web via src/api/realtime.ts) recebe o
// snapshot atual assim que conecta, depois recebe a lista de novo sempre
// que broadcastRooms() rodar.
const wss = new WebSocketServer({
  server,
  path: "/ws/rooms",
  // `protocols` é um Set. Devolver `false` aqui RECUSARIA o handshake, e
  // é justamente o que não pode acontecer com quem não oferece
  // subprotocolo nenhum (Electron/Android): pra eles a lista chega
  // vazia. `undefined` significa "sem subprotocolo", que é exatamente o
  // que esses clientes esperam desde sempre.
  handleProtocols: (protocols) =>
    protocols.has(BEARER_SUBPROTOCOL) ? BEARER_SUBPROTOCOL : undefined,
});
wss.on("connection", (ws, req) => {
  // Mesmo JWT das rotas HTTP (2026-09-10) — ver `tokenDoHandshake` acima
  // pros dois jeitos de ele chegar até aqui.
  const token = tokenDoHandshake(req);
  let userId;
  let tokenVersion;
  try {
    const payload = require("jsonwebtoken").verify(token, process.env.JWT_SECRET);
    // Guardar QUEM é o socket é o que torna a presença possível: antes do
    // JWT por usuário (item 3) o token era o mesmo pra todo mundo e não
    // dava pra saber de quem era cada conexão.
    userId = Number(payload.sub);
    tokenVersion = payload.tv;
    ws.userId = userId;
  } catch {
    ws.close(4401, "unauthorized");
    return;
  }

  // Revogação (migration 003, 2026-09-10). Este caminho NÃO passa pelo
  // `requireAuth`, então precisa conferir a `token_version` por conta
  // própria — senão um token revogado (senha trocada) continuaria
  // abrindo o WebSocket e a pessoa apareceria ONLINE pra todo mundo,
  // recebendo a lista de salas em tempo real, mesmo já expulsa de todo
  // o resto da API.
  //
  // Assíncrono no meio de um handler síncrono: o socket já está aberto
  // aqui, então a checagem acontece e fecha depois se reprovar. A
  // janela é de milissegundos e nada é enviado antes — o registro na
  // presença está DEPOIS deste await.
  usersDb
    .findById(userId)
    .then((user) => {
      if (!user || user.token_version !== tokenVersion) {
        ws.close(4401, "unauthorized");
        return;
      }
      // Conta bloqueada/pendente não abre socket (2026-09-16). Sem
      // isto, alguém bloqueado com o app aberto continuaria online pra
      // todo mundo até o processo ser fechado — o bloqueio derruba a
      // conexão de agora (presence.disconnectUser), e esta checagem
      // impede a reconexão automática que viria logo em seguida.
      if (user.status !== "active") {
        ws.close(4403, "account not active");
        return;
      }
      registerPresenceSocket(ws, userId);
    })
    .catch((err) => {
      console.error("Erro ao validar o token do WebSocket:", err);
      ws.close(1011, "internal error");
    });

  // Bug real reportado (2026-08-31): às vezes o app parava de receber
  // atualização de salas sem cair a conexão visivelmente. Sem ping/pong,
  // uma conexão TCP que morre "na marra" (rede instável, NAT/firewall no
  // meio derrubando uma conexão ociosa) não dispara `close` nenhum — o
  // servidor continua achando que o cliente tá em `OPEN` e mandando
  // mensagem pra um socket morto (`ws.send()` não falha de forma
  // confiável nesse caso), e o cliente nunca recebe nada de novo. `isAlive`
  // é o padrão documentado da própria lib `ws` pra isso: se o cliente não
  // respondeu (`pong`) ao ping do ciclo anterior, está morto de verdade —
  // derruba e libera o slot, em vez de deixar acumular conexão fantasma.
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  // Extraído em 2026-09-10 pra rodar DEPOIS da checagem de revogação
  // (ver acima). Antes disso era código solto aqui no handler, e não
  // dava pra adiar sem duplicar.
  //
  // Tudo que registra a pessoa como presente mora aqui: enquanto a
  // validação não passar, o socket existe mas não conta como ninguém.
  function registerPresenceSocket(socket, id) {
    // Fechou (ou caiu) enquanto o banco respondia — nada a registrar.
    if (socket.readyState !== socket.OPEN) return;

    roomsWsClients.add(socket);
    const cameOnline = presence.addSocket(id, socket);
    console.log(
      `[rooms] WS conectado (user ${id}, ${roomsWsClients.size} sockets) ` +
        `${cameOnline ? "— ficou ONLINE" : "(já estava online em outra janela)"}`,
    );

    // Snapshot imediato só pra ESTE socket, já filtrado pelo que ele
    // pode ver — quem acabou de conectar não pode esperar o próximo
    // evento de sala pra ter uma lista.
    socket.send(
      JSON.stringify({
        type: "rooms",
        rooms: roomsVisibleTo(id),
        userAvatars: buildUserAvatarsDirectory(),
        presence: presenceSnapshot(),
      }),
    );

    // Avisa os outros que essa pessoa entrou. Só quando é a PRIMEIRA
    // janela dela: abrir uma segunda não muda nada pra ninguém.
    if (cameOnline) {
      // A preferência (available/busy) vive no banco; carrega pro cache
      // antes de anunciar, senão a pessoa apareceria como "online" por
      // um instante mesmo tendo deixado "ocupado" marcado.
      usersDb
        .findById(id)
        .then((user) => {
          if (user) presencePreferenceCache.set(id, user.presence_preference);
        })
        .catch((err) => console.error("Erro ao carregar preferência de presença:", err))
        .finally(() => broadcastRooms());
    }

    socket.on("close", (code, reason) => {
      roomsWsClients.delete(socket);
      // Só fica offline quando a ÚLTIMA janela dela cai.
      if (presence.removeSocket(id, socket)) {
        presencePreferenceCache.delete(id);
        broadcastRooms();
      }
      console.log(
        `[rooms] cliente WS desconectado (code=${code}, reason=${reason}) — ` +
          `${roomsWsClients.size} total agora`,
      );
    });
  }
});

// A cada 30s: pinga todo mundo, derruba quem não respondeu ao ping do
// ciclo ANTERIOR (isAlive ainda false quando esse ciclo roda de novo).
setInterval(() => {
  for (const ws of roomsWsClients) {
    if (ws.isAlive === false) {
      console.log("[rooms] cliente WS não respondeu ao ping anterior — encerrando conexão morta");
      roomsWsClients.delete(ws);
      // NÃO precisa de presence.removeSocket() aqui: terminate() dispara o
      // evento "close", e é o handler dele que tira da presença e avisa os
      // outros. Chamar aqui também faria a limpeza duas vezes.
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

// --- Boot -------------------------------------------------------------
// Ordem obrigatória: banco de pé -> migrations aplicadas -> cache de
// avatares carregado -> só então aceitar requests. Subir o listen antes
// disso deixaria uma janela em que /login responderia erro de tabela
// inexistente.
//
// Qualquer falha aqui derruba o processo de propósito, em vez de subir um
// servidor pela metade: o `restart: unless-stopped` do compose reinicia, e
// o log diz o que faltou (banco fora do ar, migration quebrada, JWT_SECRET
// ausente).
async function start() {
  try {
    await db.waitForDatabase();
    await db.runMigrations();
    await refreshUserAvatars();

    // Avisa, no log, se os e-mails vão sair de verdade ou só aparecer
    // aqui (ver mail.js). Sem isso dá pra rodar semanas em "modo de
    // teste" achando que está enviando e-mail.
    mail.logStartupMode();

    // Faxina dos códigos de recuperação vencidos. No boot, e não num
    // agendador: a tabela é uma fila de coisas efêmeras, e o servidor
    // reinicia com frequência de sobra pro volume disso.
    try {
      const removed = await resetsDb.deleteExpired();
      if (removed) console.log(`[db] ${removed} código(s) de recuperação vencido(s) removido(s)`);
    } catch (err) {
      // Não impede o boot: é limpeza, não pré-requisito.
      console.error("Erro ao limpar códigos de recuperação vencidos:", err);
    }

    server.listen(PORT, () => {
      console.log(`Servidor rodando na porta ${PORT}`);
    });
  } catch (err) {
    console.error("[boot] falha ao iniciar o servidor:", err);
    process.exit(1);
  }
}

start();
