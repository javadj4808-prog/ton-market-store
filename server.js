require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const MERCHANT_ID = process.env.ZARINPAL_MERCHANT_ID || "";
const SANDBOX = String(process.env.ZARINPAL_SANDBOX || "true").toLowerCase() === "true";
const TON_PRICE_TOMAN = Number(process.env.TON_PRICE_TOMAN || 0);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/api/", rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false }));

const db = new Database(path.join(__dirname, "orders.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  amount_toman INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  authority TEXT,
  ref_id TEXT,
  created_at TEXT NOT NULL,
  paid_at TEXT,
  code_sent_at TEXT
)
`);

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET || "unsafe-development-secret").update(value).digest("hex");
}
function adminAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const parts = token.split(".");
  if (parts.length !== 2 || !SESSION_SECRET) return res.status(401).json({ error: "ورود مدیر لازم است." });
  const [expiry, mac] = parts;
  if (!/^\d+$/.test(expiry) || Number(expiry) < Date.now() || !safeEqual(sign(expiry), mac))
    return res.status(401).json({ error: "نشست مدیر منقضی یا نامعتبر است." });
  next();
}
function toman(n) { return new Intl.NumberFormat("fa-IR").format(n) + " تومان"; }

app.get("/api/price", (req, res) => {
  if (!Number.isFinite(TON_PRICE_TOMAN) || TON_PRICE_TOMAN <= 0)
    return res.status(503).json({ error: "قیمت TON هنوز توسط مدیر تنظیم نشده است." });
  res.json({ quantityTon: 5, unitPriceToman: Math.round(TON_PRICE_TOMAN), totalToman: Math.round(TON_PRICE_TOMAN * 5) });
});

app.post("/api/orders", async (req, res) => {
  const deviceId = String(req.body.deviceId || "").trim();
  const phone = String(req.body.phone || "").trim();
  if (!deviceId || deviceId.length > 200) return res.status(400).json({ error: "شناسه دستگاه معتبر نیست. خرید را از داخل برنامه آغاز کنید." });
  if (!/^[0-9+()\-\s]{8,20}$/.test(phone)) return res.status(400).json({ error: "شماره موبایل معتبر وارد کنید." });
  if (!Number.isFinite(TON_PRICE_TOMAN) || TON_PRICE_TOMAN <= 0) return res.status(503).json({ error: "قیمت فروش هنوز تنظیم نشده است." });
  if (!MERCHANT_ID || !/^[0-9a-fA-F-]{36}$/.test(MERCHANT_ID))
    return res.status(503).json({ error: "درگاه پرداخت هنوز پیکربندی نشده است." });

  const amount = Math.round(TON_PRICE_TOMAN * 5);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO orders (id,device_id,phone,amount_toman,status,created_at) VALUES (?,?,?,?,?,?)")
    .run(id, deviceId, phone, amount, "pending", now);

  try {
    const endpoint = SANDBOX
      ? "https://sandbox.zarinpal.com/pg/v4/payment/request.json"
      : "https://payment.zarinpal.com/pg/v4/payment/request.json";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        merchant_id: MERCHANT_ID,
        amount: amount,
        callback_url: `${BASE_URL}/payment/verify?order=${encodeURIComponent(id)}`,
        description: "خرید بسته ۵ TON",
        metadata: { mobile: phone }
      })
    });
    const payload = await response.json();
    const data = payload.data || {};
    if (!response.ok || !data.authority) throw new Error("Zarinpal request failed");
    db.prepare("UPDATE orders SET authority=? WHERE id=?").run(data.authority, id);
    const payBase = SANDBOX ? "https://sandbox.zarinpal.com/pg/StartPay/" : "https://www.zarinpal.com/pg/StartPay/";
    res.json({ paymentUrl: payBase + encodeURIComponent(data.authority) });
  } catch (e) {
    db.prepare("UPDATE orders SET status='payment_setup_failed' WHERE id=?").run(id);
    res.status(502).json({ error: "ساخت درخواست پرداخت ناموفق بود. سفارش ثبت شده؛ لطفاً بعداً دوباره تلاش کنید." });
  }
});

app.get("/payment/verify", async (req, res) => {
  const id = String(req.query.order || "");
  const order = db.prepare("SELECT * FROM orders WHERE id=?").get(id);
  if (!order) return res.status(404).send(pageResult("سفارش پیدا نشد", "شناسه سفارش معتبر نیست."));
  if (String(req.query.Status || "").toUpperCase() !== "OK" || !order.authority) {
    db.prepare("UPDATE orders SET status='payment_cancelled' WHERE id=? AND status='pending'").run(id);
    return res.status(200).send(pageResult("پرداخت تکمیل نشد", "پرداخت تأیید نشد یا توسط کاربر لغو شد. در صورت کسر وجه، با پشتیبانی درگاه تماس بگیرید."));
  }
  try {
    const endpoint = SANDBOX
      ? "https://sandbox.zarinpal.com/pg/v4/payment/verify.json"
      : "https://payment.zarinpal.com/pg/v4/payment/verify.json";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ merchant_id: MERCHANT_ID, amount: order.amount_toman, authority: order.authority })
    });
    const payload = await response.json();
    const data = payload.data || {};
    if (response.ok && (data.code === 100 || data.code === 101)) {
      db.prepare("UPDATE orders SET status='paid',ref_id=?,paid_at=? WHERE id=? AND status!='paid'")
        .run(String(data.ref_id || ""), new Date().toISOString(), id);
      return res.status(200).send(pageResult("پرداخت تأیید شد", `شماره سفارش: ${id}<br>شماره پیگیری: ${escapeHtml(String(data.ref_id || "—"))}<br><br>کد فعال‌سازی پس از بررسی، به‌صورت دستی برای شما ارسال می‌شود.`));
    }
    db.prepare("UPDATE orders SET status='verification_failed' WHERE id=?").run(id);
    return res.status(200).send(pageResult("تأیید پرداخت ناموفق بود", `شماره سفارش شما: ${id}. لطفاً از پرداخت مجدد خودداری کنید و با پشتیبانی تماس بگیرید.`));
  } catch {
    return res.status(502).send(pageResult("بررسی پرداخت انجام نشد", `شماره سفارش: ${id}. وضعیت پرداخت نیازمند بررسی مدیر است؛ فعلاً دوباره پرداخت نکنید.`));
  }
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}
function pageResult(title, message) {
  return `<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><main class="result"><div class="logo">TON<span>MARKET</span></div><h1>${title}</h1><p>${message}</p><a class="button" href="/">بازگشت</a></main></html>`;
}

app.post("/api/admin/login", (req, res) => {
  if (!ADMIN_PASSWORD || !SESSION_SECRET) return res.status(503).json({ error: "رمز مدیر و کلید نشست را در تنظیمات سرور قرار دهید." });
  if (!safeEqual(req.body.password, ADMIN_PASSWORD)) return res.status(401).json({ error: "رمز عبور اشتباه است." });
  const expiry = String(Date.now() + 8 * 60 * 60 * 1000);
  res.json({ token: `${expiry}.${sign(expiry)}` });
});
app.get("/api/admin/orders", adminAuth, (req, res) => {
  const rows = db.prepare("SELECT id,device_id,phone,amount_toman,status,ref_id,created_at,paid_at,code_sent_at FROM orders ORDER BY created_at DESC LIMIT 500").all();
  res.json(rows);
});
app.post("/api/admin/orders/:id/sent", adminAuth, (req, res) => {
  const result = db.prepare("UPDATE orders SET status='code_sent',code_sent_at=? WHERE id=? AND status='paid'")
    .run(new Date().toISOString(), req.params.id);
  if (!result.changes) return res.status(400).json({ error: "فقط سفارش پرداخت‌شده را می‌توان به «کد ارسال شد» تغییر داد." });
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`TON Market listening on port ${PORT}`));
