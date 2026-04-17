'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

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

  const esRef          = useRef<EventSource | null>(null);
  const progressRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef   = useRef<HTMLInputElement>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      esRef.current?.close();
      if (progressRef.current) clearInterval(progressRef.current);
      if (elapsedRef.current)  clearInterval(elapsedRef.current);
    };
  }, []);

  const clearTimers = useCallback(() => {
    if (progressRef.current) { clearInterval(progressRef.current); progressRef.current = null; }
    if (elapsedRef.current)  { clearInterval(elapsedRef.current);  elapsedRef.current  = null; }
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
    const es = new EventSource(`${API}/build/${id}/logs/stream`);
    esRef.current = es;

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
      // Fallback to polling
      const iv = setInterval(async () => {
        try {
          const r = await fetch(`${API}/build/${id}/status`);
          const d = await r.json();
          setLogs(d.logs || []);
          if (d.status === 'success' || d.status === 'failed') {
            clearInterval(iv);
            clearTimers();
            setProgress(100);
            setPhase(d.status);
          }
        } catch (_) {}
      }, 2000);
    };
  }, [clearTimers]);

  // ── Submit build ─────────────────────────────────────────────────────────────
  const startBuild = async () => {
    if (!repoUrl.trim() && !file) {
      setError('Enter a GitHub URL or upload a ZIP file');
      return;
    }
    setError(null);
    setLogs([]);
    setProgress(0);
    setElapsed(0);
    setPhase('building');

    const totalSecs = MODES.find((m) => m.id === mode)!.seconds;

    // Progress (exponential growth toward ~92%)
    let ticks = 0;
    progressRef.current = setInterval(() => {
      ticks++;
      setProgress(Math.min(92, Math.round((1 - Math.exp((-3 * ticks * 2) / totalSecs)) * 100)));
    }, 2000);

    elapsedRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);

    const fd = new FormData();
    if (repoUrl.trim()) fd.append('repoUrl', repoUrl.trim());
    if (file) fd.append('archive', file);
    fd.append('mode', mode);

    try {
      const res = await fetch(`${API}/build`, { method: 'POST', body: fd });
      if (!res.ok) {
        const msg = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(msg);
      }
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
    if (buildId) window.open(`${API}/build/${buildId}/download`, '_blank');
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
          <a href="#" className="hover:text-white/80 transition-colors">Docs</a>
          <a href="#" className="hover:text-white/80 transition-colors">Pricing</a>
          <a href="https://github.com" className="hover:text-white/80 transition-colors">GitHub</a>
        </div>
      </nav>

      {/* Page content */}
      <div className="relative z-10 max-w-2xl mx-auto px-6 py-16 animate-fade-in">

        {/* Hero */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2 glass rounded-full px-4 py-1.5 text-xs text-white/50 mb-6 border border-white/5">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            Build service online
          </div>
          <h1 className="text-5xl font-bold leading-tight mb-4">
            Build Mobile Apps.
            <br />
            <span className="text-gradient">Instantly.</span>
          </h1>
          <p className="text-white/40 text-lg">From repo to APK in one click</p>
        </div>

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
                    : 'border-white/10 hover:border-white/25 hover:bg-white/3'
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
                        : 'border-white/8 hover:border-white/20 bg-white/3 hover:bg-white/5'
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
                <span>Elapsed: {fmtSecs(elapsed)}</span>
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
                  <p className="text-xs text-white/30">Check the logs above for details</p>
                </div>
                <button onClick={reset} className="btn-primary text-sm">
                  Try Again
                </button>
              </div>
            )}

            {phase === 'building' && (
              <button onClick={reset} className="w-full text-center text-xs text-white/20 hover:text-white/40 py-2 transition-colors">
                Cancel
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
