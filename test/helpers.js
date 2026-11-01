'use strict';
// Utilitários de teste: sobe o app com um banco temporário e um cliente HTTP com cookie.
const fs = require('fs');
const os = require('os');
const path = require('path');

function setupEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ie-test-'));
  process.env.DATA_DIR = dir;
  process.env.DISABLE_SCHEDULER = '1';
  process.env.APP_URL = 'http://localhost';
  return dir;
}

class Client {
  constructor(base) {
    this.base = base;
    this.cookie = '';
    this.csrf = '';
  }

  async req(method, url, { form, json, multipart, headers = {} } = {}) {
    const h = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    let body;
    if (form) {
      const params = new URLSearchParams();
      params.append('_csrf', this.csrf);
      const entries = Array.isArray(form) ? form : Object.entries(form);
      for (const [k, v] of entries) params.append(k, v == null ? '' : String(v));
      body = params;
      h['content-type'] = 'application/x-www-form-urlencoded';
    }
    if (json) {
      body = JSON.stringify(json);
      h['content-type'] = 'application/json';
      h['x-csrf-token'] = this.csrf;
      h.accept = 'application/json';
    }
    if (multipart) {
      body = multipart;
      h.accept = 'application/json';
    }
    const res = await fetch(this.base + url, { method, headers: h, body, redirect: 'manual' });
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of setCookies) {
      const m = c.match(/^ie_sid=([^;]*)/);
      if (m) this.cookie = m[1] ? `ie_sid=${m[1]}` : '';
    }
    const ct = res.headers.get('content-type') || '';
    let text = '';
    let buffer = null;
    if (ct.includes('text') || ct.includes('json')) {
      text = await res.text();
      const m = text.match(/name="csrf-token" content="([^"]+)"/);
      if (m && m[1]) this.csrf = m[1];
    } else {
      buffer = Buffer.from(await res.arrayBuffer());
    }
    return { status: res.status, location: res.headers.get('location'), text, buffer, contentType: ct };
  }

  get(url) { return this.req('GET', url); }

  post(url, form = {}) { return this.req('POST', url, { form }); }

  postJson(url, json) { return this.req('POST', url, { json }); }
}

module.exports = { setupEnv, Client };
