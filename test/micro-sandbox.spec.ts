import assert from 'node:assert';
import { test } from 'node:test';
import { sanitizeFile, sanitizeHtmlDocument, sanitizeText } from '../dist/index.js';

test('1. sanitizeText - Reject text stream containing null byte', () => {
  const badBuffer = Buffer.from('hello\0world', 'utf8');
  assert.throws(() => sanitizeText(badBuffer), /Null byte detected/);
});

test('2. sanitizeText - Successfully validate valid UTF-8 text', () => {
  const goodBuffer = Buffer.from('Hello, micro-sandbox test stream.', 'utf8');
  const result = sanitizeText(goodBuffer);
  assert.strictEqual(result.toString('utf8'), 'Hello, micro-sandbox test stream.');
});

test('3. sanitizeHtmlDocument - Remove malicious script & events, inject CSP', () => {
  const maliciousHtml = `
    <html>
      <head><title>Test</title></head>
      <body>
        <h1>Hello</h1>
        <script>alert('xss');</script>
        <a href="https://example.com" onclick="steal()">Link</a>
      </body>
    </html>
  `;
  const sanitized = sanitizeHtmlDocument(maliciousHtml);
  assert.strictEqual(sanitized.includes('<script>'), false);
  assert.strictEqual(sanitized.includes('onclick'), false);
  assert.strictEqual(sanitized.includes('Content-Security-Policy'), true);
  assert.strictEqual(sanitized.includes('rel="noopener noreferrer"'), true);
});

test('4. sanitizeFile - Verify PDF magic byte signature', async () => {
  const fakePdf = Buffer.from('NOT_A_PDF_HEADER_DATA', 'utf8');
  await assert.rejects(
    async () => sanitizeFile(fakePdf, { mimeType: 'application/pdf' }),
    /Invalid PDF file signature/,
  );
});
