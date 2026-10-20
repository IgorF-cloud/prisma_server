// Leitura do cabeçalho PE de um .exe do Windows (2026-09-16).
//
// Serve ao painel de administração em dois pontos, os dois sobre o
// instalador que o admin acabou de subir:
//
//   1. QUAL VERSÃO ele diz ser — pra sugerir o campo em vez de o admin
//      digitar "1.0.4" olhando pro arquivo chamado Prisma-Setup.exe.
//   2. SE ELE ESTÁ ASSINADO — pra pegar o "esqueci o passo 7 do
//      RELEASE.md" antes de publicar, não depois.
//
// ---------------------------------------------------------------------
// O QUE ESTE ARQUIVO **NÃO** FAZ
//
// Não valida a assinatura. Ele só responde se existe uma tabela de
// certificado no cabeçalho — não confere se ela é criptograficamente
// válida, nem se o certificado é o do Prisma, nem se os bytes batem com
// o que foi assinado.
//
// Isso é de propósito. Validar Authenticode de verdade fora do Windows
// exige `osslsigncode` (ou equivalente) instalado na imagem, e o que ele
// pegaria a mais é um cenário que não existe aqui: alguém com senha de
// admin subindo um exe adulterado de propósito. O caso REAL é o dono
// esquecer de assinar, e pra esse a checagem barata basta.
//
// ⚠️ `signed: false` NÃO quer dizer "não confiável": binários do próprio
// Windows (notepad.exe, por exemplo) são assinados por CATÁLOGO, um
// arquivo separado, e não trazem assinatura embutida. Aqui isso não
// atrapalha porque o alvo é sempre um instalador assinado com
// `signtool sign`, que embute.
// ---------------------------------------------------------------------
//
// ⚠️ A entrada é um arquivo enviado de fora. Nada aqui pode lançar nem
// ler além do buffer: toda leitura é limitada, e qualquer surpresa vira
// `null` ("não sei dizer"), nunca uma exceção. Um instalador que este
// módulo não entende ainda pode ser publicado — o admin só não ganha a
// sugestão.

const fs = require("fs");

// Assinatura do VS_FIXEDFILEINFO, a estrutura que carrega os números da
// versão. É um valor mágico fixo — é por ele que a busca acontece.
const FIXED_FILE_INFO_MAGIC = 0xfeef04bd;

// Teto do pedaço lido da seção de recursos. O instalador tem ~90 MB e
// nada disso precisa entrar na memória: o cabeçalho fica nos primeiros
// KB e os recursos numa seção própria, quase sempre pequena. Ler o
// arquivo inteiro (readFileSync) custaria 90 MB de RAM no container por
// upload — o que este teto existe pra evitar.
const MAX_RESOURCE_READ = 8 * 1024 * 1024;

const HEADER_READ = 8192;

function readChunk(fd, position, length) {
  if (length <= 0) return null;
  const buffer = Buffer.alloc(length);
  const bytes = fs.readSync(fd, buffer, 0, length, position);
  return bytes > 0 ? buffer.subarray(0, bytes) : null;
}

// RVA (endereço quando o exe está CARREGADO na memória) -> posição no
// ARQUIVO. Os dois não coincidem: cada seção é alinhada de um jeito em
// disco e de outro na memória, e a tabela de seções é o mapa entre eles.
function rvaToFileOffset(header, sectionsStart, sectionCount, rva) {
  for (let i = 0; i < sectionCount; i++) {
    const section = sectionsStart + i * 40;
    if (section + 40 > header.length) return null;

    const virtualSize = header.readUInt32LE(section + 8);
    const virtualAddress = header.readUInt32LE(section + 12);
    const rawSize = header.readUInt32LE(section + 16);
    const rawPointer = header.readUInt32LE(section + 20);

    // `virtualSize || rawSize`: seção sem tamanho virtual declarado
    // existe, e usar 0 faria o intervalo nunca casar.
    const size = virtualSize || rawSize;
    if (rva >= virtualAddress && rva < virtualAddress + size) {
      return { offset: rawPointer + (rva - virtualAddress), rawSize };
    }
  }
  return null;
}

// Os números do VS_FIXEDFILEINFO: dwSignature(4) dwStrucVersion(4)
// dwFileVersionMS(4) dwFileVersionLS(4).
function versionFromFixedInfo(buffer, offset) {
  const ms = buffer.readUInt32LE(offset + 8);
  const ls = buffer.readUInt32LE(offset + 12);
  const parts = [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff];
  // 0.0.0.0 é o "não preenchido" — o Inno Setup deixa assim quando o
  // .iss não define VersionInfoVersion, que é justamente o caso do
  // Prisma-Setup.exe. Tratado como ausente pra cair na tabela de
  // strings, que lá tem o número certo.
  return parts.some((n) => n !== 0) ? parts.join(".") : null;
}

// O valor de uma chave da StringFileInfo (a mesma coisa que o Explorer
// mostra na aba Detalhes).
//
// Cada entrada é: wLength(2) wValueLength(2) wType(2), a CHAVE em
// UTF-16 terminada em zero, alinhamento de 4 bytes, e então o VALOR,
// também UTF-16 terminado em zero.
function stringValue(buffer, key) {
  const keyBytes = Buffer.from(key + "\0", "utf16le");
  const at = buffer.indexOf(keyBytes);
  if (at === -1) return null;

  // Depois da chave vem o padding até o próximo múltiplo de 4 — contado
  // a partir do início da ESTRUTURA, mas alinhar pelo fim da chave dá no
  // mesmo aqui porque o cabeçalho tem 6 bytes fixos e a busca já nos
  // deixou no lugar certo.
  let valueStart = at + keyBytes.length;
  while (valueStart % 4 !== 0) valueStart++;

  const end = buffer.indexOf(Buffer.from("\0\0", "utf16le"), valueStart);
  const stop = end === -1 ? Math.min(valueStart + 128, buffer.length) : end;
  if (stop <= valueStart) return null;

  return buffer.subarray(valueStart, stop).toString("utf16le").replace(/\0+$/, "").trim();
}

// "1.0.4", "1.0.4.0" — e nada além disso. Um valor como
// "1.0.4 (beta 3)" é recusado de propósito: a sugestão só serve se
// puder ir direto pro campo.
function asVersionNumber(value) {
  if (typeof value !== "string") return null;
  return /^\d+(\.\d+){1,3}$/.test(value) ? value : null;
}

function inspect(filePath) {
  const result = { version: null, fileVersion: null, signed: null };

  let fd;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return result;
  }

  try {
    const header = readChunk(fd, 0, HEADER_READ);
    if (!header || header.length < 0x40) return result;

    // --- DOS header -> offset do cabeçalho PE -------------------------
    if (header.readUInt16LE(0) !== 0x5a4d) return result; // "MZ"
    const pe = header.readUInt32LE(0x3c);
    if (pe + 24 > header.length || header.readUInt32LE(pe) !== 0x00004550) return result; // "PE\0\0"

    const sectionCount = header.readUInt16LE(pe + 6);
    const optionalHeaderSize = header.readUInt16LE(pe + 20);
    const optionalHeader = pe + 24;
    if (optionalHeader + optionalHeaderSize > header.length) return result;

    // PE32 (0x10b) e PE32+ (0x20b) divergem no tamanho de alguns campos;
    // o que muda pra nós é só onde começa a lista de diretórios.
    const magic = header.readUInt16LE(optionalHeader);
    const dataDirectories =
      magic === 0x20b ? optionalHeader + 112 : magic === 0x10b ? optionalHeader + 96 : null;
    if (dataDirectories === null) return result;

    const sectionsStart = optionalHeader + optionalHeaderSize;

    // --- 1) Assinatura: diretório 4 (Certificate Table) ---------------
    //
    // ⚠️ Este diretório é o ÚNICO cujo "endereço" já é uma posição no
    // ARQUIVO, e não um RVA. Pra nós só o tamanho importa: > 0 = existe
    // assinatura embutida.
    const certDir = dataDirectories + 4 * 8;
    if (certDir + 8 <= header.length) {
      result.signed = header.readUInt32LE(certDir + 4) > 0;
    }

    // --- 2) Versão: diretório 2 (Resource Table) ----------------------
    const resourceDir = dataDirectories + 2 * 8;
    if (resourceDir + 8 > header.length) return result;
    const resourceRva = header.readUInt32LE(resourceDir);
    const resourceSize = header.readUInt32LE(resourceDir + 4);
    if (!resourceRva || !resourceSize) return result;

    const located = rvaToFileOffset(header, sectionsStart, sectionCount, resourceRva);
    if (!located) return result;

    const length = Math.min(Math.max(resourceSize, located.rawSize), MAX_RESOURCE_READ);
    const resources = readChunk(fd, located.offset, length);
    if (!resources) return result;

    // Em vez de percorrer a árvore de recursos (raiz -> tipo RT_VERSION
    // -> nome -> idioma -> dado), trabalha DENTRO da seção de recursos.
    //
    // A troca é consciente: percorrer a árvore são ~80 linhas de saltos
    // com deslocamentos relativos, cada um deles uma chance de ler fora
    // do buffer com um arquivo malformado. Buscar as constantes é curto,
    // não tem salto nenhum, e o pior caso é sugerir uma versão errada —
    // que o admin vê na tela antes de confirmar.

    // A tabela de STRINGS vem primeiro porque é a que bate com o que o
    // Windows mostra nas propriedades do arquivo. E é a única que
    // funciona pro instalador: o Inno Setup preenche estas, mas deixa os
    // números do FIXEDFILEINFO zerados (visto no Prisma-Setup.exe 1.0.4,
    // que devolvia 0.0.0.0 antes desta ordem existir).
    result.version =
      asVersionNumber(stringValue(resources, "ProductVersion")) ??
      asVersionNumber(stringValue(resources, "FileVersion"));

    const magicBuffer = Buffer.alloc(4);
    magicBuffer.writeUInt32LE(FIXED_FILE_INFO_MAGIC);
    const found = resources.indexOf(magicBuffer);
    if (found !== -1 && found + 16 <= resources.length) {
      result.fileVersion = versionFromFixedInfo(resources, found);
    }

    // Sem string utilizável, os números servem. O app versiona em três
    // partes e o Windows guarda quatro — solta a última quando é zero.
    if (!result.version && result.fileVersion) {
      result.version = result.fileVersion.replace(/\.0$/, "");
    }
  } catch {
    // Arquivo truncado ou malformado: devolve o que já tiver sido
    // preenchido. Não saber a versão não impede publicar.
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* já fechado */
    }
  }

  return result;
}

module.exports = { inspect };
