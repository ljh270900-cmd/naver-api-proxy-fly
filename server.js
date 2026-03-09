import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Proxy-Secret');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const NAVER_CLIENT_ID = process.env.NAVER_COMMERCE_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_COMMERCE_CLIENT_SECRET;
const PROXY_SECRET = process.env.PROXY_SECRET;
const NAVER_API_BASE = 'https://api.commerce.naver.com/external';

async function getNaverToken() {
  const timestamp = String(Date.now());
  const password = `${NAVER_CLIENT_ID}_${timestamp}`;
  const bcrypt = await import('bcryptjs');
  const hashed = bcrypt.hashSync(password, NAVER_CLIENT_SECRET);
  const clientSecretSign = Buffer.from(hashed).toString('base64');
  const params = new URLSearchParams({
    client_id: NAVER_CLIENT_ID, timestamp,
    client_secret_sign: clientSecretSign,
    grant_type: 'client_credentials', type: 'SELF',
  });
  const res = await fetch(`${NAVER_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) throw new Error(`Token failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  if (!data.access_token) throw new Error(`No token: ${JSON.stringify(data)}`);
  return data.access_token;
}

function authenticate(req, res, next) {
  if (!PROXY_SECRET || req.headers['x-proxy-secret'] !== PROXY_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function toKstIsoString(date) {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth()+1).padStart(2,'0')}-${String(kst.getUTCDate()).padStart(2,'0')}T${String(kst.getUTCHours()).padStart(2,'0')}:${String(kst.getUTCMinutes()).padStart(2,'0')}:${String(kst.getUTCSeconds()).padStart(2,'0')}.${String(kst.getUTCMilliseconds()).padStart(3,'0')}+09:00`;
}

async function fetchOrders(token, from, to) {
  const all = []; let page = 1;
  const statuses = ["PAYMENT_WAITING","PAYED","DELIVERING","DELIVERED","PURCHASE_DECIDED","EXCHANGED","CANCELED","CANCELED_BY_NOPAYMENT","RETURNED"];
  while (true) {
    const params = new URLSearchParams();
    params.append("from", from); params.append("to", to);
    params.append("rangeType", "PAYED_DATETIME");
    params.append("pageSize", "300"); params.append("page", String(page));
    for (const s of statuses) params.append("productOrderStatuses", s);
    const res = await fetch(`${NAVER_API_BASE}/v1/pay-order/seller/product-orders?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    const raw = await res.text();
    if (!res.ok) throw new Error(`Orders failed: ${res.status} ${raw}`);
    const result = raw ? JSON.parse(raw) : null;
    const rows = result?.data?.contents || result?.data || result?.contents || [];
    const orders = Array.isArray(rows) ? rows : [];
    all.push(...orders);
    const tp = result?.data?.pagination?.totalPages;
    if (typeof tp === "number" && page >= tp) break;
    if (orders.length < 300) break;
    if (++page > 200) break;
    await new Promise(r => setTimeout(r, 200));
  }
  return all;
}

app.post('/api/test', authenticate, async (req, res) => {
  try { await getNaverToken(); res.json({ success: true, message: '연결 성공!' }); }
  catch (e) { res.json({ success: false, message: `실패: ${e.message}` }); }
});

app.post('/api/sync', authenticate, async (req, res) => {
  try {
    const { fromDate, toDate } = req.body;
    const token = await getNaverToken();
    const end = toDate || new Date().toISOString().split('T')[0];
    const start = fromDate || new Date(Date.now() - 7*24*60*60*1000).toISOString().split('T')[0];
    const unique = new Map();
    let cur = new Date(`${start}T00:00:00+09:00`);
    const endD = new Date(`${end}T23:59:59+09:00`);
    while (cur < endD) {
      const wEnd = new Date(cur.getTime() + 86400000);
      const eff = wEnd > endD ? endD : wEnd;
      try {
        const orders = await fetchOrders(token, toKstIsoString(cur), toKstIsoString(eff));
        for (const item of orders) {
          const po = item?.productOrder || item || {};
          const o = item?.order || item || {};
          const key = po.productOrderId || item?.productOrderId || o.orderId || item?.orderId;
          if (key) unique.set(key, item);
        }
      } catch(e) { console.error(`Window error: ${e.message}`); }
      cur = wEnd;
      await new Promise(r => setTimeout(r, 300));
    }
    const mapped = [...unique.values()].map(item => {
      const o = item?.order || item || {}, po = item?.productOrder || item || {};
      const status = po.productOrderStatus || item?.productOrderStatus;
      const total = po.totalPaymentAmount || item?.totalPaymentAmount || 0;
      const claim = po.claimStatus || item?.claimStatus || '';
      return {
        orderId: o.orderId || item?.orderId,
        productOrderId: po.productOrderId || item?.productOrderId,
        orderDate: o.orderDate || item?.orderDate,
        paymentDate: o.paymentDate || item?.paymentDate,
        productOrderStatus: status, totalPaymentAmount: total,
        productName: po.productName || item?.productName,
        quantity: po.quantity || item?.quantity || 1,
        unitPrice: po.unitPrice || item?.unitPrice || 0,
        buyerName: o.ordererName || item?.buyerName || item?.ordererName,
        shippingFeeAmount: po.deliveryFeeAmount || item?.deliveryFeeAmount || item?.shippingFeeAmount || 0,
        commissionAmount: po.commissionAmount || item?.commissionAmount || 0,
        cancelAmount: String(claim).includes('CANCEL') ? total : 0,
        refundAmount: String(claim).includes('RETURN') ? total : 0,
        sellerProductCode: po.sellerProductCode || item?.sellerProductCode,
      };
    });
    res.json({ success: true, orders: mapped, totalFetched: mapped.length });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/ip', async (req, res) => {
  try { const r = await fetch('https://api.ipify.org?format=json'); res.json(await r.json()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Proxy running on ${PORT}`));
