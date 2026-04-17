#!/usr/bin/env bash
# MobixBuild – core build engine
# Usage: build.sh <BUILD_ID> <BUILD_DIR> <MODE> <REPO_URL_OR_EMPTY>
#                  <ARCHIVE_PATH_OR_EMPTY> <KEYSTORE_PATH_OR_EMPTY>
#                  <KEYSTORE_PASS> <KEY_ALIAS> <KEY_PASS>
set -euo pipefail

BUILD_ID="${1:?BUILD_ID required}"
BUILD_DIR="${2:?BUILD_DIR required}"
MODE="${3:-quick}"
REPO_URL="${4:-}"
ARCHIVE_PATH="${5:-}"
KEYSTORE_PATH="${6:-}"
KEYSTORE_PASS="${7:-mobixbuild123}"
KEY_ALIAS="${8:-release}"
KEY_PASS="${9:-mobixbuild123}"

# ─── Logging ──────────────────────────────────────────────────────────────────

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
die()  { log "ERROR: $*"; exit 1; }

log "=========================================="
log "  MobixBuild  id=${BUILD_ID}  mode=${MODE}"
log "=========================================="

# ─── Environment ──────────────────────────────────────────────────────────────

export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export GRADLE_USER_HOME="${BUILD_DIR}/.gradle-home"

export PATH="${JAVA_HOME}/bin:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/build-tools/34.0.0:${PATH}"
export GRADLE_OPTS="-Xmx2048m -Dorg.gradle.daemon=false -Dorg.gradle.parallel=false -Dorg.gradle.configureondemand=false"

mkdir -p "${GRADLE_USER_HOME}"

log "JAVA_HOME  = ${JAVA_HOME}"
log "ANDROID_HOME = ${ANDROID_HOME}"
java -version 2>&1 || die "Java not found"

# ─── Source extraction ────────────────────────────────────────────────────────

SOURCE_DIR="${BUILD_DIR}/source"
mkdir -p "${SOURCE_DIR}"

if [ -n "${REPO_URL}" ]; then
  log "Cloning: ${REPO_URL}"
  git clone --depth=1 "${REPO_URL}" "${SOURCE_DIR}" 2>&1
elif [ -n "${ARCHIVE_PATH}" ] && [ -f "${ARCHIVE_PATH}" ]; then
  log "Extracting archive: ${ARCHIVE_PATH}"
  unzip -q "${ARCHIVE_PATH}" -d "${SOURCE_DIR}" 2>&1 || \
    tar xf  "${ARCHIVE_PATH}" -C "${SOURCE_DIR}" 2>&1 || \
    die "Failed to extract archive"
  # If there's a single top-level directory, descend into it
  TOP=$(ls "${SOURCE_DIR}" | wc -l)
  if [ "${TOP}" -eq 1 ]; then
    INNER=$(ls "${SOURCE_DIR}")
    if [ -d "${SOURCE_DIR}/${INNER}" ]; then
      mv "${SOURCE_DIR}/${INNER}"/* "${SOURCE_DIR}/" 2>/dev/null || true
      rmdir "${SOURCE_DIR}/${INNER}" 2>/dev/null || true
    fi
  fi
else
  die "No REPO_URL or ARCHIVE_PATH provided"
fi

cd "${SOURCE_DIR}"

# ─── Project detection ────────────────────────────────────────────────────────

PROJECT_TYPE="native"

if [ -f "capacitor.config.ts" ] || [ -f "capacitor.config.js" ] || [ -f "capacitor.config.json" ]; then
  PROJECT_TYPE="capacitor"
elif [ -f "ionic.config.json" ]; then
  PROJECT_TYPE="capacitor"
elif [ -f "package.json" ] && [ -d "android" ]; then
  # package.json + android/ = likely Capacitor/Cordova hybrid
  PROJECT_TYPE="capacitor"
elif [ -f "package.json" ] && [ ! -d "android" ]; then
  PROJECT_TYPE="web"
fi

log "Project type: ${PROJECT_TYPE}"

# ─── Web / Capacitor build ────────────────────────────────────────────────────

if [ "${PROJECT_TYPE}" = "capacitor" ] || [ "${PROJECT_TYPE}" = "web" ]; then
  log "Installing JS dependencies..."
  if [ -f "package-lock.json" ]; then
    npm ci --prefer-offline 2>&1 || npm install 2>&1
  elif [ -f "yarn.lock" ]; then
    yarn install --frozen-lockfile 2>&1 || yarn install 2>&1
  else
    npm install 2>&1
  fi

  log "Building web resources..."
  if grep -q '"build"' package.json 2>/dev/null; then
    npm run build 2>&1
  fi

  if [ "${PROJECT_TYPE}" = "capacitor" ]; then
    log "Syncing Capacitor..."
    npx cap sync android 2>&1 || log "cap sync warning (continuing)"
  fi
fi

# ─── Locate Android project root ──────────────────────────────────────────────

ANDROID_DIR=""
if [ -f "gradlew" ]; then
  ANDROID_DIR="${SOURCE_DIR}"
elif [ -d "android" ] && [ -f "android/gradlew" ]; then
  ANDROID_DIR="${SOURCE_DIR}/android"
elif [ -d "android" ] && [ -f "android/build.gradle" ]; then
  ANDROID_DIR="${SOURCE_DIR}/android"
else
  die "No Android project found (no gradlew or android/ directory)"
fi

log "Android dir: ${ANDROID_DIR}"
cd "${ANDROID_DIR}"
chmod +x gradlew

# Write local.properties so Gradle can find the SDK
cat > local.properties <<EOF
sdk.dir=${ANDROID_HOME}
EOF

# ─── Signing setup (production / store) ──────────────────────────────────────

setup_keystore() {
  local ks_dest="${ANDROID_DIR}/app/release.keystore"

  if [ -n "${KEYSTORE_PATH}" ] && [ -f "${KEYSTORE_PATH}" ]; then
    log "Using provided keystore"
    cp "${KEYSTORE_PATH}" "${ks_dest}"
  else
    log "Generating auto-signed keystore..."
    keytool -genkeypair \
      -keystore  "${ks_dest}" \
      -alias     "${KEY_ALIAS}" \
      -keyalg    RSA \
      -keysize   2048 \
      -validity  10000 \
      -storepass "${KEYSTORE_PASS}" \
      -keypass   "${KEY_PASS}" \
      -dname     "CN=MobixBuild, OU=Build, O=MobixBuild, L=Unknown, ST=Unknown, C=US" \
      -noprompt 2>&1
  fi

  # Write keystore.properties (read by many Capacitor/template build.gradle)
  cat > "${ANDROID_DIR}/keystore.properties" <<EOF
storeFile=release.keystore
storePassword=${KEYSTORE_PASS}
keyAlias=${KEY_ALIAS}
keyPassword=${KEY_PASS}
EOF

  log "Keystore ready at ${ks_dest}"
}

# Post-build manual zipalign + apksigner pass (ensures the APK is always signed)
sign_apk() {
  local apk_in="$1"
  local base="${apk_in%.apk}"
  local aligned="${base}-aligned.apk"
  local signed="${base}-signed.apk"
  local ks="${ANDROID_DIR}/app/release.keystore"

  log "zipalign: ${apk_in} → ${aligned}"
  "${ANDROID_HOME}/build-tools/34.0.0/zipalign" -v -p 4 "${apk_in}" "${aligned}" 2>&1 || {
    log "zipalign failed – skipping alignment step"
    aligned="${apk_in}"
  }

  log "apksigner: ${aligned} → ${signed}"
  "${ANDROID_HOME}/build-tools/34.0.0/apksigner" sign \
    --ks            "${ks}" \
    --ks-pass       "pass:${KEYSTORE_PASS}" \
    --ks-key-alias  "${KEY_ALIAS}" \
    --key-pass      "pass:${KEY_PASS}" \
    --out           "${signed}" \
    "${aligned}" 2>&1 && log "Signed: ${signed}" || log "apksigner failed – unsigned APK kept"
}

# ─── Gradle build ─────────────────────────────────────────────────────────────

if [ "${MODE}" = "quick" ]; then
  # ── MODE 1: QUICK ─────────────────────────────────────────────────────────
  log "--- MODE: quick (assembleDebug) ---"
  ./gradlew assembleDebug --stacktrace 2>&1
  log "Debug APK built."

elif [ "${MODE}" = "production" ]; then
  # ── MODE 2: PRODUCTION ────────────────────────────────────────────────────
  log "--- MODE: production (assembleRelease + sign) ---"
  setup_keystore

  # Pass signing properties via Gradle flags (works even without signingConfig in build.gradle)
  ./gradlew assembleRelease \
    "-Pandroid.injected.signing.store.file=${ANDROID_DIR}/app/release.keystore" \
    "-Pandroid.injected.signing.store.password=${KEYSTORE_PASS}" \
    "-Pandroid.injected.signing.key.alias=${KEY_ALIAS}" \
    "-Pandroid.injected.signing.key.password=${KEY_PASS}" \
    --stacktrace 2>&1

  # Always run manual sign pass to guarantee aligned + signed output
  RELEASE_APK=$(find app/build/outputs/apk/release -name "*.apk" ! -name "*-signed*" 2>/dev/null | head -1 || true)
  if [ -n "${RELEASE_APK}" ]; then
    sign_apk "${ANDROID_DIR}/${RELEASE_APK}"
  else
    log "Warning: release APK not found for manual signing step"
  fi

elif [ "${MODE}" = "store" ]; then
  # ── MODE 3: STORE ─────────────────────────────────────────────────────────
  log "--- MODE: store (bundleRelease) ---"
  setup_keystore

  ./gradlew bundleRelease \
    "-Pandroid.injected.signing.store.file=${ANDROID_DIR}/app/release.keystore" \
    "-Pandroid.injected.signing.store.password=${KEYSTORE_PASS}" \
    "-Pandroid.injected.signing.key.alias=${KEY_ALIAS}" \
    "-Pandroid.injected.signing.key.password=${KEY_PASS}" \
    --stacktrace 2>&1

  AAB=$(find app/build/outputs/bundle -name "*.aab" 2>/dev/null | head -1 || true)
  [ -n "${AAB}" ] && log "AAB artifact: ${ANDROID_DIR}/${AAB}" || log "Warning: .aab not found"

else
  die "Unknown mode '${MODE}'. Use: quick | production | store"
fi

log "=========================================="
log "  Build complete  id=${BUILD_ID}"
log "=========================================="
