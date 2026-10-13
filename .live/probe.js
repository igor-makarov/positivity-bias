import configuration from '../websites.json';
import { validateWebsites } from '../src/news.js';
import { ingestSource, loadArticleContext } from '../src/ingest.js';

const sources = validateWebsites(configuration);

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const wanted = (url.searchParams.get('sources') || 'ynet,kan').split(',');
    const sample = Math.max(1, Math.min(4, Number(url.searchParams.get('sample') || 3)));
    const out = [];
    for (const source of sources.filter((s) => wanted.includes(s.id))) {
      const ingested = await ingestSource(source, [], Date.now());
      const picks = ingested.articles.slice(0, sample);
      const contexts = [];
      for (const article of picks) {
        const { context, error } = await loadArticleContext(article, source);
        contexts.push({ id: article.id, completeness: context.completeness, chars: context.charCount, error: error || null });
      }
      out.push({ id: source.id, state: ingested.status.state, received: ingested.status.received, errors: ingested.status.errors.slice(0, 3), contexts });
    }
    return Response.json(out);
  }
};
