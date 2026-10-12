# Loan Package Splitter — Version 1B

A standalone Vite + React prototype for splitting loan packages entirely in the browser.

## Included in this prototype

- Upload one or multiple PDFs, or a ZIP containing PDFs.
- Extract page text locally with PDF.js.
- Detect and exclude STOP instruction pages.
- Group related addendums with their parent documents:
  - "Addendum to Loan and Security Agreement..." → Loan and Security Agreement
  - "Addendum to Secured Note..." → Note
- Assign recognized Mortgage and Lender's Closing Instructions pages.
- Assign other eligible pages to LD All.
- Review page assignments and manually reassign pages.
- Edit output filenames and choose which category PDFs to export.
- Download individual PDFs or a ZIP of selected PDFs.
- No Microsoft APIs, OAuth, OneDrive syncing, email connection, or external document-processing service.

## Run locally

Requirements: Node.js 18+ recommended.

```bash
npm install
npm run dev
```

Open the local URL shown by Vite.

To test a production build:

```bash
npm run build
npm run preview
```

## Deploy to Vercel

1. Create a new Git repository for this folder and push it to your account.
2. In Vercel, import the repository as a new project.
3. Framework preset: Vite.
4. Build command: `npm run build`.
5. Output directory: `dist`.
6. Deploy.

This project is independent from the Link Library. It does not need a backend or environment variables for the current prototype.

## Sample-based rules

The provided 1927 Dartmore sample indicates:
- Loan and Security Agreement main document and its addendum should be grouped together.
- Note main document and its addendum should be grouped together.
- STOP pages must be excluded from all outputs, including LD All.
- Mortgage and Lender's Closing Instructions are their own categories.
- Remaining eligible pages go to LD All.

The sample's known page ranges are only a validation reference; the app does not hardcode those page numbers. It attempts to classify each page from its text/footer and provides a page-by-page correction table.

## Important prototype limitations

- The page inspector shows extracted text, not a rendered page image.
- Text/footer recognition is heuristic and should be reviewed before using outputs for business records.
- Scanned pages with no text layer may be missed until OCR is added. OCR is not included in this version.
- The app currently detects STOP pages by text. Scanned STOP pages without extractable text require manual review or future OCR.
- The ZIP input is for PDFs inside ZIP files; non-PDF files are ignored.
- Password-protected PDFs may not open.
- Processing occurs in the browser tab; very large PDFs may need substantial memory.
- No direct SharePoint integration is included. Download the approved PDFs/ZIP and upload manually to SharePoint.

## Privacy note

PDF content is parsed and assembled in the browser. The page does not send document contents to a backend. Dependencies are bundled with the application. This does not replace your employer's policies for handling confidential borrower information.
