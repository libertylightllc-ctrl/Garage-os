# Notes on `vercel.json` — read before removing anything

## Crons + external schedulers

Not every scheduled endpoint appears in `vercel.json`. The plan cron-slot cap is 2
(this is at cap today: `ai-credit-check` + `auto-close-stale-sessions`). The
following endpoints exist but are scheduled from GitHub Actions instead, because
adding a third entry to `vercel.json` broke the deploy on 2026-08-27 (commit
`dc72683`), silently unscheduling ERPNext sync until 2026-08-28.

| Endpoint                        | Scheduler file                          | Cadence   |
| ------------------------------- | --------------------------------------- | --------- |
| `/api/keepwarm`                 | `.github/workflows/keep-warm.yml`       | */5 min (business hrs) |
| `/api/cron/erp-tailer`          | `.github/workflows/erp-tailer.yml`      | */5 min (all day) |

**If you remove an entry from `vercel.json` because you're switching a cron to
GitHub Actions**, add the row here first so the next person doesn't remove one
of these and unwire the endpoint too.

**If you add a new cron that would breach the 2-cap**, move an existing entry
to GitHub Actions rather than deleting it, and update this file.

## Region

`sin1` — Vercel Singapore. Chosen for UAE latency (closest region to Dubai). Do
not move without measuring cold-start + warm-request latency against the
current pilots.
