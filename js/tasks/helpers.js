export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const rand  = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const mean = arr =>
  arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : null;

export const pct = (n, total) =>
  total ? Math.round((n / total) * 100) : null;
