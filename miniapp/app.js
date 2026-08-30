const tg = window.Telegram && window.Telegram.WebApp;
if (tg) { tg.ready(); tg.expand(); }

const initData = tg ? tg.initData : '';
const API = (path) => fetch(path, { headers: { 'X-Init-Data': initData } }).then(r => r.json());

let BOT_USERNAME = '';
let ME = null;
let CURRENT_PRODUCT = null;
let CURRENT_QTY = 1;
let CURRENT_RATE_ORDER_ID = null;
let PICKED_STAR = 0;

const formatRp = (n) => `Rp${Number(n || 0).toLocaleString('id-ID')}`;

const showView = (name) => {
  stopQrisPolling();
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  const el = document.getElementById(`view-${name}`);
  if (el) el.classList.remove('hidden');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.nav === name));
  if (name === 'katalog') loadCatalog();
  if (name === 'pesanan') loadOrders();
  if (name === 'referral') loadReferral();
  if (name === 'stok') loadStockLive();
  if (name === 'testimoni') loadTestimoni();
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
  document.getElementById('txCount').textContent = `${ME.transaction_count || 0} transaksi`;
  document.getElementById('btnAdminDots').classList.toggle('hidden', !ME.isAdmin);
};

// ====== TRANSAKSI PENDING (biar gak bisa generate QRIS baru selama masih ada yg belum kelar) ======
let PENDING_TX = null;

const checkPending = async () => {
  try {
    const res = await API('/api/pending');
    PENDING_TX = res.pending || null;
    const banner = document.getElementById('pendingBanner');
    if (PENDING_TX) {
      const label = PENDING_TX.type === 'topup' ? 'Top up saldo' : `Pesanan ${PENDING_TX.productName || ''}`;
      document.getElementById('pendingBannerText').textContent = `⚠ ${label} — ${formatRp(PENDING_TX.totalAmount)} belum dibayar`;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  } catch (e) { /* diamkan */ }
};

document.getElementById('btnGotoPending').addEventListener('click', () => {
  if (!PENDING_TX) return;
  showQrisView(PENDING_TX.type, {
    orderId: PENDING_TX.id, topupId: PENDING_TX.id,
    productName: PENDING_TX.productName, totalAmount: PENDING_TX.totalAmount,
    expiresAt: PENDING_TX.expiresAt, qrisImage: PENDING_TX.qrisImage
  });
});

// ====== KATALOG ======
const renderProductList = (containerId, rows, clickable) => {
  const container = document.getElementById(containerId);
  if (!rows || rows.length === 0) {
    container.innerHTML = `<div class="empty-state">💀 Belum ada produk.</div>`;
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

const starsHtml = (avg) => {
  const rounded = Math.round(avg || 0);
  let out = '';
  for (let i = 1; i <= 5; i++) out += `<span${i > rounded ? ' class="empty"' : ''}>★</span>`;
  return out;
};

const escapeHtml = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Katalog dirender sebagai grid kartu (foto + nama + harga + rating + tombol beli),
// data mentah disimpan supaya bisa diurutkan ulang tanpa fetch ulang ke server.
let CATALOG_ROWS = [];

const renderProductGrid = (rows) => {
  const container = document.getElementById('productList');
  if (!rows || rows.length === 0) {
    container.innerHTML = `<div class="empty-state">💀 Belum ada produk.</div>`;
    return;
  }
  container.innerHTML = rows.map(p => `
    <div class="grid-card" data-id="${p.id}">
      <div class="grid-photo-wrap">
        ${p.photo ? `<img src="${p.photo}" alt="${escapeHtml(p.name)}" />` : `<span class="grid-photo-placeholder">📦</span>`}
        <span class="grid-stock-pill ${p.stock_count > 0 ? 'in' : 'out'}">${p.stock_count > 0 ? 'STOK TERSEDIA' : 'STOK HABIS'}</span>
      </div>
      <div class="grid-body">
        <div class="grid-name">${escapeHtml(p.name)}</div>
        <div class="grid-price">${formatRp(p.price)}</div>
        <div class="grid-stars">${starsHtml(p.avg_rating)}</div>
        <button class="grid-buy-btn" data-id="${p.id}" ${p.stock_count > 0 ? '' : 'disabled'}>🛒 ${p.stock_count > 0 ? 'Beli Sekarang' : 'Stok Habis'}</button>
      </div>
    </div>
  `).join('');
  container.querySelectorAll('.grid-card, .grid-buy-btn').forEach(el => {
    el.addEventListener('click', (e) => { e.stopPropagation(); openProduct(el.dataset.id); });
  });
};

const applySortAndRender = () => {
  const mode = document.getElementById('sortSelect').value;
  const rows = [...CATALOG_ROWS];
  if (mode === 'termurah') rows.sort((a, b) => a.price - b.price);
  else if (mode === 'termahal') rows.sort((a, b) => b.price - a.price);
  else if (mode === 'terlaris') rows.sort((a, b) => (b.sold_count || 0) - (a.sold_count || 0));
  else rows.sort((a, b) => b.id - a.id); // terbaru
  renderProductGrid(rows);
};
document.getElementById('sortSelect').addEventListener('change', applySortAndRender);

let searchTimer = null;
document.getElementById('searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadCatalog(e.target.value.trim()), 350);
});

const loadCatalog = async (q = '') => {
  document.getElementById('productList').innerHTML = `<div class="loading-spinner">Memuat produk...</div>`;
  CATALOG_ROWS = await API(`/api/products${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  applySortAndRender();
};

const loadStockLive = async () => {
  document.getElementById('stockList').innerHTML = `<div class="loading-spinner">Memuat stok...</div>`;
  const rows = await API('/api/stock-live');
  renderProductList('stockList', rows, false);
};

// ====== PRODUCT DETAIL + QTY STEPPER ======
const openProduct = async (id) => {
  const detail = document.getElementById('productDetail');
  detail.innerHTML = `<div class="loading-spinner">Memuat detail...</div>`;
  showView('detail');
  const p = await API(`/api/products/${id}`);
  if (p.error) { detail.innerHTML = `<div class="empty-state">Produk tidak ditemukan.</div>`; return; }
  CURRENT_PRODUCT = p;
  CURRENT_QTY = Math.max(1, p.min_qty || 1);

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

  const isSimpleProduct = !p.variants || p.variants.length === 0;
  const minQty = Math.max(1, p.min_qty || 1);
  const stepperHtml = (isSimpleProduct && p.stock_count > 0) ? `
    <div class="qty-stepper">
      <div>
        <div class="qty-stepper-label">Jumlah beli</div>
        <div class="qty-sub">min. ${minQty} • stok ${p.stock_count}</div>
      </div>
      <div class="qty-controls">
        <button class="qty-btn" id="qtyMinus">−</button>
        <input type="number" id="qtyInput" class="qty-input" value="${CURRENT_QTY}" min="${minQty}" max="${p.stock_count}" inputmode="numeric" />
        <button class="qty-btn" id="qtyPlus">+</button>
      </div>
    </div>
  ` : '';

  const buyButtonsHtml = isSimpleProduct ? `
    <div class="buy-btn-group">
      <button class="btn-saldo" id="btnBuySaldo" ${p.stock_count <= 0 ? 'disabled' : ''}>💰 Bayar Pakai Saldo</button>
      <button class="btn-primary" id="btnBuyQris" ${p.stock_count <= 0 ? 'disabled' : ''}>📱 Bayar via QRIS</button>
    </div>
  ` : '';

  detail.innerHTML = `
    <div class="back-link" id="backToKatalog">← Kembali ke Katalog</div>
    ${p.photo ? `<img class="detail-photo" src="${p.photo}" />` : ''}
    <div class="detail-title">${escapeHtml(p.name)}</div>
    <div class="detail-price">${formatRp(p.price)} ${minQty > 1 ? `<span style="color:var(--hint);font-weight:400;font-size:12px">(min. beli ${minQty})</span>` : ''}</div>
    <div class="detail-stars">${starsHtml(p.avg_rating)} ${p.rating_count ? `<span class="detail-rating-count">(${p.rating_count} rating)</span>` : ''}</div>
    <span class="stock-pill ${p.stock_count > 0 ? 'in' : 'out'}" style="width:fit-content">${p.stock_count > 0 ? `${p.stock_count} Stok Tersedia` : 'Stok Habis'}</span>
    ${p.note ? `<div class="detail-note">📝 ${escapeHtml(p.note)}</div>` : ''}
    ${variantHtml}
    ${stepperHtml}
    ${buyButtonsHtml}
  `;

  document.getElementById('backToKatalog').addEventListener('click', () => showView('katalog'));

  const qtyInput = document.getElementById('qtyInput');
  const clampQty = (val) => {
    let n = parseInt(val);
    if (isNaN(n)) n = minQty;
    n = Math.max(minQty, Math.min(p.stock_count, n));
    CURRENT_QTY = n;
    if (qtyInput) qtyInput.value = n;
  };
  const qtyMinus = document.getElementById('qtyMinus');
  const qtyPlus = document.getElementById('qtyPlus');
  if (qtyMinus) qtyMinus.addEventListener('click', () => clampQty(CURRENT_QTY - 1));
  if (qtyPlus) qtyPlus.addEventListener('click', () => clampQty(CURRENT_QTY + 1));
  if (qtyInput) qtyInput.addEventListener('change', () => clampQty(qtyInput.value));

  const buySaldoBtn = document.getElementById('btnBuySaldo');
  const buyQrisBtn = document.getElementById('btnBuyQris');
  if (buySaldoBtn) buySaldoBtn.addEventListener('click', () => goBuySaldo(p.id));
  if (buyQrisBtn) buyQrisBtn.addEventListener('click', () => goBuyQris(p.id));
  detail.querySelectorAll('.variant-item').forEach(v => v.addEventListener('click', () => openProduct(v.dataset.id)));
};

const postJSON = (path, body) => fetch(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Init-Data': initData },
  body: JSON.stringify(body)
}).then(async (r) => {
  const data = await r.json();
  if (!r.ok) {
    const err = new Error(data.error || 'Gagal memproses.');
    err.pending = data.pending || null;
    throw err;
  }
  return data;
});

const goBuyQris = async (id) => {
  const btn = document.getElementById('btnBuyQris');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Membuat QRIS...'; }
  try {
    const data = await postJSON('/api/checkout/product', { prodId: id, qty: CURRENT_QTY });
    showQrisView('order', data);
  } catch (e) {
    if (e.pending) {
      alert(e.message);
      PENDING_TX = e.pending;
      showQrisView(e.pending.type, {
        orderId: e.pending.id, topupId: e.pending.id,
        productName: e.pending.productName, totalAmount: e.pending.totalAmount,
        expiresAt: e.pending.expiresAt, qrisImage: e.pending.qrisImage
      });
    } else {
      alert(e.message);
    }
    if (btn) { btn.disabled = false; btn.textContent = '📱 Bayar via QRIS'; }
  }
};

const goBuySaldo = async (id) => {
  const btn = document.getElementById('btnBuySaldo');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Memproses...'; }
  try {
    const data = await postJSON('/api/checkout/product-saldo', { prodId: id, qty: CURRENT_QTY });
    showView('saldo-success');
    document.getElementById('saldoSuccessTitle').textContent = `🎉 Pesanan #${data.orderId} — ${data.productName}`;
    document.getElementById('saldoSuccessDetail').textContent =
      `${data.qty}x • Total ${formatRp(data.totalCost)}\n\n${data.stockContents}${data.note ? `\n\n📝 ${data.note}` : ''}`;
    loadMe();
    checkPending();
  } catch (e) {
    alert(e.message);
    if (btn) { btn.disabled = false; btn.textContent = '💰 Bayar Pakai Saldo'; }
  }
};

document.getElementById('backFromSaldoSuccess').addEventListener('click', () => showView('katalog'));

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
      ${o.can_rate ? `<button class="order-rate-btn" data-order-id="${o.id}">💀 Beri Rating</button>` : ''}
      ${o.rated ? `<div class="order-rated">✓ Sudah kamu kasih rating</div>` : ''}
    </div>
  `).join('');
  list.querySelectorAll('.order-rate-btn').forEach(btn => {
    btn.addEventListener('click', () => openRatingModal(btn.dataset.orderId));
  });
};

// ====== RATING MODAL ======
const openRatingModal = (orderId) => {
  CURRENT_RATE_ORDER_ID = orderId;
  PICKED_STAR = 0;
  document.querySelectorAll('#starPicker span').forEach(s => s.classList.remove('active'));
  document.getElementById('ratingComment').value = '';
  document.getElementById('ratingModal').classList.remove('hidden');
};
document.getElementById('btnCancelRating').addEventListener('click', () => {
  document.getElementById('ratingModal').classList.add('hidden');
});
document.querySelectorAll('#starPicker span').forEach(star => {
  star.addEventListener('click', () => {
    PICKED_STAR = parseInt(star.dataset.star);
    document.querySelectorAll('#starPicker span').forEach(s => {
      s.classList.toggle('active', parseInt(s.dataset.star) <= PICKED_STAR);
    });
  });
});
document.getElementById('btnSubmitRating').addEventListener('click', async () => {
  if (!PICKED_STAR) return alert('Pilih bintangnya dulu ya.');
  const btn = document.getElementById('btnSubmitRating');
  btn.disabled = true;
  try {
    await postJSON('/api/ratings', {
      orderId: CURRENT_RATE_ORDER_ID,
      rating: PICKED_STAR,
      comment: document.getElementById('ratingComment').value
    });
    document.getElementById('ratingModal').classList.add('hidden');
    loadOrders();
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
  }
});

// ====== TESTIMONI ======
const loadTestimoni = async () => {
  const list = document.getElementById('testimoniList');
  list.innerHTML = `<div class="loading-spinner">Memuat testimoni...</div>`;
  const rows = await fetch('/api/testimonials').then(r => r.json()).catch(() => []);
  if (!rows || rows.length === 0) { list.innerHTML = `<div class="empty-state">💀 Belum ada testimoni.</div>`; return; }
  list.innerHTML = rows.map(t => `
    <div class="testimoni-card">
      <div class="testimoni-top">
        <span class="testimoni-user">${escapeHtml(t.username)}</span>
        <span class="testimoni-stars">${'★'.repeat(t.rating)}${'☆'.repeat(5 - t.rating)}</span>
      </div>
      <div class="testimoni-product">${escapeHtml(t.product_name || '')}</div>
      ${t.comment ? `<div class="testimoni-comment">${escapeHtml(t.comment)}</div>` : ''}
    </div>
  `).join('');
};

// ====== SALDO / TOPUP ======
document.querySelectorAll('.topup-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const amt = parseInt(btn.dataset.amt);
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = '⏳ Membuat QRIS...';
    try {
      const data = await postJSON('/api/checkout/topup', { amount: amt });
      showQrisView('topup', data);
    } catch (e) {
      if (e.pending) {
        alert(e.message);
        PENDING_TX = e.pending;
        showQrisView(e.pending.type, {
          orderId: e.pending.id, topupId: e.pending.id,
          productName: e.pending.productName, totalAmount: e.pending.totalAmount,
          expiresAt: e.pending.expiresAt, qrisImage: e.pending.qrisImage
        });
      } else {
        alert(e.message);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
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

// ====== QRIS PAYMENT SCREEN ======
let qrisPollTimer = null;
let qrisCountdownTimer = null;

const stopQrisPolling = () => {
  if (qrisPollTimer) { clearInterval(qrisPollTimer); qrisPollTimer = null; }
  if (qrisCountdownTimer) { clearInterval(qrisCountdownTimer); qrisCountdownTimer = null; }
};

// Unduh gambar QRIS lewat Blob, bukan langsung href data: + atribut download —
// beberapa in-app browser (termasuk webview Telegram) suka nolak/nge-skip download
// kalau langsung dari data: URL. Lewat Blob URL jauh lebih reliable.
const downloadDataUrl = async (dataUrl, filename) => {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 4000);
  } catch (e) {
    // Fallback terakhir: buka di browser luar biar user bisa simpan manual
    if (tg && tg.openLink) tg.openLink(dataUrl);
    else window.open(dataUrl, '_blank');
  }
};

let CURRENT_QRIS_DATA_URL = '';
let CURRENT_QRIS_FILENAME = 'qris-pembayaran.png';

const showQrisView = (type, data) => {
  showView('qris');
  document.getElementById('qrisTitle').textContent = type === 'topup' ? '💳 Top Up Saldo' : `🧾 Pesanan #${data.orderId} — ${data.productName || ''}`;
  document.getElementById('qrisImage').src = data.qrisImage;
  document.getElementById('qrisAmount').textContent = formatRp(data.totalAmount);
  const statusEl = document.getElementById('qrisStatus');
  const timerEl = document.getElementById('qrisTimer');
  statusEl.className = 'qris-status';
  statusEl.textContent = '⏳ Menunggu pembayaran...';
  timerEl.classList.remove('warn');

  const id = type === 'topup' ? data.topupId : data.orderId;
  CURRENT_QRIS_DATA_URL = data.qrisImage;
  CURRENT_QRIS_FILENAME = `qris-${type}-${id || Date.now()}.png`;
  document.getElementById('btnCancelTx').classList.remove('hidden');
  const statusPath = type === 'topup' ? `/api/topup-status/${id}` : `/api/order-status/${id}`;
  const cancelPath = type === 'topup' ? `/api/cancel/topup/${id}` : `/api/cancel/order/${id}`;
  document.getElementById('btnCancelTx').dataset.cancelPath = cancelPath;
  const expiresAt = new Date(data.expiresAt).getTime();

  const tick = () => {
    const diff = expiresAt - Date.now();
    if (diff <= 0) {
      timerEl.textContent = '00:00';
      timerEl.classList.add('warn');
      statusEl.className = 'qris-status failed';
      statusEl.textContent = '⌛ QRIS kadaluarsa. Buat pesanan baru ya.';
      stopQrisPolling();
      document.getElementById('btnCancelTx').classList.add('hidden');
      checkPending();
      return;
    }
    const m = Math.floor(diff / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    timerEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    if (diff < 60000) timerEl.classList.add('warn');
  };
  tick();
  qrisCountdownTimer = setInterval(tick, 1000);

  const poll = async () => {
    try {
      const res = await API(statusPath);
      if (res.status === 'APPROVED') {
        statusEl.className = 'qris-status success';
        statusEl.textContent = type === 'topup' ? '🎉 Top up berhasil! Saldo sudah ditambahkan.' : '🎉 Pembayaran dikonfirmasi! Detail dikirim ke chat bot.';
        stopQrisPolling();
        document.getElementById('btnCancelTx').classList.add('hidden');
        loadMe();
        checkPending();
      } else if (res.status === 'REJECTED' || res.status === 'EXPIRED' || res.status === 'CANCELLED') {
        statusEl.className = 'qris-status failed';
        statusEl.textContent = res.status === 'EXPIRED' ? '⌛ QRIS kadaluarsa.' : res.status === 'CANCELLED' ? '✕ Dibatalkan.' : '❌ Pembayaran ditolak.';
        stopQrisPolling();
        document.getElementById('btnCancelTx').classList.add('hidden');
        checkPending();
      }
    } catch (e) { /* diamkan, coba lagi di polling berikutnya */ }
  };
  qrisPollTimer = setInterval(poll, 4000);
  poll();
};

document.getElementById('btnDownloadQris').addEventListener('click', () => {
  if (CURRENT_QRIS_DATA_URL) downloadDataUrl(CURRENT_QRIS_DATA_URL, CURRENT_QRIS_FILENAME);
});

document.getElementById('btnCancelTx').addEventListener('click', async (e) => {
  const path = e.currentTarget.dataset.cancelPath;
  if (!path) return;
  if (!confirm('Yakin mau batalkan transaksi ini?')) return;
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await postJSON(path, {});
    stopQrisPolling();
    document.getElementById('qrisStatus').className = 'qris-status failed';
    document.getElementById('qrisStatus').textContent = '✕ Transaksi dibatalkan.';
    btn.classList.add('hidden');
    checkPending();
  } catch (e2) {
    alert(e2.message);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('backFromQris').addEventListener('click', () => { showView('home'); checkPending(); });

// ====================================================================
// ====== DASHBOARD ADMIN (drawer kiri, cuma muncul buat admin) ======
// ====================================================================
const adminDrawer = document.getElementById('adminDrawer');
const adminOverlay = document.getElementById('adminOverlay');

const openAdminDrawer = () => {
  adminDrawer.classList.add('open');
  adminOverlay.classList.remove('hidden');
  loadAdminProducts();
};
const closeAdminDrawer = () => {
  adminDrawer.classList.remove('open');
  adminOverlay.classList.add('hidden');
};
document.getElementById('btnAdminDots').addEventListener('click', openAdminDrawer);
document.getElementById('btnCloseAdmin').addEventListener('click', closeAdminDrawer);
adminOverlay.addEventListener('click', closeAdminDrawer);

document.querySelectorAll('.drawer-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.drawer-tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.drawer-pane').forEach(p => p.classList.add('hidden'));
    document.getElementById(`pane-${tab.dataset.tab}`).classList.remove('hidden');
    if (tab.dataset.tab === 'produk') loadAdminProducts();
    if (tab.dataset.tab === 'toko') loadAdminStore();
    if (tab.dataset.tab === 'testimoni') loadAdminRatings();
  });
});

// Ubah file gambar yang dipilih admin jadi data URL (base64) buat disimpan di DB,
// sama kayak cara qris_image disimpan di sistem ini — gak butuh server upload terpisah.
const fileToDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = reject;
  reader.readAsDataURL(file);
});

const loadAdminProducts = async () => {
  const list = document.getElementById('adminProductList');
  list.innerHTML = `<div class="loading-spinner">Memuat produk...</div>`;
  const rows = await API('/api/admin/products');
  if (!rows || rows.length === 0) { list.innerHTML = `<div class="empty-state">Belum ada produk.</div>`; return; }
  list.innerHTML = rows.map(p => `
    <div class="admin-card">
      <div class="admin-card-title">${escapeHtml(p.name)} ${p.parent_id ? '(varian)' : ''}</div>
      <label class="admin-photo-preview" data-id="${p.id}">
        ${p.photo ? `<img src="${p.photo}" />` : '📷 Tap buat pasang foto produk'}
        <input type="file" accept="image/*" class="admin-photo-input" />
      </label>
      <div class="admin-field-row"><label>Harga</label><input type="number" class="admin-price" value="${p.price}" /></div>
      <div class="admin-field-row"><label>Min. Beli</label><input type="number" class="admin-minqty" value="${p.min_qty || 1}" min="1" /></div>
      <label class="admin-label" style="margin-top:2px">Deskripsi Produk</label>
      <textarea class="admin-input admin-note-textarea" placeholder="Deskripsi/catatan produk...">${escapeHtml(p.note || '')}</textarea>
      <button class="admin-save-btn" data-id="${p.id}">💾 Simpan</button>
    </div>
  `).join('');

  list.querySelectorAll('.admin-photo-preview').forEach(label => {
    const input = label.querySelector('.admin-photo-input');
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      if (file.size > 4 * 1024 * 1024) return alert('Ukuran foto maksimal 4MB ya.');
      const dataUrl = await fileToDataUrl(file);
      label.dataset.newPhoto = dataUrl;
      label.innerHTML = `<img src="${dataUrl}" />`;
      label.appendChild(input);
    });
  });

  list.querySelectorAll('.admin-save-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.admin-card');
      const price = card.querySelector('.admin-price').value;
      const minQty = card.querySelector('.admin-minqty').value;
      const note = card.querySelector('.admin-note-textarea').value;
      const photoLabel = card.querySelector('.admin-photo-preview');
      const body = { price, min_qty: minQty, note };
      if (photoLabel.dataset.newPhoto) body.photo = photoLabel.dataset.newPhoto;
      btn.disabled = true; btn.textContent = '⏳...';
      try {
        await postJSON(`/api/admin/products/${btn.dataset.id}`, body);
        btn.textContent = '✔ Tersimpan';
        delete photoLabel.dataset.newPhoto;
      } catch (e) {
        alert(e.message);
        btn.textContent = '💾 Simpan';
      } finally {
        btn.disabled = false;
        setTimeout(() => { btn.textContent = '💾 Simpan'; }, 1500);
      }
    });
  });
};

// ====== ADMIN: KELOLA USER (saldo & tier, sinkron sama bot Telegram) ======
let ADMIN_VIEWED_USER = null;

document.getElementById('btnLoadUser').addEventListener('click', async () => {
  const uid = document.getElementById('adminUserId').value.trim();
  if (!uid) return alert('Masukkan ID Telegram user dulu.');
  const btn = document.getElementById('btnLoadUser');
  btn.disabled = true;
  try {
    const data = await API(`/api/admin/user/${uid}`);
    ADMIN_VIEWED_USER = uid;
    document.getElementById('adminUserResult').classList.remove('hidden');
    document.getElementById('adminUserBalance').textContent = formatRp(data.balance);
    document.getElementById('adminUserTier').textContent = data.tier;
    document.getElementById('adminUserTx').textContent = data.transaction_count || 0;
    document.querySelectorAll('.tier-btn').forEach(b => b.classList.toggle('active', b.dataset.tier === data.tier));
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
  }
});

const adjustSaldo = async (mode) => {
  if (!ADMIN_VIEWED_USER) return alert('Cari user dulu.');
  const amount = document.getElementById('adminUserAmount').value;
  if (!amount || parseInt(amount) <= 0) return alert('Masukkan nominal yang valid.');
  try {
    const data = await postJSON(`/api/admin/user/${ADMIN_VIEWED_USER}/balance`, { amount, mode });
    document.getElementById('adminUserBalance').textContent = formatRp(data.balance);
    document.getElementById('adminUserAmount').value = '';
  } catch (e) {
    alert(e.message);
  }
};
document.getElementById('btnAddSaldo').addEventListener('click', () => adjustSaldo('add'));
document.getElementById('btnSubSaldo').addEventListener('click', () => adjustSaldo('subtract'));

document.querySelectorAll('.tier-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    if (!ADMIN_VIEWED_USER) return alert('Cari user dulu.');
    try {
      await postJSON(`/api/admin/user/${ADMIN_VIEWED_USER}/tier`, { tier: btn.dataset.tier });
      document.getElementById('adminUserTier').textContent = btn.dataset.tier;
      document.querySelectorAll('.tier-btn').forEach(b => b.classList.toggle('active', b === btn));
    } catch (e) {
      alert(e.message);
    }
  });
});

const loadAdminStore = async () => {
  const store = await API('/api/admin/store');
  document.getElementById('adminStoreName').value = store.name || '';
  document.getElementById('adminStoreDesc').value = store.desc || '';
};
document.getElementById('btnSaveStore').addEventListener('click', async () => {
  const btn = document.getElementById('btnSaveStore');
  btn.disabled = true;
  try {
    await postJSON('/api/admin/store', {
      name: document.getElementById('adminStoreName').value,
      desc: document.getElementById('adminStoreDesc').value
    });
    loadStore();
    alert('Tersimpan.');
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
  }
});

const loadAdminRatings = async () => {
  const list = document.getElementById('adminRatingList');
  list.innerHTML = `<div class="loading-spinner">Memuat testimoni...</div>`;
  const rows = await API('/api/admin/ratings');
  if (!rows || rows.length === 0) { list.innerHTML = `<div class="empty-state">Belum ada testimoni.</div>`; return; }
  list.innerHTML = rows.map(t => `
    <div class="admin-card">
      <div class="admin-rating-top">
        <span class="testimoni-user">${escapeHtml(t.username)}</span>
        <button class="admin-rating-del" data-id="${t.id}">🗑</button>
      </div>
      <div class="testimoni-stars">${'★'.repeat(t.rating)}${'☆'.repeat(5 - t.rating)}</div>
      <div class="testimoni-product">${escapeHtml(t.product_name || '')}</div>
      ${t.comment ? `<div class="testimoni-comment">${escapeHtml(t.comment)}</div>` : ''}
    </div>
  `).join('');
  list.querySelectorAll('.admin-rating-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Hapus testimoni ini?')) return;
      await fetch(`/api/admin/ratings/${btn.dataset.id}`, { method: 'DELETE', headers: { 'X-Init-Data': initData } });
      loadAdminRatings();
    });
  });
};

// ====== INIT ======
(async () => {
  try {
    await loadStore();
    await loadMe();
    await checkPending();
  } catch (e) {
    console.error(e);
  }
})();
