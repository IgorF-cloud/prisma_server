// A versão publicada do app ANDROID (2026-09-16).
//
// ---------------------------------------------------------------------
// POR QUE ISTO NÃO ESTÁ NO BANCO, COMO O WINDOWS
//
// A versão do Windows vive na tabela `app_version` porque o app
// INSTALADO a consulta pra se auto-atualizar — é um contrato com
// software que já está na máquina das pessoas, e por isso precisa de um
// lugar transacional, com histórico de quem publicou.
//
// O Android não tem nada disso: não existe auto-atualização no app
// Flutter (decisão de 2026-09-16), então esta informação serve a UM
// leitor só — a landing page, pra escrever "versão X · Y MB" embaixo do
// botão. Uma tabela nova, uma migration e uma aba no painel de
// administração seriam maquinário para um dado que ninguém além do site
// lê.
//
// Então o formato é um arquivo: `downloads/android.json`, escrito pelo
// `publish-apk.ps1` do projeto Flutter, que roda na máquina de quem
// desenvolve — onde o `aapt2` existe e consegue ler a versão de DENTRO
// do APK. O servidor só lê e repassa.
//
// O dia em que o app Android ganhar auto-atualização, isto vira tabela.
// Até lá, o arquivo é a peça certa.
// ---------------------------------------------------------------------

const fs = require("fs");
const path = require("path");

const DOWNLOADS_DIR = path.join(__dirname, "downloads");
const METADATA_FILE = path.join(DOWNLOADS_DIR, "android.json");

// O nome do arquivo vem de um JSON que uma PESSOA gerou e copiou pra
// VM — ou seja, de fora do código. Ele é usado pra montar um caminho em
// disco (`statSync`) e uma URL, então passa por aqui antes.
//
// Sem esta trava, um `"filename": "../../etc/passwd"` no JSON viraria
// leitura fora da pasta. Não é um cenário provável (quem edita esse
// arquivo já tem a VM), mas a checagem custa uma linha e a alternativa é
// confiar num arquivo de texto.
const SAFE_FILENAME = /^[A-Za-z0-9._-]+\.apk$/;

const SHA256 = /^[a-f0-9]{64}$/;

/// Lê o `android.json`. Devolve `null` quando ele não existe — que é o
/// estado normal antes da primeira publicação, e não um erro.
function read() {
  let raw;
  try {
    raw = fs.readFileSync(METADATA_FILE, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }

  const data = JSON.parse(raw);

  const filename = String(data.filename ?? "");
  if (!SAFE_FILENAME.test(filename)) {
    throw new Error(`android.json: filename inválido (${filename})`);
  }

  const version = String(data.version ?? "").trim();
  if (!version) throw new Error("android.json: version vazia");

  const sha256 = String(data.sha256 ?? "").toLowerCase();
  if (sha256 && !SHA256.test(sha256)) {
    throw new Error("android.json: sha256 não é um hash de 64 hex");
  }

  // Tamanho lido do ARQUIVO, e não do JSON, pelo mesmo motivo do
  // /version/public do Windows: o APK é trocado por cópia direta, sem
  // passar por código nosso. Um tamanho copiado do JSON ficaria
  // mentindo se alguém trocasse só o arquivo.
  let sizeBytes = null;
  try {
    sizeBytes = fs.statSync(path.join(DOWNLOADS_DIR, filename)).size;
  } catch {
    // Publicado, mas o APK ainda não chegou em downloads/. A página
    // simplesmente não mostra o tamanho.
  }

  return {
    version,
    versionCode: Number.isInteger(data.versionCode) ? data.versionCode : null,
    url: `/downloads/${filename}`,
    filename,
    sha256,
    sizeBytes,
    publishedAt: data.publishedAt ?? null,
  };
}

module.exports = { read, METADATA_FILE };
