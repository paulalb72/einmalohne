import type { IncomingMessage, ServerResponse } from 'node:http';

// Bilder kommen base64-kodiert im JSON an (15 MB Datei ≈ 20 MB Text).
const MAX_BODY = 25 * 1024 * 1024;

/** Öffentliche Adresse der Website – für Links in Tool-Antworten und auf der Einrichtungsseite. */
export const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://einmalohne.de').replace(/\/+$/, '');

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

export function html(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'JSON erwartet');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Anfrage zu groß');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Ungültiges JSON');
  }
}
