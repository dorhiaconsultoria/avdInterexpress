'use strict';
// Apaga o banco e recria os dados iniciais (cadastros, matriz, hierarquia e exemplos de teste).
const fs = require('fs');
const path = require('path');
const config = require('../src/config');

for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(config.dbFile + suffix); } catch { /* não existia */ }
}
try { fs.rmSync(config.uploadsDir, { recursive: true, force: true }); } catch { /* ignora */ }

const dbm = require('../src/db');
dbm.open();
require('../src/db/seed').seedIfEmpty();
console.log('Banco recriado em', path.relative(process.cwd(), config.dbFile));
