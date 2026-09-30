'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
const TOKEN_KEY = 'mobixbuild.token';

interface BuildSummary {
  id: string;
  status: 'queued' | 'running' | 'success' | 'failed';
  mode: Mode;
  repoUrl: string | null;
  createdAt: string;
}

async function readError(res: Response) {
  const text = await res.text().catch(() => '');
  try { return JSON.parse(text).error || text || `HTTP ${res.status}`; } catch { return text || `HTTP ${res.status}`; }
}

function timeAgo(iso: string) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type Mode    = 'quick' | 'production' | 'store';
type Phase   = 'idle' | 'building' | 'success' | 'failed';
type InputTab = 'url' | 'zip';

interface ModeConfig {
  id: Mode;
  label: string;
  badge: string;
  desc: string;
  icon: string;
  seconds: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MODES: ModeConfig[] = [
  { id: 'quick',      label: 'Quick',       badge: 'Free',    desc: 'Debug APK — fast build',          icon: '⚡', seconds: 120 },
  { id: 'production', label: 'Production',  badge: 'APK',     desc: 'Signed release APK',              icon: '🔒', seconds: 240 },
  { id: 'store',      label: 'Play Store',  badge: 'AAB',     desc: 'App Bundle for Google Play',      icon: '🚀', seconds: 300 },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtSecs(s: number) {
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Logo() {
  return (
    <div className="flex items-center gap-3">
      <div className="w-9 h-9 rounded-xl flex items-center justify-center font-bold text-base text-white"
           style={{ background: 'linear-gradient(135deg, #7C3AED, #2563EB)' }}>
        M
      </div>
      <span className="font-bold text-xl tracking-tight">
        Mobix<span className="text-gradient">Build</span>
      </span>
    </div>
  );
}

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="w-full h-1.5 bg-white/5 rounded-full overflow-hidden">
      <div
        className="h-full rounded-full transition-all duration-700 ease-out"
        style={{
          width: `${value}%`,
          background: 'linear-gradient(90deg, #2563EB, #7C3AED)',
          boxShadow: '0 0 12px rgba(37,99,235,0.6)',
        }}
      />
    </div>
  );
}

interface LogTerminalProps {
  logs: string[];
  phase: Phase;
}

function LogTerminal({ logs, phase }: LogTerminalProps) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const colorLine = (line: string) => {
    if (line.includes('ERROR') || line.includes('[ERR]') || line.includes('FAILED'))
      return 'text-red-400';
    if (line.includes('success') || line.includes('succeeded') || line.includes('BUILD SUCCESS'))
      return 'text-green-400';
    if (line.includes('[MOBIXBUILD]'))
      return 'text-blue-400';
    if (line.includes('WARNING') || line.includes('warning'))
      return 'text-yellow-400/80';
    return 'text-white/70';
  };

  return (
    <div className="glass rounded-2xl overflow-hidden">
      {/* Terminal header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5">
        <div className="flex gap-1.5">
          <div className="w-3 h-3 rounded-full bg-red-500/60" />
          <div className="w-3 h-3 rounded-full bg-yellow-500/60" />
          <div className="w-3 h-3 rounded-full bg-green-500/60" />
        </div>
        <span className="text-xs text-white/30 font-mono ml-2">build output</span>
        <div className="ml-auto flex items-center gap-2">
          {phase === 'building' && (
            <span className="flex items-center gap-1.5 text-xs text-blue-400">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
              live
            </span>
          )}
          {phase === 'success' && (
            <span className="text-xs text-green-400">● done</span>
          )}
          {phase === 'failed' && (
            <span className="text-xs text-red-400">● failed</span>
          )}
        </div>
      </div>

      {/* Log content */}
      <div className="h-72 overflow-y-auto p-4 font-mono text-xs leading-relaxed">
        {logs.length === 0 ? (
          <span className="text-white/20">Waiting for build to start...</span>
        ) : (
          logs.map((line, i) => (
            <div key={i} className={`${colorLine(line)} whitespace-pre-wrap break-all`}>
              {line}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function Home() {
  const [phase, setPhase]       = useState<Phase>('idle');
  const [mode, setMode]         = useState<Mode>('quick');
  const [tab, setTab]           = useState<InputTab>('url');
  const [repoUrl, setRepoUrl]   = useState('');
  const [file, setFile]         = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [buildId, setBuildId]   = useState<string | null>(null);
  const [logs, setLogs]         = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [elapsed, setElapsed]   = useState(0);
  const [error, setError]       = useState<string | null>(null);
  const [token, setToken]       = useState('');
  const [online, setOnline]     = useState<boolean | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [history, setHistory]   = useState<BuildSummary[]>([]);
  const [keystore, setKeystore] = useState<File | null>(null);
  const [ksPass, setKsPass]     = useState('');
  const [keyAlias, setKeyAlias] = useState('');
  const [keyPass, setKeyPass]   = useState('');
  const [queuePos, setQueuePos] = useState(0);

  const esRef          = useRef<EventSource | null>(null);
  const progressRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef   = useRef<HTMLInputElement>(null);
  const pollRef        = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── API helpers (token-aware) ──────────────────────────────────────────────
  const authHeaders = useCallback((): HeadersInit => (token ? { Authorization: `Bearer ${token}` } : {}), [token]);
  const withToken   = useCallback((url: string) => (token ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : url), [token]);

  useEffect(() => {
    try { setToken(localStorage.getItem(TOKEN_KEY) || ''); } catch (_) {}
  }, []);

  const saveToken = (t: string) => {
    setToken(t);
    try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (_) {}
  };

  // Server health (drives the status pill and the token prompt)
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const r = await fetch(`${API}/health`);
        const d = await r.json();
        if (!alive) return;
        setOnline(r.ok);
        setAuthRequired(!!d.auth);
      } catch (_) { if (alive) setOnline(false); }
    };
    check();
    const iv = setInterval(check, 15000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const r = await fetch(`${API}/builds`, { headers: authHeaders() });
      if (r.ok) setHistory(await r.json());
    } catch (_) {}
  }, [authHeaders]);

  useEffect(() => { if (phase === 'idle') loadHistory(); }, [phase, loadHistory]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      esRef.current?.close();
      if (progressRef.current) clearInterval(progressRef.current);
      if (elapsedRef.current)  clearInterval(elapsedRef.current);
      if (pollRef.current)     clearInterval(pollRef.current);
    };
  }, []);

  const clearTimers = useCallback(() => {
    if (progressRef.current) { clearInterval(progressRef.current); progressRef.current = null; }
    if (elapsedRef.current)  { clearInterval(elapsedRef.current);  elapsedRef.current  = null; }
    if (pollRef.current)     { clearInterval(pollRef.current);     pollRef.current     = null; }
  }, []);

  // ── Drag & drop ─────────────────────────────────────────────────────────────
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) { setFile(f); setTab('zip'); }
  };

  // ── SSE / polling ────────────────────────────────────────────────────────────
  const connectSSE = useCallback((id: string) => {
    setLogs([]);
    const es = new EventSource(withToken(`${API}/build/${id}/logs/stream`));
    esRef.current = es;

    es.addEventListener('status', (e) => {
      const { status } = JSON.parse(e.data);
      if (status !== 'queued') setQueuePos(0);
    });

    es.addEventListener('log', (e) => {
      const { line } = JSON.parse(e.data);
      setLogs((prev) => [...prev, line]);
    });

    es.addEventListener('done', (e) => {
      const { status } = JSON.parse(e.data);
      clearTimers();
      setProgress(100);
      setPhase(status === 'success' ? 'success' : 'failed');
      es.close();
    });

    es.onerror = () => {
      es.close();
      if (pollRef.current) return;
      // Fallback to polling (proxies that buffer SSE, dropped connection…)
      pollRef.current = setInterval(async () => {
        try {
          const r = await fetch(`${API}/build/${id}/status`, { headers: authHeaders() });
          if (!r.ok) throw new Error(await readError(r));
          const d = await r.json();
          setLogs(d.logs || []);
          setQueuePos(d.queuePosition || 0);
          if (d.status === 'success' || d.status === 'failed') {
            clearTimers();
            setProgress(100);
            setPhase(d.status);
          }
        } catch (err) {
          clearTimers();
          setError(err instanceof Error ? err.message : 'Lost connection to the build server');
          setPhase('failed');
        }
      }, 2000);
    };
  }, [clearTimers, withToken, authHeaders]);

  // Poll the queue position while waiting for a free builder
  useEffect(() => {
    if (phase !== 'building' || !buildId) return;
    let alive = true;
    const check = async () => {
      try {
        const r = await fetch(`${API}/build/${buildId}/status`, { headers: authHeaders() });
        if (r.ok && alive) setQueuePos((await r.json()).queuePosition || 0);
      } catch (_) {}
    };
    check();
    const iv = setInterval(check, 5000);
    return () => { alive = false; clearInterval(iv); };
  }, [phase, buildId, authHeaders]);

  // ── Submit build ─────────────────────────────────────────────────────────────
  const startTimers = (secs: number) => {
    let ticks = 0;
    progressRef.current = setInterval(() => {
      ticks++;
      setProgress(Math.min(92, Math.round((1 - Math.exp((-3 * ticks * 2) / secs)) * 100)));
    }, 2000);
    elapsedRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
  };

  const startBuild = async () => {
    const url = tab === 'url' ? repoUrl.trim() : '';
    const archive = tab === 'zip' ? file : null;
    if (!url && !archive) {
      setError(tab === 'url' ? 'Enter a repository URL' : 'Choose a .zip archive');
      return;
    }
    if (authRequired && !token) {
      setShowSettings(true);
      setError('This server requires an API token (⚙ Settings)');
      return;
    }
    setError(null);
    setLogs([]);
    setProgress(0);
    setElapsed(0);
    setPhase('building');

    startTimers(MODES.find((m) => m.id === mode)!.seconds);

    const fd = new FormData();
    if (url) fd.append('repoUrl', url);
    if (archive) fd.append('archive', archive);
    fd.append('mode', mode);
    if (mode !== 'quick' && keystore) {
      fd.append('keystore', keystore);
      fd.append('keystorePass', ksPass);
      fd.append('keyAlias', keyAlias || 'release');
      fd.append('keyPass', keyPass || ksPass);
    }

    try {
      const res = await fetch(`${API}/build`, { method: 'POST', body: fd, headers: authHeaders() });
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json();
      setBuildId(data.id);
      connectSSE(data.id);
    } catch (err: unknown) {
      clearTimers();
      setPhase('failed');
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  // ── Download ──────────────────────────────────────────────────────────────
  const download = () => {
    if (buildId) window.open(withToken(`${API}/build/${buildId}/download`), '_blank');
  };

  // ── Re-open a build from history ──────────────────────────────────────────
  const openBuild = (b: BuildSummary) => {
    setError(null);
    setMode(b.mode);
    setBuildId(b.id);
    setElapsed(0);
    setProgress(b.status === 'success' || b.status === 'failed' ? 100 : 0);
    setPhase('building');
    if (b.status === 'queued' || b.status === 'running') startTimers(MODES.find((m) => m.id === b.mode)!.seconds);
    connectSSE(b.id);
  };

  // ── Cancel (stops the build on the server, not just the UI) ──────────────
  const cancel = async () => {
    if (buildId) {
      try {
        await fetch(`${API}/build/${buildId}/cancel`, { method: 'POST', headers: authHeaders() });
      } catch (_) {}
    }
    reset();
  };

  // ── Reset ─────────────────────────────────────────────────────────────────
  const reset = () => {
    esRef.current?.close();
    clearTimers();
    setPhase('idle');
    setBuildId(null);
    setLogs([]);
    setProgress(0);
    setElapsed(0);
    setError(null);
  };

  const modeConfig = MODES.find((m) => m.id === mode)!;
  const estRemaining = Math.max(0, Math.round(modeConfig.seconds * (1 - progress / 100)));

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <main className="min-h-screen bg-bg relative overflow-x-hidden">
      {/* Ambient glows */}
      <div className="fixed inset-0 pointer-events-none select-none" aria-hidden>
        <div className="absolute top-[-15%] left-[15%] w-[700px] h-[700px] rounded-full opacity-20"
             style={{ background: 'radial-gradient(circle, #2563EB 0%, transparent 70%)' }} />
        <div className="absolute top-[20%] right-[5%] w-[500px] h-[500px] rounded-full opacity-15"
             style={{ background: 'radial-gradient(circle, #7C3AED 0%, transparent 70%)' }} />
      </div>

      {/* Navbar */}
      <nav className="relative z-10 border-b border-white/5 px-6 py-4 flex items-center justify-between max-w-screen-xl mx-auto">
        <Logo />
        <div className="flex items-center gap-6 text-sm text-white/40">
          <button onClick={() => setShowSettings((v) => !v)} className="hover:text-white/80 transition-colors">
            ⚙ Settings{authRequired && !token ? ' •' : ''}
          </button>
          <a href="https://github.com/cortexAI-2025/MobixBuild" className="hover:text-white/80 transition-colors">GitHub</a>
        </div>
      </nav>

      {/* Page content */}
      <div className="relative z-10 max-w-2xl mx-auto px-6 py-16 animate-fade-in">

        {/* Hero */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2 glass rounded-full px-4 py-1.5 text-xs text-white/50 mb-6 border border-white/5">
            <span className={`w-1.5 h-1.5 rounded-full ${
              online === null ? 'bg-white/30' : online ? 'bg-green-400 animate-pulse' : 'bg-red-400'
            }`} />
            {online === null ? 'Checking build service…' : online ? 'Build service online' : `Build service unreachable (${API})`}
          </div>
          <h1 className="text-5xl font-bold leading-tight mb-4">
            Build Mobile Apps.
            <br />
            <span className="text-gradient">Instantly.</span>
          </h1>
          <p className="text-white/40 text-lg">From repo to APK in one click</p>
        </div>

        {/* ── Settings ──────────────────────────────────────────────────────── */}
        {showSettings && (
          <div className="glass rounded-2xl p-5 mb-6 space-y-3 animate-fade-in">
            <p className="text-xs text-white/30 uppercase tracking-wider font-semibold">Server</p>
            <p className="text-xs text-white/40 font-mono break-all">{API}</p>
            <label className="block text-xs text-white/40">
              API token {authRequired ? '(required by this server)' : '(not required by this server)'}
              <input
                type="password"
                value={token}
                onChange={(e) => saveToken(e.target.value.trim())}
                placeholder="API_TOKEN"
                className="mt-1 w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-white/25 focus:outline-none focus:border-mblue/60"
              />
            </label>
            <p className="text-[11px] text-white/25">Stored in this browser only.</p>
          </div>
        )}

        {/* ── IDLE: input form ──────────────────────────────────────────────── */}
        {phase === 'idle' && (
          <div className="glass rounded-2xl p-6 space-y-6 animate-fade-in">

            {/* Tab selector */}
            <div className="flex bg-white/5 rounded-xl p-1 text-sm">
              {(['url', 'zip'] as InputTab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`flex-1 py-2 rounded-lg font-medium transition-all duration-200 ${
                    tab === t
                      ? 'bg-white/10 text-white shadow-sm'
                      : 'text-white/40 hover:text-white/60'
                  }`}
                >
                  {t === 'url' ? '🔗  GitHub URL' : '📦  Upload ZIP'}
                </button>
              ))}
            </div>

            {/* Input */}
            {tab === 'url' ? (
              <div>
                <input
                  type="url"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && startBuild()}
                  placeholder="https://github.com/user/my-android-app"
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder:text-white/25 focus:outline-none focus:border-mblue/60 transition-colors"
                />
              </div>
            ) : (
              <div
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`relative border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all duration-200 ${
                  dragging
                    ? 'border-mblue/70 bg-mblue/10'
                    : file
                    ? 'border-green-500/50 bg-green-500/5'
                    : 'border-white/10 hover:border-white/25 hover:bg-white/5'
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".zip"
                  className="hidden"
                  onChange={(e) => { if (e.target.files?.[0]) setFile(e.target.files[0]); }}
                />
                {file ? (
                  <div className="space-y-1">
                    <div className="text-2xl">📦</div>
                    <p className="text-white/80 font-medium text-sm">{file.name}</p>
                    <p className="text-white/30 text-xs">{fileSize(file.size)}</p>
                    <button
                      onClick={(e) => { e.stopPropagation(); setFile(null); }}
                      className="text-xs text-white/30 hover:text-white/60 mt-1"
                    >
                      Remove
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="text-3xl opacity-40">↑</div>
                    <p className="text-white/40 text-sm">
                      Drop your <span className="text-white/60">.zip</span> here or click to browse
                    </p>
                    <p className="text-white/20 text-xs">Max 200 MB</p>
                  </div>
                )}
              </div>
            )}

            {/* Mode selector */}
            <div>
              <p className="text-xs text-white/30 uppercase tracking-wider mb-3 font-semibold">Build Mode</p>
              <div className="grid grid-cols-3 gap-3">
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => setMode(m.id)}
                    className={`p-4 rounded-xl border text-left transition-all duration-200 ${
                      mode === m.id
                        ? 'border-mblue/60 bg-mblue/10 shadow-[0_0_20px_rgba(37,99,235,0.2)]'
                        : 'border-white/10 hover:border-white/20 bg-white/5 hover:bg-white/5'
                    }`}
                  >
                    <div className="text-xl mb-2">{m.icon}</div>
                    <div className="font-semibold text-sm text-white mb-0.5">{m.label}</div>
                    <div className="text-[10px] text-white/40 leading-tight">{m.desc}</div>
                    <div className={`mt-2 text-[10px] font-bold rounded px-1.5 py-0.5 inline-block ${
                      m.id === 'quick'
                        ? 'bg-green-500/20 text-green-400'
                        : 'bg-white/5 text-white/40'
                    }`}>
                      {m.badge}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Signing (production / store) */}
            {mode !== 'quick' && (
              <div className="space-y-3 border border-white/10 rounded-xl p-4 bg-white/5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm text-white/80 font-medium">Signing keystore</p>
                    <p className="text-[11px] text-white/30">
                      {keystore ? keystore.name : 'Optional — a throw-away key is generated otherwise. Use your own for Google Play.'}
                    </p>
                  </div>
                  <label className="text-xs text-white/60 border border-white/15 rounded-lg px-3 py-1.5 cursor-pointer hover:bg-white/5 whitespace-nowrap">
                    {keystore ? 'Change' : 'Upload .jks'}
                    <input type="file" accept=".jks,.keystore,.p12" className="hidden"
                           onChange={(e) => setKeystore(e.target.files?.[0] || null)} />
                  </label>
                </div>
                {keystore && (
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      ['Store password', ksPass, setKsPass, 'password'],
                      ['Key alias', keyAlias, setKeyAlias, 'text'],
                      ['Key password', keyPass, setKeyPass, 'password'],
                    ].map(([label, value, set, type]) => (
                      <input
                        key={label as string}
                        type={type as string}
                        value={value as string}
                        placeholder={label as string}
                        onChange={(e) => (set as (v: string) => void)(e.target.value)}
                        className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder:text-white/25 focus:outline-none focus:border-mblue/60"
                      />
                    ))}
                    <button onClick={() => { setKeystore(null); setKsPass(''); setKeyAlias(''); setKeyPass(''); }}
                            className="col-span-3 text-[11px] text-white/30 hover:text-white/60 text-left">
                      Remove keystore
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Error */}
            {error && (
              <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
                {error}
              </p>
            )}

            {/* CTA */}
            <button onClick={startBuild} className="btn-primary w-full text-center">
              Build Now →
            </button>
          </div>
        )}

        {/* ── Recent builds ─────────────────────────────────────────────────── */}
        {phase === 'idle' && history.length > 0 && (
          <div className="mt-8 animate-fade-in">
            <p className="text-xs text-white/30 uppercase tracking-wider font-semibold mb-3">Recent builds</p>
            <div className="glass rounded-2xl divide-y divide-white/5">
              {history.slice(0, 10).map((b) => (
                <button key={b.id} onClick={() => openBuild(b)}
                        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/5 transition-colors">
                  <span className={`text-xs font-semibold w-16 ${
                    b.status === 'success' ? 'text-green-400' : b.status === 'failed' ? 'text-red-400' : 'text-blue-400'
                  }`}>
                    {b.status === 'success' ? '✓ ok' : b.status === 'failed' ? '✗ failed' : `⏳ ${b.status}`}
                  </span>
                  <span className="flex-1 text-sm text-white/60 truncate">
                    {b.repoUrl ? b.repoUrl.replace(/^https:\/\/(www\.)?github\.com\//, '') : 'Uploaded archive'}
                  </span>
                  <span className="text-[11px] text-white/30">{MODES.find((m) => m.id === b.mode)?.label}</span>
                  <span className="text-[11px] text-white/20 w-14 text-right">{timeAgo(b.createdAt)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── BUILDING / SUCCESS / FAILED ───────────────────────────────────── */}
        {phase !== 'idle' && (
          <div className="space-y-4 animate-fade-in">

            {/* Status card */}
            <div className="glass rounded-2xl p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <p className="text-xs text-white/30 uppercase tracking-wider font-semibold mb-1">
                    {modeConfig.icon} {modeConfig.label} Build
                  </p>
                  <p className="text-sm text-white/50 font-mono truncate max-w-xs">
                    {buildId || '…'}
                  </p>
                </div>
                <div className={`text-sm font-semibold px-3 py-1 rounded-full ${
                  phase === 'building'
                    ? 'bg-blue-500/15 text-blue-400'
                    : phase === 'success'
                    ? 'bg-green-500/15 text-green-400'
                    : 'bg-red-500/15 text-red-400'
                }`}>
                  {phase === 'building' ? '⏳ Building' : phase === 'success' ? '✓ Success' : '✗ Failed'}
                </div>
              </div>

              <ProgressBar value={progress} />

              <div className="flex justify-between mt-2 text-xs text-white/25">
                <span>{queuePos > 0 ? `Waiting in queue — position ${queuePos}` : `Elapsed: ${fmtSecs(elapsed)}`}</span>
                {phase === 'building' && (
                  <span>~{fmtSecs(estRemaining)} remaining</span>
                )}
                {phase !== 'building' && (
                  <span>{progress}%</span>
                )}
              </div>
            </div>

            {/* Terminal */}
            <LogTerminal logs={logs} phase={phase} />

            {/* Actions */}
            {phase === 'success' && (
              <div className="glass rounded-2xl p-5 flex items-center justify-between animate-fade-in">
                <div>
                  <p className="font-semibold text-green-400 mb-1">Build successful 🎉</p>
                  <p className="text-xs text-white/30">
                    {modeConfig.label} artifact ready for download
                  </p>
                </div>
                <button onClick={download} className="btn-primary text-sm whitespace-nowrap">
                  Download {mode === 'store' ? '.aab' : '.apk'}  ↓
                </button>
              </div>
            )}

            {phase === 'failed' && (
              <div className="glass rounded-2xl p-5 flex items-center justify-between animate-fade-in">
                <div>
                  <p className="font-semibold text-red-400 mb-1">Build failed</p>
                  <p className="text-xs text-white/40 break-words">{error || 'Check the logs above for details'}</p>
                </div>
                <button onClick={reset} className="btn-primary text-sm">
                  Try Again
                </button>
              </div>
            )}

            {phase === 'building' && (
              <button onClick={cancel} className="w-full text-center text-xs text-white/20 hover:text-red-400/70 py-2 transition-colors">
                Cancel build
              </button>
            )}

            {phase !== 'building' && (
              <button onClick={reset} className="w-full text-center text-xs text-white/20 hover:text-white/40 py-2 transition-colors">
                ← Build Another
              </button>
            )}
          </div>
        )}

        {/* Footer */}
        <p className="text-center text-white/15 text-xs mt-16">
          MobixBuild · Android build infrastructure
        </p>
      </div>
    </main>
  );
}
