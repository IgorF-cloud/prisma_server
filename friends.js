// Amizades (2026-10-21) — item 26, etapa 5 do roadmap do app.
//
// O vínculo mora no banco (migração 009, db/friends.js); aqui ficam o
// CACHE em memória e as rotas.
//
// POR QUE CACHE: a regra nova da sala privada ("só o dono e os amigos
// dele") é consultada no `canSeeRoom`, que roda dentro do
// `broadcastRooms` — síncrono e chamado de dezenas de pontos (mesmo
// motivo do cache de avatares no server.js). O cache é a cópia INTEIRA
// da tabela, recarregada no boot e depois de o painel apagar uma conta,
// e atualizada a cada escrita que passa por aqui. Ninguém mais escreve
// em `friendships`.
//
// COMO O APP FICA SABENDO: toda mudança manda, pros DOIS lados, o
// retrato completo das relações de cada um (`type: "friends"` no
// /ws/rooms) — o mesmo retrato que vai no connect e que o GET /friends
// devolve. Um retrato e não um "evento": o app nunca precisa juntar
// pedaços, e uma mensagem perdida é corrigida pela próxima.
//
// ADITIVO: rotas novas e um `type` novo no WebSocket, que o app 1.5
// ignora (ver o cabeçalho de chat.js).

// userId -> Map(outroId -> "friend" | "outgoing" | "incoming")
//   outgoing = EU pedi e o outro ainda não respondeu
//   incoming = o outro me pediu
let relations = new Map();

function relationsOf(userId) {
  let map = relations.get(userId);
  if (!map) {
    map = new Map();
    relations.set(userId, map);
  }
  return map;
}

function setRelation(a, b, aSees, bSees) {
  relationsOf(a).set(b, aSees);
  relationsOf(b).set(a, bSees);
}

function clearRelation(a, b) {
  relations.get(a)?.delete(b);
  relations.get(b)?.delete(a);
}

function areFriends(a, b) {
  if (a == null || b == null) return false;
  return relations.get(a)?.get(b) === "friend";
}

function friendIdsOf(userId) {
  const ids = [];
  for (const [otherId, kind] of relations.get(userId) ?? []) {
    if (kind === "friend") ids.push(otherId);
  }
  return ids;
}

// O retrato que o app recebe. Três listas de ids, e não um mapa: é o
// formato que o React usa direto (`new Set(friends)`), e o mesmo que o
// `pinned` do GET /users já segue.
function snapshotFor(userId) {
  const snapshot = { friends: [], incoming: [], outgoing: [] };
  for (const [otherId, kind] of relations.get(userId) ?? []) {
    if (kind === "friend") snapshot.friends.push(otherId);
    else if (kind === "incoming") snapshot.incoming.push(otherId);
    else snapshot.outgoing.push(otherId);
  }
  return snapshot;
}

function setupFriends({
  app,
  requireAuth,
  friendRequestRateLimit,
  friendsDb,
  usersDb,
  presence,
  onFriendshipChanged,
}) {
  async function reload() {
    try {
      const rows = await friendsDb.listAll();
      // Trocado DEPOIS do await: o mapa velho segue valendo enquanto o
      // banco responde, e o novo entra inteiro de uma vez.
      relations = new Map();
      for (const row of rows) {
        const a = row.requester_id;
        const b = row.addressee_id;
        if (row.status === "accepted") setRelation(a, b, "friend", "friend");
        else setRelation(a, b, "outgoing", "incoming");
      }
      console.log(`[friends] cache carregado (${rows.length} vínculo(s))`);
    } catch (err) {
      console.error("[friends] erro ao carregar o cache:", err);
    }
  }

  function pushSnapshot(userId) {
    presence.sendToUser(userId, { type: "friends", ...snapshotFor(userId) });
  }

  // Depois de QUALQUER mudança: os dois lados recebem o retrato novo, e
  // o server.js reavalia as salas privadas (quem virou amigo passa a ver;
  // quem deixou de ser, deixa de ver — e sai, se estiver assistindo).
  function changed(a, b) {
    pushSnapshot(a);
    pushSnapshot(b);
    onFriendshipChanged?.(a, b);
  }

  // `:id` é sempre a OUTRA pessoa; quem age é o autenticado. Mesmo
  // desenho das rotas de fixar (POST /users/:id/pin).
  function targetId(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "id inválido" });
      return null;
    }
    if (id === req.userId) {
      res.status(400).json({ error: "Não dá para ser amigo de si mesmo." });
      return null;
    }
    return id;
  }

  app.get("/friends", requireAuth, (req, res) => {
    res.json(snapshotFor(req.userId));
  });

  // Pedir amizade. Se o outro já tinha me pedido, vira aceite na hora —
  // os dois querem a mesma coisa (ver db/friends.js `request`).
  app.post("/friends/:id/request", requireAuth, friendRequestRateLimit, async (req, res) => {
    const id = targetId(req, res);
    if (id == null) return;

    try {
      // Conta bloqueada ou pendente não aparece em lista nenhuma do app;
      // um pedido pra ela só existiria por chamada direta à rota.
      const target = await usersDb.findById(id);
      if (!target || target.status !== "active") {
        return res.status(404).json({ error: "Usuário não encontrado" });
      }

      const result = await friendsDb.request(req.userId, id);
      if (result === null) return res.status(404).json({ error: "Usuário não encontrado" });

      if (result === "requested") {
        setRelation(req.userId, id, "outgoing", "incoming");
        console.log(`[friends] ${req.username} pediu amizade a userId=${id}`);
        changed(req.userId, id);
      } else if (result === "accepted") {
        setRelation(req.userId, id, "friend", "friend");
        console.log(`[friends] ${req.username} e userId=${id} agora são amigos (pedido cruzado)`);
        changed(req.userId, id);
      }
      // "pending" e "friends": nada mudou, e não é erro — o estado pedido
      // já é o que está lá. O retrato vai mesmo assim só pra quem pediu,
      // caso o app dele estivesse desatualizado.
      else pushSnapshot(req.userId);

      res.json(snapshotFor(req.userId));
    } catch (err) {
      console.error("Erro ao pedir amizade:", err);
      res.status(500).json({ error: "Erro interno ao pedir amizade" });
    }
  });

  // Aceitar um pedido que o `:id` me mandou.
  app.post("/friends/:id/accept", requireAuth, async (req, res) => {
    const id = targetId(req, res);
    if (id == null) return;

    try {
      const accepted = await friendsDb.accept(req.userId, id);
      if (!accepted) {
        // Cancelado pelo outro lado entre o app desenhar o botão e o
        // clique. O retrato corrige a tela de quem clicou.
        pushSnapshot(req.userId);
        return res.status(409).json({ error: "Este pedido não existe mais." });
      }
      setRelation(req.userId, id, "friend", "friend");
      console.log(`[friends] ${req.username} aceitou o pedido de userId=${id}`);
      changed(req.userId, id);
      res.json(snapshotFor(req.userId));
    } catch (err) {
      console.error("Erro ao aceitar amizade:", err);
      res.status(500).json({ error: "Erro interno ao aceitar o pedido" });
    }
  });

  // Recusar um pedido recebido, cancelar um pedido enviado ou desfazer
  // a amizade — a mesma rota, porque o resultado é o mesmo: não existe
  // mais nada entre as duas pessoas. Sempre 200 com o retrato, inclusive
  // quando já não havia nada (o estado pedido já é verdade).
  app.delete("/friends/:id", requireAuth, async (req, res) => {
    const id = targetId(req, res);
    if (id == null) return;

    try {
      const removed = await friendsDb.remove(req.userId, id);
      if (removed) {
        clearRelation(req.userId, id);
        console.log(
          `[friends] ${req.username} desfez (${removed.status}) o vínculo com userId=${id}`,
        );
        changed(req.userId, id);
      }
      res.json(snapshotFor(req.userId));
    } catch (err) {
      console.error("Erro ao desfazer amizade:", err);
      res.status(500).json({ error: "Erro interno ao desfazer a amizade" });
    }
  });

  return { reload, pushSnapshot };
}

module.exports = { setupFriends, areFriends, friendIdsOf, snapshotFor };
