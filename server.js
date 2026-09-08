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

const app = express();
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

const TOKEN_API_SECRET = process.env.TOKEN_API_SECRET;

// Credenciais do LiveKit Server — em --dev sem --keys (ver start-livekit.bat
// em D:\MY PROJECTS\livekit), o próprio livekit-server usa devkey/secret
// fixos, então .env.teste aponta pra essas mesmas duas.
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

// URL HTTP (não ws) do LiveKit Server, usada só aqui no backend pra falar
// com a Server API (derrubar sala) — nunca exposta pro cliente Electron.
const LIVEKIT_SERVER_URL = process.env.LIVEKIT_SERVER_URL;
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
const pendingRoomPasswords = new Map(); // roomName -> senha (string não-vazia)

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
const roomsState = new Map(); // roomName -> { name, hostName, participants, game, startedAt, password }
const roomsWsClients = new Set();

// Item novo (2026-09-04, "sala com senha"): NUNCA manda a senha em si pro
// cliente (nem pro host, nem pro viewer) — só se a sala TEM uma
// (`hasPassword`), o suficiente pra desenhar o cadeado no tile e pedir a
// senha antes de entrar. A conferência de verdade (senha certa ou não)
// acontece só no servidor, em /token.
function toPublicRoom(room) {
  const { password, ...rest } = room;
  return { ...rest, hasPassword: Boolean(password) };
}

function broadcastRooms() {
  const rooms = Array.from(roomsState.values()).map(toPublicRoom);
  // Roadmap item 43 (Electron): diretório de avatares (nome -> preset ou
  // foto customizada), recalculado do zero a partir do userList.json a
  // cada broadcast — nunca fica "salvo" em lugar nenhum separado, então
  // nunca fica desatualizado. Ver buildUserAvatarsDirectory() mais abaixo
  // (definida depois de loadUsers/saveUsers, mas function declarations
  // são hoisted — funciona mesmo chamada antes no arquivo).
  const userAvatars = buildUserAvatarsDirectory();
  const payload = JSON.stringify({ type: "rooms", rooms, userAvatars });
  // Log de diagnóstico temporário (2026-08-31, ver ROADMAP.md item 18) —
  // se um cliente já conectado não recebe uma atualização em tempo real,
  // isso aqui mostra se o problema é ANTES (nenhum cliente registrado
  // pra receber) ou DEPOIS (registrado mas com readyState != OPEN, ex:
  // socket morto que o servidor ainda não percebeu que caiu).
  let sent = 0;
  for (const ws of roomsWsClients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
      sent++;
    }
  }
  console.log(
    `[rooms] broadcastRooms: ${rooms.length} sala(s) (${rooms.map((r) => r.name).join(", ")}) ` +
      `enviado pra ${sent}/${roomsWsClients.size} cliente(s) conectado(s)`,
  );
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
const HOSTLESS_NEW_ROOM_GRACE_MS = 15000;
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
    // esperava) ou já tem host de novo (reconectou a tempo) — nada a
    // fazer.
    if (!current || current.hostName !== null) return;
    try {
      await roomService.deleteRoom(roomName);
      console.log(`[rooms] sala ${roomName} derrubada — sem host há ${graceMs}ms`);
    } catch (err) {
      console.error(`[rooms] falha ao derrubar sala ${roomName} sem host:`, err);
    }
  }, graceMs);
  pendingHostlessRoomTimers.set(roomName, timer);
}

// Estado inicial: se o prisma_server reiniciar com salas já em andamento, não
// fica sem saber delas até o próximo evento de webhook — busca os
// participantes de cada sala já ativa (listParticipants) pra saber hostName/
// participants desde já, em vez de esperar o próximo join/left de cada uma.
(async () => {
  try {
    const rooms = await roomService.listRooms();
    for (const r of rooms) {
      let hostName = null;
      let participants = [];
      try {
        const roomParticipants = await roomService.listParticipants(r.name);
        const visibleParticipants = roomParticipants.filter(
          (p) => !isHiddenPreviewParticipant(p.identity, p.permission),
        );
        participants = visibleParticipants.map((p) => p.identity);
        hostName = visibleParticipants.find((p) => p.permission?.canPublish)?.identity ?? null;
      } catch (err) {
        console.error(`Erro ao listar participantes da sala ${r.name}:`, err);
      }
      roomsState.set(r.name, {
        name: r.name,
        hostName,
        participants,
        game: null,
        startedAt: extractStartedAt(r),
        // Sala já em andamento ANTES desse restart do prisma_server — a
        // senha (se tinha uma) só existia em `pendingRoomPasswords`, em
        // memória, então se perdeu junto do restart (mesma limitação do
        // comentário em `pendingRoomPasswords` lá em cima). Sem isso pra
        // recuperar, a sala volta sem senha até ser encerrada e criada
        // de novo.
        password: null,
      });
      // Item 46 do roadmap: cobre o caso do prisma_server reiniciar bem no
      // meio de uma sala já sem host (o host saiu antes do restart, só
      // sobraram viewers) — sem isso, essa sala ficaria sem a folga/
      // derrubada automática até o próximo participant_left de verdade
      // (que pode nunca vir, se só sobrarem viewers passivos).
      if (hostName === null) scheduleHostlessRoomTeardown(r.name);
    }
    broadcastRooms();
  } catch (err) {
    console.error("Erro ao carregar estado inicial das salas:", err);
  }
})();

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;

  if (auth !== `Bearer ${TOKEN_API_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  next();
}

app.get("/ping", (req, res) => {
  res.status(200).json("Successful Connection!");
});

// --- Contas de usuário (cadastro/login) -------------------------------------
// Guardadas num JSON simples (sem banco de dados) — "userList.json" mora
// num volume próprio (./data, ver docker-compose.yml), pra sobreviver a um
// rebuild do container. A senha nunca é guardada em texto puro, só
// hash+salt (crypto.scrypt).
const USERS_FILE = path.join(__dirname, "data", "userList.json");

const usersDir = path.dirname(USERS_FILE);
if (!fs.existsSync(usersDir)) fs.mkdirSync(usersDir, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "[]");

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

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));
  } catch (err) {
    console.error("Erro ao ler userList.json, tratando como lista vazia:", err);
    return [];
  }
}

function saveUsers(users) {
  // Escreve num arquivo temporário e troca o nome depois (rename é atômico
  // no mesmo filesystem) — evita deixar o userList.json pela metade se o
  // processo cair no meio da escrita.
  const tmpFile = `${USERS_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(users, null, 2));
  fs.renameSync(tmpFile, USERS_FILE);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const expected = Buffer.from(hash, "hex");
  const actual = crypto.scryptSync(password, salt, 64);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Só letras (sem acento) e números — nenhum caractere especial (vírgula,
// ponto, "-", "_", "/" etc.), case sensitive (decisão de 2026-08-29).
const USERNAME_CHARSET_PATTERN = /^[A-Za-z0-9]+$/;

function isValidUsername(name) {
  return USERNAME_CHARSET_PATTERN.test(name);
}

// Serializa cadastro/renomeação — sem isso, dois cadastros quase
// simultâneos podiam ler o mesmo "próximo ID" antes de qualquer um salvar,
// e um sobrescreveria o outro.
let userWriteQueue = Promise.resolve();
function withUserWriteLock(fn) {
  const run = userWriteQueue.then(fn, fn);
  userWriteQueue = run.then(
    () => {},
    () => {},
  );
  return run;
}

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
function avatarWithId(user) {
  if (!user.avatar) return null;
  if (user.avatar.type === "custom") {
    return { type: "custom", version: user.avatar.version, id: user.id };
  }
  return user.avatar;
}

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
const DEFAULT_USER_SETTINGS = {
  alertForNewLives: true,
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
function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    avatar: avatarWithId(user),
    settings: settingsOf(user),
  };
}

function buildUserAvatarsDirectory() {
  const users = loadUsers();
  const directory = {};
  for (const user of users) {
    const avatar = avatarWithId(user);
    if (avatar) directory[user.name] = avatar;
  }
  return directory;
}

// Usado pra decidir se uma mudança de avatar precisa de um
// broadcastRooms() imediato (o usuário está em live agora, como host ou
// como viewer) — se não estiver em nenhuma sala, a próxima entrada dele
// já vai pegar o avatar atualizado via buildUserAvatarsDirectory() acima,
// sem custo de broadcastar à toa pra ninguém.
function isUserActiveInAnyRoom(name) {
  for (const room of roomsState.values()) {
    if (room.hostName === name || room.participants.includes(name)) return true;
  }
  return false;
}

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
app.post("/register", requireAuth, async (req, res) => {
  const { name, password } = req.body ?? {};

  if (typeof name !== "string" || typeof password !== "string" || !name || !password) {
    return res.status(400).json({ error: "Parâmetros obrigatórios: name, password" });
  }
  if (!isValidUsername(name)) {
    return res.status(400).json({ error: "Nome inválido. Use apenas letras e números." });
  }

  try {
    const result = await withUserWriteLock(() => {
      const users = loadUsers();
      if (users.some((u) => u.name === name)) {
        return { conflict: true };
      }
      const nextId = users.length ? Math.max(...users.map((u) => u.id)) + 1 : 1;
      const created = {
        id: nextId,
        name,
        password: hashPassword(password),
        avatar: null,
        settings: { ...DEFAULT_USER_SETTINGS },
      };
      users.push(created);
      saveUsers(users);
      return { user: publicUser(created) };
    });

    if (result.conflict) {
      return res.status(409).json({ error: "Usuário já cadastrado" });
    }
    res.status(201).json(result.user);
  } catch (err) {
    console.error("Erro ao cadastrar usuário:", err);
    res.status(500).json({ error: "Erro interno ao cadastrar usuário" });
  }
});

// POST /login { name, password } — confere usuário+senha contra
// userList.json. Mesma mensagem tanto pra usuário inexistente quanto senha
// errada, de propósito (não revela se o nome existe ou não).
app.post("/login", requireAuth, (req, res) => {
  const { name, password } = req.body ?? {};

  if (typeof name !== "string" || typeof password !== "string" || !name || !password) {
    return res.status(400).json({ error: "Parâmetros obrigatórios: name, password" });
  }

  const user = loadUsers().find((u) => u.name === name);
  if (!user || !verifyPassword(password, user.password)) {
    return res.status(404).json({ error: "Usuário não encontrado" });
  }

  res.json(publicUser(user));
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
app.put("/users/:id", requireAuth, async (req, res) => {
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
    const result = await withUserWriteLock(() => {
      const users = loadUsers();
      const user = users.find((u) => u.id === id);
      if (!user) return { notFound: true };
      if (hasName && users.some((u) => u.id !== id && u.name === name)) return { conflict: true };

      const oldName = user.name;
      if (hasName) user.name = name;
      if (hasAvatar) user.avatar = avatar;
      // Merge sobre o que JÁ está salvo (costurado com os defaults por
      // settingsOf) — o cliente manda só a chave que mudou, não o objeto
      // inteiro, então sobrescrever direto apagaria as outras.
      if (hasSettings) user.settings = { ...settingsOf(user), ...settingsPatch };
      saveUsers(users);
      return {
        user: publicUser(user),
        oldName,
        renamed: hasName && oldName !== name,
      };
    });

    if (result.notFound) return res.status(404).json({ error: "Usuário não encontrado" });
    if (result.conflict) return res.status(409).json({ error: "Usuário já cadastrado" });

    if (result.renamed) propagateRename(result.oldName, result.user.name);
    if ((result.renamed || hasAvatar) && isUserActiveInAnyRoom(result.user.name)) broadcastRooms();

    res.json(result.user);
  } catch (err) {
    console.error("Erro ao atualizar usuário:", err);
    res.status(500).json({ error: "Erro interno ao atualizar usuário" });
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
  express.raw({ type: "image/webp", limit: "2mb" }),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "id inválido" });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res
        .status(400)
        .json({ error: "Corpo obrigatório: imagem WebP crua (Content-Type: image/webp)" });
    }

    try {
      const result = await withUserWriteLock(() => {
        const users = loadUsers();
        const user = users.find((u) => u.id === id);
        if (!user) return { notFound: true };

        const nextVersion = (user.avatar?.type === "custom" ? user.avatar.version : 0) + 1;
        fs.writeFileSync(path.join(AVATARS_DIR, `${id}.webp`), req.body);
        user.avatar = { type: "custom", version: nextVersion };
        saveUsers(users);
        return { user: publicUser(user) };
      });

      if (result.notFound) return res.status(404).json({ error: "Usuário não encontrado" });

      if (isUserActiveInAnyRoom(result.user.name)) broadcastRooms();

      res.json(result.user);
    } catch (err) {
      console.error("Erro ao salvar avatar customizado:", err);
      res.status(500).json({ error: "Erro interno ao salvar avatar" });
    }
  },
);

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
app.get("/token", requireAuth, async (req, res) => {
  const { roomName, participantName, role, hidden, password } = req.query;

  if (!roomName || !participantName || !role) {
    return res.status(400).json({
      error: "Parâmetros obrigatórios: roomName, participantName, role (host|viewer)",
    });
  }

  const isHost = role === "host";

  // Item novo (2026-09-04, "sala com senha"): só confere pra quem está
  // ENTRANDO como viewer — o host não precisa provar a própria senha de
  // novo pra si mesmo (ele é quem escolheu ela, lá no /ingress). Sala sem
  // senha (`room.password` null/undefined) sempre passa direto, do jeito
  // que já era antes dessa feature.
  if (!isHost) {
    const room = roomsState.get(roomName);
    if (room?.password && room.password !== password) {
      return res.status(401).json({ error: "Senha incorreta." });
    }
  }

  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: participantName,
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
app.delete("/rooms/:roomName", requireAuth, async (req, res) => {
  const roomName = req.params.roomName;

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
    return res.json({ ok: true });
  } catch (err) {
    console.error(`[rooms] deleteRoom(${roomName}) lançou erro, conferindo se a sala já sumiu:`, err);
  }

  try {
    const stillExists = (await roomService.listRooms([roomName])).length > 0;
    if (!stillExists) {
      console.log(`[rooms] sala ${roomName} já não existia mais (ok)`);
      return res.json({ ok: true });
    }
    console.error(`[rooms] sala ${roomName} AINDA EXISTE no LiveKit depois da falha`);
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
  const { roomName, participantName, password } = req.body ?? {};

  if (!roomName || !participantName) {
    return res.status(400).json({
      error: "Parâmetros obrigatórios: roomName, participantName",
    });
  }

  try {
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

    // Item novo (2026-09-04, "sala com senha"): guarda a senha (se
    // veio uma não-vazia) até "room_started" chegar e transferir ela
    // pro roomsState de verdade (ver comentário em pendingRoomPasswords
    // lá em cima — a sala em si ainda não existe nesse ponto).
    if (typeof password === "string" && password.length > 0) {
      pendingRoomPasswords.set(roomName, password);
    } else {
      pendingRoomPasswords.delete(roomName);
    }

    res.json({ url: ingress.url, streamKey: ingress.streamKey });
  } catch (err) {
    console.error("Erro ao criar ingress:", err);
    res.status(500).json({ error: "Não foi possível criar o ingress." });
  }
});

// DELETE /ingress/:roomName — mesmo padrão idempotente do
// DELETE /rooms/:roomName acima: sem ingress registrado pra essa sala não
// é erro (idempotente do ponto de vista do host parando a live).
app.delete("/ingress/:roomName", requireAuth, async (req, res) => {
  const ingressId = ingressIdByRoom.get(req.params.roomName);
  if (!ingressId) {
    console.log(`[ingress] DELETE pra sala ${req.params.roomName} sem ingress registrado (no-op)`);
    return res.json({ ok: true });
  }

  // 2026-08-31: mesmo motivo do DELETE /rooms acima — reporta o
  // resultado real pro cliente poder tentar de novo.
  try {
    await ingressClient.deleteIngress(ingressId);
    ingressIdByRoom.delete(req.params.roomName);
    console.log(`[ingress] ingress ${ingressId} (sala ${req.params.roomName}) removido com sucesso`);
    return res.json({ ok: true });
  } catch (err) {
    console.error(`[ingress] FALHA ao remover ingress ${ingressId} (sala ${req.params.roomName}):`, err);
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
app.get("/rooms", requireAuth, (req, res) => {
  res.json({
    rooms: Array.from(roomsState.values()).map(toPublicRoom),
    userAvatars: buildUserAvatarsDirectory(),
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
// de propósito NÃO idempotente como as rotas DELETE acima: aqui pode ser
// uma corrida real com o webhook room_started (o Electron chama isso logo
// depois de iniciar o processo GStreamer, mas a sala só existe pro
// LiveKit quando o WHIP começa a publicar de verdade, o que pode demorar
// mais que essa primeira chamada) — o Electron tenta de novo nesse caso
// (ver gameDetection.ts), então precisa saber que não colou ainda.
app.post("/rooms/:roomName/game", requireAuth, (req, res) => {
  const roomName = req.params.roomName;
  const { kind, name, iconUrl } = req.body ?? {};

  // Pedido do usuário (2026-09-05): "screen" entrou como kind próprio —
  // antes um monitor inteiro sem jogo detectado era reportado como
  // "window" (o rótulo exibido é o mesmo, "Transmitindo:"), mas o app
  // precisa distinguir os dois pra escolher o ícone do placeholder
  // (monitor x janela, ver HomeScreen.tsx).
  const VALID_KINDS = ["game", "window", "screen"];
  if (kind != null && !VALID_KINDS.includes(kind)) {
    return res.status(400).json({ error: `kind deve ser um de ${VALID_KINDS.join("/")} ou null` });
  }
  if (name != null && typeof name !== "string") {
    return res.status(400).json({ error: "name deve ser string ou null" });
  }
  if (iconUrl != null && typeof iconUrl !== "string") {
    return res.status(400).json({ error: "iconUrl deve ser string ou null" });
  }

  const prev = roomsState.get(roomName);
  if (!prev) {
    return res.status(404).json({ ok: false, error: "sala não encontrada" });
  }

  const game = name ? { kind, name, iconUrl: iconUrl ?? null } : null;
  roomsState.set(roomName, { ...prev, game });
  broadcastRooms();

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
// docker-compose.yml) — publicar uma versão nova só troca esse arquivo +
// o .exe em downloads/, sem precisar rebuildar a imagem (ver RELEASE.md
// do Electron). Lido a cada request (não em cache), pra não precisar
// reiniciar o container depois de trocar o arquivo.
const VERSION_FILE = path.join(__dirname, "version.json");

// O .exe em si não é sensível (é o instalador público) — fica fora do
// requireAuth pra poder ser baixado direto com um GET simples, sem
// precisar implementar streaming autenticado.
app.use("/downloads", express.static(path.join(__dirname, "downloads")));

// GET /avatars/:id.webp — fotos de avatar customizadas (roadmap item 43).
// Pública (sem requireAuth) pelo mesmo motivo de /downloads acima: uma
// tag <img src> não manda Authorization header (decisão confirmada com o
// usuário, 2026-09-01).
app.use("/avatars", express.static(AVATARS_DIR));

// GET /version — o app Electron consulta isso ao abrir (ver
// src/main/update.ts) pra saber se há uma versão mais nova disponível.
app.get("/version", requireAuth, (req, res) => {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(VERSION_FILE, "utf-8"));
  } catch (err) {
    console.error("Erro ao ler version.json:", err);
    return res.status(500).json({ error: "Não foi possível obter informações de versão." });
  }

  res.json({
    version: info.version,
    url: `/downloads/${info.installerFilename}`,
    sha256: info.sha256,
  });
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
      // Item novo (2026-09-04, "sala com senha"): consome a senha
      // pendente (se o host escolheu uma no POST /ingress, ver
      // pendingRoomPasswords) — esse é o primeiro momento em que a sala
      // passa a existir de verdade, então é aqui que a senha "gruda" no
      // roomsState pra valer.
      const password = pendingRoomPasswords.get(event.room.name) ?? null;
      pendingRoomPasswords.delete(event.room.name);
      roomsState.set(event.room.name, {
        name: event.room.name,
        // Ainda não sabemos quem é o host aqui — o evento de sala criada não
        // vem com participante nenhum. Só descobrimos no primeiro
        // participant_joined com permissão de publicar (ver abaixo).
        hostName: null,
        participants: [],
        game: null,
        startedAt: extractStartedAt(event.room),
        password,
      });
      broadcastRooms();
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
    case "room_finished":
      // Item 46: se a sala caiu por qualquer outro caminho (host parou
      // de propósito, timeout do LiveKit etc.), não deixa uma derrubada
      // "sem host" pendente tentando agir de novo em cima de uma sala
      // que já não existe mais.
      cancelPendingHostlessRoomTeardown(event.room.name);
      // Item novo ("sala com senha"): limpa uma senha pendente órfã, se
      // sobrou alguma (ex: ingress criado mas o GStreamer nunca chegou a
      // publicar de verdade) — sem isso, ficaria presa aqui pra sempre.
      pendingRoomPasswords.delete(event.room.name);
      roomsState.delete(event.room.name);
      broadcastRooms();
      break;
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
        const hostLeft = event.event === "participant_left" && identity === prev.hostName;

        roomsState.set(event.room.name, {
          name: event.room.name,
          hostName: isPublisher ? identity : hostLeft ? null : prev.hostName,
          participants,
          game: prev.game,
          startedAt: prev.startedAt,
          password: prev.password,
        });
        broadcastRooms();

        if (isPublisher) {
          // Host (re)conectou como publisher — cancela qualquer
          // derrubada "sem host" que ainda estivesse pendente pra essa
          // sala.
          cancelPendingHostlessRoomTeardown(event.room.name);
        } else if (hostLeft) {
          scheduleHostlessRoomTeardown(event.room.name);
        }
      }
      break;
    default:
      break;
  }

  res.status(200).send();
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

// WebSocket em /ws/rooms — cada cliente (Electron, via src/main/rooms.ts)
// recebe o snapshot atual assim que conecta, depois recebe a lista de novo
// sempre que broadcastRooms() rodar.
const wss = new WebSocketServer({ server, path: "/ws/rooms" });
wss.on("connection", (ws, req) => {
  if (req.headers.authorization !== `Bearer ${TOKEN_API_SECRET}`) {
    ws.close(4401, "unauthorized");
    return;
  }

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

  roomsWsClients.add(ws);
  console.log(`[rooms] cliente WS conectado (${roomsWsClients.size} total agora)`);
  ws.send(
    JSON.stringify({
      type: "rooms",
      rooms: Array.from(roomsState.values()).map(toPublicRoom),
      userAvatars: buildUserAvatarsDirectory(),
    }),
  );
  ws.on("close", (code, reason) => {
    roomsWsClients.delete(ws);
    console.log(
      `[rooms] cliente WS desconectado (code=${code}, reason=${reason}) — ` +
        `${roomsWsClients.size} total agora`,
    );
  });
});

// A cada 30s: pinga todo mundo, derruba quem não respondeu ao ping do
// ciclo ANTERIOR (isAlive ainda false quando esse ciclo roda de novo).
setInterval(() => {
  for (const ws of roomsWsClients) {
    if (ws.isAlive === false) {
      console.log("[rooms] cliente WS não respondeu ao ping anterior — encerrando conexão morta");
      roomsWsClients.delete(ws);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
