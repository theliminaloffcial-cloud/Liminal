// api/ecpay-return.js
//
// 這支是綠界的 ReturnURL：付款完成後，綠界的伺服器會直接呼叫這支 API
// （不是透過客人的瀏覽器），所以這裡才是真正可信的付款結果來源。
// 同時我們也把 OrderResultURL 指到這裡，讓客人付完款、瀏覽器被導回來時
// 能看到一個簡單的完成頁面（實際訂單狀態仍以這支 API 收到的伺服器通知為準）。
//
// ⚠️ CheckMacValue 的驗證演算法是依照 ECPay 官方文件公開的規則實作
// （排序參數 → 組字串 → 依 .NET UrlEncode 規則轉換 → SHA256 → 轉大寫）。
// 正式上線前請務必在 ECPay 測試環境實際呼叫一次，確認驗證邏輯跟綠界那邊算出來的值一致。

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

// lazy 建立，避免環境變數還沒設定時模組載入就崩潰（原因跟 create-ecpay-order.js 一樣）
let supabase = null;
function getSupabase(){
  if (!supabase){
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  }
  return supabase;
}

// 正式金鑰不寫死在程式碼裡，只從環境變數讀取，且必須跟 create-ecpay-order.js 用同一組
const ECPAY_HASH_KEY = process.env.ECPAY_HASH_KEY || '';
const ECPAY_HASH_IV = process.env.ECPAY_HASH_IV || '';

// 依照 ECPay 文件的 .NET UrlEncode 相容規則做字元還原
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    // OrderResultURL 有時瀏覽器會用 GET 帶著回來，直接顯示一個簡單完成頁
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(simplePage('感謝您的訂單，我們已收到您的付款資訊。'));
  }

  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
      console.error('尚未設定 SUPABASE_URL / SUPABASE_ANON_KEY 環境變數。');
      return res.status(200).send('0|Server Not Configured');
    }
    const supabase = getSupabase();
    const params = req.body || {};
    const receivedMac = params.CheckMacValue;
    const expectedMac = calcCheckMacValue(params);

    if (!receivedMac || receivedMac !== expectedMac) {
      console.error('ECPay CheckMacValue 驗證失敗，可能是偽造請求或參數不符。', { receivedMac, expectedMac });
      // 對綠界的伺服器對伺服器通知，驗證失敗一律回傳非 1|OK，綠界會重試
      return res.status(200).send('0|CheckMacValue Error');
    }

    const merchantTradeNo = params.MerchantTradeNo;
    const rtnCode = params.RtnCode; // '1' 代表付款成功

    if (rtnCode === '1') {
      const { data: orderRows, error: findErr } = await supabase
        .from('orders')
        .select('*')
        .eq('merchant_trade_no', merchantTradeNo)
        .limit(1);

      if (findErr || !orderRows || !orderRows.length) {
        console.error('找不到對應的訂單：', merchantTradeNo, findErr);
      } else {
        const order = orderRows[0];
        await supabase.from('orders').update({ status: 'completed' }).eq('id', order.id);

        // 觸發訂單通知信（呼叫同一個部署下的 send-order-email API）
        try {
          await fetch(`${process.env.SITE_URL || ''}/api/send-order-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              order: {
                id: order.id,
                createdAt: order.created_at,
                items: order.items,
                total: order.total,
                method: 'ecpay',
                status: 'completed',
              },
            }),
          });
        } catch (mailErr) {
          console.error('寄送通知信失敗（訂單仍已正確標記為完成）：', mailErr);
        }
      }
    } else {
      console.log('ECPay 回報付款未成功，RtnCode：', rtnCode, 'MerchantTradeNo：', merchantTradeNo);
    }

    // 依綠界規定，伺服器對伺服器通知一定要回這個字串，否則綠界會重複呼叫
    return res.status(200).send('1|OK');
  } catch (err) {
    console.error('ecpay-return error:', err);
    return res.status(200).send('0|Error');
  }
}

function simplePage(message) {
  return `<!DOCTYPE html>
<html lang="zh-Hant"><head><meta charset="UTF-8"><title>LIMINAL — 付款結果</title>
<style>
  body{ font-family:Arial,'Noto Sans TC',sans-serif; background:#fff; color:#111; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
  .box{ text-align:center; max-width:400px; padding:20px; }
  a{ color:#111; }
</style></head>
<body><div class="box"><h2>${message}</h2><p><a href="/#/shop">回到商店</a></p></div></body></html>`;
}
