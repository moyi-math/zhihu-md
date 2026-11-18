/**
 * markdown → PDF：KaTeX 渲染公式，图片 base64 内嵌，Chrome 打印
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { findBrowser } from './browser.mjs';

const requireCjs = createRequire(import.meta.url);
const MarkdownIt = requireCjs('markdown-it');
const katex = requireCjs('katex');
const puppeteer = requireCjs('puppeteer-core');
const here = path.dirname(fileURLToPath(import.meta.url));

/** pkg 打包后资源在 snapshot 里，优先按 __dirname 找，再退回源码目录 */
function resolveAsset(rel) {
  for (const base of [here, process.cwd()]) {
    const p = path.join(base, rel);
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* ignore */ }
  }
  return path.join(here, rel);
}

function toFileUrl(p) {
  return `file:///${p.replace(/\\/g, '/').replace(/^\//, '')}`;
}

const CSS = `
:root { --ink:#1a1a1a; --muted:#666; --line:#e2e2e2; --accent:#0b6bcb; }
* { box-sizing: border-box; }
body {
  margin: 0; color: var(--ink);
  font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
  font-size: 11.2pt; line-height: 1.72; -webkit-font-smoothing: antialiased;
}
h1 { font-size: 21pt; line-height: 1.35; margin: 0 0 14pt; font-weight: 700; }
h2 { font-size: 14.5pt; margin: 22pt 0 8pt; padding-bottom: 5pt; border-bottom: 1px solid var(--line); font-weight: 650; }
h3 { font-size: 12.8pt; margin: 16pt 0 6pt; font-weight: 650; }
h4 { font-size: 11.8pt; margin: 13pt 0 5pt; font-weight: 650; }
h5, h6 { font-size: 11.2pt; margin: 11pt 0 4pt; font-weight: 650; color: #333; }
p { margin: 0 0 8pt; }
a { color: var(--accent); text-decoration: none; word-break: break-all; }
hr { border: 0; border-top: 1px solid var(--line); margin: 16pt 0; }
blockquote { margin: 8pt 0; padding: 6pt 10pt; color: #444; background: #fafafa; border-left: 3px solid #d8d8d8; border-radius: 2px; }
blockquote p { margin: 2pt 0; }
ul, ol { margin: 6pt 0 8pt; padding-left: 20pt; }
li { margin: 2pt 0; }
code { font-family: "Cascadia Mono", Consolas, monospace; font-size: .9em; background: #f3f4f6; padding: 1px 4px; border-radius: 3px; }
pre { background: #f7f8fa; border: 1px solid var(--line); border-radius: 5px; padding: 9pt 11pt; overflow-x: auto; font-size: 9.3pt; line-height: 1.55; page-break-inside: avoid; }
pre code { background: none; padding: 0; font-size: inherit; }
table { border-collapse: collapse; width: 100%; margin: 9pt 0; font-size: 10pt; page-break-inside: avoid; }
th, td { border: 1px solid var(--line); padding: 5pt 7pt; text-align: left; vertical-align: top; }
th { background: #f5f6f8; font-weight: 650; }
img { max-width: 100%; height: auto; border-radius: 4px; }
strong { font-weight: 650; }
.math-block { margin: 9pt 0; text-align: center; page-break-inside: avoid; overflow: hidden; }
.katex { font-size: 1.04em; }
.katex-display { margin: 0; }
.docmeta { margin: 0 0 16pt; padding: 10pt 12pt; background: #f8f9fb; border: 1px solid var(--line); border-radius: 6px; font-size: 9.6pt; color: #555; line-height: 1.6; word-break: break-all; }
.docmeta b { color: var(--ink); font-weight: 650; }
h1, h2, h3, h4 { page-break-after: avoid; }
blockquote, table, pre, .math-block, figure { page-break-inside: avoid; }
`;

/**
 * @param {string} mdPath 输入的 md
 * @param {string} [outPdf] 输出 pdf（默认同名 .pdf）
 */
export async function markdownToPdf(mdPath, outPdf, { onLog = () => { } } = {}) {
  const mdAbs = path.resolve(mdPath);
  const pdfAbs = path.resolve(outPdf || mdAbs.replace(/\.md$/i, '.pdf'));
  const mdDir = path.dirname(mdAbs);

  let md = await fsp.readFile(mdAbs, 'utf8');

  // front matter → 页头信息
  const front = {};
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = line.match(/^([\w_]+):\s*(.*)$/);
      if (m) front[m[1]] = m[2].replace(/^"|"$/g, '');
    }
    md = md.slice(fm[0].length);
  }

  // 公式保护
  const mathStore = [];
  let text = md.replace(/\$\$\r?\n([\s\S]*?)\r?\n\$\$/g, (_w, tex) => {
    mathStore.push({ tex, display: true });
    return `MATHBLOCKX${mathStore.length - 1}XEND`;
  });
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_w, tex) => {
    mathStore.push({ tex, display: true });
    return `MATHBLOCKX${mathStore.length - 1}XEND`;
  });
  text = text.replace(/\$([^$\n]+)\$/g, (_w, tex) => {
    mathStore.push({ tex, display: false });
    return `MATHINLINEX${mathStore.length - 1}XEND`;
  });

  // 图片内嵌（PDF 自包含）
  const missing = [];
  text = text.replace(/(!\[[^\]]*\]\()([^)\s]+)([^)]*\))/g, (whole, pre, url, post) => {
    if (/^(https?:|data:)/.test(url)) return whole;
    try {
      const file = path.resolve(mdDir, decodeURI(url));
      const buf = fs.readFileSync(file);
      const ext = path.extname(file).slice(1).toLowerCase() || 'jpg';
      const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
      return `${pre}data:${mime};base64,${buf.toString('base64')}${post}`;
    } catch {
      missing.push(url);
      return whole;
    }
  });

  const mdIt = new MarkdownIt({ html: true, linkify: true, breaks: true });
  let body = mdIt.render(text);

  const renderMath = (i) => {
    const item = mathStore[i];
    if (!item) return '';
    const html = katex.renderToString(item.tex, {
      displayMode: item.display,
      throwOnError: false,
      strict: false,
      trust: true,
    });
    return item.display ? `<div class="math-block">${html}</div>` : html;
  };

  body = body
    .replace(/<p>\s*MATHBLOCKX(\d+)XEND\s*<\/p>/g, (_w, i) => renderMath(Number(i)))
    .replace(/MATHBLOCKX(\d+)XEND/g, (_w, i) => renderMath(Number(i)))
    .replace(/MATHINLINEX(\d+)XEND/g, (_w, i) => renderMath(Number(i)));

  // KaTeX 样式：优先用构建期把字体内联成 data URI 的版本，
  // 否则字体指向 snapshot 内的文件，Chrome 作为外部进程读不到
  let katexCss = '';
  try {
    katexCss = await fsp.readFile(resolveAsset('katex-inline.css'), 'utf8');
  } catch {
    try {
      const katexDist = path.dirname(requireCjs.resolve('katex'));
      katexCss = await fsp.readFile(path.join(katexDist, 'katex.min.css'), 'utf8');
      katexCss = katexCss.replace(/url\(fonts\//g, `url(${toFileUrl(path.join(katexDist, 'fonts'))}/`);
    } catch {
      onLog('  ! KaTeX 样式未加载，公式会退化为纯文本');
    }
  }

  const metaBits = [];
  if (front.source) metaBits.push(`<b>原文：</b><a href="${front.source}">${front.source}</a>`);
  if (front.answer_count) metaBits.push(`<b>回答数：</b>${front.answer_count}`);
  if (front.fetched_at) metaBits.push(`<b>抓取时间：</b>${front.fetched_at}`);
  const metaHtml = metaBits.length ? `<div class="docmeta">${metaBits.join(' &nbsp;·&nbsp; ')}</div>` : '';

  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${(front.title || path.basename(mdAbs, '.md')).replace(/</g, '&lt;')}</title>
<style>${katexCss}</style><style>${CSS}</style></head><body>
${metaHtml}${body}</body></html>`;

  const htmlPath = path.join(mdDir, `.preview-${Date.now()}.html`);
  await fsp.writeFile(htmlPath, html, 'utf8');

  const found = findBrowser();
  if (!found) throw new Error('没找到 Chrome / Edge，无法生成 PDF');

  const browser = await puppeteer.launch({
    executablePath: found.path,
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check'],
    protocolTimeout: 120000,
  });
  try {
    const page = await browser.newPage();
    await page.goto(`file:///${htmlPath.replace(/\\/g, '/')}`, { waitUntil: 'load', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 1200));

    await page.pdf({
      path: pdfAbs,
      format: 'A4',
      printBackground: true,
      margin: { top: '16mm', right: '15mm', bottom: '16mm', left: '15mm' },
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate:
        '<div style="font-size:7.5pt;color:#999;width:100%;padding:0 15mm;display:flex;justify-content:space-between;">' +
        `<span>${(front.title || '').slice(0, 40).replace(/</g, '&lt;')}</span>` +
        '<span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
    });
  } finally {
    await browser.close().catch(() => { });
    await fsp.unlink(htmlPath).catch(() => { });
  }

  const size = (await fsp.stat(pdfAbs)).size;
  onLog(`  PDF：${pdfAbs}（${(size / 1024).toFixed(0)} KB，公式 ${mathStore.filter((m) => m.display).length} 块）`);
  if (missing.length) onLog(`  ! ${missing.length} 张图片缺失`);

  return { pdfPath: pdfAbs, size };
}
