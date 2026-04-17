'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const BUILDS_DIR = process.env.BUILDS_DIR || path.join(__dirname, '..', 'builds');
const SCRIPTS_DIR = process.env.SCRIPTS_DIR || path.join(__dirname, '..', 'scripts');
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/tmp/mobixbuild-uploads';

fs.mkdirSync(BUILDS_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ─── In-memory state ──────────────────────────────────────────────────────────

/** @type {Map<string, BuildRecord>} */
const builds = new Map();
/** @type {string[]} */
const queue = [];
let running = false;

// ─── File upload (keystore + optional zip archive) ────────────────────────────

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function appendLog(id, line) {
  const build = builds.get(id);
  if (!build) return;
  build.logs.push(line);
  try {
    fs.appendFileSync(path.join(BUILDS_DIR, id, 'build.log'), line + '\n');
  } catch (_) {}
}

function findOutputFile(buildDir, mode) {
  const src = path.join(buildDir, 'source');
  const ext = mode === 'store' ? '.aab' : '.apk';

  // Well-known output paths (fastest check)
  const candidates =
    mode === 'store'
      ? [
          path.join(src, 'android', 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab'),
          path.join(src, 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab'),
        ]
      : mode === 'production'
      ? [
          path.join(src, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release-signed.apk'),
          path.join(src, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
          path.join(src, 'app', 'build', 'outputs', 'apk', 'release', 'app-release-signed.apk'),
          path.join(src, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
        ]
      : [
          path.join(src, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'),
          path.join(src, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'),
        ];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  // Fallback: recursive search under source/
  return walkForExt(src, ext);
}

function walkForExt(dir, ext) {
  if (!fs.existsSync(dir)) return null;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = walkForExt(full, ext);
        if (found) return found;
      } else if (entry.name.endsWith(ext)) {
        return full;
      }
    }
  } catch (_) {}
  return null;
}

// ─── Build queue ──────────────────────────────────────────────────────────────

function processQueue() {
  if (running || queue.length === 0) return;

  const id = queue.shift();
  const build = builds.get(id);
  if (!build) { processQueue(); return; }

  running = true;
  build.status = 'running';
  build.startedAt = new Date().toISOString();

  const buildDir = path.join(BUILDS_DIR, id);
  const scriptPath = path.join(SCRIPTS_DIR, 'build.sh');

  appendLog(id, `[MOBIXBUILD] Build ${id} started`);
  appendLog(id, `[MOBIXBUILD] mode=${build.mode}  repo=${build.repoUrl || '(uploaded archive)'}`);

  const args = [
    id,
    buildDir,
    build.mode,
    build.repoUrl   || '',
    build.archivePath  || '',
    build.keystorePath || '',
    build.keystorePass || '',
    build.keyAlias     || '',
    build.keyPass      || '',
  ];

  const proc = spawn('bash', [scriptPath, ...args], {
    cwd: buildDir,
    env: { ...process.env, BUILD_ID: id, BUILD_DIR: buildDir },
  });

  proc.stdout.on('data', (data) =>
    data.toString().split('\n').filter(Boolean).forEach((l) => appendLog(id, l))
  );
  proc.stderr.on('data', (data) =>
    data.toString().split('\n').filter(Boolean).forEach((l) => appendLog(id, `[ERR] ${l}`))
  );

  proc.on('close', (code) => {
    running = false;
    build.finishedAt = new Date().toISOString();

    if (code === 0) {
      build.status = 'success';
      build.outputFile = findOutputFile(buildDir, build.mode);
      appendLog(id, `[MOBIXBUILD] Build succeeded → ${build.outputFile || 'output not located'}`);
    } else {
      build.status = 'failed';
      appendLog(id, `[MOBIXBUILD] Build failed (exit ${code})`);
    }

    processQueue();
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /build
 * Body (JSON):  { repoUrl, mode, keystorePass, keyAlias, keyPass }
 * Body (form):  same fields + optional files: archive, keystore
 */
app.post(
  '/build',
  upload.fields([
    { name: 'archive',  maxCount: 1 },
    { name: 'keystore', maxCount: 1 },
  ]),
  (req, res) => {
    const body = req.body || {};
    const files = req.files || {};

    const repoUrl    = body.repoUrl    || null;
    const mode       = body.mode       || 'quick';
    const keystorePass = body.keystorePass || '';
    const keyAlias   = body.keyAlias   || 'release';
    const keyPass    = body.keyPass    || '';

    const archiveFile  = files.archive  && files.archive[0];
    const keystoreFile = files.keystore && files.keystore[0];

    if (!repoUrl && !archiveFile) {
      return res.status(400).json({ error: 'Provide repoUrl or upload an archive file' });
    }

    const validModes = ['quick', 'production', 'store'];
    if (!validModes.includes(mode)) {
      return res.status(400).json({ error: `mode must be one of: ${validModes.join(', ')}` });
    }

    const id = uuidv4();
    const buildDir = path.join(BUILDS_DIR, id);
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, 'build.log'), '');

    builds.set(id, {
      id,
      status: 'queued',
      mode,
      repoUrl,
      archivePath:  archiveFile  ? archiveFile.path  : null,
      keystorePath: keystoreFile ? keystoreFile.path : null,
      keystorePass,
      keyAlias,
      keyPass,
      logs: [],
      createdAt:   new Date().toISOString(),
      startedAt:   null,
      finishedAt:  null,
      outputFile:  null,
    });

    queue.push(id);
    setImmediate(processQueue);

    res.status(202).json({ id, status: 'queued' });
  }
);

/**
 * GET /build/:id/status
 */
app.get('/build/:id/status', (req, res) => {
  const build = builds.get(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });

  res.json({
    id:          build.id,
    status:      build.status,
    mode:        build.mode,
    createdAt:   build.createdAt,
    startedAt:   build.startedAt,
    finishedAt:  build.finishedAt,
    logs:        build.logs,
  });
});

/**
 * GET /build/:id/download
 */
app.get('/build/:id/download', (req, res) => {
  const build = builds.get(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });

  if (build.status !== 'success') {
    return res.status(400).json({ error: `Build status is '${build.status}', not 'success'` });
  }

  // Resolve output file (cached or re-scan)
  const outputFile =
    build.outputFile ||
    findOutputFile(path.join(BUILDS_DIR, build.id), build.mode);

  if (!outputFile || !fs.existsSync(outputFile)) {
    return res.status(404).json({ error: 'Output artifact not found on disk' });
  }

  build.outputFile = outputFile; // cache
  res.download(outputFile, path.basename(outputFile));
});

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', queued: queue.length, running });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MobixBuild API listening on port ${PORT}`);
  console.log(`  builds dir : ${BUILDS_DIR}`);
  console.log(`  scripts dir: ${SCRIPTS_DIR}`);
});
