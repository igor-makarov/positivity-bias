import test from 'node:test';
import assert from 'node:assert/strict';
import { articleKey, articleMetadata, canonicalUrl, coverageOrder, mergeArticles, parseFeed, parseNewsSitemap, plainText, validateWebsites } from '../src/news.ts';
import { fetchPublisher, ingestSource } from '../src/ingest.ts';
import configuration from '../websites.json' with { type: 'json' };

const now = Date.parse('2026-10-13T12:00:00Z');
const source = configuration.websites[0];
const feed = source.feeds[0];
const story = (id: string, category = 'חדשות', sourceId = 'ynet', time = '2026-10-13T11:00:00Z') => ({ id, categories: [category], sourceId, publishedAt: time,
  originalHeadline: 'המועצה אישרה תוכנית חדשה', headline: 'המועצה אישרה תוכנית חדשה', description: '', rewriteStatus: 'original' });
const rss = (items: string) => `<rss version="2.0"><channel><title>חדשות</title>${items}</channel></rss>`;
const item = (extra = '') => `<item><title><![CDATA[המועצה אישרה תוכנית: כל הפרטים]]></title><link>https://www.ynet.co.il/news/article/test?utm_source=rss</link><pubDate>Tue, 13 Oct 2026 11:00:00 GMT</pubDate><description><![CDATA[<p>התוכנית תיכנס לתוקף ב-2027.</p>]]></description>${extra}</item>`;

test('RSS preserves publisher categories, factual excerpt, and date while canonicalizing URL', () => {
  const [article] = parseFeed(rss(item('<category>חדשות בארץ</category><category>פוליטי</category>')), source, feed, now);
  assert.deepEqual(article.categories, ['חדשות בארץ', 'פוליטי']);
  assert.equal(article.url, 'https://www.ynet.co.il/news/article/test');
  assert.equal(article.description, 'התוכנית תיכנס לתוקף ב-2027.');
  assert.equal(article.originalHeadline, 'המועצה אישרה תוכנית: כל הפרטים');
  assert.equal(article.publishedAt, '2026-10-13T11:00:00.000Z');
});
test('Only the publisher feed label supplies a category fallback', () => {
  assert.deepEqual(parseFeed(rss(item()), source, feed, now)[0].categories, ['חדשות']);
  assert.deepEqual(parseFeed(rss(item()), source, {}, now)[0].categories, []);
});
test('Atom link attributes and category terms are supported', () => {
  const xml = `<feed><entry><title>החלטת המועצה</title><link rel="alternate" href="https://ynet.co.il/news/article/test"/><published>2026-10-13T10:00:00Z</published><category term="כלכלה"/></entry></feed>`;
  assert.equal(parseFeed(xml, source, {}, now)[0].categories[0], 'כלכלה');
});
test('Bad timestamps and foreign links do not enter the edition', () => {
  assert.equal(parseFeed(rss(item().replace('2026', '2027')), source, feed, now).length, 0);
  assert.equal(parseFeed(rss(item().replace('www.ynet.co.il', 'attacker.example')), source, feed, now).length, 0);
  assert.equal(parseFeed(rss(item().replace('Tue, 13 Oct 2026 11:00:00 GMT', 'invalid')), source, feed, now).length, 0);
});
test('Malformed XML and declarations fail rather than expanding entities', () => {
  assert.throws(() => parseFeed('<rss><channel></rss>', source, feed, now), /invalid_xml/);
  assert.throws(() => parseFeed('<!DOCTYPE rss [<!ENTITY payload SYSTEM "file:///etc/passwd">]><rss/>', source, feed, now), /invalid_xml/);
});
test('Publisher URL allowlists reject credentials, alternate protocols and off-domain redirects', async () => {
  for (const url of ['http://www.ynet.co.il/news', 'https://www.ynet.co.il:444/news', 'https://secret@www.ynet.co.il/news', 'https://www.ynet.co.il.attacker.example/news']) assert.equal(canonicalUrl(url, source), null);
  await assert.rejects(fetchPublisher(feed.url, source, async () => new Response(null, { status: 302, headers: { location: 'https://attacker.example/data' } })), /unapproved_redirect/);
});
test('A bounded publisher response rejects excessive content', async () => {
  await assert.rejects(fetchPublisher(feed.url, source, async () => new Response('x'.repeat(2_000_001))), /response_too_large/);
});
test('An unavailable feed does not erase results from a working sibling', async () => {
  const multi = { ...source, feeds: [{ ...feed, url: 'https://www.ynet.co.il/good.xml' }, { ...feed, url: 'https://www.ynet.co.il/bad.xml' }] };
  const result = await ingestSource(multi, [], now, async (url) => String(url).includes('good') ? new Response(rss(item())) : new Response('down', { status: 503 }));
  assert.equal(result.articles.length, 1); assert.equal(result.status.state, 'partial'); assert.equal(result.status.errors[0].code, 'source_http_503');
});
test('News sitemap and JSON-LD supply section and publication metadata', () => {
  const kan = configuration.websites[1];
  const xml = '<urlset><url><loc>https://www.kan.org.il/content/kan-news/test</loc><news:news><news:title>החלטת המועצה</news:title><news:publication_date>2026-10-13T10:00:00Z</news:publication_date></news:news></url></urlset>';
  assert.equal(parseNewsSitemap(xml, kan, now).length, 1);
  const metadata = articleMetadata(['bad json', JSON.stringify({ '@graph': [{ '@type': 'WebSite' }, { '@type': ['Article', 'NewsArticle'], headline: 'החלטת המועצה', articleSection: ['בארץ', 'כלכלה'], datePublished: '2026-10-13T10:00:00Z' }] })]);
  assert.deepEqual(metadata.categories, ['בארץ', 'כלכלה']);
  assert.deepEqual(articleMetadata([], { 'og:title': 'ידיעה' }).categories, []);
});
test('Mako and N12 shared article IDs deduplicate across different URL paths', () => {
  const n12 = configuration.websites[2], mako = configuration.websites[3];
  assert.equal(articleKey('https://www.n12.co.il/news/politics/Article-abc123.htm', n12), articleKey('https://www.mako.co.il/news-politics/Article-abc123.htm?partner=rss', mako));
});
test('Broad order gives categories and publishers turns without emotional scoring', () => {
  const articles = [story('a', 'חדשות', 'ynet', '2026-10-13T11:59:00Z'), story('b', 'חדשות', 'ynet', '2026-10-13T11:58:00Z'), story('c', 'חדשות', 'kan', '2026-10-13T11:57:00Z'), story('d', 'תרבות', 'mako', '2026-10-13T10:00:00Z')];
  assert.deepEqual(coverageOrder(articles).map((article) => article.id), ['a', 'd', 'c', 'b']);
  articles[1].headline = 'הלם! אסון! לא תאמינו';
  assert.deepEqual(coverageOrder(articles).map((article) => article.id), ['a', 'd', 'c', 'b']);
});
test('Refresh retains good rewrites, invalidates changed source facts, and expires stale articles', () => {
  const old = { ...story('a'), headline: 'נוסח ערוך', rewriteStatus: 'rewritten', rewriteFingerprint: 'v1' };
  assert.equal(mergeArticles([old], [story('a')], now)[0].rewriteStatus, 'rewritten');
  assert.equal(mergeArticles([old], [{ ...story('a'), description: 'תיקון במקור' }], now)[0].rewriteStatus, 'original');
  assert.equal(mergeArticles([old], [], now).length, 1);
  assert.equal(mergeArticles([story('old', 'חדשות', 'ynet', '2026-10-01T11:00:00Z')], [], now).length, 0);
});
test('A partial snapshot article missing its categories field never breaks ordering or merging', () => {
  // A partial/corrupted snapshot can lose an article's categories. Serving must not
  // crash: the whole refresh/API path runs coverageOrder and mergeArticles over every
  // article, so a missing field would otherwise 503 the site for everyone.
  const noCategories = { id: 'nocat', sourceId: 'kan', publishedAt: '2026-10-13T11:00:00Z',
    originalHeadline: 'כותרת', headline: 'כותרת', description: '', rewriteStatus: 'original' };
  assert.deepEqual(coverageOrder([noCategories]).map((article) => article.id), ['nocat']);
  assert.deepEqual(coverageOrder([noCategories, story('b')]).map((article) => article.id), ['b', 'nocat']);
  assert.equal(mergeArticles([noCategories], [], now).length, 1);
});
test('Publisher text is plain bounded text and the registry has all requested websites', () => {
  assert.equal(plainText('<script>steal()</script><p>שלום &amp; עולם</p>'), 'שלום & עולם');
  assert.deepEqual(validateWebsites(configuration).map((website) => website.domain), ['ynet.co.il', 'kan.org.il', 'n12.co.il', 'mako.co.il']);
  assert.throws(() => validateWebsites({ version: 1, websites: [source, source] }), /duplicate/);
});
