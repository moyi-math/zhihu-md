/**
 * 命令行模式：node app.mjs <链接> [选项]  （打包后：zhihu-md.exe <链接> [选项]）
 */
import path from 'node:path';
import os from 'node:os';
import { launchBrowser, findBrowser } from './browser.mjs';
import {
  ensureLogin,
  warmUp,
  exportQuestion,
  parseQuestionId,
  DEFAULT_PROFILE,
  DEFAULT_OUT_DIR,
} from './zhihu-core.mjs';
import { markdownToPdf } from './pdf.mjs';

export const HELP = `
知乎回答导出（命令行）

  zhihu-md <知乎问题链接|问题 id> [选项]

  -o, --out <dir>     输出目录（默认 ~/Documents/知乎导出）
  --order <mode>      default | updated | created（默认 default）
  --limit <n>         最多抓 n 条回答（默认全部）
  --no-images         不下载图片，保留知乎原链接
  --pdf               额外生成 PDF
  --headless          无头模式（已登录时可用，知乎对无头较敏感）
  --profile <dir>     登录态目录（默认 %LOCALAPPDATA%\\zhihu-md\\profile）
  --max-scroll <n>    滚动加载次数上限（默认 500）
  -h, --help          显示帮助

不带任何参数运行则打开图形界面。
`;

function parseArgs(argv) {
  const args = {
    input: null,
    out: DEFAULT_OUT_DIR,
    order: 'default',
    limit: 0,
    images: true,
    pdf: false,
    headless: false,
    maxScroll: 500,
    profile: DEFAULT_PROFILE,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-o':
      case '--out': args.out = argv[++i]; break;
      case '--order': args.order = argv[++i]; break;
      case '--limit': args.limit = Number(argv[++i]) || 0; break;
      case '--no-images': args.images = false; break;
      case '--pdf': args.pdf = true; break;
      case '--headless': args.headless = true; break;
      case '--profile': args.profile = argv[++i]; break;
      case '--max-scroll': args.maxScroll = Number(argv[++i]) || 500; break;
      case '-h':
      case '--help': console.log(HELP); process.exit(0); break;
      default:
        if (a.startsWith('-')) throw new Error(`未知参数: ${a}`);
        args.input = a;
    }
  }
  if (!args.input) {
    console.log(HELP);
    process.exit(1);
  }
  if (args.order && !['default', 'updated', 'created'].includes(args.order)) {
    throw new Error(`--order 只支持 default / updated / created，收到：${args.order}`);
  }
  return args;
}

export async function runCli(argv) {
  const args = parseArgs(argv);
  const log = (line) => console.log(line);

  const found = findBrowser();
  if (!found) {
    console.error('\n✖ 没找到 Chrome 或 Edge，请先安装 Google Chrome。\n');
    process.exit(1);
  }

  let qid;
  try {
    qid = parseQuestionId(args.input);
  } catch (err) {
    console.error(`\n✖ ${err.message}\n`);
    process.exit(1);
  }

  let session = null;
  try {
    session = await launchBrowser({
      profileDir: args.profile,
      headless: args.headless,
      onLog: log,
    });

    await ensureLogin({ session, onLog: log });
    await warmUp(session.page, log);

    const out = await exportQuestion({
      session,
      qid,
      outDir: args.out,
      order: args.order,
      limit: args.limit,
      images: args.images,
      maxScroll: args.maxScroll,
      onLog: log,
    });

    await session.close();
    session = null;

    if (args.pdf) {
      log('→ 生成 PDF……');
      await markdownToPdf(out.markdownPath, null, { onLog: log });
    }
  } catch (err) {
    console.error(`\n✖ 执行失败：${err.message}\n`);
    process.exitCode = 1;
  } finally {
    if (session) await session.close().catch(() => { });
  }
}
