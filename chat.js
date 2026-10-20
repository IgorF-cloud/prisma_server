// Chat da live (2026-09-23) — item novo do ROADMAP do app.
//
// Chat TEMPORÁRIO: existe enquanto a live existe e some com ela. O
// armazenamento inteiro é o Map em memória de presence.js, apagado pelo
// `forgetRoom()` que o `cleanupFinishedRoom` do server.js já chama
// quando a sala acaba. Nada disso toca o banco, e não há migration.
//
// POR QUE AQUI E NÃO NO DATA CHANNEL DO LIVEKIT (a pergunta óbvia, e a
// primeira que foi investigada): o LiveKit tem data channel, mas o HOST
// não está na sala. Ele publica via GStreamer/WHIP, então o participante
// dele no LiveKit é o Ingress — criado pelo servidor, e só de mídia. O
// app do host só abre uma Room do livekit-client quando o preview é
// ligado. Pelo data channel, o chat exigiria uma conexão LiveKit nova e
// PERMANENTE no host, que é exatamente a classe de bug que o
// `NEVER_RECONNECT` de useHostPreview.ts existe pra conter (conexão
// sobrevivente ressuscitando sala já apagada, via `auto_create`).
// Aqui o caminho já existe, já é autenticado e já está aberto pra todo
// mundo — host incluído.
//
// FORMA: envia por HTTP, recebe pelo WebSocket. É o mesmo desenho que o
// convite já usa (POST /rooms/:roomName/invite -> `type:"invite"` no
// /ws/rooms). O WebSocket nunca leu nada do cliente, e continua assim.
//
// ADITIVO DE PROPÓSITO: só rotas novas e `type`s novos no WS. O app em
// produção hoje ignora `type` desconhecido (é um encadeamento de ifs em
// src/main/rooms.ts), então subir este servidor sozinho, antes de
// publicar a versão nova do app, não muda nada pra quem já está lá.
//
// Em arquivo próprio pelo mesmo motivo do admin.js: o server.js já passa
// de 2.900 linhas. E, diferente do admin, isto aqui recebe as
// dependências por parâmetro — o que deixa as rotas testáveis com stubs,
// sem precisar de Postgres nem LiveKit de pé (ver ops/requests).

const CHAT_MAX_LENGTH = 500;

function setupChatRoutes({
  app,
  requireAuth,
  chatSendRateLimit,
  presence,
  usersDb,
  roomsState,
  canSeeRoom,
}) {
  // Contador de desempate pro id da mensagem. `Date.now()` sozinho
  // repete quando duas mensagens caem no mesmo milissegundo, e o app usa
  // esse id como key de lista no React.
  let chatMessageSeq = 0;

  // Resolve, numa consulta só: quem está na sala, o id de cada um, e o
  // nome ATUAL de quem está falando.
  //
  // O nome do remetente é cruzado por `userId` contra a lista da própria
  // sala, em vez de confiar num nome vindo de fora. Sai de graça: a
  // mesma consulta serve pra três coisas — checar se pode falar, saber o
  // nome do autor e achar os destinatários —, por isso não há um
  // findByUsername por pessoa a cada mensagem enviada.
  //
  // Contexto histórico: até 2026-09-23 o `req.username` vinha do JWT e
  // ficava velho depois de uma renomeação, então cruzar por ID era a
  // única forma correta. Isso foi consertado na raiz (o `req.username`
  // agora sai do banco, ver auth/jwt.js), mas o cruzamento continua aqui
  // porque é a fonte mais direta: o nome sai da MESMA lista pra quem a
  // mensagem vai ser entregue.
  async function resolveChatContext(roomName, userId) {
    const room = roomsState.get(roomName);
    if (!room) return { room: null, idsByName: null, senderName: null };

    const idsByName = await usersDb.idsByUsernames(room.participants);

    let senderName = null;
    for (const [name, id] of idsByName) {
      if (id === userId) {
        senderName = name;
        break;
      }
    }

    return { room, idsByName, senderName };
  }

  // Quem, entre os presentes na sala, está silenciado — por nome.
  //
  // O mute é guardado por ID (estado interno, imune a renomeação) e as
  // listas do app falam em nome, então a tradução acontece aqui, uma vez
  // por chamada e numa consulta só.
  async function mutedNamesInRoom(roomName, participants) {
    if (!participants.length) return [];
    const idsByName = await usersDb.idsByUsernames(participants);
    const names = [];
    for (const [name, id] of idsByName) {
      if (presence.isMutedInRoom(roomName, id)) names.push(name);
    }
    return names;
  }

  // Entrega pra todo mundo que está na sala, INCLUSIVE o remetente.
  //
  // O eco pro próprio autor é de propósito: assim o app não precisa de
  // update otimista nem de deduplicação, e a mensagem só aparece na tela
  // depois que o servidor aceitou. Uma fonte de verdade só.
  function fanOutChat(idsByName, payload) {
    let delivered = 0;
    for (const id of idsByName.values()) {
      delivered += presence.sendToUser(id, payload);
    }
    return delivered;
  }

  // POST /rooms/:roomName/chat { text } — manda uma mensagem.
  //
  // O rate limit vem DEPOIS do requireAuth de propósito: ele é por
  // usuário (`req.userId`), não por IP, e só existe `req.userId` depois
  // de autenticar.
  app.post("/rooms/:roomName/chat", requireAuth, chatSendRateLimit, async (req, res) => {
    const { roomName } = req.params;
    const { text } = req.body ?? {};

    if (typeof text !== "string") {
      return res.status(400).json({ error: "text obrigatório" });
    }

    const trimmed = text.trim();
    if (!trimmed) {
      return res.status(400).json({ error: "Mensagem vazia." });
    }
    if (trimmed.length > CHAT_MAX_LENGTH) {
      return res.status(400).json({ error: `A mensagem passa de ${CHAT_MAX_LENGTH} caracteres.` });
    }

    try {
      const { room, idsByName, senderName } = await resolveChatContext(roomName, req.userId);
      if (!room) return res.status(404).json({ error: "Sala não encontrada" });

      // Falar exige estar NA sala de verdade (`participants` vem do
      // webhook do LiveKit). Saber o código não basta — e quem foi
      // expulso para de falar sozinho: sair da sala tira da lista, e a
      // próxima mensagem bate neste 403, sem precisar de nenhuma lógica
      // de expulsão aqui dentro.
      if (!senderName) {
        return res.status(403).json({ error: "Você não está nesta transmissão." });
      }

      if (presence.isMutedInRoom(roomName, req.userId)) {
        return res.status(403).json({ error: "Você foi silenciado nesta transmissão." });
      }

      const message = {
        id: `${Date.now()}-${++chatMessageSeq}`,
        from: senderName,
        text: trimmed,
        at: Date.now(),
      };

      presence.pushChatMessage(roomName, message);
      fanOutChat(idsByName, { type: "chat", roomName, message });

      // 204, sem devolver a mensagem: ela chega pelo WebSocket como pra
      // todo mundo. Devolver aqui TAMBÉM obrigaria o app a deduplicar.
      res.status(204).send();
    } catch (err) {
      console.error(`Erro ao enviar mensagem de chat na sala ${roomName}:`, err);
      res.status(500).json({ error: "Não foi possível enviar a mensagem." });
    }
  });

  // GET /rooms/:roomName/chat — o que já foi dito nesta live.
  //
  // Pedido uma vez, ao entrar na sala, pra quem chega no meio não ver
  // uma tela vazia depois de duas horas de conversa.
  //
  // A permissão aqui é `canSeeRoom`, e NÃO "estar na sala" como no POST.
  // Dois motivos: (1) evita uma corrida real — o app pede o histórico
  // logo depois do `room.connect()`, e o `participants` só é preenchido
  // quando o webhook `participant_joined` chega, então exigir presença
  // daria 403 de vez em quando, sem nada de errado ter acontecido; e
  // (2) ler o chat de uma live que você já pode ver é tão público quanto
  // a própria live, enquanto numa sala privada o `canSeeRoom` já exige a
  // allow-list. Resumindo: LER é tão aberto quanto a live; FALAR exige
  // estar lá.
  app.get("/rooms/:roomName/chat", requireAuth, async (req, res) => {
    const { roomName } = req.params;

    const room = roomsState.get(roomName);
    if (!room) return res.status(404).json({ error: "Sala não encontrada" });
    if (!canSeeRoom(room, req.userId)) {
      return res.status(403).json({ error: "Esta transmissão é privada." });
    }

    try {
      res.json({
        messages: presence.chatHistoryFor(roomName),
        // Quem está silenciado, por NOME — e pra TODO MUNDO na sala, não
        // só pro host (2026-09-23, pedido do usuário: o selo de
        // silenciado aparece na lista de espectadores dos dois lados).
        //
        // Sai em nomes, e não nos ids que o servidor guarda, porque toda
        // lista do app é de nomes (a identity do LiveKit). O id continua
        // sendo a chave interna, que é o que sobrevive a uma renomeação
        // — ver `mutedInRoom` em presence.js.
        //
        // Inclui só quem está na sala AGORA: é o que as listas desenham,
        // e resolver só esses nomes é uma consulta só.
        mutedNames: await mutedNamesInRoom(roomName, room.participants),
      });
    } catch (err) {
      console.error(`Erro ao ler o chat da sala ${roomName}:`, err);
      res.status(500).json({ error: "Não foi possível carregar o chat." });
    }
  });

  // POST /rooms/:roomName/chat/mute { username, muted } — o host cala
  // (ou descala) alguém na própria live.
  //
  // Silenciar é menos que expulsar, de propósito: a pessoa continua
  // assistindo, só para de escrever. E morre com a sala igual ao resto —
  // não é banimento, e não sobrevive à live.
  app.post("/rooms/:roomName/chat/mute", requireAuth, async (req, res) => {
    const { roomName } = req.params;
    const { username, muted } = req.body ?? {};

    if (typeof username !== "string" || !username) {
      return res.status(400).json({ error: "username obrigatório" });
    }
    if (typeof muted !== "boolean") {
      return res.status(400).json({ error: "muted deve ser true ou false" });
    }

    const room = roomsState.get(roomName);
    if (!room) return res.status(404).json({ error: "Sala não encontrada" });

    // Mesma checagem de host do /invite e do /kick. O `req.username` é
    // confiável desde 2026-09-23 (vem do banco, não do JWT — ver
    // auth/jwt.js), então não precisa de consulta própria aqui.
    if (room.hostName !== req.username) {
      return res.status(403).json({ error: "Só o host pode silenciar." });
    }
    if (username === room.hostName) {
      return res.status(400).json({ error: "O host não pode se silenciar." });
    }

    try {
      const target = await usersDb.findByUsername(username);
      if (!target) return res.status(404).json({ error: "Usuário não encontrado" });

      if (muted) {
        presence.muteInRoom(roomName, target.id);
      } else {
        presence.unmuteInRoom(roomName, target.id);
      }

      // Avisa a SALA INTEIRA, e não só quem foi silenciado (2026-09-23).
      //
      // Duas coisas dependem disso, e só a primeira existia antes: a
      // própria pessoa desabilita o campo de texto em vez de escrever e
      // tomar 403; e TODO MUNDO atualiza o selo de silenciado na lista
      // de espectadores — sem isto o selo só apareceria pra quem
      // recarregasse o histórico.
      //
      // O `username` vai no pacote porque é ele que cada app usa nos
      // dois casos: comparar com o próprio nome pra saber se é sobre
      // mim, e casar com a linha certa da lista.
      const idsByName = await usersDb.idsByUsernames(room.participants);
      for (const id of idsByName.values()) {
        presence.sendToUser(id, { type: "chatMuted", roomName, username, muted });
      }

      console.log(
        `[chat] ${req.username} ${muted ? "silenciou" : "liberou"} ${username} na sala ${roomName}`,
      );
      res.status(204).send();
    } catch (err) {
      console.error(`Erro ao silenciar ${username} na sala ${roomName}:`, err);
      res.status(500).json({ error: "Não foi possível silenciar este usuário." });
    }
  });
}

module.exports = { setupChatRoutes, CHAT_MAX_LENGTH };
