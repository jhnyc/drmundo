import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocket } from 'ws';

const PROJECT_ROOT = process.cwd();
const NUM_ROOMS = 50; // 100 concurrent WebSocket clients
const ACTIVE_WINDOW_MS = 10_000;
const IDLE_WINDOW_MS = 3_000;

function parsePsTimeToMs(str) {
  const s = str.trim();
  // macOS `ps -o time=` outputs `M:SS.cc` or `H:MM:SS`
  const parts = s.split(':');
  if (parts.length === 2) {
    const mins = Number(parts[0]);
    const secs = Number(parts[1]);
    return (mins * 60 + secs) * 1000;
  }
  if (parts.length === 3) {
    const hrs = Number(parts[0]);
    const mins = Number(parts[1]);
    const secs = Number(parts[2]);
    return (hrs * 3600 + mins * 60 + secs) * 1000;
  }
  return 0;
}

function sampleProcStats(pid) {
  const out = execFileSync('ps', ['-o', 'rss=,time=', '-p', String(pid)], {
    encoding: 'utf8'
  }).trim();
  const [rssStr, timeStr] = out.split(/\s+/);
  return {
    rssKb: Number(rssStr),
    cpuMs: parsePsTimeToMs(timeStr)
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function checkGzipAsset(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/three/build/three.module.js',
        headers: { 'Accept-Encoding': 'gzip' }
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            encoding: res.headers['content-encoding'] || 'none',
            wireBytes: buf.length
          });
        });
      }
    );
    req.on('error', reject);
  });
}

function startBackend(name, cmd, args, port, snapshotFile) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        ROOMS_SNAPSHOT_PATH: snapshotFile
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`${name} startup timeout`));
    }, 8000);

    proc.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('server_started')) {
        clearTimeout(timer);
        resolve(proc);
      }
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${name} exited early (${code}): ${stderr}`));
    });
  });
}

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function waitForMsg(ws, pred, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error('WS waitForMsg timeout'));
    }, timeoutMs);
    const onMsg = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (pred(msg)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(msg);
      }
    };
    ws.on('message', onMsg);
  });
}

async function benchmarkBackend({ name, cmd, args, port, binaryPath }) {
  const snapshotFile = `/tmp/drmundo-bench-${name.toLowerCase().replace(/[^a-z0-9]/g, '')}-${process.pid}.json`;
  if (fs.existsSync(snapshotFile)) fs.unlinkSync(snapshotFile);

  const proc = await startBackend(name, cmd, args, port, snapshotFile);
  const sockets = [];
  let errors = 0;

  try {
    // 1. Idle measurement
    await sleep(2000);
    const idleStart = sampleProcStats(proc.pid);
    await sleep(IDLE_WINDOW_MS);
    const idleEnd = sampleProcStats(proc.pid);
    const idleRssMb = idleEnd.rssKb / 1024;
    const idleCpuMs = Math.max(0, idleEnd.cpuMs - idleStart.cpuMs);
    const idleCpuPct = (idleCpuMs / IDLE_WINDOW_MS) * 100;

    // 2. Gzip static check
    const rawThreeSize = fs.statSync(
      path.join(PROJECT_ROOT, 'node_modules/three/build/three.module.js')
    ).size;
    const gzipCheck = await checkGzipAsset(port);
    if (gzipCheck.status !== 200 || gzipCheck.encoding !== 'gzip') {
      throw new Error(`${name} gzip static check failed: ${JSON.stringify(gzipCheck)}`);
    }

    // 3. Spin up 50 rooms (100 clients), alternating drmundo & chogath
    const wsUrl = `ws://127.0.0.1:${port}`;
    const rooms = [];
    for (let i = 0; i < NUM_ROOMS; i++) {
      const champ = i % 2 === 0 ? 'drmundo' : 'chogath';
      const ws0 = await connectWs(wsUrl);
      const ws1 = await connectWs(wsUrl);
      ws0.on('error', () => {
        errors += 1;
      });
      ws1.on('error', () => {
        errors += 1;
      });
      sockets.push(ws0, ws1);

      const joined0Promise = waitForMsg(ws0, (m) => m.type === 'joined_room');
      ws0.send(
        JSON.stringify({
          type: 'create_room',
          name: `Host${i}`,
          championId: champ,
          spells: ['flash', 'ghost'],
          withBot: false
        })
      );
      const joined0 = await joined0Promise;

      const joined1Promise = waitForMsg(ws1, (m) => m.type === 'joined_room');
      ws1.send(
        JSON.stringify({
          type: 'join_room',
          roomId: joined0.roomId,
          name: `Guest${i}`,
          spells: ['flash', 'heal']
        })
      );
      await joined1Promise;

      rooms.push({ ws0, ws1, champ, startedPlaying: false });
    }

    // Start all matches
    const playingWaiters = rooms.map((r) =>
      waitForMsg(r.ws0, (m) => m.type === 'state_snapshot' && m.state === 'playing', 6000)
    );
    for (const r of rooms) {
      r.ws0.send(JSON.stringify({ type: 'start_match' }));
    }
    await Promise.all(playingWaiters);

    // 4. Active 10s measurement window while all 50 rooms are playing
    let measuring = true;
    const snapshotIntervals = [];
    const pingRtts = [];
    let totalSnapshots = 0;

    for (const r of rooms) {
      for (const [slotIdx, ws] of [
        [0, r.ws0],
        [1, r.ws1]
      ]) {
        let lastSnapTs = 0;
        ws.on('message', (raw) => {
          if (!measuring) return;
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'state_snapshot') {
            totalSnapshots += 1;
            const now = performance.now();
            if (lastSnapTs > 0) {
              snapshotIntervals.push(now - lastSnapTs);
            }
            lastSnapTs = now;
          } else if (msg.type === 'pong' && typeof msg.t === 'number') {
            pingRtts.push(performance.now() - msg.t);
          }
        });
        ws.datasetSlot = slotIdx;
      }
    }

    let stepIdx = 0;
    const inputTimer = setInterval(() => {
      if (!measuring) return;
      stepIdx += 1;
      const angle = stepIdx * 0.6;
      for (let i = 0; i < rooms.length; i++) {
        const r = rooms[i];
        const x0 = -300 + Math.cos(angle + i) * 140;
        const z0 = -300 + Math.sin(angle + i) * 140;
        const x1 = 300 + Math.cos(angle + i) * 140;
        const z1 = 300 + Math.sin(angle + i) * 140;
        r.ws0.send(JSON.stringify({ type: 'move', x: x0, z: z0 }));
        r.ws1.send(JSON.stringify({ type: 'move', x: x1, z: z1 }));
        if (stepIdx % 2 === 0) {
          r.ws0.send(JSON.stringify({ type: 'cast_q', x: x1, z: z1 }));
          r.ws1.send(JSON.stringify({ type: 'cast_q', x: x0, z: z0 }));
        }
      }
    }, 200);

    const pingTimer = setInterval(() => {
      if (!measuring) return;
      const now = performance.now();
      for (const ws of sockets) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping', t: now }));
        }
      }
    }, 250);

    const rssSamplesKb = [];
    const rssSampler = setInterval(() => {
      try {
        rssSamplesKb.push(sampleProcStats(proc.pid).rssKb);
      } catch {}
    }, 500);

    const loadStartWall = performance.now();
    const loadStartStats = sampleProcStats(proc.pid);
    rssSamplesKb.push(loadStartStats.rssKb);

    await sleep(ACTIVE_WINDOW_MS);

    measuring = false;
    clearInterval(inputTimer);
    clearInterval(pingTimer);
    clearInterval(rssSampler);

    const loadEndStats = sampleProcStats(proc.pid);
    const loadWallMs = performance.now() - loadStartWall;
    rssSamplesKb.push(loadEndStats.rssKb);

    const loadCpuMs = Math.max(0, loadEndStats.cpuMs - loadStartStats.cpuMs);
    const loadCpuPct = (loadCpuMs / loadWallMs) * 100;
    const avgRssMb = rssSamplesKb.reduce((a, b) => a + b, 0) / rssSamplesKb.length / 1024;
    const peakRssMb = Math.max(...rssSamplesKb) / 1024;

    snapshotIntervals.sort((a, b) => a - b);
    pingRtts.sort((a, b) => a - b);

    const binarySizeMb = binaryPath
      ? fs.statSync(binaryPath).size / (1024 * 1024)
      : null;

    return {
      name,
      binarySizeMb,
      idleRssMb,
      idleCpuPct,
      avgRssMb,
      peakRssMb,
      loadCpuMs,
      loadCpuPct,
      snapP50: percentile(snapshotIntervals, 50),
      snapP95: percentile(snapshotIntervals, 95),
      snapP99: percentile(snapshotIntervals, 99),
      pingP50: percentile(pingRtts, 50),
      pingP95: percentile(pingRtts, 95),
      pingP99: percentile(pingRtts, 99),
      totalSnapshots,
      gzipRawKb: rawThreeSize / 1024,
      gzipWireKb: gzipCheck.wireBytes / 1024,
      errors
    };
  } finally {
    for (const ws of sockets) {
      try {
        ws.close();
      } catch {}
    }
    if (proc.exitCode === null) {
      proc.kill('SIGKILL');
    }
    if (fs.existsSync(snapshotFile)) fs.unlinkSync(snapshotFile);
  }
}

async function main() {
  const candidates = [
    {
      name: 'Node.js (TS)',
      cmd: 'node',
      args: [path.join(PROJECT_ROOT, 'dist/server.js')],
      port: 3410,
      binaryPath: null
    },
    {
      name: 'Go',
      cmd: path.join(PROJECT_ROOT, 'server-go/baron-pit-server'),
      args: [],
      port: 3411,
      binaryPath: path.join(PROJECT_ROOT, 'server-go/baron-pit-server')
    },
    {
      name: 'Rust',
      cmd: path.join(PROJECT_ROOT, 'server-rs/target/release/baron-pit-server'),
      args: [],
      port: 3412,
      binaryPath: path.join(PROJECT_ROOT, 'server-rs/target/release/baron-pit-server')
    }
  ].filter((c) => c.binaryPath === null || fs.existsSync(c.binaryPath));

  const results = [];
  for (const cfg of candidates) {
    console.log(`Benchmarking ${cfg.name} (${NUM_ROOMS} rooms / ${NUM_ROOMS * 2} WS clients)...`);
    const res = await benchmarkBackend(cfg);
    results.push(res);
  }

  console.log('\n=== Backend Benchmark Results (50 active rooms, 100 WS clients, 10s playing) ===\n');
  console.log(
    '| Backend | Bin Size | Idle RSS | Idle CPU | Load Avg RSS | Load Peak RSS | Load CPU Time | Avg CPU % | Snap p50/p95/p99 (ms) | Ping p50/p95/p99 (ms) | Snaps | Errors |'
  );
  console.log(
    '|---------|----------|----------|----------|--------------|---------------|---------------|-----------|------------------------|------------------------|-------|--------|'
  );
  for (const r of results) {
    const bin = r.binarySizeMb !== null ? `${r.binarySizeMb.toFixed(1)} MB` : 'N/A';
    const snap = `${r.snapP50.toFixed(1)} / ${r.snapP95.toFixed(1)} / ${r.snapP99.toFixed(1)}`;
    const ping = `${r.pingP50.toFixed(2)} / ${r.pingP95.toFixed(2)} / ${r.pingP99.toFixed(2)}`;
    console.log(
      `| ${r.name} | ${bin} | ${r.idleRssMb.toFixed(1)} MB | ${r.idleCpuPct.toFixed(2)}% | ${r.avgRssMb.toFixed(1)} MB | ${r.peakRssMb.toFixed(1)} MB | ${Math.round(r.loadCpuMs)} ms | ${r.loadCpuPct.toFixed(1)}% | ${snap} | ${ping} | ${r.totalSnapshots} | ${r.errors} |`
    );
  }
  console.log(
    `\nStatic gzip (/three/build/three.module.js): ${results[0].gzipRawKb.toFixed(1)} KB raw -> ${results[0].gzipWireKb.toFixed(1)} KB gzipped`
  );
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
