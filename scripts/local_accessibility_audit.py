#!/usr/bin/env python3
"""Local accessibility audit helper that mirrors the GitHub Action approach.

- Accepts a directory, file list, or .zip archive.
- Converts supported non-HTML content to temporary HTML.
- Serves files on localhost and runs pa11y-ci.
- Writes JSON and Markdown reports.
"""

from __future__ import annotations

import argparse
import html
import json
import shutil
import socket
import subprocess
import sys
import tempfile
import textwrap
import zipfile
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from threading import Thread
from typing import Iterable

try:
    import markdown
except ImportError:  # pragma: no cover
    markdown = None

try:
    from pypdf import PdfReader
except ImportError:  # pragma: no cover
    PdfReader = None


SUPPORTED_EXTENSIONS = {
    ".html",
    ".htm",
    ".md",
    ".markdown",
    ".txt",
    ".csv",
    ".json",
    ".xml",
    ".yml",
    ".yaml",
    ".ipynb",
    ".pdf",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run pa11y-ci against local content.")
    parser.add_argument("input", nargs="+", help="Input files/directories/zip archives")
    parser.add_argument("--output", default="./audit-output", help="Output directory")
    return parser.parse_args()


def copy_or_extract(inputs: Iterable[str], workspace: Path) -> list[Path]:
    materialized: list[Path] = []
    for raw in inputs:
        src = Path(raw).expanduser().resolve()
        if not src.exists():
            raise FileNotFoundError(f"Input not found: {src}")

        if src.is_file() and src.suffix.lower() == ".zip":
            extract_dir = workspace / f"zip_{src.stem}"
            extract_dir.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(src, "r") as archive:
                archive.extractall(extract_dir)
            materialized.append(extract_dir)
            continue

        if src.is_dir():
            copied = workspace / src.name
            shutil.copytree(src, copied, dirs_exist_ok=True)
            materialized.append(copied)
            continue

        copied_file = workspace / src.name
        copied_file.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, copied_file)
        materialized.append(copied_file)
    return materialized


def list_supported_files(paths: Iterable[Path]) -> list[Path]:
    out: list[Path] = []
    for p in paths:
        if p.is_dir():
            for child in p.rglob("*"):
                if child.is_file() and child.suffix.lower() in SUPPORTED_EXTENSIONS:
                    out.append(child)
        elif p.is_file() and p.suffix.lower() in SUPPORTED_EXTENSIONS:
            out.append(p)
    return sorted(out)


def make_html_doc(title: str, body: str) -> str:
    return textwrap.dedent(
        f"""\
        <!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <title>{html.escape(title)}</title>
          </head>
          <body>
            {body}
          </body>
        </html>
        """
    )


def render_ipynb(path: Path) -> str:
    try:
        notebook = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except json.JSONDecodeError:
        return make_html_doc(path.name, f"<pre>{html.escape(path.read_text(encoding='utf-8', errors='replace'))}</pre>")

    chunks: list[str] = []
    for cell in notebook.get("cells", []):
        source = "".join(cell.get("source", [])) if isinstance(cell.get("source"), list) else str(cell.get("source", ""))
        if cell.get("cell_type") == "markdown" and markdown:
            chunks.append(markdown.markdown(source))
        else:
            chunks.append(f"<pre><code>{html.escape(source)}</code></pre>")
    return make_html_doc(path.name, "\n".join(chunks))


def render_pdf(path: Path) -> str:
    if PdfReader is None:
        return make_html_doc(
            path.name,
            "<p>PDF support requires pypdf. Install dependencies from requirements.txt.</p>",
        )

    try:
        reader = PdfReader(str(path))
        chunks: list[str] = []
        for i, page in enumerate(reader.pages, start=1):
            text = page.extract_text() or ""
            if text.strip():
                chunks.append(f"<h2>Page {i}</h2><pre>{html.escape(text)}</pre>")
            else:
                chunks.append(
                    f"<h2>Page {i}</h2><p>No extractable text on this page (possible scanned image without OCR).</p>"
                )
        title = ""
        if reader.metadata:
            title = str(reader.metadata.get("/Title") or "")
        doc_title = title.strip() or path.name
        return make_html_doc(doc_title, "\n".join(chunks))
    except Exception as exc:  # pragma: no cover
        return make_html_doc(path.name, f"<p>Unable to parse PDF: {html.escape(str(exc))}</p>")


def convert_to_html(src: Path, dest_root: Path) -> Path:
    safe_name = "".join(ch if ch.isalnum() or ch in {"-", "_", "."} else "_" for ch in src.name)
    dest = dest_root / f"{safe_name}.html"
    ext = src.suffix.lower()

    if ext in {".html", ".htm"}:
        content = src.read_text(encoding="utf-8", errors="replace")
        if "<html" in content.lower():
            dest.write_text(content, encoding="utf-8")
        else:
            dest.write_text(make_html_doc(src.name, content), encoding="utf-8")
        return dest

    if ext in {".md", ".markdown"} and markdown:
        body = markdown.markdown(src.read_text(encoding="utf-8", errors="replace"))
        dest.write_text(make_html_doc(src.name, body), encoding="utf-8")
        return dest

    if ext == ".ipynb":
        dest.write_text(render_ipynb(src), encoding="utf-8")
        return dest

    if ext == ".pdf":
        dest.write_text(render_pdf(src), encoding="utf-8")
        return dest

    text = src.read_text(encoding="utf-8", errors="replace")
    dest.write_text(make_html_doc(src.name, f"<pre>{html.escape(text)}</pre>"), encoding="utf-8")
    return dest


def get_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def run_server(directory: Path, port: int) -> ThreadingHTTPServer:
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(directory), **kwargs)

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def write_markdown_report(json_data: list[dict], output_md: Path) -> None:
    lines = ["# pa11y-ci Local Report", ""]
    for record in json_data:
        issue_count = len(record.get("issues", []))
        lines.append(f"## {record.get('pageUrl', 'unknown')} ({issue_count} issues)")
        lines.append("")
        if issue_count == 0:
            lines.append("No issues found.")
            lines.append("")
            continue
        for issue in record.get("issues", []):
            lines.append(f"- `{issue.get('code', 'unknown')}` [{issue.get('type', 'notice')}] {issue.get('message', '')}")
        lines.append("")
    output_md.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="a11y-input-") as tmp_input, tempfile.TemporaryDirectory(
        prefix="a11y-site-"
    ) as tmp_site:
        workspace = Path(tmp_input)
        site_dir = Path(tmp_site)

        materialized = copy_or_extract(args.input, workspace)
        supported = list_supported_files(materialized)
        if not supported:
            print("No supported files found.", file=sys.stderr)
            return 2

        html_files = [convert_to_html(path, site_dir) for path in supported]

        port = get_free_port()
        server = run_server(site_dir, port)
        try:
            urls = [f"http://127.0.0.1:{port}/{f.name}" for f in html_files]
            config_file = output_dir / "pa11yci.config.js"
            config_file.write_text(
                "module.exports = "
                + json.dumps(
                    {
                        "urls": urls,
                        "defaults": {
                            "standard": "WCAG2AA",
                            "timeout": 120000,
                            "wait": 300,
                            "chromeLaunchConfig": {"args": ["--no-sandbox", "--disable-dev-shm-usage"]},
                        },
                    },
                    indent=2,
                )
                + ";\n",
                encoding="utf-8",
            )

            cmd = [
                "npx",
                "-y",
                "pa11y-ci",
                "--json",
                "--config",
                str(config_file),
            ]
            run = subprocess.run(cmd, capture_output=True, text=True)

            raw = run.stdout.strip()
            json_output = output_dir / "pa11y_output.json"
            md_output = output_dir / "pa11y_output.md"

            try:
                parsed = json.loads(raw) if raw else []
            except json.JSONDecodeError:
                parsed = []

            json_output.write_text(json.dumps(parsed, indent=2), encoding="utf-8")
            write_markdown_report(parsed if isinstance(parsed, list) else [], md_output)

            if run.returncode not in (0, 2):
                sys.stderr.write(run.stderr)
                print("pa11y-ci execution failed.", file=sys.stderr)
                return run.returncode

            total = sum(len(item.get("issues", [])) for item in parsed) if isinstance(parsed, list) else 0
            print(f"Audited {len(urls)} files. Total issues: {total}")
            print(f"JSON report: {json_output}")
            print(f"Markdown report: {md_output}")
            return 0
        finally:
            server.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())
