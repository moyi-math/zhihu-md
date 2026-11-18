/**
 * 构建期把 KaTeX 样式里的字体引用内联成 data URI
 *
 * 原因：打包成单文件 exe 后，字体文件位于 pkg 的 snapshot（虚拟文件系统）内，
 * Chrome 作为独立进程读不到；内联成 base64 才能保证 PDF 里公式字体正确。
 * 只内联 woff2（Chrome 首选，体积最小），woff/ttf 的引用直接删掉。
 */
import fs from 'node:fs';
import path from 'node:path';

const katexDist = path.join(process.cwd(), 'node_modules', 'katex', 'dist');
const cssPath = path.join(katexDist, 'katex.min.css');
const fontsDir = path.join(katexDist, 'fonts');
const outPath = path.join(process.cwd(), 'katex-inline.css');

/**
 * @returns {{outPath: string, inlined: number, sizeKB: number}}
 */
export function buildKatexInlineCss() {
  if (!fs.existsSync(cssPath)) {
    throw new Error(`找不到 ${cssPath}，请先 npm i katex`);
  }

  let css = fs.readFileSync(cssPath, 'utf8');
  let inlined = 0;

  // font-face 里通常是：src:url(fonts/A.woff2) format("woff2"),url(fonts/A.woff) format("woff"),...
  // 只保留 woff2 并内联，其余格式删掉
  css = css.replace(/src:\s*([^;]+);/g, (whole, srcList) => {
    const entries = srcList.split(',').map((s) => s.trim());
    const woff2 = entries.find((s) => /\.woff2/.test(s));
    if (!woff2) return whole;

    const m = woff2.match(/url\(([^)]+\.woff2)\)/);
    if (!m) return whole;
    const file = path.join(fontsDir, path.basename(m[1]));

    try {
      const buf = fs.readFileSync(file);
      inlined++;
      return `src:url(data:font/woff2;base64,${buf.toString('base64')}) format("woff2");`;
    } catch {
      return whole;
    }
  });

  // 兜底：把全文里残余的 url(fonts/...) 去掉（避免运行时 404 噪音）
  css = css.replace(/url\(fonts\/[^)]+\)(\s*format\("[^"]+"\))?,?/g, '');

  fs.writeFileSync(outPath, css, 'utf8');
  const sizeKB = Math.round(fs.statSync(outPath).size / 1024);
  return { outPath, inlined, sizeKB };
}

// 允许直接运行：node make-katex-css.mjs
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('make-katex-css.mjs')) {
  const r = buildKatexInlineCss();
  console.log(`✅ ${r.outPath}（内联 ${r.inlined} 个 woff2 字体，${r.sizeKB} KB）`);
}
