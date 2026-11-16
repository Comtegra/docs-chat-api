"""Corpus builder: markdown folder -> docs-chat-api import JSON.

Generic knowledge-base exporter for docs-chat-api (generalized from
cgc-user-docs/python/md_to_json.py, minus the Docusaurus-specific parts:
i18n/mirror/fallback logic, number-prefix slugs). Designed for the client
onboarding path: point it at a folder of markdown docs, get one JSON corpus
ready to POST to /api/v1/index/import.

Per file:
  * strips the leading `---` frontmatter block (scalar keys kept for title/slug),
  * converts wikilinks `[[path|label]]` / `[[path]]` to plain text,
  * removes non-rendered markup (HTML/MDX comments, fences masked),
  * emits a WHOLE PAGE: {title, text, file_path, metadata} — the service chunks
    documents at import time (chunk.mjs: `## ` sections, 8000 chars, 300 overlap)
    and adds `route#anchor` deep links; pre-chunked documents would pass through
    untouched and lose those anchors.

Route (metadata.route) MUST be a permalink starting with `/` — the service
zeroes routes without a leading slash on purpose (untrusted-URL defence).

Output corpus is self-describing JSON:
  {"locale": "pl", "source": "my-repo", "data": [ ...documents... ]}
so send_json.py needs no repeated configuration.
"""

import argparse
import fnmatch
import json
import logging
import os
import re
import sys
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler()],
)
logger = logging.getLogger("md_to_json")

SUPPORTED_LOCALES = ("en", "pl")
MARKDOWN_SUFFIXES = (".md", ".mdx")

# Closing fence may be indented 0-3 spaces independent of the opener (CommonMark).
_FENCE = re.compile(r"^[ \t]*(`{3,}|~{3,})[^\n]*\n.*?^[ \t]{0,3}\1[^\n]*$", re.M | re.S)
_HTML_COMMENT = re.compile(r"<!--.*?-->", re.S)
_MDX_COMMENT = re.compile(r"\{/\*.*?\*/\}", re.S)
_COMMENT_DELIM = re.compile(r"\{/\*|\*/\}|<!--|-->")
# Wikilink: [[path]] or [[path|label]] -> label | last path segment (Obsidian vaults);
# empty link [[]] (authoring artifact) -> removed; [[#heading]] -> heading name.
_WIKILINK = re.compile(r"\[\[([^\]|]*?)(?:\|([^\]]*?))?\]\]")
# Leading frontmatter block: `---\n...keys...\n---\n` (only at byte 0, as in Docusaurus).
_FRONTMATTER = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?", re.S)
_FRONTMATTER_KEY = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.+?)\s*$", re.M)
_H1_LINE = re.compile(r"^#\s+(.+?)\s*$")


def strip_non_rendered_markup(content: str) -> str:
    """Remove markup that is not rendered — HTML comments (<!-- -->) and MDX
    comments ({/* */}) — so commented-out content is not embedded. Idempotent.

    Code fences (``` and ~~~) are masked first, so a comment *inside* a fence is
    preserved and a fence *inside* a comment is removed with it. Ported 1:1 from
    cgc-user-docs/python/md_to_json.py.
    """
    blocks = []

    def _stash(match):
        blocks.append(match.group(0))
        # \x00 sentinel is leak-safe: author-written UTF-8 prose never contains NUL.
        return f"\x00F{len(blocks) - 1}\x00"

    masked = _FENCE.sub(_stash, content)                          # 1) mask fences FIRST
    masked = _MDX_COMMENT.sub("", _HTML_COMMENT.sub("", masked))  # 2) strip comments
    for index, block in enumerate(blocks):                        # 3) restore fences
        masked = masked.replace(f"\x00F{index}\x00", block)
    return masked


def has_comment_residue(stripped: str) -> bool:
    """A comment delimiter surviving OUTSIDE code fences after stripping signals
    an interleaved comment/fence (potential leak). Ported from cgc-user-docs
    md_to_json.py — reported, never silently embedded."""
    return bool(_COMMENT_DELIM.search(_FENCE.sub("", stripped)))


def _mask_fences(body: str) -> str:
    """Fence blocks blanked out with the SAME line count, so a line-by-line scan
    sees prose only — a `# install deps` comment inside ```bash must never become
    a document title. Fence CONTENTS stay in the real text (masking is scan-only)."""
    return _FENCE.sub(lambda match: "\n" * match.group(0).count("\n"), body)


def convert_wikilinks(text: str) -> str:
    """[[path|label]] -> label; [[path]] -> last path segment (without suffix);
    [[a|b|c]] -> b; [[#heading]] -> heading; [[]] -> removed.

    The service answers only from indexed text and links back to `route`, so a
    dead wikilink would embed as noise; the label carries the intent.
    """

    def _replace(match: re.Match) -> str:
        path, label = match.group(1), match.group(2)
        if label and label.strip():
            return label.strip().split("|")[0].strip()
        last_segment = path.strip().lstrip("#").rstrip("/").split("/")[-1]
        return Path(last_segment).stem or last_segment

    return _WIKILINK.sub(_replace, text)


def parse_frontmatter(content: str) -> tuple[dict, str]:
    """Scalar frontmatter keys (`key: value`) and the body without the block.

    Only flat scalar keys are extracted (title/slug); nested YAML is not parsed —
    the block is removed from the embedded text regardless (it is metadata, not prose).
    """
    match = _FRONTMATTER.match(content)
    if not match:
        return {}, content
    meta = {key: value.strip().strip("\"'") for key, value in _FRONTMATTER_KEY.findall(match.group(1))}
    return meta, content[match.end():]


def extract_title(body: str, file_path: Path) -> tuple[str, str, str]:
    """Title precedence: frontmatter (checked by caller) -> first H1 -> file name.

    Returns (title, body_without_the_h1_line, title_source). The H1 scan runs on
    fence-masked text (a fenced `# comment` must not win the title), but the line
    is cut from the ORIGINAL body; the emitted text starts with a synthetic `# {title}`.
    """
    masked_lines = _mask_fences(body).splitlines()
    original_lines = body.splitlines(keepends=True)
    for index, line in enumerate(masked_lines):
        h1_match = _H1_LINE.match(line)
        if h1_match:
            remaining = "".join(original_lines[:index] + original_lines[index + 1:])
            return h1_match.group(1), remaining, "h1"
    return file_path.stem, body, "filename"


def _drop_leading_h1_if_same_title(body: str, title: str) -> str:
    """Frontmatter title wins; an H1 with the same text at the very top of the body
    (only blank lines before it) would duplicate the heading in the emitted text —
    drop that line (scan is fence-masked, the cut happens on the original)."""
    masked_lines = _mask_fences(body).splitlines()
    line_index = 0
    while line_index < len(masked_lines) and not masked_lines[line_index].strip():
        line_index += 1
    if line_index < len(masked_lines):
        h1_match = _H1_LINE.match(masked_lines[line_index])
        if h1_match and h1_match.group(1).strip() == title.strip():
            original_lines = body.splitlines(keepends=True)
            return "".join(original_lines[:line_index] + original_lines[line_index + 1:])
    return body


def route_for(relative_path: Path, frontmatter: dict) -> str:
    """Permalink for a source file, always with a leading `/`.

    Precedence: frontmatter `slug:` (must start with `/`) -> file path without
    suffix; index/readme maps to the directory route with a trailing `/`
    (as rendered by static site generators). RAW, not percent-encoded.
    """
    slug = frontmatter.get("slug", "")
    if slug.startswith("/"):
        return slug
    parts = list(relative_path.with_suffix("").parts)
    if not parts:
        return "/"
    if parts[-1].lower() in {"index", "readme"}:
        parts = parts[:-1]
        return "/" + "/".join(parts) + "/" if parts else "/"
    return "/" + "/".join(parts)


def build_document(file_path: Path, source_root: Path, locale: str) -> dict | None:
    """One import document from one markdown file, or None (with a warning)."""
    relative = file_path.relative_to(source_root)
    try:
        raw = file_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        logger.warning("Cannot read %s: %s", relative, error)
        return None

    frontmatter, body = parse_frontmatter(raw)
    body = convert_wikilinks(strip_non_rendered_markup(body))
    if has_comment_residue(body):
        logger.warning("Interleaved comment/code fence survived stripping in %s — possible leak", relative)
    title = frontmatter.get("title", "").strip()
    if title:
        title_source = "frontmatter"
        body = _drop_leading_h1_if_same_title(body, title)
    else:
        title, body, title_source = extract_title(body, file_path)
    if title_source == "filename":
        logger.warning("No frontmatter title / H1 in %s — using file name", relative)

    text = f"# {title}\n{body.strip()}" if body.strip() else f"# {title}"
    return {
        "title": title,
        "text": text,
        "file_path": relative.as_posix(),
        "metadata": {
            "locale": locale.upper(),
            "route": route_for(relative, frontmatter),
            "sourceFilePath": relative.as_posix(),
            "sourceTitle": title,
        },
    }


def iter_markdown_files(source_root: Path, includes: list[str], excludes: list[str]) -> list[Path]:
    """Markdown files under `source_root`, filtered by fnmatch patterns applied
    to the posix path relative to the root. Excludes win over includes; `_`-
    prefixed and dot files/dirs are always skipped (partials/hidden).

    Patterns are case-SENSITIVE everywhere (fnmatchcase): the same corpus must
    come out on Windows and in Linux CI. `*`/`?` also match through `/` (fnmatch
    semantics, not .gitignore) — documented in README.
    """
    found: list[Path] = []
    for root, dirs, files in os.walk(source_root):
        dirs[:] = sorted(d for d in dirs if not d.startswith(("_", ".")))
        for file_name in sorted(files):
            if file_name.startswith(("_", ".")) or Path(file_name).suffix.lower() not in MARKDOWN_SUFFIXES:
                continue
            relative = (Path(root) / file_name).relative_to(source_root).as_posix()
            if excludes and any(fnmatch.fnmatchcase(relative, pattern) or fnmatch.fnmatchcase(file_name, pattern) for pattern in excludes):
                continue
            if includes and not any(fnmatch.fnmatchcase(relative, pattern) or fnmatch.fnmatchcase(file_name, pattern) for pattern in includes):
                continue
            found.append(Path(root) / file_name)
    return sorted(found, key=lambda path: path.relative_to(source_root).as_posix())


def build_corpus(source: str | Path, locale: str, source_name: str | None = None,
                 includes: list[str] | None = None, excludes: list[str] | None = None) -> dict:
    """Read a folder into a self-describing corpus: {"locale", "source", "data"}.

    Duplicate routes (two files collapsing onto the same permalink) do not fail
    the build, but are reported loudly — the service would index both and
    page-scope filtering could mix the pages.
    """
    source_root = Path(source)
    if not source_root.is_dir():
        raise FileNotFoundError(f"source folder not found: {source_root}")
    includes = includes or []
    excludes = excludes or []
    files = iter_markdown_files(source_root, includes, excludes)
    documents: list[dict] = []
    for file_path in files:
        document = build_document(file_path, source_root, locale)
        if document:
            documents.append(document)
    if not documents:
        raise ValueError(
            f"no markdown documents under {source_root}"
            + (f" matching includes {includes}" if includes else "")
            + (f" excluding {excludes}" if excludes else "")
        )
    routes: dict[str, list[str]] = {}
    for document in documents:
        routes.setdefault(document["metadata"]["route"], []).append(document["file_path"])
    for route, file_paths in sorted(routes.items()):
        if len(file_paths) > 1:
            logger.warning("duplicate route %s: %s — page-scope filtering may mix these pages", route, ", ".join(file_paths))
    return {
        "locale": locale,
        "source": source_name or source_root.resolve().name,
        "data": documents,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build a docs-chat-api import corpus from a markdown folder.")
    parser.add_argument("source", help="folder with .md/.mdx files (scanned recursively)")
    parser.add_argument("-o", "--out", default="corpus.json", help="output corpus file (default: corpus.json)")
    parser.add_argument("--locale", default="en", choices=SUPPORTED_LOCALES, help="index collection of the tenant (default: en)")
    parser.add_argument("--source", dest="source_name", default=None, help="import source label (default: folder name)")
    parser.add_argument("--include", action="append", default=[], metavar="PATTERN",
                        help="fnmatch pattern for relative paths (repeatable); default: all")
    parser.add_argument("--exclude", action="append", default=[], metavar="PATTERN",
                        help="fnmatch pattern to skip (repeatable); wins over --include")
    args = parser.parse_args(argv)

    try:
        corpus = build_corpus(args.source, args.locale, args.source_name, args.include, args.exclude)
    except (FileNotFoundError, ValueError, OSError) as error:
        logger.error("%s", error)
        return 1
    try:
        Path(args.out).write_text(json.dumps(corpus, indent=2, ensure_ascii=False), encoding="utf-8")
    except OSError as error:
        logger.error("cannot write %s: %s", args.out, error)
        return 1
    logger.info("wrote %s documents to %s (locale=%s, source=%s)", len(corpus["data"]), args.out, corpus["locale"], corpus["source"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
