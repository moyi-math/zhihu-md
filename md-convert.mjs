/**
 * 知乎 HTML → Markdown 转换层（可独立单测）
 *
 * 处理重点：
 *  - 公式：<img eeimg src=".../equation?tex=..."> 与 <span class="ztext-math" data-tex="...">
 *    统一还原成 $LaTeX$ / $$LaTeX$$，而不是留一堆图片
 *  - 图片：优先取 data-original / data-actualsrc（懒加载），<noscript> 里的真图提升出来
 *  - 外链：还原 link.zhihu.com/?target=... 跳转
 *  - 标题：整体降级，避免和文档结构冲突
 */
import { createRequire } from 'node:module';

// 统一用 require 加载 CJS 依赖：打包成 exe 后（ESM→CJS）default import 会变成 undefined
const requireCjs = createRequire(import.meta.url);
const TurndownService = requireCjs('turndown');
const { gfm } = requireCjs('turndown-plugin-gfm');

const MATH_OPEN = '\uE000';
const MATH_CLOSE = '\uE001';
let mathStore = [];

export const HEADING_OFFSET = 1; // 文档用 #/##，回答内标题最低 ###

function resetMath() {
  mathStore = [];
}

/**
 * 这些命令在 textstyle 下会明显变形：分式压扁、积分/求和号缩小、
 * 上下限被挤到右边、binom 退化成小括号。只有含它们的行内公式才值得加 displaystyle。
 */
const DISPLAY_SENSITIVE = new RegExp(
  '\\\\(' +
    [
      'frac', 'dfrac', 'tfrac',
      'int', 'iint', 'iiint', 'oint',
      'sum', 'prod', 'coprod',
      'lim', 'limsup', 'liminf',
      'binom', 'dbinom', 'tbinom',
      'over', 'choose', 'atop',
    ].join('|') +
    // 用负向先行断言而不是 \b：\int_0、\sum_{n} 里命令后紧跟的是单词字符（下划线），
    // \b 在这些位置不成立，会漏掉最简单的积分/求和使用场景
    ')(?![a-zA-Z])'
);

/**
 * 行内公式默认按 textstyle 排（分式压扁、积分号缩小、上下限挤在右边），
 * 知乎上的式子大多按「独立公式」的写法，行内排出来会很难看。
 * 所以对含分式/积分/求和等命令的行内公式加 \displaystyle；纯符号（$t$、$x\in\mathbb Z$）
 * 保持原样，避免无谓撑高行距、也让 md 文件更干净。
 * 块级公式（$$…$$）本身就是 displaystyle，不需要加。
 */
function withDisplayStyle(tex) {
  const body = String(tex || '').trim();
  if (!body) return body;
  // 已经手动指定过，或是自带排版的环境（aligned / cases / matrix…），不要重复加
  if (/\\displaystyle/.test(body)) return body;
  if (/^\\begin\{/.test(body)) return body;
  if (!DISPLAY_SENSITIVE.test(body)) return body;
  return `\\displaystyle ${body}`;
}

function pushMath(tex, display = false) {
  const body = display ? String(tex || '').trim() : withDisplayStyle(tex);
  const idx = mathStore.push(display ? `$$\n${body}\n$$` : `$${body}$`) - 1;
  return `${MATH_OPEN}${idx}${MATH_CLOSE}`;
}

export function unescapeEntities(s) {
  return String(s || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

export function attr(tag, name) {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`, 'i');
  const m = tag.match(re);
  return m ? m[1] : '';
}

/** 知乎公式 URL 里的 tex：`+` 代表空格，需要还原 */
function decodeTex(raw) {
  let tex = unescapeEntities(raw).replace(/\+/g, ' ');
  try {
    tex = decodeURIComponent(tex);
  } catch {
    tex = tex.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return tex;
}

/** 协议相对地址 //pic1.zhimg.com/... 补成 https:// */
function normalizeUrl(u) {
  const v = String(u || '').trim();
  if (v.startsWith('//')) return `https:${v}`;
  return v;
}

export function collectImages(html) {
  const images = [];
  const re = /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  let m;
  while ((m = re.exec(html || ''))) {
    const tag = m[0];
    const src = attr(tag, 'data-original') || attr(tag, 'data-actualsrc') || attr(tag, 'src');
    if (!src || src.startsWith('data:')) continue;
    const aliases = ['data-original', 'data-actualsrc', 'src']
      .map((name) => attr(tag, name))
      .filter(Boolean)
      .map((v) => normalizeUrl(unescapeEntities(v)));
    images.push({
      tag,
      url: normalizeUrl(unescapeEntities(src)),
      caption: unescapeEntities(attr(tag, 'data-caption') || attr(tag, 'alt')),
      aliases: [...new Set(aliases)],
    });
  }
  return images;
}

export function replaceImgTags(html, replacements) {
  let out = html;
  for (const { tag, newTag } of replacements) {
    if (tag !== newTag) out = out.split(tag).join(newTag);
  }
  return out;
}

/** 公式 → 占位符；外链跳转解码；清理无用标签 */
export function preprocess(html) {
  let h = html || '';

  h = h.replace(/<script[\s\S]*?<\/script>/gi, '');
  h = h.replace(/<style[\s\S]*?<\/style>/gi, '');

  // <noscript> 里常是懒加载前的真图，有 img 就提升出来
  h = h.replace(/<noscript\b[^>]*>([\s\S]*?)<\/noscript>/gi, (_w, inner) =>
    /<img\b/i.test(inner) ? inner : ''
  );

  // 知乎公式 <img eeimg="1|2" src=".../equation?tex=...">
  h = h.replace(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, (tag) => {
    const src = unescapeEntities(attr(tag, 'src'));
    const isEquation = /\/equation\?/.test(src);
    const texAttr = attr(tag, 'data-tex') || attr(tag, 'data-formula') || attr(tag, 'alt');
    const eeimg = attr(tag, 'eeimg') || attr(tag, 'data-eeimg');

    if (isEquation) {
      const m = src.match(/[?&]tex=([^&"]*)/);
      const texRaw = m ? m[1] : '';
      const tex = decodeTex(texRaw) || unescapeEntities(texAttr);
      const inlineParam = /[?&]inline=(true|1)/.test(src);
      const display = eeimg === '2' || (!inlineParam && /[?&]inline=(false|0)/.test(src));
      if (tex) return pushMath(tex, display);
      return '';
    }

    // 带 data-tex 的数学图（旧版）
    const tex = attr(tag, 'data-tex') || attr(tag, 'data-formula');
    if (tex) return pushMath(unescapeEntities(tex), /[?&]inline=(?:false|0)/.test(src));
    return tag;
  });

  // 新版公式 <span class="ztext-math" data-tex="...">（服务端渲染通常为空）
  h = h.replace(
    // 非贪婪：服务端渲染的 ztext-math 内部为空，贪婪匹配会吞掉后面所有内容
    /<span\b(?:[^>"']|"[^"]*"|'[^']*')*class="[^"]*ztext-math[^"]*"(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/span>/gi,
    (whole) => {
      // 开始标签也要按引号解析：data-tex 里可能有 >（例如 |t|>1）
      const openMatch = whole.match(/^<span\b(?:[^>"']|"[^"]*"|'[^']*')*>/);
      const open = openMatch ? openMatch[0] : whole.slice(0, whole.indexOf('>') + 1);
      const tex = attr(open, 'data-tex');
      if (!tex) return whole;
      const display = attr(open, 'data-eeimg') === '2';
      return pushMath(unescapeEntities(tex), display);
    }
  );

  // 外链跳转 / 协议相对链接
  h = h.replace(/href\s*=\s*"([^"]*)"/gi, (whole, href) => {
    const real = unescapeEntities(href);
    const m = real.match(/link\.zhihu\.com\/?\?target=([^&"']+)/);
    if (m) {
      try {
        return `href="${decodeURIComponent(m[1]).replace(/"/g, '&quot;')}"`;
      } catch {
        return whole;
      }
    }
    if (real.startsWith('//')) return `href="https:${real}"`;
    return whole;
  });

  return h;
}

function createTurndown() {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    fence: '```',
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**',
    hr: '---',
  });
  td.use(gfm);
  td.remove(['script', 'style', 'svg', 'button', 'noscript']);

  td.addRule('heading', {
    filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    replacement: (content, node) => {
      const raw = Number(node.nodeName.charAt(1));
      const level = Math.min(6, Math.max(3, raw + HEADING_OFFSET));
      const text = content.trim();
      return text ? `\n\n${'#'.repeat(level)} ${text}\n\n` : '';
    },
  });

  td.addRule('figure', {
    filter: 'figure',
    replacement: (content) => (content.trim() ? `\n\n${content.trim()}\n\n` : ''),
  });

  td.addRule('img', {
    filter: 'img',
    replacement: (_c, node) => {
      // 知乎正文图常见 src="data:image/svg+xml..." 占位，真实地址在 data-original
      const raw =
        node.getAttribute('data-original') ||
        node.getAttribute('data-actualsrc') ||
        node.getAttribute('src') ||
        '';
      const src = normalizeUrl(raw);
      if (!src || src.startsWith('data:')) return '';
      const alt = (node.getAttribute('alt') || node.getAttribute('data-caption') || '').replace(/[[\]]/g, '');
      const title = node.getAttribute('title') || '';
      return `![${alt}](${src}${title ? ` "${title.replace(/"/g, "'")}"` : ''})`;
    },
  });

  td.addRule('strikethrough', {
    filter: ['del', 's', 'strike'],
    replacement: (content) => {
      const text = content.trim();
      return text ? `~~${text}~~` : '';
    },
  });

  td.addRule('codeBlock', {
    filter: (node) => node.nodeName === 'PRE',
    replacement: (_c, node) => {
      const codeEl = node.firstChild && node.firstChild.nodeName === 'CODE' ? node.firstChild : node;
      const raw = (codeEl.textContent || '').replace(/\n+$/, '');
      const cls = `${codeEl.getAttribute?.('class') || ''} ${node.getAttribute('class') || ''}`;
      const lang = node.getAttribute('lang') || (cls.match(/(?:language|lang)-([\w+#.-]+)/) || [])[1] || '';
      return `\n\n\`\`\`${lang}\n${raw}\n\`\`\`\n\n`;
    },
  });

  return td;
}

/** 完整转换：先抽公式与清理，再 turndown，最后还原公式占位符 */
export function htmlToMarkdown(html) {
  resetMath();
  const body = preprocess(html);
  let md = createTurndown().turndown(body);
  // 把正文里的字面 $ 转义成 \$（此时公式还是占位符，不会被误伤），
  // 否则下游渲染器会把「运费 $100，原价 $120」当成行内公式。
  // 代码段里的 $ 不转义：代码内容不经过 markdown 转义，加了反斜杠反而会显示出来。
  md = md
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((seg, i) => (i % 2 === 1 ? seg : seg.replace(/\$/g, '\\$')))
    .join('');
  md = md
    .replace(new RegExp(`${MATH_OPEN}(\\d+)${MATH_CLOSE}`, 'g'), (_m, i) => mathStore[Number(i)] ?? '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return md;
}

/** 把图片地址换成本地路径（图片已下载时） */
export function localizeImages(html, imgMap) {
  const imgs = collectImages(html);
  return replaceImgTags(
    html,
    imgs.map(({ tag, url, caption }) => {
      const local = imgMap.get(url);
      if (!local) return { tag, newTag: tag };
      return { tag, newTag: `<img src="${local}" alt="${caption.replace(/"/g, "'")}">` };
    })
  );
}
