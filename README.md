# 🚀 Ninja Bot Server Engine

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-v18+-green.svg" alt="Node.js" />
  <img src="https://img.shields.io/badge/Platform-Android%20Termux%20%7C%20Windows%20%7C%20Linux-blue.svg" alt="Platform" />
  <img src="https://img.shields.io/badge/Architecture-Pure%20JavaScript-orange.svg" alt="Architecture" />
  <img src="https://img.shields.io/badge/License-MIT-purple.svg" alt="License" />
</p>

Backend server engine cerdas dan ringan untuk otomasi Instagram via browser extension (Chrome / Kiwi Browser / Lemur Browser). Dirancang khusus agar dapat berjalan lancar di **Android (Termux)** maupun **PC (Windows/Linux)** dengan pemisahan cerdas antara kode aplikasi dan data media Anda.

---

## ✨ Fitur Unggulan

- ⚡ **Auto-Installer Cerdas**: Tidak perlu repot `npm install` manual. Server otomatis mengunduh dependensi saat pertama kali dijalankan.
- 📱 **Integrasi Penyimpanan Internal HP**: Foto, video, caption, dan font disimpan terpisah di memori HP (`Download/bot_data`), sehingga data Anda **tidak akan hilang saat update script**.
- 🛠️ **Zero-Config Native Termux**: Otomatis mendeteksi lingkungan Android dan memanfaatkan binary `ffmpeg` bawaan sistem tanpa memerlukan emulator atau root.
- 🔄 **Update 1-Detik**: Cukup ketik `git pull` di Termux untuk mendapatkan pembaruan tanpa mengganggu koleksi media dan caption Anda.
- 🌐 **Dukungan Kiwi & Lemur Browser**: Bekerja langsung di localhost (`http://127.0.0.1:7500`) pada perangkat Android yang sama.

---

## 📥 Panduan Instalasi di Termux (Android)

### 1. Izin Akses Penyimpanan
Buka **Termux**, lalu beri izin akses penyimpanan internal HP Anda:
```bash
termux-setup-storage
```
> *Pilih **Izinkan (Allow)** pada jendela pop-up di layar HP Anda.*

### 2. Pasang Paket Dasar
```bash
pkg update -y && pkg install git nodejs-lts ffmpeg -y
```

### 3. Unduh & Jalankan Server
```bash
git clone https://github.com/azahrina/bot.git
cd bot
node server
```
> *Pada kali pertama dijalankan, server akan memasang library secara otomatis dalam beberapa saat, lalu server langsung aktif di port `7500`.*

---

## 💻 Panduan Menjalankan di PC (Windows / Linux)

1. Pastikan **Node.js** sudah terpasang di PC Anda.
2. Buka Terminal / Command Prompt di folder server:
```bash
npm install
node server.js
```

---

## 📂 Cara Mengisi Media & Mengedit Caption di HP

Saat server dijalankan di Termux, folder data otomatis dibuat di penyimpanan internal HP Anda:
📍 **`Penyimpanan Internal/Download/bot_data/`**

Anda dapat mengelola file langsung menggunakan aplikasi **File Saya / File Manager** bawaan HP:

| Folder / File | Deskripsi |
| :--- | :--- |
| `media/feed/` | Letakkan foto / video untuk fitur **Bulk Post Feed**. |
| `setup/caption/` | File teks caption (contoh: `caption.txt`). Mendukung format **Spintax** `{opsi1\|opsi2}`. |
| `setup/sticker/` | Teks stiker untuk fitur Story link (`sticker.txt`). |
| `setup/highlights/` | Nama sorotan story Instagram (`sorotan.txt`). |
| `setup/bio/` | Kumpulan teks bio profil akun (`bio.txt`). |
| `setup/comment/` | Template komentar untuk auto-comment (`comment.txt`). |
| `dm/` | Template pesan teks untuk fitur DM massal (`dm.txt`). |
| `fonts/` | File font kustom (`.ttf`) untuk stiker Story. |
| `shortlink_urls.json`| Konfigurasi preset tautan tujuan (ClickDealer, Imo, Trafee). |

> 💡 **Keuntungan**: Anda dapat menambah ratusan foto atau mengubah teks caption kapan saja tanpa perlu membuka Termux. Perubahan langsung terbaca secara *real-time*.

---

## 🔄 Cara Memperbarui Kode (Update Script)

Jika ada perbaikan atau fitur baru dari PC yang di-push ke GitHub, Anda cukup memperbaruinya di Termux dengan:

```bash
cd ~/bot
git pull
node server
```

Data foto, video, dan caption Anda di folder `Download/bot_data` **dijamin 100% aman dan tidak akan tertimpa/hilang**.

---

## 🌐 Koneksi ke Extension Browser di HP

1. Pastikan server di Termux berjalan (`node server`).
2. Buka **Kiwi Browser** atau **Lemur Browser** di HP Anda.
3. Buka situs [Instagram](https://www.instagram.com/) dan buka panel extension.
4. Panel akan otomatis terhubung ke `http://127.0.0.1:7500` dengan status **Online**.

---

## 📜 Lisensi
Didistribusikan di bawah lisensi MIT. Bebas digunakan dan dikembangkan untuk kebutuhan pribadi maupun tim.
