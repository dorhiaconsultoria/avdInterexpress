'use strict';
// Recria o banco local (Postgres embutido em DATA_DIR/pgdata) com os dados iniciais e os exemplos de teste.
// Não afeta o banco do Vercel (DATABASE_URL).
const fs = require('fs');
const path = require('path');
const config = require('../src/config');

if (process.env.DATABASE_URL || process.env.POSTGRES_URL) {
  console.error('DATABASE_URL está definida: este comando só recria o banco local. Para recomeçar no Vercel, use "Apagar avaliações de teste" na tela de administração.');
  process.exit(1);
}
fs.rmSync(path.join(config.dataDir, 'pgdata'), { recursive: true, force: true });

const dbm = require('../src/db');
dbm.ready()
  .then(() => dbm.close())
  .then(() => console.log('Banco local recriado em', path.relative(process.cwd(), path.join(config.dataDir, 'pgdata'))));
