"""Send a docs-chat-api corpus: POST /index/import, then poll until active.

Generalized from cgc-user-docs/python/send_json.py for any docs-chat instance.
Reads a self-describing corpus produced by md_to_json.py:
    {"locale": "pl", "source": "my-repo", "data": [ ...documents... ]}

Service contract (lib/server/app.mjs — no tenant path segment,
the instance serves exactly one tenant):
  POST {url}/api/v1/index/import   (Bearer index key, <= 16 MB body)
    202 {"importId"} — import runs in the background, one job per instance (409 while running)
  GET  {url}/api/v1/index/imports/{importId}  — poll until status active/failed
  Activation guard: the new corpus must reach 70% of the active index document count,
  otherwise activation is refused — pass --force to override (e.g. intentional corpus shrink).

Configuration: both variables required, none optional:
  DOCS_CHAT_API_URL    instance URL, e.g. https://docs-chat-api.<ns>.cgc-krk-01.comtegra.cloud
  DOCS_CHAT_INDEX_KEY  index key (Bearer) — returned by the instance/template at create time
"""

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path

import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler()],
)
logger = logging.getLogger("send_json")

REQUEST_TIMEOUT_SECONDS = int(os.getenv("REQUEST_TIMEOUT_SECONDS", "900"))
POLL_INTERVAL_SECONDS = int(os.getenv("POLL_INTERVAL_SECONDS", "10"))
POLL_TIMEOUT_SECONDS = int(os.getenv("POLL_TIMEOUT_SECONDS", "1500"))  # whole-corpus embeddings take minutes

# Service-side caps (lib/server/app.mjs): the request is also cut by the ingress BEFORE the
# service (nginx defaults to 1 MB), so an oversized corpus must fail HERE with a hint,
# not as an opaque 413 from a proxy.
IMPORT_MAX_BYTES = 16 * 1024 * 1024
IMPORT_MAX_DOCUMENTS = 5000


def get_docs_chat_config(env=None) -> dict:
    """Instance config from env: both variables required; a missing one is an error,
    not a silent default."""
    if env is None:
        env = os.environ

    url = (env.get("DOCS_CHAT_API_URL") or "").strip().rstrip("/")
    key = (env.get("DOCS_CHAT_INDEX_KEY") or "").strip()
    missing = [name for name, value in
               (("DOCS_CHAT_API_URL", url), ("DOCS_CHAT_INDEX_KEY", key))
               if not value]
    if missing:
        raise ValueError(f"missing required environment variables: {', '.join(missing)}")
    if not url.startswith(("https://", "http://")):
        # an unexpanded CI reference (e.g. "${DOCS_CHAT_API_URL}") must fail here, not at send time
        raise ValueError(f"DOCS_CHAT_API_URL must start with https://, got: {url!r}")
    return {"url": url, "key": key}


def load_corpus(path: str | Path) -> dict:
    corpus = json.loads(Path(path).read_text(encoding="utf-8"))
    data = corpus.get("data")
    if not isinstance(data, list) or not data:
        raise ValueError(f"corpus {path} has no data[] — run md_to_json.py first")
    if not corpus.get("locale"):
        raise ValueError(f"corpus {path} has no locale — run md_to_json.py first")
    return corpus


def build_payload(corpus: dict, env=None, force: bool = False) -> dict:
    """Import payload: locale selects the tenant collection; commitSha ties the import
    to the repo revision when running from CI."""
    if env is None:
        env = os.environ
    payload = {
        "locale": corpus["locale"],
        "source": corpus.get("source"),
        "commitSha": env.get("CI_COMMIT_SHA"),
        "data": corpus["data"],
    }
    if force:
        payload["force"] = True
    return payload


def send_corpus(corpus: dict, config: dict, env=None, force: bool = False, sleep=time.sleep) -> bool:
    """POST the corpus, then poll the import until active/failed. Returns True on active.
    Pre-flight size/count check: a corpus over the service caps fails here with a
    actionable hint (split with --include/--exclude or per locale), not as a raw 413."""
    payload = build_payload(corpus, env=env, force=force)
    payload_bytes = len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    if payload_bytes > IMPORT_MAX_BYTES:
        logger.error("corpus is %.1f MB but the service accepts %.0f MB per import — "
                     "split it (md_to_json --include/--exclude per collection) and import in parts",
                     payload_bytes / 1e6, IMPORT_MAX_BYTES / 1e6)
        return False
    if len(payload["data"]) > IMPORT_MAX_DOCUMENTS:
        logger.error("corpus has %s documents but the service caps an import at %s — "
                     "split it (md_to_json --include/--exclude) and import in parts",
                     len(payload["data"]), IMPORT_MAX_DOCUMENTS)
        return False
    base = f"{config['url']}/api/v1/index"
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {config['key']}"}

    try:
        logger.info("POST %s/import (%s documents, locale=%s)", base, len(payload["data"]), payload["locale"])
        response = requests.post(f"{base}/import", headers=headers, json=payload, timeout=REQUEST_TIMEOUT_SECONDS)
        response.raise_for_status()
        import_id = response.json()["importId"]
    except requests.exceptions.HTTPError as error:
        body = getattr(error.response, "text", "")[:1000]
        status = getattr(error.response, "status_code", "unknown")
        logger.error("import rejected: status=%s body=%s", status, body)
        return False
    except (requests.exceptions.RequestException, KeyError, ValueError) as error:
        logger.error("import request failed: %s", error)
        return False

    logger.info("import %s accepted — polling until active (interval %ss, timeout %ss)",
                import_id, POLL_INTERVAL_SECONDS, POLL_TIMEOUT_SECONDS)
    deadline = time.monotonic() + POLL_TIMEOUT_SECONDS
    failures = 0
    while time.monotonic() < deadline:
        try:
            status = requests.get(f"{base}/imports/{import_id}", headers=headers, timeout=60)
            status.raise_for_status()
            state = status.json()
            failures = 0
        except (requests.exceptions.RequestException, ValueError) as error:
            # a transient network error does not stop the wait — the import keeps running server-side
            failures += 1
            logger.warning("polling import %s failed (%s/3): %s", import_id, failures, error)
            if failures >= 3:
                logger.error("giving up polling import %s", import_id)
                return False
            sleep(POLL_INTERVAL_SECONDS)
            continue
        if state.get("status") == "active":
            logger.info("import %s active: %s documents", import_id, state.get("documents"))
            return True
        if state.get("status") == "failed":
            logger.error("import %s failed: %s", import_id, state.get("error"))
            return False
        sleep(POLL_INTERVAL_SECONDS)

    logger.error("timeout waiting for import %s", import_id)
    return False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Send a corpus JSON to docs-chat-api and wait until active.")
    parser.add_argument("corpus", help="corpus file from md_to_json.py (self-describing JSON)")
    parser.add_argument("--force", action="store_true",
                        help="activate even below the 70%% guard (intentional corpus shrink / clean re-import)")
    args = parser.parse_args(argv)

    try:
        config = get_docs_chat_config()
        corpus = load_corpus(args.corpus)
    except (ValueError, OSError, json.JSONDecodeError) as error:
        logger.error("%s", error)
        return 1

    return 0 if send_corpus(corpus, config, force=args.force) else 1


if __name__ == "__main__":
    sys.exit(main())
