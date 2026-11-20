// samplux — look & feel preferences for interviewer mode (device-local; tuned in encuestador-lab.html).
export const DEFAULTS = {
  layout: 'horizontal',      // 'horizontal' | 'vertical'
  cardStyle: 'compact',      // 'compact' (title strip) | 'deck' (full cards overlapping)
  activeW: 620,              // px, width of the centre card (horizontal)
  activeBorder: 3,           // px
  gap: 12,                   // px between cards
  compactW: 190,             // px, neighbour width in compact style
  deckW: 300,                // px, neighbour width in deck style (horizontal)
  deckH: 190,                // px, visible height of a neighbour in deck style (vertical)
  overlap: 120,              // px, how much neighbours slide under the next card
  scale: 0.94,               // neighbour scale
  opacity: 0.92,             // neighbour opacity
  shadow: true,              // soft shadow on the centre card
  fontScale: 1               // multiplies the centre card text size
};
const KEY = 'samplux.enc.prefs';

export function loadPrefs() {
  try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY)) || {}) }; } catch { return { ...DEFAULTS }; }
}
export function savePrefs(p) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ } }
export function resetPrefs() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }

export function applyPrefs(p, root = document.body) {
  const s = root.style;
  s.setProperty('--enc-active-w', `${p.activeW}px`);
  s.setProperty('--enc-active-border', `${p.activeBorder}px`);
  s.setProperty('--enc-gap', `${p.gap}px`);
  s.setProperty('--enc-compact-w', `${p.compactW}px`);
  s.setProperty('--enc-deck-w', `${p.deckW}px`);
  s.setProperty('--enc-deck-h', `${p.deckH}px`);
  s.setProperty('--enc-overlap', `${p.overlap}px`);
  s.setProperty('--enc-scale', String(p.scale));
  s.setProperty('--enc-opacity', String(p.opacity));
  s.setProperty('--enc-shadow', p.shadow ? '0 18px 40px -22px rgba(0,0,0,.45)' : 'none');
  s.setProperty('--enc-font', String(p.fontScale));
  root.dataset.layout = p.layout;
  root.dataset.cards = p.cardStyle;
}
