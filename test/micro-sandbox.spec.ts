import assert from 'node:assert';
import { test } from 'node:test';
import { sanitizeFile, sanitizeHtmlDocument, sanitizeText } from '../dist/index.js';

test('1. sanitizeText - Null byte 포함 텍스트 거부', () => {
  const badBuffer = Buffer.from('hello\0world', 'utf8');
  assert.throws(() => sanitizeText(badBuffer), /Null byte detected/);
});

test('2. sanitizeText - 정상 UTF-8 텍스트 성공', () => {
  const goodBuffer = Buffer.from('안녕하세요 micro-sandbox 테스트입니다.', 'utf8');
  const result = sanitizeText(goodBuffer);
  assert.strictEqual(result.toString('utf8'), '안녕하세요 micro-sandbox 테스트입니다.');
});

test('3. sanitizeHtmlDocument - 악성 script 및 이벤트 제거, CSP 주입', () => {
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

test('4. sanitizeFile - PDF 매직 바이트 검증', async () => {
  const fakePdf = Buffer.from('NOT_A_PDF_HEADER_DATA', 'utf8');
  await assert.rejects(
    async () => sanitizeFile(fakePdf, { mimeType: 'application/pdf' }),
    /Invalid PDF file signature/,
  );
});
