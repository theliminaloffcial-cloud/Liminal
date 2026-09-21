// api/send-shipping-notification.js
//
// 後台「網站設定」以外的另一支通知信：admin.html 在訂單管理輸入追蹤號碼、
// 按下「出貨並通知客人」時，會呼叫這支 API，寄一封含追蹤號碼的信給客人。
//
// admin.html 是部署在「另一個網址」的獨立網站（跟商店分開），所以這支 API
// 需要允許跨網域呼叫（CORS），並用一組簡單的共用密鑰做基本防護，避免這支
// 會寄信的 API 被任何人隨便呼叫、濫用您的 Resend 額度亂寄信。
//
// ⚠️ 這組共用密鑰是寫在 admin.html 的前端程式碼裡（因為 admin.html 只是靜態
// 網頁，沒有自己的伺服器），所以嚴格來說不是真正機密——只是防止隨手亂試的
// 基本門檻，不是滴水不漏的安全機制。真正重要的資料（Resend 金鑰本身）
// 還是只存在這支後端的環境變數裡，不會外流。

import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_ADDRESS = process.env.FROM_ADDRESS || 'LIMINAL 訂單通知 <onboarding@resend.dev>';
const ADMIN_NOTIFY_SECRET = process.env.ADMIN_NOTIFY_SECRET || '';
// 允許呼叫這支 API 的來源網域（您的後台網址），用逗號分隔可以填多個
const ALLOWED_ORIGINS = (process.env.ADMIN_ORIGIN || 'https://liminal-admin-tan.vercel.app')
  .split(',')
  .map((s) => s.trim());

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ ok: false, error: '伺服器尚未設定 RESEND_API_KEY 環境變數。' });
  }
  if (!ADMIN_NOTIFY_SECRET || req.body?.secret !== ADMIN_NOTIFY_SECRET) {
    return res.status(401).json({ ok: false, error: '驗證失敗，無法寄送通知信。' });
  }

  try {
    const { to, recipientName, orderId, trackingNumber, items } = req.body || {};
    if (!to || !trackingNumber || !orderId) {
      return res.status(400).json({ ok: false, error: '缺少收件信箱、追蹤號碼或訂單編號。' });
    }

    const itemsList = Array.isArray(items) && items.length
      ? `<ul>${items.map((i) => `<li>${escapeHtml(i.name)}</li>`).join('')}</ul>`
      : '';

    const html = `
      <div style="font-family:Arial,'Noto Sans TC',sans-serif; max-width:520px; margin:0 auto; color:#111;">
        <h2 style="font-weight:400; font-style:italic;">LIMINAL — 您的訂單已出貨</h2>
        <p>${escapeHtml(recipientName || '')} 您好，</p>
        <p>您的訂單（編號：${escapeHtml(orderId)}）已經出貨囉！</p>
        ${itemsList}
        <div style="background:#F4F4F3; padding:14px 16px; margin:16px 0;">
          <p style="margin:0 0 6px; font-weight:600;">追蹤號碼</p>
          <p style="margin:0; font-family:monospace; font-size:16px;">${escapeHtml(trackingNumber)}</p>
        </div>
        <p style="color:#666; font-size:13px;">如有任何問題，歡迎回信與我們聯繫。</p>
      </div>`;

    const result = await resend.emails.send({
      from: FROM_ADDRESS,
      to,
      subject: `LIMINAL 訂單已出貨 #${orderId}`,
      html,
    });

    return res.status(200).json({ ok: true, id: result?.data?.id || null });
  } catch (err) {
    console.error('send-shipping-notification error:', err);
    return res.status(500).json({ ok: false, error: err.message || '寄信失敗' });
  }
}
