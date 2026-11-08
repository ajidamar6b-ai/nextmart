import express from "express";
import pg from "pg";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { getPriceList, submitTopup } from "./iak.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes("render.com") ? { rejectUnauthorized: false } : undefined })
  : null;

async function initDb() {
  if (!pool) return;
  const schema = await fs.readFile(path.join(__dirname, "../db/schema.sql"), "utf8");
  await pool.query(schema);
}
const adminOnly = (req, res, next) => {
  if (!process.env.ADMIN_API_TOKEN || req.headers.authorization !== `Bearer ${process.env.ADMIN_API_TOKEN}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

app.get("/api/health", async (_req, res) => {
  try { if (pool) await pool.query("SELECT 1"); res.json({ ok: true, database: !!pool, mode: process.env.IAK_ENV || "sandbox" }); }
  catch { res.status(500).json({ ok: false }); }
});

app.get("/api/products", async (_req, res) => {
  if (!pool) return res.json([]);
  const { rows } = await pool.query("SELECT product_code, product_description, product_nominal, selling_price, category FROM products WHERE active=true ORDER BY category, selling_price LIMIT 300");
  res.json(rows);
});

app.post("/api/admin/iak/sync-products", adminOnly, async (_req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "Database belum tersedia." });
    const data = await getPriceList();
    const list = data.pricelist || data.data?.pricelist || [];
    for (const p of list) {
      await pool.query(
        `INSERT INTO products(product_code,product_description,product_nominal,product_price,selling_price,category,active,updated_at)
         VALUES($1,$2,$3,$4,$4,$5,$6,NOW())
         ON CONFLICT(product_code) DO UPDATE SET product_description=EXCLUDED.product_description,
         product_nominal=EXCLUDED.product_nominal, product_price=EXCLUDED.product_price,
         category=EXCLUDED.category, active=EXCLUDED.active, updated_at=NOW()`,
        [p.product_code, p.product_description || p.product_code, p.product_nominal || "", Number(p.product_price || 0), p.product_category || "", String(p.status).toLowerCase() === "active"]
      );
    }
    res.json({ synced: list.length, note: "Harga jual awal sama dengan harga supplier; atur margin sebelum menerima pesanan." });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.post("/api/orders", async (req, res) => {
  if (process.env.IAK_ORDERS_ENABLED !== "true") return res.status(503).json({ error: "Pemesanan Sandbox belum diaktifkan. Tunggu pengujian kredensial dan callback." });
  if (!pool) return res.status(503).json({ error: "Database belum tersedia." });
  const { product_code, customer_id } = req.body || {};
  if (!product_code || !customer_id) return res.status(400).json({ error: "product_code dan customer_id wajib diisi." });
  const ref_id = `NM${Date.now()}${crypto.randomBytes(3).toString("hex")}`;
  const { rows } = await pool.query("SELECT product_price FROM products WHERE product_code=$1 AND active=true", [product_code]);
  if (!rows.length) return res.status(404).json({ error: "Produk tidak ditemukan." });
  await pool.query("INSERT INTO orders(ref_id,product_code,customer_id,status,provider_price) VALUES($1,$2,$3,'PENDING',$4)", [ref_id, product_code, customer_id, rows[0].product_price]);
  try {
    const result = await submitTopup({ ref_id, customer_id, product_code });
    res.status(202).json({ ref_id, status: result.data?.status || result.status || "PROCESSING", message: "Pesanan dikirim ke IAK Sandbox." });
  } catch (e) {
    await pool.query("UPDATE orders SET status='REVIEW',message=$2,updated_at=NOW() WHERE ref_id=$1", [ref_id, e.message]);
    res.status(202).json({ ref_id, status: "REVIEW", message: "Periksa status sebelum mencoba ulang." });
  }
});

app.get("/api/orders/:ref_id", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database belum tersedia." });
  const { rows } = await pool.query("SELECT ref_id, product_code, customer_id, status, message, created_at, updated_at FROM orders WHERE ref_id=$1", [req.params.ref_id]);
  if (!rows.length) return res.status(404).json({ error: "Transaksi tidak ditemukan." });
  res.json(rows[0]);
});

app.post("/api/iak/callback", async (req, res) => {
  try {
    const { ref_id, status, message, sign } = req.body || {};
    const expected = crypto.createHash("md5").update((process.env.IAK_USERNAME || "") + (process.env.IAK_API_KEY || "") + (ref_id || "")).digest("hex");
    if (!ref_id || !sign || sign !== expected) return res.status(401).json({ error: "Invalid callback signature." });
    if (pool) await pool.query("UPDATE orders SET status=$2,message=$3,updated_at=NOW() WHERE ref_id=$1", [ref_id, String(status || "UNKNOWN").toUpperCase(), message || null]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "Callback processing failed." }); }
});

const port = process.env.PORT || 3000;
initDb().then(() => app.listen(port, () => console.log(`NEXTMART listening on ${port}`)))
  .catch((e) => { console.error("Database initialization failed:", e); process.exit(1); });
