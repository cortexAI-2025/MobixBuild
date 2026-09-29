# MobixBuild

Build Android apps (APK / AAB) from a Git repo or a ZIP — without touching GitHub Actions.

| Part | Path | Role |
|---|---|---|
| API | `server/` | Express queue, live logs (SSE), artifact download |
| Build engine | `scripts/build.sh` | Detects the project type, runs Gradle with CI-proven settings, signs |
| Web UI | `web/` | Next.js front (drag & drop, live terminal) |
| Android client | `android-client/` | Compose app that talks to the API |

## Run it

```bash
docker compose up --build          # API :3000, web :8080
```

Remote deployment: the browser calls the API directly, so bake its public URL into the web image:

```bash
PUBLIC_API_URL=https://api.example.com docker compose up --build
```

## Build modes

| Mode | Gradle task | Output |
|---|---|---|
| `quick` | `assembleDebug` | debug APK |
| `production` | `assembleRelease` + zipalign/apksigner | signed APK |
| `store` | `bundleRelease` | signed AAB |

Supported sources: native Kotlin/Java, React Native / TypeScript, Capacitor / Ionic, plain web (needs an `android/` folder).
Without a keystore, one is generated automatically (fine for testing; upload your own for the Play Store).

## API

```
POST /build                multipart: repoUrl | archive, mode, [keystore, keystorePass, keyAlias, keyPass]
GET  /build/:id/status     status + logs
GET  /build/:id/logs/stream  Server-Sent Events
GET  /build/:id/download   the APK / AAB
GET  /builds               last 50 builds
GET  /health
```

`repoUrl` must be `https://…` or `git@…`. Builds are persisted to disk, survive restarts, are killed after
`BUILD_TIMEOUT_MIN` (default 30) and purged after `BUILD_RETENTION_HOURS` (default 24). One build runs at a time.

## Tests

```bash
(cd server && npm ci) && tests/e2e.sh    # no Android SDK needed
```
