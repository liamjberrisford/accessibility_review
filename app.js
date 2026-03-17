const state = {
  queued: [],
  reports: [],
};

if (typeof pdfjsLib !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js";
}

const supportedExtensions = new Set([
  "html",
  "htm",
  "md",
  "markdown",
  "txt",
  "csv",
  "json",
  "xml",
  "yml",
  "yaml",
  "ipynb",
  "docx",
  "pdf",
  "zip",
]);

const fileInput = document.getElementById("fileInput");
const runAuditBtn = document.getElementById("runAudit");
const clearAllBtn = document.getElementById("clearAll");
const downloadJsonBtn = document.getElementById("downloadJson");
const downloadMdBtn = document.getElementById("downloadMd");
const fileList = document.getElementById("fileList");
const summary = document.getElementById("summary");
const results = document.getElementById("results");

fileInput.addEventListener("change", onFileSelection);
runAuditBtn.addEventListener("click", runAudit);
clearAllBtn.addEventListener("click", clearAll);
downloadJsonBtn.addEventListener("click", downloadJson);
downloadMdBtn.addEventListener("click", downloadMarkdown);

function extensionOf(name) {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i + 1).toLowerCase();
}

function normalizeHtmlDocument(content, title) {
  if (/<html[\s>]/i.test(content)) return content;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(
    title
  )}</title></head><body>${content}</body></html>`;
}

function escapeHtml(s) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function onFileSelection() {
  const selected = Array.from(fileInput.files || []);
  for (const file of selected) {
    await enqueueFile(file, file.name);
  }
  renderQueue();
}

async function enqueueFile(fileOrBlob, logicalName) {
  const ext = extensionOf(logicalName);
  if (!supportedExtensions.has(ext)) {
    state.queued.push({ name: logicalName, status: "unsupported", reason: `Unsupported file type: .${ext || "unknown"}` });
    return;
  }

  if (ext === "zip") {
    const arrayBuffer = await fileOrBlob.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);
    const entries = Object.values(zip.files).filter((entry) => !entry.dir);
    for (const entry of entries) {
      const entryExt = extensionOf(entry.name);
      if (!supportedExtensions.has(entryExt) || entryExt === "zip") {
        state.queued.push({ name: `${logicalName}:${entry.name}`, status: "unsupported", reason: `Skipped nested/unsupported entry .${entryExt || "unknown"}` });
        continue;
      }
      const blob = await entry.async("blob");
      await enqueueFile(blob, `${logicalName}:${entry.name}`);
    }
    return;
  }

  state.queued.push({ name: logicalName, blob: fileOrBlob, ext, status: "ready" });
}

function renderQueue() {
  fileList.innerHTML = "";
  for (const item of state.queued) {
    const li = document.createElement("li");
    li.textContent = item.status === "ready" ? item.name : `${item.name} (${item.reason})`;
    fileList.appendChild(li);
  }
  runAuditBtn.disabled = !state.queued.some((x) => x.status === "ready");
}

async function buildAuditHtml(item) {
  if (item.ext === "html" || item.ext === "htm") {
    const text = await item.blob.text();
    return normalizeHtmlDocument(text, item.name);
  }

  if (item.ext === "md" || item.ext === "markdown") {
    const text = await item.blob.text();
    const body = marked.parse(text, { gfm: true, breaks: false });
    return normalizeHtmlDocument(`<main>${body}</main>`, item.name);
  }

  if (item.ext === "ipynb") {
    const text = await item.blob.text();
    try {
      const nb = JSON.parse(text);
      const cellHtml = (nb.cells || [])
        .map((cell) => {
          const source = Array.isArray(cell.source) ? cell.source.join("") : cell.source || "";
          if (cell.cell_type === "markdown") {
            return `<section>${marked.parse(source)}</section>`;
          }
          return `<section><pre><code>${escapeHtml(source)}</code></pre></section>`;
        })
        .join("\n");
      return normalizeHtmlDocument(`<article>${cellHtml}</article>`, item.name);
    } catch {
      return normalizeHtmlDocument(`<pre>${escapeHtml(text)}</pre>`, item.name);
    }
  }

  if (item.ext === "docx") {
    const arrayBuffer = await item.blob.arrayBuffer();
    try {
      const result = await mammoth.convertToHtml({ arrayBuffer });
      return normalizeHtmlDocument(`<main>${result.value}</main>`, item.name);
    } catch {
      return normalizeHtmlDocument(`<pre>Unable to parse DOCX for ${escapeHtml(item.name)}</pre>`, item.name);
    }
  }

  if (["txt", "csv", "json", "xml", "yml", "yaml"].includes(item.ext)) {
    const text = await item.blob.text();
    return normalizeHtmlDocument(`<main><pre>${escapeHtml(text)}</pre></main>`, item.name);
  }

  if (item.ext === "pdf") {
    return null;
  }

  return null;
}

function createAuditFrame(html) {
  return new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.style.position = "absolute";
    iframe.style.width = "1px";
    iframe.style.height = "1px";
    iframe.style.left = "-9999px";
    iframe.setAttribute("sandbox", "allow-same-origin allow-scripts");
    document.body.appendChild(iframe);
    iframe.onload = () => resolve(iframe);
    iframe.srcdoc = html;
  });
}

async function auditHtml(item, html) {
  const frame = await createAuditFrame(html);
  try {
    const doc = frame.contentDocument;
    const result = await frame.contentWindow.axe.run(doc, {
      resultTypes: ["violations", "incomplete", "passes"],
    });
    return {
      file: item.name,
      url: `in-memory://${item.name}`,
      auditEngine: "axe-core",
      violations: result.violations,
      incomplete: result.incomplete,
      passes: result.passes.length,
    };
  } finally {
    frame.remove();
  }
}

function pdfViolation(id, help, detail, target = "document", impact = "serious") {
  return {
    id,
    impact,
    help,
    helpUrl: "",
    nodes: [{ target: [target], failureSummary: detail }],
  };
}

async function auditPdf(item) {
  if (typeof pdfjsLib === "undefined") {
    throw new Error("PDF library could not be loaded in this browser session.");
  }

  const bytes = await item.blob.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: bytes });
  const pdf = await loadingTask.promise;

  const violations = [];
  let passes = 0;

  let metadataResult = null;
  try {
    metadataResult = await pdf.getMetadata();
  } catch {
    metadataResult = null;
  }

  const title = metadataResult?.info?.Title || metadataResult?.metadata?.get?.("dc:title") || "";
  const language = metadataResult?.info?.Language || metadataResult?.metadata?.get?.("dc:language") || "";

  if (!title) {
    violations.push(
      pdfViolation(
        "pdf-title-missing",
        "PDF does not have a document title in metadata.",
        "Add a meaningful Title in the PDF document properties."
      )
    );
  } else {
    passes += 1;
  }

  if (!language) {
    violations.push(
      pdfViolation(
        "pdf-language-missing",
        "PDF does not declare a document language.",
        "Set a language (for example en-GB) in the PDF metadata."
      )
    );
  } else {
    passes += 1;
  }

  if (typeof pdf.getMarkInfo === "function") {
    try {
      const markInfo = await pdf.getMarkInfo();
      if (!markInfo?.Marked) {
        violations.push(
          pdfViolation(
            "pdf-not-tagged",
            "PDF is not tagged for accessibility.",
            "Export as a tagged PDF so reading order and semantic structure are available."
          )
        );
      } else {
        passes += 1;
      }

      if (markInfo?.Suspects) {
        violations.push(
          pdfViolation(
            "pdf-tagging-suspect",
            "PDF tagging is marked as suspect.",
            "Review tagged structure in an accessibility checker and fix tag quality issues."
          )
        );
      } else {
        passes += 1;
      }
    } catch {
      violations.push(
        pdfViolation(
          "pdf-tag-check-unavailable",
          "Unable to verify PDF tag structure in this browser.",
          "Run a dedicated PDF accessibility checker for full tag validation.",
          "metadata",
          "moderate"
        )
      );
    }
  } else {
    violations.push(
      pdfViolation(
        "pdf-tag-check-unsupported",
        "This browser could not inspect PDF tag metadata.",
        "Run a dedicated PDF accessibility checker for full tag validation.",
        "metadata",
        "moderate"
      )
    );
  }

  const pagesWithoutText = [];
  for (let p = 1; p <= pdf.numPages; p += 1) {
    const page = await pdf.getPage(p);
    const text = await page.getTextContent();
    const textLength = (text.items || []).reduce((acc, x) => acc + String(x.str || "").trim().length, 0);
    if (textLength === 0) {
      pagesWithoutText.push(p);
    }
  }

  if (pagesWithoutText.length > 0) {
    violations.push(
      pdfViolation(
        "pdf-page-no-text",
        "Some pages appear to have no extractable text.",
        `Pages with no text: ${pagesWithoutText.join(", ")}. These may be scanned images without OCR or text tags.`,
        "pages"
      )
    );
  } else {
    passes += 1;
  }

  return {
    file: item.name,
    url: `in-memory://${item.name}`,
    auditEngine: "pdf-heuristics",
    violations,
    incomplete: [],
    passes,
  };
}

function renderResults() {
  results.innerHTML = "";
  const files = state.reports.length;
  const totalViolations = state.reports.reduce((sum, report) => sum + report.violations.length, 0);
  summary.textContent = `Files audited: ${files} | Total violations: ${totalViolations}`;

  for (const report of state.reports) {
    const card = document.createElement("article");
    card.className = "result-card";
    const title = document.createElement("h3");
    title.textContent = `${report.file} (${report.violations.length} violations)`;
    card.appendChild(title);

    if (report.violations.length === 0) {
      const p = document.createElement("p");
      p.textContent = report.auditEngine === "pdf-heuristics" ? "No PDF heuristic issues found." : "No violations found by axe-core.";
      card.appendChild(p);
    } else {
      report.violations.forEach((violation) => {
        const p = document.createElement("p");
        p.innerHTML = `<strong>${escapeHtml(violation.id)}</strong> [${escapeHtml(
          violation.impact || "unknown"
        )}] ${escapeHtml(violation.help)}`;
        card.appendChild(p);

        violation.nodes.slice(0, 2).forEach((node) => {
          const code = document.createElement("code");
          code.textContent = `${(node.target || []).join(" ")} -> ${node.failureSummary || "No detail"}`;
          card.appendChild(code);
          card.appendChild(document.createElement("br"));
        });
      });
    }
    results.appendChild(card);
  }
}

function reportAsMarkdown() {
  const lines = [
    "# Accessibility Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
  ];

  for (const report of state.reports) {
    lines.push(`## ${report.file}`);
    lines.push("");
    lines.push(`- Violations: ${report.violations.length}`);
    lines.push(`- Incomplete checks: ${report.incomplete.length}`);
    lines.push(`- Passes: ${report.passes}`);
    lines.push("");

    if (report.violations.length === 0) {
      lines.push("No violations found.");
      lines.push("");
      continue;
    }

    for (const v of report.violations) {
      lines.push(`### ${v.id} (${v.impact || "unknown"})`);
      lines.push(v.help);
      lines.push(`More info: ${v.helpUrl}`);
      lines.push("");
      for (const node of v.nodes.slice(0, 3)) {
        lines.push(`- Target: ${Array.isArray(node.target) ? node.target.join(" ") : "n/a"}`);
        lines.push(`- Detail: ${(node.failureSummary || "").replace(/\n+/g, " ")}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function downloadBlob(name, data, type) {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadJson() {
  downloadBlob("accessibility-report.json", JSON.stringify(state.reports, null, 2), "application/json");
}

function downloadMarkdown() {
  downloadBlob("accessibility-report.md", reportAsMarkdown(), "text/markdown");
}

async function runAudit() {
  state.reports = [];
  summary.textContent = "Running audits...";
  results.innerHTML = "";

  const ready = state.queued.filter((x) => x.status === "ready");
  for (const item of ready) {
    try {
      let report = null;
      if (item.ext === "pdf") {
        report = await auditPdf(item);
      } else {
        const html = await buildAuditHtml(item);
        if (!html) {
          continue;
        }
        report = await auditHtml(item, html);
      }
      state.reports.push(report);
    } catch (error) {
      state.reports.push({
        file: item.name,
        url: `in-memory://${item.name}`,
        auditEngine: item.ext === "pdf" ? "pdf-heuristics" : "axe-core",
        violations: [
          {
            id: "internal-error",
            impact: "serious",
            help: `Audit failed: ${error.message}`,
            helpUrl: "",
            nodes: [{ target: ["document"], failureSummary: "Unhandled parsing or runtime error." }],
          },
        ],
        incomplete: [],
        passes: 0,
      });
    }
  }

  renderResults();
  downloadJsonBtn.disabled = state.reports.length === 0;
  downloadMdBtn.disabled = state.reports.length === 0;
}

function clearAll() {
  state.queued = [];
  state.reports = [];
  fileInput.value = "";
  renderQueue();
  results.innerHTML = "";
  summary.textContent = "No report yet.";
  downloadJsonBtn.disabled = true;
  downloadMdBtn.disabled = true;
}
