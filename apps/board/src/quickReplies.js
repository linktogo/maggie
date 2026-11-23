// One-click answers to an agent's choice question: the items of the last list in its
// final message, or Yes / No for a closed question without a list.

const MAX_CHOICES = 6;
const MAX_LABEL = 60;
const ORDERED = /^\s*(\d+)[.)]\s+(.+)$/;
const BULLET = /^\s*[-*+]\s+(.+)$/;
const BOLD = /^(\*\*|__)(.+?)\1/;
const SEPARATOR = / [—–-] |:/;
// How a closed question starts, in English and in French.
const AUXILIARY = /^(should|shall|do|does|can|could|would|will|is|are|may|dois-je|faut-il|veux-tu|voulez-vous|souhaites-tu|souhaitez-vous|est-ce)\b/;

/** An agent turn that ends on a question is waiting for the user. */
export function asksQuestion(text) {
  const lastLine = String(text ?? '').trim().split('\n').at(-1);
  return /\?[\s*_`)"»]*$/.test(lastLine);
}

// The items of the last list: consecutive list lines, blank lines between them allowed.
function lastList(lines) {
  let list = [];
  let open = false;
  for (const line of lines) {
    const ordered = ORDERED.exec(line);
    const bullet = ordered ? null : BULLET.exec(line);
    if (ordered || bullet) {
      if (!open) list = [];
      open = true;
      list.push(ordered ? { n: ordered[1], text: ordered[2] } : { n: null, text: bullet[1] });
    } else if (line.trim() !== '') {
      open = false;
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
  return AUXILIARY.test(sentence);
}

/** The quick replies for `messages`, or [] when its last message is not a choice question. */
export function quickReplies(messages, { yes, no }) {
  const last = messages.at(-1);
  if (!last || last.role !== 'agent' || last.kind !== 'text' || !asksQuestion(last.content)) return [];
  const items = lastList(last.content.split('\n'));
  if (items.length > 0) {
    return items.slice(0, MAX_CHOICES).map(({ n, text }) => {
      const name = label(text);
      return { label: name, text: n ? `${n}. ${name}` : name };
    });
  }
  return closedQuestion(last.content) ? [{ label: yes, text: yes }, { label: no, text: no }] : [];
}
