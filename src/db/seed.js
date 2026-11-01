'use strict';
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const dbm = require('./index');
const config = require('../config');
const domain = require('../lib/domain');
const { nowIso } = require('../lib/util');
const { USERS, CARGOS, COMPETENCIES, MATRIX, MATRIX_V1, CYCLE_2026 } = require('./seed-data');
const { EXAMPLES, EXAMPLE_CYCLE_STARTED_AT } = require('./examples-data');

/** Cadastra pessoas, cargos, hierarquia, matriz V1 e o Ciclo 2026 (em planejamento). */
function seedBase() {
  const db = dbm.get();
  const now = nowIso();
  const tx = db.transaction(() => {
    dbm.setSetting('test_mode', '1');
    dbm.setSetting('company_name', 'InterExpress');
    dbm.setSetting('schema_version', '1');

    const userIds = {};
    for (const u of USERS) {
      const isAdmin = u.is_admin ? 1 : 0;
      const hash = isAdmin ? bcrypt.hashSync(config.adminInitialPassword, 10) : null;
      const r = db.prepare(`INSERT INTO users (name, email, password_hash, must_change_password, is_admin, is_rh, is_ceo, is_sgi, created_at)
                            VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(u.name, u.email, hash, isAdmin, isAdmin, u.is_rh ? 1 : 0, u.is_ceo ? 1 : 0, u.is_sgi ? 1 : 0, now);
      userIds[u.key] = r.lastInsertRowid;
    }

    const cargoIds = {};
    const vincIds = {};
    CARGOS.forEach(([code, title, short, area, lead], i) => {
      const r = db.prepare('INSERT INTO cargos (code, title, short_title, area, is_leadership, sort) VALUES (?,?,?,?,?,?)')
        .run(code, title, short, area, lead, i + 1);
      cargoIds[code] = r.lastInsertRowid;
    });
    for (const [code, , , , , holder] of CARGOS) {
      const r = db.prepare('INSERT INTO vinculos (user_id, cargo_id) VALUES (?, ?)').run(userIds[holder], cargoIds[code]);
      vincIds[code] = r.lastInsertRowid;
    }
    for (const [code, , , , , , managerCode] of CARGOS) {
      if (managerCode) db.prepare('UPDATE vinculos SET manager_vinculo_id = ? WHERE id = ?').run(vincIds[managerCode], vincIds[code]);
    }

    const v = db.prepare(`INSERT INTO matrix_versions (number, version_date, status, notes, created_by, created_at, published_at)
                          VALUES (?, ?, 'vigente', ?, ?, ?, ?)`)
      .run(MATRIX_V1.number, MATRIX_V1.date, MATRIX_V1.notes, userIds.bianca, now, now);
    const versionId = v.lastInsertRowid;
    COMPETENCIES.forEach((c, i) => {
      db.prepare(`INSERT INTO competencies (version_id, code, name, definition, n1, n2, n3, leadership_only, sort)
                  VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(versionId, c.code, c.name, c.definition, c.n1, c.n2, c.n3, c.leadership_only, i + 1);
    });
    for (const [code, levels] of Object.entries(MATRIX)) {
      levels.forEach((lvl, i) => {
        db.prepare('INSERT INTO matrix_levels (version_id, cargo_id, competency_code, required_level) VALUES (?,?,?,?)')
          .run(versionId, cargoIds[code], COMPETENCIES[i].code, lvl);
      });
    }

    const c = db.prepare(`INSERT INTO cycles (name, year, status, start_date, self_deadline, manager_deadline, feedback_deadline,
                           end_date, created_at) VALUES (?,?, 'planejamento', ?,?,?,?,?,?)`)
      .run(CYCLE_2026.name, CYCLE_2026.year, CYCLE_2026.start_date, CYCLE_2026.self_deadline, CYCLE_2026.manager_deadline,
        CYCLE_2026.feedback_deadline, CYCLE_2026.end_date, now);
    domain.syncChecklists(c.lastInsertRowid);
  });
  tx();
}

/** Apaga avaliações, plano de ação, assinaturas e anexos; o ciclo volta ao planejamento. */
function clearEvaluations() {
  const db = dbm.get();
  const files = db.prepare('SELECT stored_name FROM attachments').all();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM signatures').run();
    db.prepare('DELETE FROM action_items').run();
    db.prepare('DELETE FROM attachments').run();
    db.prepare('DELETE FROM evaluation_items').run();
    db.prepare('DELETE FROM evaluations').run();
    db.prepare('DELETE FROM reminders_sent').run();
    db.prepare(`UPDATE checklists SET status = 'nao_iniciada', results_released_at = NULL, results_released_by = NULL,
                manager_notes = NULL, employee_comment = NULL, closed_at = NULL`).run();
    db.prepare(`UPDATE cycles SET status = 'planejamento', started_at = NULL, closed_at = NULL, matrix_version_id = NULL
                 WHERE status != 'encerrado'`).run();
  });
  tx();
  for (const f of files) {
    try { fs.unlinkSync(path.join(config.uploadsDir, f.stored_name)); } catch { /* arquivo já removido */ }
  }
  const cycle = domain.currentCycle();
  if (cycle) domain.syncChecklists(cycle.id);
}

/** Inicia o ciclo atual (se em planejamento) e carrega as 3 avaliações de exemplo. */
function loadExamples() {
  const db = dbm.get();
  const cycle = domain.currentCycle();
  if (!cycle) return 0;
  const version = domain.vigenteVersion();
  if (cycle.status === 'planejamento') {
    db.prepare("UPDATE cycles SET status = 'em_andamento', started_at = ?, matrix_version_id = ? WHERE id = ?")
      .run(EXAMPLE_CYCLE_STARTED_AT, version.id, cycle.id);
  }
  domain.syncChecklists(cycle.id);
  const admin = db.prepare('SELECT * FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1').get();
  let loaded = 0;

  const tx = db.transaction(() => {
    for (const ex of EXAMPLES) {
      const cl = db.prepare(`SELECT cl.* FROM checklists cl JOIN cargos c ON c.id = cl.cargo_id
                              WHERE cl.cycle_id = ? AND c.code = ? AND cl.self_verification = 0`).get(cycle.id, ex.cargo);
      if (!cl) continue;
      if (db.prepare('SELECT 1 FROM evaluations WHERE checklist_id = ?').get(cl.id)) continue;
      const owner = domain.getUser(cl.user_id);
      const evaluator = domain.getUser(cl.evaluator_user_id);
      const { applicable } = domain.checklistCompetencies(domain.getChecklist(cl.id));
      const codes = new Set(applicable.map((c) => c.code));

      const insertEval = (kind, data, evaluatorId) => {
        const r = db.prepare(`INSERT INTO evaluations (checklist_id, kind, evaluator_user_id, status, started_at, updated_at, submitted_at)
                              VALUES (?, ?, ?, 'enviada', ?, ?, ?)`)
          .run(cl.id, kind, evaluatorId, data.started_at, data.submitted_at, data.submitted_at);
        for (const [code, [rating, evidence]] of Object.entries(data.items)) {
          if (!codes.has(code)) continue;
          db.prepare('INSERT INTO evaluation_items (evaluation_id, competency_code, rating, evidence, updated_at) VALUES (?,?,?,?,?)')
            .run(r.lastInsertRowid, code, rating, evidence, data.submitted_at);
        }
      };
      if (ex.auto) insertEval('auto', ex.auto, owner.id);
      if (ex.gestor) insertEval('gestor', ex.gestor, evaluator.id);
      if (ex.gestor) domain.syncGapActions(cl.id);
      if (ex.released_at) {
        db.prepare('UPDATE checklists SET results_released_at = ?, results_released_by = ? WHERE id = ?')
          .run(ex.released_at, admin ? admin.id : null, cl.id);
      }
      if (ex.manager_notes) db.prepare('UPDATE checklists SET manager_notes = ? WHERE id = ?').run(ex.manager_notes, cl.id);
      if (ex.employee_comment) db.prepare('UPDATE checklists SET employee_comment = ? WHERE id = ?').run(ex.employee_comment, cl.id);

      const ts = ex.released_at || nowIso();
      for (const a of ex.actions) {
        if (a.origin === 'lacuna') {
          db.prepare(`UPDATE action_items SET action = ?, responsible = ?, due_date = ?, status = ?, updated_at = ?
                       WHERE checklist_id = ? AND origin = 'lacuna' AND competency_code = ?`)
            .run(a.action || null, a.responsible || null, a.due_date || null, a.status || 'nao_iniciada', ts, cl.id, a.code);
        } else {
          const proposer = a.proposed === 'colaborador' ? owner.id : evaluator.id;
          db.prepare(`INSERT INTO action_items (checklist_id, origin, category, action, responsible, due_date, status, proposed_by,
                       validated_by, validated_at, created_at, updated_at) VALUES (?, 'livre', ?,?,?,?,?,?,?,?,?,?)`)
            .run(cl.id, a.category, a.action, a.responsible, a.due_date, a.status || 'nao_iniciada', proposer,
              a.validated ? evaluator.id : null, a.validated ? ts : null, ts, ts);
        }
      }
      for (const s of ex.signatures) {
        const signer = s.role === 'colaborador' ? owner : evaluator;
        db.prepare('INSERT INTO signatures (checklist_id, role, user_id, signer_name, signed_at, comment, ip) VALUES (?,?,?,?,?,?,?)')
          .run(cl.id, s.role, signer.id, signer.name, s.signed_at, s.comment || null, 'exemplo');
      }
      domain.refreshStatus(cl.id);
      loaded += 1;
    }
  });
  tx();
  return loaded;
}

function seedIfEmpty() {
  const db = dbm.get();
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return false;
  seedBase();
  loadExamples();
  return true;
}

module.exports = { seedBase, seedIfEmpty, clearEvaluations, loadExamples };
