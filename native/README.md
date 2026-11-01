# Urban Dry Clean CRM - native Windows app

A true native Windows desktop app - WPF, .NET 8, C#. No browser engine, no Chromium, no
Electron: real Win32 windows rendered by WPF. It talks to the **existing** backend (repo root,
`src/`) over its existing `/api/mobile/*` REST API - the same API the Android app already uses -
so no business logic is duplicated or rewritten. The backend runs locally on each shop PC
(bundled, with its own portable Node.js runtime so nothing extra needs installing), all pointed
at the same central MySQL database as the web app and the Android app.

This replaces an earlier Electron-based prototype (a Chromium+Node wrapper around the web UI),
which was removed once the decision was made to build a true native UI instead.

## Phase plan

| Phase | Scope | Status |
|---|---|---|
| 1 Foundation | Solution scaffold (`Udc.Client` testable class library + `Udc.App` WPF UI); `AppConfig`/`ConfigStore`/`TokenStore` (DPAPI-encrypted); `BackendProcessManager` (bundles + launches a portable Node runtime); `DbConnectionTester` (native MySQL connection test, no backend needed); `ApiClient` (typed wrapper over `/api/mobile/*`); Setup window (first-run DB config + test), Splash window, Login window, main shell window (menu, sidebar placeholder) with a real **Dashboard** screen (stat cards + 7-day sales) backed by live data from `dashboard_summary`; CI build (`windows-latest`, self-contained `dotnet publish` + portable Node bundling) | **done (code) - not yet run on a real Windows PC**, see Verification below |
| 2 Customers + Orders/POS | Customer list/detail/create, order creation (piece + laundry), order list/detail, payments, wallet | planned |
| 3 Workshop + Barcode | QC/Ironing/Packaging queue screens, challans, barcode/tag scanning + printing | planned |
| 4 Reports + Admin | Reports, master data, admin settings, users/roles, WhatsApp admin | planned |
| 5 Packaging polish | Proper installer (MSIX or WiX) with Start Menu/Desktop shortcuts, code signing, auto-update, background jobs (WhatsApp worker, nightly backup, photo cleanup - see Known gaps) | planned |

## Architecture

```
native/
├── Udc.sln
├── src/
│   ├── Udc.Client/            class library, plain net8.0 - builds and tests on any OS
│   │   ├── AppConfig.cs / ConfigStore.cs / Paths.cs   local config (%APPDATA%\UrbanDryCleanCRM)
│   │   ├── TokenStore.cs                              DPAPI-encrypted bearer token on disk
│   │   ├── BackendProcessManager.cs                   starts/stops the bundled Node backend
│   │   ├── DbConnectionTester.cs                       MySQL connection test (MySqlConnector)
│   │   ├── ApiClient.cs + Models/                      typed wrapper over /api/mobile/*
│   │   └── ApiException.cs
│   ├── Udc.Client.Tests/      xunit tests for all of the above (`dotnet test`)
│   └── Udc.App/                net8.0-windows, WPF - the actual UI (Windows-only to build)
│       ├── App.xaml(.cs)                               boot sequence / window orchestration
│       └── Views/               SetupWindow, SplashWindow, LoginWindow, MainWindow, DashboardView
└── scripts/
    └── prepare-backend.cjs     builds the root backend + bundles a portable Node runtime
```

**Why split `Udc.Client` out of `Udc.App`?** Everything that isn't actual UI (config, the API
client, the backend process manager, the DB connection test) lives in a plain `net8.0` class
library with no WPF dependency, so it builds and unit-tests on any OS - this repo's CI (and this
sandbox) can verify it without a Windows machine. Only the WPF project itself
(`net8.0-windows`, `UseWPF=true`) needs Windows to build, because the WPF compiler toolchain
(`Microsoft.NET.Sdk.WindowsDesktop`) isn't available on Linux/macOS SDKs at all - confirmed while
building this: `dotnet build` on `Udc.App` fails immediately with the WindowsDesktop SDK pack
missing, before anything else runs.

**Bundled backend, same as before:** `BackendProcessManager` spawns
`<install dir>/backend/node/node.exe <install dir>/backend/dist/server.js` as a child process on
app startup, waits for `/health`, then shows the UI. `backend/node/node.exe` is a portable
official Node.js Windows build (just the one `.exe`, nothing else from the zip) staged by
`scripts/prepare-backend.cjs` - so, like the Electron prototype before it, the shop PC never
needs Node.js installed separately. Every backend runtime dependency (mysql2, fastify, bcryptjs,
zod, ...) is pure JavaScript, so the production `node_modules` staged alongside it run unmodified.

**Config & secrets:** `AppConfig` (DB host/port/name/user/password, app secret key, local port)
is collected by the Setup window, connection-tested directly from .NET via `MySqlConnector`
(no need to start the backend first), and saved as JSON to
`%APPDATA%\UrbanDryCleanCRM\config.json`. The bearer token from `POST /api/mobile/login` is
saved separately, encrypted at rest with Windows DPAPI (`TokenStore`, current-user scope) -
not yet wired into the boot sequence to auto-skip the login screen (see Known gaps).

**Existing PHP/web app secret key:** same note as before - if this PC points at the same
database the web app already uses, paste the exact same `APP_SECRET_KEY` into Setup so encrypted
values (WhatsApp tokens, etc.) stay decryptable from both places.

## Verification

This was built and tested as far as this sandbox (Linux, no Windows) allows:

- `dotnet build` / `dotnet test` on `Udc.Client` + `Udc.Client.Tests`: **passing** (13 tests -
  `AppConfig.Merge` semantics, `BackendProcessManager.BuildEnvironment`, `ApiClient` against a
  fake `HttpMessageHandler` covering login success/failure, authenticated `GET /api/mobile/me`,
  and `dashboard_summary` parsing).
- `Udc.App` (the WPF UI): **cannot be built or run in this sandbox** - confirmed directly, not
  assumed (see Architecture above). It was written carefully and reviewed by hand, but has not
  been compiled. `.github/workflows/build-native.yml` builds it for real on a `windows-latest`
  GitHub Actions runner; that is also the first point it gets an actual compiler.
- `scripts/prepare-backend.cjs`: downloads a Windows Node.js build and uses `tar` (bsdtar, built
  into Windows) to extract it - both Windows-only operations, so this also could not be run here.

**Before relying on Phase 1, run the CI workflow (or build locally on Windows) and fix whatever
the real compiler finds** - treat this phase as reviewed-but-unverified until that first green
build.

## Building

### CI (recommended - works without a Windows machine)
`.github/workflows/build-native.yml` builds and tests `Udc.Client`, then publishes `Udc.App`
self-contained for `win-x64` and stages the bundled backend next to it, on a `windows-latest`
runner. Trigger it from the Actions tab or push a change under `native/**`. Download the
`urban-dry-clean-crm-native-win-x64` artifact, unzip it, and run `Udc.App.exe` - no installer yet
(that's Phase 5); for now this published folder *is* the app.

### Locally, on Windows
```powershell
cd native
dotnet restore Udc.sln
dotnet test src/Udc.Client.Tests/Udc.Client.Tests.csproj
dotnet publish src/Udc.App/Udc.App.csproj -c Release -r win-x64 --self-contained true -o publish/win-x64
node scripts/prepare-backend.cjs publish/win-x64
# run publish/win-x64/Udc.App.exe
```

### Locally, on Linux/macOS
Only `Udc.Client` (+ tests) can be built/run here - `Udc.App` needs Windows (see Verification):
```bash
cd native
dotnet test src/Udc.Client.Tests/Udc.Client.Tests.csproj
```

## Known gaps (Phase 1)

- **No background jobs yet.** The Electron prototype ran the WhatsApp outbound worker, photo
  cleanup, nightly backup and WhatsApp marketing jobs on timers while the app was open (there's
  no system cron on a desktop PC). `Udc.App` doesn't do this yet - WhatsApp messages will queue
  but not actually send until this is ported. Needs doing before Phase 1 is deployable for real
  shop use, even though it's not core "native UI" work.
- **Session isn't restored on restart.** `TokenStore` saves the bearer token on login, but
  `App.xaml.cs` doesn't yet try it before showing the Login window - every launch requires
  signing in again.
- **No installer, no code signing, no auto-update** - see Phase 5.
- **Database backups** (once ported) will have the same `mysqldump`-on-PATH requirement the
  Node backend's `DatabaseBackupService` already has - unrelated to this app, documented here so
  it isn't a surprise later.
