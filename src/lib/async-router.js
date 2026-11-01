'use strict';
// Router do Express 4 que encaminha erros de funções assíncronas para o tratamento de erros.
const express = require('express');

function wrap(fn) {
  if (typeof fn !== 'function' || fn.length === 4 || fn.stack) return fn;
  return function wrapped(req, res, next) {
    try {
      const r = fn(req, res, next);
      if (r && typeof r.catch === 'function') r.catch(next);
      return r;
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = function asyncRouter() {
  const router = express.Router();
  for (const m of ['get', 'post', 'use', 'all']) {
    const orig = router[m].bind(router);
    router[m] = (...args) => orig(...args.map((a) => (Array.isArray(a) ? a.map(wrap) : wrap(a))));
  }
  return router;
};
module.exports.wrap = wrap;
