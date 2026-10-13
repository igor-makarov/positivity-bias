import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import configuration from '../websites.json' with { type: 'json' };
import { validateWebsites } from '../src/news.js';

validateWebsites(configuration);
for (const directory of ['src', 'public', 'scripts', 'test']) {
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.js')) continue;
    const result = spawnSync(process.execPath, ['--check', `${directory}/${file}`], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
if (config.main !== 'src/worker.js' || !config.durable_objects.bindings.some((binding) => binding.name === 'NEWS')) throw new Error('Missing Worker configuration');
for (const file of ['public/index.html', 'public/style.css', 'public/app.js', 'public/fonts/heebo.ttf', 'public/fonts/OFL.txt', 'PROMPT.md']) await readFile(file);
console.log('Source syntax, source registry, Worker configuration, and assets checked.');
