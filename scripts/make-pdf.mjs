// SUBMISSION.md -> PDF. Run: node scripts/make-pdf.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { marked } from "marked";

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => fs.existsSync(p));
if (!CHROME) throw new Error("no Chrome or Edge found");

const md = fs.readFileSync("SUBMISSION.md", "utf8");
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: A4; margin: 18mm 16mm; }
body { font: 10.5pt/1.55 "Segoe UI", system-ui, sans-serif; color: #1a1a1a; max-width: 100%; }
h1 { font-size: 19pt; margin: 0 0 4pt; letter-spacing: -0.01em; }
h2 { font-size: 13pt; margin: 20pt 0 7pt; padding-top: 9pt; border-top: 1px solid #ddd;
     break-after: avoid; page-break-after: avoid; }
h3 { font-size: 11pt; margin: 13pt 0 5pt; break-after: avoid; page-break-after: avoid; }
p, li { orphans: 3; widows: 3; }
strong { color: #000; }
code { font: 9pt/1.4 "Cascadia Mono", Consolas, monospace; background: #f4f4f5;
       padding: 1px 4px; border-radius: 3px; }
pre { background: #f7f7f8; border: 1px solid #e4e4e7; border-radius: 5px; padding: 9pt 11pt;
      overflow: visible; white-space: pre-wrap; word-break: break-word;
      break-inside: avoid; page-break-inside: avoid; }
pre code { background: none; padding: 0; font-size: 8.4pt; line-height: 1.42; }
table { border-collapse: collapse; width: 100%; margin: 9pt 0; font-size: 9.3pt;
        break-inside: avoid; page-break-inside: avoid; }
th, td { border: 1px solid #d8d8dc; padding: 4.5pt 7pt; text-align: left; vertical-align: top; }
th { background: #f4f4f5; font-weight: 600; }
blockquote { border-left: 3px solid #d4d4d8; margin: 9pt 0; padding: 2pt 0 2pt 11pt; color: #444; }
hr { border: 0; border-top: 1px solid #e4e4e7; margin: 15pt 0; }
a { color: #1d4ed8; text-decoration: none; word-break: break-all; }
ul, ol { padding-left: 17pt; }
li { margin: 2.5pt 0; }
</style></head><body>${marked.parse(md)}</body></html>`;

const tmp = path.join(os.tmpdir(), "submission-render.html");
fs.writeFileSync(tmp, html);

const out = path.resolve("Superbrain-Assignment-Vardhan.pdf");
fs.rmSync(out, { force: true });
execFileSync(CHROME, [
  "--headless", "--disable-gpu", "--no-sandbox", "--no-pdf-header-footer",
  `--print-to-pdf=${out}`, pathToFileURL(tmp).href,
], { stdio: "pipe" });

console.log(`${out}  ${(fs.statSync(out).size / 1024).toFixed(0)} KB  (via ${path.basename(CHROME)})`);
