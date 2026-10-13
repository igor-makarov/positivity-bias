// Guards the dist-based runtime checks so they exercise the CURRENT source instead of
// a stale or missing Wrangler bundle. `npm run test:worker|browser|interaction` build
// first; a direct `node scripts/...` run refuses rather than silently validating old
// code. The esbuild-based checks (extract/retirement/pipeline/batch) read `src/`
// directly and need no guard.
import { existsSync, readdirSync, statSync } from 'node:fs';

const SOURCE_ROOTS = ['src', 'websites.json', 'package.json'];

function newestSourceMtime() {
  let newest = 0;
  const visit = (path) => {
    const stat = statSync(path);
    if (stat.isDirectory()) { for (const entry of readdirSync(path)) visit(`${path}/${entry}`); }
    else newest = Math.max(newest, stat.mtimeMs);
  };
  for (const path of SOURCE_ROOTS) if (existsSync(path)) visit(path);
  return newest;
}

export function requireFreshBundle(command) {
  if (!existsSync('dist/worker.js')) {
    console.error(`dist/worker.js is missing; run \`npm run build\` before \`${command}\`.`);
    process.exit(2);
  }
  if (statSync('dist/worker.js').mtimeMs < newestSourceMtime()) {
    console.error(`dist/worker.js is older than the source; run \`npm run build\` before \`${command}\`.`);
    process.exit(2);
  }
}
