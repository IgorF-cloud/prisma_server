// Todo o SQL de usuário (2026-09-10). Nenhuma query solta no server.js —
// as rotas de lá chamam estas funções.
//
// O FORMATO DE SAÍDA NÃO MUDOU com a ida pro Postgres: `publicUser`
// devolve exatamente o mesmo `{id, name, avatar, settings}` que o app já
// consome desde o userList.json. Isso é de propósito — o renderer, o
// preload e o `AuthUser` do Electron não precisam saber que o
// armazenamento trocou.

const { query } = require("./index");

// Nome de coluna -> chave do objeto `settings` que o app conhece. Config
// nova entra AQUI e na migration; o resto (leitura, validação, PUT) sai
// de graça, sem tocar em mais nenhum lugar.
const SETTINGS_COLUMNS = {
  alert_for_new_lives: "alertForNewLives",
  show_viewers_overlay: "showViewersOverlay",
  new_live_alerts: "newLiveAlerts",
};

// Avatar custom do jeito que os clientes esperam: `{type, version, id,
// format}`. Uma função só porque são DOIS lugares que montam isto
// (publicUser e avatarsDirectory) e o `format` novo não podia entrar
// num e esquecer o outro.
//
// `format` (2026-10-19, avatar em GIF): "gif" quando a pessoa mandou um
// GIF animado, "webp" pra foto parada — e pra toda conta anterior a
// isso, que não tem o campo gravado. Quem tem GIF tem OS DOIS arquivos
// em disco: o `<id>.gif` e uma cópia parada em `<id>.webp` (primeiro
// quadro), que é o que as versões antigas do app — que não conhecem o
// campo e montam sempre `.webp` — continuam mostrando.
function customAvatarOf(avatar, id) {
  return {
    type: "custom",
    version: avatar.version,
    id,
    format: avatar.format === "gif" ? "gif" : "webp",
  };
}

// Monta o objeto do jeito que o app espera. O avatar custom carrega o
// `id` do usuário junto porque é ele que monta a URL da foto
// (/avatars/<id>.webp) — o banco guarda só `{type, version}`, sem
// duplicar o id dentro do jsonb.
function publicUser(row) {
  const settings = {};
  for (const [column, key] of Object.entries(SETTINGS_COLUMNS)) {
    settings[key] = row[column];
  }

  let avatar = row.avatar ?? null;
  if (avatar && avatar.type === "custom") {
    avatar = customAvatarOf(avatar, row.id);
  }

  return {
    id: row.id,
    name: row.username,
    avatar,
    settings,
    // A PREFERENCIA de presenca ("available" | "busy"), nao o estado.
    // Quem esta online de verdade sai do presence.js, que olha os
    // WebSockets abertos — o banco nao sabe disso e nem deve saber.
    presence: row.presence_preference,
  };
}

// O MESMO objeto do publicUser, mais o e-mail (2026-09-11, pedido do
// usuário: mostrar o e-mail no box de perfil).
//
// Função SEPARADA, e não um campo novo no publicUser, por um motivo que
// não é estilo: o `publicUser` também monta o `GET /users`, que devolve
// TODO MUNDO pra sidebar de usuários (ver listAll abaixo). Um `email`
// dentro dele vazaria o endereço de cada usuário pra todos os outros,
// em silêncio.
//
// Use esta SÓ nas rotas em que o destinatário é o próprio dono dos
// dados — na prática, as que passam por `requireSelf`, mais /login,
// /register e /me.
function privateUser(row) {
  return {
    ...publicUser(row),
    email: row.email,
    // 2026-09-16: os dois existem pro app e pro painel saberem o que
    // mostrar — o painel de admin só aparece pra quem é admin, e a tela
    // de login precisa distinguir "pendente" de "bloqueado".
    //
    // ⚠️ Só aqui, NUNCA no publicUser: aquele monta o GET /users, que
    // devolve todo mundo pra lista do app. `isAdmin` ali contaria pra
    // qualquer usuário quem vale a pena atacar.
    isAdmin: row.is_admin,
    status: row.status,
  };
}

// A lista do PAINEL. Existe separada do publicUser/privateUser porque o
// destinatário é outro: um admin olhando as contas dos outros. É o único
// lugar do servidor em que e-mail alheio sai do banco — por isso a rota
// que usa isto passa por requireAdmin, e não só por requireAuth.
function adminUser(row) {
  return {
    id: row.id,
    name: row.username,
    email: row.email,
    status: row.status,
    isAdmin: row.is_admin,
    createdAt: row.created_at,
    // Última autenticação (migration 006). `null` = nenhuma desde que
    // isto passou a ser gravado — o painel mostra um traço, e não uma
    // data inventada. Sai só por AQUI: quando alguém usou o app pela
    // última vez é informação de administração, e não entra no
    // publicUser (que vai pra todo mundo) nem no privateUser.
    lastLoginAt: row.last_login_at,
    // Com o QUÊ entrou naquela vez (migration 007). Os dois são `null`
    // quando o cliente não se identificou — ver `touchLastLogin`.
    lastLoginVersion: row.last_login_version,
    lastLoginPlatform: row.last_login_platform,
    statusUpdatedAt: row.status_updated_at,
    statusUpdatedBy: row.status_updated_by,
    avatar: publicUser(row).avatar,
  };
}

async function findByUsername(username) {
  // Case-SENSITIVE por decisão do usuário: "igor" e "Igor" são contas
  // diferentes, então a comparação é direta, sem lower().
  const { rows } = await query("SELECT * FROM users WHERE username = $1", [username]);
  return rows[0] ?? null;
}

// Varios nomes -> ids, numa consulta so (2026-09-23, chat da live).
//
// Existe pra NAO fazer um findByUsername por destinatario a cada mensagem
// enviada: o fan-out do chat precisa dos ids de todo mundo que esta na
// sala, e o roomsState guarda NOMES (a identity do LiveKit). Uma live com
// 10 espectadores viraria 10 consultas por mensagem.
//
// Case-SENSITIVE igual ao findByUsername acima, pelo mesmo motivo: e a
// mesma comparacao, so que em lote.
//
// Devolve um Map(username -> id). Nome que nao existe mais no banco
// simplesmente nao aparece no Map — quem chama trata como "nao entrego
// pra esse".
async function idsByUsernames(usernames) {
  if (!usernames.length) return new Map();
  const { rows } = await query("SELECT id, username FROM users WHERE username = ANY($1)", [
    usernames,
  ]);
  return new Map(rows.map((row) => [row.username, row.id]));
}

async function findById(id) {
  const { rows } = await query("SELECT * FROM users WHERE id = $1", [id]);
  return rows[0] ?? null;
}

// Recuperação de senha (2026-09-10). Case-INSENSITIVE, ao contrário do
// username: o índice único do e-mail é sobre `lower(email)` (migration
// 001), então "Igor@x.com" e "igor@x.com" são a mesma conta — digitar
// com a caixa errada não pode impedir alguém de recuperar a própria
// senha.
async function findByEmail(email) {
  const { rows } = await query("SELECT * FROM users WHERE lower(email) = lower($1)", [email]);
  return rows[0] ?? null;
}

// Mata TODO token já emitido pra esta conta (migration 003). Chamado em
// qualquer troca de senha — é o que faz "trocar a senha" também
// significar "expulsar quem estava dentro".
//
// ⚠️ Quem chama TEM que avisar o cache em memória do auth/jwt.js
// (`invalidateTokenVersion`), senão o token velho continua passando até
// o servidor reiniciar. As duas coisas andam juntas.
async function bumpTokenVersion(id) {
  const { rows } = await query(
    `UPDATE users SET token_version = token_version + 1, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id],
  );
  return rows[0] ?? null;
}

// Diz QUAL campo colidiu, e não só "já existe": a tela de cadastro
// precisa apontar o erro no campo certo (pedido do usuário).
async function findConflict(username, email) {
  const { rows } = await query(
    `SELECT
       EXISTS (SELECT 1 FROM users WHERE username = $1)          AS username_taken,
       EXISTS (SELECT 1 FROM users WHERE lower(email) = lower($2)) AS email_taken`,
    [username, email],
  );
  return { usernameTaken: rows[0].username_taken, emailTaken: rows[0].email_taken };
}

const INSERT_USER_SQL = `INSERT INTO users (username, email, password_hash)
     VALUES ($1, $2, $3)
     RETURNING *`;

async function create({ username, email, passwordHash }) {
  const { rows } = await query(INSERT_USER_SQL, [username, email, passwordHash]);
  return rows[0];
}

// O MESMO insert, mas numa conexão que quem chama controla.
//
// Existe por causa do teto de contas (2026-09-18): a contagem e a criação
// precisam acontecer na mesma transação, senão dois cadastros
// simultâneos passam os dois pelo limite. Ver `withUserSlot` em
// db/settings.js — é ele quem abre a transação e passa o `client` aqui.
//
// A `status` não é informada: o default da coluna é 'active' desde a
// migration 005, e essa é justamente a decisão que a transação acabou de
// tomar ao confirmar que havia vaga.
async function createWith(client, { username, email, passwordHash }) {
  const { rows } = await client.query(INSERT_USER_SQL, [username, email, passwordHash]);
  return rows[0];
}

// UPDATE parcial: monta só as colunas que vieram. Ausente ≠ null — o
// avatar pode ser apagado de propósito (null), então o que decide se a
// coluna entra no SET é a CHAVE existir no objeto, não o valor.
async function update(id, { username, avatar, settings, passwordHash }) {
  const sets = [];
  const values = [];

  function push(column, value) {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  }

  if (username !== undefined) push("username", username);
  if (avatar !== undefined) push("avatar", avatar === null ? null : JSON.stringify(avatar));
  if (passwordHash !== undefined) push("password_hash", passwordHash);

  if (settings !== undefined) {
    for (const [column, key] of Object.entries(SETTINGS_COLUMNS)) {
      if (settings[key] !== undefined) push(column, settings[key]);
    }
  }

  if (!sets.length) return findById(id);

  sets.push("updated_at = now()");
  values.push(id);

  const { rows } = await query(
    `UPDATE users SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING *`,
    values,
  );
  return rows[0] ?? null;
}

// Lista pra sidebar de usuarios (GET /users). Traz quem esta offline
// tambem — quem esta online e sobreposto por cima, no servidor. Ordena
// por nome pra lista nao dancar a cada render.
//
// ⚠️ SÓ CONTAS ATIVAS (2026-09-17, pedido do usuário). Quem está
// pendente, recusado ou bloqueado não aparece pra ninguém.
//
// O filtro vive AQUI, e não no app, por dois motivos:
//
//   - não dava pra fazer no cliente nem se quiséssemos: o `publicUser`
//     não devolve `status`, e ele não pode devolver — esta lista vai
//     pra todo mundo, e a situação da conta alheia não é da conta de
//     ninguém;
//   - filtrando no servidor, o app Windows e o Android herdam a regra
//     de graça, sem cada um repetir a mesma condição.
//
// Quem administra continua vendo todos, por outro caminho:
// `listForAdmin` (GET /admin/users), atrás de `requireAdmin`.
async function listAll() {
  const { rows } = await query(
    "SELECT * FROM users WHERE status = 'active' ORDER BY lower(username)",
  );
  return rows.map(publicUser);
}

// Pro painel. Ordena por SITUAÇÃO antes do nome.
//
// Simplificado em 2026-09-18, quando sobraram duas situações: ativas
// primeiro, bloqueadas depois. Antes o topo era dos `pending`, porque
// eram os que exigiam ação — com a aprovação manual removida, não há
// mais nada esperando decisão, e o que faz sentido é a lista normal
// vindo primeiro.
async function listForAdmin() {
  const { rows } = await query(
    `SELECT * FROM users
      ORDER BY CASE status
                 WHEN 'active'  THEN 0
                 WHEN 'blocked' THEN 1
                 ELSE 2
               END,
               lower(username)`,
  );
  return rows.map(adminUser);
}

// Liga/desliga o acesso de administrador (2026-09-16).
//
// Só o flag, sem tocar na situação da conta: conceder admin e liberar uma
// conta são duas decisões diferentes, e juntá-las aqui esconderia uma
// delas. Quem impede o caso sem sentido — admin numa conta que não pode
// entrar — é a rota, que recusa com uma mensagem explicando.
async function setAdmin(id, isAdmin) {
  const { rows } = await query(
    "UPDATE users SET is_admin = $2, updated_at = now() WHERE id = $1 RETURNING *",
    [id, isAdmin],
  );
  return rows[0] ?? null;
}

// Muda a situação de uma conta e registra quem mexeu.
//
// Devolve a linha atualizada (ou null se o id não existe) pra rota poder
// responder com o estado novo sem uma segunda consulta.
async function setStatus(id, status, byUserId) {
  const { rows } = await query(
    `UPDATE users
        SET status            = $2,
            status_updated_at = now(),
            status_updated_by = $3
      WHERE id = $1
      RETURNING *`,
    [id, status, byUserId ?? null],
  );
  return rows[0] ?? null;
}

// Apaga a conta de vez (2026-09-17, painel de administração).
//
// Devolve a linha APAGADA, e não só `true`: quem chama precisa do
// `username` pro log e do `id` pra apagar a foto em disco — e depois do
// DELETE não existe mais onde buscar isso.
//
// As chaves estrangeiras que apontam pra cá já dizem o que fazer com o
// resto, e é por isso que este DELETE não limpa mais nada no banco:
//
//   password_resets.user_id   ON DELETE CASCADE    (some junto)
//   users.status_updated_by   ON DELETE SET NULL   (vira nulo)
//   app_version.updated_by    ON DELETE SET NULL   (vira nulo)
//
// O `SET NULL` nos dois últimos é o que evita o caso chato: apagar um
// administrador NÃO apaga o histórico do que ele liberou nem a versão
// que ele publicou — perde-se só o nome de quem fez.
//
// ⚠️ O que ESTE módulo não faz é apagar a FOTO
// (`data/avatars/<id>.webp`), que é arquivo e não linha. Quem chama
// cuida disso — ver `DELETE /admin/users/:id` em admin.js.
async function remove(id) {
  const { rows } = await query("DELETE FROM users WHERE id = $1 RETURNING *", [id]);
  return rows[0] ?? null;
}

// Carimba o instante desta autenticação (migration 006).
//
// Chamado no /login E no /me — os dois, porque são os dois jeitos de
// entrar no app: digitar a senha, ou o "manter conectado" restaurando a
// sessão gravada em disco. Só no /login, quem nunca é deslogado (a
// sessão é DESLIZANTE: renova 30 dias a cada abertura) apareceria no
// painel com um último acesso de meses atrás enquanto usa o app todo
// dia — o dado erraria justamente nos usuários mais ativos.
//
// NÃO mexe em `updated_at`: aquela coluna conta mudança de dado da conta
// (nome, avatar, senha), e entrar no app não é uma. Misturar as duas
// faria toda entrada parecer uma edição de perfil.
//
// ⚠️ Quem chama não espera por isto nem deixa uma falha aqui derrubar a
// autenticação — é escrituração, não parte do login. Ver `recordAccess`
// no server.js.
// Junto da data, QUAL cliente entrou (migration 007): `{ platform,
// version }`, já validado por quem chama — aqui não chega texto cru de
// header.
//
// Os dois são gravados SEMPRE, inclusive como `null`, e de propósito:
// eles descrevem ESTE acesso. Preservar o valor anterior quando o
// cliente não se identifica (um app antigo, que não manda o header)
// atribuiria a versão de um acesso a outro — e o painel afirmaria com
// segurança uma coisa que o servidor não sabe.
async function touchLastLogin(id, { platform = null, version = null } = {}) {
  await query(
    `UPDATE users
        SET last_login_at       = now(),
            last_login_version  = $2,
            last_login_platform = $3
      WHERE id = $1`,
    [id, version, platform],
  );
}

async function setPresencePreference(id, preference) {
  const { rows } = await query(
    `UPDATE users SET presence_preference = $1, updated_at = now()
      WHERE id = $2 RETURNING *`,
    [preference, id],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------
// Fixar usuarios na lista (migration 008, 2026-09-25)
// ---------------------------------------------------------------------
//
// Preferencia PESSOAL: tudo aqui e sempre do ponto de vista de UM dono
// (`ownerId`). Nao existe "quem me fixou" — nao e pergunta que o app
// faca, e responde-la exporia uma escolha privada de outra pessoa.

// Os ids que ESTE usuario fixou. Devolve array de numeros, na ordem que
// o banco der: quem ordena a lista e o app (alfabetica, decisao do
// usuario), e ordenar aqui por nome exigiria um JOIN so pra jogar fora
// o nome em seguida.
async function listPinnedIds(ownerId) {
  const { rows } = await query("SELECT pinned_id FROM user_pins WHERE owner_id = $1", [ownerId]);
  return rows.map((row) => row.pinned_id);
}

// Fixar. IDEMPOTENTE de proposito (`ON CONFLICT DO NOTHING`): dois
// cliques rapidos, ou o app repetindo a chamada depois de um erro de
// rede, nao podem virar erro — o estado desejado ja e o que esta la.
//
// Devolve `false` quando o id fixado nao existe (chave estrangeira
// violada), pra rota responder 404 em vez de 500. A corrida e real,
// ainda que rara: a conta pode ser apagada entre a lista carregar no app
// e o clique acontecer.
async function pinUser(ownerId, pinnedId) {
  try {
    await query(
      `INSERT INTO user_pins (owner_id, pinned_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
      [ownerId, pinnedId],
    );
    return true;
  } catch (err) {
    // 23503 = foreign_key_violation. Qualquer outro erro sobe: um
    // `catch` que engole tudo transformaria banco fora do ar em
    // "usuario nao encontrado".
    if (err.code === "23503") return false;
    throw err;
  }
}

// Desfixar. Tambem idempotente: desfixar quem nao estava fixado nao e
// erro, e o resultado — "essa pessoa nao esta mais fixada" — e o mesmo.
// Por isso nao devolve nada e a rota sempre responde 204.
async function unpinUser(ownerId, pinnedId) {
  await query("DELETE FROM user_pins WHERE owner_id = $1 AND pinned_id = $2", [ownerId, pinnedId]);
}

// Diretório nome -> avatar que acompanha todo broadcast de salas (item 43
// do roadmap do Electron). Recalculado do zero a cada broadcast, igual
// antes — só a fonte mudou de arquivo pra banco.
async function avatarsDirectory() {
  const { rows } = await query(
    "SELECT id, username, avatar FROM users WHERE avatar IS NOT NULL",
  );
  const directory = {};
  for (const row of rows) {
    const avatar =
      row.avatar.type === "custom"
        ? customAvatarOf(row.avatar, row.id)
        : row.avatar;
    directory[row.username] = avatar;
  }
  return directory;
}

module.exports = {
  publicUser,
  privateUser,
  findByUsername,
  findById,
  findByEmail,
  bumpTokenVersion,
  findConflict,
  create,
  createWith,
  update,
  listAll,
  listForAdmin,
  setStatus,
  remove,
  setAdmin,
  adminUser,
  touchLastLogin,
  setPresencePreference,
  listPinnedIds,
  pinUser,
  unpinUser,
  avatarsDirectory,
  idsByUsernames,
};
