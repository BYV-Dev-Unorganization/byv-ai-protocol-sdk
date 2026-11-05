# Proposal: Reduce Claude Code Context and Token Overhead in BYV Gateway

**Status:** Draft proposal  
**Scope:** Measurement and optimization; no implementation changes are included in this proposal.

> **Current-state note:** This is a historical proposal and test analysis. The SDK now includes bounded, model-neutral Claude Code autocompaction replay; see [AUTOCOMPACTION.md](AUTOCOMPACTION.md). The remaining measurement and optimization ideas below should still be treated as proposals unless independently verified in the current source.  
**Basis:** Local Claude Code tests against the BYV AI Protocol SDK gateway using the configured DeepSeek provider.

---

# Bahasa Indonesia

## 1. Latar Belakang

Pengujian nyata menunjukkan bahwa Claude Code dapat menggunakan BYV Gateway untuk menjalankan pekerjaan coding, termasuk membuat landing page portfolio di folder `byv-profile`.

Alur tool calling berbasis DSML juga berhasil digunakan. Pada salah satu request, provider mengembalikan native function call ketika native calling dinonaktifkan. Gateway menolak pemanggilan tersebut dengan `PROVIDER_NATIVE_DISABLED`, lalu melakukan recovery. Respons recovery menggunakan DSML, berhasil dikonversi ke format internal BYV, lolos validasi, dan dikembalikan sebagai tool call yang dapat dieksekusi.

Keberhasilan tersebut menunjukkan bahwa jalur DSML dan recovery dapat bekerja dalam penggunaan Claude Code yang nyata. Namun, pengujian juga memperlihatkan konsumsi prompt token yang cukup besar untuk pekerjaan yang relatif sederhana.

## 2. Temuan dari Pengujian

Temuan berikut berasal dari pengujian dan log yang dibagikan:

- Claude Code berhasil terhubung ke gateway lokal.
- DeepSeek berhasil menghasilkan DSML untuk pemanggilan tool.
- Gateway berhasil mengonversi DSML ke format internal BYV dan memvalidasi tool call.
- Skenario native-call rejection kemudian recovery ke DSML berhasil pada pengujian nyata.
- Tool `Write` digunakan untuk membuat `byv-profile/index.html` dan `byv-profile/app.js`.
- Tool PowerShell berhasil digunakan untuk menjalankan server preview lokal.
- Pada pengujian landing page, salah satu ringkasan penggunaan menunjukkan sekitar **32.540 prompt tokens** dan **5.572 completion tokens**.
- Pada request lanjutan yang tercatat, prompt token berada di kisaran **36 ribu**. Salah satu log recovery melaporkan **35.825 cached prompt tokens dari 36.335 prompt tokens**.

Angka token tersebut merupakan angka yang dilaporkan pada log untuk request terkait, bukan estimasi biaya. Dampak biaya aktual bergantung pada tarif input, cached input, dan output provider.

Pengujian juga menemukan bahwa Claude Code menggunakan **Output Style: Learning**. Instruksi gaya tersebut membuat Claude meninggalkan bagian `TODO(human)` dan meminta kontribusi manual untuk sebagian implementasi. Hal ini perlu dibedakan dari masalah gateway atau DSML: tool calling tetap berhasil, tetapi penyelesaian task dipengaruhi oleh instruksi output style.

## 3. Masalah yang Ingin Diatasi

Prompt dan konteks yang dikirim ke provider tampak besar dibandingkan dengan ukuran task yang sedang dikerjakan. Konteks tersebut dapat mencakup instruksi sistem, definisi dan schema tool, riwayat percakapan, hasil tool, serta instruksi runtime.

Log yang tersedia belum memisahkan kontribusi token dari setiap kategori tersebut. Karena itu, sumber overhead perlu diukur terlebih dahulu sebelum melakukan pemangkasan.

## 4. Usulan Peningkatan

### A. Instrumentasi penggunaan token per kategori

Tambahkan atau manfaatkan pencatatan untuk mengukur:

- Instruksi sistem dan instruksi runtime.
- Definisi tool dan JSON Schema.
- Riwayat percakapan.
- Hasil tool.
- Pesan task terbaru.
- Input token, cached input token, dan output token dari provider.

Tujuannya adalah menemukan komponen yang paling besar dan paling sering dikirim ulang.

### B. Optimasi definisi tool

Evaluasi apakah deskripsi tool dan schema dapat dibuat lebih ringkas tanpa menghilangkan parameter, batasan, atau instruksi keselamatan yang dibutuhkan.

Jangan menghapus tool yang diperlukan Claude Code hanya demi mengurangi token. Perubahan harus mempertahankan kemampuan menggunakan tool seperti Bash, PowerShell, Read, Write, dan Edit sesuai tool yang tersedia pada sesi.

### C. Pengelolaan riwayat dan hasil tool

Evaluasi strategi untuk membatasi atau merangkum konteks lama yang tidak lagi relevan, terutama hasil tool yang panjang. Informasi yang masih diperlukan untuk melanjutkan task harus tetap dipertahankan.

### D. Stabilitas prompt caching

Tinjau urutan dan kestabilan bagian prompt agar prefix yang tidak berubah dapat digunakan kembali oleh mekanisme prompt caching provider. Perubahan dinamis sebaiknya tidak membuat bagian statis yang besar berubah tanpa kebutuhan.

### E. Instruksi penyelesaian task

Untuk skenario coding otomatis, dokumentasikan pengaruh Output Style Claude Code. Pengujian penyelesaian task perlu menggunakan instruksi yang konsisten dan memastikan tidak ada `TODO(human)` yang tertinggal kecuali memang diminta.

## 5. Rencana Pengujian dan Kriteria Keberhasilan

Gunakan task pembanding yang sama sebelum dan sesudah optimasi, misalnya membuat landing page sederhana pada folder baru.

Catat untuk setiap pengujian:

1. Total prompt, cached prompt, dan completion tokens.
2. Jumlah request provider dan recovery attempt.
3. Jumlah tool call yang tervalidasi dan berhasil dieksekusi.
4. Apakah task selesai tanpa intervensi manual yang tidak diminta.
5. Durasi penyelesaian dan error yang muncul.

Optimasi dianggap berhasil apabila konsumsi token berkurang secara terukur, sementara tool calling, validasi DSML, recovery native-call, dan penyelesaian task tetap berfungsi. Automated test yang sudah ada juga harus tetap lulus.

## 6. Tahapan yang Diusulkan

1. **Baseline:** simpan log dan angka penggunaan token untuk task pembanding.
2. **Analisis:** identifikasi sumber terbesar dari prompt dan pengiriman ulang konteks.
3. **Optimasi bertahap:** ubah satu kategori pada satu waktu agar dampaknya dapat diukur.
4. **Regression test:** jalankan automated test serta skenario Claude Code yang sama.
5. **Evaluasi:** bandingkan token, cache, latensi, recovery, dan keberhasilan task.

## 7. Batasan dan Risiko

- Jangan mengorbankan instruksi keselamatan, validasi schema, allowlist tool, atau batasan `tool_choice` demi penghematan token.
- Jangan menganggap cached tokens sebagai token gratis; perhitungan biaya mengikuti tarif provider.
- Jangan menyimpulkan seluruh overhead berasal dari gateway sebelum komponen prompt dan tool context diukur.
- Perubahan harus menjaga DSML sebagai format tool-call yang diterima ketika mode DSML aktif.
- Pengujian yang tersedia membuktikan keberhasilan pada skenario yang dicoba, bukan jaminan untuk semua model, tool, atau jenis task.

## 8. Rekomendasi

Mulai dari instrumentasi dan baseline, bukan langsung memangkas prompt. Setelah komponen terbesar diketahui, lakukan optimasi kecil dan terukur dengan task pembanding yang sama. Prioritas utama adalah mengurangi pengiriman konteks yang tidak perlu sambil mempertahankan kompatibilitas Claude Code dan keberhasilan DSML recovery.

---

# English

## 1. Background

Real-world testing showed that Claude Code can use the BYV Gateway to perform coding tasks, including creating a portfolio landing page in the `byv-profile` directory.

The DSML-based tool-calling path also worked. In one request, the provider returned a native function call while native calling was disabled. The gateway rejected it with `PROVIDER_NATIVE_DISABLED` and initiated recovery. The recovery response used DSML, was converted into BYV's internal format, passed validation, and was returned as an executable tool call.

This demonstrates that the DSML and recovery path can work in an actual Claude Code session. However, the tests also showed relatively high prompt-token usage for a modest task.

## 2. Test Findings

The following findings are based on the tests and logs shared:

- Claude Code successfully connected to the local gateway.
- DeepSeek successfully generated DSML tool calls.
- The gateway converted DSML into BYV's internal format and validated the tool calls.
- The native-call rejection followed by DSML recovery succeeded in a real test.
- The `Write` tool created `byv-profile/index.html` and `byv-profile/app.js`.
- PowerShell was successfully used to start a local preview server.
- One landing-page usage summary showed approximately **32,540 prompt tokens** and **5,572 completion tokens**.
- Subsequent recorded requests showed prompt usage in the **36-thousand-token range**. One recovery log reported **35,825 cached prompt tokens out of 36,335 prompt tokens**.

These are provider-reported figures for the relevant requests, not cost estimates. Actual cost depends on the provider's input, cached-input, and output pricing.

The test also showed that Claude Code was using **Output Style: Learning**. That style instructed Claude to leave a `TODO(human)` and request manual contribution for part of the implementation. This should be distinguished from a gateway or DSML issue: tool calling worked, while task completion was affected by the selected output style.

## 3. Problem Statement

The prompt and context sent to the provider appear large relative to the task being performed. They may include system instructions, tool definitions and schemas, conversation history, tool results, and runtime instructions.

The available logs do not yet break down the token contribution of each category. The sources of overhead should therefore be measured before removing or shortening context.

## 4. Proposed Improvements

### A. Token instrumentation by category

Add or use measurements for:

- System and runtime instructions.
- Tool definitions and JSON Schemas.
- Conversation history.
- Tool results.
- The latest task message.
- Provider-reported input, cached-input, and output tokens.

The goal is to identify which components are largest and most frequently resent.

### B. Tool-definition optimization

Review whether tool descriptions and schemas can be made more concise without removing required parameters, constraints, or safety instructions.

Do not remove tools required by Claude Code solely to reduce token usage. Changes must preserve the ability to use tools such as Bash, PowerShell, Read, Write, and Edit when they are available in the session.

### C. Conversation and tool-result management

Evaluate strategies for limiting or summarizing older context that is no longer relevant, especially lengthy tool results. Information required to continue the task must remain available.

### D. Prompt-cache stability

Review prompt ordering and stability so unchanged prefixes can be reused by the provider's prompt-caching mechanism. Dynamic content should not unnecessarily invalidate large static sections.

### E. Task-completion instructions

Document the effect of Claude Code output styles. Completion benchmarks should use consistent instructions and verify that no `TODO(human)` items remain unless explicitly requested.

## 5. Test Plan and Success Criteria

Use the same benchmark task before and after optimization, such as creating a simple landing page in a new directory.

Record the following for each run:

1. Total prompt, cached-prompt, and completion tokens.
2. Number of provider requests and recovery attempts.
3. Number of validated and successfully executed tool calls.
4. Whether the task completed without unrequested manual intervention.
5. Completion time and any errors.

An optimization is successful when token usage is measurably reduced while tool calling, DSML validation, native-call recovery, and task completion continue to work. The existing automated test suite must also continue to pass.

## 6. Proposed Phases

1. **Baseline:** capture logs and token usage for a repeatable benchmark task.
2. **Analysis:** identify the largest sources of prompt content and repeated context.
3. **Incremental optimization:** change one category at a time so its impact can be measured.
4. **Regression testing:** run the automated suite and repeat the same Claude Code scenario.
5. **Evaluation:** compare token usage, cache behavior, latency, recovery, and task success.

## 7. Constraints and Risks

- Do not weaken safety instructions, schema validation, tool allowlists, or `tool_choice` constraints to save tokens.
- Do not treat cached tokens as free; cost calculations must use the provider's pricing.
- Do not assume all overhead originates in the gateway before measuring prompt and tool-context components.
- Preserve DSML as the accepted tool-call format when DSML mode is enabled.
- The available tests demonstrate success for the scenarios exercised, not a guarantee for every model, tool, or task.

## 8. Recommendation

Start with instrumentation and a baseline rather than immediately shortening prompts. Once the largest components are identified, apply small, measurable optimizations against the same benchmark task. The primary goal is to reduce unnecessary context transmission while preserving Claude Code compatibility and successful DSML recovery.
