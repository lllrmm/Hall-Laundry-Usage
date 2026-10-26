/** 极简分级日志，默认写 stderr，避免污染 `--json` 的 stdout。 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * @param {object} [options]
 * @param {string} [options.level] debug/info/warn/error/silent
 * @param {NodeJS.WritableStream} [options.stream]
 * @param {() => Date} [options.now]
 */
export function createLogger({ level = 'info', stream = process.stderr, now = () => new Date() } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const write = (levelName, args) => {
    if (LEVELS[levelName] < threshold) return;
    const ts = now().toISOString();
    stream.write(`${ts} ${levelName.toUpperCase().padEnd(5)} ${args.map(String).join(' ')}\n`);
  };

  return {
    level,
    debug: (...args) => write('debug', args),
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
  };
}
