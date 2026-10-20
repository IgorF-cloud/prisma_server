// Conexão com o Postgres + o runner de migrations (2026-09-10).
//
// POR QUE MIGRATIONS, e não os scripts de docker-entrypoint-initdb.d:
// aqueles rodam UMA vez só, quando o Postgres encontra o diretório de
// dados vazio — da segunda subida em diante o Postgres ignora a pasta
// inteira. Ou seja, serviriam pra criar o banco na primeira vez e nunca
// mais, e "adicionar uma coluna" viraria "apagar o volume e perder todos
// os usuários" (schema e dados moram no MESMO lugar no Postgres, não em
// arquivos separados).
//
// Com este runner, adicionar coluna/tabela é: criar
// db/migrations/00N_descricao.sql e subir o container. Ele aplica só o
// que ainda não rodou, funciona igual num banco vazio e num banco cheio,
// e não encosta em dado nenhum.

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  // Poucos usuários e um container só — o pool existe mais pra não abrir
  // conexão a cada request do que por concorrência.
  max: 10,
});

function query(text, params) {
  return pool.query(text, params);
}

// O Postgres do compose sobe junto com o servidor, e o `depends_on` com
// healthcheck cobre o caso normal — mas numa VM lenta o primeiro boot do
// banco (initdb) passa do healthcheck e ainda recusa conexão por alguns
// instantes. Sem esta espera, o servidor morreria no boot e o
// `restart: unless-stopped` ficaria reiniciando em loop.
async function waitForDatabase({ attempts = 30, delayMs = 1000 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      if (i === attempts) throw err;
      console.log(
        `[db] Postgres ainda não respondeu (tentativa ${i}/${attempts}): ${err.code || err.message}`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function runMigrations() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text        PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await query("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
  );

  // Ordem alfabética = ordem numérica por causa do prefixo 00N. Se um dia
  // passar de 999 migrations, o prefixo precisa de mais um dígito.
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      // Transação por migration: se o .sql falhar no meio, nada dele fica
      // aplicado e o nome não entra em schema_migrations — então a
      // próxima subida tenta de novo do zero, em vez de continuar de um
      // estado meio-aplicado.
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`[db] migration aplicada: ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`[db] FALHOU a migration ${file}:`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  if (files.length === applied.size) {
    console.log(`[db] schema em dia (${files.length} migration(s))`);
  }
}

module.exports = { pool, query, waitForDatabase, runMigrations };
