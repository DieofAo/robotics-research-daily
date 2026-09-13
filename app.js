'use strict';
const APP_VERSION = '2026-09-13-reader-v2';
const FAVORITES_KEY = 'robotics-daily-favorites-v1';
const FAVORITES_SEEN_KEY = 'robotics-daily-favorites-seen-v1';
let db = window.ROBOTICS_DAILY || { records: [], editions: [], briefs: [] };
const categories = [['all', '全部研究', '◈'], ['vla', 'VLA · 视觉语言动作', '⌘'], ['wam', 'WAM · 世界动作模型', '◎'], ['rl', 'RL · 强化学习', '↗'], ['theory', '经典机器人理论', '∑'], ['embodied', '操作、导航与具身', '⊞'], ['systems', '数据、评测与系统', '▤']];
const contentTypes = [['all', '全部', ''], ['paper', '论文', '▤'], ['news', 'News', '◉'], ['report', 'Report', '▥'], ['blog', 'Blog', '✎']];
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const safeUrl = value => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : '#'; } catch { return '#'; } };
const validDate = value => value && !Number.isNaN(new Date(value).getTime());
const dayOf = value => validDate(value) ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value)) : '';
const sourceDate = value => /^\d{4}-\d{2}-\d{2}/.exec(String(value || ''))?.[0] || '';
const shortTime = value => validDate(value) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '待更新';
const titleOf = value => categories.find(category => category[0] === value)?.[1] || '其他研究';
const shortCategory = value => titleOf(value).split(' · ')[0];
const recordTitle = record => record.zhTitle || record.title || '未命名研究';
const unique = values => [...new Set(values)];
const array = value => Array.isArray(value) ? value : [];
const tagIcon = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M1.5 1.5h5L12.5 7l-5.5 5.5L1.5 7z"/><circle cx="4.3" cy="4.3" r=".7"/></svg>';
let storageAvailable = true;
function readStored(key, fallback) { try { const parsed = JSON.parse(localStorage.getItem(key) || 'null'); return parsed || fallback; } catch { return fallback; } }
const storedFavorites = readStored(FAVORITES_KEY, { ids: [] });
let favoriteIds = new Set(array(storedFavorites.ids).filter(id => typeof id === 'string' && id.length < 300));
let favoriteSeen = readStored(FAVORITES_SEEN_KEY, {});
if (!favoriteSeen || typeof favoriteSeen !== 'object' || Array.isArray(favoriteSeen)) favoriteSeen = {};
let state = { mode: location.hash === '#favorites' ? 'favorites' : 'daily', day: '', category: 'all', type: 'all', query: '', month: '' };
let dateMap = new Map(), lookup = new Map(), searchIndex = new WeakMap(), refreshSequence = 0, refreshTimer;
function getTypes(record) {
  const explicit = array(record.contentTypes).filter(type => contentTypes.some(item => item[0] === type && type !== 'all'));
  if (explicit.length) return unique(explicit);
  const type = String(record.type || '').toLowerCase();
  const result = [];
  if (/arxiv|论文|预印本|paper/.test(type) || String(record.id).startsWith('arxiv:')) result.push('paper');
  if (/新闻|news|报道/.test(type)) result.push('news');
  if (/报告|report/.test(type)) result.push('report');
  if (/博客|blog/.test(type)) result.push('blog');
  return result.length ? result : [String(record.id).startsWith('report:') ? 'report' : 'paper'];
}
function scoreOf(record) {
  const score = record.popularity?.score;
  return record.popularity?.status === 'verified' && Number.isFinite(score) && array(record.popularity?.evidence).length ? score : -1;
}
function compareRecords(a, b) { return scoreOf(b) - scoreOf(a) || Number(!!b.featured) - Number(!!a.featured) || String(b.publishedAt || b.discoveredAt || '').localeCompare(String(a.publishedAt || a.discoveredAt || '')) || String(a.id).localeCompare(String(b.id)); }
function editionDay(edition) { return dayOf(edition.completedAt || edition.scheduledAt || edition.startedAt) || /^\d{4}-\d{2}-\d{2}/.exec(edition.id || '')?.[0] || ''; }
function normalize(value) { return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''); }
function searchText(record) { return [record.title, record.zhTitle, record.summary, record.background, record.innovation, record.experiments, record.conclusion, record.evaluation, record.futureDirections, ...array(record.tags), ...array(record.authors)].filter(Boolean).join(' '); }
function withinEditDistance(a, b, limit = 1) {
  if (Math.abs(a.length - b.length) > limit) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index), beforePrevious;
  for (let i = 1; i <= a.length; i++) {
    const row = [i]; let lowest = i;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j], beforePrevious[j - 2] + 1);
      lowest = Math.min(lowest, row[j]);
    }
    if (lowest > limit) return false;
    beforePrevious = previous; previous = row;
  }
  return previous[b.length] <= limit;
}
function matchesSearch(record, rawQuery) {
  const query = normalize(rawQuery).slice(0, 160);
  if (!query) return true;
  let index = searchIndex.get(record);
  if (!index) {
    const text = searchText(record).slice(0, 40000);
    index = { normalized: normalize(text), words: unique(text.toLowerCase().match(/[a-z0-9]{2,40}/g) || []), fuzzy: normalize([record.title, record.zhTitle, record.summary, record.innovation, ...array(record.tags)].filter(Boolean).join(' ')).slice(0, 9000) };
    searchIndex.set(record, index);
  }
  if (index.normalized.includes(query)) return true;
  const terms = rawQuery.toLowerCase().trim().split(/[\s,，;；]+/u).map(normalize).filter(Boolean).slice(0, 12);
  if (terms.length > 1 && terms.every(term => index.normalized.includes(term) || (/^[a-z0-9]{4,30}$/.test(term) && index.words.some(word => withinEditDistance(term, word))))) return true;
  if (/^[a-z0-9]{4,30}$/.test(query)) return index.words.some(word => withinEditDistance(query, word, query.length > 8 ? 2 : 1));
  if (/[^\x00-\x7F]/.test(query) && query.length >= 4 && query.length <= 14) {
    for (let offset = 0; offset <= index.fuzzy.length - query.length; offset++) {
      if (index.fuzzy[offset] !== query[0] && index.fuzzy[offset + 1] !== query[1]) continue;
      if (withinEditDistance(query, index.fuzzy.slice(offset, offset + query.length))) return true;
    }
  }
  return false;
}
function rebuild() {
  db.records = array(db.records); db.editions = array(db.editions); db.briefs = array(db.briefs);
  lookup = new Map([...db.briefs, ...db.records].map(record => [record.id, record]));
  dateMap = new Map(); searchIndex = new WeakMap();
  for (const edition of [...db.editions].sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')))) {
    const day = editionDay(edition); if (!day) continue;
    if (!dateMap.has(day)) dateMap.set(day, { editions: [], records: new Map(), briefIds: new Set(), fullIds: new Set(), ids: new Set() });
    const group = dateMap.get(day); group.editions.push(edition);
    const snapshots = new Map([...array(edition.briefsSnapshot), ...array(edition.recordsSnapshot)].map(record => [record.id, record]));
    const ids = unique([...array(edition.addedIds), ...array(edition.updatedIds), ...array(edition.rankedIds), ...array(edition.featuredIds), ...array(edition.briefIds), ...snapshots.keys()]);
    const ranked = array(edition.rankedIds).length ? edition.rankedIds : ids.filter(id => lookup.has(id)).sort((a, b) => compareRecords(lookup.get(a), lookup.get(b)));
    const full = Array.isArray(edition.featuredIds) ? edition.featuredIds : ranked.filter(id => lookup.get(id)?.background || snapshots.get(id)?.background).slice(0, 30);
    for (const id of ids) {
      const latest = lookup.get(id), snapshot = snapshots.get(id), record = snapshot ? { ...latest, ...snapshot, contentTypes: latest?.contentTypes || snapshot.contentTypes, popularity: latest?.popularity || snapshot.popularity } : latest;
      if (!record) continue;
      group.records.set(id, record); group.ids.add(id);
      if (full.includes(id) && record.background) group.fullIds.add(id); else group.briefIds.add(id);
    }
  }
  for (const brief of db.briefs) {
    if ([...dateMap.values()].some(group => group.ids.has(brief.id))) continue;
    const day = dayOf(brief.discoveredAt); if (!day) continue;
    if (!dateMap.has(day)) dateMap.set(day, { editions: [], records: new Map(), briefIds: new Set(), fullIds: new Set(), ids: new Set() });
    const group = dateMap.get(day); group.records.set(brief.id, brief); group.briefIds.add(brief.id); group.ids.add(brief.id);
  }
  const dates = [...dateMap.keys()].sort().reverse();
  if (!state.day) state.day = dates[0] || dayOf(new Date());
  if (!state.month) state.month = (state.day === 'all' ? dates[0] || dayOf(new Date()) : state.day).slice(0, 7);
}
function scopedRecords() {
  if (state.mode === 'favorites') return [...favoriteIds].map(id => lookup.get(id)).filter(Boolean);
  if (state.day === 'all') return [...lookup.values()];
  return [...(dateMap.get(state.day)?.records.values() || [])];
}
function matches(record, options = {}) {
  return (options.ignoreCategory || state.category === 'all' || record.category === state.category || array(record.tags).includes(state.category)) && (options.ignoreType || state.type === 'all' || getTypes(record).includes(state.type)) && (options.ignoreQuery || matchesSearch(record, state.query));
}
function dayRecords(day) { return [...(dateMap.get(day)?.records.values() || [])]; }
function signature(record) { return String(record.changeId || '') + '|' + String(record.updatedAt || '') + '|' + String(record.version || '') + '|' + String(record.changeNote || ''); }
function hasFavoriteUpdate(record) { return favoriteIds.has(record.id) && !!favoriteSeen[record.id] && favoriteSeen[record.id] !== signature(record); }
function storeFavorites() {
  try { localStorage.setItem(FAVORITES_KEY, JSON.stringify({ ids: [...favoriteIds], updatedAt: new Date().toISOString() })); localStorage.setItem(FAVORITES_SEEN_KEY, JSON.stringify(favoriteSeen)); storageAvailable = true; }
  catch { storageAvailable = false; $('favorites-feedback').textContent = '浏览器暂不允许保存。当前收藏仅在本页保留，请导出备份。'; }
}
function normalizeFavoriteAliases() {
  const aliases = new Map([...lookup.values()].flatMap(record => array(record.aliasIds).map(id => [id, record.id])));
  let changed = false;
  for (const id of [...favoriteIds]) {
    const canonical = aliases.get(id);
    if (!canonical || canonical === id) continue;
    favoriteIds.delete(id); favoriteIds.add(canonical);
    if (!favoriteSeen[canonical] && favoriteSeen[id]) favoriteSeen[canonical] = favoriteSeen[id];
    delete favoriteSeen[id]; changed = true;
  }
  if (changed) storeFavorites();
}
function favoriteButton(record) { const active = favoriteIds.has(record.id); return `<button type="button" class="favorite-toggle" data-favorite="${esc(record.id)}" aria-pressed="${active}" aria-label="${active ? '取消收藏' : '收藏'}：${esc(recordTitle(record))}" title="${active ? '取消收藏' : '收藏研究'}">${active ? '★' : '☆'}</button>`; }
function badges(record) { return `<span class="tag">${tagIcon}${esc(shortCategory(record.category))}</span>${getTypes(record).map(type => `<span class="tag neutral">${esc(contentTypes.find(item => item[0] === type)?.[1] || type)}</span>`).join('')}${hasFavoriteUpdate(record) ? '<span class="tag amber">收藏后有更新</span>' : ''}${record.changeType === 'updated' ? '<span class="tag amber">实质更新</span>' : ''}`; }
function recordLinks(record) {
  const links = [{ label: '原始来源', url: record.canonicalUrl }, ...array(record.links)];
  const seen = new Set();
  return links.filter(link => { const url = safeUrl(link.url); if (url === '#' || seen.has(url)) return false; seen.add(url); return true; }).map(link => `<a href="${esc(safeUrl(link.url))}" target="_blank" rel="noopener noreferrer">${esc(link.label || '研究链接')} <span aria-hidden="true">↗</span></a>`).join('');
}
function revisionNote(record) {
  const updated = hasFavoriteUpdate(record), history = array(record.revisionHistory || record.history);
  if (!updated && !record.changeNote && !record.dateNote) return '';
  const note = updated ? `你收藏的研究有新进展。${record.changeNote || history.at(-1)?.changeNote || (record.version ? '当前版本 ' + record.version + '。' : '分析内容已更新。')}` : record.changeNote || record.dateNote;
  return `<div class="change-note">${esc(note)}${updated ? `<button type="button" class="text-button" data-seen="${esc(record.id)}">标记已读 ✓</button>` : ''}</div>`;
}
function card(record) {
  const fields = [['研究背景', 'background'], ['核心创新', 'innovation'], ['实验与证据', 'experiments'], ['研究结论', 'conclusion'], ['评价与局限', 'evaluation'], ['可能的发展方向', 'futureDirections']];
  const anchor = 'paper-' + record.id;
  return `<article class="paper" id="${esc(anchor)}" data-record-id="${esc(record.id)}"><div class="paper-top"><div class="paper-heading-row"><div class="paper-meta">${badges(record)}</div>${favoriteButton(record)}</div><h3><a href="${esc(safeUrl(record.canonicalUrl))}" target="_blank" rel="noopener noreferrer">${esc(recordTitle(record))}</a></h3>${record.zhTitle && record.title ? `<p class="en-title">${esc(record.title)}</p>` : ''}<p class="paper-summary">${esc(record.summary || record.innovation || '')}</p><div class="paper-footer"><div class="record-date">原文日期 ${esc(sourceDate(record.publishedAt) || '日期待核实')}${record.version ? ' · ' + esc(record.version) : ''}<br>收录 ${esc(shortTime(record.discoveredAt))}${record.updatedAt && record.updatedAt !== record.discoveredAt ? ' · 更新 ' + esc(shortTime(record.updatedAt)) : ''}</div><div class="links">${recordLinks(record)}</div></div>${state.mode === 'favorites' ? `<p class="favorite-source">跟踪原始来源：<a href="${esc(safeUrl(record.canonicalUrl))}" target="_blank" rel="noopener noreferrer">${esc(record.canonicalUrl || '待补充')}</a></p>` : ''}</div>${revisionNote(record)}<details class="analysis-details"><summary>阅读完整分析 <span class="analysis-hint">背景 · 创新 · 实验 · 结论 · 评价 · 展望</span></summary><div class="analysis-grid">${fields.map(([label, key], index) => `<section class="analysis-section ${index >= 4 ? 'editorial' : ''}"><h4><span>0${index + 1}</span>${label}${index >= 4 ? ' · 编辑分析' : ''}</h4><p>${esc(record[key] || '目前没有足够原文证据，待核实补充。').replace(/\n/g, '<br>')}</p></section>`).join('')}</div><div class="evidence-notes"><h4>原文依据 · ${esc(record.evidence || '以所列原始资料为准')}</h4>${array(record.evidenceDetails).map(evidence => `<p><a href="${esc(safeUrl(evidence.url))}" target="_blank" rel="noopener noreferrer">${esc(evidence.location || '原文')} ↗</a> · ${esc(evidence.supports)}</p>`).join('')}${record.popularity?.basis ? `<p>关注度依据：${esc(record.popularity.basis)}</p>` : ''}</div></details></article>`;
}
function briefCard(record, unresolved = false) {
  const status = unresolved ? '待全文核验' : '创新点速览';
  return `<article class="brief-card" id="paper-${esc(record.id)}" data-record-id="${esc(record.id)}"><div class="paper-heading-row"><div class="paper-meta">${badges(record)}<span class="tag ${unresolved ? 'amber' : 'neutral'}">${status}</span></div>${favoriteButton(record)}</div><h3>${esc(recordTitle(record))}</h3><p>${esc(record.innovation || record.summary || '创新点仍待核实。')}</p><div class="links">${recordLinks(record)}</div><p class="brief-meta">${record.publishedAt ? '原文日期 ' + esc(sourceDate(record.publishedAt)) + ' · ' : ''}${esc(record.evidence || (unresolved ? '当前为候选线索，尚未完成全文核验。' : '已归档，保留核心创新点。'))}</p>${state.mode === 'favorites' ? `<p class="favorite-source">跟踪原始来源：<a href="${esc(safeUrl(record.canonicalUrl))}" target="_blank" rel="noopener noreferrer">${esc(record.canonicalUrl || '待补充')}</a></p>` : ''}${revisionNote(record)}</article>`;
}
function renderCalendar() {
  const [year, month] = state.month.split('-').map(Number), first = new Date(Date.UTC(year, month - 1, 1)), offset = (first.getUTCDay() + 6) % 7, days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  $('calendar-month').textContent = `${year} 年 ${month} 月`;
  let html = '<span aria-hidden="true"></span>'.repeat(offset);
  for (let day = 1; day <= days; day++) {
    const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, count = dateMap.get(key)?.ids.size || 0, available = dateMap.has(key), selected = state.day === key && state.mode === 'daily';
    html += `<button type="button" class="calendar-day ${available ? 'available' : ''} ${selected ? 'selected' : ''} ${dayOf(new Date()) === key ? 'today' : ''}" data-day="${key}" ${available ? '' : 'disabled'} aria-label="${year}年${month}月${day}日${available ? '，' + count + '项研究' : '，暂无归档'}" aria-pressed="${selected}">${day}${count ? `<small>${count}</small>` : ''}</button>`;
  }
  $('calendar-days').innerHTML = html;
  $('date-input').value = state.day === 'all' ? '' : state.day;
  $('all-history').setAttribute('aria-pressed', String(state.day === 'all' && state.mode === 'daily'));
}
function renderFilters(records) {
  $('categories').innerHTML = categories.map(([id, label, symbol]) => `<button type="button" class="nav-item ${state.category === id ? 'active' : ''}" data-category="${id}" aria-pressed="${state.category === id}"><span class="symbol" aria-hidden="true">${symbol}</span><span>${esc(label)}</span><span class="count">${records.filter(record => (id === 'all' || record.category === id || array(record.tags).includes(id)) && matches(record, { ignoreCategory: true })).length}</span></button>`).join('');
  $('content-types').innerHTML = contentTypes.map(([id, label, icon]) => `<button type="button" class="type-chip ${state.type === id ? 'active' : ''}" data-type="${id}" aria-pressed="${state.type === id}">${icon ? `<span aria-hidden="true">${icon}</span>` : ''}${esc(label)}<span class="type-count">${records.filter(record => (id === 'all' || getTypes(record).includes(id)) && matches(record, { ignoreType: true })).length}</span></button>`).join('');
}
function renderHighlights() {
  const node = $('highlights');
  if (state.mode === 'favorites' || state.day === 'all' || state.query || state.category !== 'all' || state.type !== 'all') { node.hidden = true; node.innerHTML = ''; return; }
  const records = dayRecords(state.day), daily = db.dailyHighlights?.[state.day];
  const candidateMap = new Map(records.map(record => [record.id, record]));
  const top = (array(daily?.top5Ids).length ? daily.top5Ids.map(id => candidateMap.get(id)).filter(Boolean) : [...records].sort(compareRecords)).slice(0, 5);
  if (!top.length) { node.hidden = true; node.innerHTML = ''; return; }
  const note = daily?.rankingNote || '有可核实关注度证据的研究优先；证据不足时，结合研究价值与新近程度选读。此处不代表全网绝对热度排名。';
  node.hidden = false;
  node.innerHTML = `<div class="section-heading"><h2>本日 <em>Top ${top.length}</em></h2><p>${esc(daily?.summary && daily.summary.length <= 70 ? daily.summary : '从今天的研究中，先读这几篇。')}</p></div><div class="highlights-grid">${top.map((record, index) => `<article class="highlight-card"><span class="highlight-number">${String(index + 1).padStart(2, '0')}</span><span class="highlight-category">${esc(shortCategory(record.category))}${!record.background ? ' · 待全文核验' : ''}</span><h3><a href="#${encodeURIComponent('paper-' + record.id)}" data-jump="${esc(record.id)}">${esc(recordTitle(record))}<span class="highlight-arrow" aria-hidden="true">↗</span></a></h3><p>${esc(record.highlightSummary || record.innovation || record.summary || '')}</p></article>`).join('')}</div><details class="ranking-note"><summary>ⓘ 排序依据</summary><p>${esc(note)}</p></details>`;
}
function render() {
  normalizeFavoriteAliases();
  const records = scopedRecords(), filtered = records.filter(record => matches(record)).sort(compareRecords), group = dateMap.get(state.day), favorites = state.mode === 'favorites';
  renderCalendar(); renderFilters(records); renderHighlights();
  $('favorite-count').textContent = favoriteIds.size;
  if (favorites) $('favorites-link').setAttribute('aria-current', 'page'); else $('favorites-link').removeAttribute('aria-current');
  $('favorites-tools').hidden = !favorites;
  $('page-eyebrow').textContent = favorites ? 'YOUR RESEARCH LIBRARY' : 'RESEARCH NOTEBOOK';
  $('page-title').textContent = favorites ? '我的研究收藏' : state.day === 'all' ? '所有值得读的研究' : '值得读的机器人研究';
  const dateLabel = state.day === 'all' ? '全部历史' : `${state.day.slice(0, 4)} 年 ${Number(state.day.slice(5, 7))} 月 ${Number(state.day.slice(8, 10))} 日`;
  const missing = [...favoriteIds].filter(id => !lookup.has(id)).length;
  $('page-subtitle').textContent = favorites ? `${favoriteIds.size} 项收藏 · 持续积累自己的研究线索${missing ? ' · ' + missing + ' 项暂不在当前归档' : ''}` : `${dateLabel} · ${records.length} 项研究${state.day !== 'all' && group?.editions.length > 1 ? ' · 已合并本日 ' + group.editions.length + ' 次更新' : ''}`;
  $('day-stamp').textContent = favorites ? '★' : state.day === 'all' ? '∞' : state.day.slice(8, 10);
  const complete = [], briefs = [], candidates = [];
  for (const record of filtered) {
    const full = favorites || state.day === 'all' ? !!record.background : group?.fullIds.has(record.id) && !!record.background;
    if (full) complete.push(record); else if (!record.background) candidates.push(record); else briefs.push(record);
  }
  $('result-title').textContent = state.query ? '搜索结果' : state.category !== 'all' ? shortCategory(state.category) : favorites ? '收藏的研究' : state.day === 'all' ? '全部研究' : '本日研究';
  $('result-count').textContent = `${filtered.length} 项${complete.length ? ' · ' + complete.length + ' 篇完整分析' : ''}${briefs.length + candidates.length ? ' · ' + (briefs.length + candidates.length) + ' 条简讯' : ''}`;
  const filtering = !!state.query || state.category !== 'all' || state.type !== 'all';
  $('filter-note').hidden = !filtering;
  $('filter-note').textContent = [state.query ? `搜索「${state.query}」· 支持近似拼写与关键词组合` : '', state.category !== 'all' ? titleOf(state.category) : '', state.type !== 'all' ? contentTypes.find(type => type[0] === state.type)?.[1] : ''].filter(Boolean).join(' ／ ');
  if (filtered.length) {
    $('reports').innerHTML = complete.map(card).join('');
    $('briefs').innerHTML = `${briefs.length ? `<details class="brief-section" ${filtering || favorites ? 'open' : ''}><summary><span>更多研究 · ${briefs.length}</span><small>展开阅读创新点 ↓</small></summary><p class="brief-intro">本轮精选之外的研究，也保留值得关注的创新点。</p>${briefs.map(record => briefCard(record)).join('')}</details>` : ''}${candidates.length ? `<details class="brief-section" ${filtering || favorites ? 'open' : ''}><summary><span>研究线索 · ${candidates.length}</span><small>待全文核验 ↓</small></summary><p class="brief-intro">以下为已发现的研究线索。创新点来自当前可核实材料，完整实验与评价待补充。</p>${candidates.map(record => briefCard(record, true)).join('')}</details>` : ''}`;
  } else {
    const emptyTitle = favorites && !favoriteIds.size ? '把值得跟进的研究，放进收藏' : state.query ? '暂时没有匹配的研究' : !dateMap.has(state.day) && state.day !== 'all' && !favorites ? '这一天还没有日报' : '当前筛选下暂无研究';
    const emptyText = favorites && !favoriteIds.size ? '点击研究卡片右上角的 ☆，在这里查看原文和后续变化。' : filtering ? '试试更短的关键词，或重置研究方向与内容类型。' : '可以选择日历中有记录的日期，或浏览全部历史。';
    $('reports').innerHTML = `<div class="empty"><span class="empty-symbol" aria-hidden="true">${favorites ? '☆' : '⌕'}</span><h3>${emptyTitle}</h3><p>${emptyText}</p>${favorites && !favoriteIds.size ? '<a href="#daily">去阅读研究 ↗</a>' : '<button type="button" data-reset="true">重置筛选</button>'}</div>`;
    $('briefs').innerHTML = '';
  }
  const latest = [...db.editions].sort((a, b) => String(b.completedAt || b.startedAt || '').localeCompare(String(a.completedAt || a.startedAt || '')))[0];
  $('last-update').textContent = latest ? `归档更新 ${shortTime(latest.completedAt || latest.startedAt)}` : '等待归档';
  $('archive-count').textContent = `${db.records.length} 篇完整研究 · ${dateMap.size} 天归档`;
  if (!storageAvailable) $('favorites-feedback').textContent = '浏览器暂不允许保存。当前收藏仅在本页保留，请导出备份。';
}
function setDay(day) { state.mode = 'daily'; state.day = day; if (day !== 'all') state.month = day.slice(0, 7); if (location.hash === '#favorites') history.replaceState(null, '', location.pathname + location.search + '#daily'); render(); }
function resetFilters() { state.category = 'all'; state.type = 'all'; state.query = ''; $('search').value = ''; render(); }
function moveMonth(delta) { const [year, month] = state.month.split('-').map(Number), date = new Date(Date.UTC(year, month - 1 + delta, 1)); state.month = date.toISOString().slice(0, 7); renderCalendar(); }
function showBanner(message, version) {
  $('version-banner').hidden = false;
  $('version-banner').innerHTML = `${esc(message)}${version ? '<button type="button" id="load-new-version">打开新版 ↗</button>' : ''}`;
  if (version) $('load-new-version').onclick = () => { const url = new URL(location.href); url.searchParams.set('v', version); location.assign(url.href); };
}
async function checkVersion() {
  if (location.protocol === 'file:') return;
  try {
    const response = await fetch('./site-manifest.json?t=' + Date.now(), { cache: 'no-store' });
    if (!response.ok) return;
    const manifest = await response.json();
    const currentAssets = document.querySelector('meta[name="robotics-build"]')?.content;
    if ((manifest.appVersion && manifest.appVersion !== APP_VERSION) || (manifest.assetsVersion && currentAssets && manifest.assetsVersion !== currentAssets)) showBanner('阅读页面已有新版本，点击即可切换。', manifest.assetsVersion || manifest.appVersion);
  } catch { /* Keep the already loaded reading experience usable. */ }
}
async function refreshData(manual = false) {
  if (location.protocol === 'file:') { if (manual) $('refresh-status').textContent = '当前为离线副本，联网版更新后可重新下载。'; return; }
  const sequence = ++refreshSequence, previousLatest = [...dateMap.keys()].sort().at(-1), followLatest = state.day === previousLatest;
  $('refresh').disabled = true; if (manual) $('refresh-status').textContent = '正在检查最新归档…';
  try {
    const response = await fetch('./data.json?t=' + Date.now(), { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    if (!Array.isArray(data.records) || !Array.isArray(data.editions)) throw new Error('归档格式不可用');
    if (sequence !== refreshSequence) return;
    const changed = JSON.stringify(data) !== JSON.stringify(db);
    db = data; window.ROBOTICS_DAILY = db; rebuild();
    if (followLatest && state.mode === 'daily') { state.day = [...dateMap.keys()].sort().at(-1) || state.day; state.month = state.day.slice(0, 7); }
    if (changed) render();
    $('refresh-status').textContent = changed ? '已加载最新归档' : manual ? '已是最新归档' : '';
  } catch {
    if (sequence === refreshSequence) $('refresh-status').textContent = db.records.length ? '暂未连上最新归档，当前内容仍可阅读' : '归档暂时无法读取，请稍后刷新';
  } finally { if (sequence === refreshSequence) $('refresh').disabled = false; }
  await checkVersion();
}
document.addEventListener('click', event => {
  const button = event.target.closest('button, a[data-jump]'); if (!button) return;
  if (button.dataset.category) { state.category = button.dataset.category; render(); }
  if (button.dataset.type) { state.type = button.dataset.type; render(); }
  if (button.dataset.day) setDay(button.dataset.day);
  if (button.dataset.reset) resetFilters();
  if (button.dataset.favorite) {
    const id = button.dataset.favorite, scroll = window.scrollY;
    if (favoriteIds.has(id)) { favoriteIds.delete(id); delete favoriteSeen[id]; }
    else { favoriteIds.add(id); if (lookup.has(id)) favoriteSeen[id] = signature(lookup.get(id)); }
    storeFavorites(); render(); window.scrollTo({ top: scroll, behavior: 'instant' });
    document.querySelector(`[data-favorite="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  }
  if (button.dataset.seen) { const record = lookup.get(button.dataset.seen); if (record) { favoriteSeen[record.id] = signature(record); storeFavorites(); render(); } }
  if (button.dataset.jump) {
    event.preventDefault();
    const target = document.getElementById('paper-' + button.dataset.jump);
    if (target) {
      target.closest('.brief-section')?.setAttribute('open', '');
      target.querySelector('.analysis-details')?.setAttribute('open', '');
      history.replaceState(null, '', location.pathname + location.search + '#' + encodeURIComponent(target.id));
      target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }
});
$('month-prev').addEventListener('click', () => moveMonth(-1));
$('month-next').addEventListener('click', () => moveMonth(1));
$('date-input').addEventListener('change', event => { if (/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)) setDay(event.target.value); });
$('latest-day').addEventListener('click', () => setDay([...dateMap.keys()].sort().at(-1) || dayOf(new Date())));
$('all-history').addEventListener('click', () => setDay('all'));
$('clear-filters').addEventListener('click', resetFilters);
$('search').addEventListener('input', event => { state.query = event.target.value.trim(); clearTimeout(refreshTimer); refreshTimer = setTimeout(render, 120); });
$('refresh').addEventListener('click', () => refreshData(true));
$('toggle-filters').addEventListener('click', () => {
  const expanded = $('toggle-filters').getAttribute('aria-expanded') !== 'true';
  $('toggle-filters').setAttribute('aria-expanded', String(expanded));
  $('sidebar-filters').classList.toggle('is-open', expanded);
});
window.addEventListener('hashchange', () => { if (location.hash === '#favorites') { state.mode = 'favorites'; resetFilters(); } else if (location.hash === '#daily' || !location.hash) { state.mode = 'daily'; resetFilters(); } });
window.addEventListener('storage', event => { if (event.key === FAVORITES_KEY || event.key === FAVORITES_SEEN_KEY) { const saved = readStored(FAVORITES_KEY, { ids: [] }); favoriteIds = new Set(array(saved.ids).filter(id => typeof id === 'string' && id.length < 300)); favoriteSeen = readStored(FAVORITES_SEEN_KEY, {}); if (!favoriteSeen || typeof favoriteSeen !== 'object' || Array.isArray(favoriteSeen)) favoriteSeen = {}; render(); } });
$('export-favorites').addEventListener('click', () => {
  const backup = { schemaVersion: 1, ids: [...favoriteIds], updatedAt: new Date().toISOString(), records: [...favoriteIds].map(id => lookup.get(id)).filter(Boolean).map(record => ({ id: record.id, title: recordTitle(record), canonicalUrl: record.canonicalUrl })), seen: favoriteSeen };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = `robotics-favorites-${dayOf(new Date())}.json`; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('favorites-feedback').textContent = `已导出 ${favoriteIds.size} 项收藏。`;
});
$('import-favorites').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file) return;
  try {
    if (file.size > 1024 * 1024) throw new Error('文件超过 1 MB，请选择收藏备份文件。');
    const parsed = JSON.parse(await file.text()), ids = array(parsed.ids);
    if (!Array.isArray(parsed.ids) || ids.length > 5000 || ids.some(id => typeof id !== 'string' || !id || id.length > 300)) throw new Error('这不是有效的收藏备份，请选择导出的 JSON 文件。');
    const before = favoriteIds.size;
    for (const id of ids) { favoriteIds.add(id); if (typeof parsed.seen?.[id] === 'string') favoriteSeen[id] = parsed.seen[id]; else if (!favoriteSeen[id] && lookup.has(id)) favoriteSeen[id] = signature(lookup.get(id)); }
    storeFavorites(); render();
    $('favorites-feedback').textContent = storageAvailable ? `已导入 ${favoriteIds.size - before} 项新收藏，原有收藏已保留。` : '已导入当前页面，但浏览器未允许保存，请保留备份。';
  } catch (error) { $('favorites-feedback').textContent = error instanceof SyntaxError ? '无法读取这个文件，请选择有效的收藏 JSON 备份。' : error.message; }
  event.target.value = '';
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { refreshData(false); checkVersion(); } });
setInterval(() => { if (document.visibilityState === 'visible') refreshData(false); }, 5 * 60 * 1000);
rebuild(); render(); refreshData(false);
window.ROBOTICS_DAILY_UI = { version: APP_VERSION, dayOf, getTypes, compareRecords, matchesSearch, withinEditDistance, getState: () => ({ ...state }), getDailyCount: day => dateMap.get(day)?.ids.size || 0 };
