# Urban Dry Clean CRM - Windows desktop app

A native Windows app (its own window, taskbar icon, Start Menu entry, installable `.exe`) built
with Electron around the **existing** Node/Fastify backend at the repo root (`src/`, built to
`dist/`). No business logic lives here and none is duplicated: the backend is exactly the same
code the web app runs, just launched locally by Electron instead of by `node dist/server.js` on
a server. This follows the approach recommended in the `UDC-windows-app-export` package
(`SETUP-WINDOWS-APP.md`): Electron + Node/Express(Fastify) + MySQL, one backend, every frontend.

MySQL stays central - this app, the web app and the Android app all point at the same database,
so every PC at the shop sees the same live orders, payments and workshop status.

## How it works

- On first launch, a **Setup** window asks for the shop's MySQL connection (host/port/db/user/
  password) and the app secret key, tests the connection, and saves it to this PC's per-user app
  data folder (`%APPDATA%\urban-dry-clean-desktop\config.json` on Windows) - never inside the
  install directory, which isn't writable without admin rights.
- On every launch after that, Electron's main process spawns the bundled backend
  (`resources/backend/dist/server.js`, running under Electron's own bundled Node -
  **no separate Node.js install needed on the shop PC**) on `127.0.0.1` with those settings, waits
  for `/health` to come up, then opens the app window pointed at it. Closing the app stops the
  local server.
- `File > Settings...` reopens the setup window to change the database connection later.
- Uploaded photos (`UPLOAD_DIR`) live under the same per-user app data folder, as
  `.../urban-dry-clean-desktop/uploads`.
- Since there's no system cron on a desktop PC, `jobs.cjs` runs the same jobs the server deploy's
  `deploy/crontab` runs, on timers, while the app is open: the WhatsApp outbound worker every
  minute, and the photo-cleanup / nightly-backup / WhatsApp-marketing jobs once a day. If the shop
  PC is usually off overnight, run those from a machine that's on (the existing server deploy, or
  another always-on PC), same as any cron-based deployment.

**Existing PHP/web app secret key:** if this PC points at the same database your web app already
uses, paste the exact same `APP_SECRET_KEY` into Setup (the web app's `.env` /
`config/config.php`) so encrypted values (WhatsApp tokens, etc.) stay decryptable from both
places. Leave it blank only for a brand-new setup with no existing encrypted data - Setup then
generates a random one for you.

**Database backups:** `Admin > Backup` and the nightly backup job shell out to `mysqldump`. If
this PC doesn't have the MySQL/MariaDB command-line client installed, backups will fail silently
in the log (`Open logs folder` from the File menu) - install it, or run backups from a machine
that already has it. This is existing backend behavior (`DatabaseBackupService`), unrelated to
Electron.

## Project layout

```
desktop/
├── main.cjs              Electron main process: windows, backend process, menu, lifecycle
├── preload.cjs            contextBridge bridge for the Setup/Splash windows only
├── jobs.cjs                cron-equivalent timers for the backend's jobs/*.js scripts
├── setup.html              first-run / Settings window (plain HTML, no build step)
├── splash.html             "starting up" window shown while the backend boots
├── scripts/
│   └── prepare-backend.cjs builds the root backend and stages it into resources/backend
├── build/
│   └── icon.ico / icon.png app icon
└── package.json             electron + electron-builder, electron-builder "build" config
```

`resources/backend/` (git-ignored, created by `prepare-backend.cjs`) is a self-contained copy of
the backend: `dist/`, `public/`, `db/`, and **production-only** `node_modules` installed fresh
into that copy. Every runtime dependency (mysql2, fastify, bcryptjs, zod, ...) is pure
JavaScript, so nothing there needs native/ABI-specific compilation against Electron's bundled
Node - it just runs.

## Building the installer

### Option A - GitHub Actions (recommended; no Windows machine needed)

`.github/workflows/build-desktop.yml` builds the real Windows installer on a `windows-latest`
runner and uploads it as a workflow artifact. Trigger it from the Actions tab ("Run workflow") or
push a change under `desktop/**`. This is the easiest way to get a fresh `.exe` without owning a
Windows PC, and it's the only path that doesn't need Wine.

### Option B - locally, on Windows

```powershell
cd desktop
npm install
npm run build:win
```
Produces `desktop/dist/Urban Dry Clean CRM Setup <version>.exe` (NSIS installer) plus an unpacked
`desktop/dist/win-unpacked/` folder.

### Option C - locally, on Linux/macOS

Works, but electron-builder needs **Wine** to write the Windows `.exe`'s icon/version resources
even for an unsigned build (`wine` + 32-bit `wine32:i386` on Debian/Ubuntu: `dpkg --add-architecture
i386 && apt-get update && apt-get install wine wine32:i386`). Then the same two commands as
Option B. This repo's own build was validated exactly this way.

## Running in development (no installer)

```bash
cd desktop
npm install
npm run start     # builds+stages the backend, then launches Electron
```

## Known limitations

- No auto-update - rebuild and reinstall to ship a new version.
- No code signing - Windows SmartScreen will warn on first run ("Windows protected your PC" >
  "More info" > "Run anyway") until the installer is signed with a code-signing certificate.
- Single-PC local backend: this app starts its own backend process per PC, each pointed at the
  same central MySQL. It does not proxy through a shared server process.
