/** 知乎 HTML → Markdown 转换层的冒烟测试：node test-md-convert.mjs */
import assert from 'node:assert';
import { htmlToMarkdown, collectImages } from './md-convert.mjs';

const chunks = [];

chunks.push([
  '行内公式',
  '<p>设 <img eeimg="1" src="https://www.zhihu.com/equation?tex=n%5Cin%5Cmathbb+Z" alt="n\in\mathbb Z"/>，成立。</p>',
  (md) => assert.match(md, /\$n\\in\\mathbb Z\$/),
]);

chunks.push([
  '块级公式',
  '<p><img eeimg="2" src="https://www.zhihu.com/equation?tex=%5Cint_0%5E1+f%28x%29dx" alt=""/></p>',
  (md) => assert.match(md, /\$\$\n\\int_0\^1 f\(x\)dx\n\$\$/),
]);

chunks.push([
  '普通图片（data-original 优先）',
  '<figure><img src="data:image/svg+xml;utf8,x" data-original="https://pic1.zhimg.com/v2-a.jpg" data-caption="示意图"></figure>',
  (md) => assert.match(md, /!\[示意图\]\(https:\/\/pic1\.zhimg\.com\/v2-a\.jpg\)/),
]);

chunks.push([
  'noscript 里的真图',
  '<figure><noscript><img src="https://pic1.zhimg.com/v2-b.jpg"></noscript></figure>',
  (md) => assert.match(md, /!\[\]\(https:\/\/pic1\.zhimg\.com\/v2-b\.jpg\)/),
]);

chunks.push([
  '标题降级 + 列表 + 引用',
  '<h2>小节</h2><ul><li>甲</li><li>乙</li></ul><blockquote><p>引用</p></blockquote>',
  (md) => {
    assert.match(md, /^### 小节$/m);
    assert.match(md, /^-\s+甲$/m);
    assert.match(md, /^> 引用$/m);
  },
]);

chunks.push([
  '代码块保留语言',
  '<pre lang="python"><code>print(1)\nprint(2)</code></pre>',
  (md) => assert.match(md, /```python\nprint\(1\)\nprint\(2\)\n```/),
]);

chunks.push([
  '表格',
  '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
  (md) => {
    assert.match(md, /\| a \| b \|/);
    assert.match(md, /\| 1 \| 2 \|/);
  },
]);

chunks.push([
  '外链跳转还原',
  '<p><a href="https://link.zhihu.com/?target=https%3A%2F%2Fexample.com%2Fx">链接</a></p>',
  (md) => assert.match(md, /\[链接\]\(https:\/\/example\.com\/x\)/),
]);

chunks.push([
  '加粗/斜体/删除线',
  '<p><b>粗</b><em>斜</em><del>删</del></p>',
  (md) => {
    assert.match(md, /\*\*粗\*\*/);
    assert.match(md, /\*斜\*/);
    assert.match(md, /~~删~~/);
  },
]);

chunks.push([
  '公式 alt 里含 > 时不被截断',
  '<p>得</p><p><img eeimg="2" src="https://www.zhihu.com/equation?tex=%5Cboxed%7Bx%7D" alt="\boxed{x} (|t|>1)"/></p>',
  (md) => {
    // 公式应以块级形式单独出现一次
    assert.ok(md.includes('\\boxed{x}'), '公式内容应以 LaTeX 出现');
    assert.strictEqual((md.match(/\$\$/g) || []).length, 2, '应只有一对 $$');
    // 关键：不能出现二次转义残留（双反斜杠 \boxed）
    const DOUBLE_BS = String.fromCharCode(92, 92);
    assert.ok(!md.includes(DOUBLE_BS + 'boxed'), '公式内容不应被重复转义');
    assert.strictEqual((md.match(/\$\$/g) || []).length, 2, '应只有一对 $$');
  },
]);

chunks.push([
  '图片收集忽略算式图',
  '<p><img eeimg="1" src="https://www.zhihu.com/equation?tex=a"><img data-original="https://pic1.zhimg.com/v2-c.jpg"></p>',
  (_md, html) => {
    const urls = collectImages(html).map((i) => i.url);
    assert.deepStrictEqual(urls.sort(), [
      'https://pic1.zhimg.com/v2-c.jpg',
      'https://www.zhihu.com/equation?tex=a',
    ].sort());
  },
]);

let failed = 0;
for (const [name, html, check] of chunks) {
  try {
    const md = htmlToMarkdown(html);
    check(md, html);
    console.log(`✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`✖ ${name}\n  ${err.message}`);
  }
}

if (failed) {
  console.log(`\n${failed} 个用例失败`);
  process.exit(1);
}
console.log('\n全部通过');
