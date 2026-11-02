// Werkzeuge des Claude-Konnektors: Website-Dateien lesen und ändern, Änderungen zurücknehmen.
import { lookup } from 'node:dns/promises';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { BlockList, isIP } from 'node:net';
import path from 'node:path';
import { PUBLIC_URL } from './http.ts';
import { change, history, requireReady, revert, siteRoot, type Saved } from './repo.ts';
import { isTextType, mimeOf } from './site.ts';

export class ToolError extends Error {}

export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type Args = Record<string, unknown>;

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean>;
  run: (args: Args) => Promise<string | Content[]>;
}

const MAX_FILE = 15 * 1024 * 1024;
const MAX_READ = 400 * 1024; // größere Textdateien nur abschnittsweise
const MAX_PREVIEW = 3.5 * 1024 * 1024; // Claude nimmt Bilder bis 5 MB, base64 macht sie um ein Drittel größer
const PREVIEW_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_HITS = 100;

// ---------- Hilfen ----------

function text(args: Args, key: string, fallback?: string): string {
  const value = args[key];
  if (typeof value === 'string') return value;
  if (fallback !== undefined && value == null) return fallback;
  throw new ToolError(`Parameter "${key}" fehlt.`);
}

const int = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined;

const commitMessage = (args: Args, fallback: string) =>
  (typeof args.nachricht === 'string' ? args.nachricht.trim().replace(/\s+/g, ' ').slice(0, 120) : '') || fallback;

/** Pfad relativ zur Website auflösen – nichts außerhalb, keine versteckten Dateien. */
function resolve(input: string, allowRoot = false) {
  const root = siteRoot();
  const cleaned = input.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  const full = path.resolve(root, cleaned);
  const rel = path.relative(root, full).split(path.sep).join('/');
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new ToolError(`"${input}" liegt außerhalb der Website.`);
  if (!rel && !allowRoot) throw new ToolError('Bitte einen Dateipfad angeben, z. B. index.html.');
  if (rel.split('/').some((part) => part.startsWith('.'))) throw new ToolError('Versteckte Dateien und Ordner (Name mit Punkt am Anfang) sind gesperrt.');
  return { full, rel };
}

const statOrNull = (file: string) => stat(file).catch(() => null);

async function walk(dir: string, prefix: string): Promise<{ rel: string; size: number }[]> {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const files: { rel: string; size: number }[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full, rel)));
    else if (entry.isFile()) files.push({ rel, size: (await stat(full)).size });
  }
  return files;
}

const size = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1).replace('.', ',')} KB` : `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;

const liveUrl = (rel: string) => `${PUBLIC_URL}/${rel.replace(/(^|\/)index\.html$/, '$1')}`;

function saved(result: Saved, what: string, rel?: string) {
  if (!result.commit) return 'Keine Änderung nötig – der Inhalt war bereits so.';
  const live = rel ? ` Live: ${liveUrl(rel)}` : '';
  const backup = result.pushed ? '' : ' (Sicherung auf GitHub wird automatisch nachgeholt)';
  return `${what} – gespeichert und sofort live.${live} · Änderungs-ID ${result.commit}${backup}`;
}

async function requireTextFile(full: string, rel: string) {
  if (!(await statOrNull(full))?.isFile()) throw new ToolError(`Datei "${rel}" gibt es nicht. Mit dateien_liste siehst du alle Dateien.`);
  if (!isTextType(mimeOf(full))) throw new ToolError(`${rel} ist keine Textdatei.`);
}

// ---------- Bilder aus dem Netz ----------

// Nur öffentliche Adressen: Der Server soll nicht als Brücke ins interne Netz dienen.
const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
] as const) PRIVATE.addSubnet(net, prefix, 'ipv4');
// IPv4-gemappte Adressen (::ffff:10.0.0.1) prüft BlockList selbst gegen die IPv4-Regeln.
for (const [net, prefix] of [['::', 127], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
  PRIVATE.addSubnet(net, prefix, 'ipv6');
}

async function assertPublic(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw new ToolError(`Adresse ${hostname} nicht gefunden.`);
  if (addresses.some((a) => PRIVATE.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4'))) throw new ToolError('Nur öffentliche Internetadressen sind erlaubt.');
}

async function download(url: string) {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new ToolError('Ungültige URL.');
  }
  for (let hop = 0; hop < 5; hop++) {
    if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new ToolError('Nur http- und https-Adressen sind erlaubt.');
    await assertPublic(target.hostname);
    const res = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(30_000), headers: { 'User-Agent': 'einmalohne-konnektor/1.0' } });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      target = new URL(location, target);
      continue;
    }
    if (!res.ok) throw new ToolError(`Download fehlgeschlagen (HTTP ${res.status}).`);
    if (Number(res.headers.get('content-length')) > MAX_FILE) throw new ToolError(`Das Bild ist größer als ${size(MAX_FILE)}.`);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_FILE) throw new ToolError(`Das Bild ist größer als ${size(MAX_FILE)}.`);
    return data;
  }
  throw new ToolError('Zu viele Weiterleitungen.');
}

/** Bildformat am Inhalt erkennen, nicht an Header oder Endung. */
function sniff(data: Buffer) {
  const ascii = (start: number, end: number) => data.subarray(start, end).toString('latin1');
  if (data[0] === 0x89 && ascii(1, 4) === 'PNG') return { type: 'image/png', ext: 'png' };
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (ascii(0, 4) === 'GIF8') return { type: 'image/gif', ext: 'gif' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { type: 'image/webp', ext: 'webp' };
  if (ascii(4, 12) === 'ftypavif') return { type: 'image/avif', ext: 'avif' };
  if (/<svg[\s>]/i.test(data.subarray(0, 2048).toString('utf8'))) return { type: 'image/svg+xml', ext: 'svg' };
  return null;
}

// ---------- Werkzeuge ----------

const pfad = (description: string) => ({ type: 'string', description });
const nachricht = { type: 'string', description: 'Kurze Beschreibung der Änderung für die Änderungsliste (optional)' };

export const TOOLS: Tool[] = [
  {
    name: 'dateien_liste',
    title: 'Dateien auflisten',
    description: 'Listet alle Dateien der Website (oder eines Ordners) mit Größe auf.',
    inputSchema: { type: 'object', properties: { pfad: pfad('Optionaler Ordner, z. B. "assets"') } },
    annotations: { readOnlyHint: true },
    async run(args) {
      const { full, rel } = resolve(text(args, 'pfad', ''), true);
      if (!(await statOrNull(full))?.isDirectory()) throw new ToolError(`Ordner "${rel}" gibt es nicht.`);
      const files = await walk(full, rel);
      if (!files.length) return 'Der Ordner ist leer.';
      return `${files.length} Dateien:\n${files.map((f) => `${f.rel}  (${size(f.size)})`).join('\n')}`;
    },
  },
  {
    name: 'datei_lesen',
    title: 'Datei lesen',
    description:
      'Liest eine Datei der Website. Textdateien (HTML, CSS, JS, SVG …) kommen als Text, Bilder (PNG, JPG, WebP, GIF) als Bild. Große Dateien mit von_zeile/bis_zeile abschnittsweise lesen.',
    inputSchema: {
      type: 'object',
      properties: {
        pfad: pfad('z. B. "index.html" oder "assets/bottle.webp"'),
        von_zeile: { type: 'integer', minimum: 1, description: 'Optional: erste Zeile (ab 1)' },
        bis_zeile: { type: 'integer', minimum: 1, description: 'Optional: letzte Zeile' },
      },
      required: ['pfad'],
    },
    annotations: { readOnlyHint: true },
    async run(args) {
      const { full, rel } = resolve(text(args, 'pfad'));
      const info = await statOrNull(full);
      if (!info?.isFile()) throw new ToolError(`Datei "${rel}" gibt es nicht. Mit dateien_liste siehst du alle Dateien.`);
      const type = mimeOf(full);
      if (!isTextType(type)) {
        const note = `${rel}: ${type}, ${size(info.size)} – ${liveUrl(rel)}`;
        if (!PREVIEW_TYPES.has(type) || info.size > MAX_PREVIEW) return note;
        return [{ type: 'text', text: note }, { type: 'image', data: (await readFile(full)).toString('base64'), mimeType: type }];
      }
      const content = await readFile(full, 'utf8');
      const from = int(args.von_zeile);
      const to = int(args.bis_zeile);
      if (from || to) {
        const lines = content.split('\n');
        const start = Math.max(1, from ?? 1);
        const end = Math.min(lines.length, to ?? lines.length);
        return `${rel}, Zeilen ${start}–${end} von ${lines.length}:\n${lines.slice(start - 1, end).join('\n')}`;
      }
      if (info.size > MAX_READ) {
        throw new ToolError(`${rel} ist ${size(info.size)} groß – bitte mit von_zeile/bis_zeile abschnittsweise lesen oder die Stelle mit suchen finden.`);
      }
      return content;
    },
  },
  {
    name: 'suchen',
    title: 'Text suchen',
    description: 'Sucht Text in allen Textdateien der Website und zeigt Fundstellen mit Zeilennummer.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Gesuchter Text' },
        pfad: pfad('Optional: nur in diesem Ordner oder dieser Datei suchen'),
        regex: { type: 'boolean', description: 'text als regulären Ausdruck behandeln' },
        gross_klein: { type: 'boolean', description: 'Groß-/Kleinschreibung beachten (Standard: nein)' },
      },
      required: ['text'],
    },
    annotations: { readOnlyHint: true },
    async run(args) {
      const query = text(args, 'text');
      if (!query) throw new ToolError('Bitte einen Suchtext angeben.');
      let pattern: RegExp;
      try {
        pattern = new RegExp(args.regex === true ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), args.gross_klein === true ? '' : 'i');
      } catch {
        throw new ToolError('Ungültiger regulärer Ausdruck.');
      }
      const { full, rel } = resolve(text(args, 'pfad', ''), true);
      const info = await statOrNull(full);
      if (!info) throw new ToolError(`"${rel}" gibt es nicht.`);
      const files = info.isDirectory() ? (await walk(full, rel)).map((f) => f.rel) : [rel];
      const hits: string[] = [];
      let total = 0;
      for (const file of files) {
        if (!isTextType(mimeOf(file))) continue;
        const lines = (await readFile(path.join(siteRoot(), file), 'utf8')).split('\n');
        lines.forEach((line, i) => {
          const at = line.search(pattern);
          if (at < 0) return;
          total++;
          if (hits.length >= MAX_HITS) return;
          const excerpt = line.length > 200 ? `${at > 80 ? '…' : ''}${line.slice(Math.max(0, at - 80), at + 120)}…` : line;
          hits.push(`${file}:${i + 1}: ${excerpt.trim()}`);
        });
      }
      if (!total) return 'Keine Treffer.';
      return `${total} Treffer${total > hits.length ? ` (die ersten ${hits.length})` : ''}:\n${hits.join('\n')}`;
    },
  },
  {
    name: 'datei_ersetzen',
    title: 'Text in Datei ersetzen',
    description:
      'Ersetzt einen exakten Textabschnitt in einer Datei – der beste Weg für Änderungen. "alt" muss genau so in der Datei stehen (inkl. Einrückung) und eindeutig sein; sonst mehr Kontext mitgeben oder alle=true setzen.',
    inputSchema: {
      type: 'object',
      properties: {
        pfad: pfad('z. B. "index.html"'),
        alt: { type: 'string', description: 'Bisheriger Text, exakt wie in der Datei' },
        neu: { type: 'string', description: 'Neuer Text' },
        alle: { type: 'boolean', description: 'Alle Vorkommen ersetzen (Standard: nur ein eindeutiges)' },
        nachricht,
      },
      required: ['pfad', 'alt', 'neu'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    async run(args) {
      requireReady();
      const { full, rel } = resolve(text(args, 'pfad'));
      const search = text(args, 'alt');
      const replacement = text(args, 'neu');
      if (!search) throw new ToolError('"alt" darf nicht leer sein.');
      let count = 0;
      const result = await change(commitMessage(args, `${rel} bearbeitet`), async () => {
        await requireTextFile(full, rel);
        const before = await readFile(full, 'utf8');
        // Dateien mit Windows-Zeilenenden: Claude schickt \n
        const crlf = !before.includes(search) && before.includes('\r\n');
        const find = crlf ? search.replace(/\r?\n/g, '\r\n') : search;
        const put = crlf ? replacement.replace(/\r?\n/g, '\r\n') : replacement;
        count = before.split(find).length - 1;
        if (!count) {
          throw new ToolError(`Der Text steht so nicht in ${rel}. Er muss exakt übereinstimmen (inkl. Leerzeichen und Einrückung) – den Abschnitt am besten vorher mit datei_lesen oder suchen holen.`);
        }
        if (count > 1 && args.alle !== true) {
          throw new ToolError(`Der Text kommt ${count}-mal in ${rel} vor. Mehr umgebenden Text angeben, damit er eindeutig ist, oder alle=true setzen.`);
        }
        await writeFile(full, args.alle === true ? before.split(find).join(put) : before.replace(find, () => put), 'utf8');
      });
      return saved(result, count > 1 ? `${count} Stellen in ${rel} ersetzt` : `${rel} geändert`, rel);
    },
  },
  {
    name: 'datei_schreiben',
    title: 'Datei schreiben',
    description:
      'Legt eine Datei an oder überschreibt sie komplett. Für kleine Änderungen besser datei_ersetzen nehmen. Binärdateien (z. B. Bilder) mit base64=true übergeben.',
    inputSchema: {
      type: 'object',
      properties: {
        pfad: pfad('z. B. "impressum.html" oder "assets/logo.svg"'),
        inhalt: { type: 'string', description: 'Vollständiger Dateiinhalt' },
        base64: { type: 'boolean', description: 'inhalt ist base64-kodiert (für Binärdateien)' },
        nachricht,
      },
      required: ['pfad', 'inhalt'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
    async run(args) {
      requireReady();
      const { full, rel } = resolve(text(args, 'pfad'));
      const data = Buffer.from(text(args, 'inhalt'), args.base64 === true ? 'base64' : 'utf8');
      if (data.length > MAX_FILE) throw new ToolError(`Dateien dürfen höchstens ${size(MAX_FILE)} groß sein.`);
      let existed = false;
      const result = await change(commitMessage(args, `${rel} geschrieben`), async () => {
        const info = await statOrNull(full);
        if (info?.isDirectory()) throw new ToolError(`"${rel}" ist ein Ordner.`);
        existed = !!info;
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, data);
      });
      return saved(result, `${rel} ${existed ? 'überschrieben' : 'angelegt'}`, rel);
    },
  },
  {
    name: 'bild_von_url',
    title: 'Bild aus dem Netz übernehmen',
    description:
      'Lädt ein Bild von einer öffentlichen URL und speichert es in der Website (z. B. unter assets/). Die Dateiendung muss zum Bildformat passen. Danach im HTML einbinden, z. B. <img src="assets/hof.webp" alt="…">.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Öffentliche Bild-URL (http/https)' },
        pfad: pfad('Ziel, z. B. "assets/weinberg.jpg"'),
        nachricht,
      },
      required: ['url', 'pfad'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async run(args) {
      requireReady();
      const { full, rel } = resolve(text(args, 'pfad'));
      if (!mimeOf(full).startsWith('image/')) throw new ToolError('Der Zielpfad braucht eine Bild-Endung, z. B. .webp, .jpg, .png oder .svg.');
      const data = await download(text(args, 'url'));
      const format = sniff(data);
      if (!format) throw new ToolError('Unter der URL liegt kein Bild (PNG, JPG, WebP, GIF, AVIF oder SVG).');
      if (format.type !== mimeOf(full)) throw new ToolError(`Das Bild ist ein ${format.ext.toUpperCase()} – bitte mit der Endung ".${format.ext}" speichern.`);
      const result = await change(commitMessage(args, `Bild ${rel} hinzugefügt`), async () => {
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, data);
      });
      return saved(result, `${rel} gespeichert (${size(data.length)})`, rel);
    },
  },
  {
    name: 'verschieben',
    title: 'Datei verschieben oder umbenennen',
    description: 'Verschiebt oder benennt eine Datei um. Verweise im HTML werden nicht angepasst – vorher mit suchen prüfen.',
    inputSchema: {
      type: 'object',
      properties: { von: pfad('Bisheriger Pfad'), nach: pfad('Neuer Pfad'), nachricht },
      required: ['von', 'nach'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    async run(args) {
      requireReady();
      const from = resolve(text(args, 'von'));
      const to = resolve(text(args, 'nach'));
      const result = await change(commitMessage(args, `${from.rel} → ${to.rel}`), async () => {
        if (!(await statOrNull(from.full))?.isFile()) throw new ToolError(`Datei "${from.rel}" gibt es nicht.`);
        if (await statOrNull(to.full)) throw new ToolError(`"${to.rel}" gibt es schon.`);
        await mkdir(path.dirname(to.full), { recursive: true });
        await rename(from.full, to.full);
      });
      return saved(result, `${from.rel} → ${to.rel}`, to.rel);
    },
  },
  {
    name: 'datei_loeschen',
    title: 'Datei löschen',
    description: 'Löscht eine Datei der Website. Vorher mit suchen prüfen, ob sie noch eingebunden ist.',
    inputSchema: { type: 'object', properties: { pfad: pfad('z. B. "assets/alt.jpg"'), nachricht }, required: ['pfad'] },
    annotations: { readOnlyHint: false, destructiveHint: true },
    async run(args) {
      requireReady();
      const { full, rel } = resolve(text(args, 'pfad'));
      const result = await change(commitMessage(args, `${rel} gelöscht`), async () => {
        if (!(await statOrNull(full))?.isFile()) throw new ToolError(`Datei "${rel}" gibt es nicht.`);
        await rm(full);
      });
      return saved(result, `${rel} gelöscht`);
    },
  },
  {
    name: 'aenderungen_liste',
    title: 'Letzte Änderungen',
    description: 'Zeigt die letzten Änderungen an der Website mit ID, Zeitpunkt und betroffenen Dateien.',
    inputSchema: { type: 'object', properties: { anzahl: { type: 'integer', minimum: 1, maximum: 50, description: 'Standard: 15' } } },
    annotations: { readOnlyHint: true },
    async run(args) {
      const entries = await history(Math.min(50, Math.max(1, int(args.anzahl) ?? 15)));
      if (!entries.length) return 'Noch keine Änderungen.';
      const files = (list: string[]) =>
        list.slice(0, 8).map((f) => `\n  - ${f}`).join('') + (list.length > 8 ? `\n  - … und ${list.length - 8} weitere` : '');
      return entries.map((e) => `${e.id} · ${e.date} · ${e.author}\n  ${e.message}${files(e.files)}`).join('\n\n');
    },
  },
  {
    name: 'aenderung_zuruecknehmen',
    title: 'Änderung zurücknehmen',
    description: 'Nimmt eine einzelne Änderung (ID aus aenderungen_liste) zurück. Spätere Änderungen bleiben erhalten.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Änderungs-ID, z. B. "a1b2c3d"' } }, required: ['id'] },
    annotations: { readOnlyHint: false, destructiveHint: false },
    async run(args) {
      const result = await revert(text(args, 'id').trim());
      return saved(result, result.message);
    },
  },
];
