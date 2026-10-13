const $ = (id) => document.getElementById(id);
const state = { order: 'broad', offset: 0, loading: false, controller: null, requestId: 0, filters: '', refreshTimer: null, refreshPolls: 0 };
const dateFormat = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jerusalem' });
const timeFormat = new Intl.DateTimeFormat('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
$('edition-date').textContent = dateFormat.format(new Date());

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value != null) node.textContent = value;
  return node;
}

function icon(kind) {
  const paths = { external: 'M7 17 17 7M7 7h10v10', down: 'M12 4v16m-6-6 6 6 6-6' };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ui-icon'); svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', paths[kind]); svg.append(path);
  return svg;
}

function safeLink(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
}

function renderArticle(article) {
  const url = safeLink(article.url);
  if (!url) return null;
  const row = element('article', article.rewriteStatus === 'rewritten' ? 'article' : 'article article-unconverted');
  const meta = element('div', 'article-meta');
  meta.append(element('span', 'article-source', article.sourceName));
  const time = element('time', 'article-time', timeFormat.format(new Date(article.publishedAt)));
  time.dateTime = article.publishedAt;
  meta.append(time, element('span', 'category-label', (article.categories || []).join(' · ') || 'ללא קטגוריה במקור'));
  const content = element('div', 'article-content');
  const heading = element('h3', 'article-title');
  const link = element('a', '', article.headline); link.href = url; link.rel = 'noopener noreferrer'; heading.append(link);
  content.append(heading);
  if (article.rewriteStatus === 'rewritten') {
    const original = element('details', 'article-original');
    original.append(element('summary', '', 'הכותרת המקורית'), element('p', '', article.originalHeadline));
    content.append(original);
  }
  const action = element('div', 'article-action');
  const originalLink = element('a', 'text-link', 'לכתבה במקור'); originalLink.href = url; originalLink.rel = 'noopener noreferrer';
  originalLink.append(icon('external'));
  action.append(originalLink, element('span', article.rewriteStatus === 'rewritten' ? 'rewrite-label edited' : 'rewrite-label', article.rewriteStatus === 'rewritten' ? 'ניסוח ענייני' : 'כותרת מקור'));
  row.append(meta, content, action);
  return row;
}

function emptyState(title, copy, retry = false) {
  const block = element('div', 'empty-state');
  const mark = element('span', 'empty-mark'); mark.setAttribute('aria-hidden', 'true'); mark.append(icon('down'));
  block.append(mark, element('h3', '', title), element('p', '', copy));
  if (retry) { const button = element('button', 'button', 'לנסות שוב'); button.type = 'button'; button.addEventListener('click', () => load()); block.append(button); }
  return block;
}

function renderSources(sources) {
  const labels = { ok: 'העדכון האחרון התקבל', partial: 'חלק מהעדכונים זמינים', unavailable: 'המקור אינו זמין כרגע', pending: 'ממתינים לעדכון הראשון' };
  $('source-status').replaceChildren(...sources.map((source) => {
    const card = element('div', 'source-card');
    const link = element('a', '', source.name); link.href = `https://${source.domain}`; link.rel = 'noopener noreferrer';
    const status = element('p', 'source-state');
    const dot = element('span', source.state === 'ok' ? 'status-dot ok' : 'status-dot'); dot.setAttribute('aria-hidden', 'true');
    status.append(dot, document.createTextNode(labels[source.state] || labels.pending));
    card.append(link, status);
    if (source.lastSuccessAt) card.append(element('p', '', `עדכון שהתקבל: ${timeFormat.format(new Date(source.lastSuccessAt))}`));
    return card;
  }));
}

async function load(append = false, refreshPoll = false) {
  clearTimeout(state.refreshTimer);
  if (!refreshPoll) state.refreshPolls = 0;
  let refreshing = false;
  const requestId = ++state.requestId;
  state.controller?.abort();
  state.controller = new AbortController(); state.loading = true;
  $('articles').setAttribute('aria-busy', 'true'); $('more').disabled = true;
  const params = new URLSearchParams(new FormData($('filters')));
  const submittedFilters = params.toString();
  params.set('order', state.order); params.set('offset', String(append ? state.offset : 0)); params.set('limit', '30');
  state.filters = params.toString();
  try {
    const response = await fetch(`/api/news?${params}`, { signal: state.controller.signal });
    if (!response.ok) throw new Error('unavailable');
    const data = await response.json();
    if (requestId !== state.requestId) return;
    refreshing = data.refreshing === true;
    if (!append) { $('articles').replaceChildren(); state.offset = 0; }
    for (const article of data.articles) { const row = renderArticle(article); if (row) $('articles').append(row); }
    state.offset += data.articles.length;
    if (!state.offset) $('articles').append(emptyState(data.updatedAt ? 'לא נמצאו עדכונים לסינון הזה.' : 'התמונה עדיין מתעדכנת.', data.updatedAt ? 'אפשר לשנות את החיפוש, המקור או הקטגוריה.' : 'העדכון הראשון מהמקורות טרם התקבל. אפשר לחזור בעוד כמה דקות.', !data.updatedAt));
    $('result-count').textContent = `${data.total} עדכונים`;
    $('more').hidden = state.offset >= data.total;
    $('freshness').textContent = data.updatedAt ? `${data.stale ? 'העדכון האחרון' : 'עודכן'} · ${timeFormat.format(new Date(data.updatedAt))}` : 'ממתינים לעדכון הראשון';
    const selected = $('category').value;
    $('category').replaceChildren(new Option('כל הקטגוריות', ''), ...data.categories.map((category) => new Option(category, category)));
    if (data.categories.includes(selected)) $('category').value = selected;
    renderSources(data.sources);
    const notices = [];
    if (refreshing) notices.push('אוספים עדכונים חדשים. התמונה תתעדכן כשהאיסוף יסתיים.');
    if (data.stale && data.updatedAt) notices.push('העדכונים המוצגים אינם עדכניים. זמני הפרסום מופיעים לצד כל ידיעה.');
    if (data.articles.some((article) => article.rewriteStatus !== 'rewritten')) notices.push('חלק מהכותרות מוצגות בנוסח המקורי ומסומנות בהתאם.');
    if (data.sources.some((source) => source.state === 'unavailable' || source.state === 'partial')) notices.push('חלק מהמקורות אינם מתעדכנים במלואם כרגע.');
    $('notice').textContent = notices.join(' '); $('notice').hidden = notices.length === 0;
  } catch (error) {
    if (error.name === 'AbortError' || requestId !== state.requestId) return;
    if (!append) { $('articles').replaceChildren(emptyState('העדכונים לא זמינים כרגע.', 'אפשר לנסות שוב בעוד רגע, או לקרוא ישירות באחד המקורות.', true)); $('result-count').textContent = ''; $('more').hidden = true; }
    else { $('notice').textContent = 'לא הצלחנו לטעון עדכונים נוספים. אפשר לנסות שוב.'; $('notice').hidden = false; }
    $('freshness').textContent = 'העדכון אינו זמין כרגע';
  } finally {
    if (requestId === state.requestId) {
      state.loading = false; $('articles').setAttribute('aria-busy', 'false'); $('more').disabled = false;
      if (refreshing && !append && state.refreshPolls < 60) {
        state.refreshPolls++;
        state.refreshTimer = setTimeout(() => {
          // Preserve an unsubmitted search and cancel stale polling on interaction.
          if (requestId === state.requestId && new URLSearchParams(new FormData($('filters'))).toString() === submittedFilters) load(false, true);
        }, 5000);
      }
    }
  }
}

$('filters').addEventListener('submit', (event) => { event.preventDefault(); load(); });
for (const field of ['source', 'category']) $(field).addEventListener('change', () => load());
$('search').addEventListener('search', () => load());
for (const order of ['broad', 'latest']) $(order).addEventListener('click', () => {
  state.order = order;
  for (const option of ['broad', 'latest']) $(option).setAttribute('aria-pressed', String(option === order));
  $('view-explanation').textContent = order === 'broad' ? 'סבב בין קטגוריות ומקורות, כדי לראות יותר מהתמונה.' : 'הפרסומים החדשים ביותר תחילה, לפי זמן הפרסום במקור.';
  load();
});
$('more').addEventListener('click', () => load(true));
renderSources([{ id: 'ynet', name: 'ynet', domain: 'ynet.co.il' }, { id: 'kan', name: 'כאן', domain: 'kan.org.il' }, { id: 'n12', name: 'N12', domain: 'n12.co.il' }, { id: 'mako', name: 'mako', domain: 'mako.co.il' }]);
load();
