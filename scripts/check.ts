import { readdir, readFile } from 'node:fs/promises';
import configuration from '../websites.json' with { type: 'json' };
import { validateWebsites } from '../src/news.ts';

validateWebsites(configuration);
for (const directory of ['src', 'client', 'scripts', 'test']) {
  for (const file of await readdir(directory)) {
    if (file.endsWith('.js')) throw new Error(`JavaScript source must be migrated: ${directory}/${file}`);
    if (!file.endsWith('.ts')) continue;
    await readFile(`${directory}/${file}`, 'utf8');
  }
}
const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8')) as {main: string; durable_objects: {bindings: {name: string}[]}};
if (config.main !== 'src/worker.ts' || !config.durable_objects.bindings.some((binding) => binding.name === 'NEWS')) throw new Error('Missing Worker configuration');
for (const file of ['public/index.html', 'public/style.css', 'client/app.ts', 'public/fonts/heebo.ttf', 'public/fonts/OFL.txt', 'PROMPT.md']) await readFile(file);
console.log('Strict TypeScript source, source registry, Worker configuration, and assets checked.');
