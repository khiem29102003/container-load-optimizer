# Container Load Optimizer

Container loading planner built with React, TypeScript, Vite, Three.js, and Supabase. Accounts are provisioned by an administrator; each account's projects are private and saved automatically.

```cmd
npm ci
copy .env.example .env.local
```

Fill `.env.local` with the Supabase project URL and publishable/anon key, then run:

```cmd
npm run dev
npm run lint
npm test
npm run build
```

## Supabase setup

1. Create a Supabase project.
2. Open **SQL Editor** and run [`supabase/schema.sql`](supabase/schema.sql). This creates `loading_projects` and enables row-level security. Users can only access rows whose `owner_id` matches their authenticated user ID.
3. In **Authentication → Providers**, enable Email.
4. In **Authentication → URL Configuration**, set the Site URL to the deployed site and add these redirect URLs:
  - `http://localhost:5173/**`
  - `https://YOUR-VERCEL-DOMAIN/**`
5. In **Project Settings → API**, copy the Project URL and publishable key (or legacy anon key) into `.env.local`:

```dotenv
VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR-PUBLISHABLE-OR-ANON-KEY
```

Self-service registration is disabled. An administrator creates accounts in **Authentication → Users → Add user**; for controlled testing, the administrator may confirm the user from the dashboard. The first successful login creates an empty project with the default container and no cargo rows. Subsequent projects are private to that account. Configure custom SMTP before relying on confirmation or password-reset emails for production.

The publishable/anon key is intended for browser use; row-level security is the data boundary. Never put a Supabase service-role key in a `VITE_` variable or in frontend code.

## Vercel deployment

Connect the GitHub repository and use:

- Framework preset: Vite
- Build command: `npm run build`
- Output directory: `dist`
- Install command: `npm ci`

Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in **Project Settings → Environment Variables** for Production, Preview, and Development, then redeploy. Do not add service-role credentials.

## Data and operating notes

- Cargo, container, and optimization data are persisted in Supabase. Auth session tokens are stored by the Supabase client in the browser.
- Excel/CSV parsing, optimization, and PDF/CSV/JSON exports run in the user's browser. Exported files download to that user's device.
- The app imports `.xlsx` with SheetJS 0.20.3 from the official SheetJS CDN because the npm registry package is stale. Spreadsheet files are capped at 10 MB and the parser loads on demand.
- Run `npm audit` after dependency updates. The production dependency audit was clean after upgrading SheetJS; review future advisories before deployment.
- The default 40 ft GP dimensions currently match the requested exterior measurements. Replace them with verified internal dimensions before using plans for real cargo operations.
- The optimizer is a planning aid. Validate loading, payload, center of gravity, and transport rules with qualified operations staff before shipment.
# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
"# container-load-optimizer" 
