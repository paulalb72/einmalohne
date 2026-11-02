// Statische Auslieferung der Website aus der Arbeitskopie.
import { readFileSync, statSync, type Stats } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { siteRoot } from './repo.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

export const mimeOf = (file: string) => MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
export const isTextType = (type: string) => /^(text\/|image\/svg|application\/(json|xml|manifest))/.test(type);

const isHidden = (rel: string) => rel.split(/[\\/]/).some((part) => part.startsWith('.'));

function statOrNull(file: string) {
  try {
    return statSync(file);
  } catch {
    return null;
  }
}

function sendFile(req: IncomingMessage, res: ServerResponse, file: string, info: Stats, status: number) {
  const type = mimeOf(file);
  const etag = `W/"${info.size.toString(16)}-${Math.round(info.mtimeMs).toString(16)}"`;
  const headers: Record<string, string> = {
    'Content-Type': type,
    // Inhalte können sich jederzeit über den Konnektor ändern – Browser fragen per ETag nach.
    'Cache-Control': 'no-cache',
    ETag: etag,
    'Last-Modified': info.mtime.toUTCString(),
  };
  if (status === 200 && req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  let body = readFileSync(file);
  if (isTextType(type) && body.length > 1024) {
    headers.Vary = 'Accept-Encoding';
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
      body = gzipSync(body);
      headers['Content-Encoding'] = 'gzip';
    }
  }
  headers['Content-Length'] = String(body.length);
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

function notFound(req: IncomingMessage, res: ServerResponse) {
  const page = path.join(siteRoot(), '404.html');
  const info = statOrNull(page);
  if (info?.isFile()) return sendFile(req, res, page, info, 404);
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Seite nicht gefunden');
}

export function serveSite(req: IncomingMessage, res: ServerResponse, pathname: string) {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return notFound(req, res);
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const root = siteRoot();
  let file = path.resolve(root, `.${rel}`);
  if (!file.startsWith(root + path.sep) || isHidden(path.relative(root, file))) return notFound(req, res);

  let info = statOrNull(file);
  if (info?.isDirectory()) {
    res.writeHead(301, { Location: `${pathname}/` });
    return res.end();
  }
  // Saubere Adressen: /animationen statt /animationen.html
  if (!info && !path.extname(file)) {
    file += '.html';
    info = statOrNull(file);
  }
  if (!info?.isFile()) return notFound(req, res);
  sendFile(req, res, file, info, 200);
}
