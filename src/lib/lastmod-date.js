// Sitemap lastmod only when the value is a real calendar date.
// Guide `checked` is stored as YYYY-MM-DD. Anything else is omitted.
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function lastmodDate(value) {
  if (typeof value !== 'string' || !DATE.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return value;
}
