
import express from "express";
import pg from "pg";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({
  verify(req, res, buffer) {
    req.rawBody = Buffer.from(buffer);
  }
}));

app.use(express.static(path.join(__dirname, "../public")));

const BASE_URL = "https://api.melostore.id/api/v1/h2h";

const pool = process.env.DATABASE_URL
  ? new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("render.com")
        ? { rejectUnauthorized: false }
        : undefined
    })
  : null;

async function meloRequest(endpoint, options = {}) {
  const { MELO_API_KEY, MELO_SECRET_KEY } = process.env;

  if (!MELO_API_KEY || !MELO_SECRET_KEY) {
    throw new Error("Kredensial Melo belum diatur di Render.");
  }

  const response = await fetch(`${BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-API-Key": MELO_API_KEY,
      "X-Secret-Key": MELO_SECRET_KEY,
      ...(options.headers || {})
    }
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      result.message || result.error || `Melo API HTTP ${response.status}`
    );
  }

  return result;
}

async function initDb() {
  if (!pool) return;

  // Menyesuaikan tabel produk lama tanpa menghapus datanya.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      product_code VARCHAR(100) UNIQUE NOT NULL,
      product_name VARCHAR(255) NOT NULL,
      category VARCHAR(100),
      price BIGINT NOT NULL DEFAULT 0,
      status VARCHAR(30) DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      buyer_trx_id VARCHAR(64) UNIQUE NOT NULL,
      melo_transaction_id VARCHAR(100),
      sku_code VARCHAR(100) NOT NULL,
      customer_target VARCHAR(255) NOT NULL,
      customer_target_zone VARCHAR(100),
      price BIGINT DEFAULT 0,
      status VARCHAR(30) DEFAULT 'processing',
      serial_number TEXT,
      message TEXT,
      is_sandbox BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS orders_melo_id_idx
      ON orders(melo_transaction_id);
  `);
}

const adminOnly = (req, res, next) => {
  const token = process.env.ADMIN_API_TOKEN;

  if (!token || req.headers.authorization !== `Bearer ${token}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
};

// Pemeriksaan koneksi Melo.
app.get("/api/health", async (_req, res) => {
  try {
    const profile = await meloRequest("/profile");
    if (pool) await pool.query("SELECT 1");

    res.json({
      ok: true,
      supplier: "Melo H2H",
      mode: "sandbox",
      database: !!pool,
      melo_connected: profile.success !== false
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error.message
    });
  }
});

// Ambil katalog reguler Melo, termasuk halaman berikutnya.
async function getMeloPriceList() {
  let cursor = "";
  let allProducts = [];
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({ limit: "500" });
    if (cursor) params.set("cursor", cursor);

    const result = await meloRequest(`/pricelists?${params.toString()}`);
    const products = Array.isArray(result.data) ? result.data : [];

    allProducts.push(...products);

    const pagination = result.meta?.pagination || {};
    hasMore = pagination.has_more === true;
    cursor = pagination.next_cursor || "";

    if (hasMore && !cursor) {
      throw new Error("Cursor katalog Melo tidak tersedia.");
    }
  }

  return allProducts;
}

// Sinkronisasi katalog ke database.
app.post("/api/admin/melo/sync-products", adminOnly, async (_req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({ error: "Database belum tersedia." });
    }

    const products = await getMeloPriceList();
    let synced = 0;

    for (const product of products) {
      if (!product.sku_code) continue;

      await pool.query(
        `INSERT INTO products
          (product_code, product_name, category, price, status, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (product_code) DO UPDATE SET
           product_name = EXCLUDED.product_name,
           category = EXCLUDED.category,
           price = EXCLUDED.price,
           status = EXCLUDED.status,
           updated_at = NOW()`,
        [
          product.sku_code,
          product.name || product.sku_code,
          product.category_name || "",
          Number(product.price || 0),
          String(product.status || "").toLowerCase()
        ]
      );

      synced++;
    }

    res.json({
      ok: true,
      synced,
      note: "Katalog Melo berhasil disinkronkan."
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

// Daftar produk aktif.
app.get("/api/products", async (_req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({ error: "Database belum tersedia." });
    }

    const { rows } = await pool.query(
      `SELECT product_code AS sku_code,
              product_name AS name,
              category,
              price,
              status
       FROM products
       WHERE LOWER(status) = 'active'
       ORDER BY category, price
       LIMIT 1000`
    );

    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Buat pesanan Sandbox.
app.post("/api/orders", async (req, res) => {
  if (process.env.MELO_ORDERS_ENABLED !== "true") {
    return res.status(503).json({
      error: "Pemesanan masih dinonaktifkan sampai pengujian Sandbox selesai."
    });
  }

  if (!pool) {
    return res.status(503).json({ error: "Database belum tersedia." });
  }

  const {
    sku_code,
    customer_target,
    customer_target_zone,
    additional_data
  } = req.body || {};

  if (!sku_code || !customer_target) {
    return res.status(400).json({
      error: "sku_code dan customer_target wajib diisi."
    });
  }

  const product = await pool.query(
    `SELECT price FROM products
     WHERE product_code = $1 AND LOWER(status) = 'active'`,
    [sku_code]
  );

  if (!product.rows.length) {
    return res.status(404).json({ error: "SKU tidak ditemukan atau tidak aktif." });
  }

  const buyer_trx_id = `NM${Date.now()}${crypto.randomBytes(3).toString("hex")}`;

  await pool.query(
    `INSERT INTO orders
      (buyer_trx_id, sku_code, customer_target,
       customer_target_zone, price, status, is_sandbox)
     VALUES ($1, $2, $3, $4, $5, 'processing', TRUE)`,
    [
      buyer_trx_id,
      sku_code,
      String(customer_target),
      customer_target_zone || null,
      Number(product.rows[0].price || 0)
    ]
  );

  try {
    const result = await meloRequest("/transaction", {
      method: "POST",
      body: JSON.stringify({
        sku_code,
        customer_target: String(customer_target),
        customer_target_zone: customer_target_zone || null,
        additional_data: additional_data || null,
        buyer_trx_id,
        sandbox_mode: true
      })
    });

    const data = result.data || {};

    await pool.query(
      `UPDATE orders
       SET melo_transaction_id = $2,
           status = $3,
           price = $4,
           serial_number = $5,
           message = $6,
           updated_at = NOW()
       WHERE buyer_trx_id = $1`,
      [
        buyer_trx_id,
        data.id || null,
        String(data.status || "processing").toLowerCase(),
        Number(data.price ?? product.rows[0].price),
        data.serial_number || null,
        data.message || null
      ]
    );

    res.status(201).json({
      ok: true,
      buyer_trx_id,
      transaction: data,
      sandbox: true
    });
  } catch (error) {
    await pool.query(
      `UPDATE orders
       SET status = 'review', message = $2, updated_at = NOW()
       WHERE buyer_trx_id = $1`,
      [buyer_trx_id, error.message]
    );

    res.status(502).json({
      buyer_trx_id,
      status: "review",
      error: error.message
    });
  }
});

// Cek status pesanan melalui ID transaksi atau buyer_trx_id.
app.get("/api/orders/:id", async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({ error: "Database belum tersedia." });
    }

    const { rows } = await pool.query(
      `SELECT * FROM orders
       WHERE buyer_trx_id = $1 OR melo_transaction_id = $1
       LIMIT 1`,
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Pesanan tidak ditemukan." });
    }

    const order = rows[0];

    if (order.melo_transaction_id) {
      const result = await meloRequest(
        `/transaction/${encodeURIComponent(order.melo_transaction_id)}`
      );

      res.json(result);
      return;
    }

    res.json(order);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

// Webhook Melo: verifikasi HMAC-SHA256 dari raw body.
app.post("/api/melo/webhook", async (req, res) => {
  try {
    const secret = process.env.MELO_WEBHOOK_SECRET;
    const signature = req.headers["x-h2h-signature"];

    if (!secret || !signature || !req.rawBody) {
      return res.status(401).json({ error: "Signature tidak tersedia." });
    }

    const expected = crypto
      .createHmac("sha256", secret)
      .update(req.rawBody)
      .digest("hex");

    const receivedBuffer = Buffer.from(String(signature), "hex");
    const expectedBuffer = Buffer.from(expected, "hex");

    if (
      receivedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
    ) {
      return res.status(401).json({ error: "Signature tidak valid." });
    }

    const event = req.body || {};
    const buyerTrxId = event.buyer_trx_id;
    const transactionId = event.id;

    if (pool && (buyerTrxId || transactionId)) {
      await pool.query(
        `UPDATE orders
         SET melo_transaction_id = COALESCE($2, melo_transaction_id),
             status = COALESCE($3, status),
             serial_number = COALESCE($4, serial_number),
             price = COALESCE($5, price),
             message = COALESCE($6, message),
             updated_at = NOW()
         WHERE buyer_trx_id = $1 OR melo_transaction_id = $2`,
        [
          buyerTrxId || "",
          transactionId || null,
          event.status ? String(event.status).toLowerCase() : null,
          event.serial_number || null,
          event.price_charged ?? null,
          event.message || null
        ]
      );
    }

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Webhook gagal diproses." });
  }
});

const port = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(port, () => {
      console.log(`NEXTMART Melo H2H backend listening on ${port}`);
    });
  })
  .catch((error) => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
