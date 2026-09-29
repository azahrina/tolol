#!/bin/bash

echo "🚀 Menyiapkan Server Bot untuk Termux..."

# 1. Pastikan Izin Penyimpanan Aktif (Agar bisa baca /sdcard/Download/bot_data)
if [ ! -d "$HOME/storage" ]; then
    echo "📱 Meminta izin penyimpanan HP (Klik Izinkan di layar)..."
    termux-setup-storage
fi

# 2. Hapus folder extension otomatis agar tidak memenuhi memori Termux
if [ -d "ig" ]; then
    echo "🧹 Membersihkan folder extension di Termux..."
    rm -rf ig
fi
if [ -d "../ig" ]; then
    rm -rf ../ig
fi

# 3. Pastikan Paket Utama Terpasang
echo "📦 Memeriksa dependensi sistem (Node.js & FFmpeg)..."
pkg update -y
pkg install -y nodejs-lts ffmpeg git

# 3. Jalankan Server
echo "🚀 Menjalankan server..."
node server.js
