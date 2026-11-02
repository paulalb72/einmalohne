// MCP-Endpunkt (Streamable HTTP, zustandslos): JSON-RPC rein, JSON raus.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PUBLIC_URL, json, readJson } from './http.ts';
import { RepoError } from './repo.ts';
import { TOOLS, ToolError } from './tools.ts';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `Direkter Schreibzugriff auf die Website ${PUBLIC_URL} – OHNE, der entalkoholisierte Wein vom Weingut Rosenhof.
Aufbau: statische Seiten, CSS und JavaScript stehen jeweils direkt in der HTML-Datei, Bilder liegen in assets/. Startseite ist index.html. animationen.html und 01-hypnose.html, 02-eiskalt.html, 03-verflogen.html sind Entwürfe für Hero-Animationen.
Änderungen sind sofort öffentlich live und werden im GitHub-Repo gesichert; jede lässt sich mit aenderung_zuruecknehmen rückgängig machen.
Vorgehen: erst dateien_liste und datei_lesen (oder suchen), dann gezielte Änderungen mit datei_ersetzen; datei_schreiben nur für neue Dateien oder komplette Neufassungen. Bilder mit bild_von_url übernehmen, möglichst als .webp.
Gestaltung: Gelb #FFF200, Schwarz #231F20, Schrift Barlow Condensed. Modern und klar, wenig Text, starke Fotos.
Bei größeren Umbauten vorher kurz bestätigen lassen, vor dem Löschen nachfragen. Nach einer Änderung den Live-Link nennen.`;

interface Message {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

async function answer(msg: Message) {
  const result = (value: unknown) => ({ jsonrpc: '2.0', id: msg.id, result: value });
  const error = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });

  switch (msg.method) {
    case 'initialize': {
      const requested = String(msg.params?.protocolVersion ?? '');
      return result({
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'einmalohne', title: 'einmalohne.de', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return result({});
    case 'tools/list':
      return result({ tools: TOOLS.map(({ run: _run, ...tool }) => tool) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return error(-32602, `Unbekanntes Tool: ${String(msg.params?.name)}`);
      try {
        const output = await tool.run((msg.params?.arguments ?? {}) as Record<string, unknown>);
        return result({ content: typeof output === 'string' ? [{ type: 'text', text: output }] : output });
      } catch (err) {
        // Fachliche Fehler gehen als Tool-Ergebnis zurück, damit Claude sie korrigieren kann.
        if (err instanceof ToolError || err instanceof RepoError) {
          return result({ content: [{ type: 'text', text: err.message }], isError: true });
        }
        console.error(err);
        const detail = err instanceof Error ? err.message : String(err);
        return result({ content: [{ type: 'text', text: `Interner Fehler: ${detail}` }], isError: true });
      }
    }
    default:
      return error(-32601, `Methode nicht unterstützt: ${String(msg.method)}`);
  }
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse) {
  // Keine Server-Push-Streams: GET und DELETE werden laut Spezifikation mit 405 beantwortet.
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' });
    return res.end();
  }
  const body = await readJson(req);
  const messages = (Array.isArray(body) ? body : [body]) as Message[];
  // Nur Anfragen mit id bekommen eine Antwort; Notifications (z. B. notifications/initialized) nicht.
  const replies = await Promise.all(
    messages
      .filter((m) => m && typeof m === 'object' && typeof m.method === 'string' && m.id !== undefined && m.id !== null)
      .map(answer),
  );

  if (!replies.length) {
    res.writeHead(202);
    return res.end();
  }
  json(res, 200, Array.isArray(body) ? replies : replies[0]);
}
