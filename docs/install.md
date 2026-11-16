# Install Docs Chat

Docs Chat is an API instance in your namespace: a compute (the service), a PostgreSQL database with the pg-vector extension (the index), and an index key that authorizes corpus imports — the service generates the key itself and shows it once in the boot log.

## Install

One database compute, one service compute. Total time: about 5 minutes.

Requirements: `cgc` CLI, an LLM API key (`cgc api-keys create --level LLM`). The Docs Chat image is public (`ghcr.io/comtegra/docs-chat-api`) — no pull secret needed.

In the examples, replace `<name>` (your instance name), `<namespace>` (your CGC namespace) and the key values.

### 1. Database

```bash
cgc db create pg-vector -n <name>-db
```

Save the **App token** from the create output — the service connects with it
(`postgresql://admin:<token>@<name>-db:5432/db`). Schema migrations run automatically
when the service starts; you never manage the schema by hand.

### 2. Service

```bash
cgc volume create <name>-tenant-data -s 1 -sc ssd-rwx-ec
cgc compute create custom -n <name>-api -c 2 -m 2 \
  --image ghcr.io/comtegra/docs-chat-api:api-2.0.4 \
  -v <name>-tenant-data -fp /app/tenant \
  -e NODE_ENV=production -e PORT=3001 \
  -e "DATABASE_URL=postgresql://admin:<db-app-token>@<name>-db:5432/db" \
  -e OPENAI_BASE_URL=https://llm.comtegra.cloud/v1 -e OPENAI_API_KEY=<llm-api-key> \
  -e DOCS_CHAT_LOCALES=pl
cgc compute port add <name>-api -p 3001 -n http
```

Two secrets and you are done — everything else has a sensible default baked into the service (see the table below). The chat model is one of those defaults: it is pinned to the one the instance is validated with, so you never configure it. The volume holds the assistant's prompt file (created automatically on first boot); without it the prompt would not survive a recreate.

Optional settings, passed the same way (`-e NAME=value`):

| Env | Default | What it does |
|---|---|---|
| `DOCS_CHAT_LOCALES` | `pl` | languages of your docs (`en`, `pl`, comma-separated; first = default for chat). Polish docs: set nothing. English: `DOCS_CHAT_LOCALES=en`. |
| `DOCS_CHAT_CORS_ORIGINS` | `*` | origin of the site hosting the chat widget — the API accepts chat calls only from it. Don't know it yet? Leave `*` (per-IP limits stay as the protection) and narrow it later. |

> **Environment is set at creation**
> Changing the configuration means recreating the compute (`cgc compute delete` + create again) — the database and the index key survive, the corpus stays. Adding the port restarts the resource; the public URL needs ~2–3 minutes for the TLS certificate (503 until then).

### 3. Smoke test

```bash
curl https://<name>-api.<namespace>.cgc-krk-01.comtegra.cloud/api/v1/health
# {"status":"ok","database":"ok","schema":"ok","tenants":1}
```

`schema: ok` confirms the service connected and migrated the database at boot.

### 4. Index key (from the boot log)

The service generated an index key on first boot and printed it once:

```bash
cgc logs <name>-api
# {"msg":"index key generated","DOCS_CHAT_INDEX_KEY":"<RAW>",...}
```

Store the **RAW** value — it becomes `DOCS_CHAT_INDEX_KEY` in your CI secrets during [import](corpus-import.md). Never commit it. The instance stores only the key's hash (in the database), which is why it survives restarts and recreates; lose the RAW key and you set a new pair via `DOCS_CHAT_INDEX_KEYS` (the hash) on the next recreate.
