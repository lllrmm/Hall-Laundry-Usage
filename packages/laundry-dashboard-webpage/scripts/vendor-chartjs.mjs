/**
 * 把 Chart.js 的 UMD 构建复制到 public/vendor/，保证看板离线可用（不依赖 CDN）。
 * 升级方式：npm update chart.js && node scripts/vendor-chartjs.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pkg = path.join(root, 'node_modules', 'chart.js');
const dist = path.join(pkg, 'dist', 'chart.umd.js');
const license = path.join(pkg, 'LICENSE.md');
const outDir = path.join(root, 'public', 'vendor');

if (!fs.existsSync(dist)) {
  console.error('找不到 chart.js 的 UMD 构建，请先 npm install');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(dist, path.join(outDir, 'chart.umd.js'));

if (fs.existsSync(license)) {
  fs.copyFileSync(license, path.join(outDir, 'CHARTJS-LICENSE.md'));
}

const version = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version;
fs.writeFileSync(
  path.join(outDir, 'VERSION.txt'),
  `Chart.js ${version}\nhttps://www.chartjs.org/\nMIT License\n`,
);

const size = (fs.statSync(path.join(outDir, 'chart.umd.js')).size / 1024).toFixed(1);
console.log(`vendored Chart.js ${version} -> public/vendor/chart.umd.js (${size} KB)`);
