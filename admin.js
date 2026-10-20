// Rotas do PAINEL DE ADMINISTRAÇÃO (2026-09-16) — o site que vive em
// admin.prisma-site.com.br (projeto prisma_admin, em MY PROJECTS/react).
//
// Em arquivo próprio, e não no server.js, por dois motivos: o server.js
// já passa de 2.200 linhas, e estas rotas têm uma regra de acesso
// diferente de todas as outras (requireAdmin por cima do requireAuth).
// Juntas num arquivo só, é questão de tempo até uma rota nova nascer sem
// o `requireAdmin` no meio do resto.
//
// Duas coisas, hoje:
//
//   1. CONTAS — aprovar, recusar, bloquear e desbloquear.
//   2. VERSÃO — subir um instalador novo e publicá-lo, substituindo o
//      `publish-version.ps1` (que continua existindo e funcionando: se
//      isto aqui quebrar numa sexta à noite, a release não fica presa).

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const pe = require("./pe");

const DOWNLOADS_DIR = path.join(__dirname, "downloads");
// Os uploads em andamento ficam numa subpasta, e NUNCA soltos em
// downloads/: aquela pasta inteira é servida estaticamente pelo
// `/downloads` (ver server.js), então um arquivo temporário ali seria
// baixável por qualquer um enquanto existisse.
const UPLOADS_DIR = path.join(DOWNLOADS_DIR, ".uploads");
// O instalador ANTERIOR, e só ele (2026-09-17).
//
// Até aqui, publicar renomeava o exe antigo pra `Prisma-Setup-<versão>.exe`
// ali mesmo em downloads/ — e isso ACUMULA: cada publicação deixava mais
// 88 MB pra trás, num disco de VM que não é grande. Agora o anterior vai
// pra esta pasta, que é esvaziada antes de receber o novo: um arquivo
// só, sempre o de imediatamente antes.
//
// Começa com ponto pelo mesmo motivo de `.uploads`: o `express.static`
// ignora nomes iniciados em ponto (`dotfiles: "ignore"` é o padrão),
// então a versão anterior deixa de ser baixável por qualquer um — o que
// antes acontecia, já que `Prisma-Setup-1.0.5.exe` ficava solto na pasta
// servida.
const BACKUP_DIR = path.join(DOWNLOADS_DIR, ".backup");

// Teto do upload. O instalador tem ~88 MB; 300 MB dá folga pra ele
// crescer bastante sem virar uma porta pra encher o disco da VM.
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;
// Abaixo disto não é o instalador do Prisma — é engano de arquivo.
const MIN_UPLOAD_BYTES = 5 * 1024 * 1024;

// Um upload que não virou publicação em 1h foi abandonado.
const UPLOAD_TTL_MS = 60 * 60 * 1000;

// As duas situações que sobraram (2026-09-18, migration 005). O CHECK do
// banco tem a mesma lista — esta aqui é pra recusar cedo, com uma
// mensagem legível, em vez de deixar o Postgres estourar constraint.
const STATUSES = ["active", "blocked"];

// Teto de contas: um número, não uma fórmula. O piso é 1 (zero travaria
// o cadastro pra sempre e não é uma configuração, é um desligamento) e o
// teto existe só pra barrar dedo escorregado — 100 mil contas não é um
// limite que alguém queira de verdade neste produto.
const MIN_MAX_USERS = 1;
const MAX_MAX_USERS = 100000;

function ensureDirs() {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// Guarda o instalador que está saindo do ar e devolve o caminho dele, ou
// `null` se não deu.
//
// Conveniência de rollback, não parte da entrega: falhar aqui NÃO impede
// publicar. A versão nova é o que a pessoa pediu; o backup é cortesia.
//
// A pasta é ESVAZIADA antes, e é isso que impede o acúmulo que motivou a
// mudança — sobra sempre um arquivo só, o de imediatamente antes. O nome
// carrega a versão porque um backup que não se sabe de quando é serve
// pela metade: na hora de voltar às pressas, é justamente o que se
// precisa saber.
function backupCurrentInstaller(currentPath, version) {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    for (const name of fs.readdirSync(BACKUP_DIR)) {
      try {
        fs.unlinkSync(path.join(BACKUP_DIR, name));
      } catch {
        /* sumiu no meio do caminho */
      }
    }

    const target = path.join(
      BACKUP_DIR,
      `${path.basename(currentPath, ".exe")}-${version}.exe`,
    );
    // `rename` e não cópia: é a MESMA partição (subpasta de downloads/),
    // então isto é instantâneo e atômico, sem gastar 88 MB de leitura e
    // escrita a cada publicação.
    fs.renameSync(currentPath, target);
    return target;
  } catch (err) {
    console.error("[admin] não consegui guardar o instalador anterior:", err);
    return null;
  }
}

// Varre temporários velhos. Chamado a cada upload novo em vez de num
// timer: o gatilho natural é justamente quando um novo chega, e assim
// não existe um timer rodando pra sempre pra uma pasta que passa a
// maior parte do tempo vazia.
function sweepOldUploads() {
  let removed = 0;
  try {
    for (const name of fs.readdirSync(UPLOADS_DIR)) {
      const file = path.join(UPLOADS_DIR, name);
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > UPLOAD_TTL_MS) {
          fs.unlinkSync(file);
          removed++;
        }
      } catch {
        /* sumiu no meio do caminho */
      }
    }
  } catch {
    /* pasta ainda não existe */
  }
  if (removed > 0) console.log(`[admin] ${removed} upload(s) abandonado(s) removido(s)`);
}

function uploadPath(id) {
  // O id vem do cliente na hora de publicar. Sem esta checagem, um
  // "../../etc/passwd" viraria um caminho de verdade.
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return path.join(UPLOADS_DIR, `${id}.exe`);
}

function isValidVersion(value) {
  return typeof value === "string" && /^\d+(\.\d+){1,3}$/.test(value);
}

// "1.0.10" > "1.0.9" — comparação por PARTES, não alfabética (que diria
// o contrário e é um clássico).
function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}


// --- Build do compose pelo painel (2026-09-21) -------------------------
//
// A "caixa de correio" entre este servidor e o host. Ver ops/README.md —
// e o comentário na seção DOCKER das rotas, lá embaixo, pro porquê de o
// build não rodar aqui dentro.
//
// É bind mount (ver docker-compose.yml). Sem ele, estas pastas existem
// dentro do container e o script do host nunca vê nada.
const OPS_DIR = path.join(__dirname, "ops");
const DEPLOY_REQUESTS_DIR = path.join(OPS_DIR, "requests");
const DEPLOY_LOGS_DIR = path.join(OPS_DIR, "logs");
const DEPLOY_STATUS_DIR = path.join(OPS_DIR, "status");

// Quantos deploys a aba mostra. O script guarda 20 arquivos; a tela não
// precisa de tantos.
const DEPLOY_HISTORY = 10;

// Só o FIM do log vai pra tela. Um build que baixa camada do zero passa
// fácil de 1 MB de saída, e o que interessa — o erro, o "Started" — está
// sempre no fim. Mandar tudo, a cada 2 segundos, seria mandar o mesmo
// megabyte trinta vezes.
const DEPLOY_LOG_TAIL_BYTES = 200 * 1024;

// O mesmo formato que o deploy.sh valida. Ordenável por nome, porque
// começa pela data — é isso que faz o `sort` do histórico ser só um
// `sort`.
const DEPLOY_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{6}$/;

// Um build "rodando" há mais de isto está morto (a VM reiniciou no meio,
// o script levou um kill). Sem este teto, um status preso em `running`
// travaria o botão pra sempre.
const DEPLOY_STALE_MS = 15 * 60 * 1000;

function newDeployId() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function readDeployStatus(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DEPLOY_STATUS_DIR, `${id}.json`), "utf8"));
  } catch {
    // Não existe, ou foi lido no meio da escrita. O script escreve em
    // .tmp e renomeia justamente pra que o segundo caso não aconteça —
    // mas se acontecer, uma leitura vazia agora é melhor que um 500.
    return null;
  }
}

// Do mais novo pro mais velho, com o `running` vencido virando `failed`
// na leitura (o arquivo no disco continua como está — quem manda nele é
// o script).
function listDeploys() {
  let names = [];
  try {
    names = fs.readdirSync(DEPLOY_STATUS_DIR);
  } catch {
    return [];
  }

  return names
    .filter((name) => name.endsWith(".json") && DEPLOY_ID_RE.test(name.slice(0, -5)))
    .sort()
    .reverse()
    .map((name) => readDeployStatus(name.slice(0, -5)))
    .filter(Boolean)
    .map((deploy) => {
      const since = Date.parse(deploy.startedAt ?? deploy.requestedAt ?? "");
      const stale =
        (deploy.state === "running" || deploy.state === "queued") &&
        Number.isFinite(since) &&
        Date.now() - since > DEPLOY_STALE_MS;
      return stale ? { ...deploy, state: "failed", stale: true } : deploy;
    });
}

function readDeployLog(id) {
  const file = path.join(DEPLOY_LOGS_DIR, `${id}.log`);
  let fd = null;
  try {
    const { size } = fs.statSync(file);
    const start = Math.max(0, size - DEPLOY_LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    fd = fs.openSync(file, "r");
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return (start > 0 ? "[... início do log omitido ...]\n" : "") + buffer.toString("utf8");
  } catch {
    // O log só nasce quando o script assume o pedido: enquanto está na
    // fila, não existe arquivo nenhum — e isso não é erro.
    return "";
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function setupAdminRoutes({
  app,
  requireAuth,
  requireAdmin,
  usersDb,
  appVersionDb,
  settingsDb,
  presence,
  invalidateTokenVersion,
  avatarsDir: AVATARS_DIR,
  onUsersChanged,
  onVersionPublished,
}) {
  ensureDirs();

  // ------------------------------------------------------------ CONTAS

  app.get("/admin/users", requireAuth, requireAdmin, async (req, res) => {
    try {
      // A lista e o uso do teto vêm JUNTOS (2026-09-18). São duas coisas
      // que a tela de Contas sempre mostra lado a lado ("12 de 50"), e
      // separar em duas rotas só criaria o momento em que uma chegou e a
      // outra não — com o painel desenhando um número desatualizado.
      const [users, usage] = await Promise.all([
        usersDb.listForAdmin(),
        settingsDb.usage(),
      ]);
      res.json({ users, usage });
    } catch (err) {
      console.error("[admin] erro ao listar usuários:", err);
      res.status(500).json({ error: "Erro interno ao listar usuários" });
    }
  });

  // Muda o teto de contas.
  //
  // Aceita um valor MENOR que o número de contas existentes, de propósito
  // (decisão do usuário, 2026-09-18): ninguém é apagado, só não entra
  // mais ninguém até o número cair. Recusar seria pior — o admin que
  // quer parar de aceitar cadastros ficaria sem jeito de fazer isso sem
  // apagar gente antes.
  app.put("/admin/settings/max-users", requireAuth, requireAdmin, async (req, res) => {
    const { maxUsers } = req.body ?? {};

    if (!Number.isInteger(maxUsers) || maxUsers < MIN_MAX_USERS || maxUsers > MAX_MAX_USERS) {
      return res.status(400).json({
        error: `O limite precisa ser um número inteiro entre ${MIN_MAX_USERS} e ${MAX_MAX_USERS}.`,
      });
    }

    try {
      await settingsDb.setMaxUsers(maxUsers, req.userId);
      const usage = await settingsDb.usage();
      console.log(
        `[admin] ${req.username} mudou o limite de contas para ${maxUsers} ` +
          `(${usage.total} conta(s) existente(s))`,
      );
      res.json({ usage });
    } catch (err) {
      console.error("[admin] erro ao mudar o limite de contas:", err);
      res.status(500).json({ error: "Erro interno ao mudar o limite" });
    }
  });

  // Aprovar, recusar, bloquear, desbloquear — tudo a mesma operação:
  // mudar a situação. Uma rota só, e não quatro verbos diferentes, pelo
  // mesmo motivo de a coluna ser uma só: não existe transição que precise
  // de tratamento próprio.
  app.post("/admin/users/:id/status", requireAuth, requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const { status } = req.body ?? {};

    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "id inválido" });
    }
    if (!STATUSES.includes(status)) {
      return res.status(400).json({ error: `status deve ser um de: ${STATUSES.join(", ")}` });
    }
    // Um admin se bloqueando perderia o acesso ao painel — e não haveria
    // como se desbloquear por ele. Sobraria um UPDATE no banco à mão.
    if (id === req.userId) {
      return res.status(400).json({ error: "Você não pode mudar a situação da sua própria conta." });
    }

    try {
      const updated = await usersDb.setStatus(id, status, req.userId);
      if (!updated) return res.status(404).json({ error: "Usuário não encontrado" });

      // Deixar de estar ativo tem que valer AGORA, não quando o token
      // vencer (até 30 dias depois).
      //
      // Duas coisas, porque são dois caminhos independentes: o `bump`
      // invalida o JWT (a próxima chamada HTTP do app devolve 401 e ele
      // volta pro login) e o `disconnectUser` derruba o WebSocket já
      // aberto, que não passaria por autenticação de novo tão cedo.
      if (status !== "active") {
        await usersDb.bumpTokenVersion(id);
        invalidateTokenVersion(id);
        const closed = presence.disconnectUser(id);
        console.log(
          `[admin] ${req.username} mudou ${updated.username} para ${status}` +
            (closed > 0 ? ` (${closed} conexão(ões) derrubada(s))` : ""),
        );
      } else {
        console.log(`[admin] ${req.username} mudou ${updated.username} para ${status}`);
      }

      res.json({ user: usersDb.adminUser(updated) });
    } catch (err) {
      console.error("[admin] erro ao mudar a situação do usuário:", err);
      res.status(500).json({ error: "Erro interno ao mudar a situação" });
    }
  });

  // Conceder ou tirar acesso de administrador (2026-09-16).
  //
  // Rota separada da de situação, e não um campo a mais lá, porque são
  // duas decisões independentes: "esta pessoa pode entrar no app" e "esta
  // pessoa pode administrar o app". Juntas numa chamada só, uma delas
  // aconteceria sem ninguém pedir.
  //
  // O `requireAdmin` já garante que quem chama é admin — quem está logado
  // no painel, por definição, é. A checagem continua aqui de propósito:
  // segurança de servidor não pode depender de a interface ter escondido
  // o botão.
  app.post("/admin/users/:id/admin", requireAuth, requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const { isAdmin } = req.body ?? {};

    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "id inválido" });
    }
    if (typeof isAdmin !== "boolean") {
      return res.status(400).json({ error: "isAdmin deve ser true ou false" });
    }
    // Tirar o próprio acesso deixaria o painel sem dono — e não haveria
    // como devolver, porque devolver exige ser admin. O caminho de volta
    // seria um UPDATE no banco à mão.
    if (id === req.userId) {
      return res.status(400).json({ error: "Você não pode mudar o seu próprio acesso." });
    }

    try {
      const target = await usersDb.findById(id);
      if (!target) return res.status(404).json({ error: "Usuário não encontrado" });

      // Admin numa conta que não pode entrar não serve pra nada: o
      // próprio requireAdmin exige situação ativa. Em vez de ativar por
      // conta própria (uma decisão que ninguém pediu), recusa explicando
      // — liberar a conta é um clique ao lado, na mesma tela.
      if (isAdmin && target.status !== "active") {
        return res.status(409).json({
          error: "Libere a conta antes de torná-la administradora.",
        });
      }

      const updated = await usersDb.setAdmin(id, isAdmin);
      console.log(
        `[admin] ${req.username} ${isAdmin ? "concedeu" : "removeu"} acesso de administrador` +
          ` ${isAdmin ? "para" : "de"} ${updated.username}`,
      );

      res.json({ user: usersDb.adminUser(updated) });
    } catch (err) {
      console.error("[admin] erro ao mudar o acesso de administrador:", err);
      res.status(500).json({ error: "Erro interno ao mudar o acesso" });
    }
  });

  // APAGAR a conta de vez (2026-09-17).
  //
  // Diferente de `status: "blocked"`, que é reversível e preserva o
  // histórico: aqui a linha some do banco e a foto some do disco. Não
  // tem volta — e é por isso que o painel exige digitar o nome do
  // usuário antes de liberar o botão.
  //
  // A ORDEM é o inverso da publicação de versão: primeiro o BANCO,
  // depois o arquivo. Falhando o `unlink`, sobra uma foto órfã em disco
  // — lixo inofensivo, que ninguém alcança porque a URL depende de um id
  // que não existe mais. Na ordem inversa, um erro no DELETE deixaria
  // uma conta viva e sem foto, que é um defeito visível.
  app.delete("/admin/users/:id", requireAuth, requireAdmin, async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "id inválido" });
    }
    // Apagar a própria conta deixaria o painel sem dono — e, ao
    // contrário de se bloquear, nem um UPDATE no banco desfaz.
    if (id === req.userId) {
      return res.status(400).json({ error: "Você não pode apagar a sua própria conta." });
    }

    try {
      const deleted = await usersDb.remove(id);
      if (!deleted) return res.status(404).json({ error: "Usuário não encontrado" });

      // Derruba quem estiver com o app aberto AGORA. Sem isto, um token
      // já emitido continuaria valendo até vencer, e as rotas que buscam
      // o usuário pelo id passariam a falhar de formas estranhas em vez
      // de dizer "sua sessão acabou".
      //
      // O `invalidateTokenVersion` limpa o cache em memória do jwt.js:
      // sem ele, a entrada da conta apagada ficaria lá até o servidor
      // reiniciar, e um token velho seria aceito contra um usuário que
      // não existe mais.
      invalidateTokenVersion(id);
      const closed = presence.disconnectUser(id);

      // A foto, que é arquivo e não linha. `unlink` num arquivo que não
      // existe é o caso NORMAL aqui (quem nunca trocou a foto não tem
      // arquivo), então ENOENT não é erro.
      //
      // Os DOIS formatos (2026-10-19): quem tem avatar em GIF tem o
      // `.gif` e a cópia parada em `.webp`.
      for (const ext of ["webp", "gif"]) {
        const avatarPath = path.join(AVATARS_DIR, `${id}.${ext}`);
        try {
          await fs.promises.unlink(avatarPath);
        } catch (err) {
          if (err.code !== "ENOENT") {
            console.error(`[admin] não foi possível apagar ${avatarPath}:`, err);
          }
        }
      }

      // O diretório nome -> avatar que acompanha todo broadcast de salas
      // é um CACHE em memória: sem recarregar, o nome da conta apagada
      // continuaria saindo nele até o próximo restart.
      await onUsersChanged();

      console.log(
        `[admin] ${req.username} APAGOU a conta ${deleted.username} (id ${id})` +
          (closed > 0 ? ` — ${closed} conexão(ões) derrubada(s)` : ""),
      );

      res.json({ deleted: { id, name: deleted.username } });
    } catch (err) {
      console.error("[admin] erro ao apagar usuário:", err);
      res.status(500).json({ error: "Erro interno ao apagar a conta" });
    }
  });

  // ------------------------------------------------------------ VERSÃO

  app.get("/admin/version", requireAuth, requireAdmin, async (req, res) => {
    try {
      const info = await appVersionDb.getForAdmin();
      if (!info) return res.status(404).json({ error: "Versão não configurada" });

      // O tamanho vem do arquivo em disco, não do banco: é o número que
      // prova que o exe publicado é o que está lá.
      let sizeBytes = null;
      try {
        sizeBytes = fs.statSync(path.join(DOWNLOADS_DIR, info.installerFilename)).size;
      } catch {
        /* arquivo ausente — o painel mostra isso como aviso */
      }

      let updatedByName = null;
      if (info.updatedBy) {
        const user = await usersDb.findById(info.updatedBy);
        updatedByName = user?.username ?? null;
      }

      res.json({ ...info, sizeBytes, updatedByName });
    } catch (err) {
      console.error("[admin] erro ao ler a versão publicada:", err);
      res.status(500).json({ error: "Erro interno ao ler a versão" });
    }
  });

  // PASSO 1 — receber o arquivo.
  //
  // O corpo é o .exe CRU (application/octet-stream), não multipart. O
  // navegador manda o File direto no body de um fetch, e aqui não entra
  // biblioteca de parsing nenhuma pra isso.
  //
  // E, principalmente: o arquivo vai pro DISCO enquanto chega. Nada de
  // juntar 88 MB em memória — `express.json` nem toca nisto porque está
  // limitado por `type` a application/json (ver server.js).
  //
  // Publicar NÃO acontece aqui. Este passo só devolve o que o servidor
  // descobriu sobre o arquivo (hash, tamanho, versão, assinatura) pro
  // admin conferir antes de confirmar.
  app.post("/admin/version/upload", requireAuth, requireAdmin, (req, res) => {
    sweepOldUploads();

    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared && declared > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: "Arquivo grande demais." });
    }

    const id = crypto.randomUUID();
    const target = uploadPath(id);
    const hash = crypto.createHash("sha256");
    const stream = fs.createWriteStream(target);

    let size = 0;
    let looksLikeExe = null;
    let failed = false;

    function abort(status, message) {
      if (failed) return;
      failed = true;

      // Para de gravar e apaga o pedaço que já foi pro disco.
      req.unpipe(stream);
      stream.destroy();
      fs.promises.unlink(target).catch(() => {});

      res.status(status).json({ error: message });

      // ⚠️ `req.resume()`, e NÃO `req.destroy()`.
      //
      // O reflexo aqui é destruir a conexão — o arquivo já foi recusado,
      // por que continuar recebendo? Testado, dá errado: destruir manda
      // um RST, e o cliente vê "a conexão caiu" EM VEZ da mensagem que
      // explica o problema. A resposta já tinha saído, mas o reset chega
      // antes de ela ser lida (visto como ECONNRESET num teste com fetch).
      //
      // Drenar deixa a requisição terminar normalmente e a mensagem
      // chegar. O custo é o cliente subir o resto do arquivo à toa, e só
      // no caso de erro — nada disso toca o disco, e o tamanho já está
      // limitado no nginx (client_max_body_size) antes de chegar aqui.
      req.resume();
    }

    req.on("data", (chunk) => {
      if (failed) return;

      // A assinatura "MZ" está nos dois primeiros bytes de todo
      // executável do Windows. Conferir no primeiro pedaço derruba o
      // upload errado (um zip, um instalador de outra coisa) em
      // milissegundos, em vez de depois de 88 MB.
      if (looksLikeExe === null) {
        looksLikeExe = chunk.length >= 2 && chunk[0] === 0x4d && chunk[1] === 0x5a;
        if (!looksLikeExe) {
          return abort(400, "Isto não parece um executável do Windows (.exe).");
        }
      }

      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        return abort(413, "Arquivo grande demais.");
      }
      hash.update(chunk);
    });

    req.on("error", () => abort(400, "Falha ao receber o arquivo."));

    stream.on("error", (err) => {
      console.error("[admin] erro ao gravar o upload:", err);
      abort(500, "Não foi possível gravar o arquivo no servidor.");
    });

    stream.on("finish", () => {
      if (failed) return;

      if (size < MIN_UPLOAD_BYTES) {
        return abort(400, "Arquivo pequeno demais para ser o instalador.");
      }

      const sha256 = hash.digest("hex");
      const info = pe.inspect(target);

      console.log(
        `[admin] ${req.username} subiu ${size} bytes` +
          ` (versão detectada: ${info.version ?? "?"}, assinado: ${info.signed})`,
      );

      res.json({
        uploadId: id,
        sizeBytes: size,
        sha256,
        // Sugestões — o admin confirma na tela. Ver pe.js pro que cada
        // uma prova e pro que NÃO prova.
        detectedVersion: info.version,
        signed: info.signed,
      });
    });

    req.pipe(stream);
  });

  // PASSO 2 — publicar de verdade.
  //
  // A ORDEM AQUI É O CUIDADO PRINCIPAL:
  //
  //   1. o exe atual é guardado com o nome da versão dele (rollback vira
  //      um UPDATE de uma linha);
  //   2. o temporário entra no lugar por RENAME, que é atômico dentro do
  //      mesmo sistema de arquivos — quem estiver baixando neste exato
  //      instante recebe o arquivo antigo INTEIRO ou o novo INTEIRO,
  //      nunca 40 MB de um colados em 48 do outro;
  //   3. só então o banco é atualizado.
  //
  // Arquivo antes do banco, e não o contrário: se o banco falhar, sobra
  // um exe novo em disco com a versão antiga anunciada — ninguém recebe
  // atualização, situação chata mas segura. Na ordem inversa, o servidor
  // anunciaria uma versão cujo arquivo ainda não chegou, e todo mundo
  // que checasse naquela janela baixaria erro.
  app.post("/admin/version/publish", requireAuth, requireAdmin, async (req, res) => {
    const { uploadId, version, sha256 } = req.body ?? {};

    const source = typeof uploadId === "string" ? uploadPath(uploadId) : null;
    if (!source || !fs.existsSync(source)) {
      return res.status(404).json({ error: "Upload não encontrado — envie o arquivo de novo." });
    }
    if (!isValidVersion(version)) {
      return res.status(400).json({ error: "Versão inválida. Use algo como 1.0.5." });
    }

    try {
      const current = await appVersionDb.getForAdmin();
      const filename = current?.installerFilename ?? "Prisma-Setup.exe";
      const destination = path.join(DOWNLOADS_DIR, filename);

      // O hash é recalculado a partir do arquivo em disco, e o que o
      // cliente mandou serve só de conferência. É isto que torna
      // impossível publicar o hash de um arquivo diferente do que está no
      // ar — o erro que o publish-version.ps1 precisa vigiar na mão.
      const recomputed = await sha256OfFile(source);
      if (sha256 && sha256 !== recomputed) {
        return res.status(409).json({
          error: "O arquivo mudou entre o envio e a publicação. Envie de novo.",
        });
      }

      // O anterior sai de downloads/ e vai pra .backup/, que guarda UM
      // arquivo só — ver `backupCurrentInstaller`.
      let backedUp = null;
      if (current?.version && fs.existsSync(destination)) {
        backedUp = backupCurrentInstaller(destination, current.version);
      }

      fs.renameSync(source, destination);

      const updated = await appVersionDb.set({
        version,
        sha256: recomputed,
        updatedBy: req.userId,
      });

      console.log(
        `[admin] ${req.username} publicou a versão ${version} (sha256 ${recomputed.slice(0, 12)}…)` +
          (backedUp ? ` — anterior guardada em .backup/${path.basename(backedUp)}` : ""),
      );

      // Os apps abertos ficam sabendo agora, pelo WebSocket — é isso
      // que acende o botão de atualizar sem ninguém reiniciar o app
      // (ver broadcastAppVersion em server.js). Depois do disco e do
      // banco já terem sido atualizados, de propósito: o anúncio faz o
      // app ir buscar o `GET /version`, e ele precisa encontrar a
      // versão nova quando chegar lá. Best-effort — se o anúncio
      // falhar, o pior que acontece é o app descobrir no próximo login,
      // como era antes.
      try {
        onVersionPublished?.(version);
      } catch (err) {
        console.error("[admin] falha ao anunciar a versão publicada:", err);
      }

      res.json({ ...updated, sizeBytes: fs.statSync(destination).size });
    } catch (err) {
      console.error("[admin] erro ao publicar a versão:", err);
      res.status(500).json({ error: "Erro interno ao publicar a versão" });
    }
  });
  // ------------------------------------------------------------ DOCKER
  //
  // Rodar `docker compose up -d --build` na VM a partir de um botão do
  // painel (2026-09-21). O desenho inteiro está em ops/README.md; o
  // resumo do que importa AQUI:
  //
  // Este servidor NÃO roda o build. Ele escreve um pedido em
  // ops/requests/, e quem roda é um script do HOST acordado por um
  // `.path` do systemd. Duas razões, e a primeira sozinha decide: o
  // build RECRIA este container — rodar daqui seria o processo se
  // matando no meio do próprio comando. A segunda é que montar o socket
  // do Docker aqui dentro daria a quem comprometesse a API pública o
  // equivalente a root na VM.
  //
  // Nada do que entra vira comando. O pedido só carrega quem pediu e
  // quando; o que roda está escrito no deploy.sh.

  app.post("/admin/docker/deploy", requireAuth, requireAdmin, (req, res) => {
    try {
      fs.mkdirSync(DEPLOY_REQUESTS_DIR, { recursive: true });
      fs.mkdirSync(DEPLOY_STATUS_DIR, { recursive: true });
    } catch (err) {
      console.error("[admin] não consegui preparar a pasta de deploys:", err);
      return res.status(500).json({
        error:
          "A pasta ops/ não está acessível no servidor. Confira o bind mount no docker-compose.yml.",
      });
    }

    // Um de cada vez. O `deploy.sh` já tem um flock que garante isso do
    // lado de lá; aqui a recusa é pra dizer isso na TELA, em vez de
    // deixar a pessoa achar que o segundo clique fez alguma coisa.
    const busy = listDeploys().find((d) => d.state === "queued" || d.state === "running");
    if (busy) {
      return res.status(409).json({ error: "Já existe um build em andamento.", id: busy.id });
    }

    const id = newDeployId();
    const requestedAt = new Date().toISOString();
    // Só pra aparecer no log e na tela. Filtrado assim mesmo: este texto
    // vai pra dentro de um JSON escrito à mão e lido por um `sed` no
    // script — aspas e barras não têm o que fazer ali.
    const requestedBy = String(req.username ?? "").replace(/[^\w .@-]/g, "").slice(0, 60);

    try {
      // O status vem PRIMEIRO: entre escrever o pedido e o script
      // assumi-lo passam alguns milissegundos, e nesse intervalo o
      // painel já está perguntando. Sem isto ele veria "não existe" e
      // chamaria de erro.
      fs.writeFileSync(
        path.join(DEPLOY_STATUS_DIR, `${id}.json`),
        JSON.stringify({ id, state: "queued", requestedAt, requestedBy }) + "\n",
      );
      // Este arquivo é o gatilho — é a criação dele que acorda o
      // systemd. Por isso é o último.
      fs.writeFileSync(
        path.join(DEPLOY_REQUESTS_DIR, `${id}.json`),
        JSON.stringify({ id, requestedAt, requestedBy }) + "\n",
      );
    } catch (err) {
      console.error("[admin] não consegui registrar o pedido de build:", err);
      return res.status(500).json({ error: "Não foi possível registrar o pedido de build." });
    }

    console.log(`[admin] ${requestedBy} pediu um build do compose (${id})`);
    res.status(202).json({ id, state: "queued", requestedAt, requestedBy });
  });

  // Os últimos deploys, do mais novo pro mais velho. É o que a aba mostra
  // ao abrir — inclusive um build que já estava rodando antes de a
  // página carregar.
  app.get("/admin/docker/deploy", requireAuth, requireAdmin, (req, res) => {
    res.json({ deploys: listDeploys().slice(0, DEPLOY_HISTORY) });
  });

  // Um deploy, com o fim do log. É o que o painel pergunta de 2 em 2
  // segundos enquanto o build roda.
  //
  // ⚠️ Durante o build ESTA ROTA FICA FORA DO AR por 20-60s: o container
  // que a serve é justamente o que está sendo recriado. O painel trata
  // isso como "reiniciando" e continua tentando — ver DockerPanel.tsx.
  app.get("/admin/docker/deploy/:id", requireAuth, requireAdmin, (req, res) => {
    const { id } = req.params;
    if (!DEPLOY_ID_RE.test(id)) {
      return res.status(400).json({ error: "Identificador de build inválido." });
    }

    const status = readDeployStatus(id);
    if (!status) return res.status(404).json({ error: "Build não encontrado." });

    res.json({ ...status, log: readDeployLog(id) });
  });

}

function sha256OfFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

module.exports = { setupAdminRoutes };
