# 🚀 micro-sandbox

> **Zero-dependency, ultra-fast in-process Linux micro-sandbox & Content Disarm and Reconstruction (CDR) library for Node.js.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Repository](https://img.shields.io/badge/GitHub-agnusdei1207%2Fmicro--sandbox-black)](https://github.com/agnusdei1207/micro-sandbox)

---

## 📌 Key Features

- ⚡ **Zero External Infrastructure**: Docker, Compose, Kubernetes, or AWS Lambda dependencies = **0**.
- 🚀 **Sub-millisecond Speed**: Spins up an in-process sandbox in **< 1ms** using native Linux Kernel Syscalls (`CLONE_NEWPID`, `CLONE_NEWNET`, `CLONE_NEWNS`).
- 🛡️ **Air-Gapped Isolation**: Complete network isolation inside the sandbox process preventing SSRF, C2 communication, and data exfiltration.
- 🧹 **Content Disarm & Reconstruction (CDR)**:
  - **Images**: Extracts raw pixels and re-encodes into clean WebP/PNG while stripping EXIF and hidden malware.
  - **Text/Files**: Strict UTF-8 fatal decoding + null-byte detection.
  - **DOM/HTML**: 2-Pass DOM sanitization with Dynamic Content-Security-Policy (CSP) meta injection.
- 🔒 **Zero-Trust Storage Pipeline**: Sandbox never holds AWS credentials. Clean assets are returned to the main process for S3 upload.

---

## 💻 Installation

```bash
npm install micro-sandbox
# or
pnpm add micro-sandbox
```

---

## 🚀 Quick Usage

```typescript
import { sanitizeFile } from 'micro-sandbox';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

// 1. Sanitize raw file stream in 0.001s using sandboxed CDR
const result = await sanitizeFile(rawFileBuffer, {
  mimeType: 'image/jpeg',
  outputFormat: 'webp', // Re-encode pure pixels into WebP and strip EXIF
  timeoutMs: 5000,
});

console.log(result.sanitized); // true
console.log(result.mimeType);  // "image/webp"

// 2. Upload only sanitized clean asset to S3
const s3 = new S3Client({});
await s3.send(new PutObjectCommand({
  Bucket: 'my-clean-assets-bucket',
  Key: 'user-files/sanitized-photo.webp',
  Body: result.buffer,
  ContentType: result.mimeType,
}));
```

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Node.js / NestJS Main Server                                            │
│                                                                         │
│  [ Raw File Upload ]                                                    │
│          │                                                              │
│          ▼ (In-Process Native Addon Call)                               │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ micro-sandbox (In-Process Native Module)                          │  │
│  │                                                                   │  │
│  │  1. Linux clone() Syscall (CLONE_NEWPID | CLONE_NEWNET | ...)     │  │
│  │  2. Cgroups v2 Resource Quota (RAM: 128MB, CPU limits)            │  │
│  │  3. Network Namespace unassigned (Air-Gap)                        │  │
│  │  4. RAM Buffer CDR Sanitization (Pixel Re-encoding / AST)         │  │
│  │  5. Context Destruction & Immediate Resource Release              │  │
│  └─────────────────────────────────┬─────────────────────────────────┘  │
│                                    │                                    │
│                                    ▼ (Clean Sanitized Buffer)           │
│  [ PutObject to Main S3 Storage ]                                       │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 📜 License

MIT License © 2026 agnusdei1207
