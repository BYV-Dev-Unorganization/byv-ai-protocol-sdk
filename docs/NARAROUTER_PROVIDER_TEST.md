# NaraRouter Provider Integration Test

[English](#english) | [Bahasa Indonesia](#bahasa-indonesia)

---

# English

**Test date:** 2 November 2026  
**Result:** Passed — all Anthropic SDK smoke-test scenarios passed  
**Repository revision tested:** `15fd1bb3bf0a1738d64bed279e0be37a8117bc62`  
**Gateway:** BYV AI Protocol SDK `0.1.0`  
**Provider:** NaraRouter  
**Upstream model:** `deepseek-v4-flash` (dashboard display name: Deepseek V4 Flash)  
**BYV model profile:** `byv-flash-v1`

## 1. Purpose and scope

This document records the BYV integration test using NaraRouter as an OpenAI-compatible provider. The test used the official Anthropic SDK against a locally running BYV gateway.

The record covers:
- Messages API and streaming compatibility;
- the `tool_use` and `tool_result` flow;
- Anthropic SDK retry configuration and request behavior in the BYV provider adapter;
- the **Coba Ulang** (Retry) counter observed in the NaraRouter dashboard.

This is a test record, not a comprehensive audit of NaraRouter's internal implementation. No source-code or provider-configuration changes were made as part of documenting this test.

## 2. Test configuration

| Component | Value |
| --- | --- |
| Gateway URL | `http://127.0.0.1:8787` |
| Provider base URL | `https://router.bynara.id/v1` |
| Provider model ID | `deepseek-v4-flash` |
| BYV model profile | `byv-flash-v1` |
| Provider endpoint shown in dashboard | `POST /v1/chat/completions` |
| Provider shown in NaraRouter request details | DeepSeek |
| SDK smoke-test command | `npm run test:sdk` |
| SDK retry setting in the smoke test | `maxRetries: 0` |

Provider and gateway credentials are intentionally excluded from this document.

## 3. Anthropic SDK smoke-test results

Command executed:

```powershell
npm run test:sdk
```

Terminal result:

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

Summary:

| Scenario | Result | Notes |
| --- | --- | --- |
| Non-streaming Messages | PASS | The gateway accepted the request and returned text |
| SDK `count_tokens` | PASS | Local gateway estimate: 4,152 tokens |
| Text streaming | PASS | The SDK received stream events and text |
| Non-streaming `tool_use` | PASS | The model returned a Bash tool call matching the schema |
| `tool_result` round trip | PASS | A synthetic tool result was sent back and the model completed with a text response |
| Streaming `tool_use` | PASS | The SDK received the tool block and its JSON input |

**Note:** `count_tokens` uses BYV's local estimation endpoint; it does not make a completion request to the provider. The Bash fixture was not executed. The smoke test only sends a synthetic tool result to validate the Anthropic conversation contract.

## 4. BYV gateway log observations

The following five completion entries appeared in the gateway logs during the test:

| Flow | Stream | Message count | Tool count | Tool calls | Stop reason | Gateway duration |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| Non-streaming Messages | No | 1 | 0 | 0 | `end_turn` | 14,163 ms |
| Text streaming | Yes | 1 | 0 | 0 | `end_turn` | 9,587 ms |
| Initial `tool_use` | No | 1 | 1 | 1 | `tool_use` | 5,131 ms |
| `tool_result` round trip | No | 4 | 1 | 0 | `end_turn` | 13,195 ms |
| Streaming `tool_use` | Yes | 1 | 1 | 1 | `tool_use` | 5,324 ms |

All five completion log entries recorded `usage_estimated: false`, meaning BYV received token-usage totals from the provider. The durations above were measured by the BYV gateway. They are not necessarily identical to the latency shown in the provider dashboard because the measurement points differ.

## 5. NaraRouter dashboard observations

On the NaraRouter **Request Logs** page, the visible requests showed:
- endpoint `POST /v1/chat/completions`;
- model **Deepseek V4 Flash**;
- provider **DeepSeek**;
- status **Successful**;
- date **2 Nov 2026**;
- the **Coba Ulang** (Retry) column displayed `1` for all five rows visible in the request-list screenshot.

The opened detail panel for one request also showed:
- status **Successful**;
- latency **4.3 seconds**;
- cost **Rp0.74**;
- **Coba Ulang: 1**.

The same request-list snapshot showed these values:

| Dashboard row | Total tokens | Visible token breakdown | Cost | Latency | Retry counter |
| --- | ---: | --- | ---: | ---: | ---: |
| 1 | 3.6k | 113 input, 3.1k cache, 399 output | Rp0.74 | 4.3 s | 1 |
| 2 | 4.2k | 3.3k input, 895 output | Rp1.99 | 10.3 s | 1 |
| 3 | 3.6k | 3.2k input, 430 output | Rp1.50 | 4.6 s | 1 |
| 4 | 3.5k | 118 input, 2.7k cache, 668 output | Rp0.96 | 8.1 s | 1 |
| 5 | 4.0k | 2.8k input, 1.2k output | Rp2.09 | 12.5 s | 1 |

Token and cost figures are transcribed from the dashboard UI and retain its displayed rounding and formatting. The available screenshots do not show per-attempt details or a retry reason. Therefore, the value `1` is recorded as an **observed Retry counter**, not as conclusive evidence of the cause or mechanism of a retry.

## 6. Retry behavior that can be verified on the BYV side

### 6.1 Anthropic SDK

The `scripts/anthropic-sdk-smoke.cjs` script creates the Anthropic client with:

```js
const client = new Anthropic({
  apiKey,
  baseURL,
  maxRetries: 0,
  timeout
});
```

With this setting, automatic retries by the Anthropic SDK are disabled for this smoke test. Therefore, the NaraRouter dashboard's **Coba Ulang: 1** value cannot be attributed to automatic Anthropic SDK retries from this script.

### 6.2 BYV provider adapter

In `src/provider/openai-compatible.js`, each call to `createChatCompletion` or `createStreamingChatCompletion`:
1. acquires a provider-request-limiter slot;
2. makes one `fetch` call to the Chat Completions endpoint;
3. reads the response or throws an error;
4. releases the limiter slot.

The adapter does not contain an automatic retry loop that resends an HTTP request after a timeout, connection failure, or HTTP error.

### 6.3 BYV protocol recovery

The BYV handler in `src/handler.js` has a **protocol recovery** mechanism with a default limit of `MAX_RECOVERY_ATTEMPTS=2`.

This recovery is different from an ordinary transport/HTTP retry. The handler can send an additional completion request with corrective instructions when, for example:
- the model emits malformed BYV markup;
- a tool call fails schema validation or the tool allowlist check;
- the model does not satisfy `tool_choice`;
- the model emits tool markup even though tools are disabled.

Recovery can therefore cause additional completion requests to the provider. It is not an automatic retry in the HTTP adapter; it is a targeted attempt to correct protocol output.

The SDK setting `maxRetries: 0` does not disable BYV's internal protocol recovery.

## 7. Interpretation and limits of the findings

Based on the available source code and test evidence, the following findings can be recorded:

1. **The integration succeeded.** All five Anthropic SDK smoke-test scenarios passed through the BYV gateway using NaraRouter and the Deepseek V4 Flash model.
2. **The SDK did not automatically retry in this smoke test.** The client was configured with `maxRetries: 0`.
3. **The BYV adapter does not automatically retry HTTP requests.** One adapter function invocation results in one `fetch` call.
4. **BYV still has protocol recovery.** Recovery can call the provider again when the initial model output does not satisfy the BYV contract.
5. **The NaraRouter dashboard displayed Retry = 1 on the five observed rows.** The available screenshots do not show attempt details or a retry reason.

Consequently, **the available evidence does not establish which component caused the NaraRouter counter to show `1`**. The counter may reflect an internal router/provider mechanism or may be associated with an additional completion call; the dashboard evidence available here is insufficient to distinguish between these explanations. A successful final response alone does not establish whether an additional attempt occurred inside the router.

It would not be justified to conclude that NaraRouter definitely performed one retry for every request, or that all of the counter values came from BYV protocol recovery. NaraRouter's per-attempt details or retry reason would be needed to determine exactly what the counter represents.

## 8. Implementation references

- [Anthropic SDK smoke test](../scripts/anthropic-sdk-smoke.cjs)
- [Provider adapter](../src/provider/openai-compatible.js)
- [BYV handler and protocol recovery](../src/handler.js)
- [Environment configuration](../src/config.js)
- [Project README](../README.md)

**Documentation status:** NaraRouter integration observations as of 2 November 2026. No changes to BYV runtime behavior were made for this test record.

---

# Bahasa Indonesia

**Tanggal pengujian:** 2 November 2026  
**Hasil:** Berhasil — seluruh skenario Anthropic SDK smoke test lulus  
**Revisi repository yang diuji:** `15fd1bb3bf0a1738d64bed279e0be37a8117bc62`  
**Gateway:** BYV AI Protocol SDK `0.1.0`  
**Provider:** NaraRouter  
**Model upstream:** `deepseek-v4-flash` (nama yang tampil di dashboard: Deepseek V4 Flash)  
**Profil model BYV:** `byv-flash-v1`

## 1. Tujuan dan ruang lingkup

Dokumen ini mencatat pengujian integrasi BYV menggunakan NaraRouter sebagai provider OpenAI-compatible. Pengujian menggunakan Anthropic SDK resmi terhadap gateway BYV yang berjalan secara lokal.

Catatan ini mencakup:
- kompatibilitas Messages API dan streaming;
- alur `tool_use` dan `tool_result`;
- konfigurasi retry pada Anthropic SDK dan perilaku request di provider adapter BYV;
- observasi counter **Coba Ulang** pada dashboard NaraRouter.

Dokumen ini merupakan catatan hasil pengujian, bukan audit menyeluruh terhadap implementasi internal NaraRouter. Tidak ada perubahan source code atau konfigurasi provider yang dilakukan sebagai bagian dari dokumentasi pengujian ini.

## 2. Konfigurasi pengujian

| Komponen | Nilai |
| --- | --- |
| URL gateway | `http://127.0.0.1:8787` |
| Base URL provider | `https://router.bynara.id/v1` |
| ID model provider | `deepseek-v4-flash` |
| Profil model BYV | `byv-flash-v1` |
| Endpoint provider yang tampil di dashboard | `POST /v1/chat/completions` |
| Provider pada detail request NaraRouter | DeepSeek |
| Perintah SDK smoke test | `npm run test:sdk` |
| Pengaturan retry SDK pada smoke test | `maxRetries: 0` |

Kredensial provider dan gateway sengaja tidak dicantumkan dalam dokumen ini.

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
| Messages non-streaming | PASS | Gateway menerima request dan mengembalikan teks |
| SDK `count_tokens` | PASS | Estimasi lokal gateway: 4.152 token |
| Streaming teks | PASS | SDK menerima event stream dan teks |
| `tool_use` non-streaming | PASS | Model mengembalikan tool call Bash sesuai schema |
| Round trip `tool_result` | PASS | Hasil tool sintetis dikirim kembali dan model menyelesaikan respons teks |
| Streaming `tool_use` | PASS | SDK menerima tool block beserta input JSON |

**Catatan:** `count_tokens` menggunakan endpoint estimasi lokal BYV, bukan request completion ke provider. Fixture Bash tidak dieksekusi. Smoke test hanya mengirim hasil tool sintetis untuk memvalidasi kontrak percakapan Anthropic.

## 4. Observasi log gateway BYV

Lima entri completion berikut terlihat pada log gateway selama pengujian:

| Alur | Stream | Message count | Tool count | Tool calls | Stop reason | Durasi gateway |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| Messages non-streaming | Tidak | 1 | 0 | 0 | `end_turn` | 14.163 ms |
| Streaming teks | Ya | 1 | 0 | 0 | `end_turn` | 9.587 ms |
| `tool_use` awal | Tidak | 1 | 1 | 1 | `tool_use` | 5.131 ms |
| Round trip `tool_result` | Tidak | 4 | 1 | 0 | `end_turn` | 13.195 ms |
| Streaming `tool_use` | Ya | 1 | 1 | 1 | `tool_use` | 5.324 ms |

Kelima entri completion pada log mencatat `usage_estimated: false`, yang berarti BYV menerima total penggunaan token dari provider. Durasi di atas diukur oleh gateway BYV. Nilainya tidak harus sama dengan latensi yang ditampilkan dashboard provider karena titik pengukurannya berbeda.

## 5. Observasi dashboard NaraRouter

Pada halaman **Log permintaan** NaraRouter, request yang terlihat menunjukkan:
- endpoint `POST /v1/chat/completions`;
- model **Deepseek V4 Flash**;
- provider **DeepSeek**;
- status **Berhasil**;
- tanggal **2 Nov 2026**;
- kolom **Coba Ulang** menampilkan nilai `1` pada kelima baris yang terlihat di screenshot daftar request.

Panel detail dari salah satu request yang dibuka juga menunjukkan:
- status **Berhasil**;
- latensi **4,3 detik**;
- biaya **Rp0,74**;
- **Coba Ulang: 1**.

Snapshot daftar request yang sama menampilkan nilai berikut:

| Baris dashboard | Total token | Rincian token yang terlihat | Biaya | Latensi | Counter coba ulang |
| --- | ---: | --- | ---: | ---: | ---: |
| 1 | 3,6k | 113 masuk, 3,1k cache, 399 keluar | Rp0,74 | 4,3 s | 1 |
| 2 | 4,2k | 3,3k masuk, 895 keluar | Rp1,99 | 10,3 s | 1 |
| 3 | 3,6k | 3,2k masuk, 430 keluar | Rp1,50 | 4,6 s | 1 |
| 4 | 3,5k | 118 masuk, 2,7k cache, 668 keluar | Rp0,96 | 8,1 s | 1 |
| 5 | 4,0k | 2,8k masuk, 1,2k keluar | Rp2,09 | 12,5 s | 1 |

Angka token dan biaya disalin dari tampilan dashboard dengan pembulatan dan format sebagaimana ditampilkan oleh UI. Screenshot yang tersedia tidak memperlihatkan detail per-attempt atau alasan retry. Oleh karena itu, nilai `1` dicatat sebagai **observasi counter Coba Ulang**, bukan sebagai bukti final mengenai penyebab atau mekanisme retry.

## 6. Perilaku retry yang dapat diverifikasi dari sisi BYV

### 6.1 Anthropic SDK

Script `scripts/anthropic-sdk-smoke.cjs` membuat client Anthropic dengan konfigurasi:

```js
const client = new Anthropic({
  apiKey,
  baseURL,
  maxRetries: 0,
  timeout
});
```

Dengan pengaturan tersebut, retry otomatis dari Anthropic SDK dinonaktifkan untuk smoke test ini. Jadi, nilai **Coba Ulang: 1** pada dashboard NaraRouter tidak dapat dijelaskan sebagai retry otomatis Anthropic SDK yang berasal dari script ini.

### 6.2 Provider adapter BYV

Di dalam `src/provider/openai-compatible.js`, setiap pemanggilan `createChatCompletion` atau `createStreamingChatCompletion`:
1. mengambil slot dari provider request limiter;
2. melakukan satu pemanggilan `fetch` ke endpoint Chat Completions;
3. membaca respons atau melempar error;
4. melepaskan slot limiter.

Adapter tidak memiliki loop retry otomatis untuk mengirim ulang HTTP request ketika terjadi timeout, kegagalan koneksi, atau HTTP error.

### 6.3 Protocol recovery BYV

Handler BYV di `src/handler.js` memiliki mekanisme **protocol recovery** dengan batas default `MAX_RECOVERY_ATTEMPTS=2`.

Recovery ini berbeda dari retry transport/HTTP biasa. Handler dapat mengirim completion request tambahan yang berisi instruksi koreksi, misalnya ketika:
- model menghasilkan BYV markup yang malformed;
- tool call gagal validasi schema atau pemeriksaan tool allowlist;
- model tidak memenuhi `tool_choice`;
- model menghasilkan tool markup ketika tool sedang dinonaktifkan.

Dengan demikian, recovery dapat menyebabkan request completion tambahan ke provider. Mekanisme ini bukan retry otomatis di HTTP adapter, melainkan percobaan terarah untuk memperbaiki output protokol.

Pengaturan SDK `maxRetries: 0` tidak menonaktifkan protocol recovery internal BYV.

## 7. Interpretasi dan batas kesimpulan

Berdasarkan source code dan bukti pengujian yang tersedia, temuan yang dapat dicatat adalah:

1. **Integrasi berhasil.** Kelima skenario Anthropic SDK smoke test lulus melalui gateway BYV menggunakan NaraRouter dan model Deepseek V4 Flash.
2. **SDK tidak melakukan retry otomatis pada smoke test ini.** Client dikonfigurasi menggunakan `maxRetries: 0`.
3. **Adapter BYV tidak melakukan retry HTTP otomatis.** Satu pemanggilan fungsi adapter menghasilkan satu pemanggilan `fetch`.
4. **BYV tetap memiliki protocol recovery.** Recovery dapat memanggil provider kembali ketika output awal model tidak memenuhi kontrak BYV.
5. **Dashboard NaraRouter menampilkan Coba Ulang = 1 pada lima baris yang diamati.** Screenshot yang tersedia tidak menunjukkan detail attempt atau alasan retry.

Dengan demikian, **bukti yang tersedia belum dapat memastikan komponen mana yang menyebabkan counter NaraRouter menampilkan nilai `1`**. Counter tersebut mungkin berasal dari mekanisme internal router/provider atau berkaitan dengan completion call tambahan; bukti dashboard yang tersedia belum cukup untuk membedakan kedua kemungkinan tersebut. Respons akhir yang berhasil saja tidak membuktikan apakah terjadi attempt tambahan di dalam router.

Kita belum bisa menyimpulkan bahwa NaraRouter pasti melakukan satu retry pada setiap request, ataupun bahwa seluruh nilai counter tersebut berasal dari protocol recovery BYV. Untuk memastikan arti counter, diperlukan detail per-attempt atau retry reason dari NaraRouter.

## 8. Referensi implementasi

- [Anthropic SDK smoke test](../scripts/anthropic-sdk-smoke.cjs)
- [Provider adapter](../src/provider/openai-compatible.js)
- [Handler dan protocol recovery BYV](../src/handler.js)
- [Konfigurasi environment](../src/config.js)
- [README proyek](../README.md)

**Status dokumentasi:** catatan observasi integrasi NaraRouter per 2 November 2026. Tidak ada perubahan pada perilaku runtime BYV yang dibuat untuk catatan pengujian ini.
