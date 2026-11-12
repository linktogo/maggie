import { locale } from './i18n.js';

// The K/M suffixes read the same in every supported language; only the
// decimal separator follows the selected locale (36.4K, 36,4K).
function oneDecimal(n) {
  return n.toLocaleString(locale.value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

export function formatTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${oneDecimal(n / 1000)}K`;
  return `${oneDecimal(n / 1_000_000)}M`;
}
