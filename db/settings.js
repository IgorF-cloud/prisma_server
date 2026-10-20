// Os ajustes do servidor que um administrador muda em tempo de execução
// (2026-09-18). Hoje é um só: o teto de contas.
//
// Tabela de linha única (migration 005), mesmo padrão do `app_version` —
// por isso todas as queries daqui fixam `id = 1` em vez de aceitar um id
// de fora.

// `pool` (e não só `query`) porque a reserva de vaga abaixo precisa de
// uma CONEXÃO fixa: o lock e o INSERT têm que acontecer na mesma
// transação, e `query` pega uma conexão qualquer do pool a cada chamada.
const { pool, query } = require("./index");

function toPublic(row) {
  return {
    maxUsers: row.max_users,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by ?? null,
  };
}

async function get() {
  const { rows } = await query("SELECT * FROM app_settings WHERE id = 1");
  return rows[0] ? toPublic(rows[0]) : null;
}

async function setMaxUsers(maxUsers, byUserId) {
  const { rows } = await query(
    `UPDATE app_settings
        SET max_users  = $1,
            updated_by = $2,
            updated_at = now()
      WHERE id = 1
      RETURNING *`,
    [maxUsers, byUserId ?? null],
  );
  return rows[0] ? toPublic(rows[0]) : null;
}

// Quantas contas existem e quantas cabem. Usado pelo painel pra desenhar
// o "12 de 50".
//
// Conta TUDO, inclusive bloqueadas (decisão do usuário, 2026-09-18).
// "Vaga" passa a significar "linha na tabela", que é simples de explicar
// — e evita o modo de falha estranho da alternativa: se bloqueada não
// contasse, DESBLOQUEAR alguém poderia falhar por limite cheio.
async function usage() {
  const { rows } = await query(
    "SELECT (SELECT count(*)::int FROM users) AS total, max_users FROM app_settings WHERE id = 1",
  );
  if (!rows[0]) return null;
  return { total: rows[0].total, maxUsers: rows[0].max_users };
}

// ---------------------------------------------------------------------
// A RESERVA DE VAGA
//
// O cadastro é "conta quantos existem, depois insere" — e isso, sem
// cuidado, é uma corrida clássica: duas pessoas se cadastrando no mesmo
// instante leem 49 de 50 e as duas inserem. Fica 51.
//
// `pg_advisory_xact_lock` resolve: o segundo cadastro simultâneo espera o
// primeiro terminar a transação e só então conta, já enxergando a linha
// nova. É um lock de APLICAÇÃO, preso a esta transação — não tranca a
// tabela `users`, então login, listagem e qualquer outra coisa seguem
// normalmente enquanto ele existe.
//
// O número é arbitrário e só precisa ser único dentro do servidor: é a
// chave que identifica ESTE lock.
//
// Alternativas descartadas: isolamento SERIALIZABLE (resolveria, mas
// espalharia erros de serialização por caminhos que não têm nada a ver
// com isto) e trigger no banco (a regra viraria invisível pra quem lê o
// código do cadastro).
// ---------------------------------------------------------------------
const REGISTER_LOCK_KEY = 815263;

/**
 * Roda `run(client)` com a vaga garantida.
 *
 * Devolve `{ ok: false, total, maxUsers }` quando não há vaga — e nesse
 * caso `run` NÃO é chamado, então não se cria linha nenhuma.
 * Devolve `{ ok: true, result }` quando havia.
 */
async function withUserSlot(run) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [REGISTER_LOCK_KEY]);

    const { rows } = await client.query(
      "SELECT (SELECT count(*)::int FROM users) AS total, max_users FROM app_settings WHERE id = 1",
    );
    const total = rows[0]?.total ?? 0;
    // Sem linha de ajustes o servidor não inventa um teto: trava. Um
    // limite chutado aqui seria pior que o erro — ou barraria cadastros
    // legítimos, ou deixaria entrar sem limite nenhum.
    const maxUsers = rows[0]?.max_users;
    if (maxUsers === undefined) {
      throw new Error("app_settings sem linha id=1 — migration 005 não rodou?");
    }

    if (total >= maxUsers) {
      await client.query("ROLLBACK");
      return { ok: false, total, maxUsers };
    }

    const result = await run(client);
    await client.query("COMMIT");
    return { ok: true, result, total: total + 1, maxUsers };
  } catch (err) {
    // `catch {}` no rollback de propósito: se a transação já morreu, o
    // ROLLBACK também falha — e o erro que importa é o de cima, não este.
    try {
      await client.query("ROLLBACK");
    } catch {
      /* transação já perdida */
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { get, setMaxUsers, usage, withUserSlot };
