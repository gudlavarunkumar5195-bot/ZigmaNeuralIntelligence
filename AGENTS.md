# figma-make-app

React + Vite + Tailwind CSS project running inside Figma Make.

## Development Server

A Vite development server is **already running** on `$PORT` (default 8443). You don't need to start it manually.

- Preview URL: The user can access the running app through the preview panel
- Hot reload: Changes to source files are reflected immediately

## Project Structure

This is the canonical project structure. Start with task-relevant files below. Only follow imports or inspect other files when required, when a documented path is missing, or when the repository contradicts this guide.

- `src/main.tsx` - React entrypoint; imports `src/index.css` and mounts `src/App.tsx` into the `#root` element
- `src/App.tsx` - Primary application component and the usual starting point for UI work
- `src/index.css` - Global CSS entrypoint and Tailwind CSS v4 import
- `index.html` - Vite HTML shell containing the `#root` element and loading `src/main.tsx`
- `package.json` - Project dependencies and the Vite build, development, preview, and formatting scripts
- `vite.config.ts` - Vite configuration with React, Tailwind CSS v4, and Figma Make plugins plus the `@` alias for `src`
- `.mise.toml` - Toolchain versions for Node.js and pnpm

## Dependencies

- Runtime: React 19 and React DOM 19
- Styling: Tailwind CSS v4 with the `@tailwindcss/vite` plugin
- Build tooling: Vite 8, TypeScript 5.7, and `@vitejs/plugin-react`
- Formatting: oxfmt

## Styling

This project uses **Tailwind CSS v4** through the `@tailwindcss/vite` plugin configured in `vite.config.ts`. `src/index.css` imports Tailwind with `@import 'tailwindcss';`. Use Tailwind utility classes directly in JSX and put global CSS or Tailwind v4 theme customization in `src/index.css`. This scaffold does not need a Tailwind config file or PostCSS config.

`src/main.tsx` imports `src/index.css`, so global font wiring belongs in `src/index.css`. Keep CSS `@import` statements first, then add any `@font-face` rules and font-family defaults there.

## Code quality

- Use double quotes for strings containing apostrophes (`"We're here to help"`), or escape them in single-quoted strings. An unescaped apostrophe in a single-quoted string breaks the build.
- Ensure JSX tags are closed and braces are balanced.
- Export components as default exports.

## Backend, database and deployment

The repository is a two-package app: the Vite frontend (root) and a Fastify API in `server/` (its own `package.json` and lockfile). In production a single Fastify process serves both `/api/v1/*` and the built frontend (`dist/`), see `app.yaml` and `Procfile`.

- Server entry points: `server/src/index.ts` (process, worker, graceful shutdown), `server/src/app.ts` (plugins, routes, static serving), `server/src/config.ts` + `config-security.ts` (validated env; see `server.env.example`).
- Database: PostgreSQL via `pg`; schema is owned by the ordered SQL files in `server/src/db/migrations`. Apply with `pnpm --dir server migrate` (production: `migrate:prod` on the built output). Never edit an applied migration; add a new numbered one. `server/src/db/supabase_setup.sql` is deprecated and raises on use.
- Tenancy: every tenant request carries `x-org-id`; `requireOrgMember` re-reads membership/role (and `users.active`) from the database. Global resources (model catalog, global agents, global routing policy) additionally require `PLATFORM_ADMIN_USER_IDS` (user UUIDs; unset = nobody).
- Proxy trust for rate limiting is explicit: `TRUST_PROXY` (default off).
- Tests: `pnpm test` (frontend), `pnpm --dir server test` (backend). Database-backed suites run only with `RUN_INTEGRATION=1` and `TEST_DATABASE_URL` pointing at an isolated throwaway database. Never point them at production.
- Quality gate: `pnpm exec tsc --noEmit && pnpm test && pnpm --dir server build && pnpm --dir server test && pnpm build && git diff --check`.
