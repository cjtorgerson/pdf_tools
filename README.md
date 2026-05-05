# Offline PDF Booklet Editor

This is a static browser tool for combining PDFs, drag-and-drop page reordering, and page deletion before export.

## Use

1. Open [index.html](./index.html) in a current desktop Chromium-based browser.
2. Add one or more PDF files with the button or drag-and-drop.
3. Drag page cards to change order.
4. Use `Delete` on any page you want removed from the final booklet.
5. Click `Export Combined PDF` to download `combined.pdf`.

## Offline Runtime Files

The app runs from plain local files and uses these bundled browser assets:

- `vendor/pdf-lib.min.js`
- `vendor/pdf.min.js`
- `vendor/pdf.worker.min.js`

After the vendor files are present, the app can be copied elsewhere and opened directly without a server.

## Refreshing Dependencies

If you want to refresh the bundled vendor files later:

1. Run `npm install`
2. Copy the browser builds from:
   - `node_modules/pdf-lib/dist/pdf-lib.min.js`
   - `node_modules/pdfjs-dist/build/pdf.min.js`
   - `node_modules/pdfjs-dist/build/pdf.worker.min.js`
3. Replace the matching files in `vendor/`
