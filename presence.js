// Presença e convites (2026-09-10).
//
// PRESENÇA
// Não existe tabela de "quem está online" — o estado é derivado dos
// WebSockets abertos em /ws/rooms, que o app já mantém desde sempre (com
// reconexão e ping/pong de 30s). Um usuário está online enquanto tiver ao
// menos um socket vivo.
//
// Gravar "online" no banco seria um bug esperando acontecer: bastaria o
// container reiniciar pra todo mundo ficar online pra sempre, porque
// ninguém escreveria o "offline" de volta. Em memória isso se resolve
// sozinho — subiu de novo, ninguém tem socket, todo mundo offline, e os
// clientes reconectam em segundos.
//
// O que MORA no banco é só a PREFERÊNCIA (available/busy), porque é
// escolha do usuário e precisa sobreviver a fechar o app.
//
// CONVITES
// Também em memória, e de propósito: uma sala só existe enquanto a live
// está no ar, então um convite não tem sentido depois que ela acaba.
// Morrem junto com a sala (ver `forgetRoom`).

// userId -> Set<ws>. Set, e não um socket só, porque a mesma conta pode
// ter duas janelas abertas — só fica offline quando a última cai.
const socketsByUser = new Map();

// roomName -> Set<userId> que podem VER e ENTRAR numa sala privada.
// Inclui o host. Quem aceitou um convite fica aqui pela vida da sala:
// sair da live e voltar não exige convite novo (uma queda de conexão
// exigiria um convite novo, o que seria irritante).
const roomAllowList = new Map();

// roomName -> Set<userId> CONVIDADOS que ainda não responderam.
//
// Existe pra fechar um buraco concreto: sem isto, o endpoint de aceitar
// convite liberava qualquer usuário autenticado que soubesse (ou
// adivinhasse) o código da sala — bastava chamar a rota direto, sem
// passar pela interface. Como o código tem 6 dígitos, dava pra varrer.
//
// Agora aceitar só funciona se houver um convite pendente pra aquele
// par (sala, usuário), e ele é CONSUMIDO no aceite.
//
// Forma: roomName -> Map(userId -> quando expira). O prazo entrou em
// 2026-09-14 junto com o "um convite de pé por vez" (ver invite()).
const pendingInvites = new Map();

function addSocket(userId, ws) {
  let set = socketsByUser.get(userId);
  if (!set) {
    set = new Set();
    socketsByUser.set(userId, set);
  }
  set.add(ws);
  // true = ficou online agora (antes tinha zero sockets), pro chamador
  // saber se precisa avisar os outros.
  return set.size === 1;
}

function removeSocket(userId, ws) {
  const set = socketsByUser.get(userId);
  if (!set) return false;
  set.delete(ws);
  if (set.size === 0) {
    socketsByUser.delete(userId);
    return true; // ficou offline agora
  }
  return false;
}

function isOnline(userId) {
  return socketsByUser.has(userId);
}

function onlineUserIds() {
  return [...socketsByUser.keys()];
}

// Todo socket conectado, com o dono de cada um — usado pelo broadcast,
// que precisa montar um pacote diferente por usuário (salas privadas só
// vão pra quem pode vê-las).
function eachConnection(callback) {
  for (const [userId, sockets] of socketsByUser) {
    for (const ws of sockets) callback(userId, ws);
  }
}

// Manda uma mensagem só pros sockets de um usuário. Usado pra entregar
// convite. Devolve quantos sockets receberam — 0 significa que a pessoa
// saiu no meio do caminho.
function sendToUser(userId, payload) {
  const sockets = socketsByUser.get(userId);
  if (!sockets) return 0;
  const text = JSON.stringify(payload);
  let sent = 0;
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) {
      ws.send(text);
      sent++;
    }
  }
  return sent;
}

// --- convites / lista de permissão ------------------------------------

// Quanto tempo um convite fica de pé aqui no servidor (2026-09-14).
//
// Um pouco MAIOR que os 30s do aviso na tela do convidado
// (INVITE_TIMEOUT_MS no app): no caminho normal quem encerra o
// convite é o próprio app dele, avisando que expirou. Este prazo é a
// rede de segurança pro caminho em que esse aviso não chega — o app
// fechou, caiu a internet, a máquina hibernou.
//
// Sem ele, um convite que ninguém respondeu ficaria pendente pra
// sempre, e o host nunca mais conseguiria convidar aquela pessoa
// naquela sala (ver o "só um convite de pé por vez" na rota).
const PENDING_INVITE_TTL_MS = 45_000;

// roomName -> Map(userId -> quando expira). Virou Map (era Set) em
// 2026-09-14, quando o convite passou a ter prazo.
function invite(roomName, userId) {
  let byUser = pendingInvites.get(roomName);
  if (!byUser) {
    byUser = new Map();
    pendingInvites.set(roomName, byUser);
  }
  byUser.set(userId, Date.now() + PENDING_INVITE_TTL_MS);
}

// Existe um convite DE PÉ pra essa pessoa nessa sala?
//
// É o que faz o host poder clicar em "convidar" quantas vezes quiser
// sem incomodar ninguém: com um convite já de pé, a rota não manda
// nada de novo, e o aviso na tela do convidado continua correndo o
// tempo dele, sem reiniciar.
//
// Um convite vencido é tratado como inexistente E apagado na hora:
// assim a checagem não deixa lixo pra trás, e a limpeza acontece no
// ritmo do uso, sem precisar de um varredor periódico.
function hasPendingInvite(roomName, userId) {
  const byUser = pendingInvites.get(roomName);
  const expiresAt = byUser?.get(userId);
  if (expiresAt === undefined) return false;
  if (Date.now() < expiresAt) return true;

  byUser.delete(userId);
  if (byUser.size === 0) pendingInvites.delete(roomName);
  return false;
}

// Devolve false se não havia convite (ou se ele já venceu) — a rota
// responde 403. Consome o pendente: um convite serve pra uma entrada
// na lista de permissão, e dali em diante quem manda é a allow-list
// (que dura a vida da sala).
function consumeInvite(roomName, userId) {
  const valid = hasPendingInvite(roomName, userId);
  const byUser = pendingInvites.get(roomName);
  if (byUser) {
    byUser.delete(userId);
    if (byUser.size === 0) pendingInvites.delete(roomName);
  }
  return valid;
}

function allowInRoom(roomName, userId) {
  let set = roomAllowList.get(roomName);
  if (!set) {
    set = new Set();
    roomAllowList.set(roomName, set);
  }
  set.add(userId);
}

function isAllowedInRoom(roomName, userId) {
  return roomAllowList.get(roomName)?.has(userId) ?? false;
}

// Tira UM usuario da lista de permissao de uma sala (expulsao pelo
// host, 2026-09-13). Diferente do forgetRoom abaixo, que apaga a sala
// inteira quando a live termina.
//
// E isto que faz a sala PRIVADA sumir da lista de quem foi expulso: o
// broadcast filtra por esta lista, entao basta sair dela e o proximo
// pacote ja nao inclui a sala pra essa pessoa.
//
// Apaga tambem um convite PENDENTE. Sem isso, quem foi expulso poderia
// aceitar um convite antigo que ainda estivesse no ar no app dele e
// voltar pra sala de onde acabou de ser tirado.
function disallowInRoom(roomName, userId) {
  roomAllowList.get(roomName)?.delete(userId);
  pendingInvites.get(roomName)?.delete(userId);
}

// BARRADOS por sala (2026-10-21, amizades).
//
// Até aqui a expulsão de uma sala privada era definitiva "de graça":
// tirar a pessoa da allow-list bastava, porque a allow-list era o único
// caminho de entrada. Com a regra nova — amigo do dono entra sem
// convite —, um amigo expulso voltaria no mesmo instante pela amizade.
// Esta lista vence a amizade (ver canSeeRoom no server.js) e, como o
// resto deste arquivo, dura a vida da sala: na próxima live do mesmo
// dono, o amigo expulso entra de novo.
//
// roomName -> Set<userId>
const barredFromRoom = new Map();

function barFromRoom(roomName, userId) {
  let set = barredFromRoom.get(roomName);
  if (!set) {
    set = new Set();
    barredFromRoom.set(roomName, set);
  }
  set.add(userId);
}

function isBarredFromRoom(roomName, userId) {
  return barredFromRoom.get(roomName)?.has(userId) ?? false;
}

// Chamado quando a sala acaba. Sem isso o Map cresceria pra sempre —
// cada live deixaria uma entrada órfã, e um código de sala reaproveitado
// (são só 6 dígitos) herdaria a lista de convidados da live anterior.
// Derruba TODAS as conexões de um usuário (2026-09-16, bloqueio pelo
// painel).
//
// Sem isto, bloquear alguém que está com o app aberto só valeria na
// próxima requisição HTTP dele: o WebSocket já aberto continuaria
// recebendo a lista de salas em tempo real, porque a situação da conta
// é conferida no HANDSHAKE, e aquele handshake já aconteceu.
//
// 4403 é um código do espaço privado do WebSocket (4000-4999). O app
// já trata 4401 como "sessão inválida, volte pro login"; este é o
// vizinho semântico pra "conta bloqueada".
function disconnectUser(userId, code = 4403, reason = "conta bloqueada") {
  const set = socketsByUser.get(userId);
  if (!set) return 0;

  let closed = 0;
  // Cópia do Set antes de iterar: fechar dispara o handler de "close",
  // que remove do mesmo Set que estaria sendo percorrido.
  for (const ws of [...set]) {
    try {
      ws.close(code, reason);
      closed++;
    } catch {
      /* socket já morto */
    }
  }
  return closed;
}

// --- chat da live (2026-09-23) ----------------------------------------
//
// Mora aqui, junto de convite e allow-list, porque e a mesma natureza:
// estado EFEMERO por sala, que nasce com a live e morre com ela. O
// `forgetRoom` logo abaixo e quem apaga — nao existe expiracao nem
// varredor periodico, e nada disso toca o banco.
//
// A decisao de transporte (2026-09-23): as mensagens vao pelo WebSocket
// `/ws/rooms` que ja existe, e nao por data channel do LiveKit. O motivo
// e o host — ele publica via GStreamer/WHIP, entao o participante dele no
// LiveKit e o Ingress, criado pelo servidor e so de midia. O app do host
// nao tem conexao de dados nenhuma com a sala (so abre uma Room quando o
// preview e ligado). Pelo LiveKit, o chat exigiria uma conexao nova e
// permanente no host — que e exatamente a classe de bug do
// `NEVER_RECONNECT` em useHostPreview.ts (conexao sobrevivente
// ressuscitando sala apagada via auto_create).

// roomName -> [{ id, from, text, at }]. So as ultimas mensagens: um chat
// que morre com a live nao precisa de rolagem infinita, e o teto e o que
// impede uma live de 6 horas virar um vazamento de memoria lento.
const chatHistory = new Map();
const CHAT_HISTORY_LIMIT = 50;

// roomName -> Set<userId> silenciados pelo host.
//
// Por userId (e nao por nome), diferente do `participants` do roomsState:
// isto e estado interno, nunca aparece na tela e nunca cruza o LiveKit,
// entao nao ha motivo pra herdar a fragilidade do nome — que muda quando
// a pessoa se renomeia. Mesma escolha que a `roomAllowList` acima ja faz.
const mutedInRoom = new Map();

function pushChatMessage(roomName, message) {
  let list = chatHistory.get(roomName);
  if (!list) {
    list = [];
    chatHistory.set(roomName, list);
  }
  list.push(message);
  // Corta pela FRENTE (as mais antigas) — `splice` de uma vez em vez de
  // `shift()` em laco, que seria O(n) por mensagem descartada.
  if (list.length > CHAT_HISTORY_LIMIT) {
    list.splice(0, list.length - CHAT_HISTORY_LIMIT);
  }
  return message;
}

// Copia, nao a lista viva: quem chama serializa pra JSON e nao deve
// conseguir mexer no historico sem querer.
function chatHistoryFor(roomName) {
  return [...(chatHistory.get(roomName) ?? [])];
}

function muteInRoom(roomName, userId) {
  let set = mutedInRoom.get(roomName);
  if (!set) {
    set = new Set();
    mutedInRoom.set(roomName, set);
  }
  set.add(userId);
}

function unmuteInRoom(roomName, userId) {
  mutedInRoom.get(roomName)?.delete(userId);
}

function isMutedInRoom(roomName, userId) {
  return mutedInRoom.get(roomName)?.has(userId) ?? false;
}

function mutedUserIds(roomName) {
  return [...(mutedInRoom.get(roomName) ?? [])];
}

function forgetRoom(roomName) {
  roomAllowList.delete(roomName);
  pendingInvites.delete(roomName);
  barredFromRoom.delete(roomName);
  // E ISTO que faz o chat ser "temporario, so durante a live": a live
  // acaba -> cleanupFinishedRoom -> forgetRoom -> historico e mutes somem
  // da memoria. Nao ha nenhum outro lugar onde uma mensagem sobreviva.
  chatHistory.delete(roomName);
  mutedInRoom.delete(roomName);
}

module.exports = {
  addSocket,
  removeSocket,
  disconnectUser,
  isOnline,
  onlineUserIds,
  eachConnection,
  sendToUser,
  invite,
  hasPendingInvite,
  consumeInvite,
  allowInRoom,
  disallowInRoom,
  isAllowedInRoom,
  barFromRoom,
  isBarredFromRoom,
  forgetRoom,
  pushChatMessage,
  chatHistoryFor,
  muteInRoom,
  unmuteInRoom,
  isMutedInRoom,
  mutedUserIds,
  CHAT_HISTORY_LIMIT,
};
