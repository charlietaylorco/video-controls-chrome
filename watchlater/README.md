# Watchlater

Private ChatGPT Sites application with managed sign-in and durable D1 storage.
The published origin is https://watchlater.chimping.chatgpt.site.

The parent repository's `npm run prepare:site` copies shared extension/web assets
into generated app HTML and public scripts. This generated source is included in
the separate Sites source checkout for publication. It is not an independent
source of edits in this GitHub checkout.

- `app/`: authenticated HTML/API routes and managed ChatGPT identity helpers.
- `lib/api.mjs`: bounded application operations and Reader safety checks.
- `lib/database.mjs`: D1 queries, atomic revision guards, budgets and tickets.
- `db/schema.ts` / `drizzle/`: the schema and append-only generated migrations.
- `worker/`, `vite.config.ts`, `scripts/`: maintained Sites runtime/build integration.
- `.openai/hosting.json`: registered Site identity and DB binding.

Keep the Site owner-private. No Supabase account or password-based app auth is used.
Optional `READER_TOKEN` and `RAINDROP_TOKEN` server secrets enable integration actions;
records can be imported, edited, searched and exported without them.

See the parent `docs/recent-saves-website.md` for migration and publishing details.
