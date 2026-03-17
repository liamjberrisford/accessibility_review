# Browser Accessibility Reporter

This project provides two paths:

1. `index.html` web app that runs entirely in the browser (no backend, no upload to a server).
2. `scripts/local_accessibility_audit.py` local fallback that runs `pa11y-ci` from your machine.

The browser flow is designed to mirror the intent of the GitHub Action in `accessibility_complete.yml`: evaluate input content and produce an accessibility report. Since `pa11y` itself is Node/CLI-based, the browser app uses `axe-core` for in-browser audits and exports JSON/Markdown reports.

For PDF files, the browser app runs dedicated heuristic PDF checks (metadata, tagging indicators when available, and text extraction checks) rather than DOM-based `axe-core` rules.

## Browser mode (no server)

Open the site locally:

```bash
open index.html
```

Usage:

1. Upload one or more files, or a `.zip` containing files.
2. Click **Run Audit**.
3. Read results in-page and optionally download JSON/Markdown reports.

Supported input types in browser:

- `html`, `htm`
- `md`, `markdown`
- `txt`, `csv`, `json`, `xml`, `yml`, `yaml`
- `ipynb`
- `docx`
- `pdf` (heuristic PDF accessibility checks)
- `zip` (recursively extracts supported files)

Notes:

- All processing is in-memory in your browser tab.
- No file content is sent to this repo or any API.
- Nested `.zip` files are skipped.
- PDF checks are useful triage but not a full replacement for a dedicated PDF accessibility validator.

## Local mode (`pa11y-ci` via Python)

If users want a local `pa11y` workflow instead of browser-only scanning, use the Python helper script in this repo.

### Prerequisites

- Python 3.10+
- Node.js + npm (for `npx pa11y-ci`)

### Install Python dependency

```bash
python3 -m pip install -r requirements.txt
```

### Run

```bash
python3 scripts/local_accessibility_audit.py ./path/to/content_or_zip --output ./audit-output
```

You can pass multiple inputs:

```bash
python3 scripts/local_accessibility_audit.py ./docs ./slides.zip ./page.html --output ./audit-output
```

### Output files

- `audit-output/pa11y_output.json`
- `audit-output/pa11y_output.md`
- `audit-output/pa11yci.config.js` (generated config used for the run)

### Local script behavior

1. Expands `.zip` inputs to a temp workspace.
2. Converts supported files into temporary HTML pages.
3. Serves pages at `http://127.0.0.1:<port>/...`.
4. Executes `npx -y pa11y-ci --json --config <generated-config>`.
5. Writes JSON and Markdown report artifacts.

Supported local script input types:

- `html`, `htm`
- `md`, `markdown`
- `txt`, `csv`, `json`, `xml`, `yml`, `yaml`
- `ipynb`
- `pdf`
- `zip`

## Repository URL

Share this repository URL with users who want the local Python + `pa11y-ci` route. They can clone it and run the commands above directly.

## Support and issue reporting

If anyone finds a problem:

- Email: `l.berrisford3@exeter.ac.uk`
- Or open a GitHub Issue in this repository
