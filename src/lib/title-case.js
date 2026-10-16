// Title case for headings, navigation, and buttons (AP style: short articles,
// conjunctions, and prepositions of three letters or fewer stay lowercase unless first or last).
const SMALL = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'so', 'yet', 'as', 'at', 'by', 'in', 'of', 'off', 'on', 'per', 'to', 'up', 'via', 'vs']);

export function titleCase(text) {
  const words = String(text ?? '').split(/(\s+)/);
  const last = words.length - 1;
  return words
    .map((word, i) => {
      if (/^\s+$/.test(word) || !word) return word;
      const bare = word.toLowerCase().replace(/[^a-z]/g, '');
      const afterColon = i > 0 && /[:.?!]$/.test(words[i - 2] || '');
      if (i !== 0 && i !== last && !afterColon && SMALL.has(bare)) return word.toLowerCase();
      return word.replace(/(^|-)([a-z])/g, (m, dash, ch) => dash + ch.toUpperCase());
    })
    .join('');
}
