#!/usr/bin/env python3
"""Buduje ZIP-y dystrybucyjne docs-chat-kit (deterministycznie, stdlib).

Usage:  python docs-chat-kit/package.py
Output: docs-chat-kit/dist/docs-chat-kit-github.zip
        docs-chat-kit/dist/docs-chat-kit-gitlab.zip

Klient rozpakowuje ZIP w root swojego repo: dostaje docs-chat-kit/ (2 skrypty)
+ plik CI w root ZIP-a, który przenosi do swojej platformy (GitHub: .github/workflows/,
GitLab: include: local). To jedyne pliki w paczce — README i testy zostają w repo.
"""

import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
DIST = HERE / "dist"
# stały timestamp = te same bajty dla tego samego kodu (reproducible build)
ZIP_DATE = (2026, 1, 1, 0, 0, 0)

SCRIPTS = ["md_to_json.py", "send_json.py"]


def add(zip_file: zipfile.ZipFile, arcname: str, source: Path) -> None:
    zip_file.writestr(zipfile.ZipInfo(arcname, ZIP_DATE), source.read_bytes())


def build(name: str, ci_arcname: str, ci_source: Path) -> Path:
    out = DIST / name
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for script in SCRIPTS:
            add(zf, f"docs-chat-kit/{script}", HERE / script)
        add(zf, ci_arcname, ci_source)
    return out


def main() -> None:
    DIST.mkdir(exist_ok=True)
    github = build(
        "docs-chat-kit-github.zip",
        "docs-chat-index.yml",
        HERE / ".github" / "workflows" / "docs-chat-index.yml",
    )
    gitlab = build(
        "docs-chat-kit-gitlab.zip",
        "gitlab-ci.docs-chat.yml",
        HERE / "gitlab-ci.docs-chat.yml",
    )
    for path in (github, gitlab):
        print(f"{path.relative_to(HERE.parent)}  ({path.stat().st_size} B)")


if __name__ == "__main__":
    main()
