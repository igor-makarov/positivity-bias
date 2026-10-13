// Probe worker used only by scripts/extraction-check.js. It exercises the real
// HTMLRewriter body extraction under workerd, which plain Node cannot provide.
import { prepareContext, readArticleData } from '../src/extract.js';

// The article intentionally contains a self-closing SVG <path>: the parser never
// closes it, and registering an end-tag handler for it used to abort extraction with
// "Parser error: No end tag." on real publisher pages.
const articleHtml = `<!doctype html><html lang="he"><head>
  <title>אתר הדגמה</title>
  <meta property="og:title" content="התעשייה האווירית השלימה ניסוי">
  <script type="application/ld+json">{"@type":"NewsArticle","headline":"התעשייה האווירית השלימה בהצלחה ניסוי במל״ט","articleSection":"בטחון","datePublished":"2026-10-13T10:00:00Z"}</script>
</head><body>
  <header class="masthead"><nav><a href="/">דף הבית</a><a href="/sport">ספורט</a></nav></header>
  <main><article>
    <h1>התעשייה האווירית השלימה בהצלחה ניסוי במל״ט</h1>
    <svg class="icon" aria-hidden="true"><path d="M0 0h32L0 32Z"/></svg>
    <p>התעשייה האווירית הודיעה כי השלימה בהצלחה ניסוי במל״ט שמצויד במקלע.</p>
    <div class="ad-banner">פרסומת</div>
    <p>הניסוי נערך באזור דרומי ונחשב להצלחה מלאה.</p>
    <aside class="related-articles"><p>כתבות נוספות</p></aside>
  </article></main>
  <div class="recommended"><p>מומלץ עבורך</p></div>
  <footer><p>כל הזכויות שמורות</p></footer>
</body></html>`;

// A bot-mitigation interstitial served in place of the article.
const blockHtml = `<!doctype html><html lang="en"><head><title>Radware Block Page</title></head>
  <body><main><p>We are sorry... but your activity and behavior on this website made us think that you are a bot. To protect this website, we cannot process your request right now. Please solve this CAPTCHA in helping us understand your behavior to grant access.</p></main></body></html>`;

// A client-rendered shell whose initial HTML is only navigation chrome.
const thinHtml = `<!doctype html><html lang="he"><body><nav><a href="/">דף הבית</a><a href="/sport">ספורט</a></nav><main><p>טוען את הכתבה</p></main></body></html>`;

const pages = { article: articleHtml, block: blockHtml, thin: thinHtml };

export default {
  async fetch(request) {
    const which = new URL(request.url).searchParams.get('case') || 'article';
    const data = await readArticleData(pages[which] || articleHtml);
    const context = prepareContext(data.body);
    return Response.json({ case: which, headline: data.headline, categories: data.categories,
      body: context.text, charCount: context.charCount, completeness: context.completeness });
  }
};
