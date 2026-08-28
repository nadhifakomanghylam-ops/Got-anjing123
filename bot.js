require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const bot = new Telegraf(process.env.BOT_TOKEN);

const getAdminId = () => {
  const raw = process.env.ADMIN_ID;
  if (!raw) return 0;
  return Number(String(raw).replace(/[^0-9]/g, ''));
};

// DATABASE SETUP
const dbPath = path.join(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS store (
    id INTEGER PRIMARY KEY, 
    name TEXT, 
    desc TEXT, 
    photo TEXT,
    qris TEXT, 
    dana TEXT,
    gopay TEXT,
    admin_uname TEXT, 
    required_channel TEXT,
    log_group_id TEXT
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    upline_id INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS visitors (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    joined_at TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS groups (group_id INTEGER PRIMARY KEY)`);
  db.run(`CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, price INTEGER, photo TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, 
    user_id INTEGER, 
    username TEXT, 
    product_id INTEGER, 
    status TEXT, 
    proof TEXT,
    discount INTEGER DEFAULT 0,
    created_at TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS stock_items (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER, content TEXT, status TEXT DEFAULT 'AVAILABLE')`);
  db.run(`CREATE TABLE IF NOT EXISTS vouchers (code TEXT PRIMARY KEY, discount INTEGER, quota INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS auto_reply (keyword TEXT PRIMARY KEY, reply TEXT)`);
  
  db.get(`SELECT * FROM store WHERE id = 1`, (err, row) => {
    if (!row) {
      db.run(`INSERT INTO store (id, name, desc, photo, qris, dana, gopay, admin_uname, required_channel, log_group_id) VALUES (1, '🛍️ TOKO DIGITAL', 'Selamat datang di toko kami!', '', '', '', '', '', '', '')`);
    }
  });
});

const userState = {};

// FUNGSI UPDATE TAMPILAN (ANTI-NUMPUK)
const safeUpdateMainDisplay = async (ctx, text, extra = {}) => {
  try {
    if (ctx.callbackQuery && ctx.callbackQuery.message) {
      const msg = ctx.callbackQuery.message;
      if (extra.photo) {
        try { await ctx.deleteMessage(); } catch (e) {}
        return await ctx.replyWithPhoto(extra.photo, { caption: text, parse_mode: 'Markdown', ...extra });
      } else if (msg.photo) {
        await ctx.telegram.editMessageCaption(ctx.chat.id, msg.message_id, undefined, text, { parse_mode: 'Markdown', ...extra });
      } else {
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, text, { parse_mode: 'Markdown', ...extra });
      }
      return;
    }
  } catch (e) {}
  
  if (extra.photo) {
    await ctx.replyWithPhoto(extra.photo, { caption: text, parse_mode: 'Markdown', ...extra });
  } else {
    await ctx.replyWithMarkdown(text, extra);
  }
};

const saveUserAndVisitor = (ctx, uplineId = 0) => {
  const userId = ctx.from.id;
  const username = ctx.from.username ? `@${ctx.from.username}` : '';
  const firstName = ctx.from.first_name || 'User';
  const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

  db.get(`SELECT user_id FROM users WHERE user_id = ?`, [userId], (err, row) => {
    if (!row) {
      db.run(`INSERT INTO users (user_id, upline_id) VALUES (?, ?)`, [userId, uplineId]);
    }
  });
  db.run(`INSERT OR IGNORE INTO visitors (user_id, username, first_name, joined_at) VALUES (?, ?, ?, ?)`, [userId, username, firstName, now]);
};

const saveGroup = (groupId) => db.run(`INSERT OR IGNORE INTO groups (group_id) VALUES (?)`, [groupId]);

bot.command(['id', 'cekid'], (ctx) => {
  const chatId = ctx.chat.id;
  const chatType = ctx.chat.type;
  if (chatType === 'group' || chatType === 'supergroup') {
    ctx.replyWithMarkdown(`👥 *ID Grup ini adalah:* \`${chatId}\``);
  } else {
    ctx.replyWithMarkdown(`👤 *ID Telegram Anda:* \`${ctx.from.id}\``);
  }
});

// ANTI SPAM & LINK DI GRUP
bot.use(async (ctx, next) => {
  if (ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup')) {
    saveGroup(ctx.chat.id);
    const userId = ctx.from.id;
    if (userId === getAdminId()) return next();

    if (ctx.message && ctx.message.text) {
      const text = ctx.message.text.toLowerCase();
      if (/(chat\.whatsapp\.com|wa\.me|t\.me|telegram\.me)/i.test(text)) {
        try {
          await ctx.deleteMessage();
          const warning = await ctx.reply(`⚠️ *@${ctx.from.username || ctx.from.first_name}*, dilarang mengirim link!`, { parse_mode: 'Markdown' });
          setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, warning.message_id).catch(() => {}), 5000);
        } catch (e) {}
        return;
      }
    }
  }
  return next();
});

// WAJIB JOIN CHANNEL
const checkMembership = async (ctx, next) => {
  if (ctx.chat.type !== 'private') return next();
  
  let uplineId = 0;
  if (ctx.message && ctx.message.text && ctx.message.text.startsWith('/start')) {
    const parts = ctx.message.text.split(' ');
    if (parts.length > 1 && !isNaN(parts[1])) {
      uplineId = parseInt(parts[1]);
      if (uplineId === ctx.from.id) uplineId = 0;
    }
  }
  saveUserAndVisitor(ctx, uplineId);

  if (ctx.from.id === getAdminId()) return next();

  db.get(`SELECT required_channel FROM store WHERE id = 1`, async (err, store) => {
    if (store && store.required_channel && store.required_channel.trim() !== '') {
      const channel = store.required_channel.trim();
      try {
        const member = await ctx.telegram.getChatMember(channel, ctx.from.id);
        if (['creator', 'administrator', 'member'].includes(member.status)) return next();
        else showJoinGate(ctx, channel);
      } catch (e) { return next(); }
    } else return next();
  });
};

const showJoinGate = (ctx, channel) => {
  const channelUrl = channel.startsWith('@') ? `https://t.me/${channel.replace('@', '')}` : channel;
  const buttons = Markup.inlineKeyboard([
    [Markup.button.url('📢 Join Channel Official', channelUrl)],
    [Markup.button.callback('✅ Saya Sudah Join', 'main_menu')]
  ]);
  ctx.replyWithMarkdown(`⚠️ *AKSES DIBATASI*\n\nSilakan bergabung ke Channel resmi terlebih dahulu.`, buttons);
};

// MENU UTAMA
const getMainMenu = (userId) => {
  const adminId = getAdminId();
  const buttons = [
    [Markup.button.callback('🛒 Katalog Produk', 'user_catalog'), Markup.button.callback('🔍 Cari Produk', 'user_search_prod')],
    [Markup.button.callback('📦 Cek Pesanan', 'user_my_orders'), Markup.button.callback('📊 Cek Stok Live', 'user_live_stock')],
    [Markup.button.callback('🔗 Program Referral', 'user_referral'), Markup.button.callback('📖 Cara Belanja', 'user_faq')],
    [Markup.button.callback('📞 Customer Service', 'user_contact'), Markup.button.callback('🆔 Cek ID', 'user_check_id')]
  ];
  if (Number(userId) === adminId && adminId !== 0) {
    buttons.push([Markup.button.callback('⚙️ Dashboard Admin', 'admin_dashboard')]);
  }
  return Markup.inlineKeyboard(buttons);
};

const getAdminMenu = () => {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📊 Statistik', 'admin_stats'), Markup.button.callback('💾 Backup DB', 'admin_backup')],
    [Markup.button.callback('➕ Tambah Produk', 'admin_add_prod'), Markup.button.callback('🗑️ Hapus Produk', 'admin_del_prod')],
    [Markup.button.callback('📦 Tambah Stok (Massal)', 'admin_add_stock'), Markup.button.callback('💳 Metode Bayar', 'admin_set_payment')],
    [Markup.button.callback('✏️ Edit Info Toko', 'admin_edit_store'), Markup.button.callback('🖼️ Ganti Foto Header', 'admin_set_header_photo')],
    [Markup.button.callback('🤖 Atur Auto-Reply', 'admin_autoreply'), Markup.button.callback('🗑️ Hapus Auto-Reply', 'admin_del_autoreply')],
    [Markup.button.callback('👤 Set Admin Uname', 'admin_set_uname'), Markup.button.callback('🔒 Wajib Join', 'admin_set_channel')],
    [Markup.button.callback('📢 Grup Log/Testi', 'admin_set_log_group'), Markup.button.callback('🎁 Buat Voucher', 'admin_add_voucher')],
    [Markup.button.callback('🗑️ Hapus Voucher', 'admin_del_voucher'), Markup.button.callback('👥 Top Referral', 'admin_top_ref')],
    [Markup.button.callback('📢 Broadcast Text', 'admin_broadcast_menu'), Markup.button.callback('🔗 Broadcast + Button', 'admin_bc_button')],
    [Markup.button.callback('🔙 Menu Utama', 'main_menu')]
  ]);
};

// START & NAVIGASI
bot.start(checkMembership, async (ctx) => {
  db.get(`SELECT * FROM store WHERE id = 1`, (err, store) => {
    const text = `🏬 *${store.name}*\n\n${store.desc}`;
    if (store.photo) {
      ctx.replyWithPhoto(store.photo, { caption: text, parse_mode: 'Markdown', ...getMainMenu(ctx.from.id) });
    } else {
      ctx.replyWithMarkdown(text, getMainMenu(ctx.from.id));
    }
  });
});

bot.action('main_menu', checkMembership, async (ctx) => {
  db.get(`SELECT * FROM store WHERE id = 1`, async (err, store) => {
    const text = `🏬 *${store.name}*\n\n${store.desc}`;
    if (store.photo) {
      await safeUpdateMainDisplay(ctx, text, { photo: store.photo, ...getMainMenu(ctx.from.id) });
    } else {
      await safeUpdateMainDisplay(ctx, text, getMainMenu(ctx.from.id));
    }
  });
});

bot.action('user_check_id', async (ctx) => {
  ctx.answerCbQuery();
  ctx.replyWithMarkdown(`👤 *ID Pengguna Anda:* \`${ctx.from.id}\``);
});

bot.action('user_faq', async (ctx) => {
  ctx.answerCbQuery();
  const faqText = `📖 *CARA BELANJA DI TOKO KAMI*\n\n` +
    `1️⃣ Pilih menu *Katalog Produk*.\n` +
    `2️⃣ Klik produk yang diinginkan lalu pilih Beli.\n` +
    `3️⃣ Masukkan kode voucher jika punya.\n` +
    `4️⃣ Transfer sesuai nominal ke DANA/Gopay/QRIS.\n` +
    `5️⃣ Kirim bukti foto transfer ke chat ini.\n` +
    `6️⃣ Pesanan diproses dan akun dikirim otomatis!`;
  await safeUpdateMainDisplay(ctx, faqText, Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali', 'main_menu')]]));
});

bot.action('user_live_stock', async (ctx) => {
  ctx.answerCbQuery();
  const query = `SELECT p.name, p.price, COUNT(s.id) AS stock_count FROM products p LEFT JOIN stock_items s ON p.id = s.product_id AND s.status = 'AVAILABLE' GROUP BY p.id`;
  db.all(query, async (err, rows) => {
    if (!rows || rows.length === 0) {
      return await safeUpdateMainDisplay(ctx, `📊 *STATUS STOK REAL-TIME*\n\nBelum ada produk tersedia.`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali', 'main_menu')]]));
    }
    let text = `📊 *STATUS STOK REAL-TIME*\n\n`;
    rows.forEach(r => {
      const statusEmoji = r.stock_count > 0 ? '🟢 Tersedia' : '🔴 Habis';
      text += `• *${r.name}* - Rp${r.price.toLocaleString('id-ID')}\n  Status: ${statusEmoji} (*${r.stock_count} item*)\n\n`;
    });
    await safeUpdateMainDisplay(ctx, text, Markup.inlineKeyboard([[Markup.button.callback('🛒 Beli Sekarang', 'user_catalog'), Markup.button.callback('🔙 Menu Utama', 'main_menu')]]));
  });
});

bot.action('user_referral', async (ctx) => {
  ctx.answerCbQuery();
  const userId = ctx.from.id;
  db.get(`SELECT COUNT(user_id) as total_downline FROM users WHERE upline_id = ?`, [userId], async (err, row) => {
    const botInfo = await ctx.telegram.getMe();
    const refLink = `https://t.me/${botInfo.username}?start=${userId}`;
    const text = `🔗 *PROGRAM REFERRAL*\n\n` +
      `Bagikan link di bawah ini ke teman Anda:\n\`${refLink}\`\n\n` +
      `👥 Total teman diundang: *${row ? row.total_downline : 0} orang*`;
    await safeUpdateMainDisplay(ctx, text, Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali', 'main_menu')]]));
  });
});

bot.action('user_search_prod', async (ctx) => {
  ctx.answerCbQuery();
  userState[ctx.from.id] = { step: 'SEARCH_PRODUCT' };
  await safeUpdateMainDisplay(ctx, `🔍 *PENCARIAN PRODUK*\n\nSilakan ketik kata kunci nama produk yang dicari:`, Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', 'user_catalog')]]));
});

bot.action('user_my_orders', async (ctx) => {
  ctx.answerCbQuery();
  const userId = ctx.from.id;
  db.all(`SELECT o.*, p.name as prod_name FROM orders o JOIN products p ON o.product_id = p.id WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 5`, [userId], async (err, rows) => {
    if (!rows || rows.length === 0) {
      return await safeUpdateMainDisplay(ctx, `📦 *RIWAYAT PESANAN*\n\nAnda belum pernah transaksi.`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali', 'main_menu')]]));
    }
    let text = `📦 *5 TRANSAKSI TERAKHIR ANDA:*\n\n`;
    rows.forEach(r => {
      text += `• *Order #${r.id}* - ${r.prod_name}\n  Status: *${r.status}* (${r.created_at})\n\n`;
    });
    await safeUpdateMainDisplay(ctx, text, Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali', 'main_menu')]]));
  });
});

bot.action('user_contact', checkMembership, async (ctx) => {
  ctx.answerCbQuery();
  db.get(`SELECT admin_uname FROM store WHERE id = 1`, async (err, store) => {
    const uname = (store && store.admin_uname) ? store.admin_uname.replace('@', '') : '';
    if (uname) {
      await safeUpdateMainDisplay(ctx, `Silakan hubungi Customer Service kami:`, Markup.inlineKeyboard([[Markup.button.url('💬 Chat Admin', `https://t.me/${uname}`)], [Markup.button.callback('🔙 Kembali', 'main_menu')]]));
    } else {
      await safeUpdateMainDisplay(ctx, `⚠️ Admin belum mengatur Username CS.`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali', 'main_menu')]]));
    }
  });
});

// KATALOG & ORDER
bot.action('user_catalog', checkMembership, async (ctx) => {
  const query = `SELECT p.*, COUNT(s.id) AS stock_count FROM products p LEFT JOIN stock_items s ON p.id = s.product_id AND s.status = 'AVAILABLE' GROUP BY p.id`;
  db.all(query, async (err, products) => {
    if (!products || products.length === 0) {
      return await safeUpdateMainDisplay(ctx, '⚠️ Katalog produk kosong.', Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali', 'main_menu')]]));
    }
    let text = `🛒 *KATALOG PRODUK*\n\nPilih produk di bawah ini:`;
    let buttons = products.map(prod => [
      Markup.button.callback(`${prod.name} (Rp${prod.price.toLocaleString('id-ID')}) [Stok: ${prod.stock_count}]`, `buy_${prod.id}`)
    ]);
    buttons.push([Markup.button.callback('🔙 Menu Utama', 'main_menu')]);
    await safeUpdateMainDisplay(ctx, text, Markup.inlineKeyboard(buttons));
  });
});

bot.action(/^buy_(.+)$/, checkMembership, async (ctx) => {
  const prodId = ctx.match[1];
  db.get(`SELECT * FROM products WHERE id = ?`, [prodId], (err, prod) => {
    db.get(`SELECT COUNT(id) AS stock_count FROM stock_items WHERE product_id = ? AND status = 'AVAILABLE'`, [prodId], async (err, res) => {
      if (!res || res.stock_count <= 0) {
        return ctx.answerCbQuery(`⚠️ Stok ${prod.name} habis!`, { show_alert: true });
      }
      const buttons = Markup.inlineKeyboard([
        [Markup.button.callback('🎟️ Pakai Kode Voucher', `vouc_${prodId}`)],
        [Markup.button.callback('⏩ Bayar Tanpa Voucher', `pay_${prodId}_0`)],
        [Markup.button.callback('🔙 Kembali ke Katalog', 'user_catalog')]
      ]);
      await safeUpdateMainDisplay(ctx, `🛒 *PEMBELIAN: ${prod.name}*\n💰 *Harga:* Rp${prod.price.toLocaleString('id-ID')}\n📦 *Stok Tersedia:* ${res.stock_count}\n\nPunya Kode Voucher Diskon?`, buttons);
    });
  });
});

bot.action(/^vouc_(.+)$/, async (ctx) => {
  const prodId = ctx.match[1];
  userState[ctx.from.id] = { step: 'INPUT_VOUCHER', prodId: prodId };
  await safeUpdateMainDisplay(ctx, `🎟️ *MASUKKAN KODE VOUCHER*\n\nKetik kode voucher diskon di chat:`, Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', `buy_${prodId}`)]]));
});

bot.action(/^pay_(.+)_(.+)$/, checkMembership, async (ctx) => {
  const prodId = ctx.match[1];
  const discount = parseInt(ctx.match[2]) || 0;

  db.get(`SELECT * FROM products WHERE id = ?`, [prodId], (err, prod) => {
    const finalPrice = Math.max(0, prod.price - discount);
    const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    const username = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'Buyer');

    db.run(`INSERT INTO orders (user_id, username, product_id, status, discount, created_at) VALUES (?, ?, ?, 'PENDING', ?, ?)`, [ctx.from.id, username, prodId, discount, now], async function(err) {
      const orderId = this.lastID;
      userState[ctx.from.id] = { step: 'WAITING_PROOF', orderId: orderId };

      db.get(`SELECT * FROM store WHERE id = 1`, async (err, store) => {
        const detailText = `🧾 *RINCIAN PESANAN #${orderId}*\n\n` +
          `📦 *Produk:* ${prod.name}\n` +
          `💵 *Total Bayar:* Rp${finalPrice.toLocaleString('id-ID')}\n\n` +
          `💳 *METODE PEMBAYARAN:*\n` +
          `💙 *DANA:* \`${store.dana || 'Belum diset'}\`\n` +
          `🟢 *GOPAY:* \`${store.gopay || 'Belum diset'}\`\n\n` +
          `📸 *Kirimkan foto Bukti Transfer ke chat ini!*`;

        if (store && store.qris) {
          await ctx.replyWithPhoto(store.qris, { caption: detailText, parse_mode: 'Markdown' });
        } else {
          await ctx.replyWithMarkdown(detailText);
        }
      });
    });
  });
});

// DASHBOARD & AKSI ADMIN
bot.action('admin_dashboard', async (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  await safeUpdateMainDisplay(ctx, '⚙️ *DASHBOARD ADMIN TOKO*', getAdminMenu());
});

bot.action('admin_stats', async (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  db.get(`SELECT COUNT(user_id) AS total_visitors FROM visitors`, (err, row) => {
    db.get(`SELECT COUNT(group_id) AS total_groups FROM groups`, (err, gRow) => {
      ctx.answerCbQuery(`Pengunjung: ${row ? row.total_visitors : 0} | Grup: ${gRow ? gRow.total_groups : 0}`, { show_alert: true });
    });
  });
});

bot.action('admin_top_ref', async (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  db.all(`SELECT upline_id, COUNT(user_id) as total FROM users WHERE upline_id != 0 GROUP BY upline_id ORDER BY total DESC LIMIT 10`, (err, rows) => {
    if (!rows || rows.length === 0) return ctx.reply('Belum ada data referral.');
    let text = `👥 *TOP 10 REFERRAL:* \n\n`;
    rows.forEach((r, idx) => {
      text += `${idx + 1}. ID: \`${r.upline_id}\` - *${r.total} Undang*\n`;
    });
    ctx.replyWithMarkdown(text);
  });
});

bot.action('admin_backup', async (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  try {
    await ctx.replyWithDocument({ source: dbPath, filename: 'database.db' }, { caption: '💾 *DATABASE BACKUP*', parse_mode: 'Markdown' });
  } catch (e) { ctx.reply('❌ Gagal backup.'); }
});

bot.action('admin_add_prod', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'ADD_PROD_NAME' };
  ctx.reply('Masukkan Nama Produk Baru:');
});

bot.action('admin_del_prod', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  db.all(`SELECT * FROM products`, (err, rows) => {
    if (!rows || rows.length === 0) return ctx.reply('Tidak ada produk.');
    const buttons = rows.map(p => [Markup.button.callback(`🗑️ ${p.name}`, `delprod_${p.id}`)]);
    ctx.reply('Pilih produk yang ingin dihapus:', Markup.inlineKeyboard(buttons));
  });
});

bot.action(/^delprod_(.+)$/, (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  db.run(`DELETE FROM products WHERE id = ?`, [ctx.match[1]]);
  db.run(`DELETE FROM stock_items WHERE product_id = ?`, [ctx.match[1]]);
  ctx.reply('✅ Produk berhasil dihapus!');
});

bot.action('admin_add_stock', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  db.all(`SELECT * FROM products`, (err, rows) => {
    if (!rows || rows.length === 0) return ctx.reply('Tambah produk terlebih dahulu!');
    const buttons = rows.map(p => [Markup.button.callback(`📦 ${p.name}`, `addstock_${p.id}`)]);
    ctx.reply('Pilih produk yang mau diisi stoknya:', Markup.inlineKeyboard(buttons));
  });
});

bot.action(/^addstock_(.+)$/, (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'ADD_STOCK_BULK', prodId: ctx.match[1] };
  ctx.reply('📥 *TAMBAH STOK MASSAL*\n\nKirim/Paste banyak akun atau kode stok sekaligus. *Setiap baris dihitung 1 stok terpisah*:');
});

bot.action('admin_edit_store', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'EDIT_STORE_NAME' };
  ctx.reply('Masukkan Nama Toko Baru:');
});

bot.action('admin_set_header_photo', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'SET_HEADER_PHOTO' };
  ctx.reply('🖼️ Kirim foto baru untuk dijadikan Header / Banner Toko:');
});

bot.action('admin_autoreply', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'ADD_AUTOREPLY_KEY' };
  ctx.reply('🤖 *AUTO-REPLY*\n\nKetik kata kunci yang ingin dideteksi (contoh: *lokasi* atau *garansi*):', { parse_mode: 'Markdown' });
});

bot.action('admin_del_autoreply', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  db.all(`SELECT * FROM auto_reply`, (err, rows) => {
    if (!rows || rows.length === 0) return ctx.reply('Tidak ada data auto-reply.');
    const buttons = rows.map(r => [Markup.button.callback(`🗑️ ${r.keyword}`, `delreply_${r.keyword}`)]);
    ctx.reply('Pilih kata kunci auto-reply yang ingin dihapus:', Markup.inlineKeyboard(buttons));
  });
});

bot.action(/^delreply_(.+)$/, (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  db.run(`DELETE FROM auto_reply WHERE keyword = ?`, [ctx.match[1]]);
  ctx.reply('✅ Auto-reply berhasil dihapus!');
});

bot.action('admin_set_uname', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'SET_UNAME' };
  ctx.reply('Ketik Username Admin (contoh: @Admin):');
});

bot.action('admin_set_channel', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'SET_CHANNEL' };
  ctx.reply('Ketik Channel Wajib Join (atau ketik 0 untuk menonaktifkan):');
});

bot.action('admin_set_payment', async (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  ctx.reply('Pilih metode pembayaran:', Markup.inlineKeyboard([
    [Markup.button.callback('💙 Set DANA', 'set_dana'), Markup.button.callback('🟢 Set GOPAY', 'set_gopay')],
    [Markup.button.callback('🖼️ Set QRIS', 'set_qris')]
  ]));
});

bot.action('set_dana', (ctx) => { userState[getAdminId()] = { step: 'SET_DANA' }; ctx.reply('Ketik No DANA:'); });
bot.action('set_gopay', (ctx) => { userState[getAdminId()] = { step: 'SET_GOPAY' }; ctx.reply('Ketik No GOPAY:'); });
bot.action('set_qris', (ctx) => { userState[getAdminId()] = { step: 'SET_QRIS' }; ctx.reply('Kirim foto QRIS:'); });
bot.action('admin_set_log_group', (ctx) => { userState[getAdminId()] = { step: 'SET_LOG_GROUP' }; ctx.reply('Ketik ID Grup Log/Testimoni (contoh: -100xxx):'); });

bot.action('admin_add_voucher', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'ADD_VOUC_CODE' };
  ctx.reply('Ketik Kode Voucher Baru:');
});

bot.action('admin_del_voucher', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  db.all(`SELECT * FROM vouchers`, (err, rows) => {
    if (!rows || rows.length === 0) return ctx.reply('Tidak ada voucher.');
    const buttons = rows.map(v => [Markup.button.callback(`🗑️ ${v.code}`, `delvouc_${v.code}`)]);
    ctx.reply('Pilih voucher yang ingin dihapus:', Markup.inlineKeyboard(buttons));
  });
});

bot.action(/^delvouc_(.+)$/, (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  db.run(`DELETE FROM vouchers WHERE code = ?`, [ctx.match[1]]);
  ctx.reply('✅ Voucher berhasil dihapus!');
});

bot.action('admin_broadcast_menu', async (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  ctx.reply('Pilih target broadcast:', Markup.inlineKeyboard([
    [Markup.button.callback('📢 Broadcast ke Semua User', 'bc_user')],
    [Markup.button.callback('📢 Broadcast ke Semua Grup', 'bc_group')]
  ]));
});

bot.action('bc_user', (ctx) => { userState[getAdminId()] = { step: 'BROADCAST_USER' }; ctx.reply('Ketik pesan broadcast untuk SELURUH USER:'); });
bot.action('bc_group', (ctx) => { userState[getAdminId()] = { step: 'BROADCAST_GROUP' }; ctx.reply('Ketik pesan broadcast untuk SELURUH GRUP:'); });

bot.action('admin_bc_button', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'BC_BTN_TEXT' };
  ctx.reply('Ketik TEKS pesan broadcast:');
});

// HANDLER FOTO
bot.on('photo', (ctx) => {
  const adminId = getAdminId();
  const state = userState[ctx.from.id];
  const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;

  if (state && state.step === 'WAITING_PROOF') {
    db.run(`UPDATE orders SET proof = ?, status = 'PROSES' WHERE id = ?`, [photoId, state.orderId]);
    delete userState[ctx.from.id];
    ctx.reply('✅ Bukti pembayaran diterima! Menunggu konfirmasi Admin.');
    
    const adminButtons = Markup.inlineKeyboard([[Markup.button.callback('✅ Approve', `app_${state.orderId}`), Markup.button.callback('❌ Reject', `rej_${state.orderId}`)]]);
    const proofText = `🔔 *BUKTI PEMBAYARAN MASUK!*\n\n🧾 *Order ID:* #${state.orderId}\n👤 *User:* ${ctx.from.username ? '@' + ctx.from.username : ctx.from.first_name}`;
    if (adminId !== 0) bot.telegram.sendPhoto(adminId, photoId, { caption: proofText, parse_mode: 'Markdown', ...adminButtons });
  } else if (state && state.step === 'SET_QRIS' && Number(ctx.from.id) === adminId) {
    db.run(`UPDATE store SET qris = ? WHERE id = 1`, [photoId]);
    delete userState[adminId];
    ctx.reply('✅ Foto QRIS disimpan!');
  } else if (state && state.step === 'SET_HEADER_PHOTO' && Number(ctx.from.id) === adminId) {
    db.run(`UPDATE store SET photo = ? WHERE id = 1`, [photoId]);
    delete userState[adminId];
    ctx.reply('✅ Foto Header / Banner toko berhasil diperbarui!');
  } else if (state && state.step === 'ADD_PROD_PHOTO' && Number(ctx.from.id) === adminId) {
    db.run(`INSERT INTO products (name, price, photo) VALUES (?, ?, ?)`, [state.name, state.price, photoId]);
    delete userState[adminId];
    ctx.reply('✅ Produk ditambahkan!');
  }
});

// HANDLER TEXT & INPUT
bot.on('text', (ctx) => {
  const adminId = getAdminId();
  const state = userState[ctx.from.id];

  // PENGECEKAN AUTO-REPLY DARI CHAT PRIVATE (USER)
  if (ctx.chat.type === 'private' && !state) {
    const userText = ctx.message.text.trim().toLowerCase();
    db.get(`SELECT reply FROM auto_reply WHERE ? LIKE '%' || keyword || '%'`, [userText], (err, row) => {
      if (row) {
        ctx.reply(row.reply, { parse_mode: 'Markdown' });
      }
    });
  }

  if (!state) return;

  if (state.step === 'SEARCH_PRODUCT') {
    const keyword = ctx.message.text.trim();
    delete userState[ctx.from.id];
    
    db.all(`SELECT p.*, COUNT(s.id) AS stock_count FROM products p LEFT JOIN stock_items s ON p.id = s.product_id AND s.status = 'AVAILABLE' WHERE p.name LIKE ? GROUP BY p.id`, [`%${keyword}%`], async (err, products) => {
      if (!products || products.length === 0) {
        return ctx.replyWithMarkdown(`❌ Tidak ada produk dengan kata kunci "*${keyword}*"`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Katalog', 'user_catalog')]]));
      }
      let text = `🔍 *HASIL PENCARIAN ("${keyword}"):*\n\n`;
      let buttons = products.map(prod => [
        Markup.button.callback(`${prod.name} (Rp${prod.price.toLocaleString('id-ID')}) [Stok: ${prod.stock_count}]`, `buy_${prod.id}`)
      ]);
      buttons.push([Markup.button.callback('🔙 Kembali ke Katalog', 'user_catalog')]);
      ctx.replyWithMarkdown(text, Markup.inlineKeyboard(buttons));
    });
    return;
  }

  if (state.step === 'INPUT_VOUCHER') {
    const code = ctx.message.text.trim().toUpperCase();
    db.get(`SELECT * FROM vouchers WHERE code = ? AND quota > 0`, [code], (err, vouc) => {
      if (!vouc) {
        ctx.reply('⚠️ Voucher tidak valid / habis! Melanjutkan tanpa voucher...');
        delete userState[ctx.from.id];
        ctx.reply('Klik tombol di bawah:', Markup.inlineKeyboard([[Markup.button.callback('⏩ Lanjut Pembayaran', `pay_${state.prodId}_0`)]]));
      } else {
        delete userState[ctx.from.id];
        ctx.reply(`🎉 *VOUCHER AKTIF:* Potongan Rp${vouc.discount.toLocaleString('id-ID')}`, Markup.inlineKeyboard([[Markup.button.callback('💳 Lanjut Bayar', `pay_${state.prodId}_${vouc.discount}`)]]));
      }
    });
    return;
  }

  if (state.step === 'WAITING_REVIEW') {
    const reviewText = ctx.message.text.trim();
    delete userState[ctx.from.id];
    ctx.reply('⭐️ Terima kasih atas ulasannya!');
    db.get(`SELECT log_group_id FROM store WHERE id = 1`, (err, store) => {
      if (store && store.log_group_id) {
        bot.telegram.sendMessage(store.log_group_id, `⭐️ *ULASAN PEMBELI*\n👤 ${ctx.from.first_name}\n⭐ ${'⭐'.repeat(state.stars)}\n💬 "${reviewText}"`, { parse_mode: 'Markdown' }).catch(() => {});
      }
    });
    return;
  }

  if (Number(ctx.from.id) === adminId) {
    if (state.step === 'ADD_AUTOREPLY_KEY') {
      userState[adminId] = { step: 'ADD_AUTOREPLY_VAL', keyword: ctx.message.text.trim().toLowerCase() };
      ctx.reply('Ketik teks balasan otomatis untuk kata kunci tersebut:');
    } else if (state.step === 'ADD_AUTOREPLY_VAL') {
      db.run(`INSERT OR REPLACE INTO auto_reply (keyword, reply) VALUES (?, ?)`, [state.keyword, ctx.message.text]);
      delete userState[adminId];
      ctx.reply(`✅ Auto-reply untuk kata kunci *${state.keyword}* berhasil disimpan!`, { parse_mode: 'Markdown' });
    } else if (state.step === 'BC_BTN_TEXT') {
      userState[adminId] = { step: 'BC_BTN_LABEL', text: ctx.message.text };
      ctx.reply('Ketik TULISAN TOMBOL (contoh: Kunjungi Channel):');
    } else if (state.step === 'BC_BTN_LABEL') {
      userState[adminId] = { step: 'BC_BTN_URL', text: state.text, label: ctx.message.text };
      ctx.reply('Ketik LINK TARGET (contoh: https://t.me/xx):');
    } else if (state.step === 'BC_BTN_URL') {
      const url = ctx.message.text.trim();
      const bcText = state.text;
      const btnLabel = state.label;
      delete userState[adminId];

      db.all(`SELECT user_id FROM users`, (err, users) => {
        if (users) {
          users.forEach(u => {
            bot.telegram.sendMessage(u.user_id, bcText, {
              parse_mode: 'Markdown',
              ...Markup.inlineKeyboard([[Markup.button.url(btnLabel, url)]])
            }).catch(() => {});
          });
        }
        ctx.reply(`✅ Broadcast ber-tombol terkirim ke ${users ? users.length : 0} user!`);
      });
    } else if (state.step === 'ADD_PROD_NAME') {
      userState[adminId] = { step: 'ADD_PROD_PRICE', name: ctx.message.text.trim() };
      ctx.reply('Masukkan Harga Produk (angka saja):');
    } else if (state.step === 'ADD_PROD_PRICE') {
      const price = parseInt(ctx.message.text.trim());
      if (isNaN(price)) return ctx.reply('⚠️ Masukkan angka yang valid!');
      userState[adminId] = { step: 'ADD_PROD_PHOTO', name: state.name, price: price };
      ctx.reply('Kirim foto produk (atau ketik "skip"):');
    } else if (state.step === 'ADD_PROD_PHOTO' && ctx.message.text.toLowerCase() === 'skip') {
      db.run(`INSERT INTO products (name, price, photo) VALUES (?, ?, '')`, [state.name, state.price]);
      delete userState[adminId];
      ctx.reply('✅ Produk ditambahkan tanpa foto!');
    } else if (state.step === 'ADD_STOCK_BULK') {
      const lines = ctx.message.text.split('\n').map(i => i.trim()).filter(i => i !== '');
      if (lines.length === 0) return ctx.reply('⚠️ Tidak ada stok terdeteksi.');
      
      let inserted = 0;
      const stmt = db.prepare(`INSERT INTO stock_items (product_id, content) VALUES (?, ?)`);
      lines.forEach(item => {
        stmt.run(state.prodId, item);
        inserted++;
      });
      stmt.finalize();

      delete userState[adminId];
      ctx.reply(`✅ Berhasil menambahkan *${inserted} stok* secara massal!`);
    } else if (state.step === 'EDIT_STORE_NAME') {
      userState[adminId] = { step: 'EDIT_STORE_DESC', name: ctx.message.text.trim() };
      ctx.reply('Masukkan Deskripsi Toko Baru:');
    } else if (state.step === 'EDIT_STORE_DESC') {
      db.run(`UPDATE store SET name = ?, desc = ? WHERE id = 1`, [state.name, ctx.message.text.trim()]);
      delete userState[adminId];
      ctx.reply('✅ Informasi Toko berhasil diperbarui!');
    } else if (state.step === 'ADD_VOUC_CODE') {
      userState[adminId] = { step: 'ADD_VOUC_DISC', code: ctx.message.text.trim().toUpperCase() };
      ctx.reply('Masukkan Jumlah Potongan (contoh: 5000):');
    } else if (state.step === 'ADD_VOUC_DISC') {
      userState[adminId] = { step: 'ADD_VOUC_QUOTA', code: state.code, discount: parseInt(ctx.message.text.trim()) };
      ctx.reply('Masukkan Kuota Penggunaan:');
    } else if (state.step === 'ADD_VOUC_QUOTA') {
      db.run(`INSERT OR REPLACE INTO vouchers (code, discount, quota) VALUES (?, ?, ?)`, [state.code, state.discount, parseInt(ctx.message.text.trim())]);
      delete userState[adminId];
      ctx.reply(`✅ Voucher *${state.code}* berhasil dibuat!`);
    } else if (state.step === 'SET_UNAME') {
      db.run(`UPDATE store SET admin_uname = ? WHERE id = 1`, [ctx.message.text.trim()]);
      delete userState[adminId];
      ctx.reply('✅ Username Admin disimpan!');
    } else if (state.step === 'SET_CHANNEL') {
      db.run(`UPDATE store SET required_channel = ? WHERE id = 1`, [ctx.message.text.trim() === '0' ? '' : ctx.message.text.trim()]);
      delete userState[adminId];
      ctx.reply('✅ Channel Wajib Join diperbarui!');
    } else if (state.step === 'SET_DANA') {
      db.run(`UPDATE store SET dana = ? WHERE id = 1`, [ctx.message.text.trim()]);
      delete userState[adminId];
      ctx.reply('✅ No DANA disimpan!');
    } else if (state.step === 'SET_GOPAY') {
      db.run(`UPDATE store SET gopay = ? WHERE id = 1`, [ctx.message.text.trim()]);
      delete userState[adminId];
      ctx.reply('✅ No GOPAY disimpan!');
    } else if (state.step === 'SET_LOG_GROUP') {
      db.run(`UPDATE store SET log_group_id = ? WHERE id = 1`, [ctx.message.text.trim()]);
      delete userState[adminId];
      ctx.reply('✅ ID Grup Log/Testimoni berhasil disimpan!');
    } else if (state.step === 'BROADCAST_USER') {
      const text = ctx.message.text;
      delete userState[adminId];
      db.all(`SELECT user_id FROM users`, (err, users) => {
        if (users) users.forEach(u => bot.telegram.sendMessage(u.user_id, `📢 *INFO TOKO*\n\n${text}`, { parse_mode: 'Markdown' }).catch(() => {}));
        ctx.reply(`✅ Broadcast terkirim ke ${users ? users.length : 0} user!`);
      });
    } else if (state.step === 'BROADCAST_GROUP') {
      const text = ctx.message.text;
      delete userState[adminId];
      db.all(`SELECT group_id FROM groups`, (err, groups) => {
        if (groups) groups.forEach(g => bot.telegram.sendMessage(g.group_id, `📢 *INFO TOKO*\n\n${text}`, { parse_mode: 'Markdown' }).catch(() => {}));
        ctx.reply(`✅ Broadcast terkirim ke ${groups ? groups.length : 0} grup!`);
      });
    }
  }
});

// APPROVE & REJECT ORDER
bot.action(/^app_(.+)$/, (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  const orderId = ctx.match[1];

  db.get(`SELECT o.*, p.name as product_name, p.price as product_price FROM orders o JOIN products p ON o.product_id = p.id WHERE o.id = ?`, [orderId], (err, order) => {
    if (!order || order.status !== 'PROSES') return ctx.reply('Pesanan sudah diproses sebelumnya.');

    db.get(`SELECT * FROM stock_items WHERE product_id = ? AND status = 'AVAILABLE' LIMIT 1`, [order.product_id], (err, stock) => {
      if (!stock) return ctx.reply(`⚠️ Stok produk telah HABIS!`);

      db.run(`UPDATE orders SET status = 'APPROVED' WHERE id = ?`, [orderId]);
      db.run(`UPDATE stock_items SET status = 'SOLD' WHERE id = ?`, [stock.id]);

      const ratingButtons = Markup.inlineKeyboard([
        [Markup.button.callback('⭐ 1', `rate_1`), Markup.button.callback('⭐ 2', `rate_2`), Markup.button.callback('⭐ 3', `rate_3`), Markup.button.callback('⭐ 4', `rate_4`), Markup.button.callback('⭐ 5', `rate_5`)]
      ]);

      // Kirim barang/akun ke pembeli
      bot.telegram.sendMessage(order.user_id, `🎉 *PEMBAYARAN DISETUJUI!*\n\nDetail Pesanan (#${orderId}):\n\`${stock.content}\`\n\n⭐ Berikan penilaian transaksi:`, { parse_mode: 'Markdown', ...ratingButtons });
      ctx.reply(`✅ Order #${orderId} Berhasil Di-Approve dan Stok terkirim ke pembeli.`);

      // OTOMATIS KIRIM TESTIMONI KE GRUP LOG
      db.get(`SELECT log_group_id FROM store WHERE id = 1`, (err, store) => {
        if (store && store.log_group_id && store.log_group_id.trim() !== '') {
          const finalTotal = Math.max(0, order.product_price - (order.discount || 0));
          const testiText = `🎉 *TESTIMONI TRANSAKSI SUKSES*\n\n` +
            `🧾 *ID Transaksi:* #${order.id}\n` +
            `📦 *Produk:* ${order.product_name}\n` +
            `💰 *Total:* Rp${finalTotal.toLocaleString('id-ID')}\n` +
            `👤 *Buyer:* ${order.username}\n` +
            `🕒 *Waktu:* ${order.created_at}\n\n` +
            `✅ _Status: Lunas & Terkirim Otomatis_`;

          if (order.proof) {
            bot.telegram.sendPhoto(store.log_group_id, order.proof, { caption: testiText, parse_mode: 'Markdown' }).catch((e) => console.log('Gagal kirim foto ke grup log:', e.message));
          } else {
            bot.telegram.sendMessage(store.log_group_id, testiText, { parse_mode: 'Markdown' }).catch((e) => console.log('Gagal kirim text ke grup log:', e.message));
          }
        }
      });
    });
  });
});

bot.action(/^rate_(.+)$/, (ctx) => {
  const stars = parseInt(ctx.match[1]);
  userState[ctx.from.id] = { step: 'WAITING_REVIEW', stars: stars };
  ctx.reply(`Terima kasih ${stars} bintangnya! ⭐ Ketik ulasan singkat untuk toko kami:`);
});

bot.action(/^rej_(.+)$/, (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  const orderId = ctx.match[1];
  db.run(`UPDATE orders SET status = 'REJECTED' WHERE id = ?`, [orderId]);
  db.get(`SELECT user_id FROM orders WHERE id = ?`, [orderId], (err, ord) => {
    if (ord) bot.telegram.sendMessage(ord.user_id, `❌ *PEMBAYARAN DITOLAK*\n\nMaaf pesanan #${orderId} ditolak oleh Admin.`, { parse_mode: 'Markdown' });
  });
  ctx.reply(`❌ Order #${orderId} telah Ditolak.`);
});

bot.launch();
console.log('Bot Telegram Running...');
