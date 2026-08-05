# Recon: latabledessavoirs.fr API probing notes

Probed from a browser-less shell (PowerShell, `curl.exe` / `Invoke-WebRequest`).
No API docs are exposed anywhere. All hosts sit behind Cloudflare.

## Host matrix

| Host | Type | Notes |
|---|---|---|
| `api.latabledessavoirs.fr` | prod public API | NestJS (`{"message":"Cannot GET ...","statusCode":404}` style errors). |
| `preprod-api.latabledessavoirs.fr` | preprod public API | Same endpoints, empty DB. |
| `admin.latabledessavoirs.fr` | prod admin UI | Angular SPA, route `/jours`, title "ADMIN - La Table des Savoirs". |
| `preprod-admin.latabledessavoirs.fr` | preprod admin UI | Angular SPA, same as prod. |
| `api-admin.latabledessavoirs.fr` | prod admin API | NestJS, same stack as public API. |
| `preprod-api-admin.latabledessavoirs.fr` | preprod admin API | NestJS, same stack as public API. |
| `assets.latabledessavoirs.fr` | CDN / S3 bucket | Cloudflare in front of an S3-like store (`x-amz-request-id` headers). |

There is **no** `dev.*` (or `dev-api*`, `dev-admin*`, `www2`, etc.) subdomain — it does not resolve.

## Public API endpoints

- `GET /` → `{"status":"ok","uptime":...}`
- `GET /seasons` → `{"seasons":[...]}` (each with `_id`, `seasonNumber`, `name`, `dayStart`, `dayEnd`, `__v`)
- `GET /seasons/progress`
- `GET /leaderboards/season/:n/:difficulty` (`facile` | `difficile`)
- `GET /search?...`
- `GET /day-top` (daily top)
- `GET /me`, `GET /stats/me`, `GET /game*`, `GET /seasons/current`, `GET /seasons/:n` → `401` (auth required)

No auth/login endpoints exposed. Preprod DB is empty.

## Admin API surface (from `preprod-admin` bundle `main-EQZYCMHL.js`)

All auth-gated (`401` without credentials):

- `/admin/users`, `/admin/users/:id`
- `/admin/export`
- `/admin/partner`
- `/admin/reset/:x`
- `/admin/contestations`, `/admin/contestations/approve`, `/admin/contestations/reject`
- `/admin/contestations/v2/{approve,reject,event/...}`
- `/admin/leaderboards/season/:n`
- `/seasons/status`
- `/days/:n/events`
- `/event/results`, `/event/update-results`

Docs routes (`/docs`, `/swagger`, `/openapi.json`, `/api-docs`) are `404` on every host.
