import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://evtripreports.com',
  trailingSlash: 'ignore',
  build: { format: 'directory' },
});
