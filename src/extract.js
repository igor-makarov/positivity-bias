import { articleMetadata, plainText } from './news.js';

export const DEFAULT_CONTEXT_CHARS = 6_000;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
// Structural chrome that is never part of the article. Text inside a matched
// subtree is skipped with an explicit depth counter: HTMLRewriter's remove() does
// not stop descendant text handlers.
const NOISE_TAGS = new Set(['head', 'title', 'script', 'style', 'noscript', 'template', 'nav', 'aside', 'footer', 'header', 'form', 'iframe', 'dialog', 'svg', 'button', 'select', 'option']);
const NOISE_PATTERN = /(?:^|[-_ ])(?:ad|ads|advert|advertisement|banner|promo|promoted|sponsor|sponsored|share|sharing|social|comment|comments|related|recommend|recommended|newsletter|subscribe|subscription|breadcrumb|menu|nav|navigation|sidebar|toolbar|cookie|consent|popup|modal|overlay|widget|tags|print|skip)(?:[-_ ]|$)/i;

export function prepareContext(rawBody, { maxChars = DEFAULT_CONTEXT_CHARS } = {}) {
  const clean = plainText(rawBody, maxChars * 3 + 4_000);
  if (!clean) return { text: '', charCount: 0, completeness: 'missing' };
  if (clean.length > maxChars) return { text: clean.slice(0, maxChars), charCount: clean.length, completeness: 'truncated' };
  return { text: clean, charCount: clean.length, completeness: 'complete' };
}

// One bounded HTMLRewriter pass over an article page: JSON-LD/meta metadata plus the
// article body with navigation, advertising and unrelated recommendations removed.
// The return value keeps the publisher's own headline separate from the body text.
export async function readArticleData(html) {
  const scripts = [], meta = {}, segments = [];
  let currentScript = null;
  let skipDepth = 0;
  const frames = [];
  const rewriter = new HTMLRewriter()
    .on('script[type="application/ld+json"]', {
      element() { currentScript = { value: '' }; scripts.push(currentScript); },
      text(chunk) { if (currentScript && currentScript.value.length < 150_000) currentScript.value += chunk.text; }
    })
    .on('meta', { element(element) {
      const name = element.getAttribute('property') || element.getAttribute('name');
      if (['og:title', 'og:description', 'description', 'article:section', 'article:published_time'].includes(name)) meta[name] = element.getAttribute('content');
    } })
    .on('*', {
      element(element) {
        const tag = element.tagName.toLowerCase();
        if (VOID.has(tag)) return;
        const classId = `${element.getAttribute('class') || ''} ${element.getAttribute('id') || ''}`;
        const noise = NOISE_TAGS.has(tag) || NOISE_PATTERN.test(classId);
        const frame = { noise, content: !noise && (tag === 'article' || tag === 'main') };
        if (noise) skipDepth++;
        frames.push(frame);
        element.onEndTag(() => {
          if (frames[frames.length - 1] === frame) frames.pop();
          else { const at = frames.lastIndexOf(frame); if (at >= 0) frames.splice(at, 1); }
          if (frame.noise) skipDepth--;
        });
      },
      text(chunk) {
        if (skipDepth > 0) return;
        segments.push({ content: frames.some((frame) => frame.content), text: chunk.text });
      }
    });
  await rewriter.transform(new Response(html)).text();
  const metadata = articleMetadata(scripts.map((script) => script.value), meta);
  const contentText = plainText(segments.filter((segment) => segment.content).map((segment) => segment.text).join(' '), 200_000);
  const allText = plainText(segments.map((segment) => segment.text).join(' '), 200_000);
  const htmlBody = contentText.length >= 60 ? contentText : allText.length > contentText.length ? allText : contentText;
  const jsonLdBody = metadata.body || '';
  const body = jsonLdBody.length >= htmlBody.length ? jsonLdBody : htmlBody;
  return { ...metadata, body };
}
