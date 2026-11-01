'use strict';
const bcrypt = require('bcryptjs');
const dbm = require('./index');
const config = require('../config');
const domain = require('../lib/domain');
const { nowIso } = require('../lib/util');
const { USERS, CARGOS, COMPETENCIES, MATRIX, MATRIX_V1, CYCLE_2026 } = require('./seed-data');
const { EXAMPLES, EXAMPLE_CYCLE_STARTED_AT } = require('./examples-data');

/** Cadastra pessoas, cargos, hierarquia, matriz V1 e o Ciclo 2026 (em planejamento). */
async function seedBase() {
  const now = nowIso();
  await dbm.tx(async () => {
    await dbm.setSetting('test_mode', '1');
    await dbm.setSetting('company_name', 'InterExpress');
    await dbm.setSetting('schema_version', '1');

    const userIds = {};
    for (const u of USERS) {
      const isAdmin = u.is_admin ? 1 : 0;
      const hash = isAdmin ? bcrypt.hashSync(config.adminInitialPassword, 10) : null;
      userIds[u.key] = await dbm.insert(`INSERT INTO users (name, email, password_hash, must_change_password, is_admin, is_rh, is_ceo, is_sgi, created_at)
                            VALUES (?,?,?,?,?,?,?,?,?)`, u.name, u.email, hash, isAdmin, isAdmin, u.is_rh ? 1 : 0, u.is_ceo ? 1 : 0, u.is_sgi ? 1 : 0, now);
    }

    const cargoIds = {};
    const vincIds = {};
    for (const [i, [code, title, short, area, lead]] of CARGOS.entries()) {
      cargoIds[code] = await dbm.insert('INSERT INTO cargos (code, title, short_title, area, is_leadership, sort) VALUES (?,?,?,?,?,?)', code, title, short, area, lead, i + 1);
    }
    for (const [code, , , , , holder] of CARGOS) {
      vincIds[code] = await dbm.insert('INSERT INTO vinculos (user_id, cargo_id) VALUES (?, ?)', userIds[holder], cargoIds[code]);
    }
    for (const [code, , , , , , managerCode] of CARGOS) {
      if (managerCode) await dbm.run('UPDATE vinculos SET manager_vinculo_id = ? WHERE id = ?', vincIds[managerCode], vincIds[code]);
    }

    const versionId = await dbm.insert(`INSERT INTO matrix_versions (number, version_date, status, notes, created_by, created_at, published_at)
                          VALUES (?, ?, 'vigente', ?, ?, ?, ?)`, MATRIX_V1.number, MATRIX_V1.date, MATRIX_V1.notes, userIds.bianca, now, now);
    for (const [i, c] of COMPETENCIES.entries()) {
      await dbm.run(`INSERT INTO competencies (version_id, code, name, definition, n1, n2, n3, leadership_only, sort)
                  VALUES (?,?,?,?,?,?,?,?,?)`, versionId, c.code, c.name, c.definition, c.n1, c.n2, c.n3, c.leadership_only, i + 1);
    }
    for (const [code, levels] of Object.entries(MATRIX)) {
      for (const [i, lvl] of levels.entries()) {
        await dbm.run('INSERT INTO matrix_levels (version_id, cargo_id, competency_code, required_level) VALUES (?,?,?,?)', versionId, cargoIds[code], COMPETENCIES[i].code, lvl);
      }
    }

    const cycleId = await dbm.insert(`INSERT INTO cycles (name, year, status, start_date, self_deadline, manager_deadline, feedback_deadline,
                           end_date, created_at) VALUES (?,?, 'planejamento', ?,?,?,?,?,?)`, CYCLE_2026.name, CYCLE_2026.year, CYCLE_2026.start_date, CYCLE_2026.self_deadline, CYCLE_2026.manager_deadline,
        CYCLE_2026.feedback_deadline, CYCLE_2026.end_date, now);
    await domain.syncChecklists(cycleId);
  });
}

/** Apaga avaliações, plano de ação, assinaturas e anexos; o ciclo volta ao planejamento. */
async function clearEvaluations() {
  await dbm.tx(async () => {
    await dbm.run('DELETE FROM signatures');
    await dbm.run('DELETE FROM action_items');
    await dbm.run('DELETE FROM attachments');
    await dbm.run('DELETE FROM evaluation_items');
    await dbm.run('DELETE FROM evaluations');
    await dbm.run('DELETE FROM reminders_sent');
    await dbm.run(`UPDATE checklists SET status = 'nao_iniciada', results_released_at = NULL, results_released_by = NULL,
                manager_notes = NULL, employee_comment = NULL, closed_at = NULL`);
    await dbm.run(`UPDATE cycles SET status = 'planejamento', started_at = NULL, closed_at = NULL, matrix_version_id = NULL
                 WHERE status != 'encerrado'`);
  });
  const cycle = await domain.currentCycle();
  if (cycle) await domain.syncChecklists(cycle.id);
}

/** Inicia o ciclo atual (se em planejamento) e carrega as 3 avaliações de exemplo. */
async function loadExamples() {
  const cycle = await domain.currentCycle();
  if (!cycle) return 0;
  const version = await domain.vigenteVersion();
  if (cycle.status === 'planejamento') {
    await dbm.run("UPDATE cycles SET status = 'em_andamento', started_at = ?, matrix_version_id = ? WHERE id = ?", EXAMPLE_CYCLE_STARTED_AT, version.id, cycle.id);
  }
  await domain.syncChecklists(cycle.id);
  const admin = await dbm.get('SELECT * FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1');
  let loaded = 0;

  await dbm.tx(async () => {
    for (const ex of EXAMPLES) {
      const cl = await dbm.get(`SELECT cl.* FROM checklists cl JOIN cargos c ON c.id = cl.cargo_id
                              WHERE cl.cycle_id = ? AND c.code = ? AND cl.self_verification = 0`, cycle.id, ex.cargo);
      if (!cl) continue;
      if (await dbm.get('SELECT 1 FROM evaluations WHERE checklist_id = ?', cl.id)) continue;
      const owner = await domain.getUser(cl.user_id);
      const evaluator = await domain.getUser(cl.evaluator_user_id);
      const { applicable } = await domain.checklistCompetencies(await domain.getChecklist(cl.id));
      const codes = new Set(applicable.map((c) => c.code));

      const insertEval = async (kind, data, evaluatorId) => {
        const evId = await dbm.insert(`INSERT INTO evaluations (checklist_id, kind, evaluator_user_id, status, started_at, updated_at, submitted_at)
                              VALUES (?, ?, ?, 'enviada', ?, ?, ?)`, cl.id, kind, evaluatorId, data.started_at, data.submitted_at, data.submitted_at);
        for (const [code, [rating, evidence]] of Object.entries(data.items)) {
          if (!codes.has(code)) continue;
          await dbm.run('INSERT INTO evaluation_items (evaluation_id, competency_code, rating, evidence, updated_at) VALUES (?,?,?,?,?)', evId, code, rating, evidence, data.submitted_at);
        }
      };
      if (ex.auto) await insertEval('auto', ex.auto, owner.id);
      if (ex.gestor) await insertEval('gestor', ex.gestor, evaluator.id);
      if (ex.gestor) await domain.syncGapActions(cl.id);
      if (ex.released_at) {
        await dbm.run('UPDATE checklists SET results_released_at = ?, results_released_by = ? WHERE id = ?', ex.released_at, admin ? admin.id : null, cl.id);
      }
      if (ex.manager_notes) await dbm.run('UPDATE checklists SET manager_notes = ? WHERE id = ?', ex.manager_notes, cl.id);
      if (ex.employee_comment) await dbm.run('UPDATE checklists SET employee_comment = ? WHERE id = ?', ex.employee_comment, cl.id);

      const ts = ex.released_at || nowIso();
      for (const a of ex.actions) {
        if (a.origin === 'lacuna') {
          await dbm.run(`UPDATE action_items SET action = ?, responsible = ?, due_date = ?, status = ?, updated_at = ?
                       WHERE checklist_id = ? AND origin = 'lacuna' AND competency_code = ?`, a.action || null, a.responsible || null, a.due_date || null, a.status || 'nao_iniciada', ts, cl.id, a.code);
        } else {
          const proposer = a.proposed === 'colaborador' ? owner.id : evaluator.id;
          await dbm.run(`INSERT INTO action_items (checklist_id, origin, category, action, responsible, due_date, status, proposed_by,
                       validated_by, validated_at, created_at, updated_at) VALUES (?, 'livre', ?,?,?,?,?,?,?,?,?,?)`, cl.id, a.category, a.action, a.responsible, a.due_date, a.status || 'nao_iniciada', proposer,
              a.validated ? evaluator.id : null, a.validated ? ts : null, ts, ts);
        }
      }
      for (const s of ex.signatures) {
        const signer = s.role === 'colaborador' ? owner : evaluator;
        await dbm.run('INSERT INTO signatures (checklist_id, role, user_id, signer_name, signed_at, comment, ip) VALUES (?,?,?,?,?,?,?)', cl.id, s.role, signer.id, signer.name, s.signed_at, s.comment || null, 'exemplo');
      }
      await domain.refreshStatus(cl.id);
      loaded += 1;
    }
  });
  return loaded;
}

async function seedIfEmpty() {
  const count = (await dbm.get('SELECT COUNT(*) AS n FROM users')).n;
  if (count > 0) return false;
  await seedBase();
  await loadExamples();
  return true;
}

module.exports = { seedBase, seedIfEmpty, clearEvaluations, loadExamples };
