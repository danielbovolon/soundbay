# Soundbay accounts (API)

This small server lets anyone create a Soundbay account and keep their sessions (notes, takes, plans, sketches) in it, so they can open them on any device. It runs on Cloudflare Workers with a D1 database, both on Cloudflare's free plan, and it doesn't pause when idle.

Without it, the site still works: everything is saved in each visitor's browser, and PDF export and backup files work as normal.

## What it stores
- Email address
- A salted PBKDF2 hash of the password (never the password itself)
- The user's entries
- Sign-in sessions (random tokens, stored hashed, valid for 90 days)

Users can delete their account and all their entries from the app ("Your sessions" → "Delete account").

## Set it up once (about 10 minutes)

You need Node.js and a free Cloudflare account.

```bash
cd api
npm install
npx wrangler login                     # opens the browser to connect your Cloudflare account
npx wrangler d1 create soundbay        # prints a database_id
```

1. Open `wrangler.toml`.
   - Paste the `database_id` you just got.
   - In `ALLOWED_ORIGINS`, list the addresses your site is served from, for example `https://soundbay.danielbovolon.com,https://YOUR-GITHUB-USERNAME.github.io`.
2. Create the tables:
   ```bash
   npm run db:init
   ```
3. Deploy:
   ```bash
   npm run deploy
   ```
   Wrangler prints the address, e.g. `https://soundbay-api.your-subdomain.workers.dev`.
4. Check it: open `<that address>/api/health` in a browser. You should see `{"ok":true}`.
5. In the site's root, open `config.js` and set:
   ```js
   window.SOUNDBAY_API = 'https://soundbay-api.your-subdomain.workers.dev';
   ```
   Commit and push. The site now shows "Sign in to sync" in the top right.

### Optional: put the API on your own domain
In the Cloudflare dashboard → Workers & Pages → soundbay-api → Settings → Domains & Routes, add a custom domain such as `api.soundbay.danielbovolon.com` (the domain's DNS must be on Cloudflare). Then use that address in `config.js`.

## Updating
After changing `src/index.js`, run `npm run deploy` again. Schema changes go in `schema.sql`.

## Limits
- 1 MB per entry (a very dense sketch is the only thing likely to reach it)
- 5,000 entries per account
- 5 wrong passwords lock sign-in for that email for 15 minutes
- There's no password reset yet. Adding one needs an email sender (for example Cloudflare Email Routing or Resend).

## Local testing
```bash
npx wrangler d1 execute soundbay --local --file=schema.sql
npx wrangler dev --local
```
Add `http://localhost:8000` to `ALLOWED_ORIGINS`, serve the site with `python3 -m http.server 8000` from the repo root, and set `config.js` to `http://localhost:8787`.
