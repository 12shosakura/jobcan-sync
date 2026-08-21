// A ~100-line router over node:http. Express would work, but this daemon holds
// live credentials and starts on login, so a smaller dependency surface and a
// faster cold start are both worth more than the framework.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function createServer({ staticDir, routes }) {
  return http.createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
      res.end(body);
    };
    const json = (status, data) =>
      send(status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8' });

    try {
      // The server holds live credentials, so refuse any request that did not
      // arrive addressed to loopback. This blocks DNS rebinding from a web page.
      const host = (req.headers.host || '').replace(/:\d+$/, '');
      if (!LOOPBACK_HOSTS.has(host)) return json(403, { error: 'Only loopback requests are allowed.' });

      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      const handler = routes[`${req.method} ${url.pathname}`];

      if (handler) {
        const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
        return await handler({ url, body, json, send, req });
      }
      if (req.method === 'GET') return serveStatic(staticDir, url.pathname, send);
      return json(404, { error: 'Not found' });
    } catch (e) {
      json(e.statusCode || 500, { error: e.message });
    }
  });
}

function readJsonBody(req, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
      }
    });
  });
}

function serveStatic(staticDir, pathname, send) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(staticDir, rel);
  // Never serve outside the web directory, whatever the request path claims.
  if (!file.startsWith(path.resolve(staticDir) + path.sep)) {
    return send(403, 'Forbidden', { 'Content-Type': 'text/plain' });
  }
  fs.readFile(file, (err, data) => {
    if (err) return send(404, 'Not found', { 'Content-Type': 'text/plain' });
    send(200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  });
}

export const html = (title, body) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px system-ui;padding:3rem;max-width:32rem"><h1>${title}</h1><p>${body}</p>` +
  `<p><a href="/">Back to Jobcan Sync</a></p>`;
