// api/create-ecpay-order.js
//
// 流程說明（導轉付款頁模式，適用個人／商務賣家，免簽特約）：
//   1. 前端用一個真正的 <form method="POST"> 導向這支 API（不是 fetch，因為最後需要
//      讓瀏覽器整頁導到綠界的付款頁面，這是 ECPay 官方規定的串接方式）。
//   2. 這支 API 收到購物車內容，先在 Supabase 建立一筆狀態為 pending 的訂單，
//      產生一組 MerchantTradeNo 綁定這筆訂單。
//   3. 直接用 Node.js 內建的 crypto 模組，依照 ECPay 官方文件的規則自己組參數、
//      算 CheckMacValue，回傳一個「會自動送出的表單」HTML，瀏覽器收到後
//      會自動整頁跳轉到綠界付款頁。
//   4. 客人在綠界自己的頁面輸入卡號付款（綠界的頁面樣式，我們無法客製）。
//   5. 付款完成後，綠界會用「伺服器對伺服器」的方式呼叫 ReturnURL（見 api/ecpay-return.js），
//      由那支 API 把訂單狀態改成已完成、計入營收、寄出通知信。
//
// ⚠️ 這裡沒有使用任何第三方 ECPay npm 套件（那些套件版本、名稱、API 用法變動較大，
//    容易造成部署失敗或行為對不上），改成直接依照 ECPay 官方公開的文件規則實作，
//    只依賴 Node.js 內建的 crypto。CheckMacValue 演算法跟 api/ecpay-return.js
//    裡驗證用的是同一套，正式上線前務必先用小額真實訂單完整測試一次。

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

// ==== Supabase（用來寫入待付款訂單）====
// 用 lazy 建立，避免環境變數還沒設定時，模組一載入就直接丟例外讓整支函式崩潰
// （createClient 拿到空字串網址會直接 throw，若寫在最外層會導致連 GET/POST 判斷都跑不到）
let supabase = null;
function getSupabase(){
  if (!supabase){
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  }
  return supabase;
}

// ==== ECPay 商店資訊 ====
// 正式金鑰不寫死在程式碼裡，只從環境變數讀取。請到部署平台（Vercel 等）設定：
//   ECPAY_MERCHANT_ID / ECPAY_HASH_KEY / ECPAY_HASH_IV
const ECPAY_MERCHANT_ID = process.env.ECPAY_MERCHANT_ID || '';
const ECPAY_HASH_KEY = process.env.ECPAY_HASH_KEY || '';
const ECPAY_HASH_IV = process.env.ECPAY_HASH_IV || '';
// 正式環境網址；測試環境請改成 https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5
const ECPAY_CHECKOUT_URL = process.env.ECPAY_CHECKOUT_URL ||
  'https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5';

// 您網站的網域（用來組出 ReturnURL / OrderResultURL），部署到 Vercel 後請設定這個環境變數
const SITE_URL = process.env.SITE_URL || 'https://liminal-gamma-three.vercel.app';

function genMerchantTradeNo(){
  // 只能是英數字，長度上限 20
  return ('L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).toUpperCase().slice(0, 20);
}

function formatTradeDate(date){
  const pad = (n)=> String(n).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth()+1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// 依照 ECPay 文件的 .NET UrlEncode 相容規則做字元還原（跟 ecpay-return.js 用同一套邏輯）
function dotNetUrlEncode(str) {
  return encodeURIComponent(str)
    .replace(/%20/g, '+')
    .replace(/%2D/gi, '-')
    .replace(/%5F/gi, '_')
    .replace(/%2E/gi, '.')
    .replace(/%21/gi, '!')
    .replace(/%2A/gi, '*')
    .replace(/%28/gi, '(')
    .replace(/%29/gi, ')');
}

function calcCheckMacValue(params) {
  const entries = Object.keys(params)
    .filter((k) => k !== 'CheckMacValue')
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((k) => `${k}=${params[k]}`);

  const raw = `HashKey=${ECPAY_HASH_KEY}&${entries.join('&')}&HashIV=${ECPAY_HASH_IV}`;
  const encoded = dotNetUrlEncode(raw).toLowerCase();
  return crypto.createHash('sha256').update(encoded).digest('hex').toUpperCase();
}

// 產生會自動送出的 HTML 表單，瀏覽器收到後整頁跳轉到 ECPay
function buildAutoSubmitForm(actionUrl, params) {
  const inputs = Object.keys(params)
    .map((k) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(String(params[k]))}">`)
    .join('\n      ');

  return `<!DOCTYPE html>
<html lang="zh-Hant"><head><meta charset="UTF-8"><title>正在前往付款頁面…</title></head>
<body onload="document.forms[0].submit()">
  <p style="font-family:Arial,'Noto Sans TC',sans-serif; text-align:center; margin-top:40px;">正在為您導向綠界安全付款頁面，請稍候…</p>
  <form method="POST" action="${escapeHtml(actionUrl)}">
      ${inputs}
  </form>
</body></html>`;
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
    return res.status(405).send('Method not allowed');
  }

  if (!ECPAY_MERCHANT_ID || !ECPAY_HASH_KEY || !ECPAY_HASH_IV) {
    return res.status(500).send('伺服器尚未設定 ECPAY_MERCHANT_ID / ECPAY_HASH_KEY / ECPAY_HASH_IV 環境變數，請至部署平台設定後再試一次。');
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return res.status(500).send('伺服器尚未設定 SUPABASE_URL / SUPABASE_ANON_KEY 環境變數，請至部署平台設定後再試一次。');
  }

  try {
    const supabase = getSupabase();
    const body = req.body || {};
    const items = JSON.parse(body.itemsJson || '[]');
    const total = Number(body.total || 0);
    const recipientName = (body.recipientName || '').trim();
    const recipientPhone = (body.recipientPhone || '').trim();
    const recipientAddress = (body.recipientAddress || '').trim();
    const recipientEmail = (body.recipientEmail || '').trim();

    if (!items.length || !total || total <= 0) {
      return res.status(400).send('缺少購物車內容或金額不正確');
    }
    if (!recipientName || !recipientPhone || !recipientAddress) {
      return res.status(400).send('缺少收件人姓名、電話或地址，請回上一頁填寫完整。');
    }
    if (total > 6000000) {
      // ECPay 單筆金額上限（一般約六百萬，實際請依商店等級確認）
      return res.status(400).send('金額超過綠界單筆交易上限，請洽賣家。');
    }

    const merchantTradeNo = genMerchantTradeNo();
    const orderId = crypto.randomUUID ? crypto.randomUUID() : merchantTradeNo;

    // 先在資料庫建立一筆「待對帳」訂單，等綠界的 ReturnURL 通知回來才會改成已完成
    const { error: insertErr } = await supabase.from('orders').insert({
      id: orderId,
      items,
      total,
      method: 'ecpay',
      status: 'pending',
      merchant_trade_no: merchantTradeNo,
      recipient_name: recipientName,
      recipient_phone: recipientPhone,
      recipient_address: recipientAddress,
      recipient_email: recipientEmail || null,
      created_at: new Date().toISOString()
    });
    if (insertErr) {
      console.error('建立待付款訂單失敗：', insertErr);
      return res.status(500).send('建立訂單失敗，請稍後再試。');
    }

    const itemName = items.map(i => `${i.name} x1`).join('#');

    // ECPay AioCheckOut 要求的參數（不含 CheckMacValue，最後才算並加進去）
    const params = {
      MerchantID: ECPAY_MERCHANT_ID,
      MerchantTradeNo: merchantTradeNo,
      MerchantTradeDate: formatTradeDate(new Date()),
      PaymentType: 'aio',
      TotalAmount: Math.round(total),
      TradeDesc: 'LIMINAL 商店訂單',
      ItemName: itemName,
      ReturnURL: `${SITE_URL}/api/ecpay-return`,
      ChoosePayment: 'Credit',
      ClientBackURL: `${SITE_URL}/#/shop`,
      OrderResultURL: `${SITE_URL}/api/ecpay-order-result`,
      NeedExtraPaidInfo: 'N',
      EncryptType: 1,
    };

    params.CheckMacValue = calcCheckMacValue(params);

    const html = buildAutoSubmitForm(ECPAY_CHECKOUT_URL, params);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (err) {
    console.error('create-ecpay-order error:', err);
    return res.status(500).send('伺服器發生錯誤：' + err.message);
  }
}
