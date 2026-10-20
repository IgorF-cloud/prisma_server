// SQL da versão publicada do app (2026-09-10). Substitui o version.json,
// que era lido do disco a cada GET /version.
//
// A tabela tem UMA linha só, garantida pelo `CHECK (id = 1)` da migration
// 001 — por isso todas as queries daqui fixam `id = 1` em vez de aceitar
// um id de fora.

const { query } = require("./index");

// Mesmas chaves que o version.json tinha, porque é o que o app já lê
// (ver src/main/update.ts no Electron): version, installerFilename,
// sha256. Renomear qualquer uma aqui quebra a auto-atualização de todo
// app já instalado.
function toPublic(row) {
  return {
    version: row.version,
    installerFilename: row.installer_filename,
    sha256: row.sha256,
  };
}

// O MESMO de cima, mais quando e por quem (2026-09-16, painel de
// administração). Separado porque o `toPublic` alimenta o app de todo
// mundo, e nome de admin não é informação que precise sair de lá.
function toAdmin(row) {
  return {
    ...toPublic(row),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by ?? null,
  };
}

async function get() {
  const { rows } = await query("SELECT * FROM app_version WHERE id = 1");
  return rows[0] ? toPublic(rows[0]) : null;
}

async function set({ version, installerFilename, sha256, updatedBy }) {
  const { rows } = await query(
    `UPDATE app_version
        SET version            = COALESCE($1, version),
            installer_filename = COALESCE($2, installer_filename),
            sha256             = COALESCE($3, sha256),
            updated_by         = COALESCE($4, updated_by),
            updated_at         = now()
      WHERE id = 1
      RETURNING *`,
    [version ?? null, installerFilename ?? null, sha256 ?? null, updatedBy ?? null],
  );
  return rows[0] ? toPublic(rows[0]) : null;
}

// Pro painel: a mesma linha, com a data e o id de quem publicou.
async function getForAdmin() {
  const { rows } = await query("SELECT * FROM app_version WHERE id = 1");
  return rows[0] ? toAdmin(rows[0]) : null;
}

module.exports = { get, set, getForAdmin };
