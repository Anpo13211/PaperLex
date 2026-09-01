# PaperLex hosted

Private OpenAI Sites edition of PaperLex. The browser UI is served as static
assets, while a Cloudflare Worker-compatible API stores words and encounter
history in D1.

## Local validation

```bash
npm install
npm run db:generate
npm test
npm run build
```

The hosted runtime expects `PAPERLEX_CAPTURE_TOKEN` for Preview captures and a
separate one-time `PAPERLEX_IMPORT_TOKEN` while migrating an existing backup.

## Included shape

- `public/` contains the same PaperLex mobile/desktop UI as the local edition.
- `worker/` contains the API, D1 store and bounded enrichment clients.
- `db/schema.ts` and `drizzle/` are the authoritative schema and migration.
- `.openai/hosting.json` declares D1 as `DB`; R2 is intentionally unused.

Browser access is protected by the private Sites deployment policy. The capture
and one-time import endpoints additionally require their dedicated tokens.
