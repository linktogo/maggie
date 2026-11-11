import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Links open in a new tab; set after sanitising so the attributes survive.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

// Raw HTML never gets to swallow the markdown after it on the same line (a
// block-level tag would otherwise turn the rest of the line into literal text):
// block HTML is re-read as inline content, and DOMPurify decides what survives.
marked.use({
  walkTokens(token) {
    if (token.type === 'html' && token.block) {
      token.type = 'paragraph';
      token.tokens = marked.Lexer.lexInline(token.raw.trim());
    }
  },
});

// Explicit allowlist: only what rendered markdown needs. No style/form/input
// elements, no style or class attributes (a Tailwind class could restyle the
// board), no images (they would let agent output load remote beacons).
const PURIFY = {
  ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
    'ul', 'ol', 'li', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
  ALLOWED_ATTR: ['href', 'title', 'target', 'rel'],
};

export function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(String(text ?? ''), { async: false }), PURIFY);
}
