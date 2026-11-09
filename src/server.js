
import express from "express";
import pg from "pg";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const BASE_URL = "https://api.melostore.id/api/v1/h2h";
const PORT = process.env.PORT || 3000;

// =====================================================
// CORS - GITHUB PAGES NEXTMART
// =====================================================

const allowedOrigins = [
  "https://ajidamar6b-ai.github.io"
];

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, OPTIONS"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization"
    );
    res.setHeader("Access-Control-Max-Age", "86400");
  }

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// =====================================================
// MIDTRANS CONFIGURATION
// =====================================================

const MIDTRANS_PRODUCTION =
  process.env.MIDTRANS_IS_PRODUCTION === "true";

const MIDTRANS_SNAP_URL = MIDTRANS_PRODUCTION
  ? "https://app.midtrans.com/snap/v1/transactions"
  : "https://app.sandbox.midtrans.com/snap/v1/transactions";

const MIDTRANS_STATUS_URL = MIDTRANS_PRODUCTION
  ? "https://api.midtrans.com/v2"
  : "https://api.sandbox.midtrans.com/v2";

// =====================================================
// DATABASE
// =====================================================

const pool = process.env.DATABASE_URL
  ? new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("render.com")
        ? { rejectUnauthorized: false }
        : undefined
    })
  : null;

app.use(express.json({
  limit: "1mb",
  verify(req, res, buffer) {
    req.rawBody = Buffer.from(buffer);
  }
}));

app.use(express.static(path.join(__dirname, "../public")));

app.get("/", (_req, res) => {
  res.status(200).send("NEXTMART backend is running");
});

app.get("/api/health-check", (_req, res) => {
  res.json({
    ok: true,
    service: "NEXTMART",
    status: "running"
  });
});

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

    CREATE TABLE IF NOT EXISTS product_sync_jobs (
      id UUID PRIMARY KEY,
      status VARCHAR(20) NOT NULL DEFAULT 'queued',
      fetched INTEGER NOT NULL DEFAULT 0,
      synced INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE product_sync_jobs
      ADD COLUMN IF NOT EXISTS sync_cursor TEXT;

    CREATE TABLE IF NOT EXISTS payment_orders (
      id SERIAL PRIMARY KEY,
      order_id VARCHAR(50) UNIQUE NOT NULL,
      sku_code VARCHAR(100) NOT NULL,
      customer_target VARCHAR(255) NOT NULL,
      customer_target_zone VARCHAR(100),
      additional_data JSONB,
      modal_price BIGINT NOT NULL,
      selling_price BIGINT NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      snap_token TEXT,
      snap_redirect_url TEXT,
      midtrans_transaction_id VARCHAR(100),
      payment_type VARCHAR(50),
      supplier_status VARCHAR(30) DEFAULT 'waiting_payment',
      supplier_message TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS payment_orders_status_idx
      ON payment_orders(status);

    CREATE INDEX IF NOT EXISTS payment_orders_supplier_idx
      ON payment_orders(supplier_status);
  `);
}

// =====================================================
// ADMIN AUTH
// =====================================================

const adminOnly = (req, res, next) => {
  const token = process.env.ADMIN_API_TOKEN;

  if (!token || req.headers.authorization !== `Bearer ${token}`) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  next();
};

// =====================================================
// HARGA JUAL
// Modal + 10%, minimal keuntungan Rp1.500,
// lalu dibulatkan ke atas kelipatan Rp500.
// =====================================================

function calculateSellingPrice(modalPrice) {
  const modal = Number(modalPrice);

  if (!Number.isSafeInteger(modal) || modal <= 0) {
    throw new Error("Harga modal produk tidak valid.");
  }

  const withMarkup = modal * 1.10;
  const withMinimumProfit = modal + 1500;

  return Math.ceil(
    Math.max(withMarkup, withMinimumProfit) / 500
  ) * 500;
}

// =====================================================
// MELO API
// =====================================================

async function meloRequest(endpoint, options = {}) {
  const {
    MELO_API_KEY,
    MELO_SECRET_KEY
  } = process.env;

  if (!MELO_API_KEY || !MELO_SECRET_KEY) {
    throw new Error("Kredensial Melo belum diatur.");
  }

  const response = await fetch(`${BASE_URL}${endpoint}`, {
    ...options,
    signal: options.signal || AbortSignal.timeout(30000),
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

// =====================================================
// MIDTRANS API
// =====================================================

function getMidtransAuth() {
  const serverKey = process.env.MIDTRANS_SERVER_KEY;

  if (!serverKey) {
    throw new Error("MIDTRANS_SERVER_KEY belum diatur.");
  }

  return "Basic " +
    Buffer.from(`${serverKey}:`).toString("base64");
}

async function midtransRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(30000),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: getMidtransAuth(),
      ...(options.headers || {})
    }
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      result.error_messages?.join(", ") ||
      result.status_message ||
      result.message ||
      `Midtrans HTTP ${response.status}`
    );
  }

  return result;
}

async function createSnapTransaction(order) {
  const payload = {
    transaction_details: {
      order_id: order.order_id,
      gross_amount: Number(order.selling_price)
    },

    item_details: [
      {
        id: order.sku_code,
        price: Number(order.selling_price),
        quantity: 1,
        name: String(order.sku_code).slice(0, 50)
      }
    ],

    callbacks: {
      finish: "https://ajidamar6b-ai.github.io/nextmart/"
    }
  };

  const result = await midtransRequest(
    MIDTRANS_SNAP_URL,
    {
      method: "POST",
      body: JSON.stringify(payload)
    }
  );

  if (!result.token || !result.redirect_url) {
    throw new Error("Midtrans tidak memberikan token pembayaran.");
  }

  return result;
}

async function getMidtransTransactionStatus(orderId) {
  return midtransRequest(
    `${MIDTRANS_STATUS_URL}/${encodeURIComponent(orderId)}/status`,
    {
      method: "GET"
    }
  );
}

// =====================================================
// PEMROSESAN PESANAN SETELAH PEMBAYARAN
// =====================================================

async function fulfillPaidOrder(orderId, allowRetry = false) {
  const client = await pool.connect();

  let payment;

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT *
       FROM payment_orders
       WHERE order_id = $1
       FOR UPDATE`,
      [orderId]
    );

    if (!result.rows.length) {
      await client.query("ROLLBACK");
      return;
    }

    payment = result.rows[0];

    if (payment.status !== "paid") {
      await client.query("ROLLBACK");
      return;
    }

    const canStart =
      payment.supplier_status === "waiting_payment" ||
      (
        allowRetry &&
        payment.supplier_status === "review"
      );

    if (!canStart) {
      await client.query("ROLLBACK");
      return;
    }

    await client.query(
      `UPDATE payment_orders
       SET supplier_status = 'processing',
           supplier_message = NULL,
           updated_at = NOW()
       WHERE order_id = $1`,
      [orderId]
    );

    await client.query(
      `INSERT INTO orders
        (buyer_trx_id, sku_code, customer_target,
         customer_target_zone, price, status, is_sandbox)
       VALUES ($1, $2, $3, $4, $5, 'processing', TRUE)
       ON CONFLICT (buyer_trx_id) DO NOTHING`,
      [
        payment.order_id,
        payment.sku_code,
        payment.customer_target,
        payment.customer_target_zone,
        payment.modal_price
      ]
    );

    await client.query("COMMIT");

  } catch (error) {
    await client.query("ROLLBACK");
    client.release();
    throw error;
  }

  client.release();

  try {
    const result = await meloRequest("/transaction", {
      method: "POST",
      body: JSON.stringify({
        sku_code: payment.sku_code,
        customer_target: String(payment.customer_target),
        customer_target_zone:
          payment.customer_target_zone || null,
        additional_data: payment.additional_data || null,
        buyer_trx_id: payment.order_id,
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
        payment.order_id,
        data.id,
        String(data.status || "processing").toLowerCase(),
        Number(data.price ?? payment.modal_price),
        data.serial_number || null,
        data.message || null
      ]
    );

    await pool.query(
      `UPDATE payment_orders
       SET supplier_status = $2,
           supplier_message = $3,
           updated_at = NOW()
       WHERE order_id = $1`,
      [
        payment.order_id,
        String(data.status || "processing").toLowerCase(),
        data.message || null
      ]
    );

  } catch (error) {
    console.error("Melo fulfillment error:", error.message);

    await pool.query(
      `UPDATE orders
       SET status = 'review',
           message = $2,
           updated_at = NOW()
       WHERE buyer_trx_id = $1`,
      [payment.order_id, error.message]
    );

    await pool.query(
      `UPDATE payment_orders
       SET supplier_status = 'review',
           supplier_message = $2,
           updated_at = NOW()
       WHERE order_id = $1`,
      [payment.order_id, error.message]
    );
  }
}

// =====================================================
// DATABASE HEALTH
// =====================================================

app.get("/api/health", async (_req, res) => {
  try {
    const profile = await meloRequest("/profile");

    if (pool) {
      await pool.query("SELECT 1");
    }

    res.json({
      ok: true,
      supplier: "Melo H2H",
      mode: "sandbox",
      database: !!pool,
      melo_connected: !!profile.data,
      midtrans_mode: MIDTRANS_PRODUCTION
        ? "production"
        : "sandbox"
    });

  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error.message
    });
  }
});

// =====================================================
// PRODUCT SYNC
// =====================================================

const activeSyncWorkers = new Set();

async function runProductSyncJob(jobId) {
  try {
    const savedJob = await pool.query(
      `SELECT sync_cursor, fetched, synced
       FROM product_sync_jobs
       WHERE id = $1`,
      [jobId]
    );

    if (!savedJob.rows.length) {
      throw new Error("Job sinkronisasi tidak ditemukan.");
    }

    const saved = savedJob.rows[0];

    let cursor = saved.sync_cursor || "";

    let fetched = saved.sync_cursor
      ? Number(saved.fetched || 0)
      : 0;

    let synced = saved.sync_cursor
      ? Number(saved.synced || 0)
      : 0;

    await pool.query(
      `UPDATE product_sync_jobs
       SET status = 'running',
           fetched = $2,
           synced = $3,
           message = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [jobId, fetched, synced]
    );

    let hasMore = true;

    while (hasMore) {
      const params = new URLSearchParams({
        limit: "500"
      });

      if (cursor) {
        params.set("cursor", cursor);
      }

      const result = await meloRequest(
        `/pricelists?${params.toString()}`
      );

      if (!Array.isArray(result.data)) {
        throw new Error("Format katalog Melo tidak valid.");
      }

      for (const product of result.data) {
        fetched++;

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

      const pagination = result.meta?.pagination || {};

      hasMore = pagination.has_more === true;
      cursor = pagination.next_cursor || "";

      await pool.query(
        `UPDATE product_sync_jobs
         SET fetched = $2,
             synced = $3,
             sync_cursor = $4,
             updated_at = NOW()
         WHERE id = $1`,
        [jobId, fetched, synced, cursor || null]
      );

      if (hasMore && !cursor) {
        throw new Error("Cursor katalog Melo tidak tersedia.");
      }
    }

    await pool.query(
      `UPDATE product_sync_jobs
       SET status = 'completed',
           fetched = $2,
           synced = $3,
           message = 'Sinkronisasi selesai',
           updated_at = NOW()
       WHERE id = $1`,
      [jobId, fetched, synced]
    );

    console.log(
      `Melo product sync completed: ${synced} products`
    );

  } catch (error) {
    console.error("Melo product sync failed:", error.message);

    await pool.query(
      `UPDATE product_sync_jobs
       SET status = 'failed',
           message = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [jobId, error.message]
    ).catch((dbError) => {
      console.error(
        "Could not update sync job:",
        dbError.message
      );
    });
  }
}

function startProductSyncJob(jobId) {
  if (!pool || activeSyncWorkers.has(jobId)) return;

  activeSyncWorkers.add(jobId);

  runProductSyncJob(jobId)
    .catch((error) => {
      console.error("Sync worker error:", error.message);
    })
    .finally(() => {
      activeSyncWorkers.delete(jobId);
    });
}

app.post(
  "/api/admin/melo/sync-products",
  adminOnly,
  async (_req, res) => {
    if (!pool) {
      return res.status(503).json({
        error: "Database belum tersedia."
      });
    }

    try {
      const active = await pool.query(
        `SELECT id
         FROM product_sync_jobs
         WHERE status IN ('queued', 'running')
         ORDER BY created_at DESC
         LIMIT 1`
      );

      if (active.rows.length) {
        const jobId = active.rows[0].id;

        startProductSyncJob(jobId);

        return res.status(202).json({
          ok: true,
          message: "Sinkronisasi sudah berjalan atau dilanjutkan.",
          job_id: jobId,
          status_url: `/api/admin/melo/sync-products/${jobId}`
        });
      }

      const jobId = crypto.randomUUID();

      await pool.query(
        `INSERT INTO product_sync_jobs (id, status)
         VALUES ($1, 'queued')`,
        [jobId]
      );

      setImmediate(() => {
        startProductSyncJob(jobId);
      });

      return res.status(202).json({
        ok: true,
        message: "Sinkronisasi katalog dimulai di background.",
        job_id: jobId,
        status_url: `/api/admin/melo/sync-products/${jobId}`
      });

    } catch (error) {
      return res.status(500).json({
        error: error.message
      });
    }
  }
);

app.get(
  "/api/admin/melo/sync-products/:id",
  adminOnly,
  async (req, res) => {
    if (!pool) {
      return res.status(503).json({
        error: "Database belum tersedia."
      });
    }

    try {
      const { rows } = await pool.query(
        `SELECT id, status, fetched, synced, message,
                created_at, updated_at
         FROM product_sync_jobs
         WHERE id = $1`,
        [req.params.id]
      );

      if (!rows.length) {
        return res.status(404).json({
          error: "Job sinkronisasi tidak ditemukan."
        });
      }

      return res.json({
        ok: true,
        job: rows[0]
      });

    } catch (error) {
      return res.status(500).json({
        error: error.message
      });
    }
  }
);

// =====================================================
// PRODUCT API
// Harga yang dikirim ke frontend adalah harga jual.
// Harga modal tidak dikirim ke pembeli.
// =====================================================

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
              price AS modal_price,
              status
       FROM products
       WHERE LOWER(status) = 'active'
       ORDER BY category, price
       LIMIT 25000`
    );

    const products = rows.map((product) => {
      const sellingPrice = calculateSellingPrice(
        product.modal_price
      );

      return {
        sku_code: product.sku_code,
        name: product.name,
        category: product.category,
        price: sellingPrice,
        selling_price: sellingPrice,
        status: product.status
      };
    });

    res.json(products);

  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

// =====================================================
// CREATE PAYMENT ORDER
// Pembeli belum dikirim ke supplier di tahap ini.
// =====================================================

app.post("/api/orders", async (req, res) => {
  if (!pool) {
    return res.status(503).json({
      error: "Database belum tersedia."
    });
  }

  if (process.env.MELO_ORDERS_ENABLED !== "true") {
    return res.status(503).json({
      error: "Pemesanan supplier belum diaktifkan."
    });
  }

  if (!process.env.MIDTRANS_SERVER_KEY) {
    return res.status(503).json({
      error: "Midtrans Server Key belum diatur."
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

  if (
    String(sku_code).length > 100 ||
    String(customer_target).length > 255 ||
    String(customer_target_zone || "").length > 100
  ) {
    return res.status(400).json({
      error: "Data pesanan terlalu panjang."
    });
  }

  try {
    const product = await pool.query(
      `SELECT product_code, product_name, price
       FROM products
       WHERE product_code = $1
         AND LOWER(status) = 'active'`,
      [sku_code]
    );

    if (!product.rows.length) {
      return res.status(404).json({
        error: "SKU tidak ditemukan atau tidak aktif."
      });
    }

    const modalPrice = Number(product.rows[0].price);

    const sellingPrice = calculateSellingPrice(modalPrice);

    const orderId =
      `NM${Date.now()}${crypto.randomBytes(4).toString("hex")}`;

    await pool.query(
      `INSERT INTO payment_orders
        (order_id, sku_code, customer_target,
         customer_target_zone, additional_data,
         modal_price, selling_price, status, supplier_status)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7,
               'pending', 'waiting_payment')`,
      [
        orderId,
        sku_code,
        String(customer_target),
        customer_target_zone || null,
        JSON.stringify(additional_data || null),
        modalPrice,
        sellingPrice
      ]
    );

    try {
      const snap = await createSnapTransaction({
        order_id: orderId,
        sku_code,
        selling_price: sellingPrice
      });

      await pool.query(
        `UPDATE payment_orders
         SET snap_token = $2,
             snap_redirect_url = $3,
             updated_at = NOW()
         WHERE order_id = $1`,
        [
          orderId,
          snap.token,
          snap.redirect_url
        ]
      );

      return res.status(201).json({
        ok: true,
        order_id: orderId,
        buyer_trx_id: orderId,
        status: "pending",
        price: sellingPrice,
        payment: {
          token: snap.token,
          redirect_url: snap.redirect_url
        },
        sandbox: !MIDTRANS_PRODUCTION
      });

    } catch (error) {
      await pool.query(
        `UPDATE payment_orders
         SET status = 'payment_error',
             supplier_message = $2,
             updated_at = NOW()
         WHERE order_id = $1`,
        [orderId, error.message]
      );

      throw error;
    }

  } catch (error) {
    console.error("Create payment error:", error.message);

    return res.status(502).json({
      ok: false,
      error: error.message
    });
  }
});

// =====================================================
// MIDTRANS WEBHOOK
// Verifikasi signature + cek status langsung ke Midtrans.
// =====================================================

app.post("/api/midtrans/webhook", async (req, res) => {
  if (!pool) {
    return res.status(503).json({
      error: "Database belum tersedia."
    });
  }

  try {
    const notification = req.body || {};

    const {
      order_id,
      status_code,
      gross_amount,
      signature_key
    } = notification;

    const serverKey = process.env.MIDTRANS_SERVER_KEY;

    if (
      !serverKey ||
      !order_id ||
      !status_code ||
      !gross_amount ||
      !signature_key
    ) {
      return res.status(400).json({
        error: "Data notifikasi tidak lengkap."
      });
    }

    const expectedSignature = crypto
      .createHash("sha512")
      .update(
        `${order_id}${status_code}${gross_amount}${serverKey}`
      )
      .digest("hex");

    const received = Buffer.from(
      String(signature_key),
      "hex"
    );

    const expected = Buffer.from(
      expectedSignature,
      "hex"
    );

    if (
      received.length !== expected.length ||
      !crypto.timingSafeEqual(received, expected)
    ) {
      return res.status(401).json({
        error: "Signature Midtrans tidak valid."
      });
    }

    const paymentResult = await pool.query(
      `SELECT *
       FROM payment_orders
       WHERE order_id = $1`,
      [order_id]
    );

    if (!paymentResult.rows.length) {
      return res.status(404).json({
        error: "Pesanan tidak ditemukan."
      });
    }

    const payment = paymentResult.rows[0];

    if (
      Math.round(Number(gross_amount)) !==
      Number(payment.selling_price)
    ) {
      return res.status(400).json({
        error: "Nominal pembayaran tidak cocok."
      });
    }

    // Ambil status langsung dari Midtrans.
    // Jangan hanya percaya isi webhook.
    const verified = await getMidtransTransactionStatus(
      order_id
    );

    if (
      Math.round(Number(verified.gross_amount)) !==
      Number(payment.selling_price)
    ) {
      return res.status(400).json({
        error: "Nominal status Midtrans tidak cocok."
      });
    }

    const transactionStatus = verified.transaction_status;
    const fraudStatus = verified.fraud_status;

    const isPaid =
      transactionStatus === "settlement" ||
      (
        transactionStatus === "capture" &&
        fraudStatus === "accept"
      );

    if (isPaid) {
      await pool.query(
        `UPDATE payment_orders
         SET status = 'paid',
             midtrans_transaction_id = $2,
             payment_type = $3,
             updated_at = NOW()
         WHERE order_id = $1`,
        [
          order_id,
          verified.transaction_id || null,
          verified.payment_type || null
        ]
      );

      // Hanya pesanan yang sudah terverifikasi dibayar
      // yang diteruskan ke supplier Melo.
      await fulfillPaidOrder(order_id);

    } else if (transactionStatus === "pending") {
      await pool.query(
        `UPDATE payment_orders
         SET status = 'pending',
             updated_at = NOW()
         WHERE order_id = $1
           AND status <> 'paid'`,
        [order_id]
      );

    } else if (
      ["deny", "cancel", "expire"].includes(transactionStatus)
    ) {
      await pool.query(
        `UPDATE payment_orders
         SET status = $2,
             updated_at = NOW()
         WHERE order_id = $1
           AND status <> 'paid'`,
        [
          order_id,
          transactionStatus === "expire"
            ? "expired"
            : "failed"
        ]
      );
    }

    return res.status(200).json({
      ok: true,
      order_id,
      transaction_status: transactionStatus
    });

  } catch (error) {
    console.error("Midtrans webhook error:", error.message);

    return res.status(500).json({
      error: "Webhook gagal diproses."
    });
  }
});

// =====================================================
// CEK STATUS PESANAN
// =====================================================

app.get("/api/orders/:id", async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({
        error: "Database belum tersedia."
      });
    }

    const payment = await pool.query(
      `SELECT order_id, sku_code, customer_target,
              selling_price, status, payment_type,
              supplier_status, supplier_message,
              snap_redirect_url, created_at, updated_at
       FROM payment_orders
       WHERE order_id = $1`,
      [req.params.id]
    );

    if (payment.rows.length) {
      return res.json({
        ok: true,
        order: payment.rows[0]
      });
    }

    const { rows } = await pool.query(
      `SELECT *
       FROM orders
       WHERE buyer_trx_id = $1
          OR melo_transaction_id = $1
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
    res.status(502).json({
      error: error.message
    });
  }
});

// =====================================================
// ADMIN: RETRY SUPPLIER ORDER
// Hanya untuk pembayaran sukses yang supplier-nya review.
// =====================================================

app.post(
  "/api/admin/payments/:id/retry-supplier",
  adminOnly,
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT order_id, status, supplier_status
         FROM payment_orders
         WHERE order_id = $1`,
        [req.params.id]
      );

      if (!result.rows.length) {
        return res.status(404).json({
          error: "Pesanan tidak ditemukan."
        });
      }

      const payment = result.rows[0];

      if (
        payment.status !== "paid" ||
        payment.supplier_status !== "review"
      ) {
        return res.status(400).json({
          error: "Pesanan tidak memenuhi syarat retry."
        });
      }

      await fulfillPaidOrder(payment.order_id, true);

      return res.json({
        ok: true,
        order_id: payment.order_id,
        message: "Proses supplier dicoba kembali."
      });

    } catch (error) {
      return res.status(500).json({
        error: error.message
      });
    }
  }
);

// =====================================================
// MELO ACTION VALIDATION
// =====================================================

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

// =====================================================
// MELO WEBHOOK
// =====================================================

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

  const event = req.body || {};

  if (!event || typeof event.id !== "string") {
    return res.status(422).json({
      error: "ID transaksi tidak valid."
    });
  }

  const actionEvent =
    event.event === "transaction.action_change";

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

    if (inserted.rowCount > 0) {
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

    return res.status(200).json({
      ok: true
    });

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

// =====================================================
// START SERVER
// =====================================================

initDb()
  .then(async () => {
    if (pool) {
      const active = await pool.query(
        `SELECT id
         FROM product_sync_jobs
         WHERE status IN ('queued', 'running')
         ORDER BY created_at DESC
         LIMIT 1`
      );

      if (active.rows.length) {
        const jobId = active.rows[0].id;

        console.log("Resuming product sync:", jobId);

        setImmediate(() => {
          startProductSyncJob(jobId);
        });
      }
    }

    app.listen(PORT, "0.0.0.0", () => {
      console.log(
        `NEXTMART backend listening on port ${PORT}`
      );

      console.log(
        `Midtrans mode: ${MIDTRANS_PRODUCTION ? "PRODUCTION" : "SANDBOX"}`
      );

      console.log(
        "CORS enabled for:",
        allowedOrigins.join(", ")
      );
    });
  })
  .catch((error) => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
