/* InterExpress · Verificação de Competências — comportamento das páginas */
(function () {
  'use strict';

  var csrfMeta = document.querySelector('meta[name="csrf-token"]');
  var CSRF = csrfMeta ? csrfMeta.getAttribute('content') : '';

  /* Menu no celular */
  var toggle = document.querySelector('[data-nav-toggle]');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var nav = document.getElementById('mainnav');
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  /* Confirmações (formulários e botões com data-confirm) */
  document.addEventListener('submit', function (e) {
    var form = e.target;
    var submitter = e.submitter;
    var msg = (submitter && submitter.getAttribute('data-confirm')) || form.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) e.preventDefault();
  });

  /* Selects que enviam o formulário ao mudar */
  document.querySelectorAll('select[data-autosubmit]').forEach(function (sel) {
    sel.addEventListener('change', function () { if (sel.value) sel.form.submit(); });
  });

  /* Copiar link */
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var input = btn.parentElement.querySelector('[data-copy-src]');
      input.select();
      var done = function () { btn.textContent = 'Copiado!'; };
      if (navigator.clipboard) navigator.clipboard.writeText(input.value).then(done, function () { document.execCommand('copy'); done(); });
      else { document.execCommand('copy'); done(); }
    });
  });

  /* ------------------------------------------------ formulário de avaliação */
  var form = document.querySelector('form[data-autosave]');
  if (!form) return;

  var saveUrl = form.getAttribute('data-autosave');
  var uploadUrl = form.getAttribute('data-upload');
  var showRequired = form.getAttribute('data-show-required') === '1';
  var stateEl = document.querySelector('[data-save-state]');
  var barEl = document.querySelector('[data-progress-bar]');
  var doneEl = document.querySelector('[data-progress-done]');
  var progressEl = document.querySelector('.progress');
  var pending = {};
  var timer = null;
  var saving = false;

  function setState(text, isError) {
    if (!stateEl) return;
    stateEl.textContent = text;
    stateEl.classList.toggle('error', !!isError);
  }

  function collect(code) {
    var checked = form.querySelector('input[name="rating_' + code + '"]:checked');
    var ta = form.querySelector('textarea[name="evidence_' + code + '"]');
    return { code: code, rating: checked ? Number(checked.value) : null, evidence: ta ? ta.value : '' };
  }

  function updateLocal() {
    var comps = form.querySelectorAll('.comp');
    var done = 0;
    comps.forEach(function (c) {
      var d = collect(c.getAttribute('data-code'));
      if (d.rating && d.evidence.trim()) done += 1;
      if (showRequired) {
        var req = Number(c.getAttribute('data-required'));
        var gapEl = c.querySelector('[data-gap]');
        if (gapEl) {
          if (!d.rating) gapEl.innerHTML = '<span class="muted">—</span>';
          else if (d.rating >= req) gapEl.innerHTML = '<span class="badge badge-success"><span aria-hidden="true">✓</span> Atende</span>';
          else gapEl.innerHTML = '<span class="badge badge-danger"><span aria-hidden="true">!</span> Lacuna (' + (d.rating - req) + ')</span>';
        }
      }
    });
    var pct = comps.length ? Math.round(done / comps.length * 100) : 0;
    if (barEl) barEl.style.width = pct + '%';
    if (progressEl) progressEl.setAttribute('aria-valuenow', String(pct));
    if (doneEl) doneEl.textContent = String(done);
  }

  function flush() {
    var codes = Object.keys(pending);
    if (!codes.length || saving) return;
    pending = {};
    saving = true;
    setState('Salvando…');
    fetch(saveUrl, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-CSRF-Token': CSRF },
      body: JSON.stringify({ items: codes.map(collect) })
    }).then(function (r) {
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Erro ao salvar'); return j; });
    }).then(function (j) {
      setState('Rascunho salvo às ' + j.savedAt);
    }).catch(function (err) {
      codes.forEach(function (c) { pending[c] = true; });
      setState((err && err.message ? err.message : 'Não foi possível salvar') + '. Tentaremos de novo; ou use "Salvar rascunho".', true);
    }).then(function () {
      saving = false;
      if (Object.keys(pending).length) schedule(null, 4000);
    });
  }

  function schedule(code, delay) {
    if (code) pending[code] = true;
    setState('Alterações não salvas…');
    clearTimeout(timer);
    timer = setTimeout(flush, delay);
  }

  form.addEventListener('change', function (e) {
    var comp = e.target.closest('.comp');
    if (!comp || e.target.type === 'file') return;
    updateLocal();
    schedule(comp.getAttribute('data-code'), 300);
  });
  form.addEventListener('input', function (e) {
    if (e.target.tagName !== 'TEXTAREA') return;
    var comp = e.target.closest('.comp');
    if (!comp) return;
    updateLocal();
    schedule(comp.getAttribute('data-code'), 1200);
  });
  form.addEventListener('submit', function () { pending = {}; clearTimeout(timer); });
  window.addEventListener('beforeunload', function (e) {
    if (Object.keys(pending).length || saving) { e.preventDefault(); e.returnValue = ''; }
  });

  /* Anexos de evidência */
  function attachItem(list, id, name) {
    var li = document.createElement('li');
    li.setAttribute('data-attach-id', id);
    var a = document.createElement('a');
    a.href = '/anexos/' + id;
    a.textContent = name;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'linklike danger';
    btn.setAttribute('data-attach-remove', id);
    btn.textContent = 'remover';
    li.appendChild(a);
    li.appendChild(document.createTextNode(' '));
    li.appendChild(btn);
    list.appendChild(li);
  }

  form.addEventListener('change', function (e) {
    var input = e.target;
    if (!input.matches('[data-attach-input]') || !input.files.length) return;
    var box = input.closest('[data-attach]');
    var msg = box.querySelector('[data-attach-msg]');
    var file = input.files[0];
    if (file.size > 10 * 1024 * 1024) { msg.textContent = 'Arquivo maior que 10 MB.'; input.value = ''; return; }
    var fd = new FormData();
    fd.append('_csrf', CSRF);
    fd.append('code', input.getAttribute('data-code'));
    fd.append('arquivo', file);
    msg.textContent = 'Enviando ' + file.name + '…';
    fetch(uploadUrl, { method: 'POST', body: fd, credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Falha no envio'); return j; }); })
      .then(function (j) { attachItem(box.querySelector('[data-attach-list]'), j.id, j.name); msg.textContent = 'Arquivo anexado.'; })
      .catch(function (err) { msg.textContent = err.message; })
      .then(function () { input.value = ''; });
  });

  form.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-attach-remove]');
    if (!btn) return;
    if (!window.confirm('Remover este anexo?')) return;
    var id = btn.getAttribute('data-attach-remove');
    fetch('/anexos/' + id + '/excluir', { method: 'POST', credentials: 'same-origin', headers: { 'Accept': 'application/json', 'X-CSRF-Token': CSRF } })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Falha'); return j; }); })
      .then(function () { var li = btn.closest('li'); li.parentNode.removeChild(li); })
      .catch(function (err) { window.alert(err.message); });
  });

  updateLocal();
})();
