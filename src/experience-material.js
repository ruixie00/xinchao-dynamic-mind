// Read-only local projection. Never fetch memory or consume/delete a note.
export function buildExperienceMaterial(state, { now = new Date(), maxChars = 3000, cycleId } = {}) {
  const rows = [];
  const seen = new Set();
  const clean = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  function add(source, value, at, eligible = true) {
    const text = clean(value);
    if (!text || !/\p{L}/u.test(text) || seen.has(text)) return;
    seen.add(text);
    rows.push({ source, text, at: clean(at), eligible });
  }
  const notes = (Array.isArray(state.handoffNotes) ? state.handoffNotes : [])
    .filter(item => Date.parse(item?.expiresAt) > now.getTime())
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 6);
  for (const item of notes) add('handoff-note', item.note, item.createdAt);
  for (const item of state.thoughtPool?.flash ?? []) add('flash', item.text, item.createdAt);
  for (const item of state.thoughtPool?.obsessions ?? []) add('ongoing-thought', item.text, item.createdAt);
  for (const type of ['thought', 'daytime', 'dream']) {
    const items = state.proactive?.experiences?.[type] ?? [];
    for (const item of items.filter(item => item.cycleId !== cycleId).slice(-3).reverse()) {
      add(`internal-${type} (not external fact)`, item.text, item.createdAt, type !== 'dream' && item.source !== 'rules');
    }
  }
  for (const item of (state.recentDreams ?? []).slice(-3).reverse()) {
    add('internal-dream (not external fact)', item.dream, item.createdAt, false);
  }
  let text = '', materialChars = 0;
  const sources = [];
  const budget = Math.max(0, Math.min(10000, Number(maxChars) || 0));
  for (const row of rows) {
    const prefix = `${text ? '\n' : ''}[${row.source}${row.at ? ` at ${row.at}` : ''}] `;
    const remaining = budget - text.length - prefix.length;
    if (remaining <= 0) break;
    const content = row.text.slice(0, Math.min(1200, remaining));
    text += prefix + content;
    if (row.eligible) materialChars += content.length;
    sources.push(row.source);
  }
  return { text, materialChars, sources };
}
