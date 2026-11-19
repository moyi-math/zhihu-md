#!/usr/bin/env node
/**
 * 知乎回答导出 —— 桌面客户端入口
 *
 *   zhihu-md.exe                          打开图形界面
 *   zhihu-md.exe <问题链接> [选项]        命令行模式
 *
 * GUI 实现：本地 HTTP 服务 + 系统 Chrome 的 --app 窗口（不引入 Electron）。
 *
 * 安全模型（本服务只给本机窗口用）：
 *   - 启动时生成一次性 token，页面地址带 ?t=<token>
 *   - 所有 /api/* 与页面本身都校验 token + Host + Origin
 *   - /api/open 只允许打开输出目录内的文件
 *   - 目标：即使本机其他网页被注入脚本，也无法通过 127.0.0.1 的随机端口驱动本程序
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findBrowser, launchBrowser } from './browser.mjs';
import {
  BASE_DIR,
  DEFAULT_PROFILE,
  DEFAULT_OUT_DIR,
  ensureLogin,
  warmUp,
  exportQuestion,
  parseQuestionId,
} from './zhihu-core.mjs';
import { markdownToPdf } from './pdf.mjs';
import { runCli } from './cli.mjs';
import { loadConfig, saveConfig, resolveOutDir } from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_DATA = BASE_DIR || path.join(os.homedir(), '.zhihu-md');
const PROFILE_DIR = DEFAULT_PROFILE || path.join(APP_DATA, 'profile');
const GUI_PROFILE_DIR = path.join(APP_DATA, 'gui-profile');
// 输出目录可在界面里改，存到 config.json；首次运行用默认值
let outDir = loadConfig().outDir || DEFAULT_OUT_DIR || path.join(os.homedir(), 'Documents', '知乎导出');
const LOCK_FILE = path.join(APP_DATA, 'instance.json');
const FALLBACK_VERSION = '1.0.1';

function appVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(assetPath('package.json'), 'utf8'));
    return pkg.version || FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}
const VERSION = appVersion();

function assetPath(name) {
  for (const base of [here, process.cwd()]) {
    const p = path.join(base, name);
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* ignore */ }
  }
  return path.join(here, name);
}

/* ------------------------------------------------------------------ 命令行模式 */

const cliArgs = process.argv.slice(2);
const wantsCli = cliArgs.length > 0 && cliArgs[0] !== '--gui' && cliArgs[0] !== '-g';

if (wantsCli) {
  await runCli(cliArgs);
} else {
  await runGui();
}

/* ------------------------------------------------------------------ GUI */

async function runGui() {
  const clients = new Set();
  const job = { running: false, logs: [], result: null, error: null };
  const TOKEN = crypto.randomBytes(16).toString('hex');

  const broadcast = (msg) => {
    const payload = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of clients) {
      try { res.write(payload); } catch { /* ignore */ }
    }
  };
  const log = (line) => {
    job.logs.push(line);
    if (job.logs.length > 500) job.logs.shift();
    broadcast({ type: 'log', line });
    console.log(line);
  };

  /** 粗判是否登录过：检查 profile 里有没有 cookie 库（真正校验在抓取时） */
  const loginHint = () => {
    for (const f of [
      path.join(PROFILE_DIR, 'Default', 'Network', 'Cookies'),
      path.join(PROFILE_DIR, 'Default', 'Cookies'),
    ]) {
      try {
        if (fs.statSync(f).size > 8192) return true;
      } catch { /* ignore */ }
    }
    return false;
  };

  async function runJob(opts) {
    if (job.running) throw new Error('已有任务在进行中，请等待完成');
    job.running = true;
    job.logs = [];
    job.result = null;
    job.error = null;
    broadcast({ type: 'state', running: true });

    let session = null;
    try {
      const qid = parseQuestionId(opts.url);
      log(`目标问题 id：${qid}`);
      session = await launchBrowser({ profileDir: PROFILE_DIR, onLog: log });
      await ensureLogin({ session, onLog: log });
      await warmUp(session.page, log);

      const out = await exportQuestion({
        session,
        qid,
        outDir,
        order: opts.order || 'default',
        limit: Math.max(0, Number(opts.limit) || 0),
        images: opts.images !== false,
        onLog: log,
      });

      await session.close();
      session = null;

      let pdfPath = null;
      if (opts.pdf) {
        log('→ 生成 PDF……');
        try {
          const p = await markdownToPdf(out.markdownPath, null, { onLog: log });
          pdfPath = p.pdfPath;
        } catch (err) {
          log(`  ! PDF 生成失败：${err.message}`);
        }
      }

      job.result = {
        title: out.title || '',
        md: out.markdownPath,
        pdf: pdfPath,
        answers: out.answers,
        images: out.imgCount,
        chars: out.chars || 0,
        note: out.note || '',
      };
      job.running = false;
      broadcast({ type: 'done', result: job.result });
    } catch (err) {
      job.running = false;
      job.error = err.message || String(err);
      broadcast({ type: 'error', message: job.error });
    } finally {
      if (session) await session.close().catch(() => { });
    }
  }

  /* ---------------- 打开文件（不经过 cmd，避免路径里的 & % ^ 被当命令） ---------------- */

  function withinOutDir(target) {
    try {
      const root = path.resolve(outDir) + path.sep;
      const p = path.resolve(String(target || ''));
      return p.startsWith(root);
    } catch {
      return false;
    }
  }

  function openTarget(type, target) {
    const resolved = path.resolve(String(target || ''));
    if (!withinOutDir(resolved)) return false;

    try {
      if (type === 'folder') {
        // /select, 后面的逗号是参数的一部分
        spawn('explorer.exe', [`/select,${resolved}`], { detached: true, stdio: 'ignore' }).unref();
        return true;
      }
      if (type === 'pdf') {
        const b = findBrowser();
        if (b) {
          // Chrome 打开 PDF（本机 .pdf 可能没有关联程序）
          spawn(b.path, [resolved], { detached: true, stdio: 'ignore' }).unref();
          return true;
        }
      }
      if (process.platform === 'win32') {
        // explorer.exe 走 ShellExecute 语义，不做命令行解析，路径含 & % ^ 也安全
        spawn('explorer.exe', [resolved], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [resolved], {
          detached: true,
          stdio: 'ignore',
        }).unref();
      }
      return true;
    } catch {
      return false;
    }
  }

  /* ---------------- 目录选择框 ---------------- */

  function pickDirectory() {
    return new Promise((resolve, reject) => {
      if (process.platform !== 'win32') {
        // 非 Windows 没有现成对话框，让用户手动填
        return resolve('');
      }
      const outFile = path.join(os.tmpdir(), `zmd-pick-${Date.now()}.txt`);
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -AssemblyName System.Drawing',
        '$owner = New-Object System.Windows.Forms.Form',
        '$owner.TopMost = $true',
        '$owner.ShowInTaskbar = $false',
        '$owner.FormBorderStyle = "None"',
        '$owner.Size = New-Object System.Drawing.Size(1,1)',
        '$owner.StartPosition = "CenterScreen"',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
        '$d.Description = "选择知乎导出的保存目录"',
        '$d.ShowNewFolderButton = $true',
        `if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [System.IO.File]::WriteAllText('${outFile}', $d.SelectedPath, [System.Text.Encoding]::UTF8) }`,
        '$owner.Dispose()',
      ].join('; ');

      const child = spawn(
        'powershell',
        ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true }
      );
      child.on('error', reject);
      child.on('close', () => {
        let picked = '';
        try {
          picked = fs.readFileSync(outFile, 'utf8').trim();
        } catch { /* 用户取消 */ }
        try { fs.unlinkSync(outFile); } catch { /* ignore */ }
        resolve(picked);
      });
    });
  }

  /* ---------------- HTTP ---------------- */

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let raw = '';
      let tooLarge = false;
      req.on('data', (c) => {
        if (tooLarge) return;
        raw += c;
        if (raw.length > 1e6) {
          tooLarge = true;
          const err = new Error('请求体过大');
          err.statusCode = 413;
          reject(err);
        }
      });
      req.on('end', () => {
        if (tooLarge) return;
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch (e) {
          const err = new Error(`请求体不是合法 JSON：${e.message}`);
          err.statusCode = 400;
          reject(err);
        }
      });
      req.on('error', reject);
    });

  const sendJson = (res, obj, code = 200) => {
    if (res.writableEnded) return;
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };

  let port = 0;

  /** token + Host + Origin 三重校验：挡住跨站请求与 DNS rebinding */
  function authorized(req) {
    const host = String(req.headers.host || '');
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;

    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
      return false;
    }

    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const given = req.headers['x-zmd-token'] || url.searchParams.get('t');
    return given === TOKEN;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (!authorized(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('403 Forbidden');
    }

    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const html = await fsp.readFile(assetPath('ui.html'));
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          // 界面会随版本更新，禁止缓存，避免用户看到旧 UI
          'cache-control': 'no-store, must-revalidate',
        });
        return res.end(html);
      }

      if (url.pathname === '/api/config') {
        return sendJson(res, {
          outDir,
          loggedIn: loginHint(),
          version: VERSION,
        });
      }

      if (url.pathname === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write(`data: ${JSON.stringify({ type: 'state', running: job.running })}\n\n`);
        for (const line of job.logs) {
          res.write(`data: ${JSON.stringify({ type: 'log', line })}\n\n`);
        }
        // 重连时补发失败状态，否则界面会永远停在「抓取中」
        if (job.error) res.write(`data: ${JSON.stringify({ type: 'error', message: job.error })}\n\n`);
        else if (job.result) res.write(`data: ${JSON.stringify({ type: 'done', result: job.result })}\n\n`);

        clients.add(res);
        lastClientSeen = Date.now();
        const ping = setInterval(() => {
          try { res.write(': ping\n\n'); } catch { /* ignore */ }
        }, 15000);
        req.on('close', () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }

      if (url.pathname === '/api/run' && req.method === 'POST') {
        const body = await readBody(req);
        if (job.running) return sendJson(res, { ok: false, error: '已有任务在进行中' });
        try {
          parseQuestionId(body.url);
        } catch (err) {
          return sendJson(res, { ok: false, error: err.message });
        }
        runJob(body).catch(() => { });
        return sendJson(res, { ok: true });
      }

      if (url.pathname === '/api/pdf' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.path || !withinOutDir(body.path) || !fs.existsSync(body.path)) {
          return sendJson(res, { ok: false, error: '文件不在输出目录内或不存在' });
        }
        try {
          const p = await markdownToPdf(body.path, null);
          return sendJson(res, { ok: true, pdf: p.pdfPath });
        } catch (err) {
          return sendJson(res, { ok: false, error: err.message || String(err) });
        }
      }

      if (url.pathname === '/api/setOutDir' && req.method === 'POST') {
        const body = await readBody(req);
        if (job.running) return sendJson(res, { ok: false, error: '抓取进行中，暂不能修改输出目录' });
        const r = resolveOutDir(body.dir);
        if (!r.ok) return sendJson(res, { ok: false, error: r.error });
        outDir = r.dir;
        saveConfig({ outDir });
        return sendJson(res, { ok: true, dir: outDir });
      }

      if (url.pathname === '/api/pickDir' && req.method === 'POST') {
        try {
          const picked = await pickDirectory();
          if (!picked) return sendJson(res, { ok: false, canceled: true });
          const r = resolveOutDir(picked);
          if (!r.ok) return sendJson(res, { ok: false, error: r.error });
          outDir = r.dir;
          saveConfig({ outDir });
          return sendJson(res, { ok: true, dir: outDir });
        } catch (err) {
          return sendJson(res, { ok: false, error: err.message || String(err) });
        }
      }

      if (url.pathname === '/api/open' && req.method === 'POST') {
        const body = await readBody(req);
        const ok = openTarget(body.type, body.path);
        return sendJson(res, ok ? { ok: true } : { ok: false, error: '路径不在输出目录内' });
      }

      res.writeHead(404);
      res.end('not found');
    } catch (err) {
      sendJson(res, { ok: false, error: err.message || String(err) }, err.statusCode || 500);
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  const pageUrl = `http://127.0.0.1:${port}/?t=${TOKEN}`;
  fs.mkdirSync(outDir, { recursive: true });

  /* ---------------- 单实例：已有实例则直接开窗口给它 ---------------- */

  const existing = await probeExistingInstance();
  if (existing) {
    console.log(`  已有实例在运行，打开其窗口：${existing.replace(/t=[0-9a-f]+/, 't=***')}`);
    openAppWindow(existing);
    await new Promise((resolve) => server.close(resolve));
    setTimeout(() => process.exit(0), 200);
    return;
  }
  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ url: pageUrl, pid: process.pid }), 'utf8');
  } catch { /* ignore */ }

  console.log('');
  console.log(`  知乎回答导出 v${VERSION}`);
  console.log('  ─────────────────────────────');
  console.log(`  界面地址: ${pageUrl.replace(/t=[0-9a-f]+/, 't=***')}`);
  console.log(`  输出目录: ${outDir}`);
  console.log(`  登录态:   ${PROFILE_DIR}`);
  console.log('');

  const found = findBrowser();
  let child = null;
  let shuttingDown = false;
  const startedAt = Date.now();
  let lastClientSeen = Date.now();

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { server.close(); } catch { /* ignore */ }
    try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
    setTimeout(() => process.exit(0), 200);
  };

  if (found) {
    console.log(`  正在用 ${found.name} 打开窗口……\n`);
    child = openAppWindow(pageUrl, found.path);
    child.on('exit', () => {
      // 注意：如果本机已有一个我们的 --app 窗口，Chrome 会把命令转发给它并让这个
      // 子进程立刻退出。所以这里不能立即 shutdown，交给下面的空闲检测决定。
      if (job.running) console.log('  窗口已关闭，当前任务会继续跑完……');
    });
    child.on('error', () => {
      console.log(`  ! 无法启动浏览器窗口，请手动打开上面的地址`);
    });
  } else {
    console.log('  ! 未找到 Chrome / Edge，请手动在浏览器打开上面的地址');
    console.log('    （抓取功能仍需安装 Chrome）\n');
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // 界面每打开/重连一次 SSE 都会刷新 lastClientSeen；窗口关掉后连接自然断开。
  // 启动后 40 秒内不判退出（给窗口加载留时间），之后连续 25 秒无连接才退出。
  setInterval(() => {
    if (shuttingDown || job.running) return;
    if (clients.size > 0) {
      lastClientSeen = Date.now();
      return;
    }
    if (Date.now() - startedAt < 40000) return;
    if (Date.now() - lastClientSeen > 25000) shutdown();
  }, 5000);
  if (!child) setInterval(() => { }, 1 << 30);

  /* ---------------- 工具 ---------------- */

  function openAppWindow(target, exePath) {
    const exe = exePath || findBrowser()?.path;
    if (!exe) throw new Error('找不到浏览器');
    fs.mkdirSync(GUI_PROFILE_DIR, { recursive: true });
    return spawn(
      exe,
      [
        `--app=${target}`,
        `--user-data-dir=${GUI_PROFILE_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1040,820',
        '--window-position=140,90',
        '--disable-features=Translate',
        '--lang=zh-CN',
      ],
      { detached: false, stdio: 'ignore' }
    );
  }

  /** 上一个实例还活着吗？活着就返回它的窗口地址（带 token） */
  async function probeExistingInstance() {
    let info;
    try {
      info = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    } catch {
      return null;
    }
    if (!info?.url) return null;
    try {
      const res = await fetch(info.url, { redirect: 'manual' });
      return res.ok ? info.url : null;
    } catch {
      return null;
    }
  }
}
