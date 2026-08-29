const tg = window.Telegram && window.Telegram.WebApp;
if (tg) { tg.ready(); tg.expand(); }

const initData = tg ? tg.initData : '';
const API = (path) => fetch(path, { headers: { 'X-Init-Data': initData } }).then(r => r.json());

let BOT_USERNAME = '';
let ME = null;

const formatRp = (n) => `Rp${Number(n || 0).toLocaleString('id-ID')}`;

const showView = (name) => {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  const el = document.getElementById(`view-${name}`);
  if (el) el.classList.remove('hidden');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.nav === name));
  if (name === 'katalog') loadCatalog();
  if (name === 'pesanan') loadOrders();
  if (name === 'referral') loadReferral();
  if (name === 'stok') loadStockLive();
};

// ====== NAVIGATION ======
document.querySelectorAll('[data-nav]').forEach(btn => {
  btn.addEventListener('click', () => showView(btn.dataset.nav));
});

// ====== HOME / STORE INFO ======
const loadStore = async () => {
  const store = await API('/api/store');
  BOT_USERNAME = store.bot_username || '';
  document.getElementById('storeName').textContent = store.name || 'Toko Digital';
  document.getElementById('storeDesc').textContent = store.desc || '';
  const img = document.getElementById('storePhoto');
  const initial = document.getElementById('storeInitial');
  if (store.photo) {
    img.onload = () => { img.style.display = 'block'; initial.style.display = 'none'; };
    img.onerror = () => { img.style.display = 'none'; initial.style.display = 'flex'; };
    img.src = store.photo;
  }
};

const loadMe = async () => {
  ME = await API('/api/me');
  document.getElementById('tierBadge').textContent = ME.tier || 'Bronze';
  document.getElementById('balanceAmount').textContent = ME.balance === null ? '∞ (Unlimited)' : formatRp(ME.balance);
};

// ====== KATALOG ======
const renderProductList = (containerId, rows, clickable) => {
  const container = document.getElementById(containerId);
  if (!rows || rows.length === 0) {
    container.innerHTML = `<div class="empty-state">Belum ada produk.</div>`;
    return;
  }
  container.innerHTML = rows.map(p => `
    <div class="product-card" ${clickable ? `data-id="${p.id}"` : ''}>
      <div>
        <div class="product-name">${escapeHtml(p.name)}</div>
        <div class="product-price">${formatRp(p.price)}</div>
      </div>
      <span class="stock-pill ${p.stock_count > 0 ? 'in' : 'out'}">${p.stock_count > 0 ? `${p.stock_count} Tersedia` : 'Habis'}</span>
    </div>
  `).join('');
  if (clickable) {
    container.querySelectorAll('.product-card').forEach(card => {
      card.addEventListener('click', () => openProduct(card.dataset.id));
    });
  }
};

const escapeHtml = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let searchTimer = null;
document.getElementById('searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadCatalog(e.target.value.trim()), 350);
});

const loadCatalog = async (q = '') => {
  document.getElementById('productList').innerHTML = `<div class="loading-spinner">Memuat produk...</div>`;
  const rows = await API(`/api/products${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  renderProductList('productList', rows, true);
};

const loadStockLive = async () => {
  document.getElementById('stockList').innerHTML = `<div class="loading-spinner">Memuat stok...</div>`;
  const rows = await API('/api/stock-live');
  renderProductList('stockList', rows, false);
};

// ====== PRODUCT DETAIL ======
const openProduct = async (id) => {
  const detail = document.getElementById('productDetail');
  detail.innerHTML = `<div class="loading-spinner">Memuat detail...</div>`;
  showView('detail');
  const p = await API(`/api/products/${id}`);
  if (p.error) { detail.innerHTML = `<div class="empty-state">Produk tidak ditemukan.</div>`; return; }

  let variantHtml = '';
  if (p.variants && p.variants.length > 0) {
    variantHtml = `<div class="variant-list">${p.variants.map(v => `
      <div class="variant-item" data-id="${v.id}">
        <div>
          <div class="product-name">${escapeHtml(v.name)}</div>
          <div class="product-price">${formatRp(v.price)}</div>
        </div>
        <span class="stock-pill ${v.stock_count > 0 ? 'in' : 'out'}">${v.stock_count > 0 ? `${v.stock_count} Tersedia` : 'Habis'}</span>
      </div>
    `).join('')}</div>`;
  }

  detail.innerHTML = `
    <div class="back-link" id="backToKatalog">← Kembali ke Katalog</div>
    ${p.photo ? `<img class="detail-photo" src="${p.photo}" />` : ''}
    <div class="detail-title">${escapeHtml(p.name)}</div>
    <div class="detail-price">${formatRp(p.price)} ${p.min_qty > 1 ? `<span style="color:var(--hint);font-weight:400;font-size:12px">(min. beli ${p.min_qty})</span>` : ''}</div>
    <span class="stock-pill ${p.stock_count > 0 ? 'in' : 'out'}" style="width:fit-content">${p.stock_count > 0 ? `${p.stock_count} Stok Tersedia` : 'Stok Habis'}</span>
    ${p.note ? `<div class="detail-note">📝 ${escapeHtml(p.note)}</div>` : ''}
    ${variantHtml}
    ${(!p.variants || p.variants.length === 0) ? `<button class="btn-primary" id="btnBuy">🛒 Beli Sekarang</button>` : ''}
  `;

  document.getElementById('backToKatalog').addEventListener('click', () => showView('katalog'));
  const buyBtn = document.getElementById('btnBuy');
  if (buyBtn) buyBtn.addEventListener('click', () => goBuy(p.id));
  detail.querySelectorAll('.variant-item').forEach(v => v.addEventListener('click', () => openProduct(v.dataset.id)));
};

const goBuy = (id) => {
  if (!tg || !BOT_USERNAME) return alert('Buka mini app ini dari dalam Telegram ya.');
  tg.openTelegramLink(`https://t.me/${BOT_USERNAME}?start=buy_${id}`);
  tg.close();
};

// ====== PESANAN ======
const loadOrders = async () => {
  const list = document.getElementById('orderList');
  list.innerHTML = `<div class="loading-spinner">Memuat pesanan...</div>`;
  const rows = await API('/api/orders');
  if (!rows || rows.length === 0) { list.innerHTML = `<div class="empty-state">Belum ada pesanan.</div>`; return; }
  list.innerHTML = rows.map(o => `
    <div class="order-card">
      <div class="order-top">
        <span class="order-id">Order #${o.id} — ${escapeHtml(o.product_name || 'Produk')}</span>
        <span class="order-status ${String(o.status || '').toLowerCase()}">${o.status}</span>
      </div>
      <div class="order-meta">${o.quantity || 1}x • ${formatRp(o.amount)} • ${o.created_at || ''}</div>
    </div>
  `).join('');
};

// ====== SALDO / TOPUP ======
document.querySelectorAll('.topup-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!tg || !BOT_USERNAME) return alert('Buka mini app ini dari dalam Telegram ya.');
    tg.openTelegramLink(`https://t.me/${BOT_USERNAME}?start=topup_${btn.dataset.amt}`);
    tg.close();
  });
});

// ====== REFERRAL ======
const loadReferral = async () => {
  const r = await API('/api/referral');
  document.getElementById('referralLink').textContent = r.link;
  document.getElementById('referralCount').textContent = `${r.total_referred} orang diundang`;
};
document.getElementById('btnCopyRef').addEventListener('click', () => {
  const link = document.getElementById('referralLink').textContent;
  navigator.clipboard.writeText(link).then(() => {
    if (tg) tg.showPopup ? tg.showPopup({ message: 'Link referral disalin!' }) : alert('Link disalin!');
    else alert('Link disalin!');
  }).catch(() => alert('Gagal menyalin, salin manual ya.'));
});

// ====== CS ======
document.getElementById('btnCS').addEventListener('click', () => {
  if (!tg || !BOT_USERNAME) return alert('Buka mini app ini dari dalam Telegram ya.');
  tg.openTelegramLink(`https://t.me/${BOT_USERNAME}?start=cs`);
  tg.close();
});

// ====== INIT ======
(async () => {
  try {
    await loadStore();
    await loadMe();
  } catch (e) {
    console.error(e);
  }
})();
