# docs-chat-kit

Paczka dla repozytorium z dokumentacją — indeksuje markdowny w instancji
docs-chat (CGC). **Dwa skrypty** (Python 3.10+, jedyna zależność: `requests`,
CI instaluje sam):

1. **`md_to_json.py`** — folder `.md` → `corpus.json` (czyści frontmatter,
   wikilinki, komentarze; `--include`/`--exclude` wybierają, co wchodzi
   do bazy wiedzy),
2. **`send_json.py`** — import: `POST /api/v1/index/import` → czeka do `active`
   (minuty — embeddingi).

Do tego **dwa gotowe workflowy CI**: `.github/workflows/docs-chat-index.yml`
(GitHub Actions) i `gitlab-ci.docs-chat.yml` (GitLab CI). Prompt asystenta
podmienia się curlem (`PUT /api/v1/admin/prompt`, Bearer RAW klucz indeksu) —
skrypt do tego nie jest potrzebny, kit go świadomie nie wozi.

Konfiguracja — dwie zmienne (obie wymagane, jako sekrety CI): `DOCS_CHAT_API_URL`
(adres instancji, bez końcowego `/`), `DOCS_CHAT_INDEX_KEY` (RAW klucz z logu
pierwszego bootu instancji — NIGDY w pliku).

## Dystrybucja (ZIP-y)

Klient nie kopiuje plików pojedynczo — z dokumentacji Docs Chat (CGC user docs,
`static/docs-chat/`) pobiera ZIP pod swoją platformę i rozpakowuje w root
swojego repo:

- **`docs-chat-kit-github.zip`** — `docs-chat-kit/` (2 skrypty) +
  `docs-chat-index.yml` w root ZIP-a (przenieść do `.github/workflows/`),
- **`docs-chat-kit-gitlab.zip`** — `docs-chat-kit/` (2 skrypty) +
  `gitlab-ci.docs-chat.yml` w root ZIP-a (dołączyć przez `include: local`).

Budowa ZIP-ów (deterministyczna, stdlib):

```bash
python docs-chat-kit/package.py   # → docs-chat-kit/dist/*.zip
```

Po zmianie kita: przebuduj ZIP-y i skopiuj je do
`cgc-user-docs/static/docs-chat/` (to jedyne miejsce dystrybucji — pojedyncze
pliki w static celowo nie istnieją, zero rozjazdów wersji).

## Workflowy CI — setup w repo klienta

**GitHub Actions**: rozpakuj ZIP w root repo, przenieś `docs-chat-index.yml`
do `.github/workflows/`, ustaw sekrety `DOCS_CHAT_API_URL` +
`DOCS_CHAT_INDEX_KEY` (Settings → Secrets → Actions). Odpalanie: release (auto)
albo Actions → docs-chat-index → Run workflow (parametry w UI).

**GitLab CI**: rozpakuj ZIP w root repo, dołącz job:

```yaml
include:
  - local: 'docs-chat-kit/gitlab-ci.docs-chat.yml'
```

Sekrety: Settings → CI/CD → Variables (`DOCS_CHAT_INDEX_KEY` jako masked).
Job leci na tagach; `when: manual` w pliku = ręczne odpalanie.

## Import jednorazowy (terminal, opcjonalnie)

```bash
python docs-chat-kit/md_to_json.py docs -o corpus.json --locale pl
export DOCS_CHAT_API_URL="https://<name>-api.<ns>.cgc-krk-01.comtegra.cloud"
export DOCS_CHAT_INDEX_KEY="<RAW z logu bootu>"
python docs-chat-kit/send_json.py corpus.json
```

## Pochodzenie i testy

Prawda o kształcie API: `lib/server/app.mjs` + testy w tym repo
(`tests/docs-chat-kit/`, unittest bez sieci — requests mockowane; leci
w CI: `test_docs_chat_kit`). Skrypty nie wchodzą do obrazu serwisu.
