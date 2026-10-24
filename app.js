const params = new URLSearchParams(location.search);
const deviceInput = document.getElementById("deviceId");
const hint = document.getElementById("deviceHint");
const form = document.getElementById("buyForm");
const payBtn = document.getElementById("payBtn");
const message = document.getElementById("message");
const total = document.getElementById("total");
const priceNote = document.getElementById("priceNote");

// The Android app should open this page with ?deviceId=<URL-encoded-device-id>.
const deviceId = params.get("deviceId") || params.get("device_id") || "";
deviceInput.value = deviceId;
if (deviceId) {
  hint.textContent = "شناسه دستگاه از برنامه دریافت شد.";
  hint.style.color = "#54e0b4";
} else {
  hint.textContent = "شناسه دستگاه دریافت نشد. این صفحه را از دکمه خرید داخل برنامه باز کنید.";
}

fetch("/api/price")
  .then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || "قیمت در دسترس نیست."); return d; })
  .then(d => { total.textContent = new Intl.NumberFormat("fa-IR").format(d.totalToman) + " تومان"; priceNote.textContent = "برای بسته ۵ TON"; })
  .catch(e => { total.textContent = "فعلاً در دسترس نیست"; priceNote.textContent = e.message; });

form.addEventListener("submit", async e => {
  e.preventDefault();
  message.textContent = "";
  if (!deviceId) { message.textContent = "شناسه دستگاه موجود نیست؛ خرید را از داخل برنامه آغاز کنید."; return; }
  const phone = document.getElementById("phone").value.trim();
  payBtn.disabled = true;
  payBtn.textContent = "در حال آماده‌سازی پرداخت…";
  try {
    const r = await fetch("/api/orders", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, phone })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "امکان ساخت سفارش وجود ندارد.");
    location.href = d.paymentUrl;
  } catch (err) {
    message.textContent = err.message;
    payBtn.disabled = false;
    payBtn.textContent = "ادامه و پرداخت";
  }
});
