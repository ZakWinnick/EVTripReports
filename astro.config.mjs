import { defineConfig } from 'astro/config';

export default defineConfig({
  devToolbar: { enabled: false },
  site: 'https://evtripreports.com',
  trailingSlash: 'ignore',
  build: { format: 'directory' },
  vite: {
    build: {
      // The site's Content Security Policy requires executable scripts to stay external.
      assetsInlineLimit: (filePath) => filePath.endsWith('.js') ? false : undefined,
    },
  },
});
