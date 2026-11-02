// Einrichtungsseite: Dieselbe Adresse ist im Browser eine Anleitung und in Claude der Konnektor.

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const CSS = `
:root{--yellow:#FFF200;--ink:#231F20;--muted:#5c5758;--line:#e6e3dc;--card:#fff;color-scheme:light}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--yellow);color:var(--ink);font:16px/1.55 system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased;padding:clamp(16px,5vw,56px) 16px}
main{max-width:640px;margin:0 auto;background:var(--card);border-radius:18px;padding:clamp(22px,5vw,40px);box-shadow:0 18px 50px rgba(35,31,32,.12)}
h1{font-family:'Barlow Condensed','Arial Narrow',sans-serif;font-weight:800;text-transform:uppercase;font-size:clamp(30px,6vw,42px);line-height:1;margin:0 0 .4em}
h1 span{background:var(--yellow);padding:0 .12em}
h2{font-size:15px;letter-spacing:.08em;text-transform:uppercase;margin:2em 0 .6em}
p{margin:0 0 .8em}.lead{color:var(--muted)}
ol{margin:0;padding-left:1.3em}li{margin:.45em 0}
.url{display:flex;gap:8px;margin:.5em 0 .2em}
.url input{flex:1;min-width:0;height:44px;padding:0 12px;border:1px solid var(--line);border-radius:10px;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink);background:#faf9f6}
.url button{height:44px;padding:0 18px;border:0;border-radius:10px;background:var(--ink);color:var(--yellow);font:700 13px/1 system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;cursor:pointer}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f3f1ec;padding:.1em .35em;border-radius:5px;word-break:break-all}
.ex{border-left:3px solid var(--yellow);padding:.2em 0 .2em .9em;font-style:italic;color:var(--muted)}
.warn{margin-top:2em;padding:12px 14px;border-radius:10px;background:#231F200d;font-size:14px}
details{margin-top:1.2em;font-size:14px;color:var(--muted)}summary{cursor:pointer}`;

export function setupPage(url: string) {
  const u = esc(url);
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Claude-Konnektor · einmalohne.de</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@800&display=swap"><style>${CSS}</style></head>
<body><main>
<h1><span>OHNE</span> mit Claude bearbeiten</h1>
<p class="lead">Mit diesem Konnektor bearbeitet Claude die Website einmalohne.de direkt: Texte ändern, Bilder austauschen, Abschnitte ergänzen. Änderungen sind sofort live und lassen sich jederzeit zurücknehmen.</p>

<h2>Einrichten · einmalig, 1 Minute</h2>
<ol>
<li>Claude öffnen (claude.ai oder die Desktop-App) → <b>Einstellungen</b> → <b>Konnektoren</b>.</li>
<li><b>Benutzerdefinierten Konnektor hinzufügen</b> wählen.</li>
<li>Name: <code>einmalohne.de</code> · URL: diese Adresse einfügen
<div class="url"><input id="u" value="${u}" readonly aria-label="Konnektor-URL"><button id="c" type="button">Kopieren</button></div></li>
<li><b>Hinzufügen</b> – fertig. Eine Anmeldung ist nicht nötig.</li>
</ol>

<h2>Benutzen</h2>
<p>Im Chat über <b>+</b> → <b>Konnektoren</b> „einmalohne.de“ einschalten und sagen, was sich ändern soll, zum Beispiel:</p>
<p class="ex">„Ändere auf einmalohne.de die Überschrift im Weingut-Abschnitt in ‚Von Hand gelesen‘.“</p>
<p class="ex">„Was wurde zuletzt geändert? Nimm die letzte Änderung zurück.“</p>

<p class="warn"><b>Dieser Link ist der Schlüssel zur Website.</b> Wer ihn hat, kann sie bearbeiten – bitte nur an Personen weitergeben, die das dürfen. Bei Team- oder Enterprise-Konten fügt ggf. ein Admin den Konnektor in den Organisationseinstellungen hinzu.</p>

<details><summary>Claude Code</summary><p><code>claude mcp add --transport http einmalohne ${u}</code></p></details>
</main>
<script>
document.getElementById('c').addEventListener('click', async (e) => {
  const input = document.getElementById('u');
  try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand('copy'); }
  e.target.textContent = 'Kopiert';
  setTimeout(() => { e.target.textContent = 'Kopieren'; }, 1800);
});
</script></body></html>`;
}
