# 9Router Account Automation Design

## 1. Overview

Tambah fitur **Account Automation** di 9Router untuk menambahkan provider account secara otomatis via browser automation. Fase pertama: **Kiro** dan **Antigravity**. Fitur ini pakai **Playwright** sebagai browser automation engine (seragam, tidak redundan), menerima input bulk `email:password`, dan hanya menyimpan token/credentials hasil login ke DB — tidak menyimpan password.

## 2. Goals

- User bisa bulk-add account Kiro dan Antigravity dari UI 9Router.
- Input: paste textarea atau upload file `.txt` dengan format `email:password` per baris.
- Browser automation pakai Playwright, modular per provider.
- Hasil login (token, refresh token, email, provider-specific data) disimpan ke `providerConnections` via `createProviderConnection`.
- Progress dan log ditampilkan real-time di UI (console/terminal style).
- Default headless; ada opsi visible browser untuk debug.

## 3. Non-Goals

- Tidak menyimpan email/password user di DB 9Router.
- Tidak support provider selain Kiro dan Antigravity di fase pertama.
- Tidak membuat sistem queue yang persisten/distributed di fase pertama (in-memory queue cukup).
- Tidak mengganti flow OAuth manual yang sudah ada; ini adalah alternatif automation.

## 4. Architecture

```
┌─────────────────────────────────────┐
│  Dashboard Next.js                  │
│  - Tab "Add Account"                │
│  - Textarea / file upload           │
│  - Console log panel (SSE)          │
└─────────────┬───────────────────────┘
              │ POST /api/account-automation/run
              ▼
┌─────────────────────────────────────┐
│  API Route Controller               │
│  - Parse & validate bulk input      │
│  - Start AutomationQueue            │
│  - Return job id + open SSE stream  │
└─────────────┬───────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│  open-sse/services/automation/      │
│  ├── core/                          │
│  │   ├── AutomationQueue.js         │
│  │   ├── PlaywrightManager.js       │
│  │   ├── CredentialSaver.js         │
│  │   └── SseEventEmitter.js         │
│  └── providers/                     │
│      ├── BaseAutomation.js          │
│      ├── KiroAutomation.js          │
│      └── AntigravityAutomation.js   │
└─────────────┬───────────────────────┘
              │ insert/update
              ▼
┌─────────────────────────────────────┐
│  providerConnections (SQLite)       │
└─────────────────────────────────────┘
```

## 5. Components

### 5.1 BaseAutomation

Abstract base class untuk semua provider automation.

Responsibilities:
- Launch/shutdown Playwright browser context
- Provide shared retry logic
- Provide progress logging hooks
- Define interface `run(email, password)` yang harus diimplementasikan provider

```js
export class BaseAutomation {
  constructor(options = {}) {
    this.headless = options.headless !== false;
    this.proxy = options.proxy || null;
    this.logCallback = options.onLog || (() => {});
  }

  async init() { /* launch browser once */ }
  async newContext() { /* isolated context per account */ }
  async run(email, password) { throw new Error("implement in subclass"); }
  async cleanup() { /* close browser */ }
}
```

### 5.2 PlaywrightManager

Singleton yang mengelola satu instance browser Playwright. Setiap account memakai **browser context** terpisah (bukan browser baru), jadi isolasi cookies/localStorage aman tapi tetap hemat resource.

### 5.3 AutomationQueue

In-memory queue untuk menjalankan automation job satu per satu (atau limited concurrency). Tiap job memanggil provider automation, lalu menyimpan hasil. Mengirim event log via callback.

### 5.4 CredentialSaver

Fungsi utilitas yang memanggil `createProviderConnection` dari `src/lib/db/repos/connectionsRepo.js` dengan format yang sesuai untuk masing-masing provider.

### 5.5 SseEventEmitter

Helper untuk mengubah log/progress dari queue menjadi SSE stream yang dikonsumsi frontend.

## 6. Provider Implementations

### 6.1 KiroAutomation

Flow:
1. Mulai AWS SSO OIDC device code flow (reuse logic dari `src/lib/oauth/providers.js` untuk Kiro).
2. Buka browser context ke verification URI / social login URL.
3. Inject email/password sesuai metode login (builder-id/google/github/import).
4. Setelah browser selesai authorize, poll token endpoint sampai dapet `access_token`, `refresh_token`, `expires_in`.
5. Extract profile ARN/email via existing helper.
6. Return credential object.

Catatan: `noiuai` auth script sudah punya logika ini. Kita port yang esensial ke Playwright tapi tanpa Camoufox (pakai Playwright standar + stealth jika perlu).

### 6.2 AntigravityAutomation

Flow:
1. Bangun Google OAuth authorize URL pakai existing `buildAuthUrl` dari `src/lib/oauth/providers.js`.
2. Buka browser context ke URL tersebut.
3. Inject email/password ke form Google.
4. Handle consent screen (Allow/Continue/Izinkan).
5. Intercept redirect ke redirect URI untuk capture `code`.
6. Exchange code via existing `exchangeToken` untuk dapatkan `access_token`, `refresh_token`, `expires_in`.
7. Reuse `postExchange` untuk fetch user info dan project/tier.
8. Return credential object.

Ini mirip dengan `Gsuiteto9router/bot.js`, tapi dipindahkan ke Playwright dan modular.

## 7. UI Design

Referensi: NOIU AI dashboard (`/aicoding/app/static/index.html`).

Tab baru di sidebar 9Router: **"Add Account"** (icon robot/user-plus).

Layout tab:
- **Header**: judul + deskripsi singkat
- **Provider tabs**: Kiro | Antigravity
- **Input section**:
  - Textarea besar untuk paste bulk `email:password`
  - Atau drag-and-drop file upload `.txt`
  - Toggle headless / visible browser
  - Tombol **"Run Automation"**
- **Console panel**:
  - Background dark, font monospace
  - Log tiap account: `[09:12:34] [kiro] user@example.com → LOGIN → OK`
  - Error ditampilkan dengan warna merah
  - Screenshot gagal bisa ditampilkan inline (opsional fase 2)
- **Summary panel**:
  - Total, success, failed, skipped
  - List akun yang berhasil dengan tombol "View in Accounts"

## 8. API Endpoints

### POST /api/account-automation/run

Body:
```json
{
  "provider": "kiro" | "antigravity",
  "accounts": [
    { "email": "a@x.com", "password": "secret" },
    { "email": "b@x.com", "password": "secret2" }
  ],
  "headless": true,
  "concurrency": 1
}
```

Response:
```json
{
  "jobId": "job_01KWNFF...",
  "status": "started",
  "total": 2
}
```

### GET /api/account-automation/stream?jobId=...

SSE stream dengan event:
```json
event: log
data: {"time":"09:12:34","provider":"kiro","email":"a@x.com","step":"login","message":"Opening login page"}

event: result
data: {"email":"a@x.com","provider":"kiro","success":true,"connectionId":"..."}

event: done
data: {"total":2,"success":1,"failed":1,"errors":[{"email":"b@x.com","error":"..."}]}
```

## 9. Security

- Password hanya ada di memory selama session automation; tidak disimpan, tidak di-log.
- Setiap akun pakai Playwright browser context terpisah.
- Automation API route dilindungi autentikasi 9Router (sama seperti route lain).
- Batasi concurrency default 1 untuk mencegah rate-limit / abuse.
- Screenshot debug hanya disimpan di server lokal, tidak dikirim ke client.

## 10. Error Handling

- Setiap account gagal tidak menghentikan batch lain.
- Retry internal 1x untuk error timeout/consent.
- Screenshot otomatis saat error untuk debugging.
- Log error detail (tanpa password) ke console panel.
- Summary akhir mencantumkan semua akun yang gagal dengan alasan.

## 11. Testing

- Unit test untuk `BaseAutomation` dengan mocked Playwright.
- Integration test manual dengan akun Kiro dan Antigravity test.
- Test queue behavior: sequential, error isolation, cleanup.

## 12. Files to Create / Modify

Create:
- `open-sse/services/automation/core/BaseAutomation.js`
- `open-sse/services/automation/core/PlaywrightManager.js`
- `open-sse/services/automation/core/AutomationQueue.js`
- `open-sse/services/automation/core/CredentialSaver.js`
- `open-sse/services/automation/core/SseEventEmitter.js`
- `open-sse/services/automation/providers/KiroAutomation.js`
- `open-sse/services/automation/providers/AntigravityAutomation.js`
- `src/app/api/account-automation/run/route.js`
- `src/app/api/account-automation/stream/route.js`
- `src/app/dashboard/add-account/page.js`

Modify:
- `src/lib/db/schema.js` (jika perlu tabel log automation, optional fase 2)
- Sidebar/navigasi dashboard untuk menambah menu "Add Account"

## 13. Open Questions

- Apakah perlu support proxy per connection? (Bisa reuse field `connectionProxyUrl` yang sudah ada.)
- Apakah perlu menyimpan log automation di DB untuk riwayat? (Bisa fase 2.)
- Apakah perlu integrasi dengan Camoufox/stealth plugin Playwright? (Rekomendasi awal: Playwright standar + user-agent override.)
