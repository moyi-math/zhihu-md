/**
 * 抓取核心：SSR + 页面接口拦截 + 滚动加载 + 图片本地化 + markdown 组装
 * 与 UI 无关，CLI 和 GUI 都调用这里
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { collectImages, htmlToMarkdown } from './md-convert.mjs';
import { fetchImageBuffer, sleep } from './browser.mjs';

/** 应用数据目录（登录态等） */
export const BASE_DIR = path.join(
  process.env.LOCALAPPDATA || process.env.HOME || process.env.USERPROFILE || '.',
  'zhihu-md'
);

/** 默认输出目录 */
export const DEFAULT_OUT_DIR = path.join(os.homedir(), 'Documents', '知乎导出');

/** 沿用旧版 playwright 时代已登录的 profile，避免重复扫码 */
const LEGACY_PROFILE = path.join(os.homedir(), '.zhihu-md', 'profile');
export const DEFAULT_PROFILE = fs.existsSync(LEGACY_PROFILE)
  ? LEGACY_PROFILE
  : path.join(BASE_DIR, 'profile');

/* ------------------------------------------------------------------ 解析 */

export function parseQuestionId(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('请提供知乎问题链接或问题 id');
  if (/^\d{6,}$/.test(s)) return s;
  const m = s.match(/zhihu\.com\/question\/(\d+)/) || s.match(/[?&]q(?:uestion)?[_=]?(\d{6,})/);
  if (m) return m[1];
  throw new Error(`无法从输入中解析出问题 id：${input}`);
}

function normalizeAnswer(raw) {
  if (!raw) return null;
  const id = raw.id != null ? String(raw.id) : (raw.url || '').match(/answer\/(\d+)/)?.[1];
  const content = raw.content ?? raw.excerpt ?? '';
  if (!id || !content) return null;
  const author = raw.author || {};
  return {
    id,
    content,
    voteup: raw.voteup_count ?? raw.voteupCount ?? 0,
    comments: raw.comment_count ?? raw.commentCount ?? 0,
    created: raw.created_time ?? raw.createdTime ?? 0,
    updated: raw.updated_time ?? raw.updatedTime ?? 0,
    author: {
      name: author.name || '匿名用户',
      headline: (author.headline || '').trim(),
      token: author.url_token ?? author.urlToken ?? '',
    },
  };
}

function normalizeQuestion(q, qid) {
  if (!q) {
    return { id: qid, title: '', detail: '', answer_count: null, follower_count: null, visit_count: null, collapsed: 0 };
  }
  return {
    id: qid,
    title: q.title || '',
    detail: q.detail || '',
    answer_count: q.answer_count ?? q.answerCount ?? null,
    follower_count: q.follower_count ?? q.followerCount ?? null,
    visit_count: q.visit_count ?? q.visitCount ?? null,
    collapsed: q.collapsedAnswerCount ?? q.collapsed_answer_count ?? 0,
  };
}

/* ------------------------------------------------------------------ 登录 / 预热 */

export async function ensureLogin({ session, timeoutMs = 5 * 60 * 1000, onLog = () => { } }) {
  if (await session.hasLogin()) {
    onLog('✓ 已复用本地登录态');
    return true;
  }
  onLog('→ 未检测到登录态，正在打开知乎登录页……');
  await session.page.goto('https://www.zhihu.com/signin', { waitUntil: 'domcontentloaded', timeout: 60000 });
  onLog('→ 请在浏览器窗口中扫码登录（5 分钟内有效）……');

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await session.hasLogin()) {
      onLog('✓ 登录成功，登录态已保存');
      await sleep(1200);
      return true;
    }
    await sleep(1500);
  }
  throw new Error('登录超时（5 分钟）。请重新运行后及时扫码。');
}

export async function warmUp(page, onLog = () => { }) {
  onLog('→ 预热浏览器会话……');
  try {
    await page.goto('https://www.zhihu.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(1800 + Math.random() * 1000);
    await page.evaluate('window.scrollBy(0, 700);');
    await sleep(1000 + Math.random() * 700);
  } catch {
    onLog('  (预热跳过)');
  }
}

/* ------------------------------------------------------------------ 读取 */

function initialScript(qid) {
  return `(() => {
  const qid = ${JSON.stringify(String(qid))};
  const el = document.getElementById('js-initialData');
  if (!el || !el.textContent) return null;
  let st;
  try {
    st = JSON.parse(el.textContent).initialState || {};
  } catch (e) {
    return null;
  }
  const ents = st.entities || {};
  const question = (ents.questions && (ents.questions[qid] || Object.values(ents.questions)[0])) || null;
  const answers = Object.values(ents.answers || {});
  const feed = (st.question && st.question.answers && st.question.answers[qid]) || null;
  return {
    question: question,
    answers: answers,
    drained: !!(feed && feed.isDrained),
    idCount: ((feed && feed.ids) || []).length,
    blocked: !question,
  };
})()`;
}

async function readInitialData(page, qid) {
  return page.evaluate(initialScript(qid));
}

const READ_DOM_SCRIPT = `(() => {
  const list = Array.prototype.slice.call(document.querySelectorAll('.AnswerItem'));
  return list.map(function (el) {
    var zop = {};
    try {
      zop = JSON.parse(el.getAttribute('data-zop') || '{}');
    } catch (e) { zop = {}; }
    var rich = el.querySelector('.RichText');
    var voteEl = el.querySelector('.VoteButton--up');
    var vote = ((voteEl && voteEl.innerText) || '').replace(/[^0-9]/g, '');
    var nameEl = el.querySelector('.AuthorInfo-name');
    return {
      id: zop.itemId ? String(zop.itemId) : '',
      content: (rich && rich.innerHTML) || '',
      voteupCount: Number(vote) || 0,
      author: { name: (nameEl && nameEl.innerText && nameEl.innerText.trim()) || '匿名用户' },
      created_time: 0,
      updated_time: 0,
      comment_count: null,
    };
  }).filter(function (a) { return a.id && a.content; });
})()`;

async function readAnswersFromDom(page) {
  return page.evaluate(READ_DOM_SCRIPT);
}

/* ------------------------------------------------------------------ 抓取 */

export async function crawlQuestion(page, qid, { order = 'default', limit = 0, maxScroll = 500, onLog = () => { } } = {}) {
  const store = new Map();
  const state = { isEnd: false, question: null, apiPages: 0 };
  const inflight = [];

  const absorb = (list) => {
    for (const raw of list || []) {
      const a = normalizeAnswer(raw);
      if (!a) continue;
      const old = store.get(a.id);
      if (!old || a.content.length > old.content.length) store.set(a.id, a);
    }
  };

  page.on('response', (res) => {
    if (!/\/api\/v4\/questions\/\d+\/answers/.test(res.url())) return;
    const p = res
      .json()
      .then((j) => {
        state.apiPages += 1;
        absorb(j?.data);
        if (j?.paging?.is_end) state.isEnd = true;
      })
      .catch(() => { });
    inflight.push(p);
  });

  const sortQuery = order === 'updated' ? '?sort=updated' : order === 'created' ? '?sort=created' : '';
  const url = `https://www.zhihu.com/question/${qid}${sortQuery}`;
  onLog(`→ 打开 ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  try {
    await page.waitForSelector('.AnswerItem, .QuestionRichText, h1', { timeout: 20000 });
  } catch { /* 继续 */ }
  await sleep(1500);

  const ssr = await readInitialData(page, qid);
  if (ssr) {
    state.question = ssr.question;
    absorb(ssr.answers);
    if (ssr.question?.title) onLog(`  标题：${ssr.question.title}`);
    const cnt = ssr.question?.answerCount ?? ssr.question?.answer_count;
    if (cnt != null) onLog(`  共 ${cnt} 个回答，首屏 ${ssr.idCount} 条`);
  }

  const declaredTotal = state.question?.answerCount ?? state.question?.answer_count ?? null;
  onLog(`→ 滚动加载全部回答${declaredTotal != null ? `（目标 ${declaredTotal} 条）` : ''}`);
  let idle = 0;
  let scrolls = 0;
  let progress = store.size;

  while (!state.isEnd && scrolls < maxScroll) {
    if (limit && store.size >= limit) break;
    if (declaredTotal != null && progress >= declaredTotal) break;

    await page.evaluate('window.scrollTo(0, document.body.scrollHeight); window.scrollBy(0, -300);');
    await sleep(1200 + Math.random() * 700);
    await Promise.all(inflight.splice(0));

    const domCount = await page
      .evaluate("document.querySelectorAll('.AnswerItem').length")
      .catch(() => 0);
    const now = Math.max(store.size, domCount);
    scrolls++;
    onLog(`  已渲染 ${domCount} 条 / 已提取 ${store.size} 条（滚动 ${scrolls} 次）`);

    if (now > progress) {
      progress = now;
      idle = 0;
    } else {
      idle++;
    }
    if (idle >= 6) break;
  }
  await Promise.all(inflight);

  if (!store.size) {
    onLog('→ 接口与 SSR 均无数据，改用 DOM 提取……');
    absorb(await readAnswersFromDom(page));
  } else {
    const domAnswers = await readAnswersFromDom(page);
    if (domAnswers.length > store.size) absorb(domAnswers);
  }

  if (!state.question) {
    const again = await readInitialData(page, qid).catch(() => null);
    state.question = again?.question ?? null;
  }

  const all = [...store.values()].sort((a, b) => b.voteup - a.voteup);
  const collapsedCount = state.question?.collapsedAnswerCount ?? state.question?.collapsed_answer_count ?? 0;
  const covered = declaredTotal == null || declaredTotal - all.length <= collapsedCount;
  const isEnd = state.isEnd || covered;

  if (!all.length) {
    throw new Error(
      '没有抓到任何回答。可能原因：登录态失效、被知乎临时限流、或该问题确实没有回答。'
    );
  }

  return {
    question: normalizeQuestion(state.question, qid),
    answers: limit ? all.slice(0, limit) : all,
    isEnd,
    declaredTotal,
    collapsedCount,
  };
}

/* ------------------------------------------------------------------ 图片 */

function extFromUrlOrType(url, contentType) {
  const clean = url.split('?')[0];
  const m = clean.match(/\.(jpe?g|png|gif|webp|svg|bmp)$/i);
  if (m) return `.${m[1].toLowerCase().replace('jpeg', 'jpg')}`;
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('svg')) return '.svg';
  if (ct.includes('gif')) return '.gif';
  if (ct.includes('webp')) return '.webp';
  if (ct.includes('png')) return '.png';
  return '.jpg';
}

export function imageKeys(url) {
  const keys = new Set([url, url.split('?')[0]]);
  for (const k of [...keys]) {
    keys.add(k.replace(/_\d+w\./, '.').replace(/_\d+x\d+\./, '.'));
  }
  return [...keys];
}

async function downloadImages(urls, assetsDir, assetsRel, { cookie, userAgent, onLog }) {
  const map = new Map();
  const queue = [...new Set(urls)].filter(Boolean);
  if (!queue.length) return map;
  fs.mkdirSync(assetsDir, { recursive: true });

  let done = 0;
  let failed = 0;
  for (const url of queue) {
    const got = await fetchImageBuffer(url, { cookie: await cookie(), userAgent: await userAgent() });
    if (got) {
      const name = crypto.createHash('sha1').update(url).digest('hex').slice(0, 12) + extFromUrlOrType(got.url, got.contentType);
      await fsp.writeFile(path.join(assetsDir, name), got.buffer);
      map.set(url, `${assetsRel}/${name}`);
    } else {
      failed++;
    }
    done++;
    if (done % 5 === 0 || done === queue.length) onLog(`  图片 ${done}/${queue.length}`);
  }
  if (failed) onLog(`  ! ${failed} 张图片下载失败，已保留原链接`);
  return map;
}

/* ------------------------------------------------------------------ markdown */

function sanitizeFilename(name) {
  return (
    String(name)
      .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'zhihu-question'
  );
}

function fmtDate(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function rewriteImageUrls(md, imgMap) {
  return md.replace(/(!\[[^\]]*\]\()([^)\s]+)/g, (whole, pre, url) => {
    for (const key of imageKeys(url)) {
      const local = imgMap.get(key);
      if (local) return `${pre}${local}`;
    }
    return whole;
  });
}

export function buildMarkdown({ question, answers, url, qid, fetchedAt, truncated, declaredTotal, collapsedCount, withImages }) {
  const title = (question.title || `知乎问题 ${qid}`).trim();
  const L = [];

  L.push('---');
  L.push(`title: "${title.replace(/"/g, '\\"')}"`);
  L.push(`source: ${url}`);
  L.push(`question_id: ${qid}`);
  if (question.answer_count != null) L.push(`answer_count: ${question.answer_count}`);
  L.push(`fetched_answers: ${answers.length}`);
  L.push(`fetched_at: "${fetchedAt}"`);
  L.push('---', '');

  L.push(`# ${title}`, '');
  L.push(`> 原问题: <${url}>`);
  const meta = [];
  if (question.answer_count != null) meta.push(`${question.answer_count} 个回答`);
  if (question.follower_count != null) meta.push(`${question.follower_count} 人关注`);
  if (question.visit_count != null) meta.push(`${question.visit_count} 次浏览`);
  if (meta.length) L.push(`> ${meta.join(' · ')}`);
  L.push(`> 已抓取 ${answers.length} 条回答 · ${fetchedAt}`, '');

  L.push('## 问题描述', '');
  L.push((question.detail && htmlToMarkdown(question.detail)) || '_（无问题描述）_', '');
  L.push('---', '');

  L.push('## 回答目录', '');
  answers.forEach((a, i) => {
    L.push(`${i + 1}. [${a.author.name}](#回答-${i + 1}) · ${a.voteup} 赞同`);
  });
  L.push('', '---', '');

  answers.forEach((a, i) => {
    L.push(`## 回答 ${i + 1}`, '');
    L.push(`**${a.author.name}**${a.author.headline ? ` — ${a.author.headline}` : ''}`, '');
    const m = [`${a.voteup} 赞同`];
    if (a.comments != null) m.push(`${a.comments} 条评论`);
    if (a.created) m.push(`发布于 ${fmtDate(a.created)}`);
    if (a.updated && a.updated !== a.created) m.push(`编辑于 ${fmtDate(a.updated)}`);
    L.push(`> ${m.join(' · ')}`);
    L.push(`> 回答链接: <https://www.zhihu.com/question/${qid}/answer/${a.id}>`);
    if (a.author.token) L.push(`> 作者主页: <https://www.zhihu.com/people/${a.author.token}>`);
    L.push('');
    L.push(htmlToMarkdown(a.content) || '_（该回答无正文，可能是纯图片或视频）_', '');
    L.push('---', '');
  });

  if (truncated) {
    const gap =
      declaredTotal != null && declaredTotal > answers.length
        ? `（知乎显示共 ${declaredTotal} 条${collapsedCount ? `，其中 ${collapsedCount} 条已被折叠` : ''}）`
        : '';
    L.push(`> ⚠️ 本次抓到 ${answers.length} 条回答${gap}；若认为有遗漏，可稍后重跑。`, '');
  }
  if (!withImages) {
    L.push('_注：本次未下载图片，图片链接直接指向知乎，可能因防盗链无法显示。_', '');
  }

  return { title, markdown: L.join('\n') };
}

/**
 * 完整导出：抓取 → 下载图片 → 生成 md 文件
 */
export async function exportQuestion({
  session,
  qid,
  outDir,
  order = 'default',
  limit = 0,
  images = true,
  maxScroll = 500,
  onLog = () => { },
}) {
  const url = `https://www.zhihu.com/question/${qid}`;
  const result = await crawlQuestion(session.page, qid, { order, limit, maxScroll, onLog });
  const { question, answers, isEnd, declaredTotal, collapsedCount } = result;

  if (!question.title) {
    try {
      question.title = (await session.page.title()).replace(/\s*-\s*知乎$/, '');
    } catch { /* ignore */ }
  }

  const fetchedAt = fmtDate(Math.floor(Date.now() / 1000));
  await fsp.mkdir(path.resolve(outDir), { recursive: true });
  const assetsRel = 'assets';
  const assetsDir = path.join(path.resolve(outDir), assetsRel);

  let imgMap = new Map();
  if (images) {
    const imgs = [
      ...answers.flatMap((a) => collectImages(a.content)),
      ...collectImages(question.detail),
    ].filter((i) => !/\/equation\?/.test(i.url));
    const urls = imgs.map((i) => i.url);
    onLog(`→ 下载图片 ${new Set(urls).size} 张……`);
    const downloaded = await downloadImages(urls, assetsDir, assetsRel, {
      cookie: session.cookiesHeader,
      userAgent: session.ua,
      onLog,
    });
    for (const img of imgs) {
      const local = downloaded.get(img.url);
      if (!local) continue;
      for (const alias of img.aliases || [img.url]) {
        for (const key of imageKeys(alias)) imgMap.set(key, local);
      }
    }
  }

  const built = buildMarkdown({
    question,
    answers,
    url,
    qid,
    fetchedAt,
    truncated: !isEnd,
    declaredTotal,
    collapsedCount,
    withImages: images,
  });
  const markdown = imgMap.size ? rewriteImageUrls(built.markdown, imgMap) : built.markdown;

  const outFile = path.join(path.resolve(outDir), `${sanitizeFilename(built.title)}.md`);
  await fsp.writeFile(outFile, markdown, 'utf8');

  const imgCount = images && fs.existsSync(assetsDir) ? (await fsp.readdir(assetsDir)).length : 0;
  onLog('');
  onLog('✅ 抓取完成');
  onLog(`  文件：${outFile}`);
  onLog(`  回答：${answers.length} 条 · 正文 ${markdown.length} 字符${isEnd ? '' : '（未抓到底）'}`);
  if (imgCount) onLog(`  图片：${imgCount} 张 → ${assetsDir}`);

  return {
    title: built.title,
    markdownPath: outFile,
    assetsDir,
    imgCount,
    answers: answers.length,
    chars: markdown.length,
    question,
  };
}
