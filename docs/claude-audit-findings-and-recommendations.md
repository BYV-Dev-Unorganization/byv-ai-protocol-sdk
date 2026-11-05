# BYV AI Protocol SDK: Claude Audit Findings and Recommendations
# Audit Temuan Claude dan Rekomendasi Perbaikan

**Repository:** `BYV-Dev-Unorganization/byv-ai-protocol-sdk`  
**Branch:** `feat/dsml-prompt-byv-adapter`  
**HEAD reviewed:** `c758a056b72e06b9c42683b5003cfb699ce42d0c`  
**Relevant implementation commit:** `43d15b0d262b666364a48c8a8483da1d86b82a99`  
**Date:** 2026-11-03  
**Scope:** Documentation and recommendations only. No source-code changes are included in this document.

> **Historical snapshot:** This audit describes the `feat/dsml-prompt-byv-adapter` revision identified above, not the current implementation. Use the repository README and [current autocompaction notes](AUTOCOMPACTION.md) for current behavior.

---

# Bahasa Indonesia

## 1. Tujuan dan ruang lingkup

Dokumen ini menggabungkan temuan audit kode oleh Claude, pemeriksaan silang terhadap source code pada branch yang disebutkan, serta rekomendasi teknis untuk memperkuat BYV Gateway.

Fokus audit adalah alur ketika provider mengembalikan provider-native function call sementara `PROVIDER_NATIVE_TOOL_CALLING` dinonaktifkan, lalu gateway menolak respons tersebut dan meminta model menghasilkan DSML text tool call sebagai recovery.

Dokumen ini juga membahas sanitasi konteks recovery, integritas operasi, parser dan adapter, kompatibilitas model, pengelolaan riwayat tool, efisiensi token, serta test coverage.

### 1.1 Metode dan batas bukti

Audit Claude dilakukan terhadap clone lokal repository pada branch `feat/dsml-prompt-byv-adapter`. HEAD yang dilaporkan adalah `c758a05`, dengan commit `43d15b0` sebagai ancestor. Claude melaporkan telah menjalankan `npm test` dengan hasil 150/150 lulus dan empat skrip probe lokal menggunakan provider mock.

Pemeriksaan silang tambahan terhadap source code branch mengonfirmasi beberapa alur dan menemukan bahwa sebagian klaim pada audit DeepSeek sebelumnya perlu dikoreksi. Pemeriksaan silang ini bukan pengujian LLM/provider nyata dan tidak membuktikan tingkat keberhasilan lintas model.

Gunakan penanda bukti berikut:

- **[K] Code-verified:** perilaku atau struktur dapat diperiksa langsung dari source code.
- **[P] Mock/local probe:** hasil probe lokal yang dilaporkan Claude; bukan hasil panggilan ke LLM/provider nyata.
- **[R] Recommendation:** rekomendasi desain atau implementasi.
- **[U] Unverified:** memerlukan pengujian atau bukti tambahan.

Angka probe Claude seperti “9 dari 10 pola credential bocor pada recovery” dan “5 dari 10 pada diagnostics” adalah hasil pengujian lokal yang dilaporkan Claude. Angka tersebut belum direplikasi secara independen dalam audit ini dan tidak boleh diperlakukan sebagai tingkat kebocoran universal.

## 2. Executive summary

Fondasi validasi BYV cukup baik: output recovery diproses kembali melalui adapter/parser dan schema validation sebelum dikembalikan sebagai `tool_use`. Tidak ditemukan jalur pada alur recovery yang secara langsung meloloskan output model ke hasil tool tanpa validasi.

Namun, recovery masih merupakan mata rantai yang paling lemah. Model diminta mengetik ulang operasi yang sebenarnya sudah diketahui gateway. Gateway tidak membandingkan operasi hasil recovery dengan operasi native yang ditolak. Karena itu, operasi yang berbeda tetapi tetap valid secara schema dapat diterima.

Risiko utama yang perlu ditangani:

1. **Recovery context bersifat lossy.** Batas panjang string, jumlah calls, dan ukuran total dapat menghilangkan argumen tanpa penanda yang cukup jelas.
2. **Semantic drift tidak dicegah.** Tidak ada pemeriksaan kesetaraan antara operasi yang ditolak dan hasil recovery.
3. **Sanitasi credential belum menyeluruh.** Implementasi sanitizer recovery dan diagnostics berbeda, dan pola rahasia yang tertanam dalam string biasa dapat terlewat.
4. **Parser mengenali calls block berdasarkan markup, bukan konteks kutipan.** Markup DSML/BYV yang muncul di dalam prosa atau contoh berpotensi ditafsirkan sebagai tool call.
5. **Isi string dapat bertabrakan dengan delimiter protokol.** Perlu round-trip testing untuk data file atau command yang memuat tag penutup.
6. **Tool history masih dikonversi menjadi native `assistant.tool_calls`.** Ini merupakan kandidat penyebab perilaku native-call pada giliran berikutnya, tetapi belum terbukti.
7. **Representasi schema dalam prompt tekstual lebih dangkal daripada JSON Schema aslinya.** Informasi seperti enum dan struktur array/object bersarang dapat tidak terlihat oleh model dalam mode DSML.

**Kesimpulan:** jalur validasi terstruktur sudah mempunyai fondasi yang baik, tetapi recovery belum layak dianggap production-hardened untuk input adversarial atau lingkungan auto-approval sebelum risiko integritas operasi, sanitasi, pemotongan konteks, dan parsing ditangani.

## 3. Koreksi penting terhadap audit sebelumnya

Pemeriksaan silang menemukan dua klaim DeepSeek yang tidak sesuai dengan source code:

### 3.1 Test native-rejection recovery memang tersedia

Klaim bahwa tidak ada test untuk `provider_native_disabled` recovery adalah keliru. Pada `test/handler.test.js`, termasuk pada commit `43d15b0`, terdapat test:

- `rejects provider-native calls and recovers with DSML when native calling is disabled`
- `second recovery explains a repeated native-call rejection before accepting DSML`

Test pertama memeriksa native rejection, isi recovery prompt, tidak diteruskannya provider call ID, dan diterimanya DSML sebagai `tool_use`. Test kedua memeriksa pesan khusus ketika recovery kembali menghasilkan native call.

Test tersebut menggunakan provider mock. Jadi test membuktikan perilaku handler terhadap respons yang ditentukan, bukan keberhasilan recovery pada berbagai LLM nyata.

### 3.2 Recovery prompt sudah menyebut rejected context sebagai untrusted

Klaim bahwa recovery prompt sama sekali tidak memperingatkan prompt injection juga tidak akurat. Cabang `provider_native_disabled` di `src/prompts.js` sudah menyebut JSON sebagai untrusted diagnostic data dan secara eksplisit melarang mengikuti instruksi di dalam nama tool atau nilai argumen.

Namun, risiko prompt injection belum hilang sepenuhnya. Instruksi untuk memperlakukan data sebagai untrusted tetap merupakan instruksi kepada model, bukan kontrol deterministik. Prompt juga meminta model mempertahankan nilai argumen yang tersedia. Karena itu, delimitasi yang lebih tegas dan desain recovery yang tidak meminta model menafsirkan ulang isi argumen tetap disarankan.

## 4. Prompt architecture dan efisiensi token

### 4.1 Jalur prompt aktif

Jalur runtime yang diperiksa adalah:

`buildProviderMessages()` → `buildSystemPrompt()` → system message provider.

Bagian prompt yang dibangun mencakup:

1. System prompt dari client.
2. `PROJECT_AND_LANGUAGE_INSTRUCTIONS`.
3. DSML tool-call protocol.
4. Katalog tool yang dirender oleh `toolsToPrompt()`.
5. Instruksi untuk turn terkini atau instruksi setelah tool result.
6. Kontrol `tool_choice` yang aktif.
7. Model-profile prompt, jika tersedia.

Model profile ditambahkan sebagai bagian terpisah pada akhir prompt. Dengan demikian, pemeriksaan “tanpa model profile” harus tetap membedakan profile-specific suffix dari system prompt client dan instruksi gateway inti.

### 4.2 Temuan prompt

- **[K] Ringkasan schema tekstual bersifat dangkal.** `toolsToPrompt()` merender nama tool, tipe properti tingkat atas, required marker, dan deskripsi. Struktur schema yang lebih dalam seperti enum, `items`, `anyOf`, dan objek bersarang tidak seluruhnya direpresentasikan dalam ringkasan tersebut.
- **[K] Ada bagian prompt yang tidak menjadi jalur runtime utama.** Claude melaporkan `buildFullPrompt()`, `buildResumePrompt()`, dan `BASE_TEMPLATE` tidak digunakan oleh jalur runtime aktif di `src/`, meskipun fungsi/konstanta tersebut masih diekspor atau diuji. Perlakukan ini sebagai isu pemeliharaan dan potensi sumber kebingungan, bukan bukti bahwa prompt runtime saat ini salah.
- **[K] Ada pengulangan instruksi dan contoh.** Contoh Bash `pwd` dan instruksi satu DSML calls block muncul lebih dari sekali. Ini dapat dipangkas setelah regression test memastikan kepatuhan model tidak menurun.
- **[K] Prompt proyek cukup besar.** `PROJECT_AND_LANGUAGE_INSTRUCTIONS` memuat banyak instruksi umum yang tidak semuanya berkaitan langsung dengan tool calling.
- **[P] Claude melaporkan pengukuran prompt minimal sekitar 14.280 karakter atau kira-kira 4,1K token.** Konversi karakter-ke-token adalah perkiraan, bukan pengukuran tokenizer provider.
- **[K] Provider tidak menerima native tool definitions ketika native mode OFF.** Payload `openai-compatible` hanya menyertakan `tools` dan `tool_choice` saat `PROVIDER_NATIVE_TOOL_CALLING` aktif. Pada mode DSML, tool contract disampaikan melalui system prompt tekstual.
- **[K] Riwayat Anthropic `tool_use` dikonversi menjadi pesan assistant dengan `tool_calls` native dan hasilnya menjadi `role: tool`.** Ini berlaku dalam konversi riwayat pada `src/content.js`, termasuk ketika permintaan berikutnya menggunakan mode DSML.
- **[U] Riwayat native tersebut mungkin berkontribusi pada model yang kembali menghasilkan native calls meskipun native mode OFF.** Ini hipotesis yang memerlukan eksperimen terkontrol, bukan penyebab yang sudah terbukti.

### 4.3 Rekomendasi token

1. Instrumentasikan estimasi ukuran per bagian prompt sebelum memangkas instruksi.
2. Ukur kontribusi system prompt client, instruksi BYV, tool catalog, riwayat, dan tool result.
3. Hapus atau konsolidasikan contoh dan aturan yang benar-benar duplikat.
4. Evaluasi apakah instruksi umum dalam `PROJECT_AND_LANGUAGE_INSTRUCTIONS` memang harus dikirim pada setiap permintaan gateway.
5. Jangan menghapus informasi schema yang diperlukan hanya demi mengurangi token. Schema prompt yang terlalu ringkas dapat meningkatkan kegagalan dan biaya recovery.
6. Pertahankan prefix yang stabil untuk memaksimalkan kemungkinan prompt caching, tetapi ukur dampak cache dan latensi secara terpisah.
7. Jangan menganggap cached tokens sebagai token gratis; biaya mengikuti tarif provider.

## 5. Recovery flow dan integritas operasi

### 5.1 Perilaku yang diverifikasi

Saat native calling OFF dan completion memuat `tool_calls`:

1. `parseCompletionToolCalls()` menormalisasi native calls untuk konteks diagnostik.
2. Native calls tidak diteruskan sebagai executable calls. Hasilnya adalah `calls: []` dengan alasan `PROVIDER_NATIVE_DISABLED`.
3. Handler memasuki recovery dan membuat pesan baru dengan `buildRecoveryMessage()`.
4. Recovery prompt menyatakan operasi ditolak dan belum dieksekusi.
5. Model diminta menghasilkan operasi yang sama dalam DSML.
6. Output recovery kembali melewati DSML adapter, BYV parser, allowlist/schema validation, serta pemeriksaan akhir sebelum dikembalikan sebagai `tool_use`.

Gateway pada tahap ini mengembalikan tool-use request kepada client. Eksekusi tool dilakukan oleh client/tool runtime yang menangani hasil tersebut, bukan oleh schema validator.

### 5.2 Batas recovery

- Default `MAX_RECOVERY_ATTEMPTS` adalah 2, dapat dikonfigurasi dalam rentang 0 sampai 5. Dengan default tersebut, kegagalan awal dapat memicu maksimal dua recovery request tambahan.
- Jika recovery terus mengembalikan native call, output malformed, schema-invalid, atau tidak menghasilkan calls yang dapat diterima, handler dapat berakhir dengan `BYV_TOOL_CALL_RECOVERY_FAILED` HTTP 502.
- Jika recovery mengembalikan teks biasa ketika tool recovery masih diwajibkan oleh jalur tersebut, teks itu tidak diterima sebagai pengganti tool call.
- Output yang melebihi batas maksimum dapat gagal sebelum proses recovery selesai.
- Pada recovery generik setelah respons DSML malformed/schema-invalid, konteks rejected native call dapat hilang karena handler mengganti `rejectedToolCalls` dengan konteks dari hasil terbaru, yang mungkin kosong.

### 5.3 F1 — Recovery context lossy

**Severity: High**

Lokasi utama: `src/prompts.js`, `sanitizeRecoveryValue()`, `formatRejectedToolCalls()`, dan `buildRecoveryMessage()`.

Batas yang terlihat di kode:

- String dipotong menjadi maksimal 1.200 karakter.
- Maksimal 8 rejected calls dimasukkan.
- Serialized context dibatasi 6.000 karakter.
- Jika ukuran context melampaui batas, argumen seluruh calls diganti dengan placeholder `[OMITTED: recovery context size limit]`.

Pemotongan string dilakukan sebelum value-pattern redaction dalam sanitizer. Jumlah calls atau panjang context yang berlebihan juga tidak diberi ringkasan jumlah operasi yang terbuang secara eksplisit.

Claude melaporkan probe mock di mana konten Write sekitar 3.945 karakter menjadi representasi recovery sekitar 1.194 karakter dan nilai argumennya tidak lagi lengkap. Ini hasil probe lokal, bukan run provider nyata.

**Rekomendasi:**

- Lakukan redaksi sebelum truncation.
- Tambahkan penanda eksplisit jumlah calls dan karakter yang dihilangkan.
- Jangan meminta model merekonstruksi atau mengeksekusi operasi ketika argumen penting telah dihilangkan.
- Pertimbangkan menyimpan operasi asli secara utuh di memori proses dan hanya memberikan referensi/placeholder non-rahasia ke prompt.
- Jika payload tidak dapat direpresentasikan lengkap dengan aman, gagal secara eksplisit daripada meminta model menebak.

### 5.4 F2 — Tidak ada semantic-drift guard

**Severity: High untuk lingkungan auto-approval; Medium untuk alur dengan review manusia.**

Lokasi utama: recovery acceptance block di `src/handler.js`.

Handler menerima recovery ketika tidak ada parse error, schema validation valid, dan jumlah calls lebih dari nol. Tidak ada perbandingan eksplisit antara tool name dan input hasil recovery dengan rejected native calls.

Karena itu, recovery dapat mengubah tool atau argumen dan tetap lolos selama hasilnya memenuhi allowlist dan schema.

**Rekomendasi:**

- Simpan rejected native calls asli sebagai data terstruktur di memori gateway.
- Jika recovery LLM tetap digunakan, bandingkan nama tool, jumlah calls, key argumen, dan nilai yang seharusnya dipertahankan.
- Terapkan exact equality untuk command/argumen yang harus dipertahankan, bukan hanya kesamaan schema.
- Jangan mencoba semantic equivalence generik untuk semua tool tanpa kontrak per-tool yang jelas.
- Jika mismatch ditemukan, jangan kembalikan `tool_use`; catat alasan dan gagal secara aman.

### 5.5 F3 — Dua pesan user berurutan

**Severity: Low / compatibility concern**

Recovery message ditambahkan sebagai pesan `user` baru setelah provider messages yang sudah ada. Ini menghasilkan dua pesan user berurutan dalam beberapa kondisi.

Claude mencatat bahwa perilaku ini berhasil pada pengujian DeepSeek yang dilakukan, tetapi kompatibilitas lintas provider belum diverifikasi.

**Rekomendasi:** uji normalisasi pesan untuk setiap upstream yang didukung. Jangan mengubah struktur pesan sebelum pengujian memastikan perubahan tidak merusak prompt caching atau urutan konteks.

## 6. Security review

### 6.1 F4 — Sanitizer tidak mencakup seluruh bentuk credential

**Severity: High sampai cakupan redaksi diverifikasi.**

Sanitizer recovery di `src/prompts.js` dan sanitizer diagnostics di `src/diagnostics.js` memiliki pola dan cakupan yang berbeda.

Sanitizer recovery menangani sejumlah sensitive key dan pola seperti Bearer, beberapa prefix API key, GitHub token tertentu, Slack token, AWS access key ID, serta beberapa assignment umum. Namun, key-name masking tidak cukup untuk secret yang tertanam dalam nilai string di properti seperti `command`, `url`, atau `content`.

Claude melaporkan probe lokal yang menemukan beberapa pola seperti URL userinfo, credential CLI, PEM, JWT, dan nama environment variable tertentu tidak tersamarkan. Probe tersebut perlu direplikasi dengan test otomatis sebelum dijadikan metrik tetap.

Ada pula potensi over-redaction karena regex sensitive key recovery tidak di-anchor secara ketat. Nama seperti `max_tokens` berpotensi cocok dengan bagian `token` dan tersamarkan meskipun bukan credential.

**Rekomendasi:**

- Gunakan satu modul redaksi yang konsisten untuk recovery prompt dan diagnostics.
- Redaksi string value berdasarkan pola umum credential, bukan hanya nama key.
- Tambahkan test untuk URL userinfo, credential CLI, environment variable secret/password, GitHub fine-grained token, Google API key, JWT, PEM, dan pola lain yang relevan.
- Uji batas string: redaksi harus dilakukan sebelum pemotongan.
- Hindari over-redaction pada field yang bukan credential.
- Jangan mencatat raw provider arguments atau prompt secara default.

### 6.2 F5 — Prompt injection melalui rejected context

**Severity: Medium; meningkat jika model diberi keleluasaan tinggi untuk menjalankan tool.**

Recovery prompt sudah memberi label rejected JSON sebagai untrusted diagnostic data serta melarang mengikuti instruksi di dalam nama tool atau nilai argumen. Ini kontrol prompt yang baik, tetapi bukan batas keamanan deterministik.

Model tetap diminta mempertahankan nilai argumen. Nilai string dapat berisi konten adversarial, instruksi, atau teks yang menyerupai protokol.

**Rekomendasi:**

- Pertahankan peringatan untrusted yang sudah ada.
- Bungkus data sebagai blok terstruktur dan delimitasi yang tidak mudah tertukar dengan instruksi recovery.
- Jangan meminta model menafsirkan atau memperbaiki isi argumen yang seharusnya dipertahankan secara literal.
- Gunakan pemeriksaan server-side untuk memastikan hasil recovery tidak mengubah operasi asli.
- Anggap seluruh konten provider/tool sebagai data yang tidak tepercaya.

### 6.3 F6 — Logging dan diagnostics

**Severity: Medium, tergantung konfigurasi capture.**

Handler logger `logToolCallValidation()` mencatat metadata validasi dan tidak memasukkan `call.input` ke event tersebut. Namun, diagnostics content capture merupakan mekanisme terpisah. `LOG_CAPTURE_CONTENT` default-nya false; jika diaktifkan, sebagian konten request/response dapat direkam melalui redaction diagnostics.

Karena sanitizer diagnostics berbeda dari sanitizer recovery, mengaktifkan capture dapat membawa risiko kebocoran untuk pola yang belum tertangani.

**Rekomendasi:**

- Pertahankan content capture OFF secara default.
- Tampilkan peringatan yang jelas ketika content capture diaktifkan.
- Uji redaksi pada request body, response, tool arguments, dan nested arrays.
- Pastikan log metadata tidak menyertakan input tool, prompt, atau tool result.
- Tetapkan retensi, permission file, dan proses penghapusan log untuk deployment production.

### 6.4 Batas keamanan validator

Schema validator memeriksa tool yang dideklarasikan, bentuk object, invocation ID, batas batch, dan JSON Schema. Ia tidak membuktikan bahwa command shell aman, path tidak sensitif, atau operasi tidak destruktif.

**Rekomendasi:** kebijakan izin, approval, sandboxing, dan pembatasan efek samping harus tetap berada pada layer tool/client/runtime. Jangan menganggap schema validation sebagai sandbox eksekusi.

## 7. Parser dan adapter

### 7.1 F7 — DSML di dalam prosa dapat terbaca sebagai tool call

**Severity: Medium**

Parser mencari penanda outer calls block pada response text. Parser tidak secara eksplisit mensyaratkan bahwa markup berada di luar code fence atau menjadi satu-satunya bagian protokol yang dimaksud.

Akibatnya, contoh DSML yang muncul di dalam prosa atau kutipan berpotensi dikenali sebagai calls block.

**Rekomendasi:**

- Definisikan aturan posisi dan konteks calls block secara eksplisit.
- Tambahkan test untuk markup dalam code fence, kutipan, dokumentasi, dan teks biasa.
- Jika memilih aturan “calls block harus menjadi output protokol terakhir”, ukur dampaknya terhadap model yang menambahkan whitespace/narasi.
- Jangan hanya mengandalkan prompt untuk mencegah parser salah mengartikan contoh.

### 7.2 F8 — Delimiter protokol di dalam nilai string

**Severity: Medium**

Claude melaporkan probe lokal ketika isi string yang memuat tag penutup parameter atau markup BYV literal merusak parsing/konversi. Ini penting untuk tool seperti Write/Edit yang harus mempertahankan isi file secara tepat.

**Rekomendasi:**

- Tentukan escaping contract yang konsisten dari DSML ke BYV dan dari BYV kembali ke nilai asli.
- Tambahkan round-trip test untuk newline, backslash, tag penutup parameter, markup calls literal, dan kombinasi karakter khusus.
- Jalankan fuzz test dengan data biasa dan data yang mengandung penanda protokol secara terkontrol.
- Pastikan parser hanya mengenali delimiter struktural yang tidak sedang di-escape.

### 7.3 F9 — Alias `function_calls`

**Severity: Medium jika upstream yang digunakan mengeluarkan dialek tersebut; selain itu Low.**

Adapter `src/protocol/dsml-adapter.js` mengenali tag `calls`, `tool_calls`, `invoke`, dan `parameter`. Tag `function_calls` tidak termasuk dalam daftar yang dikenali.

**Rekomendasi:** tambahkan alias hanya jika format itu memang menjadi target kompatibilitas. Sertakan fixture berdasarkan dokumentasi/probe provider yang tepat dan test bahwa alias tidak mengubah parsing format yang sudah ada.

## 8. Compatibility dan perilaku provider

- **DeepSeek:** DSML text protocol adalah target implementasi saat native mode OFF. Tingkat kepatuhan model terhadap format ini tetap perlu diuji secara empiris per model/provider/router.
- **Claude-style model profile:** nama profile seperti `claude-fable-5-1` adalah konfigurasi prompt/profile dalam gateway, bukan bukti bahwa request diproses oleh bobot model Anthropic. Provider model aktual harus dibaca dari konfigurasi/log upstream.
- **Model yang cenderung native tool calling:** jalur rejection/recovery tersedia, tetapi model dapat mengulangi native call sampai batas retry.
- **Model yang hanya menghasilkan narasi:** ketika `tool_choice=auto`, tidak menghasilkan tool call dapat merupakan keputusan model yang sah. Ini tidak otomatis memicu native-rejection recovery.
- **Reasoning effort tinggi:** forwarding effort dapat diverifikasi dari payload/test, tetapi pengaruhnya terhadap kepatuhan DSML membutuhkan pengujian empiris.
- **Riwayat tool:** representasi native `assistant.tool_calls` dalam history mode DSML merupakan hipotesis penting untuk eksperimen, bukan bukti akar masalah.

### Rekomendasi eksperimen kompatibilitas

1. Uji model tanpa riwayat tool dibandingkan model setelah satu atau lebih putaran tool.
2. Uji prompt yang sama dengan tool catalog penuh dan subset tool.
3. Kontrol model profile, plan/output style, dan reasoning effort.
4. Catat proporsi output DSML valid, native call, narasi tanpa call, parse failure, dan schema failure.
5. Gunakan sedikitnya 30 percobaan per kondisi untuk baseline awal; tingkatkan jumlah bila hasil sangat bervariasi.
6. Jangan menyimpulkan kompatibilitas dari satu keberhasilan atau satu kegagalan.

## 9. Test coverage

### 9.1 Test yang sudah ada

Source test pada branch mencakup antara lain:

- DSML/native tool parsing dan conversion.
- Native calls ditolak ketika native calling OFF lalu recovery ke DSML.
- Recovery kedua ketika model kembali menghasilkan native call.
- Recovery untuk schema-invalid BYV tool call.
- Penolakan output campuran native call dan markup.
- Sanitasi dasar untuk sensitive key dan Bearer token.
- Logging metadata validasi tanpa menampilkan argumen.
- Text-only recovery ketika tool dinonaktifkan.
- Required-tool failure dan beberapa kondisi batas handler.

Karena itu, pernyataan bahwa sama sekali tidak ada test native-rejection recovery tidak benar.

### 9.2 Test tambahan yang direkomendasikan

| Priority | Test |
|---|---|
| Critical | Credential redaction pada nilai string biasa, nested objects, arrays, URL, CLI flags, PEM, JWT, dan pola token yang relevan |
| Critical | Redaction sebelum truncation, termasuk secret yang melintasi batas karakter |
| Critical | Recovery output yang mengubah nama tool, command, path, jumlah calls, atau argumen harus ditolak sesuai kebijakan integritas |
| High | Rejected batch lebih dari 8 calls dan konteks lebih dari 6.000 karakter harus ditandai secara eksplisit; operasi tidak boleh diam-diam hilang |
| High | DSML/BYV markup di dalam code fence, kutipan, dan prosa tidak boleh salah dianggap sebagai tool call |
| High | DSML-to-BYV round-trip ketika konten string mengandung delimiter protokol |
| High | Native rejection diikuti malformed DSML, schema-invalid arguments, native call berulang, teks biasa, dan exhaustion |
| High | Recovery attempt berikutnya tetap mempertahankan konteks asli yang diperlukan atau gagal secara aman jika konteks tidak lengkap |
| Medium | Nested schema, enum, array items, dan object properties pada prompt tekstual |
| Medium | History berisi native `assistant.tool_calls` setelah DSML tool round-trip |
| Medium | `function_calls` alias jika memang didukung sebagai target kompatibilitas |
| Medium | Streaming dan recovery interaction |
| Medium | Prompt injection string di dalam rejected arguments |
| Medium | Fuzz round-trip dengan input normal dan input yang mengandung tag protokol |
| Medium | Diagnostics capture ON/OFF dan verifikasi redaction pada setiap kategori log |

## 10. Rekomendasi arsitektur: recovery LLM atau konversi deterministik

Ini adalah keputusan desain paling penting sebelum perubahan source code.

### Option A — Pertahankan DSML-only secara ketat

Native tool calls tetap ditolak. Model diminta mengeluarkan ulang operasi sebagai DSML.

**Kelebihan:**
- DSML tetap menjadi satu-satunya model-facing tool-call protocol yang diterima.
- Perilaku sesuai kebijakan native calling OFF.
- Tidak mengubah kontrak kompatibilitas gateway saat ini.

**Kekurangan:**
- Menambah satu atau lebih round trip ke provider.
- Model diminta mengetik ulang data yang sudah dimiliki gateway.
- Tetap memiliki risiko semantic drift, credential leakage, prompt injection, truncation, dan recovery failure.

**Kontrol minimum:** redaksi kuat, context-loss handling, server-side equivalence check, parser hardening, dan test recovery menyeluruh.

### Option B — Konversi native call secara deterministik ke kontrak internal BYV

Gateway menerima native call sebagai input provider, menormalisasikannya ke representasi internal yang sama, lalu menjalankan allowlist, schema validation, tool-choice validation, dan semua kontrol downstream yang sama.

**Kelebihan:**
- Tidak meminta model mengulang operasi.
- Menghindari satu recovery round trip khusus untuk re-encoding.
- Mengurangi risiko perubahan argumen oleh model recovery.
- Menghilangkan kebutuhan mengirim rejected arguments kembali ke model untuk sekadar konversi format.

**Kekurangan dan trade-off:**
- Ini bukan lagi kebijakan “native transport selalu ditolak”; gateway menerima lebih dari satu input protocol.
- Perlu kontrak tegas bahwa kedua transport dinormalisasi ke satu internal representation dan melewati validasi identik.
- Perlu penanganan ambiguity ketika response memuat native calls dan markup DSML sekaligus.
- Native provider payload tetap harus dianggap untrusted dan tidak boleh langsung dieksekusi.

### Rekomendasi

**[R] Pilih satu kontrak internal tool-call yang kanonis.** DSML dapat tetap menjadi protokol model-facing yang diprioritaskan, tetapi gateway sebaiknya tidak meminta LLM melakukan transformasi data terstruktur yang bisa dilakukan secara deterministik.

Sebelum mengubah default, buat mode eksperimen terkontrol untuk membandingkan:
- strict reject + LLM recovery;
- deterministic native-to-internal conversion + validation;
- explicit reject tanpa recovery.

Jangan mengaktifkan konversi deterministik sebelum test membuktikan bahwa allowlist, JSON Schema, tool choice, ambiguity handling, logging, dan approval boundary tetap berlaku.

## 11. Prioritas implementasi

### Phase 1 — Security dan integrity

1. Satukan sanitizer untuk recovery dan diagnostics.
2. Tambahkan value-pattern redaction dan test yang luas.
3. Redact sebelum truncation.
4. Tandai konteks yang terpotong dan jangan meminta rekonstruksi operasi yang tidak lengkap.
5. Tambahkan semantic-drift guard atau implementasikan deterministic conversion setelah keputusan arsitektur.
6. Tegaskan batas bahwa schema validation bukan execution sandbox.

### Phase 2 — Parser dan protocol robustness

1. Perketat deteksi calls block agar contoh dalam prosa tidak dijalankan.
2. Perbaiki round-trip escaping nilai string.
3. Tambahkan test delimiter dan fuzz.
4. Tambahkan alias protokol hanya berdasarkan target kompatibilitas yang terverifikasi.

### Phase 3 — Context dan compatibility

1. Uji representasi conversation history yang berisi tool calls.
2. Ukur dampak jumlah tool dan schema yang dirender.
3. Uji beberapa upstream/model profile secara terkontrol.
4. Uji streaming dan recovery.
5. Dokumentasikan failure mode dan retry semantics.

### Phase 4 — Token optimization

1. Ukur prompt per kategori.
2. Pangkas instruksi berulang.
3. Evaluasi instruksi proyek yang tidak relevan untuk setiap request.
4. Pertahankan schema yang diperlukan.
5. Ukur token, cache, latency, jumlah provider request, dan task completion dengan benchmark yang sama.

## 12. Kriteria kesiapan production

Sebelum menyatakan recovery production-ready, setidaknya harus dipenuhi:

- Semua recovered calls melewati parser, allowlist, schema, tool-choice, dan final validation.
- Tidak ada operasi yang berbeda dari operasi yang disetujui tanpa kontrol/approval yang sesuai.
- Credential redaction diuji pada nested dan value-embedded secrets.
- Truncation tidak menyebabkan operasi hilang diam-diam atau nilai rahasia bocor.
- Prompt injection dalam rejected arguments tidak dapat mengubah operasi yang diterima tanpa terdeteksi.
- Parser tidak salah mengeksekusi contoh markup dalam prosa/kutipan.
- String payload dapat melewati adapter/parser tanpa korupsi delimiter.
- Retry exhaustion, output terlalu besar, malformed response, dan native-call berulang mempunyai hasil error yang terdokumentasi.
- Pengujian mock dan pengujian provider nyata dilaporkan secara terpisah.
- Approval, sandbox, dan tool permissions tetap ditegakkan pada layer eksekusi.

---

# English Version

## 1. Purpose and scope

This document consolidates Claude's code-audit findings, cross-checks against the source code on the stated branch, and technical recommendations for strengthening the BYV Gateway.

The main focus is the path in which a provider returns a provider-native function call while `PROVIDER_NATIVE_TOOL_CALLING` is disabled. The gateway rejects that response and asks the model to produce a DSML text tool call as a recovery.

The review also covers recovery-context sanitization, operation integrity, the parser and adapter, model compatibility, tool-history handling, token efficiency, and test coverage.

### 1.1 Method and evidence limitations

Claude audited a local clone of the repository on branch `feat/dsml-prompt-byv-adapter`. The reported HEAD was `c758a05`, with commit `43d15b0` as an ancestor. Claude reported running `npm test` with 150/150 tests passing and four local probe scripts using a mock provider.

Additional source-code cross-checks confirmed several execution paths and identified claims in the earlier DeepSeek audit that need correction. These cross-checks were not live LLM/provider tests and do not establish cross-model success rates.

The following evidence labels are used:

- **[K] Code-verified:** directly inspectable in source code.
- **[P] Mock/local probe:** local probe results reported by Claude; not a live LLM/provider result.
- **[R] Recommendation:** a design or implementation recommendation.
- **[U] Unverified:** requires further testing or evidence.

Claude's probe figures, including “9 of 10 credential patterns leaked in recovery” and “5 of 10 in diagnostics,” are reported local test results. They have not been independently reproduced in this audit and must not be treated as universal leakage rates.

## 2. Executive summary

The BYV validation foundation is sound: recovery output is processed again through the adapter/parser and schema validation before it is returned as `tool_use`. No path was identified in the recovery flow that forwards model output directly as a tool result without validation.

However, recovery remains the weakest link. The model is asked to retype an operation that the gateway already knows. The gateway does not compare the recovered operation with the rejected native operation. As a result, a different operation that remains schema-valid may be accepted.

The main risks to address are:

1. **Recovery context is lossy.** String, call-count, and total-size limits can remove arguments without sufficiently clear indicators.
2. **Semantic drift is not prevented.** There is no equivalence check between the rejected operation and the recovered result.
3. **Credential sanitization is incomplete.** Recovery and diagnostics use different sanitizer implementations, and secrets embedded in ordinary strings can be missed.
4. **The parser recognizes calls blocks by markup rather than quotation context.** DSML/BYV markup inside prose or examples may be interpreted as a tool call.
5. **String contents can collide with protocol delimiters.** Round-trip testing is needed for file contents or commands containing closing tags.
6. **Tool history is still converted into native `assistant.tool_calls`.** This is a candidate explanation for native-call behavior on later turns, but it is not proven.
7. **The textual schema summary is shallower than the actual JSON Schema.** Details such as enums and nested array/object structures may not be visible to the model in DSML mode.

**Conclusion:** the structured validation path has a good foundation, but recovery should not be considered production-hardened for adversarial inputs or auto-approval environments until operation integrity, sanitization, context truncation, and parsing risks are addressed.

## 3. Important corrections to the earlier audit

Cross-checking found two DeepSeek claims that do not match the source code.

### 3.1 Native-rejection recovery tests do exist

The claim that no test covers `provider_native_disabled` recovery is incorrect. `test/handler.test.js`, including at commit `43d15b0`, contains:

- `rejects provider-native calls and recovers with DSML when native calling is disabled`
- `second recovery explains a repeated native-call rejection before accepting DSML`

The first test checks native rejection, recovery-prompt content, omission of the provider call ID, and acceptance of DSML as `tool_use`. The second checks the special message used when recovery again returns a native call.

These tests use a mock provider. They demonstrate handler behavior for predetermined responses, not recovery success across real LLMs.

### 3.2 The recovery prompt already identifies rejected context as untrusted

The claim that the recovery prompt contains no prompt-injection warning is also inaccurate. The `provider_native_disabled` branch in `src/prompts.js` labels the JSON as untrusted diagnostic data and explicitly says not to follow instructions inside tool names or argument values.

However, this does not eliminate prompt-injection risk. Treating data as untrusted is still a model instruction, not a deterministic control. The prompt also asks the model to preserve available argument values. Stronger delimiting and a design that does not require the model to reinterpret argument contents are therefore still recommended.

## 4. Prompt architecture and token efficiency

### 4.1 Active prompt path

The inspected runtime path is:

`buildProviderMessages()` → `buildSystemPrompt()` → provider system message.

The assembled prompt contains:

1. The client system prompt.
2. `PROJECT_AND_LANGUAGE_INSTRUCTIONS`.
3. The DSML tool-call protocol.
4. The tool catalog rendered by `toolsToPrompt()`.
5. Instructions for the current turn or after tool results.
6. The active `tool_choice` control.
7. A model-profile prompt, if available.

The model profile is appended as a separate final section. Therefore, any review of the prompt “without the model profile” must distinguish the profile-specific suffix from the client system prompt and the gateway's core instructions.

### 4.2 Prompt findings

- **[K] The textual schema summary is shallow.** `toolsToPrompt()` renders tool names, top-level property types, required markers, and descriptions. Deeper schema structures such as enums, `items`, `anyOf`, and nested objects are not fully represented in that summary.
- **[K] Some prompt-building code is not part of the primary runtime path.** Claude reported that `buildFullPrompt()`, `buildResumePrompt()`, and `BASE_TEMPLATE` are not used by the active runtime path in `src/`, although functions/constants remain exported or tested. Treat this as a maintenance and potential confusion issue, not proof that the current runtime prompt is incorrect.
- **[K] Instructions and examples are repeated.** The Bash `pwd` example and the one-DSML-calls-block instruction appear more than once. They can be consolidated after regression tests establish that model compliance does not decline.
- **[K] The project prompt is substantial.** `PROJECT_AND_LANGUAGE_INSTRUCTIONS` contains many general instructions that are not directly related to tool calling.
- **[P] Claude reported a minimal prompt measurement of about 14,280 characters, or approximately 4.1K tokens.** Character-to-token conversion is an estimate, not a provider tokenizer measurement.
- **[K] The provider does not receive native tool definitions when native mode is OFF.** The `openai-compatible` payload includes `tools` and `tool_choice` only when `PROVIDER_NATIVE_TOOL_CALLING` is enabled. In DSML mode, the tool contract is conveyed through textual system-prompt instructions.
- **[K] Anthropic `tool_use` history is converted into assistant messages with native `tool_calls`, and results are converted into `role: tool` messages.** This occurs in `src/content.js`, including when the next request uses DSML mode.
- **[U] This native history representation may contribute to the model returning native calls again even when native mode is OFF.** This is a hypothesis requiring a controlled experiment, not a proven cause.

### 4.3 Token recommendations

1. Instrument prompt size by section before removing instructions.
2. Measure the contribution of the client system prompt, BYV instructions, tool catalog, conversation history, and tool results.
3. Remove or consolidate examples and rules that are genuinely duplicated.
4. Evaluate whether all general instructions in `PROJECT_AND_LANGUAGE_INSTRUCTIONS` need to be sent with every gateway request.
5. Do not remove required schema information merely to save tokens. An overly compact schema prompt may increase failures and recovery cost.
6. Keep stable prefixes where possible to improve prompt-cache reuse, but measure cache behavior and latency separately.
7. Do not treat cached tokens as free; cost depends on provider pricing.

## 5. Recovery flow and operation integrity

### 5.1 Verified behavior

When native calling is OFF and the completion contains `tool_calls`:

1. `parseCompletionToolCalls()` normalizes native calls for diagnostic context.
2. Native calls are not forwarded as executable calls. The result is `calls: []` with reason `PROVIDER_NATIVE_DISABLED`.
3. The handler enters recovery and creates a new message with `buildRecoveryMessage()`.
4. The recovery prompt states that the operation was rejected and has not been executed.
5. The model is asked to produce the same operation in DSML.
6. Recovery output passes through the DSML adapter, BYV parser, allowlist/schema validation, and final checks before being returned as `tool_use`.

At this stage, the gateway returns a tool-use request to the client. Tool execution is performed by the client/tool runtime handling that result, not by the schema validator.

### 5.2 Recovery limits

- The default `MAX_RECOVERY_ATTEMPTS` is 2 and can be configured from 0 to 5. With the default, an initial failure may trigger up to two additional recovery requests.
- If recovery continues to return native calls, malformed output, schema-invalid arguments, or no acceptable calls, the handler may end with `BYV_TOOL_CALL_RECOVERY_FAILED` HTTP 502.
- If recovery returns plain text while tool recovery is still required by that path, the text is not accepted as a substitute for a tool call.
- Output exceeding the maximum size can fail before recovery completes.
- During generic recovery after malformed/schema-invalid DSML, the rejected-native-call context can be lost because the handler replaces `rejectedToolCalls` with the latest result's context, which may be empty.

### 5.3 F1 — Lossy recovery context

**Severity: High**

Primary locations: `src/prompts.js`, `sanitizeRecoveryValue()`, `formatRejectedToolCalls()`, and `buildRecoveryMessage()`.

Visible limits in the code:

- Strings are limited to 1,200 characters.
- At most 8 rejected calls are included.
- Serialized context is limited to 6,000 characters.
- If the context exceeds the limit, arguments for all calls are replaced with `[OMITTED: recovery context size limit]`.

String truncation occurs before value-pattern redaction in the sanitizer. Excessive call counts or total context length are also not accompanied by a sufficiently explicit summary of how many operations were removed.

Claude reported a mock probe in which Write content of about 3,945 characters became a recovery representation of about 1,194 characters, leaving the argument incomplete. This is a local probe result, not a live provider run.

**Recommendations:**

- Redact before truncating.
- Add explicit indicators for the number of calls and characters omitted.
- Do not ask the model to reconstruct or execute an operation when important arguments have been removed.
- Consider retaining the complete original operation in gateway process memory and exposing only non-secret references/placeholders to the prompt.
- If the payload cannot be represented completely and safely, fail explicitly rather than asking the model to guess.

### 5.4 F2 — No semantic-drift guard

**Severity: High for auto-approval environments; Medium for human-reviewed flows.**

Primary location: the recovery acceptance block in `src/handler.js`.

The handler accepts recovery when there is no parse error, schema validation is valid, and at least one call exists. It does not explicitly compare the recovered tool names and inputs with the rejected native calls.

Therefore, recovery can change the tool or arguments and still pass as long as the result satisfies the allowlist and schema.

**Recommendations:**

- Preserve the original rejected native calls as structured data in gateway memory.
- If LLM recovery remains, compare tool names, call count, argument keys, and values that must be preserved.
- Apply exact equality to commands/arguments that must remain unchanged, rather than relying only on schema validity.
- Do not attempt generic semantic equivalence for every tool without a clear per-tool contract.
- If a mismatch is detected, do not return `tool_use`; record the reason and fail safely.

### 5.5 F3 — Consecutive user messages

**Severity: Low / compatibility concern**

The recovery message is appended as a new `user` message after the existing provider messages. In some cases this produces two consecutive user messages.

Claude noted that this worked in the tested DeepSeek scenario, but cross-provider compatibility has not been verified.

**Recommendation:** test message normalization for every supported upstream. Do not change message structure before testing that the change does not break prompt caching or context ordering.

## 6. Security review

### 6.1 F4 — Credential sanitizer does not cover every credential form

**Severity: High until redaction coverage is verified.**

The recovery sanitizer in `src/prompts.js` and the diagnostics sanitizer in `src/diagnostics.js` use different patterns and coverage.

The recovery sanitizer handles several sensitive keys and patterns such as Bearer, selected API-key prefixes, certain GitHub tokens, Slack tokens, AWS access key IDs, and several common assignments. However, key-name masking is insufficient for secrets embedded in string values under properties such as `command`, `url`, or `content`.

Claude reported local probes in which patterns such as URL userinfo, CLI credentials, PEM, JWT, and certain environment-variable names were not redacted. Those probes should be reproduced in automated tests before being treated as fixed metrics.

There is also potential over-redaction because the recovery sensitive-key regex is not tightly anchored. A property such as `max_tokens` may match the `token` substring and be redacted even though it is not a credential.

**Recommendations:**

- Use one consistent redaction module for recovery prompts and diagnostics.
- Redact string values by common credential patterns, not only by key names.
- Add tests for URL userinfo, CLI credentials, secret/password environment variables, GitHub fine-grained tokens, Google API keys, JWT, PEM, and other relevant patterns.
- Test string boundaries: redaction must occur before truncation.
- Avoid over-redaction of fields that are not credentials.
- Do not log raw provider arguments or prompts by default.

### 6.2 F5 — Prompt injection through rejected context

**Severity: Medium; higher when the model has broad tool-execution autonomy.**

The recovery prompt already labels rejected JSON as untrusted diagnostic data and prohibits following instructions inside tool names or argument values. This is a useful prompt-level control, but not a deterministic security boundary.

The model is still asked to preserve argument values. String values may contain adversarial content, instructions, or text that resembles protocol markup.

**Recommendations:**

- Retain the existing untrusted-data warning.
- Wrap the data in a structured block with delimiters that cannot easily be confused with recovery instructions.
- Do not ask the model to interpret or repair argument content that should be preserved literally.
- Use server-side checks to ensure recovery does not change the original operation.
- Treat all provider/tool content as untrusted data.

### 6.3 F6 — Logging and diagnostics

**Severity: Medium, depending on capture configuration.**

The handler's `logToolCallValidation()` records validation metadata and does not include `call.input` in that event. However, diagnostics content capture is a separate mechanism. `LOG_CAPTURE_CONTENT` defaults to false; when enabled, some request/response content may be recorded through diagnostics redaction.

Because the diagnostics sanitizer differs from the recovery sanitizer, enabling capture can create exposure for patterns that are not covered.

**Recommendations:**

- Keep content capture OFF by default.
- Display a clear warning when content capture is enabled.
- Test redaction on request bodies, responses, tool arguments, and nested arrays.
- Ensure metadata logs do not include tool inputs, prompts, or tool results.
- Define retention, file permissions, and log-deletion procedures for production deployments.

### 6.4 Validator security boundary

The schema validator checks declared tools, object shape, invocation IDs, batch limits, and JSON Schema. It does not prove that a shell command is safe, a path is non-sensitive, or an operation is non-destructive.

**Recommendation:** permissions, approval, sandboxing, and side-effect restrictions must remain enforced by the tool/client/runtime layer. Do not treat schema validation as an execution sandbox.

## 7. Parser and adapter

### 7.1 F7 — DSML inside prose may be interpreted as a tool call

**Severity: Medium**

The parser searches response text for an outer calls-block marker. It does not explicitly require the markup to be outside a code fence or to be the only intended protocol section.

As a result, a DSML example appearing in prose or a quotation may be recognized as a calls block.

**Recommendations:**

- Define explicit position and context rules for calls blocks.
- Add tests for markup inside code fences, quotations, documentation, and ordinary prose.
- If requiring the calls block to be the final protocol output, measure the effect on models that add whitespace or narration.
- Do not rely on prompts alone to prevent the parser from misinterpreting examples.

### 7.2 F8 — Protocol delimiters inside string values

**Severity: Medium**

Claude reported local probes in which string content containing parameter-closing tags or literal BYV markup corrupted parsing/conversion. This matters for tools such as Write/Edit that must preserve file contents exactly.

**Recommendations:**

- Define a consistent escaping contract from DSML to BYV and from BYV back to the original value.
- Add round-trip tests for newlines, backslashes, parameter-closing tags, literal calls markup, and special-character combinations.
- Run fuzz tests with ordinary data and controlled protocol-marker data.
- Ensure the parser recognizes only structural delimiters that have not been escaped.

### 7.3 F9 — `function_calls` alias

**Severity: Medium if an upstream emits this dialect; otherwise Low.**

The adapter in `src/protocol/dsml-adapter.js` recognizes `calls`, `tool_calls`, `invoke`, and `parameter`. The `function_calls` tag is not in the recognized list.

**Recommendation:** add the alias only if that format is an actual compatibility target. Include fixtures from the relevant provider documentation/probes and tests proving that the alias does not change existing parsing behavior.

## 8. Provider compatibility and behavior

- **DeepSeek:** DSML text protocol is the implementation target when native mode is OFF. Model compliance with this format still needs empirical testing for each model/provider/router.
- **Claude-style model profiles:** a profile name such as `claude-fable-5-1` is a gateway prompt/profile configuration, not proof that the request is processed by Anthropic model weights. The actual upstream model must be read from provider configuration/logs.
- **Models prone to native tool calling:** the rejection/recovery path exists, but a model may repeat native calls until the retry limit is reached.
- **Narrative-only models:** under `tool_choice=auto`, not returning a tool call may be a valid model decision. It does not automatically trigger native-rejection recovery.
- **High reasoning effort:** effort forwarding can be verified from payload/tests, but its effect on DSML compliance requires empirical testing.
- **Tool history:** native `assistant.tool_calls` representation in DSML-mode history is an important experiment hypothesis, not a proven root cause.

### Compatibility experiment recommendations

1. Test a model without tool history against the same model after one or more tool rounds.
2. Test the same prompt with a full tool catalog and a reduced subset.
3. Control model profile, plan/output style, and reasoning effort.
4. Record rates of valid DSML, native calls, narrative-only responses, parse failures, and schema failures.
5. Use at least 30 attempts per condition for an initial baseline; increase the sample if results vary widely.
6. Do not infer compatibility from one success or one failure.

## 9. Test coverage

### 9.1 Existing tests

The branch's test suite includes, among other cases:

- DSML/native tool parsing and conversion.
- Native calls rejected when native calling is OFF, followed by DSML recovery.
- A second recovery when the model returns another native call.
- Recovery for schema-invalid BYV tool calls.
- Rejection of mixed native-call and markup output.
- Basic sanitization for sensitive keys and Bearer tokens.
- Validation-metadata logging without exposing arguments.
- Text-only recovery when tools are disabled.
- Required-tool failure and several handler boundary conditions.

Therefore, the statement that no native-rejection recovery tests exist is incorrect.

### 9.2 Recommended additional tests

| Priority | Test |
|---|---|
| Critical | Credential redaction in ordinary string values, nested objects, arrays, URLs, CLI flags, PEM, JWT, and relevant token patterns |
| Critical | Redaction before truncation, including secrets crossing the character boundary |
| Critical | Recovery that changes tool name, command, path, call count, or arguments must be rejected according to the integrity policy |
| High | Rejected batches over 8 calls and contexts over 6,000 characters must be explicitly marked; operations must not silently disappear |
| High | DSML/BYV markup inside code fences, quotations, and prose must not be misinterpreted as a tool call |
| High | DSML-to-BYV round-trip when string contents include protocol delimiters |
| High | Native rejection followed by malformed DSML, schema-invalid arguments, repeated native calls, plain text, and retry exhaustion |
| High | Later recovery attempts must retain the required original context or fail safely when context is incomplete |
| Medium | Nested schemas, enums, array items, and object properties in textual prompts |
| Medium | History containing native `assistant.tool_calls` after a DSML tool round-trip |
| Medium | `function_calls` alias if it is a supported compatibility target |
| Medium | Streaming and recovery interaction |
| Medium | Prompt-injection strings inside rejected arguments |
| Medium | Round-trip fuzzing with ordinary input and protocol-marker input |
| Medium | Diagnostics capture ON/OFF and redaction verification for every log category |

## 10. Architecture recommendation: LLM recovery or deterministic conversion

This is the most important design decision before changing source code.

### Option A — Keep strict DSML-only behavior

Native tool calls continue to be rejected. The model is asked to re-emit the operation as DSML.

**Advantages:**
- DSML remains the only accepted model-facing tool-call protocol.
- Behavior matches the native-calling-OFF policy.
- The gateway's current compatibility contract is preserved.

**Disadvantages:**
- Adds one or more provider round trips.
- Asks the model to retype data the gateway already has.
- Retains semantic-drift, credential-leakage, prompt-injection, truncation, and recovery-failure risks.

**Minimum controls:** robust redaction, context-loss handling, server-side equivalence checks, parser hardening, and comprehensive recovery tests.

### Option B — Deterministically convert native calls into the internal BYV contract

The gateway accepts native calls as provider input, normalizes them into the same internal representation, then applies the same allowlist, schema validation, tool-choice validation, and downstream controls.

**Advantages:**
- Does not ask the model to repeat the operation.
- Avoids a special recovery round trip for re-encoding.
- Reduces the risk of model-induced argument changes during recovery.
- Removes the need to send rejected arguments back to the model solely for format conversion.

**Disadvantages and trade-offs:**
- This is no longer a policy that “native transport is always rejected”; the gateway accepts more than one input protocol.
- A clear contract is required so both transports normalize to one internal representation and pass identical validation.
- Ambiguity must be handled when a response contains both native calls and DSML markup.
- Native provider payloads must still be treated as untrusted and must never be executed directly.

### Recommendation

**[R] Choose one canonical internal tool-call contract.** DSML can remain the preferred model-facing protocol, but the gateway should avoid asking an LLM to perform a deterministic transformation of structured data.

Before changing the default, create controlled experimental modes to compare:
- strict reject + LLM recovery;
- deterministic native-to-internal conversion + validation;
- explicit rejection without recovery.

Do not enable deterministic conversion until tests prove that allowlists, JSON Schema, tool choice, ambiguity handling, logging, and approval boundaries remain enforced.

## 11. Implementation priorities

### Phase 1 — Security and integrity

1. Unify recovery and diagnostics sanitization.
2. Add value-pattern redaction and extensive tests.
3. Redact before truncation.
4. Mark truncated context and do not ask the model to reconstruct incomplete operations.
5. Add a semantic-drift guard or implement deterministic conversion after the architecture decision.
6. Clarify that schema validation is not an execution sandbox.

### Phase 2 — Parser and protocol robustness

1. Tighten calls-block detection so examples in prose are not executed.
2. Fix string-value round-trip escaping.
3. Add delimiter and fuzz tests.
4. Add protocol aliases only for verified compatibility targets.

### Phase 3 — Context and compatibility

1. Test conversation-history representation containing tool calls.
2. Measure the impact of tool count and rendered schemas.
3. Test multiple upstream models/profiles under controlled conditions.
4. Test streaming and recovery.
5. Document failure modes and retry semantics.

### Phase 4 — Token optimization

1. Measure prompt content by category.
2. Remove redundant instructions.
3. Evaluate project instructions that are not relevant to every request.
4. Preserve required schema information.
5. Measure tokens, cache, latency, provider request count, and task completion using the same benchmark.

## 12. Production-readiness criteria

Before describing recovery as production-ready, at minimum:

- Every recovered call passes parser, allowlist, schema, tool-choice, and final validation.
- No operation can differ from the approved operation without the appropriate control/approval.
- Credential redaction is tested for nested and value-embedded secrets.
- Truncation cannot silently drop operations or expose secrets.
- Prompt injection in rejected arguments cannot change an accepted operation without detection.
- The parser does not mistakenly execute markup examples in prose/quotations.
- String payloads pass through the adapter/parser without delimiter corruption.
- Retry exhaustion, oversized output, malformed responses, and repeated native calls have documented outcomes.
- Mock tests and real-provider tests are reported separately.
- Approval, sandboxing, and tool permissions remain enforced at the execution layer.

---

**Document status:** Audit findings and recommendations. This document does not authorize or perform any source-code changes.
