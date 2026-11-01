'use strict';
// Banco SQLite embutido no próprio Node.js (node:sqlite): não precisa compilar nada na instalação.
const fs = require('fs');
const path = require('path');
const config = require('../config');

let db;

function loadDriver() {
  try {
    return require('node:sqlite');
  } catch (err) {
    const e = new Error(`Este sistema precisa do Node.js 22.13 ou mais recente (versão atual: ${process.version}). Instale a versão LTS em https://nodejs.org`);
    e.cause = err;
    throw e;
  }
}

/** Valores que o SQLite aceita: undefined vira NULL e booleanos viram 0/1. */
function bindable(args) {
  return args.map((a) => {
    if (a === undefined) return null;
    if (typeof a === 'boolean') return a ? 1 : 0;
    return a;
  });
}

/**
 * Envolve a conexão com a mesma interface usada no código:
 * prepare(sql).run/get/all e transaction(fn) com suporte a transações aninhadas.
 */
function wrap(conn) {
  let depth = 0;
  return {
    exec: (sql) => conn.exec(sql),
    close: () => conn.close(),
    prepare(sql) {
      const st = conn.prepare(sql);
      return {
        run: (...args) => st.run(...bindable(args)),
        get: (...args) => {
          const row = st.get(...bindable(args));
          return row ? { ...row } : row;
        },
        all: (...args) => st.all(...bindable(args)).map((row) => ({ ...row })),
      };
    },
    transaction(fn) {
      return (...args) => {
        const level = depth;
        const sp = `sp_${level}`;
        conn.exec(level === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`);
        depth += 1;
        try {
          const result = fn(...args);
          depth -= 1;
          conn.exec(level === 0 ? 'COMMIT' : `RELEASE ${sp}`);
          return result;
        } catch (err) {
          depth -= 1;
          if (level === 0) conn.exec('ROLLBACK');
          else {
            conn.exec(`ROLLBACK TO ${sp}`);
            conn.exec(`RELEASE ${sp}`);
          }
          throw err;
        }
      };
    },
  };
}

function open(file = config.dbFile) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  const { DatabaseSync } = loadDriver();
  const conn = new DatabaseSync(file);
  conn.exec('PRAGMA journal_mode = WAL');
  conn.exec('PRAGMA foreign_keys = ON');
  conn.exec('PRAGMA busy_timeout = 5000');
  conn.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  db = wrap(conn);
  return db;
}

function get() {
  if (!db) open();
  return db;
}

function close() {
  if (db) db.close();
  db = undefined;
}

function getSetting(key, fallback = null) {
  const row = get().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  get().prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? null : String(value));
}

function isTestMode() {
  return getSetting('test_mode', '1') === '1';
}

module.exports = { open, get, close, getSetting, setSetting, isTestMode };
