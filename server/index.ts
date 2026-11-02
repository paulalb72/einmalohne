import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setupPage } from './connect.ts';
import { HttpError, PUBLIC_URL, html, json } from './http.ts';
import { handleMcp } from './mcp.ts';
import { start } from './repo.ts';
import { serveSite } from './site.ts';

const PORT = Number(process.env.PORT) || 3000;
const TOKEN = process.env.CONNECTOR_TOKEN ?? '';

if (!TOKEN) console.warn('CONNECTOR_TOKEN ist nicht gesetzt – der Claude-Konnektor ist abgeschaltet.');
else if (TOKEN.length < 24) console.warn('Hinweis: CONNECTOR_TOKEN ist kürzer als 24 Zeichen und damit leicht zu erraten.');

const digest = (s: string) => createHash('sha256').update(s).digest();
const isToken = (candidate: string) => !!TOKEN && timingSafeEqual(digest(candidate), digest(TOKEN));

async function handle(req: IncomingMessage, res: ServerResponse) {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // SAMEORIGIN statt DENY: animationen.html bettet die drei Varianten per iframe ein.
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // www.einmalohne.de → einmalohne.de (eine Adresse für Suchmaschinen und Links)
  const host = String(req.headers.host ?? '');
  if (host.startsWith('www.')) {
    res.writeHead(301, { Location: `https://${host.slice(4)}${req.url ?? '/'}` });
    return res.end();
  }

  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  // Claude-Konnektor: Der geheime Pfad ist der Schlüssel. Falscher Schlüssel = 404, damit nichts verraten wird.
  const connector = /^\/mcp\/([^/]+)\/?$/.exec(pathname);
  if (connector) {
    if (!isToken(connector[1])) return json(res, 404, { error: 'Nicht gefunden' });
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Im Browser geöffnet: Anleitung zum Einrichten statt JSON-RPC
    if (req.method === 'GET' && String(req.headers.accept ?? '').includes('text/html')) {
      return html(res, 200, setupPage(`${PUBLIC_URL}/mcp/${TOKEN}`));
    }
    return handleMcp(req, res);
  }

  if (req.method === 'GET' || req.method === 'HEAD') return serveSite(req, res, pathname);
  res.writeHead(405, { Allow: 'GET, HEAD' });
  res.end();
}

const server = createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    if (res.headersSent) return res.end();
    if (err instanceof HttpError) return json(res, err.status, { error: err.message });
    console.error(err);
    json(res, 500, { error: 'Serverfehler' });
  });
});

server.listen(PORT, () => console.log(`einmalohne.de läuft auf http://localhost:${PORT}`));
void start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
