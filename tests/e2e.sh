#!/usr/bin/env bash
# End-to-end test of the API + build.sh using a fake Gradle project (no Android SDK needed).
# Usage: tests/e2e.sh        (run from the repo root, after `npm ci` in server/)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
PORT="${E2E_PORT:-3199}"
API="http://localhost:${PORT}"
SERVER_PID=""
cleanup() { [ -n "${SERVER_PID}" ] && kill "${SERVER_PID}" 2>/dev/null || true; rm -rf "${WORK}"; }
trap cleanup EXIT

fail() { echo "✗ $*"; [ -f "${WORK}/server.log" ] && tail -20 "${WORK}/server.log"; exit 1; }
ok()   { echo "✓ $*"; }
json() { python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }

# ── Fake project: a gradlew that just drops the expected artifacts ────────────
P="${WORK}/proj"; mkdir -p "${P}/gradle/wrapper"
echo x > "${P}/gradle/wrapper/gradle-wrapper.jar"
echo "rootProject.name='fake'" > "${P}/settings.gradle"
cat > "${P}/gradlew" <<'G'
#!/usr/bin/env bash
case "$1" in
  assembleDebug)   d=app/build/outputs/apk/debug;      mkdir -p $d; echo apk > $d/app-debug.apk;;
  assembleRelease) d=app/build/outputs/apk/release;    mkdir -p $d; echo apk > $d/app-release-unsigned.apk;;
  bundleRelease)   d=app/build/outputs/bundle/release; mkdir -p $d; echo aab > $d/app-release.aab;;
  *) exit 2;;
esac
echo "fake gradle: $*"
G
chmod +x "${P}/gradlew"
(cd "${P}" && zip -qr "${WORK}/proj.zip" .)
# Monorepo layout: the Android project lives in a subfolder next to other files
M="${WORK}/mono"; mkdir -p "${M}/docs"; echo hi > "${M}/README.md"; cp -r "${P}" "${M}/android-client"
(cd "${M}" && zip -qr "${WORK}/mono.zip" .)

# ── Start the API ─────────────────────────────────────────────────────────────
export BUILDS_DIR="${WORK}/builds" UPLOADS_DIR="${WORK}/uploads" PORT
export ANDROID_HOME="${WORK}/sdk"; mkdir -p "${ANDROID_HOME}"
node "${ROOT}/server/index.js" > "${WORK}/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 20); do curl -sf "${API}/health" >/dev/null && break; sleep 0.5; done
curl -sf "${API}/health" >/dev/null || fail "API did not start"
ok "API up"

# ── Every mode must build and serve the right artifact ────────────────────────
for entry in quick:apk production:apk store:aab; do
  mode="${entry%%:*}"; want="${entry##*:}"
  id=$(curl -sf -F "archive=@${WORK}/proj.zip" -F "mode=${mode}" "${API}/build" | json "['id']")
  st=""
  for _ in $(seq 1 60); do
    st=$(curl -sf "${API}/build/${id}/status" | json "['status']")
    [ "${st}" = success ] || [ "${st}" = failed ] && break
    sleep 1
  done
  [ "${st}" = success ] || fail "mode=${mode} ended with status '${st}'"
  code=$(curl -s -o "${WORK}/out" -w '%{http_code}' "${API}/build/${id}/download")
  [ "${code}" = 200 ] && grep -q "${want}" "${WORK}/out" || fail "mode=${mode}: bad download (http ${code})"
  ok "mode=${mode} → ${want}"
done

# ── Android project in a subfolder (monorepo) ─────────────────────────────────
id=$(curl -sf -F "archive=@${WORK}/mono.zip" -F mode=quick "${API}/build" | json "['id']")
for _ in $(seq 1 60); do
  st=$(curl -sf "${API}/build/${id}/status" | json "['status']"); [ "${st}" = success ] || [ "${st}" = failed ] && break; sleep 1
done
[ "${st}" = success ] || fail "monorepo layout ended with status '${st}'"
ok "monorepo (android-client/ subfolder) → apk"

# ── Input validation ──────────────────────────────────────────────────────────
for bad in '--upload-pack=touch /tmp/pwn' 'file:///etc' 'http://insecure.example/x.git'; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -F "repoUrl=${bad}" -F mode=quick "${API}/build")
  [ "${code}" = 400 ] || fail "repoUrl '${bad}' accepted (http ${code})"
done
ok "malicious repoUrl rejected"
code=$(curl -s -o /dev/null -w '%{http_code}' -F mode=nope -F "archive=@${WORK}/proj.zip" "${API}/build")
[ "${code}" = 400 ] || fail "invalid mode accepted"
ok "invalid mode rejected"

echo "ALL E2E TESTS PASSED"
