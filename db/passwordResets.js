// SQL da recuperação de senha (2026-09-10). Mesma regra do resto:
// nenhuma query solta no server.js.
//
// O código NUNCA é gravado — só o hash dele (scrypt, o mesmo de senha).
// Quem ler o banco não sai usando o que encontrar.

const { query } = require("./index");

// 15 minutos. Curto o suficiente pra que um código de 6 dígitos não
// fique exposto por horas, longo o suficiente pra caber "abrir o
// e-mail, achar a mensagem, digitar".
const CODE_TTL_MINUTES = 15;

// Tentativas erradas antes de queimar o código. É ESTE teto que impede
// varrer as 1.000.000 combinações dentro da validade — o rate limit por
// IP não resolve sozinho, porque o atacante pode ter vários IPs (ou ser
// o dono legítimo do dele).
const MAX_ATTEMPTS = 5;

// Quantos pedidos a mesma conta pode gerar por hora. Segura o uso do
// endereço de e-mail de alguém como alvo de spam — mesmo sem conseguir
// entrar na conta, dá pra encher a caixa de entrada da pessoa.
const MAX_REQUESTS_PER_HOUR = 5;

async function create(userId, codeHash) {
  const { rows } = await query(
    `INSERT INTO password_resets (user_id, code_hash, expires_at)
     VALUES ($1, $2, now() + ($3 || ' minutes')::interval)
     RETURNING *`,
    [userId, codeHash, String(CODE_TTL_MINUTES)],
  );
  return rows[0];
}

// O pedido VIGENTE: o mais recente que ainda não venceu, não foi usado e
// não estourou as tentativas. Pedir um código novo não apaga o anterior
// (ele ainda conta pro limite por hora), mas o `created_at DESC` garante
// que só o último vale.
async function findActive(userId) {
  const { rows } = await query(
    `SELECT * FROM password_resets
      WHERE user_id = $1
        AND used_at IS NULL
        AND expires_at > now()
        AND attempts < $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId, MAX_ATTEMPTS],
  );
  return rows[0] ?? null;
}

async function countRecent(userId) {
  const { rows } = await query(
    `SELECT count(*)::int AS total FROM password_resets
      WHERE user_id = $1 AND created_at > now() - interval '1 hour'`,
    [userId],
  );
  return rows[0].total;
}

async function registerAttempt(id) {
  const { rows } = await query(
    "UPDATE password_resets SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts",
    [id],
  );
  return rows[0]?.attempts ?? 0;
}

async function markUsed(id) {
  await query("UPDATE password_resets SET used_at = now() WHERE id = $1", [id]);
}

// Limpeza dos vencidos. Chamada no boot (ver server.js): a tabela é uma
// fila de coisas efêmeras, e sem isso ela só cresce. Não precisa de
// agendador — o servidor reinicia com frequência mais que suficiente
// pro volume disso.
async function deleteExpired() {
  const { rowCount } = await query(
    "DELETE FROM password_resets WHERE expires_at < now() - interval '1 day'",
  );
  return rowCount;
}

module.exports = {
  create,
  findActive,
  countRecent,
  registerAttempt,
  markUsed,
  deleteExpired,
  CODE_TTL_MINUTES,
  MAX_ATTEMPTS,
  MAX_REQUESTS_PER_HOUR,
};
