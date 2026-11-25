/**
 * Cloudflare 대시보드 웹 에디터(Quick Edit) 복사용 단일 파일 번들 생성기 (외부 패키지 0)
 * GitHub 연동이나 `npx wrangler deploy`를 쓰지 않고 브라우저에서 1개 파일만 붙여넣고 싶을 때 사용합니다.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const coreSrc = fs.readFileSync(path.join(ROOT, 'lib', 'bionda-core.js'), 'utf8');
const cctvSrc = fs.readFileSync(path.join(ROOT, 'lib', 'cctv-its.js'), 'utf8');
const rwisSrc = fs.readFileSync(path.join(ROOT, 'cloudflare', 'rwis-worker.js'), 'utf8');
const workerSrc = fs.readFileSync(path.join(ROOT, 'cloudflare', 'worker.js'), 'utf8');

const coreClean = coreSrc.replace(/\nmodule\.exports\s*=\s*\{[\s\S]*?\};\s*$/, '\n');
const cctvClean = cctvSrc.replace(/\nmodule\.exports\s*=\s*\{[\s\S]*?\};\s*$/, '\n');
// rwis-worker.js 는 lib/cctv-its.js 와 동명 함수가 있으므로 IIFE 스코프로 감싸 합칩니다.
const rwisClean = rwisSrc
  .replace(/^export\s+/gm, '')
  .replace(/^default\s+rwisWorker;\s*$/m, '');
const rwisBlock = `// ─── 광주대구선 RWIS·CCTV (/rwis) ───\nconst { handleRwisFetch } = (() => {\n${rwisClean}\nreturn { handleRwisFetch };\n})();\n`;
const workerClean = workerSrc
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*['"]\.\.\/lib\/bionda-core\.js['"];\s*/, '')
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*['"]\.\.\/lib\/cctv-its\.js['"];\s*/, '')
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/rwis-worker\.js['"];\s*/, '');

const outDir = path.join(ROOT, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'bionda-worker.standalone.js');
const banner = `// Auto-generated standalone single-file Cloudflare Worker bundle\n// Build: npm run build:worker\n\n`;
fs.writeFileSync(outFile, banner + coreClean + '\n' + cctvClean + '\n' + rwisBlock + '\n' + workerClean, 'utf8');
console.log(`[생성 완료] ${path.relative(ROOT, outFile)} (${fs.statSync(outFile).size} bytes)`);
