# Contributing

**English** | [简体中文](CONTRIBUTING.md)

Thanks for taking the time. This document covers getting the project running, how to check your work, and what to include when you open an issue or a pull request.

## Setup

**Node 24 or newer.** The server uses Node's built-in `node:sqlite`; older versions will not start (you get a clear message, not a pile of module resolution errors).

```bash
git clone https://github.com/jxwine/cloudnote.git
cd cloudnote
npm run install:all   # install server and client dependencies
npm run dev           # start the sync service and the desktop client together
```

Click "创建一个" (Create one) on the login page to register. Data lands in `server/data/` by default.

You can also run the pieces separately:

```bash
npm run server        # sync service only (http://localhost:4471)
npm run app           # desktop client only
```

> The client's `userData` directory is named after `name` in `app/package.json`, which is the same
> for the installed build and the dev build. **Quit an installed client before developing** — otherwise
> the single-instance lock makes the dev build exit immediately with no message at all.

## Layout

```
server/          Sync service: Fastify + node:sqlite + WebSocket
  src/db.js        Schema, transactions, per-user monotonic change sequence
  src/auth.js      Registration, login, JWT, auth and admin hooks
  src/routes.js    All endpoints. Three scopes: public, priv (logged in), admin
  src/hub.js       WebSocket broadcast grouped by account
  src/uploads.js   Image storage and retrieval
  src/releases.js  Client installer storage and retrieval
  test/e2e.js      End-to-end tests
app/             Electron client (the web version is this same build output)
  src/main/        Main process: window, tray, theme, update download
  src/preload/     Bridge between renderer and main
  src/renderer/
    lib/sync.ts      Sync engine: debounced saves, conflict archiving, offline queue
    lib/store.ts     Global state and local cache
    components/      UI
deploy/          Deployment script and Nginx config
```

## Checking your work

### Type check

```bash
cd app && npm run typecheck
```

`tsconfig.json` has `strict` **and `noUnusedLocals`** on — one unused variable fails the build.

> There is **no ESLint** in this project, so there is no `npm run lint`. Match the surrounding code.

### Server end-to-end tests

The suite is a plain script that talks real HTTP and WebSocket, so **start the server first**:

```bash
npm run server        # in another terminal
npm test              # 71 checks
```

The admin-related checks need the server to recognise an admin, otherwise that whole section is
skipped with a printed notice:

```bash
CLOUDNOTE_ADMINS=admin@test.local npm run server
npm test
```

Tests isolate themselves with timestamped emails and **do not clean up**. Delete
`server/data/cloudnote.db` if the leftovers bother you.

### UI changes

Please **click through the real window** before opening a PR. Passing the type check does not mean it
works — bugs this project has actually shipped include a popup clipped out of view, a drag highlight
that never appeared, and a modal overlay that dimmed the page but not the native window controls,
leaving a visibly brighter block. Static checks catch none of that.

## Pull requests

1. Branch off `main`
2. One PR, one thing — do not mix a refactor with a bug fix
3. Explain **why**, not just what. The commit history and code comments in this project follow that habit
4. Say how you verified it (which tests, what you clicked)

**If you build an installer**, bump `version` in `app/package.json` first. With an unchanged version,
people on the old build never get an update prompt, and the admin panel refuses a second release
with the same version number.

## Do not commit

`.gitignore` already covers these, but for the record:

- `server/.env` — contains the signing secret
- `server/data/` — database, uploaded images, installers
- `app/out/`, `app/release/` — build output
- `cloudnote-update/` — deployment artifacts staged for upload

## Reporting bugs

Please include:

- **Client version** and OS version
- **Steps to reproduce**, as specific as you can. "Clicked a toolbar button, then clicked empty
  space" beats "the UI is broken"
- Expected versus actual behaviour
- For sync issues: how many devices were online and what each was doing (reading or editing)
- A screenshot or screen recording

Sync and conflict behaviour is not obvious; skim "How sync works" in the README first to confirm it
is not working as designed.

## Feature requests

This project is deliberately restrained — a small fixed palette, a title derived at exactly two
moments. Describing **the situation you ran into** makes for a better discussion than proposing a
solution directly.
