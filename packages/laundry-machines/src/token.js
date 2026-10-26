import fs from 'node:fs';
import path from 'node:path';

/**
 * 解析 Bearer token，优先级：显式传入 > 环境变量 LDR_TOKEN > 本地 token.txt。
 *
 * token 来自网页登录态：localStorage["ldr_student"].token。
 *
 * @param {object} [options]
 * @param {string} [options.token] 显式 token
 * @param {NodeJS.ProcessEnv} [options.env] 环境变量来源，默认 process.env
 * @param {string} [options.cwd] 查找 token.txt 的目录，默认 process.cwd()
 * @param {string} [options.file] 文件名，默认 "token.txt"
 * @returns {string|null} 找到的 token，未找到返回 null
 */
export function resolveToken({ token, env = process.env, cwd = process.cwd(), file = 'token.txt' } = {}) {
  if (typeof token === 'string' && token.trim()) return token.trim();

  const fromEnv = env?.LDR_TOKEN;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();

  try {
    const content = fs.readFileSync(path.resolve(cwd, file), 'utf8').trim();
    if (content) return content;
  } catch {
    // 没有 token.txt 是正常情况，交给调用方处理
  }

  return null;
}
