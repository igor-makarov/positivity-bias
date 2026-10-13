import { articleMetadata, plainText } from './text.js';

export const DEFAULT_CONTEXT_CHARS = 6_000;
// A body shorter than this is navigation chrome or a stub, not an article. Such
// context is treated as missing so the original headline is preserved instead of
// grounding a rewrite in a menu fragment.
export const MIN_CONTEXT_CHARS = 120;

// Interstitials that publishers/bot-mitigation serve instead of the article. They are
// never inference context: respect source access restrictions and keep the original.
const BLOCK_MARKERS = [
  /made us think that you are a bot/i,
  /solve this captcha in helping us understand/i,
  /access to this page has been denied/i,
  /enable javascript and cookies to continue/i,
  /are you a robot|verify you are a human|unusual traffic from your/i,
  /just a moment\.\.\./i,
];

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
// Structural chrome that is never part of the article. Text inside a matched
// subtree is skipped with an explicit depth counter: HTMLRewriter's remove() does
// not stop descendant text handlers.
const NOISE_TAGS = new Set(['head', 'title', 'script', 'style', 'noscript', 'template', 'nav', 'aside', 'footer', 'header', 'form', 'iframe', 'dialog', 'svg', 'button', 'select', 'option']);
const NOISE_PATTERN = /(?:^|[-_ ])(?:ad|ads|advert|advertisement|banner|promo|promoted|sponsor|sponsored|share|sharing|social|comment|comments|related|recommend|recommended|newsletter|subscribe|subscription|breadcrumb|menu|nav|navigation|sidebar|toolbar|cookie|consent|popup|modal|overlay|widget|tags|print|skip)(?:[-_ ]|$)/i;

export function prepareContext(rawBody, { maxChars = DEFAULT_CONTEXT_CHARS, minChars = MIN_CONTEXT_CHARS } = {}) {
  const clean = plainText(rawBody, maxChars * 3 + 4_000);
  if (!clean) return { text: '', charCount: 0, completeness: 'missing' };
  // A bot challenge or access-denied page is not the article; never feed it to the model.
  if (BLOCK_MARKERS.some((pattern) => pattern.test(clean))) return { text: '', charCount: clean.length, completeness: 'missing' };
  if (clean.length < minChars) return { text: '', charCount: clean.length, completeness: 'missing' };
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
        // Real pages contain elements the parser never closes (e.g. SVG <path>).
        // Registering an end-tag handler for them throws "Parser error: No end tag."
        // and would abort the whole extraction, so treat those as having no subtree.
        try {
          element.onEndTag(() => {
            if (frames[frames.length - 1] === frame) frames.pop();
            else { const at = frames.lastIndexOf(frame); if (at >= 0) frames.splice(at, 1); }
            if (frame.noise) skipDepth--;
          });
        } catch { return; }
        if (noise) skipDepth++;
        frames.push(frame);
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
