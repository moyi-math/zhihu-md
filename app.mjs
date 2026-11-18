#!/usr/bin/env node
/**
 * 知乎回答导出 —— 桌面客户端入口
 *
 *   zhihu-md.exe                          打开图形界面
 *   zhihu-md.exe <问题链接> [选项]        命令行模式
 *
 * GUI 实现：本地 HTTP 服务 + 系统 Chrome 的 --app 窗口（不额外引入 Electron）
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
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

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_DATA = BASE_DIR || path.join(os.homedir(), '.zhihu-md');
const PROFILE_DIR = DEFAULT_PROFILE || path.join(APP_DATA, 'profile');
const GUI_PROFILE_DIR = path.join(APP_DATA, 'gui-profile');
const OUT_DIR = DEFAULT_OUT_DIR || path.join(os.homedir(), 'Documents', '知乎导出');

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
  const job = { running: false, logs: [], result: null };

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
    for (const f of [path.join(PROFILE_DIR, 'Default', 'Network', 'Cookies'), path.join(PROFILE_DIR, 'Default', 'Cookies')]) {
      try {
        const st = fs.statSync(f);
        if (st.size > 8192) return true;
      } catch { /* ignore */ }
    }
    return false;
  };

  async function runJob(opts) {
    if (job.running) throw new Error('已有任务在进行中，请等待完成');
    job.running = true;
    job.logs = [];
    job.result = null;
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
        outDir: OUT_DIR,
        order: opts.order || 'default',
        limit: Number(opts.limit) || 0,
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
        md: out.markdownPath,
        pdf: pdfPath,
        answers: out.answers,
        images: out.imgCount,
        chars: out.chars || 0,
        note: '',
      };
      job.running = false;
      broadcast({ type: 'done', result: job.result });
    } catch (err) {
      job.running = false;
      broadcast({ type: 'error', message: err.message || String(err) });
    } finally {
      if (session) await session.close().catch(() => { });
    }
  }

  function openTarget(type, target) {
    if (!target) return;
    try {
      if (type === 'folder') {
        spawn('explorer', ['/select,', target], { detached: true, stdio: 'ignore' }).unref();
        return;
      }
      if (type === 'pdf') {
        const b = findBrowser();
        if (b) {
          spawn(b.path, [target], { detached: true, stdio: 'ignore' }).unref();
          return;
        }
      }
      if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } else {
        spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch { /* ignore */ }
  }

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
        if (raw.length > 1e6) req.destroy();
      });
      req.on('end', () => {
        try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
      });
      req.on('error', reject);
    });

  const sendJson = (res, obj, code = 200) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const html = await fsp.readFile(assetPath('ui.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      }

      if (url.pathname === '/api/config') {
        return sendJson(res, { outDir: OUT_DIR, loggedIn: loginHint(), version: appVersion() });
      }

      if (url.pathname === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write(`data: ${JSON.stringify({ type: 'state', running: job.running })}\n\n`);
        // 重连时补发已有日志与结果
        for (const line of job.logs) res.write(`data: ${JSON.stringify({ type: 'log', line })}\n\n`);
        if (job.result) res.write(`data: ${JSON.stringify({ type: 'done', result: job.result })}\n\n`);
        clients.add(res);
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
        try {
          const p = await markdownToPdf(body.path, null);
          return sendJson(res, { ok: true, pdf: p.pdfPath });
        } catch (err) {
          return sendJson(res, { ok: false, error: err.message || String(err) });
        }
      }

      if (url.pathname === '/api/open' && req.method === 'POST') {
        const body = await readBody(req);
        openTarget(body.type, body.path);
        return sendJson(res, { ok: true });
      }

      res.writeHead(404);
      res.end('not found');
    } catch (err) {
      sendJson(res, { ok: false, error: err.message || String(err) }, 500);
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const pageUrl = `http://127.0.0.1:${port}/`;
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('');
  console.log('  知乎回答导出');
  console.log('  ─────────────────────────────');
  console.log(`  界面地址: ${pageUrl}`);
  console.log(`  输出目录: ${OUT_DIR}`);
  console.log(`  登录态:   ${PROFILE_DIR}`);
  console.log('');

  const found = findBrowser();
  let child = null;
  let shuttingDown = false;

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { server.close(); } catch { /* ignore */ }
    setTimeout(() => process.exit(0), 200);
  };

  if (found) {
    console.log(`  正在用 ${found.name} 打开窗口……\n`);
    fs.mkdirSync(GUI_PROFILE_DIR, { recursive: true });
    child = spawn(
      found.path,
      [
        `--app=${pageUrl}`,
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
    child.on('exit', shutdown);
    child.on('error', () => {
      console.log(`  ! 无法启动浏览器窗口，请手动打开 ${pageUrl}`);
    });
  } else {
    console.log('  ! 未找到 Chrome / Edge，请手动在浏览器打开上面的地址');
    console.log('    （抓取功能仍需安装 Chrome）\n');
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  if (!child) {
    // 没有浏览器窗口时保持服务常驻，等待手动访问
    setInterval(() => { }, 1 << 30);
  }
}

function appVersion() {
  return '1.0.0';
}
