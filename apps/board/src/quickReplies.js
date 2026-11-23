// One-click answers to an agent's choice question: the items of the last list in its
// final message, or Yes / No for a closed question.

const MAX_CHOICES = 6;
const MAX_LABEL = 60;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.+)$/;
const BULLET = /^(\s*)[-*+]\s+(.+)$/;
const FENCE = /^\s*(```|~~~)/;
const BOLD = /^(\*\*|__)(.+?)\1/;
// A dash between spaces, or a colon followed by a space: not the colon of a URL or a time.
const SEPARATOR = / [—–-] |: /;
// How a closed question starts, in English and in French.
const AUXILIARY = /^(should|shall|do|does|can|could|would|will|is|are|may|dois-je|faut-il|veux-tu|voulez-vous|souhaites-tu|souhaitez-vous|est-ce)\b/;
// "Tabs or spaces?" is a choice, not a yes / no.
const ALTERNATIVE = /\s(or|ou)\s/;

/** An agent turn that ends on a question is waiting for the user. */
export function asksQuestion(text) {
  const lastLine = String(text ?? '').trim().split('\n').at(-1);
  return /\?[\s*_`)"»]*$/.test(lastLine);
}

function listItem(line) {
  const ordered = ORDERED.exec(line);
  if (ordered) return { indent: ordered[1].length, n: ordered[2], text: ordered[3] };
  const bullet = BULLET.exec(line);
  return bullet ? { indent: bullet[1].length, n: null, text: bullet[2] } : null;
}

// The first-level items of the last list outside code fences; blank lines and deeper
// (nested) items inside a list keep it open.
function lastList(lines) {
  let list = [];
  let indent = null;
  let fenced = false;
  for (const line of lines) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      indent = null;
      continue;
    }
    const item = fenced ? null : listItem(line);
    if (item) {
      if (indent === null) {
        list = [];
        indent = item.indent;
      }
      if (item.indent <= indent) list.push(item);
    } else if (line.trim() !== '') {
      indent = null;
    }
  }
  return list;
}

function label(text) {
  const bold = BOLD.exec(text);
  const head = bold ? bold[2] : text.split(SEPARATOR)[0];
  return head.replace(/[*_`]/g, '').trim().slice(0, MAX_LABEL).trim();
}

function closedQuestion(content) {
  const lastLine = content.trim().split('\n').filter((line) => line.includes('?')).at(-1);
  const sentence = lastLine.split(/(?<=[.!])\s+/).at(-1).trim().toLowerCase();
  return AUXILIARY.test(sentence) && !ALTERNATIVE.test(sentence);
}

function choices(items) {
  const seen = new Set();
  const out = [];
  for (const { n, text } of items) {
    const name = label(text);
    const sent = n ? `${n}. ${name}` : name;
    if (!name || seen.has(sent)) continue;
    seen.add(sent);
    out.push({ label: name, text: sent });
  }
  return out.slice(0, MAX_CHOICES);
}

/** The quick replies for `messages`, or [] when its last message is not a choice question. */
export function quickReplies(messages, { yes, no }) {
  const last = messages.at(-1);
  if (!last || last.role !== 'agent' || last.kind !== 'text' || !asksQuestion(last.content)) return [];
  // A closed question wins over a list: the list is then what was done, not what to choose.
  if (closedQuestion(last.content)) return [{ label: yes, text: yes }, { label: no, text: no }];
  return choices(lastList(last.content.split('\n')));
}
