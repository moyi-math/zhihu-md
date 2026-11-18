/**
 * 浏览器层：定位系统 Chrome / Edge，用 puppeteer-core 启动，并提供图片下载
 * 用 puppeteer-core 而不是 playwright，是因为它没有 driver 子进程，能整包进 exe
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
const puppeteer = requireCjs('puppeteer-core');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 常见安装路径 + 注册表，找本机 Chrome（找不到退回 Edge） */
export function findBrowser() {
  const candidates = [];
  const add = (p) => p && candidates.push(p);

  add(process.env.CHROME_PATH);
  add('C:/Program Files/Google/Chrome/Application/chrome.exe');
  add('C:/Program Files (x86)/Google/Chrome/Application/chrome.exe');
  add(process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'));
  add(process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'));
  add(process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'));

  // 注册表里 App Paths 兜底（Chrome 装在非默认位置时）
  if (process.platform === 'win32') {
    for (const exe of ['chrome.exe', 'msedge.exe']) {
      try {
        const out = execFileSync(
          'reg',
          ['query', `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, '/ve'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 }
        );
        const m = out.match(/REG_SZ\s+(.+\.exe)/i);
        if (m) add(m[1].trim().replace(/^"|"$/g, ''));
      } catch { /* 没有就算了 */ }
    }
  }

  add('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
  add('C:/Program Files/Microsoft/Edge/Application/msedge.exe');
  if (process.platform === 'darwin') {
    add('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    add('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  }
  add('/usr/bin/google-chrome');
  add('/usr/bin/chromium');

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return { path: p, name: path.basename(p).replace('.exe', '') };
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * 启动持久化浏览器（登录态保存在 userDataDir）
 * @returns {{browser, page, cookiesHeader: () => Promise<string>, ua: () => string, close: () => Promise<void>}}
 */
export async function launchBrowser({ profileDir, headless = false, width = 1400, height = 950, onLog = () => { } }) {
  const found = findBrowser();
  if (!found) {
    throw new Error('没找到 Chrome / Edge。请先安装 Google Chrome 后重试。');
  }
  onLog(`浏览器: ${found.name} (${found.path})`);

  fs.mkdirSync(profileDir, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: found.path,
    userDataDir: profileDir,
    headless,
    defaultViewport: { width, height },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,AcceptCHFrame',
      '--lang=zh-CN',
    ],
    protocolTimeout: 120000,
  });

  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());
  await page.evaluateOnNewDocument(
    "try { Object.defineProperty(navigator, 'webdriver', { get: function () { return undefined; } }); } catch (e) {}"
  ).catch(() => { });

  const cookiesHeader = async (url = 'https://www.zhihu.com') => {
    try {
      const list = await browser.cookies(url);
      return list.map((c) => `${c.name}=${c.value}`).join('; ');
    } catch {
      return '';
    }
  };

  let cachedUa = '';
  const ua = async () => {
    if (cachedUa) return cachedUa;
    try {
      cachedUa = await page.evaluate('navigator.userAgent');
    } catch {
      cachedUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    }
    return cachedUa;
  };

  const hasLogin = async () => {
    try {
      const list = await browser.cookies('https://www.zhihu.com');
      return list.some((c) => c.name === 'z_c0' && c.value);
    } catch {
      return false;
    }
  };

  return {
    browser,
    page,
    cookiesHeader,
    ua,
    hasLogin,
    info: found,
    close: async () => {
      try { await browser.close(); } catch { /* ignore */ }
    },
  };
}

/** 下载单张图片（Node 侧发请求，带 Referer，绕开页面里的 CORS 限制） */
export async function fetchImageBuffer(url, { cookie = '', userAgent = '' } = {}) {
  const targets = [url];
  const stripped = url.replace(/\/(\d{2,3}|_[\w-]+)(\/v\d?-)/, '$2');
  if (stripped !== url) targets.push(stripped);

  for (const target of targets) {
    try {
      const res = await fetch(target, {
        headers: {
          referer: 'https://www.zhihu.com/',
          accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9',
          ...(cookie ? { cookie } : {}),
          ...(userAgent ? { 'user-agent': userAgent } : {}),
        },
        redirect: 'follow',
      });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 200) continue;
      return { buffer: buf, contentType: res.headers.get('content-type') || '', url: target };
    } catch { /* 试下一个候选 */ }
  }
  return null;
}
