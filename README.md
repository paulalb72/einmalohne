# einmalohne.de

Website für **OHNE**, den entalkoholisierten Wein vom Weingut Rosenhof, mit einem Claude-Konnektor, über den sich die Seite per Chat bearbeiten lässt.

- `site/` – die Website (statisch): `index.html` ist die Startseite, `animationen.html` und `01–03-*.html` sind Entwürfe für Hero-Animationen, Bilder in `assets/`
- `server/` – kleiner Node-Server ohne Abhängigkeiten: liefert `site/` aus und stellt den Konnektor (MCP) bereit

## Claude-Konnektor

Adresse: `https://einmalohne.de/mcp/<CONNECTOR_TOKEN>`

Im Browser geöffnet zeigt sie eine Anleitung zum Einrichten. Diesen Link weitergeben: In Claude unter **Einstellungen → Konnektoren → Benutzerdefinierten Konnektor hinzufügen** eintragen, fertig. Der Link ist der Schlüssel, eine Anmeldung gibt es nicht.

Werkzeuge: `dateien_liste`, `datei_lesen`, `suchen`, `datei_ersetzen`, `datei_schreiben`, `bild_von_url`, `verschieben`, `datei_loeschen`, `aenderungen_liste`, `aenderung_zuruecknehmen`.

So funktioniert es:

- Der Server klont dieses Repo beim Start und liefert die Seite aus der Arbeitskopie aus.
- Jede Änderung über den Konnektor ist sofort live und wird als Commit von „Claude-Konnektor“ nach GitHub gepusht. Zurücknehmen = `git revert` des jeweiligen Commits.
- Jede Minute holt der Server neue Commits von GitHub. Lokal gepushte Änderungen an `site/` sind also ohne Redeploy nach spätestens einer Minute live. Änderungen an `server/` brauchen einen Redeploy.
- Der Konnektor kommt nur an `site/` heran, nicht an den Server-Code.

**Lokal weiterarbeiten:** vorher `git pull`, weil der Konnektor eigene Commits pusht.

**Link sperren oder erneuern:** `CONNECTOR_TOKEN` in Coolify ändern und neu starten. Der alte Link funktioniert dann nicht mehr.

## Konfiguration

| Variable | Bedeutung |
| --- | --- |
| `GIT_REPO` | SSH-Adresse des Repos, z. B. `git@github.com:paulalb72/einmalohne.git` |
| `GIT_SSH_KEY_B64` | privater Deploy-Key mit Schreibrecht, base64-kodiert (`base64 -w0 deploy_key`) |
| `CONNECTOR_TOKEN` | geheimer Teil der Konnektor-Adresse (lang und zufällig, z. B. `openssl rand -base64 32 \| tr '+/' '-_' \| tr -d =`) |
| `PUBLIC_URL` | öffentliche Adresse, Standard `https://einmalohne.de` |
| `GIT_BRANCH` | Standard `main` |

Ohne `GIT_REPO` läuft die Seite aus dem Docker-Image und der Konnektor kann nur lesen.

## Deployment (Coolify)

Public Repository → Build Pack **Dockerfile**, Port **3000**, Domain `https://einmalohne.de` (plus `www`). Die Umgebungsvariablen oben setzen. Ein Volume ist nicht nötig, weil GitHub den Stand hält.

Lokal: `.env` aus `.env.example` anlegen, dann `npm start` (Node ≥ 22.13).
