// Amizades no banco (migração 009, 2026-10-21).
//
// Só SQL aqui. Quem decide o que cada operação significa pro resto do
// servidor (o cache, os avisos pelo WebSocket, a sala privada) é o
// friends.js da raiz.

const { pool, query } = require("./index");

// Todas as linhas — pro cache em memória, que carrega no boot e depois
// de o painel apagar uma conta. A tabela é pequena nessa escala (cada
// linha é um par de pessoas), e ter tudo em memória é o que deixa o
// `broadcastRooms` continuar síncrono.
async function listAll() {
  const { rows } = await query(
    "SELECT requester_id, addressee_id, status FROM friendships",
  );
  return rows;
}

// Pedir amizade. Devolve o estado em que o par FICOU:
//
//   "requested" — pedido novo criado;
//   "accepted"  — o outro já tinha me pedido: pedir de volta é aceitar
//                 (os dois querem, não há o que esperar);
//   "pending"   — eu já tinha pedido antes (nada muda);
//   "friends"   — já éramos amigos (nada muda);
//   null        — a outra conta não existe (chave estrangeira).
//
// Numa transação com `FOR UPDATE`: entre ler o par e escrever, o outro
// lado pode estar pedindo a mesma coisa ao mesmo tempo. O índice
// `friendships_pair` garante que só um INSERT vence; quem perde cai no
// 23505 e relê o que o vencedor gravou.
async function request(fromId, toId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await requestInTransaction(client, fromId, toId);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err.code === "23503") return null; // foreign_key_violation
    if (err.code === "23505") {
      // unique_violation: os dois pediram no mesmo instante. A linha do
      // outro já existe agora — tentar de novo vira o aceite.
      return request(fromId, toId);
    }
    throw err;
  } finally {
    client.release();
  }
}

async function requestInTransaction(client, fromId, toId) {
  const { rows } = await client.query(
    `SELECT requester_id, status FROM friendships
      WHERE (requester_id = $1 AND addressee_id = $2)
         OR (requester_id = $2 AND addressee_id = $1)
      FOR UPDATE`,
    [fromId, toId],
  );
  const existing = rows[0];

  if (existing?.status === "accepted") return "friends";
  if (existing && existing.requester_id === fromId) return "pending";
  if (existing) {
    await client.query(
      `UPDATE friendships SET status = 'accepted', accepted_at = now()
        WHERE requester_id = $1 AND addressee_id = $2`,
      [toId, fromId],
    );
    return "accepted";
  }

  await client.query(
    "INSERT INTO friendships (requester_id, addressee_id) VALUES ($1, $2)",
    [fromId, toId],
  );
  return "requested";
}

// Aceitar um pedido que `requesterId` mandou pra `addresseeId`. Só um
// pedido PENDENTE NESSA DIREÇÃO vira amizade — aceitar o próprio pedido
// não pode funcionar. Devolve `true` se aceitou.
async function accept(addresseeId, requesterId) {
  const { rowCount } = await query(
    `UPDATE friendships SET status = 'accepted', accepted_at = now()
      WHERE requester_id = $1 AND addressee_id = $2 AND status = 'pending'`,
    [requesterId, addresseeId],
  );
  return rowCount > 0;
}

// Recusar, cancelar o pedido ou desfazer a amizade — os três são "não
// existe mais nada entre nós" (ver a migração). Devolve o que existia
// antes (`{ requester_id, status }`), ou null se já não havia nada.
async function remove(a, b) {
  const { rows } = await query(
    `DELETE FROM friendships
      WHERE (requester_id = $1 AND addressee_id = $2)
         OR (requester_id = $2 AND addressee_id = $1)
      RETURNING requester_id, status`,
    [a, b],
  );
  return rows[0] ?? null;
}

module.exports = { listAll, request, accept, remove };
