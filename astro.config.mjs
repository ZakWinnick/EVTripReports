import { defineConfig } from 'astro/config';

export default defineConfig({
  devToolbar: { enabled: false },
  site: 'https://evtripreports.com',
  trailingSlash: 'ignore',
  build: { format: 'directory' },
});
