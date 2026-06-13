function getArticleThemeCss() {
  return String.raw`
:root {
      color-scheme: light;
      --ink: #20242b;
      --muted: #687182;
      --paper: #ffffff;
      --wash: #f5f6f8;
      --line: #e3e6eb;
      --accent: #b42318;
      --accent-soft: #fff1ed;
      --code-bg: #111827;
      --code-ink: #f9fafb;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      background: var(--wash);
      color: var(--ink);
      font-family: SimSun, "宋体", "Songti SC", "Noto Serif CJK SC", serif;
      font-size: 15.5px;
      line-height: 1.72;
    }
    .page {
      width: 100%;
      padding: 18mm 0;
      background: var(--wash);
    }
    .sheet {
      width: 210mm;
      height: 297mm;
      margin: 0 auto 18mm;
      overflow: hidden;
      background: var(--paper);
      box-shadow: 0 16px 45px rgba(15, 23, 42, .08);
      break-after: page;
      page-break-after: always;
    }
    .cover {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      align-content: stretch;
      gap: 18mm;
      padding: 20mm 16mm 16mm;
      background:
        radial-gradient(circle at 84% 18%, rgba(180, 35, 24, .08), transparent 26%),
        linear-gradient(145deg, #fff 0%, #f8fafc 58%, #fff7f5 100%);
    }
    .kicker {
      margin: 0 0 16px;
      color: var(--accent);
      font-size: 15px;
      font-weight: 700;
    }
    h1 {
      margin: 0;
      max-width: 9.8em;
      font-size: 48px;
      line-height: 1.1;
      letter-spacing: 0;
      text-wrap: balance;
      overflow-wrap: anywhere;
    }
    .cover-title {
      display: -webkit-box;
      max-height: 2.22em;
      overflow: hidden;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }
    .cover-title.medium { font-size: 44px; }
    .cover-title.long { font-size: 36px; }
    .cover-title.extra-long { font-size: 31px; }
    .dek {
      max-width: 34em;
      margin: 16px 0 0;
      color: #424b5b;
      font-size: 17px;
      line-height: 1.75;
    }
    .cover-media {
      align-self: end;
      display: block;
    }
    .cover-media img {
      width: 100%;
      height: 142mm;
      object-fit: contain;
      object-position: center;
      border: 1px solid #d8dee8;
      display: block;
      background: #f8fafc;
      box-shadow: 0 18px 42px rgba(15, 23, 42, .12);
    }
    .meta {
      color: var(--muted);
      font-size: 14px;
      line-height: 1.7;
    }
    .mindmap-page {
      padding: 10mm;
      background: #fbfcfe;
    }
    .mindmap-page h2 {
      margin: 0 0 8px;
      padding-top: 0;
      border-top: 0;
      font-size: 24px;
      line-height: 1.15;
      text-wrap: balance;
    }
    .content h2 {
      margin: 0 0 16px;
      padding-top: 10px;
      border-top: 2px solid var(--ink);
      font-size: 28px;
      line-height: 1.25;
      text-wrap: balance;
    }
    .mindmap-frame {
      width: 100%;
      height: 267mm;
      border: 1px solid var(--line);
      background: #fff;
      display: block;
    }
    .mindmap-image {
      width: 100%;
      height: 267mm;
      object-fit: contain;
      display: block;
      border: 1px solid var(--line);
      background: #fff;
    }
    .mindmap-empty {
      min-height: 45vh;
      display: grid;
      place-items: center;
      border: 1px dashed var(--line);
      color: var(--muted);
      background: #fff;
    }
    .content {
      height: 100%;
      overflow: hidden;
      padding: 16mm 14mm;
    }
    .content.allow-large-block {
      overflow: auto;
    }
    .content-source-sheet {
      visibility: hidden;
      position: absolute;
      left: -9999px;
    }
    .content h2 { margin-top: 0; }
    .content h2:first-child {
      margin-top: 0;
    }
    h3 {
      margin: 24px 0 9px;
      color: #111827;
      font-size: 20px;
      line-height: 1.35;
    }
    p, li {
      max-width: 44em;
      text-wrap: pretty;
    }
    strong { color: #101828; }
    code {
      font-family: Consolas, "Cascadia Mono", monospace;
      font-size: .9em;
      color: #111827;
      background: #eef2f7;
      border: 1px solid #dbe3ed;
      border-radius: 5px;
      padding: 1px 5px;
    }
    pre.code {
      max-width: 100%;
      overflow-x: auto;
      margin: 16px 0;
      padding: 14px;
      background: var(--code-bg);
      color: var(--code-ink);
      border-radius: 10px;
      font-family: Consolas, "Cascadia Mono", monospace;
      font-size: 12px;
      line-height: 1.65;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    pre.code code {
      color: inherit;
      background: transparent;
      border: 0;
      padding: 0;
    }
    blockquote {
      margin: 28px 0;
      padding: 18px 22px;
      border: 1px solid #fecaca;
      background: var(--accent-soft);
      color: #7f1d1d;
      font-size: 1.08rem;
    }
    ul { padding-left: 1.3em; }
    li + li { margin-top: 7px; }
    .figure {
      margin: 18px 0 22px;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .image-button {
      display: block;
      width: 100%;
      padding: 0;
      border: 0;
      background: transparent;
      cursor: zoom-in;
    }
    .figure img {
      display: block;
      width: 100%;
      max-height: 100mm;
      object-fit: contain;
      height: auto;
      border: 1px solid var(--line);
      background: #f8fafc;
      border-radius: 8px;
    }
    figcaption {
      margin-top: 8px;
      color: var(--accent);
      font-size: 15px;
      line-height: 1.45;
      font-weight: 700;
    }
    .figure-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 14px;
      margin: 16px 0 22px;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .figure-grid .figure {
      margin: 0;
    }
    .table-wrap {
      overflow-x: auto;
      margin: 16px 0;
      border: 1px solid var(--line);
      break-inside: avoid;
      page-break-inside: avoid;
    }
    table {
      width: 100%;
      min-width: 0;
      border-collapse: collapse;
      font-size: 13px;
      line-height: 1.6;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 12px 14px;
      vertical-align: top;
      text-align: left;
    }
    th {
      background: #f8fafc;
      font-weight: 700;
    }
    .flow-summary {
      margin: 22px 0;
      padding: 18px;
      border: 1px solid var(--line);
      background: #f8fafc;
      color: #344054;
    }
    .flow-summary span {
      display: inline-block;
      margin: 6px 8px 0 0;
      padding: 4px 8px;
      border: 1px solid #d0d5dd;
      background: #fff;
      border-radius: 999px;
      font-size: 15px;
    }
    .note {
      color: var(--muted);
    }
    .lightbox {
      position: fixed;
      inset: 0;
      z-index: 20;
      display: none;
      place-items: center;
      padding: 28px;
      background: rgba(15, 23, 42, .86);
    }
    .lightbox.open {
      display: grid;
    }
    .lightbox img {
      max-width: min(96vw, 1280px);
      max-height: 90vh;
      background: white;
      box-shadow: 0 20px 80px rgba(0,0,0,.35);
    }
    .lightbox button {
      position: fixed;
      top: 18px;
      right: 18px;
      border: 1px solid rgba(255,255,255,.45);
      background: rgba(255,255,255,.12);
      color: white;
      border-radius: 999px;
      padding: 8px 12px;
      cursor: pointer;
      font: inherit;
    }
    @media (max-width: 720px) {
      body { font-size: 15.5px; }
      .page { padding: 0; }
      .sheet {
        width: 100vw;
        height: calc(100vw * 1.4142857);
        margin-bottom: 0;
        box-shadow: none;
      }
      .cover, .content { padding: 20px; }
      .mindmap-page { padding: 12px; }
      .cover-media { grid-template-columns: 1fr; }
      .mindmap-frame, .mindmap-image { height: 86%; }
      h1 { font-size: 34px; }
    }
    @media print {
      @page { size: A4; margin: 0; }
      body { background: white; }
      .page { padding: 0; }
      .page { box-shadow: none; }
      .sheet {
        width: 210mm;
        height: 297mm;
        margin: 0;
        box-shadow: none;
        break-after: page;
        page-break-after: always;
      }
      .figure, .figure-grid, .table-wrap, pre.code, img, table { break-inside: avoid; page-break-inside: avoid; }
      .lightbox { display: none; }
    }
  `;
}

module.exports = { getArticleThemeCss };
