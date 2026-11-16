# Import your documentation

Your corpus enters Docs Chat through the **docs-chat kit** — two Python scripts plus a CI workflow for your platform. The import runs in CI: the index follows your documentation, no manual steps.

## 1. Get the kit

In this repository the kit lives at [`docs-chat-kit/`](../docs-chat-kit/) — copy that folder to the **root of your documentation repository**.
(On the documentation site the same kit ships as ready-made ZIPs: `docs-chat-kit-github.zip` / `docs-chat-kit-gitlab.zip` — same content, no unpacking.)

The kit is two scripts:

- **`md_to_json.py`** — builds a corpus file from your Markdown folder (strips frontmatter, cleans wiki links and comments; `--include`/`--exclude` pick what enters the knowledge base),
- **`send_json.py`** — imports the corpus and waits until the index is active.

…and one CI file, which you move to your platform's CI location:

**GitHub** — move `docs-chat-index.yml` to `.github/workflows/`.

**GitLab** — keep `gitlab-ci.docs-chat.yml` where it is and reference it from your `.gitlab-ci.yml`:

```yaml
include:
  - local: 'docs-chat-kit/gitlab-ci.docs-chat.yml'
```

## 2. What the CI needs

Two secrets, set once:

| Secret | Value |
|---|---|
| `DOCS_CHAT_API_URL` | your instance URL (from the [install](install.md) summary) |
| `DOCS_CHAT_INDEX_KEY` | the RAW index key from the service's first boot log (line `index key generated` — shown once; store it in your CI secret store, never in files) |

GitHub: *Settings → Secrets and variables → Actions*. GitLab: *Settings → CI/CD → Variables* (`DOCS_CHAT_INDEX_KEY` as masked).

The CI file you just installed — it runs the two kit scripts you unpacked: `md_to_json.py` builds the corpus, `send_json.py` imports it and waits until the index is active — so you can review it:

```yaml
name: docs-chat-index

# Index your Markdown docs into a Docs Chat instance (CGC).
# Setup (once): unpack docs-chat-kit (ZIP from the Docs Chat documentation) at your repo root,
# move this file to .github/workflows/,
# set secrets DOCS_CHAT_API_URL + DOCS_CHAT_INDEX_KEY (Settings → Secrets → Actions).
# Run: on release (auto) or Actions → docs-chat-index → Run workflow — parameters in the UI,
# no YAML editing needed.
on:
  release: { types: [published] }
  workflow_dispatch:
    inputs:
      paths:
        description: "Folder with Markdown files (relative to repo root)"
        default: "docs"
        required: false
      include:
        description: "fnmatch include; empty = everything"
        default: ""
        required: false
      exclude:
        description: "fnmatch exclude — comma-separated (e.g. 'private/**,drafts/**')"
        default: ""
        required: false
      locale:
        description: "Index collection: en | pl"
        default: "pl"
        required: false

jobs:
  index:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install requests
      - name: Build corpus
        run: |
          ARGS=""
          if [ -n "$INCLUDE" ]; then ARGS="$ARGS --include $INCLUDE"; fi
          for P in $(echo "$EXCLUDE" | tr ',' ' '); do
            if [ -n "$P" ]; then ARGS="$ARGS --exclude $P"; fi
          done
          python docs-chat-kit/md_to_json.py "$PATHS" -o corpus.json --locale "$LOCALE" --source "$SOURCE" $ARGS
        env:
          PATHS: ${{ inputs.paths || 'docs' }}
          INCLUDE: ${{ inputs.include }}
          EXCLUDE: ${{ inputs.exclude }}
          LOCALE: ${{ inputs.locale || 'pl' }}
          SOURCE: ${{ github.event.repository.name }}
      - name: Import to docs-chat
        run: python docs-chat-kit/send_json.py corpus.json
        env:
          DOCS_CHAT_API_URL: ${{ secrets.DOCS_CHAT_API_URL }}
          DOCS_CHAT_INDEX_KEY: ${{ secrets.DOCS_CHAT_INDEX_KEY }}
```

```yaml
# Attach to .gitlab-ci.yml:  include: [ { local: 'docs-chat-kit/gitlab-ci.docs-chat.yml' } ]
# Secrets (Settings → CI/CD → Variables, DOCS_CHAT_INDEX_KEY as masked): DOCS_CHAT_API_URL,
# DOCS_CHAT_INDEX_KEY. Scripts: docs-chat-kit/ at repo root (ZIP from the Docs Chat docs).
docs-chat-index:
  stage: deploy
  image: python:3.12
  variables:
    DOCS_CHAT_API_URL: "${DOCS_CHAT_API_URL}"
  script:
    - pip install requests
    # what enters the knowledge base: --include/--exclude (fnmatch, repeatable, exclude wins)
    - python docs-chat-kit/md_to_json.py docs -o corpus.json --locale pl
    - python docs-chat-kit/send_json.py corpus.json
  rules:
    - if: $CI_COMMIT_TAG          # release = tag; add when: manual for manual triggers
```

## 3. Run the import

**GitHub** — *Actions → docs-chat-index → Run workflow* (or let it run on each release). Run parameters, no YAML editing:

- **paths** — folder with your Markdown (default `docs`),
- **include / exclude** — glob patterns, exclude wins (e.g. `private/**,drafts/**`); index the whole repository or just the docs folder,
- **locale** — index collection (`en` or `pl`); must match a locale enabled in your instance.

**GitLab** — the job runs on tags; add `when: manual` to the included file for manual triggers. Corpus folder and locale live in its script line (`docs-chat-kit/md_to_json.py docs -o corpus.json --locale pl`).

The import runs in the background — a large corpus takes minutes (documents are embedded as they arrive). One import at a time per instance; a re-import **replaces** the previous corpus (a much smaller corpus is rejected by default as a safety guard — it protects against accidentally indexing a near-empty folder). Limits: up to 5 000 documents / 20 000 chunks per import, 16 MB request size.

Verify what the instance knows:

```bash
curl $DOCS_CHAT_API_URL/api/v1/status
# "index": [{ "documents": 237, … }]
```

## 4. After the import

Chat away — from your site with the widget, or straight against the API:

```bash
curl -N -X POST $DOCS_CHAT_API_URL/api/v1/chat \
  -H "Origin: <your docs site origin>" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"What is Docs Chat?","locale":"en","scope":"all"}'
```

Answers arrive as a live stream of SSE frames: `sources`, `step`, `reasoning`, `content`, `done` (or `error`). The same contract is implemented by [`@comtegra/docs-chat-client`](https://www.npmjs.com/package/@comtegra/docs-chat-client), so your UI never parses SSE by hand.

## Customize the assistant (optional)

The assistant's system prompt is a file on the instance — replace it with a single call (applies live, from the next question, no restart):

```bash
curl -X PUT $DOCS_CHAT_API_URL/api/v1/admin/prompt \
  -H "Authorization: Bearer $DOCS_CHAT_INDEX_KEY" \
  -H "Content-Type: text/plain" \
  --data-binary @prompt.md
```

`prompt.md` is the full system prompt, plain text, up to 8 000 characters. The RAW index key doubles as the admin credential here — the instance stores only its hash.
