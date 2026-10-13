// Probe worker used only by scripts/extraction-check.js. It exercises the real
// HTMLRewriter body extraction under workerd, which plain Node cannot provide.
import { prepareContext, readArticleData } from '../src/extract.js';

const html = `<!doctype html><html lang="he"><head>
  <title>אתר הדגמה</title>
  <meta property="og:title" content="התעשייה האווירית השלימה ניסוי">
  <script type="application/ld+json">{"@type":"NewsArticle","headline":"התעשייה האווירית השלימה בהצלחה ניסוי במל״ט","articleSection":"בטחון","datePublished":"2026-10-13T10:00:00Z"}</script>
</head><body>
  <header class="masthead"><nav><a href="/">דף הבית</a><a href="/sport">ספורט</a></nav></header>
  <main><article>
    <h1>התעשייה האווירית השלימה בהצלחה ניסוי במל״ט</h1>
    <p>התעשייה האווירית הודיעה כי השלימה בהצלחה ניסוי במל״ט שמצויד במקלע.</p>
    <div class="ad-banner">פרסומת</div>
    <p>הניסוי נערך באזור דרומי ונחשב להצלחה מלאה.</p>
    <aside class="related-articles"><p>כתבות נוספות</p></aside>
  </article></main>
  <div class="recommended"><p>מומלץ עבורך</p></div>
  <footer><p>כל הזכויות שמורות</p></footer>
</body></html>`;

export default {
  async fetch() {
    const data = await readArticleData(html);
    const context = prepareContext(data.body);
    return Response.json({ headline: data.headline, categories: data.categories, body: context.text, completeness: context.completeness });
  }
};
