import React, { useCallback, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as pdfjsLib from "pdfjs-dist";
import { PDFDocument } from "pdf-lib";
import JSZip from "jszip";
import "./styles.css";

// Keep the PDF.js worker bundled with the app so no external document-processing
// service is used. All parsing and PDF assembly happen in the user's browser.
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

const CATEGORY_META = {
  "Loan and Security Agreement": { short: "Loan and Security Agreement", color: "blue" },
  "Note": { short: "Note", color: "purple" },
  "Mortgage": { short: "Mortgage", color: "green" },
  "Lender's Closing Instructions": { short: "Lender's Closing Instructions", color: "orange" },
  "LD All": { short: "LD All", color: "gray" }
};

const STOP_RE = /\bSTOP\s*!?/i;
const STOP_CONTEXT_RE = /(following|requires|borrower\(s\)|initials|required in the footer)/i;

function cleanText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}
function normalize(s) {
  return cleanText(s).toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]/g, " ");
}
function isStopPage(text) {
  const t = cleanText(text);
  return STOP_RE.test(t) && STOP_CONTEXT_RE.test(t);
}
function titleCategory(footerText, fullText) {
  const f = normalize(footerText);
  const t = normalize(fullText);
  // Related addenda are deliberately assigned to their parent document.
  if (f.includes("addendum to loan and security agreement") ||
      f.includes("loan and security agreement") ||
      t.includes("addendum to loan and security agreement re survival event")) {
    return "Loan and Security Agreement";
  }
  if (f.includes("addendum to secured note") ||
      f === "note" || f.includes(" note loan no") ||
      t.includes("addendum to secured note re survival event")) {
    return "Note";
  }
  if (f.includes("lender's closing instructions") || f.includes("lender s closing instructions")) {
    return "Lender's Closing Instructions";
  }
  if (f.includes("mortgage") || f.includes("security instrument")) {
    return "Mortgage";
  }
  return "LD All";
}

async function readPdf(file, setProgress) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1 });
    const lines = [];
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
      lines.push({ str: item.str, x, y });
    }
    const fullText = lines.sort((a,b) => a.y - b.y || a.x - b.x).map(x => x.str).join(" ");
    // Footer title is normally at the bottom-left. Restrict footer scan to the
    // lower ~18% of the page to avoid using headings from the body.
    const footerText = lines
      .filter(x => x.y > viewport.height * 0.80 && x.x < viewport.width * 0.72)
      .sort((a,b) => a.y - b.y || a.x - b.x)
      .map(x => x.str).join(" ");
    const stop = isStopPage(fullText);
    const category = stop ? null : titleCategory(footerText, fullText);
    pages.push({
      pageNumber: i,
      fullText,
      footerText: cleanText(footerText),
      stop,
      category: category || "LD All",
      pageBytes: null
    });
    setProgress?.(Math.round((i / pdf.numPages) * 100));
  }
  return { bytes, pdf, pages };
}

function suggestedFilename(base, category) {
  const safeBase = (base || "Loan Package").replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]/g, "-").trim();
  const safeCat = category.replace(/[\\/:*?"<>|]/g, "-");
  return `${safeBase} - ${safeCat}.pdf`;
}

function App() {
  const inputRef = useRef(null);
  const [files, setFiles] = useState([]);
  const [packages, setPackages] = useState([]);
  const [activePackage, setActivePackage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [selectedPages, setSelectedPages] = useState({});
  const [filenames, setFilenames] = useState({});
  const [previewPage, setPreviewPage] = useState(null);
  const [status, setStatus] = useState("");

  const allPages = useMemo(() => packages.flatMap((p, pi) =>
    p.pages.map((page, index) => ({ ...page, packageIndex: pi, localIndex: index, sourceName: p.file.name }))
  ), [packages]);

  const summaries = useMemo(() => {
    const map = {};
    for (const category of Object.keys(CATEGORY_META)) map[category] = [];
    allPages.forEach(p => {
      if (p.stop) return;
      if (!map[p.category]) map[p.category] = [];
      map[p.category].push(p);
    });
    return map;
  }, [allPages]);

  const onFiles = useCallback(async (incoming) => {
    const accepted = Array.from(incoming || []).filter(f =>
      /\.pdf$/i.test(f.name) || /\.zip$/i.test(f.name)
    );
    if (!accepted.length) {
      setError("Choose PDF files or a ZIP containing PDFs.");
      return;
    }
    setBusy(true); setError(""); setStatus(""); setProgress(0);
    try {
      const expanded = [];
      for (const file of accepted) {
        if (/\.zip$/i.test(file.name)) {
          const zip = await JSZip.loadAsync(file);
          for (const entry of Object.values(zip.files)) {
            if (!entry.dir && /\.pdf$/i.test(entry.name)) {
              expanded.push(new File([await entry.async("blob")], entry.name.split("/").pop(), { type: "application/pdf" }));
            }
          }
        } else expanded.push(file);
      }
      if (!expanded.length) throw new Error("No PDFs were found in the selected files.");
      const loaded = [];
      for (const file of expanded) {
        const parsed = await readPdf(file, setProgress);
        loaded.push({ file, bytes: parsed.bytes, pageCount: parsed.pdf.numPages, pages: parsed.pages });
      }
      setPackages(loaded);
      setFiles(expanded);
      setActivePackage(0);
      const initSelected = {};
      const initNames = {};
      loaded.forEach((p, pi) => {
        const base = p.file.name.replace(/\.pdf$/i, "");
        Object.keys(CATEGORY_META).forEach(category => {
          const key = `${pi}:${category}`;
          initSelected[key] = true;
          initNames[key] = suggestedFilename(base, category);
        });
      });
      setSelectedPages(initSelected);
      setFilenames(initNames);
      setStatus(`Analyzed ${loaded.length} PDF${loaded.length === 1 ? "" : "s"} entirely in your browser.`);
    } catch (e) {
      setError(e?.message || "Unable to read these files. Try a non-password-protected PDF.");
    } finally {
      setBusy(false);
    }
  }, []);

  const updatePageCategory = (packageIndex, pageNumber, category) => {
    setPackages(old => old.map((p, pi) => pi !== packageIndex ? p : ({
      ...p,
      pages: p.pages.map(page => page.pageNumber === pageNumber
        ? { ...page, category, stop: false, manuallyChanged: true }
        : page)
    })));
  };

  const makePdf = async (packageIndex, category) => {
    const pkg = packages[packageIndex];
    const chosen = pkg.pages.filter(p => !p.stop && p.category === category);
    if (!chosen.length) return null;
    const src = await PDFDocument.load(pkg.bytes);
    const out = await PDFDocument.create();
    const indices = chosen.map(p => p.pageNumber - 1);
    const copied = await out.copyPages(src, indices);
    copied.forEach(page => out.addPage(page));
    const bytes = await out.save();
    return new Blob([bytes], { type: "application/pdf" });
  };

  const downloadCategory = async (pi, category) => {
    const key = `${pi}:${category}`;
    if (!selectedPages[key]) return;
    const blob = await makePdf(pi, category);
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filenames[key] || suggestedFilename(packages[pi].file.name, category);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  };

  const downloadZip = async () => {
    setBusy(true); setError(""); setStatus("Preparing approved PDFs…");
    try {
      const zip = new JSZip();
      let count = 0;
      for (let pi = 0; pi < packages.length; pi++) {
        for (const category of Object.keys(CATEGORY_META)) {
          const key = `${pi}:${category}`;
          if (!selectedPages[key]) continue;
          const blob = await makePdf(pi, category);
          if (!blob) continue;
          const filename = filenames[key] || suggestedFilename(packages[pi].file.name, category);
          zip.file(filename, await blob.arrayBuffer());
          count++;
        }
      }
      if (!count) throw new Error("There are no selected documents to export.");
      const blob = await zip.generateAsync({ type: "blob" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "Loan Package Splitter - Approved PDFs.zip";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1500);
      setStatus(`Created ZIP containing ${count} selected PDF${count === 1 ? "" : "s"}.`);
    } catch (e) {
      setError(e?.message || "Could not create the ZIP.");
    } finally { setBusy(false); }
  };

  const downloadOriginal = (pi) => {
    const p = packages[pi];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([p.bytes], { type: "application/pdf" }));
    a.download = p.file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  };

  const active = packages[activePackage];
  const stopCount = allPages.filter(p => p.stop).length;
  const assignedCount = allPages.filter(p => !p.stop).length;

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand-mark"><span className="brand-icon">▤</span><span>Loan Package <b>Splitter</b></span></div>
      <div className="local-pill"><span className="dot"></span> Browser processing</div>
    </header>
    <main>
      <section className="hero">
        <div className="eyebrow">DOCUMENT WORKFLOW · VERSION 1B</div>
        <h1>Turn loan packages into<br/><em>organized PDFs.</em></h1>
        <p>Upload a combined package or multiple PDFs. Review the proposed splits, correct assignments, then save approved documents for manual SharePoint upload.</p>
      </section>

      {!packages.length && <section className="upload-card">
        <div className="upload-icon">↑</div>
        <h2>Drop your loan package here</h2>
        <p>PDF or ZIP containing PDFs · Multiple files supported</p>
        <button className="primary" onClick={() => inputRef.current?.click()} disabled={busy}>
          {busy ? "Analyzing…" : "Choose files"}
        </button>
        <input ref={inputRef} type="file" accept=".pdf,.zip,application/pdf,application/zip" multiple hidden onChange={e => onFiles(e.target.files)} />
        <div className="privacy-note"><span>▣</span> Files are processed locally in this browser. No upload to a document-processing server.</div>
      </section>}

      {busy && <div className="progress-card"><div className="progress-label"><span>Analyzing document pages</span><b>{progress}%</b></div><div className="progress-track"><div style={{width:`${progress}%`}} /></div></div>}
      {error && <div className="notice error">{error}</div>}
      {status && <div className="notice success">{status}</div>}

      {packages.length > 0 && <>
        <section className="summary-strip">
          <div><span className="metric">{packages.length}</span><span className="metric-label">PDF files</span></div>
          <div><span className="metric">{allPages.length}</span><span className="metric-label">Pages analyzed</span></div>
          <div><span className="metric">{stopCount}</span><span className="metric-label">STOP pages excluded</span></div>
          <div><span className="metric">{assignedCount}</span><span className="metric-label">Eligible pages</span></div>
          <button className="secondary" onClick={() => { setPackages([]); setFiles([]); setStatus(""); setError(""); }}>Start over</button>
        </section>

        <section className="workspace">
          <aside className="file-sidebar">
            <div className="section-label">SOURCE FILES</div>
            {packages.map((p, pi) => <button key={p.file.name+pi} className={`file-item ${activePackage===pi?"active":""}`} onClick={() => setActivePackage(pi)}>
              <span className="pdf-icon">PDF</span><span className="file-name">{p.file.name}<small>{p.pageCount} pages</small></span>
            </button>)}
            <button className="add-files" onClick={() => inputRef.current?.click()}>＋ Add more files</button>
            <input ref={inputRef} type="file" accept=".pdf,.zip,application/pdf,application/zip" multiple hidden onChange={e => onFiles(e.target.files)} />
            <button className="text-button" onClick={() => downloadOriginal(activePackage)}>Download original</button>
          </aside>

          <section className="review-area">
            <div className="review-heading">
              <div><div className="section-label">REVIEW & CORRECT</div><h2>Document assignments</h2><p>Check each page's proposed category. STOP pages are excluded automatically.</p></div>
            </div>
            <div className="rules-banner"><b>Current rules:</b> related addendums are grouped with their parent document; all STOP pages are excluded from every output.</div>

            <div className="category-grid">
              {Object.keys(CATEGORY_META).map(category => {
                const pages = active?.pages.filter(p => !p.stop && p.category===category) || [];
                const key = `${activePackage}:${category}`;
                return <div className="category-card" key={category}>
                  <div className="category-top">
                    <span className={`category-dot ${CATEGORY_META[category].color}`}></span>
                    <h3>{category}</h3>
                    <label className="include-toggle"><input type="checkbox" checked={!!selectedPages[key]} onChange={e => setSelectedPages(old=>({...old,[key]:e.target.checked}))}/> Export</label>
                  </div>
                  <div className="category-sub">{pages.length} page{pages.length===1?"":"s"} assigned</div>
                  <input className="filename-input" value={filenames[key] || ""} onChange={e=>setFilenames(old=>({...old,[key]:e.target.value}))} aria-label={`${category} output filename`} />
                  <div className="page-chips">
                    {pages.length ? pages.map(p=><button key={p.pageNumber} className="page-chip" title={`PDF page ${p.pageNumber}: ${p.footerText || "No footer title detected"}`} onClick={()=>setPreviewPage({packageIndex:activePackage,page:p})}>{p.pageNumber}</button>) : <span className="empty-pages">No pages assigned</span>}
                  </div>
                  <button className="small-button" disabled={!pages.length || busy} onClick={()=>downloadCategory(activePackage,category)}>Download this PDF</button>
                </div>;
              })}
            </div>

            <div className="page-review">
              <div className="page-review-head"><div><div className="section-label">PAGE-BY-PAGE CHECK</div><h3>Correct a page assignment</h3></div><span className="muted">{active?.pageCount || 0} pages in source</span></div>
              <div className="page-table-wrap">
                <table>
                  <thead><tr><th>PDF page</th><th>Detected footer/title</th><th>Assignment</th><th>Review</th></tr></thead>
                  <tbody>
                    {active?.pages.map(p=><tr key={p.pageNumber} className={p.stop?"stop-row":""}>
                      <td>{p.pageNumber}</td>
                      <td className="footer-cell">{p.stop ? <span className="stop-tag">STOP PAGE — EXCLUDED</span> : (p.footerText || <span className="muted">No footer text detected</span>)}</td>
                      <td>{p.stop ? "Excluded" : <select value={p.category} onChange={e=>updatePageCategory(activePackage,p.pageNumber,e.target.value)}>
                        {Object.keys(CATEGORY_META).map(c=><option key={c}>{c}</option>)}
                      </select>}</td>
                      <td><button className="review-link" onClick={()=>setPreviewPage({packageIndex:activePackage,page:p})}>Inspect</button></td>
                    </tr>)}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="export-bar">
              <div><h3>Ready to retrieve your PDFs?</h3><p>Review your selections, then export the approved files. Upload them to SharePoint manually.</p></div>
              <button className="primary" onClick={downloadZip} disabled={busy}>Download approved PDFs as ZIP ↗</button>
            </div>
          </section>
        </section>
      </>}

      {previewPage && <div className="modal-backdrop" onClick={()=>setPreviewPage(null)}>
        <div className="modal" onClick={e=>e.stopPropagation()}>
          <div className="modal-head"><div><div className="section-label">PAGE INSPECTION</div><h2>PDF page {previewPage.page.pageNumber}</h2></div><button className="close" onClick={()=>setPreviewPage(null)}>×</button></div>
          <div className="preview-status">{previewPage.page.stop ? "This page is excluded because it matches the STOP-page rule." : `Current assignment: ${previewPage.page.category}`}</div>
          <div className="preview-extract"><b>Detected footer text</b><p>{previewPage.page.footerText || "No footer text detected."}</p><b>Text excerpt</b><p>{(previewPage.page.fullText || "No text layer detected. This may be a scanned page.").slice(0,1800)}</p></div>
          <p className="modal-note">This prototype shows extracted text for inspection. It does not render a full page image preview yet.</p>
          <button className="primary" onClick={()=>setPreviewPage(null)}>Done</button>
        </div>
      </div>}

      <footer><span>Loan Package Splitter · Prototype</span><span>Local browser processing · No OneDrive connection</span></footer>
    </main>
  </div>;
}

createRoot(document.getElementById("root")).render(<App />);