// Autenticação por JWT, por usuário (2026-09-10) — item 3 do ROADMAP.
//
// SUBSTITUI o `TOKEN_API_SECRET` compartilhado, que era o mesmo pra todo
// mundo e vinha em texto puro dentro do installer/config.json instalado
// na máquina de cada usuário. Qualquer um que abrisse aquele arquivo
// tinha acesso total à API.
//
// CONSEQUÊNCIA da troca, e ela é importante: o segredo compartilhado
// protegia TUDO, inclusive /register e /login. Com token por usuário
// esses dois viram PÚBLICOS por definição — não existe token antes de
// existir conta. É por isso que o rate limiting (auth/rateLimit.js)
// deixou de ser opcional: sem ele, /login fica aberto pra força bruta.

const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET;
// 30 dias: o app é desktop e guarda a sessão em disco, então pedir login
// toda semana seria só atrito. Quando expira, o app volta pra tela de
// login sozinho (ver o tratamento de 401 no main do Electron).
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "30d";

if (!JWT_SECRET) {
  // Falha no boot, e não no primeiro login: sem segredo o jsonwebtoken
  // lança em cada request, e o servidor pareceria "de pé" respondendo
  // 500 pra tudo.
  throw new Error("JWT_SECRET não está definido no .env — o servidor não pode subir sem ele.");
}

function sign(user) {
  // Só o necessário pra identificar. NADA de e-mail, avatar ou settings
  // aqui: o payload de um JWT é apenas base64, qualquer um lê. E, se
  // fosse, o token ficaria desatualizado no instante em que o usuário
  // trocasse o nome.
  //
  // `tv` (token version, 2026-09-10) é a exceção que vale o espaço: é o
  // que dá REVOGAÇÃO a um token que, por natureza, não tem. Ver
  // requireAuth abaixo e a migration 003.
  //
  // ⚠️ O `username` abaixo é INFORMATIVO desde 2026-09-23 — nada de
  // autorização pode sair dele. A ironia é que o parágrafo acima já
  // descrevia o problema ("o token ficaria desatualizado no instante em
  // que o usuário trocasse o nome") enquanto o campo estava logo aqui,
  // fazendo exatamente isso: o `req.username` saía daqui e ficava velho
  // depois de uma renomeação, o que quebrava o /invite e o /kick da
  // própria live de quem se renomeou. Quem responde "quem é essa
  // pessoa AGORA" é o cache alimentado pelo banco, ver requireAuth.
  //
  // Continua no payload só por compatibilidade com os tokens já
  // emitidos (valem 30 dias); tirar não traria ganho nenhum.
  return jwt.sign(
    { sub: String(user.id), username: user.username, tv: user.token_version },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  );
}

// userId -> { tokenVersion, username }, em memória.
//
// Existe porque, sem cache, conferir a revogação custaria uma ida ao
// banco em CADA request autenticado. Como o servidor é um container só
// (mesma premissa do rate limiting em memória, ver rateLimit.js), um
// Map local é suficiente e é invalidado na hora por quem incrementa.
//
// O `username` entrou aqui em 2026-09-23 junto com a correção abaixo — e
// DE GRAÇA: a consulta que preenche esta entrada já era feita, só o
// nome não estava sendo aproveitado.
//
// ⚠️ No dia em que houver mais de uma instância, isto vira incorreto:
// bumpar numa não limparia o cache da outra, e um token revogado
// continuaria válido pela instância que não soube. Aí o lugar disso é o
// Redis que já está no compose.
const userCache = new Map();

// Descarta o que está em cache sobre um usuário.
//
// O nome fala em "token version" por herança (era só isso que morava
// aqui), mas desde 2026-09-23 a entrada guarda o NOME também — então
// chamar isto é obrigatório em DOIS momentos, não um:
//
//   1. quando a `token_version` muda (troca/reset de senha, bloqueio);
//   2. quando o USUÁRIO SE RENOMEIA (ver PUT /users/:id no server.js).
//
// Esquecer o caso 2 traz de volta exatamente o bug que a mudança abaixo
// corrigiu.
function invalidateTokenVersion(userId) {
  userCache.delete(Number(userId));
}

// Middleware. Deixa `req.userId` pronto pras rotas.
//
// Assíncrono desde 2026-09-10 — precisa consultar a token_version. O
// Express aceita middleware async normalmente, MAS não captura rejeição
// de promise sozinho (só a partir do Express 5), daí o try/catch cobrir
// o corpo inteiro em vez de só o `jwt.verify`.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "unauthorized" });
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    // `code` separado do 401 genérico de propósito: o app precisa
    // distinguir "token venceu, mande o usuário logar de novo" de
    // "token inválido/ausente" pra não deslogar em um erro qualquer.
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "token expirado", code: "token_expired" });
    }
    return res.status(401).json({ error: "unauthorized" });
  }

  const userId = Number(payload.sub);

  let cached;
  try {
    cached = userCache.get(userId);
    if (cached === undefined) {
      // `require` aqui dentro, e não no topo: db/users.js importa
      // db/index.js, que abre o pool do Postgres. No topo, este módulo
      // passaria a exigir banco só pra ser carregado — e ele é
      // carregado antes do `waitForDatabase()` do boot.
      const usersDb = require("../db/users");
      const user = await usersDb.findById(userId);
      // Conta apagada com token ainda válido na mão: não existe mais
      // versão pra comparar, então não passa.
      if (!user) return res.status(401).json({ error: "unauthorized" });
      cached = { tokenVersion: user.token_version, username: user.username };
      userCache.set(userId, cached);
    }

    // Tokens emitidos ANTES da migration 003 não têm o claim. Tratados
    // como revogados de propósito: são exatamente os tokens que a
    // revogação existe pra invalidar, e o app já sabe voltar pro login
    // com este `code`.
    if (payload.tv !== cached.tokenVersion) {
      return res.status(401).json({ error: "token revogado", code: "token_expired" });
    }
  } catch (err) {
    console.error("Erro ao conferir a versão do token:", err);
    return res.status(500).json({ error: "Erro interno de autenticação" });
  }

  req.userId = userId;
  // BUG REAL corrigido em 2026-09-23: isto era `payload.username`, o
  // nome gravado no JWT no momento do LOGIN.
  //
  // Renomear NÃO reemite o token nem sobe a `token_version` (é de
  // propósito: trocar de nome não deveria deslogar ninguém). O efeito
  // era que, depois de se renomear, a pessoa continuava se apresentando
  // pelo nome ANTIGO em toda rota — por até 30 dias, que é a validade do
  // token, ou até ela relogar.
  //
  // Isso quebrava de verdade, e não só em texto: `/invite` e `/kick`
  // decidem quem é o host comparando `room.hostName` (que o
  // `propagateRename` mantém ATUALIZADO) com este campo (que estava
  // velho). Um host que se renomeasse no meio da própria live tomava 403
  // ao convidar ou expulsar — na sala dele mesmo. O aviso de convite
  // aceito/recusado também chegava assinado com o nome antigo.
  //
  // Agora vem do banco, pela mesma entrada de cache já consultada acima
  // — nenhuma consulta a mais. Quem renomeia invalida a entrada (ver
  // `invalidateTokenVersion`).
  req.username = cached.username;
  next();
}

// Pras rotas do PAINEL de administração (2026-09-16).
//
// Vai SEMPRE depois do requireAuth — este aqui não confere token, só
// responde "essa pessoa pode?". Encadeado:
//
//   app.get("/admin/users", requireAuth, requireAdmin, ...)
//
// A consulta ao banco é de propósito, e é o ponto todo: o `is_admin`
// NÃO é claim do JWT. Se fosse, tirar o admin de alguém só valeria
// quando o token dele vencesse — até 30 dias depois, com a pessoa
// administrando o sistema nesse meio tempo. Aqui a revogação é
// imediata, e o custo (uma consulta) só acontece em rota de admin,
// que é rara por natureza.
//
// A mesma consulta confere a SITUAÇÃO da conta: um admin bloqueado
// deixa de ser admin no mesmo instante.
async function requireAdmin(req, res, next) {
  try {
    // `require` aqui dentro pelo mesmo motivo do requireAuth acima: este
    // módulo é carregado antes do banco estar de pé.
    const usersDb = require("../db/users");
    const user = await usersDb.findById(req.userId);

    if (!user || !user.is_admin || user.status !== "active") {
      // 403 e não 404: o pedido chegou autenticado, e esconder a
      // existência da rota de quem já provou quem é não protege nada.
      return res.status(403).json({ error: "forbidden" });
    }

    next();
  } catch (err) {
    console.error("Erro ao conferir permissão de admin:", err);
    res.status(500).json({ error: "Erro interno de autenticação" });
  }
}

// Pras rotas em que o usuário só pode mexer nele mesmo. Sem isso,
// qualquer conta autenticada poderia trocar a senha de qualquer outra
// só mudando o id da URL.
function requireSelf(req, res, next) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id !== req.userId) {
    return res.status(403).json({ error: "forbidden" });
  }
  next();
}

module.exports = { sign, requireAuth, requireAdmin, requireSelf, invalidateTokenVersion };
