/**
 * 打包成 Windows 单文件 exe
 *   node build.mjs
 *
 * 说明：
 *  - 用 @yao-pkg/pkg 把 app.mjs 及其依赖塞进一个 Node 运行时里，产物约 60-90MB
 *  - 浏览器不打包：运行时定位系统 Chrome / Edge（抓取和 PDF 都需要真实浏览器）
 *  - ui.html / katex 字体 / package.json 作为 asset 打进 snapshot
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.chdir(here);

const target = process.env.TARGET || 'node22-win-x64';
const outFile = path.join('dist', 'zhihu-md.exe');

await fsp.mkdir('dist', { recursive: true });

// KaTeX 字体内联（pkg 的 snapshot 里 Chrome 读不到字体文件）
const { buildKatexInlineCss } = await import('./make-katex-css.mjs');
const katex = buildKatexInlineCss();
console.log(`→ KaTeX 字体已内联：${katex.inlined} 个 woff2，${katex.sizeKB} KB`);

console.log(`→ 打包 ${target} ……`);
const t0 = Date.now();

// 直接调 pkg 的 JS 入口：Node 24 起不允许无 shell 地 spawn .cmd
const pkgBin = path.join(here, 'node_modules', '@yao-pkg', 'pkg', 'lib-es5', 'bin.js');
if (!fs.existsSync(pkgBin)) {
  console.error('✖ 找不到 @yao-pkg/pkg，请先 npm i');
  process.exit(1);
}

try {
  execFileSync(
    process.execPath,
    [pkgBin, 'app.mjs', '--targets', target, '--output', outFile, '--compress', 'GZip'],
    { stdio: 'inherit', cwd: here }
  );
} catch (err) {
  console.error('\n✖ 打包失败:', err.message);
  process.exit(1);
}

if (!fs.existsSync(outFile)) {
  console.error('✖ 未生成 exe');
  process.exit(1);
}

// 附带一个隐藏控制台窗口的启动器（双击它就没有黑框）
await fsp.copyFile('launcher.vbs', path.join('dist', 'zhihu-md-launcher.vbs'));

const size = (await fsp.stat(outFile)).size;
console.log('');
console.log('✅ 打包完成');
console.log(`  文件: ${path.resolve(outFile)}`);
console.log(`  体积: ${(size / 1024 / 1024).toFixed(1)} MB`);
console.log(`  耗时: ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
console.log('');
console.log('用法:');
console.log('  双击 zhihu-md.exe                          → 图形界面');
console.log('  zhihu-md.exe <知乎链接> [--pdf] [-o 目录]   → 命令行');
