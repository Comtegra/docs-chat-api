import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from send_json import (
    build_payload,
    get_docs_chat_config,
    load_corpus,
    send_corpus,
)


class ConfigTests(unittest.TestCase):
    def test_both_variables_required(self):
        with self.assertRaisesRegex(ValueError, "DOCS_CHAT_API_URL, DOCS_CHAT_INDEX_KEY"):
            get_docs_chat_config({})
        with self.assertRaisesRegex(ValueError, "missing required environment variables: DOCS_CHAT_INDEX_KEY"):
            get_docs_chat_config({"DOCS_CHAT_API_URL": "https://ask.example"})
        config = get_docs_chat_config({
            "DOCS_CHAT_API_URL": "https://ask.example/",
            "DOCS_CHAT_INDEX_KEY": "idx-key",
        })
        self.assertEqual(config, {"url": "https://ask.example", "key": "idx-key"})

    def test_unexpanded_ci_reference_fails_early(self):
        with self.assertRaisesRegex(ValueError, "must start with https://"):
            get_docs_chat_config({
                "DOCS_CHAT_API_URL": "${DOCS_CHAT_API_URL}",
                "DOCS_CHAT_INDEX_KEY": "k",
            })


class PayloadTests(unittest.TestCase):
    def test_payload_from_self_describing_corpus(self):
        corpus = {"locale": "pl", "source": "my-repo", "data": [{"title": "A", "text": "b"}]}
        payload = build_payload(corpus, env={"CI_COMMIT_SHA": "abc123"})
        self.assertEqual(payload["locale"], "pl")
        self.assertEqual(payload["source"], "my-repo")
        self.assertEqual(payload["commitSha"], "abc123")
        self.assertEqual(payload["data"], corpus["data"])
        self.assertNotIn("force", payload)

    def test_force_flag_adds_guard_override(self):
        corpus = {"locale": "en", "source": "s", "data": [{"title": "A", "text": "b"}]}
        self.assertEqual(build_payload(corpus, force=True)["force"], True)


class CorpusFileTests(unittest.TestCase):
    def test_corpus_file_without_data_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "corpus.json"
            path.write_text(json.dumps({"locale": "pl"}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "no data"):
                load_corpus(path)

    def test_corpus_file_without_locale_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "corpus.json"
            path.write_text(json.dumps({"data": [{"title": "A", "text": "b"}]}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "no locale"):
                load_corpus(path)


class SendTests(unittest.TestCase):
    def test_posts_corpus_then_polls_until_active(self):
        config = {"url": "https://ask.example", "key": "idx-key"}
        corpus = {"locale": "pl", "source": "my-repo", "data": [{"title": "Start", "text": "Body"}]}
        created = SimpleNamespace(raise_for_status=lambda: None, json=lambda: {"importId": "imp-1"})
        pending = SimpleNamespace(raise_for_status=lambda: None, json=lambda: {"status": "pending"})
        active = SimpleNamespace(raise_for_status=lambda: None, json=lambda: {"status": "active", "documents": 2})
        sleeps = []

        with patch("send_json.requests.post", return_value=created) as post:
            with patch("send_json.requests.get", side_effect=[pending, active]) as get:
                result = send_corpus(corpus, config, env={"CI_COMMIT_SHA": "abc123"}, sleep=sleeps.append)

        self.assertTrue(result)
        args, kwargs = post.call_args
        self.assertEqual(args[0], "https://ask.example/api/v1/index/import")
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer idx-key")
        self.assertEqual(kwargs["json"]["locale"], "pl")
        self.assertEqual(kwargs["json"]["source"], "my-repo")
        self.assertEqual(len(kwargs["json"]["data"]), 1)
        self.assertEqual(get.call_count, 2)
        self.assertEqual(len(sleeps), 1)  # one sleep between pending and active

    def test_failed_import_returns_false(self):
        config = {"url": "https://ask.example", "key": "idx-key"}
        corpus = {"locale": "pl", "source": "my-repo", "data": [{"title": "Start", "text": "Body"}]}
        created = SimpleNamespace(raise_for_status=lambda: None, json=lambda: {"importId": "imp-2"})
        failed = SimpleNamespace(raise_for_status=lambda: None,
                                json=lambda: {"status": "failed", "error": "boom"})

        with patch("send_json.requests.post", return_value=created):
            with patch("send_json.requests.get", return_value=failed):
                result = send_corpus(corpus, config, sleep=lambda _s: None)

        self.assertFalse(result)

    def test_force_reaches_the_payload(self):
        config = {"url": "https://ask.example", "key": "idx-key"}
        corpus = {"locale": "en", "source": "s", "data": [{"title": "A", "text": "b"}]}
        created = SimpleNamespace(raise_for_status=lambda: None, json=lambda: {"importId": "imp-3"})
        active = SimpleNamespace(raise_for_status=lambda: None, json=lambda: {"status": "active"})

        with patch("send_json.requests.post", return_value=created) as post:
            with patch("send_json.requests.get", return_value=active):
                self.assertTrue(send_corpus(corpus, config, force=True, sleep=lambda _s: None))

        self.assertEqual(post.call_args.kwargs["json"]["force"], True)


class PreflightTests(unittest.TestCase):
    def test_oversized_corpus_fails_before_any_request(self):
        config = {"url": "https://ask.example", "key": "idx-key"}
        corpus = {"locale": "en", "source": "s", "data": [{"title": "A", "text": "b"}]}
        with patch("send_json.IMPORT_MAX_BYTES", 10):
            with patch("send_json.requests.post") as post:
                self.assertFalse(send_corpus(corpus, config, sleep=lambda _s: None))
        post.assert_not_called()

    def test_too_many_documents_fails_before_any_request(self):
        config = {"url": "https://ask.example", "key": "idx-key"}
        corpus = {"locale": "en", "source": "s",
                  "data": [{"title": f"A{i}", "text": "b"} for i in range(2)]}
        with patch("send_json.IMPORT_MAX_DOCUMENTS", 1):
            with patch("send_json.requests.post") as post:
                self.assertFalse(send_corpus(corpus, config, sleep=lambda _s: None))
        post.assert_not_called()


class ErrorPathTests(unittest.TestCase):
    def test_http_error_on_post_returns_false(self):
        import requests
        config = {"url": "https://ask.example", "key": "idx-key"}
        corpus = {"locale": "pl", "source": "s", "data": [{"title": "A", "text": "b"}]}
        rejected = requests.exceptions.HTTPError("409 Client Error")
        rejected.response = SimpleNamespace(status_code=409, text='{"error":"An index job is already running"}')

        with patch("send_json.requests.post", side_effect=rejected):
            self.assertFalse(send_corpus(corpus, config, sleep=lambda _s: None))

    def test_polling_gives_up_after_three_consecutive_failures(self):
        import requests
        config = {"url": "https://ask.example", "key": "idx-key"}
        corpus = {"locale": "pl", "source": "s", "data": [{"title": "A", "text": "b"}]}
        created = SimpleNamespace(raise_for_status=lambda: None, json=lambda: {"importId": "imp-9"})

        with patch("send_json.requests.post", return_value=created):
            with patch("send_json.requests.get",
                       side_effect=requests.exceptions.ConnectionError("boom")):
                self.assertFalse(send_corpus(corpus, config, sleep=lambda _s: None))


if __name__ == "__main__":
    unittest.main()
