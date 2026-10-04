#!/usr/bin/env node
/* Preview the built iPad edition locally: http://localhost:4322/ipad/

   Service workers run on localhost without HTTPS, so offline mode can be
   tested here (DevTools → Network → Offline). An iPad on the same Wi-Fi can
   load the page from your Mac's IP, but it won't work offline that way —
   Safari only allows service workers over HTTPS. Use the deployed URL on the
   iPad itself. */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const PORT = Number(process.env.PORT) || 4322;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '/ipad') {
      res.writeHead(302, { Location: '/ipad/index.html' });
      return res.end();
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, () => console.log(`iPad edition at http://localhost:${PORT}/ipad/`));
