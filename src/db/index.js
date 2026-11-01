'use strict';
// Banco de dados PostgreSQL.
//  - No Vercel (ou em qualquer servidor): use DATABASE_URL (ex.: Neon, criado em Vercel › Storage).
//  - No computador e nos testes, sem DATABASE_URL: Postgres embutido (PGlite), gravado em DATA_DIR/pgdata.
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const config = require('../config');

const txStore = new AsyncLocalStorage();
let driver = null; // { kind, query(sql, params), transaction(fn), close() }
let readyPromise = null;

class ConfigError extends Error {}

/** Converte os marcadores "?" para "$1, $2..." (ignorando textos entre aspas). */
function toPg(sql) {
  let out = '';
  let n = 0;
  let quote = null;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
    } else if (ch === '?') {
      n += 1;
      out += `$${n}`;
    } else out += ch;
  }
  return out;
}

/** undefined/NaN viram NULL; booleanos viram 0/1 (as colunas de sim/não são inteiros). */
function bindable(args) {
  return args.map((a) => {
    if (a === undefined) return null;
    if (typeof a === 'number' && Number.isNaN(a)) return null;
    if (typeof a === 'boolean') return a ? 1 : 0;
    return a;
  });
}

function connectionString() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
}

async function createDriver() {
  const url = connectionString();
  if (url) {
    const pg = require('pg');
    pg.types.setTypeParser(20, (v) => (v == null ? null : parseInt(v, 10))); // COUNT(*) etc.
    const needsSsl = !/localhost|127\.0\.0\.1/.test(url) && !/sslmode=disable/.test(url);
    const pool = new pg.Pool({
      connectionString: url,
      max: Number(process.env.DB_POOL_MAX || 5),
      idleTimeoutMillis: 10000,
      ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    });
    return {
      kind: 'postgres',
      async query(sql, params, client) {
        const r = await (client || pool).query(sql, params);
        return { rows: r.rows, changes: r.rowCount || 0 };
      },
      async transaction(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn(client);
          await client.query('COMMIT');
          return result;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }
  if (process.env.VERCEL) {
    throw new ConfigError('Banco de dados não conectado. No Vercel, abra o projeto › Storage › crie (ou conecte) um banco Neon Postgres e faça um novo deploy.');
  }
  const { PGlite } = require('@electric-sql/pglite');
  const dir = path.join(config.dataDir, 'pgdata');
  fs.mkdirSync(config.dataDir, { recursive: true });
  const lite = new PGlite(dir);
  await lite.waitReady;
  return {
    kind: 'pglite',
    async query(sql, params, client) {
      const r = await (client || lite).query(sql, params);
      return { rows: r.rows, changes: r.affectedRows || 0 };
    },
    transaction: (fn) => lite.transaction((tx) => fn(tx)),
    close: () => lite.close(),
  };
}

async function getDriver() {
  if (!driver) driver = await createDriver();
  return driver;
}

/** Executa uma consulta (usa a transação em andamento, se houver). */
async function query(sql, params = []) {
  const d = await getDriver();
  const ctx = txStore.getStore();
  return d.query(toPg(sql), bindable(params), ctx ? ctx.client : undefined);
}

function normalizeRow(row) {
  if (!row) return row;
  for (const k of Object.keys(row)) {
    if (row[k] instanceof Uint8Array && !Buffer.isBuffer(row[k])) row[k] = Buffer.from(row[k]);
  }
  return row;
}

async function get(sql, ...params) {
  const r = await query(sql, params);
  return r.rows.length ? normalizeRow(r.rows[0]) : undefined;
}

async function all(sql, ...params) {
  const r = await query(sql, params);
  return r.rows.map(normalizeRow);
}

async function run(sql, ...params) {
  const r = await query(sql, params);
  return { changes: r.changes };
}

/** INSERT que devolve o id criado. */
async function insert(sql, ...params) {
  const r = await query(`${sql} RETURNING id`, params);
  return r.rows[0].id;
}

/** Transação (aninhada vira SAVEPOINT). */
async function tx(fn) {
  const ctx = txStore.getStore();
  if (ctx) {
    ctx.depth += 1;
    const sp = `sp_${ctx.depth}`;
    await query(`SAVEPOINT ${sp}`);
    try {
      const result = await fn();
      await query(`RELEASE SAVEPOINT ${sp}`);
      return result;
    } catch (err) {
      await query(`ROLLBACK TO SAVEPOINT ${sp}`);
      throw err;
    } finally {
      ctx.depth -= 1;
    }
  }
  const d = await getDriver();
  return d.transaction((client) => txStore.run({ client, depth: 0 }, fn));
}

/** Cria as tabelas (se não existirem) e a carga inicial. Executado uma vez por processo. */
function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
        .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
      const statements = schema.split(';').map((s) => s.trim()).filter(Boolean);
      // Trava para dois processos não criarem as tabelas ou a carga inicial ao mesmo tempo
      await tx(async () => {
        await query('SELECT pg_advisory_xact_lock(724512)');
        for (const stmt of statements) await query(stmt);
        await require('./seed').seedIfEmpty();
      });
    })().catch((err) => {
      readyPromise = null;
      throw err;
    });
  }
  return readyPromise;
}

async function close() {
  if (driver) await driver.close();
  driver = null;
  readyPromise = null;
}

async function getSetting(key, fallback = null) {
  const row = await get('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : fallback;
}

async function setSetting(key, value) {
  await run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    key, value == null ? null : String(value));
}

async function isTestMode() {
  return (await getSetting('test_mode', '1')) === '1';
}

module.exports = {
  ready, close, query, get, all, run, insert, tx, getSetting, setSetting, isTestMode, ConfigError, toPg,
};
