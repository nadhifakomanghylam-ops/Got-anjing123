const { Telegraf, Markup } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Menyimpan instance bot sewaan yang sedang berjalan: rentalId -> { bot, db }
const activeInstances = {};

function initRentalDb(dbDir, rentalId) {
  const dbPath = path.join(dbDir, `rental_${rentalId}.db`);
  const db = new sqlite3.Database(dbPath);
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS store (
      id INTEGER PRIMARY KEY,
      name TEXT, desc TEXT, photo TEXT, qris TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, price INTEGER, photo TEXT DEFAULT ''
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS stock_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER, content TEXT, status TEXT DEFAULT 'AVAILABLE'
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, username TEXT, product_id INTEGER,
      quantity INTEGER DEFAULT 1, status TEXT DEFAULT 'PENDING', proof TEXT, amount INTEGER DEFAULT 0, created_at TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS visitors (
      user_id INTEGER PRIMARY KEY, username TEXT, first_name TEXT, joined_at TEXT
    )`);
    db.get(`SELECT * FROM store WHERE id = 1`, (err, row) => {
      if (!row) {
        db.run(`INSERT INTO store (id, name, desc, photo, qris) VALUES (1, '🛍️ Toko Baru', 'Selamat datang! Admin toko ini belum mengatur profil tokonya.', '', '')`);
      }
    });
  });
  return db;
}

function launchRentedBot(token, adminId, rentalId, dbDir) {
  // Kalau instance dengan rentalId ini sudah jalan, matikan dulu supaya tidak dobel polling
  if (activeInstances[rentalId]) {
    try { activeInstances[rentalId].bot.stop('relaunch'); } catch (e) {}
    delete activeInstances[rentalId];
  }

  const db = initRentalDb(dbDir, rentalId);
  const bot = new Telegraf(token);
  const userState = {};
  const isAdmin = (id) => Number(id) === Number(adminId);

  const safeClearAndSend = async (ctx, text, extra = {}) => {
    try { await ctx.deleteMessage(); } catch (e) {}
    if (extra.photo) return ctx.replyWithPhoto(extra.photo, { caption: text, parse_mode: 'Markdown', ...extra });
    return ctx.replyWithMarkdown(text, extra);
  };

  const getMainMenu = (userId) => {
    const buttons = [
      [Markup.button.callback('🛒 Katalog', 'r_catalog')],
      [Markup.button.callback('📦 Pesanan Saya', 'r_my_orders')]
    ];
    if (isAdmin(userId)) buttons.push([Markup.button.callback('⚙️ Dashboard Admin', 'r_admin')]);
    return Markup.inlineKeyboard(buttons);
  };

  const getAdminMenu = () => Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Edit Info Toko', 'r_edit_store'), Markup.button.callback('🧾 Set Foto QRIS', 'r_set_qris')],
    [Markup.button.callback('➕ Tambah Produk', 'r_add_prod'), Markup.button.callback('🗑️ Hapus Produk', 'r_del_prod')],
    [Markup.button.callback('📦 Tambah Stok', 'r_add_stock')],
    [Markup.button.callback('🔙 Menu Utama', 'r_main')]
  ]);

  // ===== USER =====
  bot.start((ctx) => {
    const userId = ctx.from.id;
    const username = ctx.from.username ? `@${ctx.from.username}` : '';
    db.run(`INSERT OR IGNORE INTO visitors (user_id, username, first_name, joined_at) VALUES (?, ?, ?, ?)`,
      [userId, username, ctx.from.first_name || '', new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })]);
    db.get(`SELECT * FROM store WHERE id = 1`, (err, store) => {
      const text = `🏬 *${store.name}*\n\n${store.desc}`;
      if (store.photo) ctx.replyWithPhoto(store.photo, { caption: text, parse_mode: 'Markdown', ...getMainMenu(userId) });
      else ctx.replyWithMarkdown(text, getMainMenu(userId));
    });
  });

  bot.action('r_main', (ctx) => {
    ctx.answerCbQuery();
    db.get(`SELECT * FROM store WHERE id = 1`, (err, store) => {
      safeClearAndSend(ctx, `🏬 *${store.name}*\n\n${store.desc}`, getMainMenu(ctx.from.id));
    });
  });

  bot.action('r_catalog', (ctx) => {
    ctx.answerCbQuery();
    db.all(`SELECT * FROM products`, (err, rows) => {
      if (!rows || rows.length === 0) {
        return safeClearAndSend(ctx, '🛒 *KATALOG*\n\nBelum ada produk.', Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali', 'r_main')]]));
      }
      const buttons = rows.map(p => [Markup.button.callback(`${p.name} - Rp${p.price.toLocaleString('id-ID')}`, `r_buy_${p.id}`)]);
      buttons.push([Markup.button.callback('🔙 Kembali', 'r_main')]);
      safeClearAndSend(ctx, '🛒 *KATALOG PRODUK*', Markup.inlineKeyboard(buttons));
    });
  });

  bot.action(/^r_buy_(\d+)$/, (ctx) => {
    ctx.answerCbQuery();
    db.get(`SELECT * FROM products WHERE id = ?`, [ctx.match[1]], (err, prod) => {
      if (!prod) return;
      safeClearAndSend(ctx, `📦 *${prod.name}*\n\n💰 Harga: Rp${prod.price.toLocaleString('id-ID')}`, Markup.inlineKeyboard([
        [Markup.button.callback('💳 Beli Sekarang', `r_order_${prod.id}`)],
        [Markup.button.callback('🔙 Kembali', 'r_catalog')]
      ]));
    });
  });

  bot.action(/^r_order_(\d+)$/, (ctx) => {
    ctx.answerCbQuery();
    const userId = ctx.from.id;
    const username = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'Buyer');
    db.get(`SELECT * FROM products WHERE id = ?`, [ctx.match[1]], (err, prod) => {
      if (!prod) return;
      const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
      db.run(`INSERT INTO orders (user_id, username, product_id, quantity, status, amount, created_at) VALUES (?, ?, ?, 1, 'PENDING', ?, ?)`,
        [userId, username, prod.id, prod.price, now], function (err) {
          const orderId = this.lastID;
          userState[userId] = { step: 'R_UPLOAD_PROOF', orderId };
          const text = `🧾 *PESANAN #${orderId}*\n\n📦 ${prod.name}\n💰 Total: Rp${prod.price.toLocaleString('id-ID')}\n\nSilakan transfer, lalu kirim *foto bukti transfer* ke chat ini.`;
          db.get(`SELECT qris FROM store WHERE id = 1`, (err, store) => {
            if (store && store.qris) ctx.replyWithPhoto(store.qris, { caption: text, parse_mode: 'Markdown' });
            else ctx.replyWithMarkdown(text);
          });
        });
    });
  });

  bot.action('r_my_orders', (ctx) => {
    ctx.answerCbQuery();
    db.all(`SELECT o.*, p.name as pname FROM orders o JOIN products p ON o.product_id = p.id WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 10`, [ctx.from.id], (err, rows) => {
      if (!rows || rows.length === 0) return safeClearAndSend(ctx, '📦 Belum ada pesanan.', Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali', 'r_main')]]));
      let text = '📦 *PESANAN SAYA*\n\n';
      rows.forEach(o => { text += `#${o.id} ${o.pname} - ${o.status}\n`; });
      safeClearAndSend(ctx, text, Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali', 'r_main')]]));
    });
  });

  // ===== ADMIN (khusus admin_id yang didaftarkan penyewa) =====
  bot.action('r_admin', (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    ctx.answerCbQuery();
    safeClearAndSend(ctx, '⚙️ *DASHBOARD ADMIN*', getAdminMenu());
  });

  bot.action('r_edit_store', (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    ctx.answerCbQuery();
    userState[ctx.from.id] = { step: 'R_EDIT_NAME' };
    ctx.reply('Masukkan Nama Toko Baru:');
  });

  bot.action('r_set_qris', (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    ctx.answerCbQuery();
    userState[ctx.from.id] = { step: 'R_SET_QRIS' };
    ctx.reply('Kirim foto QRIS toko kamu:');
  });

  bot.action('r_add_prod', (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    ctx.answerCbQuery();
    userState[ctx.from.id] = { step: 'R_ADD_PROD_NAME' };
    ctx.reply('Masukkan Nama Produk:');
  });

  bot.action('r_del_prod', (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    ctx.answerCbQuery();
    db.all(`SELECT * FROM products`, (err, rows) => {
      if (!rows || rows.length === 0) return ctx.reply('Belum ada produk.');
      const buttons = rows.map(p => [Markup.button.callback(`🗑️ ${p.name}`, `r_delprod_${p.id}`)]);
      buttons.push([Markup.button.callback('🔙 Kembali', 'r_admin')]);
      safeClearAndSend(ctx, 'Pilih produk yang mau dihapus:', Markup.inlineKeyboard(buttons));
    });
  });

  bot.action(/^r_delprod_(\d+)$/, (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    db.run(`DELETE FROM products WHERE id = ?`, [ctx.match[1]]);
    db.run(`DELETE FROM stock_items WHERE product_id = ?`, [ctx.match[1]]);
    ctx.answerCbQuery('✅ Produk dihapus.', { show_alert: true });
  });

  bot.action('r_add_stock', (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    ctx.answerCbQuery();
    db.all(`SELECT * FROM products`, (err, rows) => {
      if (!rows || rows.length === 0) return ctx.reply('⚠️ Tambah produk dulu sebelum menambah stok.');
      const buttons = rows.map(p => [Markup.button.callback(p.name, `r_stockfor_${p.id}`)]);
      buttons.push([Markup.button.callback('🔙 Kembali', 'r_admin')]);
      safeClearAndSend(ctx, 'Pilih produk untuk ditambah stok:', Markup.inlineKeyboard(buttons));
    });
  });

  bot.action(/^r_stockfor_(\d+)$/, (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    ctx.answerCbQuery();
    userState[ctx.from.id] = { step: 'R_ADD_STOCK', prodId: ctx.match[1] };
    ctx.reply('Kirim daftar stok (1 baris = 1 item):');
  });

  bot.action(/^r_approve_(\d+)$/, (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    const orderId = ctx.match[1];
    db.get(`SELECT * FROM orders WHERE id = ?`, [orderId], (err, order) => {
      if (!order) return ctx.answerCbQuery('Tidak ditemukan.', { show_alert: true });
      db.all(`SELECT * FROM stock_items WHERE product_id = ? AND status = 'AVAILABLE' LIMIT ?`, [order.product_id, order.quantity], (err, stocks) => {
        if (!stocks || stocks.length < order.quantity) return ctx.answerCbQuery('⚠️ Stok kurang!', { show_alert: true });
        const ids = stocks.map(s => s.id);
        const content = stocks.map(s => s.content).join('\n---\n');
        db.run(`UPDATE orders SET status = 'APPROVED' WHERE id = ?`, [orderId]);
        db.run(`UPDATE stock_items SET status = 'SOLD' WHERE id IN (${ids.join(',')})`);
        bot.telegram.sendMessage(order.user_id, `🎉 *PEMBAYARAN DIKONFIRMASI!*\n\n\`\`\`\n${content}\n\`\`\``, { parse_mode: 'Markdown' }).catch(() => {});
        ctx.answerCbQuery('✅ Disetujui & produk dikirim.', { show_alert: true });
        ctx.editMessageCaption ? ctx.editMessageCaption(`✅ APPROVED - Order #${orderId}`).catch(() => {}) : null;
      });
    });
  });

  bot.action(/^r_reject_(\d+)$/, (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    const orderId = ctx.match[1];
    db.get(`SELECT * FROM orders WHERE id = ?`, [orderId], (err, order) => {
      if (!order) return ctx.answerCbQuery('Tidak ditemukan.', { show_alert: true });
      db.run(`UPDATE orders SET status = 'REJECTED' WHERE id = ?`, [orderId]);
      bot.telegram.sendMessage(order.user_id, `❌ Bukti transfer pesanan #${orderId} ditolak. Hubungi admin bila ada kendala.`).catch(() => {});
      ctx.answerCbQuery('Ditolak.', { show_alert: true });
      ctx.editMessageCaption ? ctx.editMessageCaption(`❌ REJECTED - Order #${orderId}`).catch(() => {}) : null;
    });
  });

  // ===== TEXT HANDLER =====
  bot.on('text', (ctx) => {
    const userId = ctx.from.id;
    const state = userState[userId];
    if (!state) return;

    if (isAdmin(userId)) {
      if (state.step === 'R_EDIT_NAME') {
        userState[userId] = { step: 'R_EDIT_DESC', name: ctx.message.text.trim() };
        return ctx.reply('Masukkan Deskripsi Toko:');
      }
      if (state.step === 'R_EDIT_DESC') {
        db.run(`UPDATE store SET name = ?, desc = ? WHERE id = 1`, [state.name, ctx.message.text.trim()]);
        delete userState[userId];
        return ctx.reply('✅ Info toko berhasil diperbarui.');
      }
      if (state.step === 'R_ADD_PROD_NAME') {
        userState[userId] = { step: 'R_ADD_PROD_PRICE', name: ctx.message.text.trim() };
        return ctx.reply('Masukkan Harga Produk (angka saja):');
      }
      if (state.step === 'R_ADD_PROD_PRICE') {
        const price = parseInt(ctx.message.text.trim());
        if (isNaN(price)) return ctx.reply('⚠️ Masukkan angka yang valid!');
        db.run(`INSERT INTO products (name, price) VALUES (?, ?)`, [state.name, price]);
        delete userState[userId];
        return ctx.reply('✅ Produk berhasil ditambahkan! Jangan lupa tambah stoknya juga.');
      }
      if (state.step === 'R_ADD_STOCK') {
        const lines = ctx.message.text.split('\n').map(i => i.trim()).filter(i => i);
        if (lines.length === 0) return ctx.reply('⚠️ Tidak ada stok terdeteksi.');
        const stmt = db.prepare(`INSERT INTO stock_items (product_id, content) VALUES (?, ?)`);
        lines.forEach(l => stmt.run(state.prodId, l));
        stmt.finalize();
        delete userState[userId];
        return ctx.reply(`✅ ${lines.length} stok berhasil ditambahkan!`);
      }
    }
  });

  bot.on('photo', (ctx) => {
    const userId = ctx.from.id;
    const state = userState[userId];
    if (!state) return;
    const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;

    if (isAdmin(userId) && state.step === 'R_SET_QRIS') {
      db.run(`UPDATE store SET qris = ? WHERE id = 1`, [photoId]);
      delete userState[userId];
      return ctx.reply('✅ QRIS berhasil diatur!');
    }

    if (state.step === 'R_UPLOAD_PROOF') {
      const orderId = state.orderId;
      delete userState[userId];
      db.run(`UPDATE orders SET proof = ?, status = 'PENDING_REVIEW' WHERE id = ?`, [photoId, orderId]);
      ctx.reply('✅ Bukti transfer diterima, menunggu konfirmasi admin.');
      db.get(`SELECT o.*, p.name as pname FROM orders o JOIN products p ON o.product_id = p.id WHERE o.id = ?`, [orderId], (err, order) => {
        if (!order) return;
        bot.telegram.sendPhoto(adminId, photoId, {
          caption: `🧾 *KONFIRMASI PEMBAYARAN #${orderId}*\n📦 ${order.pname}\n💰 Rp${order.amount.toLocaleString('id-ID')}\n👤 ${order.username}`,
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[
            Markup.button.callback('✅ Approve', `r_approve_${orderId}`),
            Markup.button.callback('❌ Reject', `r_reject_${orderId}`)
          ]])
        }).catch(() => {});
      });
    }
  });

  bot.launch().then(() => {
    console.log(`🤖 Bot sewaan #${rentalId} (@${bot.botInfo ? bot.botInfo.username : '?'}) berhasil dijalankan.`);
  }).catch((e) => {
    console.log(`❌ Gagal menjalankan bot sewaan #${rentalId}:`, e.message);
  });

  activeInstances[rentalId] = { bot, db };
  return bot;
}

function stopRentedBot(rentalId) {
  if (activeInstances[rentalId]) {
    try { activeInstances[rentalId].bot.stop('manual_stop'); } catch (e) {}
    delete activeInstances[rentalId];
  }
}

module.exports = { launchRentedBot, stopRentedBot };
