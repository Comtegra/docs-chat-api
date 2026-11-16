import tempfile
import unittest
from pathlib import Path

from md_to_json import (
    build_corpus,
    build_document,
    convert_wikilinks,
    extract_title,
    iter_markdown_files,
    parse_frontmatter,
    route_for,
    strip_non_rendered_markup,
)


class ParseTests(unittest.TestCase):
    def test_frontmatter_stripped_and_scalar_keys_kept(self):
        raw = "---\ntitle: My Title\nslug: /custom/route\ntags:\n  - a\n---\n\nBody text."
        meta, body = parse_frontmatter(raw)
        self.assertEqual(meta["title"], "My Title")
        self.assertEqual(meta["slug"], "/custom/route")
        self.assertTrue(body.startswith("Body text."))

    def test_no_frontmatter_returns_body_untouched(self):
        raw = "# Heading\n\nBody."
        meta, body = parse_frontmatter(raw)
        self.assertEqual(meta, {})
        self.assertEqual(raw, body)

    def test_wikilink_with_label_uses_label(self):
        self.assertEqual(convert_wikilinks("see [[projects/foo|the foo project]] now"),
                         "see the foo project now")

    def test_wikilink_without_label_uses_last_segment(self):
        self.assertEqual(convert_wikilinks("see [[projects/foo]] and [[bar.md]]"),
                         "see foo and bar")

    def test_empty_wikilink_removed(self):
        self.assertEqual(convert_wikilinks("empty [[]] artifact"), "empty  artifact")

    def test_comments_removed_but_fence_contents_preserved(self):
        raw = "a <!-- hidden --> b\n\n```html\n<!-- stays -->\n```\ndone"
        stripped = strip_non_rendered_markup(raw)
        self.assertNotIn(" hidden ", stripped)
        self.assertIn("<!-- stays -->", stripped)
        self.assertIn("done", stripped)

    def test_title_from_h1_and_h1_removed_from_body(self):
        title, body, source = extract_title("Intro line\n\n# Real Title\n\nBody.", Path("x/file.md"))
        self.assertEqual((title, source), ("Real Title", "h1"))
        self.assertNotIn("# Real Title", body)
        self.assertIn("Body.", body)

    def test_title_falls_back_to_filename(self):
        title, _body, source = extract_title("Just body.", Path("x/file-name.md"))
        self.assertEqual((title, source), ("file-name", "filename"))

    def test_h1_not_taken_from_code_fence(self):
        body = "```bash\n# install deps\n```\n\n# Real Title\n\nBody."
        title, remaining, source = extract_title(body, Path("x/file.md"))
        self.assertEqual((title, source), ("Real Title", "h1"))
        # the fenced comment stays in the indexed text — the title never eats code
        self.assertIn("# install deps", remaining)
        self.assertNotIn("# Real Title", remaining)

    def test_fence_before_h1_does_not_break_line_numbers(self):
        body = "Intro.\n\n```python\n# comment\nx = 1\n```\n\n# Title Line\nTail."
        title, remaining, _source = extract_title(body, Path("x/f.md"))
        self.assertEqual(title, "Title Line")
        self.assertIn("x = 1", remaining)  # fence content intact
        self.assertIn("Tail.", remaining)

    def test_wikilink_with_second_pipe_takes_first_label(self):
        self.assertEqual(convert_wikilinks("[[a|b|c]]"), "b")

    def test_heading_wikilink_uses_heading_name(self):
        self.assertEqual(convert_wikilinks("[[#Section]]"), "Section")


class RouteTests(unittest.TestCase):
    def test_route_always_leading_slash(self):
        self.assertEqual(route_for(Path("docs/intro.md"), {}), "/docs/intro")

    def test_index_maps_to_directory_with_trailing_slash(self):
        self.assertEqual(route_for(Path("docs/index.md"), {}), "/docs/")
        self.assertEqual(route_for(Path("index.md"), {}), "/")

    def test_frontmatter_slug_wins(self):
        self.assertEqual(route_for(Path("docs/intro.md"), {"slug": "/custom/route"}), "/custom/route")


class BuildTests(unittest.TestCase):
    def _write(self, root: Path, relative: str, content: str):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def test_document_shape_and_cleaning(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write(root, "projects/paper.md",
                        "---\ntitle: Paper Title\ndate: 2026-10-16\n---\n\n"
                        "Intro <!-- hidden comment --> and [[other/note|the other note]].\n\n"
                        "# Paper Title\n\nBody.")
            document = build_document(root / "projects/paper.md", root, "pl")
        self.assertEqual(document["title"], "Paper Title")
        self.assertEqual(document["file_path"], "projects/paper.md")
        self.assertEqual(document["metadata"]["route"], "/projects/paper")
        self.assertEqual(document["metadata"]["locale"], "PL")
        self.assertTrue(document["text"].startswith("# Paper Title\n"))
        self.assertNotIn("---", document["text"])           # frontmatter gone
        self.assertNotIn("hidden comment", document["text"])  # comment gone
        self.assertNotIn("[[", document["text"])            # wikilink converted
        self.assertIn("the other note", document["text"])
        # H1 with the same text as frontmatter title sits MID-DOCUMENT here (after
        # "Intro…") — it is an author section, not a duplicate heading; it stays.
        self.assertIn("# Paper Title\n\nBody.", document["text"])

    def test_same_title_h1_at_top_is_dropped(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write(root, "note.md", "---\ntitle: Dup\n---\n\n# Dup\n\nBody.")
            document = build_document(root / "note.md", root, "en")
        self.assertEqual(document["text"].count("# Dup"), 1)  # only the synthetic one

    def test_include_exclude_filters(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write(root, "projects/a.md", "# A")
            self._write(root, "projects/b.md", "# B")
            self._write(root, "dziennik/2026-10-16.md", "# D")
            files = iter_markdown_files(root, ["projects/*"], [])
            self.assertEqual([f.name for f in files], ["a.md", "b.md"])
            files = iter_markdown_files(root, [], ["projects/b.md"])
            # sorted by relative posix path: dziennik/... < projects/...
            self.assertEqual([f.name for f in files], ["2026-10-16.md", "a.md"])

    def test_hidden_and_partial_files_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write(root, "_partials/skip.md", "# S")
            self._write(root, ".hidden/skip.md", "# H")
            self._write(root, "keep.md", "# K")
            files = iter_markdown_files(root, [], [])
            self.assertEqual([f.name for f in files], ["keep.md"])

    def test_corpus_is_self_describing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write(root, "docs/intro.md", "# Intro\nHello.")
            corpus = build_corpus(root, locale="pl", source_name="my-repo")
        self.assertEqual(corpus["locale"], "pl")
        self.assertEqual(corpus["source"], "my-repo")
        self.assertEqual(len(corpus["data"]), 1)

    def test_empty_result_is_an_error_not_an_empty_import(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                build_corpus(Path(tmp), locale="en")

    def test_missing_source_folder_raises(self):
        with self.assertRaises(FileNotFoundError):
            build_corpus(Path("no/such/folder"), locale="en")

    def test_duplicate_routes_are_reported_not_fatal(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write(root, "docs/index.md", "# Index page")
            self._write(root, "docs/readme.md", "# Readme page")
            with self.assertLogs("md_to_json", level="WARNING") as logs:
                corpus = build_corpus(root, locale="en")
        self.assertEqual(len(corpus["data"]), 2)
        self.assertTrue(any("duplicate route /docs/" in message for message in logs.output))

    def test_include_patterns_are_case_sensitive(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            # same folder, differently-cased FILES (dirs would collide on NTFS)
            self._write(root, "docs/Alpha.md", "# A")
            self._write(root, "docs/beta.md", "# B")
            files = iter_markdown_files(root, ["docs/beta.md"], [])
            self.assertEqual([f.name for f in files], ["beta.md"])
            files = iter_markdown_files(root, ["docs/BETA.md"], [])
            self.assertEqual(files, [])

    def test_crlf_files_build_like_lf(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "win.md").write_bytes(b"# Title\r\n\r\nBody.\r\n")
            corpus = build_corpus(root, locale="en")
        document = corpus["data"][0]
        self.assertEqual(document["title"], "Title")
        self.assertIn("Body.", document["text"])
        self.assertNotIn("\r", document["text"])


if __name__ == "__main__":
    unittest.main()
