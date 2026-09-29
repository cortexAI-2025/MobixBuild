#!/usr/bin/env bash
# MobixBuild – core build engine (validated config from CI v22)
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

log() { echo "[$(date '+%H:%M:%S')] $*"; }
die() { log "ERROR: $*"; exit 1; }

log "=========================================="
log "  MobixBuild  id=${BUILD_ID}  mode=${MODE}"
log "=========================================="

# ─── Environment ──────────────────────────────────────────────────────────────

export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export GRADLE_USER_HOME="${BUILD_DIR}/.gradle-home"

export PATH="${JAVA_HOME}/bin:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/build-tools/34.0.0:${PATH}"

# JVM args validés en CI — évite les crashs WorkerLeaseService / AAPT2
export GRADLE_OPTS="-Xmx2g -XX:MaxMetaspaceSize=512m -XX:+UseG1GC -Dfile.encoding=UTF-8"

mkdir -p "${GRADLE_USER_HOME}"

log "JAVA_HOME    = ${JAVA_HOME}"
log "ANDROID_HOME = ${ANDROID_HOME}"
java -version 2>&1 || die "Java not found"

# ─── Source extraction ────────────────────────────────────────────────────────

SOURCE_DIR="${BUILD_DIR}/source"
mkdir -p "${SOURCE_DIR}"

if [ -n "${REPO_URL}" ]; then
  log "Cloning: ${REPO_URL}"
  GIT_TERMINAL_PROMPT=0 git clone --depth=1 -- "${REPO_URL}" "${SOURCE_DIR}" 2>&1
elif [ -n "${ARCHIVE_PATH}" ] && [ -f "${ARCHIVE_PATH}" ]; then
  log "Extracting archive: ${ARCHIVE_PATH}"
  unzip -q "${ARCHIVE_PATH}" -d "${SOURCE_DIR}" 2>&1 || \
    tar xf  "${ARCHIVE_PATH}" -C "${SOURCE_DIR}" 2>&1 || \
    die "Failed to extract archive"
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

PROJECT_TYPE="native"  # kotlin/java native Android

if [ -f "capacitor.config.ts" ] || [ -f "capacitor.config.js" ] || [ -f "capacitor.config.json" ]; then
  PROJECT_TYPE="capacitor"
elif [ -f "ionic.config.json" ]; then
  PROJECT_TYPE="capacitor"
elif [ -f "package.json" ] && (grep -q '"react-native"' package.json 2>/dev/null || [ -f "metro.config.js" ] || [ -f "metro.config.ts" ]); then
  PROJECT_TYPE="react-native"
elif [ -f "package.json" ] && [ -d "android" ]; then
  PROJECT_TYPE="capacitor"
elif [ -f "package.json" ] && [ ! -d "android" ]; then
  PROJECT_TYPE="web"
fi

log "Project type: ${PROJECT_TYPE}"

# ─── JS dependencies + web build ──────────────────────────────────────────────

if [ "${PROJECT_TYPE}" = "capacitor" ] || [ "${PROJECT_TYPE}" = "web" ] || [ "${PROJECT_TYPE}" = "react-native" ]; then
  log "Installing JS dependencies..."
  if [ -f "package-lock.json" ]; then
    npm ci --prefer-offline 2>&1 || npm install 2>&1
  elif [ -f "yarn.lock" ]; then
    yarn install --frozen-lockfile 2>&1 || yarn install 2>&1
  else
    npm install 2>&1
  fi

  if [ "${PROJECT_TYPE}" = "capacitor" ]; then
    log "Building web resources..."
    grep -q '"build"' package.json 2>/dev/null && npm run build 2>&1 || true
    log "Syncing Capacitor..."
    npx cap sync android 2>&1 || log "cap sync warning (continuing)"
  fi

  if [ "${PROJECT_TYPE}" = "react-native" ]; then
    log "React Native detected — Android dir will be ./android"
  fi
fi

# ─── Locate Android project root ──────────────────────────────────────────────

is_gradle_root() {
  [ -f "$1/gradlew" ] || [ -f "$1/settings.gradle" ] || [ -f "$1/settings.gradle.kts" ]
}

ANDROID_DIR=""
if is_gradle_root "${SOURCE_DIR}"; then
  ANDROID_DIR="${SOURCE_DIR}"
elif [ -d "${SOURCE_DIR}/android" ] && is_gradle_root "${SOURCE_DIR}/android"; then
  ANDROID_DIR="${SOURCE_DIR}/android"
else
  die "No Android project found (need gradlew or settings.gradle[.kts], at the root or in android/)"
fi

log "Android dir: ${ANDROID_DIR}"
cd "${ANDROID_DIR}"

# Use the project's wrapper when it is complete; otherwise fall back to the
# Gradle distribution baked into the image (wrapper jar is often not committed).
if [ -f gradlew ] && [ -f gradle/wrapper/gradle-wrapper.jar ]; then
  chmod +x gradlew
  GRADLE_CMD="./gradlew"
elif command -v gradle >/dev/null 2>&1; then
  log "Gradle wrapper missing/incomplete – using system Gradle"
  GRADLE_CMD="gradle"
else
  die "No usable Gradle: wrapper jar missing and no system gradle installed"
fi
log "Gradle command: ${GRADLE_CMD}"

# Write local.properties so Gradle can find the SDK
cat > local.properties <<EOF
sdk.dir=${ANDROID_HOME}
EOF

# ─── Inject validated gradle.properties ───────────────────────────────────────
# Ces valeurs ont été validées en CI (build #22, Gradle 8.6, AGP 8.3+).
# On les injecte sans écraser les props custom du projet.

GRADLE_PROPS="gradle.properties"

inject_prop() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "${GRADLE_PROPS}" 2>/dev/null; then
    # Remplace la valeur existante
    sed -i "s|^${key}=.*|${key}=${val}|" "${GRADLE_PROPS}"
  else
    echo "${key}=${val}" >> "${GRADLE_PROPS}"
  fi
}

touch "${GRADLE_PROPS}"
inject_prop "org.gradle.daemon"                      "false"
inject_prop "org.gradle.parallel"                    "false"
inject_prop "org.gradle.workers.max"                 "1"
inject_prop "org.gradle.configureondemand"           "false"
inject_prop "org.gradle.vfs.watch"                   "false"
inject_prop "kotlin.compiler.execution.strategy"     "in-process"
inject_prop "kotlin.incremental"                     "false"
inject_prop "android.enableAapt2DaemonModeCache"     "false"
inject_prop "android.useAndroidX"                    "true"

log "gradle.properties stabilisé pour CI"

# ─── Gradle flags communs ─────────────────────────────────────────────────────

GRADLE_FLAGS="--no-daemon --stacktrace --max-workers=1 -Dorg.gradle.jvmargs=-Xmx2g"

# ─── Signing setup (production / store) ──────────────────────────────────────

setup_keystore() {
  local ks_dest="${ANDROID_DIR}/app/release.keystore"
  mkdir -p "$(dirname "${ks_dest}")"

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

  cat > "${ANDROID_DIR}/keystore.properties" <<EOF
storeFile=release.keystore
storePassword=${KEYSTORE_PASS}
keyAlias=${KEY_ALIAS}
keyPassword=${KEY_PASS}
EOF

  log "Keystore ready"
}

sign_apk() {
  local apk_in="$1"
  local base="${apk_in%.apk}"
  local aligned="${base}-aligned.apk"
  local signed="${base}-signed.apk"
  local ks="${ANDROID_DIR}/app/release.keystore"

  log "zipalign → ${aligned}"
  "${ANDROID_HOME}/build-tools/34.0.0/zipalign" -v -p 4 "${apk_in}" "${aligned}" 2>&1 || {
    log "zipalign failed – skipping"
    aligned="${apk_in}"
  }

  log "apksigner → ${signed}"
  "${ANDROID_HOME}/build-tools/34.0.0/apksigner" sign \
    --ks           "${ks}" \
    --ks-pass      "pass:${KEYSTORE_PASS}" \
    --ks-key-alias "${KEY_ALIAS}" \
    --key-pass     "pass:${KEY_PASS}" \
    --out          "${signed}" \
    "${aligned}" 2>&1 && log "Signed: ${signed}" || log "apksigner failed – unsigned APK kept"
}

# ─── Gradle build ─────────────────────────────────────────────────────────────

OUTPUT=""

if [ "${MODE}" = "quick" ]; then
  log "--- MODE: quick (assembleDebug) ---"
  # shellcheck disable=SC2086
  ${GRADLE_CMD} assembleDebug ${GRADLE_FLAGS} 2>&1
  OUTPUT=$(find . -path "*/build/outputs/apk/debug/*.apk" -type f 2>/dev/null | head -1 || true)
  log "Debug APK built."

elif [ "${MODE}" = "production" ]; then
  log "--- MODE: production (assembleRelease + sign) ---"
  setup_keystore
  # shellcheck disable=SC2086
  ${GRADLE_CMD} assembleRelease ${GRADLE_FLAGS} \
    "-Pandroid.injected.signing.store.file=${ANDROID_DIR}/app/release.keystore" \
    "-Pandroid.injected.signing.store.password=${KEYSTORE_PASS}" \
    "-Pandroid.injected.signing.key.alias=${KEY_ALIAS}" \
    "-Pandroid.injected.signing.key.password=${KEY_PASS}" \
    2>&1

  RELEASE_APK=$(find . -path "*/build/outputs/apk/release/*.apk" ! -name "*-signed*" ! -name "*-aligned*" -type f 2>/dev/null | head -1 || true)
  if [ -n "${RELEASE_APK}" ]; then
    sign_apk "${ANDROID_DIR}/${RELEASE_APK#./}"
    OUTPUT=$(find . -path "*/build/outputs/apk/release/*-signed.apk" -type f 2>/dev/null | head -1 || true)
    # apksigner unavailable/failed → ship the unsigned release APK rather than nothing
    [ -n "${OUTPUT}" ] || OUTPUT="${RELEASE_APK}"
  fi

elif [ "${MODE}" = "store" ]; then
  log "--- MODE: store (bundleRelease) ---"
  setup_keystore
  # shellcheck disable=SC2086
  ${GRADLE_CMD} bundleRelease ${GRADLE_FLAGS} \
    "-Pandroid.injected.signing.store.file=${ANDROID_DIR}/app/release.keystore" \
    "-Pandroid.injected.signing.store.password=${KEYSTORE_PASS}" \
    "-Pandroid.injected.signing.key.alias=${KEY_ALIAS}" \
    "-Pandroid.injected.signing.key.password=${KEY_PASS}" \
    2>&1

  OUTPUT=$(find . -path "*/build/outputs/bundle/release/*.aab" -type f 2>/dev/null | head -1 || true)

else
  die "Unknown mode '${MODE}'. Use: quick | production | store"
fi

# ─── Record the produced artifact for the API ─────────────────────────────────

[ -n "${OUTPUT:-}" ] || die "Gradle finished but no artifact was found"
OUTPUT_ABS="${ANDROID_DIR}/${OUTPUT#./}"
[ -f "${OUTPUT_ABS}" ] || die "Artifact missing: ${OUTPUT_ABS}"
echo "${OUTPUT_ABS}" > "${BUILD_DIR}/output.path"
log "Artifact: ${OUTPUT_ABS} ($(du -h "${OUTPUT_ABS}" | cut -f1))"

log "=========================================="
log "  Build complete  id=${BUILD_ID}"
log "=========================================="
