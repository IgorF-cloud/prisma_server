// Envio de e-mail (2026-09-10) — hoje só o código de recuperação de
// senha.
//
// Dois drivers, escolhidos pela presença de RESEND_API_KEY no .env:
//
//   - com a chave  -> manda de verdade pela API do Resend
//   - sem a chave  -> escreve o e-mail no LOG do servidor
//
// O driver de log não é um stub de preguiça: é o que deixa testar o
// fluxo inteiro (pedir código, digitar, trocar a senha) antes de existir
// domínio verificado, SPF e DKIM. `docker compose logs prisma_server`
// mostra o código.
//
// ⚠️ Ele NUNCA deve ser o driver ativo em produção de verdade: qualquer
// pessoa com acesso ao log consegue trocar a senha de qualquer conta.
// Por isso o aviso barulhento no boot, abaixo.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
// Precisa ser um endereço de um domínio VERIFICADO no Resend. Com o
// domínio recém-comprado, é `algo@prisma-site.com.br` depois de
// adicionar os registros SPF/DKIM que eles mostram no painel.
const MAIL_FROM = process.env.MAIL_FROM || "Prisma <nao-responda@prisma-site.com.br>";

const enabled = Boolean(RESEND_API_KEY);

function logStartupMode() {
  if (enabled) {
    console.log(`[mail] Resend ativo, remetente: ${MAIL_FROM}`);
    return;
  }
  console.warn(
    "[mail] RESEND_API_KEY ausente — os e-mails serão ESCRITOS NO LOG em vez de enviados.\n" +
      "[mail] Isso é o modo de teste. Em produção, quem lê o log troca a senha de qualquer conta.",
  );
}

async function send({ to, subject, text }) {
  if (!enabled) {
    console.log(
      `\n[mail:log] ---------------------------------------------\n` +
        `[mail:log] Para: ${to}\n` +
        `[mail:log] Assunto: ${subject}\n` +
        `[mail:log] ${text}\n` +
        `[mail:log] ---------------------------------------------\n`,
    );
    return;
  }

  // `fetch` nativo (Node 18+) em vez do SDK do Resend: é uma chamada
  // HTTP só, e o SDK traria uma dependência inteira pra montar este
  // objeto.
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Resend respondeu ${response.status}: ${body}`);
  }
}

// O texto que a pessoa recebe. Sem HTML de propósito: um e-mail de
// código não ganha nada com layout, e texto puro passa longe de filtro
// de spam com mais folga.
async function sendPasswordResetCode({ to, username, code, ttlMinutes }) {
  await send({
    to,
    subject: `Prisma — seu código de recuperação: ${code}`,
    text: [
      `Olá, ${username}.`,
      "",
      `Seu código para redefinir a senha do Prisma é: ${code}`,
      "",
      `Ele vale por ${ttlMinutes} minutos e só pode ser usado uma vez.`,
      "",
      "Se não foi você que pediu, ignore este e-mail — sua senha continua a mesma.",
      "",
      "— Prisma",
    ].join("\n"),
  });
}

module.exports = { sendPasswordResetCode, logStartupMode, enabled };
