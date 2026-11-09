
import express from "express";
import pg from "pg";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const BASE_URL = "https://api.melostore.id/api/v1/h2h";
const PORT = process.env.PORT || 3000;

const pool = process.env.DATABASE_URL
  ? new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("render.com")
        ? { rejectUnauthorized: false }
        : undefined
    })
  : null;

// Simpan raw body untuk verifikasi webhook Melo.
app.use(express.json({
  limit: "1mb",
  verify(req, res, buffer) {
    req.rawBody = Buffer.from(buffer);
  }
}));

app.use(express.static(path.join(__dirname, "../public")));

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

  if (!response.ok || result.success === false) {
    throw new Error(
      result.message ||
      result.error ||
      `Melo API HTTP ${response.status}`
    );
  }

  return result;
}

async function initDb() {
  if (!pool) return;

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

    CREATE TABLE IF NOT EXISTS melo_callback_inbox (
      event_key VARCHAR(128) PRIMARY KEY,
      payload JSONB NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS melo_action_state (
      transaction_id VARCHAR(255) PRIMARY KEY,
      action_id UUID NOT NULL,
      version BIGINT NOT NULL,
      payload JSONB NOT NULL
    );
  `);
}

const adminOnly = (req, res, next) => {
  const token = process.env.ADMIN_API_TOKEN;

  if (!token || req.headers.authorization !== `Bearer ${token}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
};

// Pemeriksaan koneksi backend dan Melo.
app.get("/api/health", async (_req, res) => {
  try {
    const profile = await meloRequest("/profile");

    if (pool) await pool.query("SELECT 1");

    res.json({
      ok: true,
      supplier: "Melo H2H",
      mode: "sandbox",
      database: !!pool,
      melo_connected: !!profile.data
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error.message
    });
  }
});

// Ambil seluruh katalog reguler Melo.
async function getMeloPriceList() {
  let cursor = "";
  const allProducts = [];
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({ limit: "500" });

    if (cursor) params.set("cursor", cursor);

    const result = await meloRequest(
      `/pricelists?${params.toString()}`
    );

    if (!Array.isArray(result.data)) {
      throw new Error("Format katalog Melo tidak valid.");
    }

    allProducts.push(...result.data);

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
app.post(
  "/api/admin/melo/sync-products",
  adminOnly,
  async (_req, res) => {
    try {
      if (!pool) {
        return res.status(503).json({
          error: "Database belum tersedia."
        });
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
  }
);

// Daftar produk aktif.
app.get("/api/products", async (_req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({
        error: "Database belum tersedia."
      });
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
      error: "Pemesanan masih dinonaktifkan selama pengujian."
    });
  }

  if (!pool) {
    return res.status(503).json({
      error: "Database belum tersedia."
    });
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

  try {
    const product = await pool.query(
      `SELECT price FROM products
       WHERE product_code = $1 AND LOWER(status) = 'active'`,
      [sku_code]
    );

    if (!product.rows.length) {
      return res.status(404).json({
        error: "SKU tidak ditemukan atau tidak aktif."
      });
    }

    const buyer_trx_id =
      `NM${Date.now()}${crypto.randomBytes(3).toString("hex")}`;

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

    const data = result.data;

    if (!data || !data.id) {
      throw new Error("Respons transaksi Melo tidak lengkap.");
    }

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
        data.id,
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
    res.status(502).json({
      error: error.message
    });
  }
});

// Cek status transaksi melalui UUID atau buyer_trx_id.
app.get("/api/orders/:id", async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({
        error: "Database belum tersedia."
      });
    }

    const { rows } = await pool.query(
      `SELECT * FROM orders
       WHERE buyer_trx_id = $1 OR melo_transaction_id = $1
       LIMIT 1`,
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({
        error: "Pesanan tidak ditemukan."
      });
    }

    const order = rows[0];

    if (order.melo_transaction_id) {
      const result = await meloRequest(
        `/transaction/${encodeURIComponent(order.melo_transaction_id)}`
      );

      return res.json(result);
    }

    res.json(order);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

// Verifikasi format action 2FA dari webhook.
function validAction(action) {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  return !!action &&
    typeof action.id === "string" &&
    uuid.test(action.id) &&
    action.type === "two_factor" &&
    Number.isSafeInteger(action.version) &&
    action.version > 0 &&
    ["required", "submitted", "resolved"].includes(action.state) &&
    action.can_submit === (action.state === "required") &&
    typeof action.message === "string";
}

// Webhook Melo dengan verifikasi HMAC dan deduplikasi.
app.post("/api/melo/webhook", async (req, res) => {
  const secret = process.env.MELO_WEBHOOK_SECRET;
  const signature = req.headers["x-h2h-signature"];

  if (!secret || !signature || !req.rawBody) {
    return res.status(401).json({
      error: "Signature tidak tersedia."
    });
  }

  if (!/^[a-f0-9]{64}$/i.test(String(signature))) {
    return res.status(401).json({
      error: "Format signature tidak valid."
    });
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(req.rawBody)
    .digest();

  const received = Buffer.from(String(signature), "hex");

  if (!crypto.timingSafeEqual(expected, received)) {
    return res.status(401).json({
      error: "Signature tidak valid."
    });
  }

  if (!pool) {
    return res.status(503).json({
      error: "Database belum tersedia."
    });
  }

  let event;

  try {
    event = JSON.parse(req.rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({
      error: "JSON webhook tidak valid."
    });
  }

  if (!event || typeof event.id !== "string") {
    return res.status(422).json({
      error: "ID transaksi tidak valid."
    });
  }

  const actionEvent = event.event === "transaction.action_change";

  if (actionEvent) {
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (
      typeof event.event_id !== "string" ||
      !uuid.test(event.event_id) ||
      !validAction(event.action) ||
      !["pending", "processing", "success", "failed"].includes(event.status) ||
      event.need_action !== (event.action.state === "required")
    ) {
      return res.status(422).json({
        error: "Event tindakan tidak valid."
      });
    }
  } else if (
    event.event ||
    !["success", "failed"].includes(event.status)
  ) {
    return res.status(422).json({
      error: "Event hasil akhir tidak valid."
    });
  }

  if (event.action && !validAction(event.action)) {
    return res.status(422).json({
      error: "Snapshot tindakan tidak valid."
    });
  }

  const eventKey = actionEvent
    ? `action:${event.event_id}:${event.action.version}`
    : `${event.id}:${event.status}`;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const inserted = await client.query(
      `INSERT INTO melo_callback_inbox (event_key, payload)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (event_key) DO NOTHING
       RETURNING event_key`,
      [eventKey, JSON.stringify(event)]
    );

    // Hanya proses event baru.
    if (inserted.rowCount > 0) {
      // Simpan snapshot tindakan secara terpisah.
      // Event tindakan TIDAK mengubah status akhir pesanan.
      if (event.action) {
        await client.query(
          `INSERT INTO melo_action_state
            (transaction_id, action_id, version, payload)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (transaction_id) DO UPDATE SET
             action_id = EXCLUDED.action_id,
             version = EXCLUDED.version,
             payload = EXCLUDED.payload
           WHERE melo_action_state.action_id = EXCLUDED.action_id
             AND melo_action_state.version < EXCLUDED.version`,
          [
            event.id,
            event.action.id,
            event.action.version,
            JSON.stringify(event.action)
          ]
        );
      }

      // Hanya callback success/failed yang mengubah hasil pesanan.
      if (!actionEvent) {
        await client.query(
          `UPDATE orders
           SET melo_transaction_id = COALESCE($2, melo_transaction_id),
               status = $3,
               serial_number = COALESCE($4, serial_number),
               price = COALESCE($5, price),
               message = COALESCE($6, message),
               updated_at = NOW()
           WHERE buyer_trx_id = $1
              OR melo_transaction_id = $2`,
          [
            event.buyer_trx_id || "",
            event.id,
            String(event.status).toLowerCase(),
            event.serial_number || null,
            event.price_charged ?? null,
            event.message || null
          ]
        );
      }
    }

    await client.query("COMMIT");

    return res.status(200).json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Melo webhook error:", error.message);

    return res.status(500).json({
      error: "Webhook gagal diproses."
    });
  } finally {
    client.release();
  }
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`NEXTMART Melo H2H backend listening on ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
