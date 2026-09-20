// api/send-order-email.js
// 這支檔案放在 /api 資料夾下，部署到 Vercel 後會自動變成一支 API：
//   POST https://您的網域/api/send-order-email
//
// 金鑰完全不寫在程式碼裡，而是從環境變數 RESEND_API_KEY 讀取。
// 請到 Vercel 專案設定 → Environment Variables 新增：
//   RESEND_API_KEY = 您在 Resend 後台重新產生的新金鑰

import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

// 通知信要寄到的信箱（也可以改用環境變數 NOTIFY_EMAIL，見下方）
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'theliminal.offcial@gmail.com';

// Resend 規定「寄件者」網域必須先在 Resend 後台完成驗證（加 DNS 紀錄）。
// 在您完成網域驗證之前，可以先用 Resend 提供的測試寄件位址：
//   onboarding@resend.dev
// 注意：測試位址只能寄給您自己在 Resend 註冊的帳號信箱，正式上線前務必換成您自己驗證過的網域。
const FROM_ADDRESS = process.env.FROM_ADDRESS || 'LIMINAL 訂單通知 <onboarding@resend.dev>';

function buildEmailHtml(order) {
  const itemsHtml = (order.items || [])
    .map(
      (item) => `
      <tr>
        <td style="padding:8px 12px; border-bottom:1px solid #eee;">${escapeHtml(item.name)}</td>
        <td style="padding:8px 12px; border-bottom:1px solid #eee;">${escapeHtml(
          [item.color, item.size].filter(Boolean).join(' / ') || '—'
        )}</td>
        <td style="padding:8px 12px; border-bottom:1px solid #eee; text-align:right;">NT$ ${Number(
          item.price || 0
        ).toLocaleString('zh-Hant-TW')}</td>
      </tr>`
    )
    .join('');

  const methodLabel =
    order.method === 'paypal'
      ? 'PayPal'
      : `銀行轉帳（末五碼：${escapeHtml(order.bankLast5 || '未提供')}）`;

  const statusLabel =
    order.status === 'pending' ? '待對帳' : order.status === 'paid' ? '已付款' : '已完成';

  return `
  <div style="font-family:Arial,'Noto Sans TC',sans-serif; max-width:520px; margin:0 auto; color:#111;">
    <h2 style="font-weight:400; font-style:italic;">LIMINAL — 新訂單通知</h2>
    <p>訂單編號：<strong>${escapeHtml(order.id)}</strong></p>
    <p>建立時間：${new Date(order.createdAt).toLocaleString('zh-Hant-TW')}</p>
    <p>付款方式：${methodLabel}</p>
    <p>訂單狀態：<strong>${statusLabel}</strong></p>
    <table style="width:100%; border-collapse:collapse; margin:16px 0;">
      <thead>
        <tr style="background:#f4f4f3;">
          <th style="text-align:left; padding:8px 12px;">商品</th>
          <th style="text-align:left; padding:8px 12px;">規格</th>
          <th style="text-align:right; padding:8px 12px;">金額</th>
        </tr>
      </thead>
      <tbody>${itemsHtml}</tbody>
    </table>
    <p style="font-size:16px;"><strong>訂單總額：NT$ ${Number(order.total || 0).toLocaleString(
      'zh-Hant-TW'
    )}</strong></p>
    ${
      order.status === 'pending'
        ? '<p style="color:#7A5B10; background:#F4E7C7; padding:10px 14px;">此為銀行轉帳待對帳訂單，尚未計入營收，請至後台確認款項後手動標記為「已付款」。</p>'
        : ''
    }
  </div>`;
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({
      ok: false,
      error: '伺服器尚未設定 RESEND_API_KEY 環境變數，請至部署平台後台設定後再試一次。',
    });
  }

  try {
    const { order, to } = req.body || {};
    if (!order || !order.id) {
      return res.status(400).json({ ok: false, error: '缺少訂單資料 (order)。' });
    }

    const result = await resend.emails.send({
      from: FROM_ADDRESS,
      to: to || NOTIFY_EMAIL,
      subject: `LIMINAL 新訂單通知 #${order.id}`,
      html: buildEmailHtml(order),
    });

    return res.status(200).json({ ok: true, id: result?.data?.id || null });
  } catch (err) {
    console.error('send-order-email error:', err);
    return res.status(500).json({ ok: false, error: err.message || '寄信失敗' });
  }
}
