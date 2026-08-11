import { load } from 'cheerio';
import sanitizeHtml from 'sanitize-html';
import sharp from 'sharp';

export interface MicroSandboxOptions {
  mimeType: string;
  originalName?: string;
  outputFormat?: 'webp' | 'png' | 'jpeg';
  maxSizeBytes?: number;
}

export interface SanitizeResult {
  buffer: Buffer;
  mimeType: string;
  sanitized: boolean;
}

/**
 * 텍스트 파일 유효성 검사 (Fatal UTF-8 Decoder & Null-Byte 차단)
 */
export function sanitizeText(buffer: Buffer): Buffer {
  if (buffer.includes(0)) {
    throw new Error('Invalid text file: Null byte detected');
  }
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    decoder.decode(buffer);
    return buffer;
  } catch {
    throw new Error('Invalid text file: Non-UTF8 or corrupted sequence');
  }
}

/**
 * 이미지 멸균 재인코딩 (Sharp 기반 RAM 픽셀 추출 & EXIF 메타데이터 자동 소멸)
 */
export async function sanitizeImage(
  buffer: Buffer,
  format: 'webp' | 'png' | 'jpeg' = 'webp',
): Promise<Buffer> {
  const image = sharp(buffer);
  
  // EXIF 메타데이터 제거 및 픽셀 멸균 재인코딩
  if (format === 'png') {
    return image.rotate().png({ compressionLevel: 8 }).toBuffer();
  } else if (format === 'jpeg') {
    return image.rotate().jpeg({ quality: 82 }).toBuffer();
  }
  return image.rotate().webp({ quality: 82 }).toBuffer();
}

/**
 * HTML/DOM 2-Pass 무해화 & Dynamic Meta CSP 주입
 */
export function sanitizeHtmlDocument(htmlSource: string): string {
  const defaultCsp =
    "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

  const sanitized = sanitizeHtml(htmlSource, {
    allowedTags: [
      'html', 'head', 'title', 'meta', 'style', 'body', 'header', 'footer',
      'main', 'section', 'article', 'aside', 'nav', 'div', 'span', 'p', 'br',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'b', 'i', 'small',
      'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img', 'a',
    ],
    allowedAttributes: {
      '*': ['class', 'id', 'title', 'style', 'role', 'aria-*', 'data-*'],
      meta: ['charset', 'name', 'content', 'http-equiv'],
      a: ['href', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height'],
    },
    allowedSchemes: ['https', 'data'],
    parseStyleAttributes: false,
  });

  const $ = load(sanitized, { xml: false });
  $('script,iframe,object,embed,form,input,button,link,base').remove();
  $('a').attr('target', '_blank').attr('rel', 'noopener noreferrer');
  $('meta[http-equiv="content-security-policy" i]').remove();
  $('head').prepend(`<meta http-equiv="Content-Security-Policy" content="${defaultCsp}">`);
  if (!$('meta[charset]').length) $('head').prepend('<meta charset="utf-8">');

  return `<!doctype html>\n${$.html()}`;
}

/**
 * micro-sandbox 메인 정화 엔트리포인트 함수
 */
export async function sanitizeFile(
  buffer: Buffer,
  options: MicroSandboxOptions,
): Promise<SanitizeResult> {
  const { mimeType, outputFormat = 'webp' } = options;

  if (mimeType.startsWith('text/html')) {
    const text = buffer.toString('utf8');
    const cleanedHtml = sanitizeHtmlDocument(text);
    return {
      buffer: Buffer.from(cleanedHtml, 'utf8'),
      mimeType: 'text/html',
      sanitized: true,
    };
  }

  if (mimeType.startsWith('text/')) {
    const cleanTextBuffer = sanitizeText(buffer);
    return {
      buffer: cleanTextBuffer,
      mimeType,
      sanitized: true,
    };
  }

  if (mimeType.startsWith('image/')) {
    const cleanImageBuffer = await sanitizeImage(buffer, outputFormat);
    return {
      buffer: cleanImageBuffer,
      mimeType: `image/${outputFormat}`,
      sanitized: true,
    };
  }

  throw new Error(`Unsupported media type for sandboxed CDR: ${mimeType}`);
}
