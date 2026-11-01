# NaraRouter Provider Integration Test

**Tanggal pengujian:** 2 November 2026  
**Status:** Berhasil — seluruh skenario Anthropic SDK smoke test lulus  
**Repository revision:** `15fd1bb3bf0a1738d64bed279e0be37a8117bc62`  
**Gateway:** BYV AI Protocol SDK `0.1.0`  
**Provider:** NaraRouter  
**Upstream model:** `deepseek-v4-flash` (dashboard: Deepseek V4 Flash)  
**BYV model profile:** `byv-flash-v1`

## 1. Tujuan dan ruang lingkup

Dokumen ini mencatat hasil pengujian integrasi BYV dengan NaraRouter sebagai provider OpenAI-compatible. Pengujian dilakukan memakai Anthropic SDK resmi terhadap gateway BYV lokal.

Catatan ini berfokus pada:
- kompatibilitas Messages API dan streaming;
- alur `tool_use` serta `tool_result`;
- konfigurasi retry pada Anthropic SDK dan perilaku request di adapter BYV;
- observasi kolom **Coba Ulang** pada dashboard NaraRouter.

Dokumen ini adalah catatan hasil uji, bukan audit menyeluruh terhadap implementasi internal NaraRouter. Tidak ada perubahan kode atau konfigurasi provider yang dilakukan sebagai bagian dari dokumentasi ini.

## 2. Konfigurasi pengujian

| Komponen | Nilai |
| --- | --- |
| Gateway URL | `http://127.0.0.1:8787` |
| Provider base URL | `https://router.bynara.id/v1` |
| Provider model ID | `deepseek-v4-flash` |
| BYV model profile | `byv-flash-v1` |
| Provider endpoint yang tercatat di dashboard | `POST /v1/chat/completions` |
| Provider pada detail request NaraRouter | DeepSeek |
| SDK smoke test | `npm run test:sdk` |
| SDK retry setting pada smoke test | `maxRetries: 0` |

Kredensial provider dan gateway tidak dicantumkan dalam dokumentasi ini.

## 3. Hasil Anthropic SDK smoke test

Perintah yang dijalankan:

```powershell
npm run test:sdk
```

Hasil terminal:

```text
[1/5] Non-streaming Messages request ...
PASS non-streaming: BYV_SDK_SMOKE_OK

[2/5] count_tokens SDK request ...
PASS count_tokens: 4152 (gateway estimate)

[3/5] Streaming text request ...
PASS streaming text: Hello! BYV_STREAM_SMOKE_OK

[4/5] Non-streaming tool_use and tool_result round trip ...
PASS tool_use: Bash {"command":"echo BYV_SDK_TOOL_CALL_OK"}
PASS stateless tool_result round trip: Acknowledged: BYV_SDK_SYNTHETIC_TOOL_RESULT_OK.

[5/5] Streaming tool_use ...
PASS streaming tool_use: {"id":"call_001","name":"Bash","input":{"command":"echo BYV_SDK_STREAM_TOOL_OK"}}

ALL BYV ANTHROPIC SDK SMOKE TESTS PASSED
```

Ringkasan:

| Skenario | Hasil | Catatan |
| --- | --- | --- |
| Non-streaming Messages | PASS | Gateway menerima dan mengembalikan respons teks |
| SDK `count_tokens` | PASS | Estimasi lokal gateway: 4.152 token |
| Streaming teks | PASS | SDK menerima event stream dan teks |
| `tool_use` non-streaming | PASS | Model menghasilkan tool call Bash sesuai schema |
| `tool_result` round trip | PASS | Hasil tool sintetis dikirim kembali; model menyelesaikan respons teks |
| Streaming `tool_use` | PASS | SDK menerima tool block dan input JSON |

**Catatan:** `count_tokens` menggunakan endpoint estimasi lokal BYV, bukan completion ke provider. Fixture Bash pada smoke test tidak dieksekusi; test hanya mengirim hasil tool sintetis untuk menguji kontrak percakapan Anthropic.

## 4. Observasi log gateway BYV

Lima completion yang tampak pada log gateway selama pengujian:

| Alur | Stream | Message count | Tool count | Tool calls | Stop reason | Durasi gateway |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| Non-streaming Messages | Tidak | 1 | 0 | 0 | `end_turn` | 14.163 ms |
| Streaming teks | Ya | 1 | 0 | 0 | `end_turn` | 9.587 ms |
| `tool_use` awal | Tidak | 1 | 1 | 1 | `tool_use` | 5.131 ms |
| `tool_result` round trip | Tidak | 4 | 1 | 0 | `end_turn` | 13.195 ms |
| Streaming `tool_use` | Ya | 1 | 1 | 1 | `tool_use` | 5.324 ms |

Semua baris completion pada log tersebut mencatat `usage_estimated: false`, sehingga BYV menerima total penggunaan token dari provider. Nilai durasi di atas diukur oleh gateway BYV; nilainya tidak harus identik dengan latensi yang ditampilkan dashboard provider karena titik pengukurannya berbeda.

## 5. Observasi dashboard NaraRouter

Pada halaman **Log permintaan** NaraRouter, request yang terlihat menunjukkan:
- endpoint `POST /v1/chat/completions`;
- model **Deepseek V4 Flash**;
- provider **DeepSeek**;
- status **Berhasil**;
- tanggal **2 Nov 2026**;
- kolom **Coba Ulang** menampilkan nilai `1` pada kelima baris yang terlihat pada tangkapan layar daftar request.

Detail salah satu request yang dibuka juga memperlihatkan:
- status **Berhasil**;
- latensi **4,3 detik**;
- biaya **Rp0,74**;
- **Coba Ulang: 1**.

Snapshot daftar request yang sama memperlihatkan nilai berikut:

| Baris pada dashboard | Total token | Rincian token yang terlihat | Biaya | Latensi | Coba ulang |
| --- | ---: | --- | ---: | ---: | ---: |
| 1 | 3,6k | 113 masuk, 3,1k cache, 399 keluar | Rp0,74 | 4,3 s | 1 |
| 2 | 4,2k | 3,3k masuk, 895 keluar | Rp1,99 | 10,3 s | 1 |
| 3 | 3,6k | 3,2k masuk, 430 keluar | Rp1,50 | 4,6 s | 1 |
| 4 | 3,5k | 118 masuk, 2,7k cache, 668 keluar | Rp0,96 | 8,1 s | 1 |
| 5 | 4,0k | 2,8k masuk, 1,2k keluar | Rp2,09 | 12,5 s | 1 |

Angka token dan biaya di atas disalin dari tampilan dashboard dan mengikuti pembulatan/format tampilan UI. Daftar dashboard tidak memperlihatkan rincian attempt atau alasan retry pada screenshot yang tersedia. Karena itu, nilai `1` dicatat sebagai **observasi counter Coba Ulang**, bukan sebagai bukti final mengenai penyebab atau mekanisme retry.

## 6. Perilaku retry yang dapat dipastikan dari sisi BYV

### 6.1 Anthropic SDK

Script `scripts/anthropic-sdk-smoke.cjs` membuat client Anthropic dengan:

```js
const client = new Anthropic({
  apiKey,
  baseURL,
  maxRetries: 0,
  timeout
});
```

Dengan konfigurasi ini, retry otomatis dari Anthropic SDK dinonaktifkan untuk smoke test tersebut. Jadi, nilai **Coba Ulang: 1** pada dashboard tidak dapat dijelaskan sebagai retry otomatis Anthropic SDK dari script ini.

### 6.2 Provider adapter BYV

Pada `src/provider/openai-compatible.js`, setiap pemanggilan `createChatCompletion` atau `createStreamingChatCompletion`:
1. mengambil slot provider request limiter;
2. melakukan satu pemanggilan `fetch` ke endpoint Chat Completions;
3. membaca respons atau melempar error;
4. melepaskan slot limiter.

Adapter tidak memiliki loop retry otomatis untuk mengulang HTTP request ketika terjadi timeout, kegagalan koneksi, atau HTTP error.

### 6.3 Protocol recovery BYV

Handler BYV di `src/handler.js` memiliki mekanisme **protocol recovery** dengan batas default `MAX_RECOVERY_ATTEMPTS=2`.

Recovery ini berbeda dari retry transport/HTTP biasa. Handler dapat membuat completion tambahan dengan pesan koreksi ketika, misalnya:
- model mengeluarkan BYV markup yang malformed;
- tool call tidak lolos validasi schema atau tool allowlist;
- model tidak memenuhi `tool_choice`;
- model mengeluarkan tool markup padahal tool dinonaktifkan.

Dengan demikian, recovery dapat menghasilkan request completion tambahan ke provider. Mekanisme ini bukan retry otomatis pada adapter HTTP, melainkan percobaan ulang terarah untuk memperbaiki output protokol.

Konfigurasi `maxRetries: 0` pada SDK tidak menonaktifkan recovery internal BYV.

## 7. Interpretasi dan batas kesimpulan

Berdasarkan source code dan bukti pengujian yang tersedia, kesimpulan yang dapat dicatat adalah:

1. **Integrasi berhasil.** Kelima skenario Anthropic SDK smoke test lulus terhadap gateway BYV dengan NaraRouter dan model Deepseek V4 Flash.
2. **SDK tidak melakukan retry otomatis pada smoke test ini.** Client dikonfigurasi dengan `maxRetries: 0`.
3. **Adapter BYV tidak melakukan retry HTTP otomatis.** Satu pemanggilan fungsi adapter menghasilkan satu pemanggilan `fetch`.
4. **BYV tetap mempunyai protocol recovery.** Recovery dapat memanggil provider lagi bila output awal tidak sesuai kontrak BYV.
5. **Dashboard NaraRouter menampilkan Coba Ulang = 1 pada lima baris yang diamati.** Screenshot yang tersedia tidak menunjukkan detail attempt atau retry reason.

Oleh karena itu, **belum dapat dipastikan dari bukti yang ada siapa atau komponen mana yang menyebabkan counter NaraRouter bernilai `1`**. Counter tersebut bisa berasal dari mekanisme internal di sisi router/provider atau berkaitan dengan panggilan completion tambahan; data dashboard yang tersedia belum cukup untuk membedakannya. Keberhasilan respons akhir saja tidak membuktikan apakah ada attempt tambahan di sisi router.

Tidak tepat menyimpulkan bahwa NaraRouter pasti melakukan satu retry pada setiap request, atau bahwa seluruh counter tersebut berasal dari protocol recovery BYV. Diperlukan detail attempt/retry reason dari NaraRouter untuk memastikan arti counter tersebut.

## 8. Referensi implementasi

- [Anthropic SDK smoke test](../scripts/anthropic-sdk-smoke.cjs)
- [Provider adapter](../src/provider/openai-compatible.js)
- [BYV handler dan protocol recovery](../src/handler.js)
- [Konfigurasi environment](../src/config.js)
- [README proyek](../README.md)

---

**Status dokumentasi:** catatan observasi integrasi NaraRouter per 2 November 2026. Tidak ada perubahan pada perilaku runtime BYV yang dibuat untuk pengujian ini.
