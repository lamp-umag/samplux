// samplux — HTML allow-list for survey text (prompts, thank-you messages…).
// Surveys can now be written by any staff member and are rendered on the same origin as
// the admin pages, so a survey must never be able to run script. Only plain formatting
// survives; everything else is reduced to its text.
const TAGS = new Set(['A', 'B', 'BR', 'DIV', 'EM', 'H1', 'H2', 'H3', 'H4', 'I', 'IMG', 'LI', 'OL', 'P', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'U', 'UL']);
const DROP_WITH_CONTENT = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'NOSCRIPT', 'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'LINK', 'META', 'BASE']);
const SAFE_HREF = /^(https?:\/\/|mailto:|tel:|#)/i;
const SAFE_SRC = /^(https:\/\/|surveys\/assets\/|\.\/surveys\/assets\/)[^\s"'<>]*$/i;
const SAFE_CLASS = /^[\w\- ]{0,80}$/;

export function sanitizeHtml(html) {
  const s = String(html ?? '');
  if (!s.includes('<')) return s;                       // no markup: nothing to do (keeps "&" as typed)
  const tpl = document.createElement('template');       // inert: nothing loads or runs inside it
  tpl.innerHTML = s;
  clean(tpl.content);
  return tpl.innerHTML;
}

function clean(parent) {
  for (const node of [...parent.childNodes]) {
    if (node.nodeType === 3) continue;                  // text
    if (node.nodeType !== 1) { node.remove(); continue; }   // comments, etc.
    const tag = node.tagName.toUpperCase();
    if (DROP_WITH_CONTENT.has(tag)) { node.remove(); continue; }
    clean(node);
    if (!TAGS.has(tag)) { node.replaceWith(...node.childNodes); continue; }   // unwrap unknown tags
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      const v = attr.value.trim();
      const ok = (name === 'class' && SAFE_CLASS.test(v)) ||
        (tag === 'A' && name === 'href' && SAFE_HREF.test(v)) ||
        (tag === 'A' && name === 'title') ||
        (tag === 'IMG' && name === 'src' && SAFE_SRC.test(v)) ||
        (tag === 'IMG' && name === 'alt');
      if (!ok) node.removeAttribute(attr.name);
    }
    if (tag === 'A') { node.setAttribute('rel', 'noopener noreferrer'); node.setAttribute('target', '_blank'); }
    if (tag === 'IMG' && !node.getAttribute('src')) node.remove();
  }
}

/** Sanitizes every field of a survey that the runner renders as HTML. Returns the same object. */
export function sanitizeSurvey(survey) {
  for (const it of survey.items || []) {
    if (typeof it.prompt === 'string') it.prompt = sanitizeHtml(it.prompt);
    if (typeof it.exitMessage === 'string') it.exitMessage = sanitizeHtml(it.exitMessage);
  }
  if (survey.settings && typeof survey.settings.thankYou === 'string') survey.settings.thankYou = sanitizeHtml(survey.settings.thankYou);
  return survey;
}
