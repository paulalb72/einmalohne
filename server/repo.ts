// Arbeitskopie des Website-Repos. Die Seite wird direkt aus ihr ausgeliefert:
// Änderungen über den Konnektor sind sofort live und landen als Commit auf GitHub.
// Umgekehrt holt ein Abgleich jede Minute neue Commits von GitHub (z. B. lokal gepushte).
import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const REPO = process.env.GIT_REPO ?? '';
const BRANCH = process.env.GIT_BRANCH || 'main';
const WORK_DIR = path.resolve(process.env.WORK_DIR || path.join(tmpdir(), 'einmalohne'));
const SITE = 'site';
const BAKED_SITE = path.join(import.meta.dirname, '..', SITE);
const SYNC_MS = 60_000;
const AUTHOR = 'Claude-Konnektor';
const EMAIL = 'konnektor@einmalohne.de';

// GitHub-Hostschlüssel fest hinterlegt, statt ihn beim ersten Kontakt ungeprüft zu übernehmen.
const GITHUB_HOST_KEY = 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';

/** Fehler, die Claude als Tool-Ergebnis sieht und selbst beheben kann. */
export class RepoError extends Error {}

let ready = false;

/** Ordner, aus dem die Website gerade ausgeliefert wird – bis die Arbeitskopie steht, die Kopie aus dem Image. */
export const siteRoot = () => (ready ? path.join(WORK_DIR, SITE) : BAKED_SITE);

export function requireReady() {
  if (ready) return;
  throw new RepoError(
    REPO ? 'Die Website wird gerade geladen. Bitte in einer Minute noch einmal versuchen.' : 'Speichern ist nicht eingerichtet (GIT_REPO fehlt).',
  );
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: AUTHOR,
    GIT_AUTHOR_EMAIL: EMAIL,
    GIT_COMMITTER_NAME: AUTHOR,
    GIT_COMMITTER_EMAIL: EMAIL,
  };
  const key = process.env.GIT_SSH_KEY_B64;
  if (!key) return env;
  // Deploy-Key (Schreibrecht nur für dieses eine Repo) kommt base64-kodiert aus der Umgebung.
  const dir = path.join(tmpdir(), 'einmalohne-ssh');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyFile = path.join(dir, 'deploy_key');
  const knownHosts = path.join(dir, 'known_hosts');
  writeFileSync(keyFile, `${Buffer.from(key, 'base64').toString('utf8').trimEnd()}\n`, { mode: 0o600 });
  writeFileSync(knownHosts, `${GITHUB_HOST_KEY}\n`);
  env.GIT_SSH_COMMAND = `ssh -i ${keyFile} -o IdentitiesOnly=yes -o UserKnownHostsFile=${knownHosts} -o StrictHostKeyChecking=yes`;
  return env;
}

const ENV = gitEnv();

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function git(args: string[], cwd = WORK_DIR) {
  try {
    const { stdout } = await exec('git', ['-c', 'core.quotePath=false', ...args], { cwd, env: ENV, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const { stderr } = err as { stderr?: string };
    throw new Error(`git ${args[0]}: ${(stderr || errorText(err)).trim()}`);
  }
}

// Alle Git-Vorgänge laufen nacheinander, damit sich Änderungen und Abgleich nicht in die Quere kommen.
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.then(job, job);
  queue = next.catch(() => {});
  return next;
}

async function clone() {
  rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(path.dirname(WORK_DIR), { recursive: true });
  await git(['clone', '--quiet', '--branch', BRANCH, REPO, WORK_DIR], path.dirname(WORK_DIR));
  ready = true;
}

async function pull() {
  try {
    // Bei Konflikten gewinnt die eigene Änderung (beim Rebase ist "theirs" der lokale Commit).
    await git(['pull', '--quiet', '--rebase', '--autostash', '-X', 'theirs', 'origin', BRANCH]);
  } catch (err) {
    await git(['rebase', '--abort']).catch(() => {});
    throw err;
  }
}

async function push() {
  try {
    await git(['push', '--quiet', 'origin', `HEAD:${BRANCH}`]);
  } catch {
    // Inzwischen hat jemand anders gepusht: neu aufsetzen und noch einmal versuchen.
    await pull();
    await git(['push', '--quiet', 'origin', `HEAD:${BRANCH}`]);
  }
}

async function tryPush() {
  try {
    await push();
    return true;
  } catch (err) {
    console.error('Push fehlgeschlagen, wird beim nächsten Abgleich nachgeholt:', errorText(err));
    return false;
  }
}

async function sync() {
  await pull();
  if (Number((await git(['rev-list', '--count', `origin/${BRANCH}..HEAD`])).trim())) await push();
}

const head = async () => (await git(['rev-parse', '--short', 'HEAD'])).trim();
const hasStaged = async () => !!(await git(['diff', '--cached', '--name-only'])).trim();

async function discard() {
  await git(['reset', '--hard', '--quiet', 'HEAD']).catch(() => {});
  await git(['clean', '-fdq', '--', SITE]).catch(() => {});
}

export async function start() {
  if (!REPO) {
    console.warn('GIT_REPO ist nicht gesetzt – die Website läuft aus dem Image, der Konnektor kann nichts speichern.');
    return;
  }
  for (;;) {
    try {
      await exclusive(clone);
      break;
    } catch (err) {
      console.error(`Klonen von ${REPO} fehlgeschlagen, neuer Versuch in 30 s:`, errorText(err));
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  }
  console.log(`Arbeitskopie bereit: ${REPO} (${BRANCH})`);
  // Früh prüfen, ob der Deploy-Key schreiben darf – sonst fällt es erst bei der ersten Änderung auf.
  exclusive(() => git(['push', '--dry-run', '--quiet', 'origin', `HEAD:${BRANCH}`]))
    .then(() => console.log('Schreibzugriff auf GitHub: ok'))
    .catch((err) => console.warn('WARNUNG: kein Schreibzugriff auf GitHub –', errorText(err)));
  setInterval(() => {
    exclusive(sync).catch((err) => console.error('Abgleich mit GitHub fehlgeschlagen:', errorText(err)));
  }, SYNC_MS);
}

export interface Saved {
  commit: string | null;
  pushed: boolean;
}

/** Führt eine Dateiänderung aus, committet sie und pusht sie. commit = null heißt: nichts hat sich geändert. */
export function change(message: string, apply: () => Promise<void>): Promise<Saved> {
  return exclusive(async () => {
    requireReady();
    await pull().catch((err) => console.warn('Abgleich vor der Änderung fehlgeschlagen:', errorText(err)));
    try {
      await apply();
    } catch (err) {
      await discard();
      throw err;
    }
    await git(['add', '--all', '--', SITE]);
    if (!(await hasStaged())) return { commit: null, pushed: true };
    await git(['commit', '--quiet', '-m', message]);
    return { commit: await head(), pushed: await tryPush() };
  });
}

export interface Entry {
  id: string;
  date: string;
  author: string;
  message: string;
  files: string[];
}

const STATUS: Record<string, string> = { A: 'neu', M: 'geändert', D: 'gelöscht', R: 'verschoben' };
const withoutSite = (file: string) => file.replace(/^site\//, '');

export function history(limit: number): Promise<Entry[]> {
  return exclusive(async () => {
    requireReady();
    const out = await git([
      'log',
      `--max-count=${limit}`,
      '--date=format-local:%d.%m.%Y %H:%M',
      '--name-status',
      '--pretty=format:%x1e%h%x1f%ad%x1f%an%x1f%s',
      '--',
      SITE,
    ]);
    return out
      .split('\x1e')
      .filter((block) => block.trim())
      .map((block) => {
        const [meta, ...lines] = block.split('\n');
        const [id, date, author, message] = meta.split('\x1f');
        const files = lines
          .filter((line) => line.trim())
          .map((line) => {
            const [status, ...paths] = line.split('\t');
            return `${STATUS[status[0]] ?? status}: ${paths.map(withoutSite).join(' → ')}`;
          });
        return { id, date, author, message, files };
      });
  });
}

/** Nimmt eine einzelne Änderung per "git revert" zurück – spätere Änderungen bleiben erhalten. */
export function revert(id: string): Promise<Saved & { message: string }> {
  if (!/^[0-9a-f]{4,40}$/i.test(id)) return Promise.reject(new RepoError('Ungültige Änderungs-ID – die IDs stehen in aenderungen_liste.'));
  return exclusive(async () => {
    requireReady();
    await pull().catch((err) => console.warn('Abgleich vor dem Zurücknehmen fehlgeschlagen:', errorText(err)));
    const full = (await git(['rev-parse', '--verify', '--quiet', `${id}^{commit}`]).catch(() => '')).trim();
    if (!full) throw new RepoError(`Änderung ${id} gibt es nicht.`);
    const [parents, subject] = (await git(['log', '-1', '--pretty=format:%P%x1f%s', full])).split('\x1f');
    if (parents.trim().split(/\s+/).filter(Boolean).length !== 1) throw new RepoError('Diese Änderung lässt sich nicht einzeln zurücknehmen.');
    const files = (await git(['diff-tree', '--no-commit-id', '--name-only', '-r', full])).split('\n').filter(Boolean);
    if (!files.length || files.some((file) => !file.startsWith(`${SITE}/`))) {
      throw new RepoError('Diese Änderung betrifft nicht nur Website-Dateien und kann hier nicht zurückgenommen werden.');
    }
    try {
      await git(['revert', '--no-commit', full]);
    } catch {
      await git(['revert', '--abort']).catch(() => {});
      await discard();
      throw new RepoError('Spätere Änderungen betreffen dieselben Stellen – bitte gezielt mit datei_ersetzen korrigieren.');
    }
    if (!(await hasStaged())) {
      await discard();
      throw new RepoError('Diese Änderung ist bereits zurückgenommen.');
    }
    const message = `Zurückgenommen: ${subject}`;
    await git(['commit', '--quiet', '-m', message]);
    return { message, commit: await head(), pushed: await tryPush() };
  });
}
