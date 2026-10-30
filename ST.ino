
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <SPI.h>
#include <MFRC522.h>
#include "HX711.h"
#include <ESP32Servo.h>
#include <math.h>

// =====================================================
// 1. KONFIGURASI UTAMA
// =====================================================

// Kredensial (WIFI_SSID, WIFI_PASSWORD, DEVICE_TOKEN) ada di secrets.h.
// Berkas itu tidak boleh di-commit. Contoh isi: secrets.example.h.
#include "secrets.h"

const char* SUPABASE_URL =
  "https://rdrzrxambxgqjbazuopo.supabase.co/functions/v1/super-processor";

// ID stasiun SLB-001 di tabel stations (bukan rahasia)
const char* STATION_ID = "b61a95df-ec99-4457-a723-d785e4d76953";

// RFID RC522 — PIN TETAP
const int RFID_SS_PIN   = 5;
const int RFID_RST_PIN  = 22;
const int RFID_SCK_PIN  = 18;
const int RFID_MOSI_PIN = 23;
const int RFID_MISO_PIN = 19;

// HX711 — PIN TETAP
const int HX711_DOUT_PIN = 4;
const int HX711_SCK_PIN  = 16;

// Buzzer aktif (aktif HIGH) — PIN TETAP
const int BUZZER_PIN = 27;

// Servo pintu (continuous, tanpa sensor posisi) — PIN TETAP
const int SERVO_PIN = 21;

// Servo continuous: sudut 90 = diam, 0 dan 180 = berputar berlawanan arah.
// ARAH BELUM DIVERIFIKASI pada pintu fisik. Jika terbalik, tukar nilai
// SERVO_OPEN_ANGLE dan SERVO_CLOSE_ANGLE.
const int SERVO_STOP_ANGLE  = 90;
const int SERVO_OPEN_ANGLE  = 0;
const int SERVO_CLOSE_ANGLE = 180;
const int SERVO_MIN_US = 1000;
const int SERVO_MAX_US = 2000;

// Batas keras waktu putar agar pintu tidak berputar terus.
const unsigned long SERVO_MAX_RUN_MS = 2000;

// Awal konservatif; sesuaikan lewat perintah OPENTIME/CLOSETIME saat uji.
unsigned long openTimeMs  = 300;
unsigned long closeTimeMs = 300;

Servo doorServo;

// Kalibrasi dan batas berat — TETAP
const float CALIBRATION_FACTOR = 425.66f;
const float MIN_VALID_WEIGHT_G = 60.0f;
const float MAX_VALID_WEIGHT_G = 200.0f;
const float EMPTY_THRESHOLD_G  = 5.0f;
const float WEIGHT_TOLERANCE_G = 20.0f;

// Dipercepat: 4 sampel x 2 pembacaan (HX711 10 SPS) = sekitar 0,8 detik
// (sebelumnya 5 x 3 + jeda = sekitar 2 detik). Jika sering "berat belum stabil",
// naikkan WEIGHT_AVG_PER_SAMPLE ke 3 atau MAX_WEIGHT_SPREAD_G ke 5.
const int WEIGHT_SAMPLES = 4;
const int WEIGHT_AVG_PER_SAMPLE = 2;
const float MAX_WEIGHT_SPREAD_G = 4.0f;

const unsigned long RFID_COOLDOWN_MS = 3000;
const unsigned long HX711_TIMEOUT_MS = 3000;

// HANYA DUA UID YANG DIIZINKAN
const char* ALLOWED_UIDS[] = {
  "53EF2B0F760001",
  "0451F602594189"
};

const int ALLOWED_UID_COUNT =
  sizeof(ALLOWED_UIDS) / sizeof(ALLOWED_UIDS[0]);

// =====================================================
// 2. OBJEK DAN STATUS
// =====================================================

MFRC522 rfid(RFID_SS_PIN, RFID_RST_PIN);
HX711 scale;

String lastUID = "";
unsigned long lastRFIDTime = 0;
unsigned long lastWeightPrint = 0;

bool hx711Available = false;

// Isi respons terakhir dari server (dipakai untuk membaca keputusan transaksi)
String lastResponse = "";

// Poll ke server (juga berfungsi sebagai heartbeat) dan sambung ulang Wi-Fi.
// Saat idle cukup jarang; saat ada sesi web aktif atau pintu terbuka lebih sering.
const unsigned long HEARTBEAT_INTERVAL_MS  = 2000;   // poll saat idle (sebelumnya 10 detik)
const unsigned long POLL_FAST_INTERVAL_MS  = 700;    // poll saat sesi web aktif / pintu terbuka (sebelumnya 3 detik)
const unsigned long WIFI_RETRY_INTERVAL_MS = 10000;

unsigned long lastHeartbeat   = 0;   // waktu poll terakhir
unsigned long lastWifiAttempt = 0;
bool wifiWasConnected = false;

// Pintu (KEMBALIKAN dan PINJAM)
const unsigned long DOOR_CLOSE_DELAY_MS       = 800;    // jeda setelah bunyi, sebelum pintu menutup (sebelumnya 2 detik)
const unsigned long DOOR_CHECK_INTERVAL_MS    = 300;    // pemeriksaan sensor saat pintu terbuka (sebelumnya 1 detik)
const unsigned long EMPTY_CONFIRM_MS          = 1000;   // kembalikan gagal/batal: harus kosong & tanpa tag selama ini (sebelumnya 3 detik)
const unsigned long BLOCKED_ALERT_INTERVAL_MS = 10000;  // pengingat jika masih ada wadah/tag
const unsigned long REMOVAL_CONFIRM_MS        = 700;    // pinjam: kosong stabil selama ini = wadah diambil (sebelumnya 1,5 detik)
const unsigned long BORROW_REMOVAL_TIMEOUT_MS = 30000;  // pinjam: batas waktu mengambil wadah
const unsigned long FORCED_SCAN_INTERVAL_MS   = 300;    // baca tag di dalam stasiun saat ada transaksi (sebelumnya 1 detik)
const unsigned long BORROW_CHECK_INTERVAL_MS  = 200;    // pinjam: pemeriksaan timbangan saat menunggu wadah diambil (sebelumnya 500 ms)

// Mode pintu (int, bukan enum, agar aman dengan prototipe otomatis Arduino IDE)
const int DOOR_IDLE           = 0;   // pintu tertutup
const int DOOR_RETURN_OPEN    = 1;   // terbuka untuk transaksi kembalikan
const int DOOR_BORROW_REMOVAL = 2;   // terbuka, menunggu wadah pinjaman diambil
int doorMode = DOOR_IDLE;

bool sessionActive = false;          // ada sesi web aktif di stasiun ini (dari server)
bool commandPending = false;         // ada transaksi pending di server (dari poll)
String activeTxType = "";            // "borrow" / "return" / ""
String activeTxId   = "";            // id transaksi pending dari poll
String handledTxId  = "";            // transaksi yang sudah diputuskan server; jangan diproses lagi
String borrowUid    = "";            // UID wadah pinjaman yang lolos validasi
String flowTxId     = "";            // transaksi yang sedang dikerjakan stasiun (untuk laporan tahapan)
String flowTxType   = "";            // "borrow" / "return" untuk flowTxId

bool lastReportValidated = false;    // respons terakhir: peminjaman lolos validasi (belum selesai)
bool blockedReported = false;

unsigned long doorOpenedAt      = 0;
unsigned long emptySince        = 0;
unsigned long lastDoorCheck     = 0;
unsigned long lastBlockedAlert  = 0;
unsigned long lastForcedScan    = 0;
unsigned long lastUnknownTagMsg = 0;

// Koneksi HTTPS dipakai ulang (keep-alive). Jabat tangan TLS baru tiap permintaan
// memakan sekitar 0,5-1,5 detik di ESP32; dengan koneksi tetap, tiap event
// hanya sekitar 0,1-0,3 detik.
WiFiClientSecure secureClient;
bool secureClientReady = false;

// Tahapan proses yang dikirim ke server (event "station_stage") agar indikator
// di web mengikuti keadaan nyata di ESP32. Isi false untuk mematikannya.
const bool ENABLE_STAGE_EVENTS = true;
String lastStageKey = "";

// =====================================================
// 3. KIRIM EVENT KE SUPABASE
// =====================================================

bool sendEvent(
  const char* eventType,
  const String& uid,
  float weight,
  bool includeWeight,
  const String& eventData = ""
) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WiFi] Tidak terhubung.");
    return false;
  }

  if (!secureClientReady) {
    // Pengujian awal saja; verifikasi TLS diperlukan
    // sebelum perangkat dipakai di lingkungan produksi.
    secureClient.setInsecure();
    secureClientReady = true;
  }

  String body = "{\"event_type\":\"";
  body += eventType;
  body += "\"";

  // ID stasiun selalu disertakan
  body += ",\"station_id\":\"";
  body += STATION_ID;
  body += "\"";

  if (uid.length() > 0) {
    body += ",\"rfid_uid\":\"";
    body += uid;
    body += "\"";
  }

  if (includeWeight) {
    body += ",\"weight_grams\":";
    body += String(weight, 2);
  }

  if (eventData.length() > 0) {
    body += ",\"event_data\":";
    body += eventData;
  }

  body += "}";

  Serial.print("[Supabase] Event: ");
  Serial.println(eventType);

  unsigned long startedAt = millis();
  int statusCode = 0;
  String response = "";

  // Percobaan kedua hanya bila koneksi lama sudah ditutup server (gagal kirim,
  // sebelum server memproses apa pun), supaya event tidak terkirim ganda.
  for (int attempt = 0; attempt < 2; attempt++) {
    HTTPClient http;

    http.setReuse(true);
    http.setConnectTimeout(4000);
    http.setTimeout(6000);

    if (!http.begin(secureClient, SUPABASE_URL)) {
      Serial.println("[HTTP] Gagal memulai koneksi.");
      return false;
    }

    http.addHeader("Content-Type", "application/json");
    http.addHeader("x-device-token", DEVICE_TOKEN);

    statusCode = http.POST(body);
    response = (statusCode > 0) ? http.getString() : String("");

    http.end();

    bool staleConnection =
      statusCode == HTTPC_ERROR_CONNECTION_REFUSED ||
      statusCode == HTTPC_ERROR_SEND_HEADER_FAILED ||
      statusCode == HTTPC_ERROR_SEND_PAYLOAD_FAILED;

    if (statusCode > 0 || !staleConnection) {
      break;
    }

    secureClient.stop();   // buang koneksi lama; percobaan berikutnya membuat yang baru
  }

  if (statusCode <= 0) {
    secureClient.stop();
  }

  lastResponse = response;

  Serial.print("[Supabase] HTTP: ");
  Serial.print(statusCode);
  Serial.print(" (");
  Serial.print(millis() - startedAt);
  Serial.println(" ms)");

  if (response.length() > 0) {
    Serial.print("[Supabase] Respons: ");
    Serial.println(response);
  }

  return statusCode >= 200 && statusCode < 300;
}

// Mengirim tahapan proses transaksi ke server (tidak mengubah lastResponse).
// Dikirim sekali saja per transaksi + tahap, jadi aman dipanggil berulang.
// Server cukup menyimpan stage ini lalu web menampilkannya lewat Realtime.
//
// Tahap yang dipakai:
//   request_received : ESP32 menerima perintah transaksi dari poll
//   reading          : tag RFID terbaca, timbangan sedang membaca berat
//   door_open        : pintu sudah terbuka (pinjam: tunggu wadah diambil)
//   removed_detected : timbangan kosong stabil, wadah terbukti diambil
//   door_closing     : pintu akan menutup
//   unknown_tag      : ada tag di stasiun yang tidak terdaftar
void reportStage(const char* stage, const String& txId, const char* txType, const String& uid = "") {
  Serial.print("[TAHAP] ");
  Serial.print(txType);
  Serial.print(" -> ");
  Serial.println(stage);

  if (!ENABLE_STAGE_EVENTS) {
    return;
  }

  String key = txId + "|" + stage;

  if (key == lastStageKey) {
    return;
  }

  lastStageKey = key;

  String data = "{\"stage\":\"";
  data += stage;
  data += "\",\"tx_type\":\"";
  data += txType;
  data += "\",\"transaction_id\":\"";
  data += txId;
  data += "\",\"device_ms\":";
  data += String(millis());
  data += "}";

  String saved = lastResponse;
  sendEvent("station_stage", uid, 0, false, data);
  lastResponse = saved;
}

// =====================================================
// 3B. BUZZER DAN KEPUTUSAN SERVER
// =====================================================

void beep(unsigned int durationMs) {
  digitalWrite(BUZZER_PIN, HIGH);
  delay(durationMs);
  digitalWrite(BUZZER_PIN, LOW);
}

// Diterima: dua bunyi pendek
void beepSuccess() {
  beep(100);
  delay(100);
  beep(100);
}

// Ditolak: satu bunyi panjang
void beepError() {
  beep(400);
}

// =====================================================
// 3C. SERVO PINTU (HANYA PERINTAH SERIAL)
// =====================================================
// Servo TIDAK terhubung ke transaksi. Ia hanya bergerak jika Anda mengetik
// OPEN / CLOSE di Serial Monitor.
//
// Gerakan dibuat blocking (delay) dengan batas waktu keras. Alasannya: servo
// continuous berputar selama sinyal dikirim, dan loop() dapat tertahan beberapa
// detik oleh permintaan HTTPS. Jika berhenti diatur dari loop(), servo bisa
// berputar jauh lebih lama dari yang dimaksud.

void stopServo() {
  if (doorServo.attached()) {
    doorServo.write(SERVO_STOP_ANGLE);
    delay(30);
    doorServo.detach();
  }
}

void runServo(int directionAngle, unsigned long durationMs, const char* label) {
  if (durationMs > SERVO_MAX_RUN_MS) {
    durationMs = SERVO_MAX_RUN_MS;
  }

  Serial.print("[SERVO] ");
  Serial.print(label);
  Serial.print(" selama ");
  Serial.print(durationMs);
  Serial.println(" ms");

  doorServo.setPeriodHertz(50);

  if (!doorServo.attached()) {
    doorServo.attach(SERVO_PIN, SERVO_MIN_US, SERVO_MAX_US);
  }

  if (!doorServo.attached()) {
    Serial.println("[SERVO] Gagal menyalakan servo.");
    return;
  }

  doorServo.write(directionAngle);
  delay(durationMs);
  stopServo();

  Serial.println("[SERVO] Berhenti.");
}

void printServoHelp() {
  Serial.println("[SERVO] Perintah: OPEN, CLOSE, STOP, OPENTIME <ms>, CLOSETIME <ms>, HELP");
  Serial.print("[SERVO] OPENTIME = ");
  Serial.print(openTimeMs);
  Serial.print(" ms, CLOSETIME = ");
  Serial.print(closeTimeMs);
  Serial.print(" ms, batas maks = ");
  Serial.print(SERVO_MAX_RUN_MS);
  Serial.println(" ms");
}

void handleSerialCommands() {
  if (!Serial.available()) {
    return;
  }

  String command = Serial.readStringUntil('\n');
  command.trim();

  if (command.length() == 0) {
    return;
  }

  command.toUpperCase();

  String arg = "";
  int space = command.indexOf(' ');

  if (space > 0) {
    arg = command.substring(space + 1);
    arg.trim();
    command = command.substring(0, space);
  }

  if (command == "HELP") {
    printServoHelp();
  } else if (command == "OPEN") {
    runServo(SERVO_OPEN_ANGLE, openTimeMs, "BUKA");
  } else if (command == "CLOSE") {
    runServo(SERVO_CLOSE_ANGLE, closeTimeMs, "TUTUP");
  } else if (command == "STOP") {
    stopServo();
    Serial.println("[SERVO] Dihentikan.");
  } else if (command == "OPENTIME" || command == "CLOSETIME") {
    long ms = arg.toInt();

    if (ms < 50 || ms > (long)SERVO_MAX_RUN_MS) {
      Serial.print("[SERVO] Waktu harus bilangan bulat 50-");
      Serial.print(SERVO_MAX_RUN_MS);
      Serial.print(" ms. Diterima: '");
      Serial.print(arg);
      Serial.print("' (terbaca ");
      Serial.print(ms);
      Serial.println("). Contoh: OPENTIME 650");
    } else if (command == "OPENTIME") {
      openTimeMs = ms;
      Serial.print("[SERVO] OPENTIME = ");
      Serial.println(openTimeMs);
    } else {
      closeTimeMs = ms;
      Serial.print("[SERVO] CLOSETIME = ");
      Serial.println(closeTimeMs);
    }
  } else {
    Serial.println("[SERVO] Perintah tidak dikenal. Ketik HELP.");
  }
}

// Membaca bagian "report" dari respons server dan membunyikan buzzer.
// Hanya berbunyi jika ada transaksi yang diproses ("handled":true).
// Keputusan sukses/gagal dibuat server (device_report), bukan oleh ESP32.
//
// Mengembalikan: 1 = diterima, -1 = ditolak, 0 = tidak ada transaksi yang diproses.
int signalServerDecision() {
  lastReportValidated = false;

  int reportAt = lastResponse.indexOf("\"report\":");

  if (reportAt < 0) {
    return 0;
  }

  String report = lastResponse.substring(reportAt);

  if (report.indexOf("\"handled\":true") < 0) {
    Serial.println("[SERVER] Tidak ada transaksi yang menunggu.");
    return 0;
  }

  if (report.indexOf("\"ok\":true") >= 0) {
    lastReportValidated = report.indexOf("\"validated\":true") >= 0;

    if (lastReportValidated) {
      // Peminjaman lolos validasi, tetapi belum selesai: pinjaman dicatat setelah wadah diambil.
      Serial.println("[SERVER] Peminjaman LOLOS validasi. Menunggu wadah diambil.");
      beep(200);
    } else {
      Serial.println("[SERVER] Transaksi DITERIMA.");
      beepSuccess();
    }

    return 1;
  }

  String reason = "";
  int r = report.indexOf("\"reason\":\"");

  if (r >= 0) {
    int start = r + 10;
    int end = report.indexOf('"', start);

    if (end > start) {
      reason = report.substring(start, end);
    }
  }

  if (reason.length() == 0) {
    reason = "tidak diketahui";
  }

  Serial.print("[SERVER] Transaksi DITOLAK. Alasan: ");
  Serial.println(reason);
  beepError();
  return -1;
}

// =====================================================
// 3D. PINTU
// =====================================================
// Pintu hanya bergerak karena transaksi yang sah di server.
//
// KEMBALIKAN: pintu terbuka saat transaksi pending (lewat poll). Pintu ditutup
//   - segera setelah server MENERIMA pengembalian, atau
//   - jika transaksi gagal/dibatalkan, HANYA bila timbangan kosong dan tidak ada tag
//     di dekat pembaca. Jika masih ada beban/tag, pintu tetap terbuka dan stasiun mengingatkan.
// PINJAM: wadah dibaca di dalam stasiun (pintu tertutup). Jika server meloloskan
//   validasi, pintu terbuka, menunggu timbangan kosong (wadah diambil), lalu menutup.
//
// Sudut/waktu gerak (openTimeMs, closeTimeMs) masih nilai sementara sampai
// prototipe selesai dirakit.

// Tiga bunyi pendek: pengingat bahwa masih ada wadah/tag di dalam stasiun.
void beepBlocked() {
  for (int i = 0; i < 3; i++) {
    beep(80);
    delay(80);
  }
}

void openDoorFor(int mode) {
  if (mode == DOOR_RETURN_OPEN) {
    Serial.println("[PINTU] Transaksi KEMBALIKAN. Membuka pintu.");
  } else {
    Serial.println("[PINTU] Peminjaman lolos validasi. Membuka pintu.");
  }

  beep(80);
  runServo(
    SERVO_OPEN_ANGLE,
    openTimeMs,
    mode == DOOR_RETURN_OPEN ? "BUKA (kembalikan)" : "BUKA (pinjam)"
  );

  doorMode         = mode;
  doorOpenedAt     = millis();
  emptySince       = 0;
  blockedReported  = false;
  lastBlockedAlert = millis();

  // Pintu benar-benar sudah terbuka (servo selesai bergerak).
  if (flowTxId.length() > 0) {
    reportStage("door_open", flowTxId, mode == DOOR_RETURN_OPEN ? "return" : "borrow", borrowUid);
  }
}

void closeDoor(const char* reason) {
  Serial.print("[PINTU] Menutup pintu: ");
  Serial.println(reason);

  // Bunyi peringatan dan jeda agar tangan sempat menjauh dari pintu.
  if (flowTxId.length() > 0) {
    reportStage("door_closing", flowTxId, doorMode == DOOR_RETURN_OPEN ? "return" : "borrow");
  }

  beep(80);
  delay(DOOR_CLOSE_DELAY_MS);

  runServo(SERVO_CLOSE_ANGLE, closeTimeMs, "TUTUP");

  doorMode   = DOOR_IDLE;
  emptySince = 0;
  flowTxId   = "";
  flowTxType = "";

  // Pintu sudah tertutup: hapus banner "masih ada wadah" di web (jika pernah dikirim).
  if (blockedReported) {
    blockedReported = false;
    sendEvent("door_cleared", "", 0, false);
  }
}

// Membaca bagian "command" dari respons event "poll".
void handlePollResponse() {
  int at = lastResponse.indexOf("\"command\":");

  if (at < 0) {
    return;
  }

  String command = lastResponse.substring(at);

  sessionActive  = command.indexOf("\"session_active\":true") >= 0;
  commandPending = command.indexOf("\"has_command\":true") >= 0;

  activeTxType = "";

  if (commandPending) {
    if (command.indexOf("\"type\":\"return\"") >= 0) {
      activeTxType = "return";
    } else if (command.indexOf("\"type\":\"borrow\"") >= 0) {
      activeTxType = "borrow";
    }
  }

  // id transaksi (UUID 36 karakter) setelah "transaction_id":"
  activeTxId = "";
  int t = command.indexOf("\"transaction_id\":\"");

  if (t >= 0 && command.length() >= (unsigned int)(t + 18 + 36)) {
    activeTxId = command.substring(t + 18, t + 18 + 36);
  }

  // Beri tahu server/web bahwa stasiun benar-benar sudah menerima perintah.
  if (commandPending && activeTxId.length() > 0 && activeTxId != handledTxId && activeTxType.length() > 0) {
    flowTxId   = activeTxId;     // diingat sampai pintu menutup (poll berikutnya bisa mengosongkan activeTxId)
    flowTxType = activeTxType;
    reportStage("request_received", flowTxId, flowTxType.c_str());
  }

  // Transaksi kembalikan menunggu: buka pintu.
  // Peminjaman tidak membuka pintu di sini; pintu baru terbuka setelah validasi lolos.
  if (commandPending && activeTxType == "return" && doorMode == DOOR_IDLE) {
    openDoorFor(DOOR_RETURN_OPEN);
  }
}

// =====================================================
// 4. BACA DAN VALIDASI UID RFID
// =====================================================

String readRFID() {
  if (!rfid.PICC_IsNewCardPresent()) {
    return "";
  }

  if (!rfid.PICC_ReadCardSerial()) {
    return "";
  }

  String uid = "";

  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) {
      uid += "0";
    }

    uid += String(rfid.uid.uidByte[i], HEX);
  }

  uid.toUpperCase();

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();

  bool allZero = true;

  for (unsigned int i = 0; i < uid.length(); i++) {
    if (uid[i] != '0') {
      allZero = false;
      break;
    }
  }

  if (allZero || uid.length() == 0) {
    Serial.println("[RFID] UID tidak valid.");
    return "";
  }

  return uid;
}

bool isUIDAllowed(const String& uid) {
  for (int i = 0; i < ALLOWED_UID_COUNT; i++) {
    if (uid.equalsIgnoreCase(ALLOWED_UIDS[i])) {
      return true;
    }
  }

  return false;
}

// =====================================================
// 5. BACA BERAT STABIL
// =====================================================

bool waitForHX711(unsigned long timeoutMs) {
  unsigned long start = millis();

  while (!scale.is_ready() &&
         millis() - start < timeoutMs) {
    delay(20);
  }

  return scale.is_ready();
}

bool readStableWeight(float& result) {
  if (!hx711Available) {
    Serial.println("[HX711] Sensor belum siap.");
    return false;
  }

  float samples[WEIGHT_SAMPLES];

  for (int i = 0; i < WEIGHT_SAMPLES; i++) {
    if (!waitForHX711(HX711_TIMEOUT_MS)) {
      Serial.println("[HX711] Timeout.");
      return false;
    }

    samples[i] = scale.get_units(WEIGHT_AVG_PER_SAMPLE);

    if (!isfinite(samples[i])) {
      Serial.println("[HX711] Pembacaan tidak valid.");
      return false;
    }
  }

  float minimum = samples[0];
  float maximum = samples[0];
  float total = 0.0f;

  for (int i = 0; i < WEIGHT_SAMPLES; i++) {
    if (samples[i] < minimum) minimum = samples[i];
    if (samples[i] > maximum) maximum = samples[i];

    total += samples[i];
  }

  float spread = maximum - minimum;

  Serial.print("[HX711] Selisih sampel: ");
  Serial.print(spread, 2);
  Serial.println(" gram");

  if (spread > MAX_WEIGHT_SPREAD_G) {
    Serial.println("[HX711] Berat belum stabil.");
    return false;
  }

  result = total / WEIGHT_SAMPLES;

  if (fabs(result) <= EMPTY_THRESHOLD_G) {
    result = 0.0f;
  }

  return true;
}

bool isWeightInRange(float weight) {
  return weight >= MIN_VALID_WEIGHT_G &&
         weight <= MAX_VALID_WEIGHT_G;
}

// =====================================================
// 6. PROSES UID YANG DIIZINKAN
// =====================================================

void processTag(const String& uid) {
  Serial.println();
  Serial.println("========== SMART-LOOPBOX ==========");

  Serial.print("[RFID] UID diizinkan: ");
  Serial.println(uid);

  // Tag terbaca: laporkan tahap "reading" (sekali per transaksi) lalu timbang.
  if (flowTxId.length() == 0 && activeTxId.length() > 0) {
    flowTxId   = activeTxId;
    flowTxType = activeTxType;
  }

  if (flowTxId.length() > 0) {
    reportStage("reading", flowTxId, flowTxType.c_str(), uid);
  }

  // Baca berat dahulu.
  // Belum mengirim event apa pun jika pembacaan gagal.
  float weight = 0.0f;

  if (!readStableWeight(weight)) {
    Serial.println(
      "[HASIL] Tidak ada event dikirim: berat gagal/stabil."
    );

    Serial.println("===================================");
    return;
  }

  bool weightValid = isWeightInRange(weight);

  Serial.print("[BERAT] ");
  Serial.print(weight, 2);
  Serial.println(" gram");

  Serial.print("[BERAT] ");
  Serial.println(
    weightValid ? "DALAM RENTANG" : "DI LUAR RENTANG"
  );

  Serial.print("[HASIL] ");
  Serial.println(
    weightValid ? "LOLOS VALIDASI" : "DITOLAK"
  );

  String eventData = "{\"uid_known\":true";
  eventData += ",\"weight_valid\":";
  eventData += weightValid ? "true" : "false";
  eventData += ",\"validation_result\":\"";
  eventData += weightValid ? "accepted" : "rejected";
  eventData += "\"";

  if (flowTxId.length() > 0) {
    eventData += ",\"transaction_id\":\"";
    eventData += flowTxId;
    eventData += "\",\"tx_type\":\"";
    eventData += flowTxType;
    eventData += "\"";
  }

  eventData += "}";

  // Satu event berisi UID + berat + hasil validasi.
  // Menghindari event rfid_detected terpisah yang
  // sebelumnya membuat baris dengan berat NULL.
  bool sent = sendEvent(
    "weight_read",
    uid,
    weight,
    true,
    eventData
  );

  if (sent) {
    Serial.println("[Supabase] Data berhasil dikirim.");

    int decision = signalServerDecision();

    if (decision != 0) {
      // Server sudah memutuskan transaksi ini; jangan diproses lagi.
      commandPending = false;
      handledTxId = activeTxId;
    }

    if (decision > 0 && lastReportValidated) {
      // PINJAM lolos validasi: buka pintu dan tunggu wadah diambil.
      if (doorMode == DOOR_IDLE) {
        borrowUid = uid;
        openDoorFor(DOOR_BORROW_REMOVAL);
      }
    } else if (decision > 0 && doorMode == DOOR_RETURN_OPEN) {
      // KEMBALIKAN diterima: wadah benar, pintu ditutup.
      closeDoor("pengembalian diterima");
    } else if (decision < 0 && doorMode == DOOR_RETURN_OPEN) {
      // KEMBALIKAN ditolak: pintu TETAP terbuka sampai wadah dikeluarkan atau diletakkan dengan benar.
      Serial.println("[PINTU] Pengembalian ditolak. Pintu TETAP TERBUKA.");
      Serial.println("[PINTU] Keluarkan wadah dari stasiun, atau letakkan wadah yang benar lalu coba lagi dari web.");
    }
  } else {
    Serial.println("[Supabase] Pengiriman gagal.");
  }

  Serial.println("===================================");
}

// =====================================================
// 6B. SENSOR PINTU, PEMELIHARAAN PINTU, WI-FI, POLL
// =====================================================

// true hanya jika timbangan terbaca dan kosong.
// Sensor tidak siap dianggap TIDAK kosong, supaya pintu tidak menutup karena sensor mati.
bool platformEmpty() {
  if (!hx711Available || !scale.is_ready()) {
    return false;
  }

  float w = scale.get_units(2);

  if (!isfinite(w)) {
    return false;
  }

  return fabs(w) <= EMPTY_THRESHOLD_G;
}

// true jika ada tag di dekat pembaca, termasuk tag yang sudah dibaca/di-halt sebelumnya.
bool tagPresent() {
  byte atqa[2];
  byte atqaSize = sizeof(atqa);

  MFRC522::StatusCode status = rfid.PICC_WakeupA(atqa, &atqaSize);

  if (status == MFRC522::STATUS_OK || status == MFRC522::STATUS_COLLISION) {
    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
    return true;
  }

  return false;
}

// Membaca UID tag yang sedang berada di dalam stasiun, termasuk tag yang sudah
// di-halt (readRFID() hanya melihat tag baru). Dipakai saat ada transaksi pending.
String readUidForced() {
  byte atqa[2];
  byte atqaSize = sizeof(atqa);

  MFRC522::StatusCode status = rfid.PICC_WakeupA(atqa, &atqaSize);

  if (status != MFRC522::STATUS_OK) {
    return "";
  }

  if (!rfid.PICC_ReadCardSerial()) {
    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
    return "";
  }

  String uid = "";

  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) {
      uid += "0";
    }

    uid += String(rfid.uid.uidByte[i], HEX);
  }

  uid.toUpperCase();

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();

  return uid;
}

// Dipanggil terus-menerus dari loop(): menutup pintu hanya bila aman.
void maintainDoor() {
  if (doorMode == DOOR_IDLE) {
    return;
  }

  unsigned long now = millis();

  // ---------- KEMBALIKAN ----------
  if (doorMode == DOOR_RETURN_OPEN) {
    // Masih menunggu wadah untuk transaksi kembalikan: pintu tetap terbuka.
    if (commandPending && activeTxType == "return") {
      emptySince = 0;
      return;
    }

    if (now - lastDoorCheck < DOOR_CHECK_INTERVAL_MS) {
      return;
    }

    lastDoorCheck = now;

    // Transaksi sudah gagal/dibatalkan. Tutup HANYA jika tidak ada beban dan tidak ada tag.
    bool empty = platformEmpty();
    bool tag   = tagPresent();

    if (empty && !tag) {
      if (emptySince == 0) {
        emptySince = now;
      } else if (now - emptySince >= EMPTY_CONFIRM_MS) {
        closeDoor("tidak ada wadah/tag; transaksi selesai atau dibatalkan");
      }

      return;
    }

    emptySince = 0;

    // Deteksi pertama: peringatan langsung (bunyi + banner di web).
    // Selanjutnya: bunyi pengingat tiap BLOCKED_ALERT_INTERVAL_MS.
    if (!blockedReported || now - lastBlockedAlert >= BLOCKED_ALERT_INTERVAL_MS) {
      lastBlockedAlert = now;

      Serial.println("[PINTU] Masih ada wadah/tag terdeteksi. Pintu TETAP TERBUKA.");
      Serial.println("[PINTU] Segera keluarkan wadah, atau coba lagi dari web.");
      beepBlocked();

      if (!blockedReported) {
        blockedReported = true;
        sendEvent("door_blocked", "", 0, false);   // server menampilkan banner di web
      }
    }

    return;
  }

  // ---------- PINJAM: tunggu wadah diambil ----------
  if (now - doorOpenedAt >= BORROW_REMOVAL_TIMEOUT_MS) {
    Serial.println("[PINTU] Wadah tidak diambil dalam batas waktu. Peminjaman digagalkan.");

    if (sendEvent("removal_timeout", borrowUid, 0, false)) {
      signalServerDecision();
    }

    closeDoor("wadah tidak diambil");
    return;
  }

  if (now - lastDoorCheck < BORROW_CHECK_INTERVAL_MS) {
    return;
  }

  lastDoorCheck = now;

  if (!platformEmpty()) {
    emptySince = 0;
    return;
  }

  if (emptySince == 0) {
    emptySince = now;
    return;
  }

  if (now - emptySince < REMOVAL_CONFIRM_MS) {
    return;
  }

  // Timbangan kosong stabil: wadah terbukti diambil. Server mencatat pinjaman.
  Serial.println("[PINTU] Wadah terdeteksi sudah diambil. Mengonfirmasi ke server.");

  if (flowTxId.length() > 0) {
    reportStage("removed_detected", flowTxId, "borrow", borrowUid);
  }

  if (!sendEvent("container_removed", borrowUid, 0.0f, true)) {
    Serial.println("[PINTU] Konfirmasi belum terkirim. Mencoba lagi.");
    return;
  }

  signalServerDecision();
  closeDoor("peminjaman selesai");
}

// Saat ada transaksi pending, baca tag di dalam stasiun secara aktif.
// KEMBALIKAN: pintu sudah terbuka. PINJAM: pintu masih tertutup (wadah ada di dalam).
void handleForcedScan() {
  if (!commandPending || activeTxId.length() == 0 || activeTxId == handledTxId) {
    return;
  }

  bool borrowScan = (activeTxType == "borrow" && doorMode == DOOR_IDLE);
  bool returnScan = (activeTxType == "return" && doorMode == DOOR_RETURN_OPEN);

  if (!borrowScan && !returnScan) {
    return;
  }

  unsigned long now = millis();

  if (now - lastForcedScan < FORCED_SCAN_INTERVAL_MS) {
    return;
  }

  lastForcedScan = now;

  String uid = readUidForced();

  if (uid.length() == 0) {
    return;
  }

  if (!isUIDAllowed(uid)) {
    if (now - lastUnknownTagMsg >= 5000) {
      lastUnknownTagMsg = now;
      Serial.print("[RFID] UID tidak diizinkan: ");
      Serial.println(uid);
      reportStage("unknown_tag", activeTxId, activeTxType.c_str(), uid);
    }

    return;
  }

  processTag(uid);
}

void maintainConnection() {
  unsigned long now = millis();

  if (WiFi.status() != WL_CONNECTED) {
    if (wifiWasConnected) {
      Serial.println("[WiFi] Terputus.");
      wifiWasConnected = false;
    }

    if (now - lastWifiAttempt >= WIFI_RETRY_INTERVAL_MS) {
      lastWifiAttempt = now;
      Serial.println("[WiFi] Mencoba menyambung ulang...");

      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    }

    return;
  }

  if (!wifiWasConnected) {
    wifiWasConnected = true;

    Serial.print("[WiFi] Tersambung. IP: ");
    Serial.println(WiFi.localIP());

    // Kirim heartbeat segera setelah tersambung.
    lastHeartbeat = now - HEARTBEAT_INTERVAL_MS;
  }

  // Poll lebih sering saat ada sesi web aktif atau pintu sedang terbuka.
  unsigned long interval =
    (sessionActive || doorMode != DOOR_IDLE) ? POLL_FAST_INTERVAL_MS : HEARTBEAT_INTERVAL_MS;

  if (now - lastHeartbeat >= interval) {
    lastHeartbeat = now;

    if (sendEvent("poll", "", 0, false)) {
      handlePollResponse();
    }
  }
}

// =====================================================
// 7. SETUP
// =====================================================

void setup() {
  // Buzzer dipastikan mati sejak awal
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  Serial.begin(115200);
  Serial.setTimeout(50);
  delay(1000);

  // Timer PWM untuk library ESP32Servo. Servo tidak dinyalakan di sini.
  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  ESP32PWM::allocateTimer(3);

  Serial.println();
  Serial.println("===================================");
  Serial.println(" SMART-LOOPBOX");
  Serial.println(" RFID + HX711 + SUPABASE");
  Serial.println(" SERVO: HANYA PERINTAH SERIAL");
  Serial.println("===================================");

  // RFID
  SPI.begin(
    RFID_SCK_PIN,
    RFID_MISO_PIN,
    RFID_MOSI_PIN,
    RFID_SS_PIN
  );

  rfid.PCD_Init();
  delay(100);

  byte version = rfid.PCD_ReadRegister(
    MFRC522::VersionReg
  );

  Serial.print("[RFID] Versi chip: 0x");
  Serial.println(version, HEX);

  if (version == 0x00 || version == 0xFF) {
    Serial.println("[PERINGATAN] RC522 tidak merespons.");
  } else {
    Serial.println("[RFID] RC522 terdeteksi.");
  }

  // HX711
  scale.begin(HX711_DOUT_PIN, HX711_SCK_PIN);
  scale.set_scale(CALIBRATION_FACTOR);

  Serial.println("[HX711] Menunggu sensor...");

  if (waitForHX711(5000)) {
    Serial.println("[HX711] Siap.");
    Serial.println("Kosongkan platform sebelum tare.");

    delay(1000);
    scale.tare(15);

    hx711Available = true;
    Serial.println("[HX711] Tare selesai.");
  } else {
    hx711Available = false;
    Serial.println("[PERINGATAN] HX711 tidak terdeteksi.");
  }

  // Wi-Fi
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("[WiFi] Menghubungkan");

  unsigned long wifiStart = millis();

  while (WiFi.status() != WL_CONNECTED &&
         millis() - wifiStart < 15000) {
    delay(500);
    Serial.print(".");
  }

  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("[WiFi] Terhubung. IP: ");
    Serial.println(WiFi.localIP());

    // Event status perangkat tetap dipertahankan.
    sendEvent("device_online", "", 0, false);

    wifiWasConnected = true;
    lastHeartbeat = millis();
  } else {
    Serial.println("[WiFi] Belum terhubung.");
  }

  Serial.println("[SISTEM] Siap memindai RFID.");
}

// =====================================================
// 8. LOOP
// =====================================================

void loop() {
  // Sambung ulang Wi-Fi bila putus dan kirim heartbeat berkala
  maintainConnection();

  // Perintah servo manual dari Serial Monitor (uji gerak)
  handleSerialCommands();

  // Pintu: tutup hanya bila aman; baca tag di dalam stasiun saat ada transaksi
  maintainDoor();
  handleForcedScan();

  // Pemulihan HX711
  if (!hx711Available && scale.is_ready()) {
    Serial.println("[HX711] Sensor kembali siap.");
    Serial.println("Pastikan platform kosong sebelum tare.");

    delay(1000);

    scale.set_scale(CALIBRATION_FACTOR);
    scale.tare(15);

    hx711Available = true;
    Serial.println("[HX711] Tare selesai.");
  }

  // Pantau berat di Serial Monitor saja.
  // Pembacaan rutin ini tidak dikirim ke Supabase.
  // Dilewati saat ada transaksi/pintu terbuka agar loop tetap responsif.
  if (millis() - lastWeightPrint >= 1000 && !commandPending && doorMode == DOOR_IDLE) {
    lastWeightPrint = millis();

    if (hx711Available && scale.is_ready()) {
      float weight = scale.get_units(1);

      if (isfinite(weight)) {
        if (fabs(weight) <= EMPTY_THRESHOLD_G) {
          weight = 0.0f;
        }

        Serial.print("[MONITOR BERAT] ");
        Serial.print(weight, 2);
        Serial.println(" gram");
      }
    }
  }

  // Baca RFID
  String uid = readRFID();

  if (uid.length() == 0) {
    delay(20);
    return;
  }

  unsigned long now = millis();

  // Cooldown untuk UID yang sama
  if (uid == lastUID &&
      now - lastRFIDTime < RFID_COOLDOWN_MS) {
    return;
  }

  lastUID = uid;
  lastRFIDTime = now;

  // Tolak UID yang tidak terdaftar sebelum membaca berat
  // dan sebelum mengirim event apa pun.
  if (!isUIDAllowed(uid)) {
    Serial.print("[RFID] UID tidak diizinkan: ");
    Serial.println(uid);
    Serial.println("[RFID] Diabaikan; tidak dikirim ke Supabase.");

    delay(20);
    return;
  }

  processTag(uid);

  delay(20);
}
