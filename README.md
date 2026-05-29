# seasonal-sandboxd

`seasonal-sandboxd` is a SeasonalNet controlled execution daemon. It gives callers such as Seasonal Agent a narrow REST API for job-scoped scratch workspaces, structured command pipelines, and artifact output without granting direct shell access.

It is designed for a no-network sandbox host or container. The daemon records job state in SQLite and stores human-reviewable workspaces/artifacts on SeasonalNAS-style paths.

## Design summary

- TypeScript/Node.js daemon.
- SQLite access uses prepared statements through `better-sqlite3`, with a `node:sqlite` fallback for supported Node runtimes.
- REST API with OpenAPI 3.1 contract.
- Optional scoped opaque token exchange using `seasonalsandboxd_client_*` credentials and short-lived `seasonalsandboxd_access_*` tokens.
- Mutating routes require `Idempotency-Key` and replay the original completed response for the same key/payload.
- RFC 9457 Problem Details on errors.
- SQLite metadata database, defaulting to `/var/lib/sandboxd/sandboxd.db`.
- Job IDs use `sandboxd_<uuidv7>`.
- Job paths are partitioned as `YYYY/MM-Month/<jobId>/`.
- Commands are structured argv arrays, not shell strings.
- Pipelines are connected by process pipes without `/bin/sh -c`.
- Commands are allowlisted.
- Outputs are capped and ANSI-stripped.

## Default storage layout

```text
/mnt/seasonalnas/agent-workspaces/seasonal-sandboxd/2026/05-May/sandboxd_<uuidv7>/
  input/
  work/
  tmp/
  logs/
  manifest.json

/mnt/seasonalnas/artifacts/seasonal-sandboxd/2026/05-May/sandboxd_<uuidv7>/
  manifest.json
  stdout.txt
  stderr.txt
```

## API overview

```text
GET  /healthz
GET  /readyz
GET  /openapi.json
POST /v1/auth/token
POST /v1/auth/revoke
POST /v1/jobs
GET  /v1/jobs
GET  /v1/jobs/{jobId}
POST /v1/jobs/{jobId}/pipelines
GET  /v1/jobs/{jobId}/processes
POST /v1/jobs/{jobId}/cancel
GET  /v1/jobs/{jobId}/artifacts
```

## Example

Create a job:

```bash
curl -sS -X POST http://127.0.0.1:9090/v1/jobs \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <seasonalsandboxd_access_token>' \
  -H 'idempotency-key: create-job-0001' \
  -d '{"profile":"inspect"}' | jq .
```

Run a pipeline:

```bash
curl -sS -X POST http://127.0.0.1:9090/v1/jobs/sandboxd_.../pipelines \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <seasonalsandboxd_access_token>' \
  -H 'idempotency-key: run-pipeline-0001' \
  -d '{"pipeline":[["find",".","-maxdepth","2","-type","f"],["sort"]]}' | jq .
```

## Token sketch

Create a sandboxd client credential:

```bash
npm run token -- create-client \
  --name seasonal-agent \
  --scopes sandbox:status:read,sandbox:job:create,sandbox:job:read,sandbox:pipeline:run,sandbox:artifact:read,sandbox:job:cancel \
  --prefix /v1/jobs \
  --cidr 192.168.1.20/32
```

Exchange it for an access token:

```bash
curl -sS -X POST http://127.0.0.1:9090/v1/auth/token \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <seasonalsandboxd_client_token>' \
  -d '{"requestedScopes":["sandbox:job:create","sandbox:job:read","sandbox:pipeline:run","sandbox:artifact:read"]}' | jq .
```

## Install sketch

```bash
# Requires upstream Node.js. Prefer an environment where better-sqlite3 can use a prebuild or compile cleanly.
npm install
npm run build

sudo install -d -m 0755 /etc/seasonal-sandboxd
sudo install -d -m 0750 -o sandboxd -g sandboxd /var/lib/sandboxd
sudo cp config.example.yaml /etc/seasonal-sandboxd/config.yaml
sudo cp systemd/seasonal-sandboxd.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now seasonal-sandboxd.service
```

## Minimal host package guidance

On Debian, install Node from the upstream tarball or another lightweight Node distribution path. Avoid Debian's `npm` package on minimal sandbox hosts because it can pull in a large JavaScript/build-tool dependency closure. The daemon itself only needs:

```text
node
npm, only for install/build
compiler/prebuild support for `better-sqlite3`, or a Node runtime with `node:sqlite`
coreutils/findutils/grep/sed/etc. for allowed pipeline commands
```

## Security notes

Do not run this as a privileged host shell service. The intended deployment is a locked-down VM or container with no network egress, non-root execution, job-scoped writable mounts, read-only input mounts, and no secrets.
