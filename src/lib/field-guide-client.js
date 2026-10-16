// Shared by built pages and the shell used for guides published from D1.
export function normalizedSearch(text) {
  return String(text || '').toLowerCase().replace(/\b(i|us|sr)[ -]?(\d+)\b/g, '$1 $2').replace(/[^a-z0-9]+/g, ' ').trim();
}
export function matchesGuide(text, query) {
  const haystack = normalizedSearch(text);
  return normalizedSearch(query).split(' ').filter(Boolean).every((term) => haystack.includes(term));
}
export function mountFieldGuide(doc = document, win = window) {
  doc.querySelectorAll('[data-guide-finder]').forEach((finder) => {
    const list = doc.getElementById(finder.dataset.target);
    const input = finder.querySelector('input');
    const status = finder.querySelector('[role=status]');
    const clear = finder.querySelector('.finder-clear');
    let region = '';
    if (!list || !input) return;
    const update = () => {
      const items = [...list.children];
      let count = 0;
      items.forEach((item) => {
        item.hidden = !matchesGuide(`${item.textContent} ${item.dataset.search || ''}`, input.value) || !!(region && item.dataset.region !== region);
        if (!item.hidden) count++;
      });
      status.textContent = `${count} ${count === 1 ? 'guide' : 'guides'} to explore`;
      finder.querySelector('.finder-empty').hidden = count !== 0;
      clear.hidden = !input.value;
    };
    input.addEventListener('input', update);
    clear.addEventListener('click', () => { input.value = ''; input.focus(); update(); });
    finder.querySelectorAll('[data-region]').forEach((button) => button.addEventListener('click', () => {
      region = button.dataset.region;
      finder.querySelectorAll('[data-region]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
      update();
    }));
    update();
  });
  let printDetails = [];
  win.addEventListener('beforeprint', () => {
    printDetails = [...doc.querySelectorAll('main details:not([open])')];
    printDetails.forEach((detail) => { detail.open = true; });
  });
  win.addEventListener('afterprint', () => { printDetails.forEach((detail) => { detail.open = false; }); printDetails = []; });
  doc.querySelectorAll('[data-print]').forEach((button) => button.addEventListener('click', () => win.print()));
  doc.querySelectorAll('.menu nav a').forEach((a) => a.addEventListener('click', () => a.closest('details').removeAttribute('open')));
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') doc.querySelectorAll('.menu[open]').forEach((menu) => { menu.removeAttribute('open'); menu.querySelector('summary').focus(); });
  });
}
