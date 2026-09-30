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
[ -f slow ] && sleep 60
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
# Slow variant (gradlew sleeps) to test cancellation
SL="${WORK}/slow"; cp -r "${P}" "${SL}"; touch "${SL}/slow"
(cd "${SL}" && zip -qr "${WORK}/slow.zip" .)
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

# ── Cancellation: running build is killed, queued build is dropped ────────────
wait_status() { # id wanted → echoes final status
  local st=""
  for _ in $(seq 1 30); do
    st=$(curl -sf "${API}/build/$1/status" | json "['status']"); [ "${st}" = "$2" ] && break; sleep 0.5
  done
  echo "${st}"
}
run_id=$(curl -sf -F "archive=@${WORK}/slow.zip" -F mode=quick "${API}/build" | json "['id']")
[ "$(wait_status "${run_id}" running)" = running ] || fail "slow build never started"
queued_id=$(curl -sf -F "archive=@${WORK}/proj.zip" -F mode=quick "${API}/build" | json "['id']")
[ "$(curl -sf "${API}/build/${queued_id}/status" | json "['queuePosition']")" = 1 ] || fail "queuePosition not reported"
curl -sf -X POST "${API}/build/${queued_id}/cancel" >/dev/null || fail "cancel queued failed"
[ "$(wait_status "${queued_id}" failed)" = failed ] || fail "queued build not cancelled"
start=$(date +%s)
curl -sf -X POST "${API}/build/${run_id}/cancel" >/dev/null || fail "cancel running failed"
[ "$(wait_status "${run_id}" failed)" = failed ] || fail "running build not killed"
[ $(( $(date +%s) - start )) -lt 10 ] || fail "cancel took too long"
curl -sf "${API}/build/${run_id}/status" | grep -q "cancelled" || fail "cancel reason not logged"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${API}/build/${run_id}/cancel")
[ "${code}" = 409 ] || fail "cancelling a finished build should be 409 (got ${code})"
ok "cancel (queued + running)"

# ── Token auth ────────────────────────────────────────────────────────────────
kill "${SERVER_PID}"; wait "${SERVER_PID}" 2>/dev/null || true
API_TOKEN=s3cret node "${ROOT}/server/index.js" >> "${WORK}/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 20); do curl -sf "${API}/health" >/dev/null && break; sleep 0.5; done
[ "$(curl -s -o /dev/null -w '%{http_code}' "${API}/health")" = 200 ]            || fail "/health must stay public"
[ "$(curl -s -o /dev/null -w '%{http_code}' "${API}/builds")" = 401 ]            || fail "no token accepted"
[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer nope' "${API}/builds")" = 401 ] || fail "bad token accepted"
[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer s3cret' "${API}/builds")" = 200 ] || fail "bearer token rejected"
[ "$(curl -s -o /dev/null -w '%{http_code}' "${API}/builds?token=s3cret")" = 200 ] || fail "query token rejected"
ok "API_TOKEN auth (header + query, /health public)"

echo "ALL E2E TESTS PASSED"
