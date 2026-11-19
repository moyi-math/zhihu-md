/**
 * 用户配置（GUI 用）：目前只有输出目录
 * 存放位置：%LOCALAPPDATA%\zhihu-md\config.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { BASE_DIR, DEFAULT_OUT_DIR } from './zhihu-core.mjs';

export const CONFIG_FILE = path.join(BASE_DIR, 'config.json');

const DEFAULTS = {
  outDir: DEFAULT_OUT_DIR,
};

/** 读配置；文件缺失或损坏时回退默认值 */
export function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

/** 合并写入；失败不抛（配置不是关键路径） */
export function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 校验并规范化一个输出目录：
 *  - 必填、必须是绝对路径
 *  - 不能是文件
 *  - 尝试创建（不存在的目录要能建出来）
 * 返回 { ok, dir, error }
 */
export function resolveOutDir(input) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, error: '请填写目录路径' };

  const abs = path.resolve(raw);
  if (!path.isAbsolute(raw) && !/^[a-zA-Z]:/.test(raw) && !raw.startsWith('\\\\')) {
    // path.resolve 会把相对路径挂到 cwd 上，这里明确拒绝，避免"看起来成功但存到意外的位置"
    if (!/[\\/]/.test(raw)) return { ok: false, error: '请填写完整路径，例如 D:\\知乎导出' };
  }

  try {
    const st = fs.statSync(abs, { throwIfNoEntry: false });
    if (st && !st.isDirectory()) return { ok: false, error: '该路径是一个文件，不是目录' };
    if (!st) fs.mkdirSync(abs, { recursive: true });
  } catch (err) {
    return { ok: false, error: `无法创建或访问该目录：${err.message}` };
  }

  // 真实写一次，确认有权限
  try {
    const probe = path.join(abs, `.write-test-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (err) {
    return { ok: false, error: `该目录不可写：${err.message}` };
  }

  return { ok: true, dir: abs };
}
