// Explicitly fictional fixtures for the local Worker-runtime checks. No external traffic.
// Returned documents never reach the live site; they exist only inside Miniflare.
export function createFixtureFetch() {
  const publishedAt = new Date(Date.now() - 300_000).toISOString();
  let requests = 0;
  const fetch = async (request) => {
    const url = new URL(request.url);
    requests++;
    if (url.pathname.includes('/sitemap/')) {
      return new Response(`<urlset><url><loc>https://www.kan.org.il/content/kan-news/fixture</loc><news:news><news:title>לפי המועצה: 3 תוכניות אושרו</news:title><news:publication_date>${publishedAt}</news:publication_date></news:news></url></urlset>`);
    }
    if (url.pathname.includes('/kan-news/')) {
      return new Response(`<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', headline: 'לפי המועצה: 3 תוכניות אושרו', description: 'ידיעה בדיונית לבדיקת תוכנה בלבד.', articleSection: 'בארץ', datePublished: publishedAt })}</script></head></html>`);
    }
    const domain = url.hostname.includes('ynet') ? 'www.ynet.co.il' : url.pathname.includes('news-') ? 'www.n12.co.il' : 'www.mako.co.il';
    const id = [...url.pathname].reduce((sum, char) => sum * 31 + char.charCodeAt(0) >>> 0, 0).toString(16);
    return new Response(`<rss><channel><item><title>לפי המועצה: 3 תוכניות אושרו</title><link>https://${domain}/news/Article-${id}.htm</link><pubDate>${publishedAt}</pubDate><category>קהילה</category><description>ידיעה בדיונית לבדיקת תוכנה בלבד.</description></item></channel></rss>`);
  };
  return { fetch, count: () => requests };
}
// Decode the documented native chat or Qwen raw format in test-only model fixtures.
export function rewriteItems(input) {
  const content = input.messages?.[1]?.content
    ?? input.prompt?.match(/<\|im_start\|>user\n([\s\S]*?)<\|im_end\|>\n<\|im_start\|>assistant/)[1];
  return JSON.parse(content);
}
