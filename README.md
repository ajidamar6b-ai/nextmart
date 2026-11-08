# NEXTMART — deployment starter

Paket awal website + backend Node.js/Express + PostgreSQL untuk uji **IAK Sandbox**.

## Isi
- `public/`: halaman website NEXTMART
- `src/server.js`: API backend dan callback
- `src/iak.js`: klien IAK
- `db/schema.sql`: tabel produk dan pesanan
- `render.yaml`: konfigurasi Render Blueprint

## Deploy
1. Ekstrak ZIP ini.
2. Upload **isi folder** ke root repository GitHub bernama `nextmart` (bukan ZIP-nya).
3. Di Render pilih **New → Blueprint**, hubungkan repository, lalu deploy.
4. Setelah service dibuat, tambahkan `IAK_USERNAME` dan `IAK_API_KEY` pengganti Sandbox pada Environment Render. Jangan taruh rahasia di GitHub atau chat.
5. Atur callback IAK ke `https://NAMA-SERVICE.onrender.com/api/iak/callback`.
6. Simpan `ADMIN_API_TOKEN` dari Environment Render. Gunakan token itu untuk memanggil `POST /api/admin/iak/sync-products` dengan header `Authorization: Bearer TOKEN`.
7. Biarkan `IAK_ORDERS_ENABLED=false` sampai kredensial, katalog, dan callback diuji.

## Penting
- Ini starter/preview, belum sistem produksi.
- Harga jual saat sinkronisasi awal sama dengan harga supplier; tetapkan margin sebelum menjual.
- Belum ada payment gateway, login pelanggan, panel admin, atau refund otomatis.
- Jangan aktifkan pesanan sebelum pengujian Sandbox berhasil.
- Database Render gratis hanya untuk uji coba dan dapat memiliki batas masa simpan; jangan simpan transaksi pelanggan sungguhan di paket gratis.
