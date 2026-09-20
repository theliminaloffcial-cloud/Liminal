// api/ecpay-order-result.js
//
// 這支是 ECPay 的 OrderResultURL：付款完成後，ECPay 會把「客人的瀏覽器」導回這裡
// （用 POST 表單的方式），這支只負責把客人導向網站上一個好看的「感謝購買」頁面，
// 不做任何訂單狀態的判斷或資料庫寫入——真正的訂單狀態更新一律以 api/ecpay-return.js
// 收到的「伺服器對伺服器」通知為準（因為客人有可能在導回這一步之前就關掉瀏覽器）。

const SITE_URL = process.env.SITE_URL || 'https://liminal-site-8.vercel.app';

export default function handler(req, res) {
  // 不管 ECPay 是用 POST 還是 GET 導過來，一律導向網站裡的「訂購完成」頁面
  res.writeHead(302, { Location: `${SITE_URL}/#/order-complete` });
  res.end();
}
