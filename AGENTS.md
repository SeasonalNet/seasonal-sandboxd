# AGENTS.md

## Purpose

This repository contains `seasonal-sandboxd`, the SeasonalNet controlled execution daemon.

The daemon provides a narrow REST API for creating job-scoped scratch workspaces, running allowlisted structured command pipelines, and recording job metadata/artifacts in SQLite. It is intended to be called by Seasonal Agent and other SeasonalNet control-plane tools without giving those callers direct shell access.

## Ground rules

- Do not add arbitrary `/bin/sh -c`, `bash -c`, `eval`, or free-form shell execution endpoints.
- Do not mount broad host paths, Docker sockets, SSH keys, API tokens, or system service directories into the sandbox runtime.
- Treat POSIX permissions and ACLs on NFS shares as convenience only, not as the security boundary.
- Keep the security boundary in daemon policy, explicit path allowlists, job-scoped directories, no-network deployment, non-root execution, resource limits, timeouts, and output caps.
- Keep the API RESTful and documented in OpenAPI.
- Return RFC 9457 Problem Details for errors.
- Keep SQLite as the default storage layer unless there is explicit future design work for another backend.
- Native SQLite modules are acceptable when they materially simplify correctness or safety. Prefer `better-sqlite3` for prepared-statement SQLite access, with `node:sqlite` acceptable as a fallback on supported Node runtimes.
- Prefer structured argv arrays and pipeline stages over string commands.
- Do not add network-capable commands to the default allowlist.
- Keep generated artifacts under the configured artifact root, partitioned by year and month.
- Keep workspaces under the configured workspace root, partitioned by year and month.

## Naming and paths

- Service name: `seasonal-sandboxd`
- CLI/package name: `seasonal-sandboxd`
- Default config path: `/etc/seasonal-sandboxd/config.yaml`
- Default database path: `/var/lib/sandboxd/sandboxd.db`
- Default workspace root: `/mnt/seasonalnas/agent-workspaces/seasonal-sandboxd`
- Default artifact root: `/mnt/seasonalnas/artifacts/seasonal-sandboxd`
- Job IDs use `sandboxd_<uuidv7>`.
- Job filesystem paths use `YYYY/MM-Month/<jobId>/`.

## API expectations

- `GET /healthz` must remain a lightweight process liveness check.
- `GET /readyz` must verify database and storage readiness.
- `GET /openapi.json` must return the current contract.
- `/v1/jobs` creates and lists jobs.
- `/v1/jobs/{jobId}/pipelines` runs structured pipeline stages against one job.
- `/v1/jobs/{jobId}/processes` is sandbox-local process visibility only.
- `/v1/jobs/{jobId}/cancel` cancels daemon-managed work for that job only.

## Pipeline safety

- A pipeline stage is an argv array, not a shell string.
- Commands must be allowlisted by executable name.
- Paths must stay inside the job workspace or explicitly configured read-only input roots.
- Default working directory is the job `work/` directory.
- Enforce timeout and maximum output bytes.
- Strip ANSI control sequences before storing or returning output.
- Preserve compact logs in SQLite and write larger outputs as artifacts when configured.

## Change discipline

- Update `openapi/openapi.yaml` when changing API behavior.
- Mutating routes must require and honor `Idempotency-Key`; do not add mutating endpoints without route policy coverage.
- Authenticated routes should use scoped sandboxd access tokens issued from sandboxd client credentials, not raw static all-access bearer tokens.
- Add or update tests for path partitioning, job IDs, command allowlists, and Problem Details.
- Keep README operator-facing and AGENTS.md agent-facing.
