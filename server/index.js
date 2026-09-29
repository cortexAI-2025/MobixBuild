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

// ─── CORS (allow web frontend from any origin) ────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const BUILDS_DIR = process.env.BUILDS_DIR || path.join(__dirname, '..', 'builds');
const SCRIPTS_DIR = process.env.SCRIPTS_DIR || path.join(__dirname, '..', 'scripts');
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/tmp/mobixbuild-uploads';

const BUILD_TIMEOUT_MS = (parseInt(process.env.BUILD_TIMEOUT_MIN, 10) || 30) * 60 * 1000;
const RETENTION_MS     = (parseInt(process.env.BUILD_RETENTION_HOURS, 10) || 24) * 3600 * 1000;

fs.mkdirSync(BUILDS_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ─── In-memory state ──────────────────────────────────────────────────────────

/** @type {Map<string, object>} */
const builds = new Map();
/** @type {string[]} */
const queue = [];
let running = false;

// SSE clients: buildId -> Set of response objects
/** @type {Map<string, Set<import('express').Response>>} */
const sseClients = new Map();

// ─── Persistence (survive restarts) ───────────────────────────────────────────

const SECRET_FIELDS = ['keystorePass', 'keyPass'];

function persistBuild(build) {
  try {
    const copy = { ...build, logs: undefined };
    SECRET_FIELDS.forEach((k) => delete copy[k]);
    fs.writeFileSync(path.join(BUILDS_DIR, build.id, 'meta.json'), JSON.stringify(copy));
  } catch (_) {}
}

function loadPersistedBuilds() {
  for (const id of fs.readdirSync(BUILDS_DIR)) {
    const dir = path.join(BUILDS_DIR, id);
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
      let logs = [];
      try { logs = fs.readFileSync(path.join(dir, 'build.log'), 'utf8').split('\n').filter(Boolean); } catch (_) {}
      // A build that was running/queued when the server died can never finish
      if (meta.status === 'running' || meta.status === 'queued') {
        meta.status = 'failed';
        meta.finishedAt = new Date().toISOString();
        logs.push('[MOBIXBUILD] Build interrupted by server restart');
      }
      builds.set(id, { ...meta, logs });
    } catch (_) {}
  }
}

function cleanupOldBuilds() {
  const now = Date.now();
  for (const [id, b] of builds) {
    if (b.status === 'queued' || b.status === 'running') continue;
    const finished = Date.parse(b.finishedAt || b.createdAt) || now;
    if (now - finished < RETENTION_MS) continue;
    builds.delete(id);
    fs.rm(path.join(BUILDS_DIR, id), { recursive: true, force: true }, () => {});
    if (b.archivePath)  fs.rm(b.archivePath,  { force: true }, () => {});
    if (b.keystorePath) fs.rm(b.keystorePath, { force: true }, () => {});
  }
}

// Only accept plain remote git URLs (blocks `--upload-pack=...`, file://, ext:: …)
function isValidRepoUrl(u) {
  return typeof u === 'string' && u.length < 500 &&
    /^(https:\/\/|git@)[\w.@:\/~+-]+$/.test(u) && !u.includes('..');
}

// ─── File upload ──────────────────────────────────────────────────────────────

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 200 * 1024 * 1024 },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sseWrite(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
}

function appendLog(id, line) {
  const build = builds.get(id);
  if (!build) return;
  build.logs.push(line);
  try {
    fs.appendFileSync(path.join(BUILDS_DIR, id, 'build.log'), line + '\n');
  } catch (_) {}

  // Broadcast to SSE subscribers
  const clients = sseClients.get(id);
  if (clients && clients.size > 0) {
    clients.forEach((res) => sseWrite(res, 'log', { line }));
  }
}

function broadcastStatus(id, status) {
  const clients = sseClients.get(id);
  if (!clients || clients.size === 0) return;
  clients.forEach((res) => {
    sseWrite(res, 'status', { status });
    if (status === 'success' || status === 'failed') {
      sseWrite(res, 'done', { status });
      try { res.end(); } catch (_) {}
    }
  });
  if (status === 'success' || status === 'failed') {
    sseClients.delete(id);
  }
}

function findOutputFile(buildDir, mode) {
  // build.sh records the exact artifact it produced
  try {
    const recorded = fs.readFileSync(path.join(buildDir, 'output.path'), 'utf8').trim();
    if (recorded && fs.existsSync(recorded)) return recorded;
  } catch (_) {}

  const src = path.join(buildDir, 'source');
  const ext = mode === 'store' ? '.aab' : '.apk';

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
  persistBuild(build);

  broadcastStatus(id, 'running');

  const buildDir = path.join(BUILDS_DIR, id);
  const scriptPath = path.join(SCRIPTS_DIR, 'build.sh');

  appendLog(id, `[MOBIXBUILD] Build ${id} started`);
  appendLog(id, `[MOBIXBUILD] mode=${build.mode}  repo=${build.repoUrl || '(uploaded archive)'}`);

  const args = [
    id, buildDir, build.mode,
    build.repoUrl      || '',
    build.archivePath  || '',
    build.keystorePath || '',
    build.keystorePass || '',
    build.keyAlias     || '',
    build.keyPass      || '',
  ];

  const proc = spawn('bash', [scriptPath, ...args], {
    cwd: buildDir,
    env: { ...process.env, BUILD_ID: id, BUILD_DIR: buildDir },
    detached: true, // own process group so a timeout can kill gradle & children
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    appendLog(id, `[MOBIXBUILD] Timeout after ${BUILD_TIMEOUT_MS / 60000} min — killing build`);
    try { process.kill(-proc.pid, 'SIGKILL'); } catch (_) {}
  }, BUILD_TIMEOUT_MS);

  proc.on('error', (err) => appendLog(id, `[MOBIXBUILD] Cannot start build script: ${err.message}`));

  proc.stdout.on('data', (data) =>
    data.toString().split('\n').filter(Boolean).forEach((l) => appendLog(id, l))
  );
  proc.stderr.on('data', (data) =>
    data.toString().split('\n').filter(Boolean).forEach((l) => appendLog(id, `[ERR] ${l}`))
  );

  proc.on('close', (code) => {
    clearTimeout(timer);
    running = false;
    build.finishedAt = new Date().toISOString();

    // Secrets are only needed during the build
    if (build.keystorePath) fs.rm(build.keystorePath, { force: true }, () => {});
    if (build.archivePath)  fs.rm(build.archivePath,  { force: true }, () => {});

    if (code === 0) {
      build.outputFile = findOutputFile(buildDir, build.mode);
      if (build.outputFile) {
        build.status = 'success';
        appendLog(id, `[MOBIXBUILD] Build succeeded → ${path.basename(build.outputFile)}`);
      } else {
        build.status = 'failed';
        appendLog(id, '[MOBIXBUILD] Build finished but no APK/AAB was produced');
      }
    } else {
      build.status = 'failed';
      appendLog(id, `[MOBIXBUILD] Build failed (${timedOut ? 'timeout' : 'exit ' + code})`);
    }

    persistBuild(build);
    broadcastStatus(id, build.status);
    processQueue();
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.post(
  '/build',
  upload.fields([
    { name: 'archive',  maxCount: 1 },
    { name: 'keystore', maxCount: 1 },
  ]),
  (req, res) => {
    const body = req.body || {};
    const files = req.files || {};

    const repoUrl      = body.repoUrl      || null;
    const mode         = body.mode         || 'quick';
    const keystorePass = body.keystorePass || '';
    const keyAlias     = body.keyAlias     || 'release';
    const keyPass      = body.keyPass      || '';

    const archiveFile  = files.archive  && files.archive[0];
    const keystoreFile = files.keystore && files.keystore[0];

    if (!repoUrl && !archiveFile) {
      return res.status(400).json({ error: 'Provide repoUrl or upload an archive file' });
    }
    if (repoUrl && !isValidRepoUrl(repoUrl)) {
      return res.status(400).json({ error: 'repoUrl must be an https:// or git@ repository URL' });
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
      id, status: 'queued', mode, repoUrl,
      archivePath:  archiveFile  ? archiveFile.path  : null,
      keystorePath: keystoreFile ? keystoreFile.path : null,
      keystorePass, keyAlias, keyPass,
      logs: [],
      createdAt: new Date().toISOString(),
      startedAt: null, finishedAt: null, outputFile: null,
    });

    persistBuild(builds.get(id));
    queue.push(id);
    setImmediate(processQueue);
    res.status(202).json({ id, status: 'queued' });
  }
);

app.get('/build/:id/status', (req, res) => {
  const build = builds.get(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });
  res.json({
    id: build.id, status: build.status, mode: build.mode,
    createdAt: build.createdAt, startedAt: build.startedAt,
    finishedAt: build.finishedAt, logs: build.logs,
  });
});

// SSE live log stream
app.get('/build/:id/logs/stream', (req, res) => {
  const build = builds.get(req.params.id);
  if (!build) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  // Replay existing logs
  build.logs.forEach((line) => sseWrite(res, 'log', { line }));
  sseWrite(res, 'status', { status: build.status });

  // If already terminal, close immediately
  if (build.status === 'success' || build.status === 'failed') {
    sseWrite(res, 'done', { status: build.status });
    return res.end();
  }

  // Register client
  if (!sseClients.has(req.params.id)) sseClients.set(req.params.id, new Set());
  sseClients.get(req.params.id).add(res);

  req.on('close', () => {
    const clients = sseClients.get(req.params.id);
    if (clients) clients.delete(res);
  });
});

app.get('/build/:id/download', (req, res) => {
  const build = builds.get(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });
  if (build.status !== 'success') {
    return res.status(400).json({ error: `Build status is '${build.status}', not 'success'` });
  }
  const outputFile =
    build.outputFile || findOutputFile(path.join(BUILDS_DIR, build.id), build.mode);
  if (!outputFile || !fs.existsSync(outputFile)) {
    return res.status(404).json({ error: 'Output artifact not found on disk' });
  }
  build.outputFile = outputFile;
  res.download(outputFile, path.basename(outputFile));
});

app.get('/builds', (_req, res) => {
  const list = [...builds.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 50)
    .map(({ id, status, mode, repoUrl, createdAt, finishedAt }) =>
      ({ id, status, mode, repoUrl, createdAt, finishedAt }));
  res.json(list);
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', queued: queue.length, running, builds: builds.size });
});

loadPersistedBuilds();
cleanupOldBuilds();
setInterval(cleanupOldBuilds, 30 * 60 * 1000).unref();

// Multer / route errors → JSON instead of an HTML stack trace
app.use((err, _req, res, _next) => {
  res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MobixBuild API listening on port ${PORT}`);
  console.log(`  builds dir : ${BUILDS_DIR}`);
  console.log(`  scripts dir: ${SCRIPTS_DIR}`);
});
