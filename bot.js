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
  
  db.run(`CREATE TABLE IF NOT EXISTS users (user_id INTEGER PRIMARY KEY)`);
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
  
  db.get(`SELECT * FROM store WHERE id = 1`, (err, row) => {
    if (!row) {
      db.run(`INSERT INTO store (id, name, desc, photo, qris, dana, gopay, admin_uname, required_channel, log_group_id) VALUES (1, '🛍️ TOKO DIGITAL', 'Selamat datang di toko kami!', '', '', '', '', '', '', '')`);
    }
  });
});

const userState = {};
const userSpamMap = new Map();

// FUNGSI EDIT PESAN SUPAYA TIDAK NUMPUK KE BAWAH
const safeUpdateMainDisplay = async (ctx, text, extra) => {
  try {
    if (ctx.callbackQuery && ctx.callbackQuery.message) {
      const msg = ctx.callbackQuery.message;
      if (msg.photo) {
        // Jika pesan sebelumnya ada fotonya, edit caption
        await ctx.telegram.editMessageCaption(ctx.chat.id, msg.message_id, undefined, text, { parse_mode: 'Markdown', ...extra });
      } else {
        // Jika teks biasa
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, text, { parse_mode: 'Markdown', ...extra });
      }
      return;
    }
  } catch (e) {}
  
  // Fallback jika edit gagal (kirim baru)
  if (extra && extra.photo) {
    await ctx.replyWithPhoto(extra.photo, { caption: text, parse_mode: 'Markdown', ...extra });
  } else {
    await ctx.replyWithMarkdown(text, extra);
  }
};

const saveUserAndVisitor = (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username ? `@${ctx.from.username}` : '';
  const firstName = ctx.from.first_name || 'User';
  const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

  db.run(`INSERT OR IGNORE INTO users (user_id) VALUES (?)`, [userId]);
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
  saveUserAndVisitor(ctx);
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

// MENU UTAMA DENGAN TOMBOL LEBIH BANYAK & TAMPILAN RAPI
const getMainMenu = (userId) => {
  const adminId = getAdminId();
  const buttons = [
    [Markup.button.callback('🛒 Katalog Produk', 'user_catalog'), Markup.button.callback('📦 Cek Pesanan Saya', 'user_my_orders')],
    [Markup.button.callback('📖 Cara Belanja (FAQ)', 'user_faq'), Markup.button.callback('📞 Customer Service', 'user_contact')],
    [Markup.button.callback('🆔 Cek Akun ID', 'user_check_id')]
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
    [Markup.button.callback('📦 Isi Stok', 'admin_add_stock'), Markup.button.callback('💳 Metode Pembayaran', 'admin_set_payment')],
    [Markup.button.callback('✏️ Edit Toko', 'admin_edit_store'), Markup.button.callback('👤 Set Admin Uname', 'admin_set_uname')],
    [Markup.button.callback('🔒 Wajib Join', 'admin_set_channel'), Markup.button.callback('📢 Grup Log/Testi', 'admin_set_log_group')],
    [Markup.button.callback('🎁 Buat Voucher', 'admin_add_voucher'), Markup.button.callback('🗑️ Hapus Voucher', 'admin_del_voucher')],
    [Markup.button.callback('📢 Broadcast User', 'admin_broadcast'), Markup.button.callback('📢 Broadcast Grup', 'admin_broadcast_group')],
    [Markup.button.callback('🔙 Menu Utama', 'main_menu')]
  ]);
};

// START & NAVIGASI UTAMA (MENGGUNAKAN EDIT MESSAGE)
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
    await safeUpdateMainDisplay(ctx, text, { ...getMainMenu(ctx.from.id), photo: store.photo });
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
    `2️⃣ Klik tombol Beli pada produk yang diinginkan.\n` +
    `3️⃣ Masukkan kode voucher jika punya (opsional).\n` +
    `4️⃣ Lakukan pembayaran sesuai nomor DANA/Gopay/QRIS yang tertera.\n` +
    `5️⃣ Kirimkan foto bukti transfer ke chat bot ini.\n` +
    `6️⃣ Tunggu beberapa saat sampai Admin menyetujui, dan akun/pesanan akan dikirim otomatis!`;
  
  await safeUpdateMainDisplay(ctx, faqText, Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali ke Menu Utama', 'main_menu')]]));
});

bot.action('user_my_orders', async (ctx) => {
  ctx.answerCbQuery();
  const userId = ctx.from.id;
  db.all(`SELECT o.*, p.name as prod_name FROM orders o JOIN products p ON o.product_id = p.id WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 5`, [userId], async (err, rows) => {
    if (!rows || rows.length === 0) {
      return await safeUpdateMainDisplay(ctx, `📦 *RIWAYAT PESANAN*\n\nAnda belum pernah melakukan transaksi.`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali', 'main_menu')]]));
    }
    
    let text = `📦 *5 TRANSAKSI TERAKHIR ANDA:*\n\n`;
    rows.forEach(r => {
      text += `• *Order #${r.id}* - ${r.prod_name}\n  Status: *${r.status}* (${r.created_at})\n\n`;
    });
    
    await safeUpdateMainDisplay(ctx, text, Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali ke Menu Utama', 'main_menu')]]));
  });
});

bot.action('user_contact', checkMembership, async (ctx) => {
  ctx.answerCbQuery();
  db.get(`SELECT admin_uname FROM store WHERE id = 1`, async (err, store) => {
    const uname = (store && store.admin_uname) ? store.admin_uname.replace('@', '') : '';
    if (uname) {
      await safeUpdateMainDisplay(ctx, `Silakan hubungi Customer Service kami melalui tombol di bawah:`, Markup.inlineKeyboard([[Markup.button.url('💬 Chat Admin', `https://t.me/${uname}`)], [Markup.button.callback('🔙 Kembali', 'main_menu')]]));
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
      return await safeUpdateMainDisplay(ctx, '⚠️ Katalog produk saat ini kosong.', Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali', 'main_menu')]]));
    }
    
    // Tampilkan produk pertama atau ringkasan katalog rapi
    let text = `🛒 *KATALOG PRODUK TERSEDIA*\n\nPilih produk di bawah ini:`;
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
        [Markup.button.callback('🔙 Batal / Katalog', 'user_catalog')]
      ]);
      await safeUpdateMainDisplay(ctx, `🛒 *PEMBELIAN: ${prod.name}*\n💰 *Harga:* Rp${prod.price.toLocaleString('id-ID')}\n📦 *Stok Tersedia:* ${res.stock_count}\n\nApakah Anda punya Kode Voucher Diskon?`, buttons);
    });
  });
});

bot.action(/^vouc_(.+)$/, async (ctx) => {
  const prodId = ctx.match[1];
  userState[ctx.from.id] = { step: 'INPUT_VOUCHER', prodId: prodId };
  await safeUpdateMainDisplay(ctx, `🎟️ *MASUKKAN KODE VOUCHER*\n\nSilakan ketik kode voucher diskon Anda di chat ini:`, Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', `buy_${prodId}`)]]));
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
          `📸 *Kirimkan foto Bukti Transfer ke chat ini sekarang!*`;

        if (store && store.qris) {
          await ctx.replyWithPhoto(store.qris, { caption: detailText, parse_mode: 'Markdown' });
        } else {
          await ctx.replyWithMarkdown(detailText);
        }
      });
    });
  });
});

// DASHBOARD ADMIN
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

bot.action('admin_backup', async (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  try {
    await ctx.replyWithDocument({ source: dbPath, filename: 'database.db' }, { caption: '💾 *DATABASE BACKUP*', parse_mode: 'Markdown' });
  } catch (e) { ctx.reply('❌ Gagal backup.'); }
});

bot.action('admin_add_prod', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'ADD_PROD_NAME' };
  ctx.reply('Masukkan Nama Produk:');
});

bot.action('admin_del_prod', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  db.all(`SELECT * FROM products`, (err, rows) => {
    if (!rows || rows.length === 0) return ctx.reply('Tidak ada produk.');
    const buttons = rows.map(p => [Markup.button.callback(`🗑️ ${p.name}`, `delprod_${p.id}`)]);
    ctx.reply('Pilih produk:', Markup.inlineKeyboard(buttons));
  });
});

bot.action(/^delprod_(.+)$/, (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  db.run(`DELETE FROM products WHERE id = ?`, [ctx.match[1]]);
  db.run(`DELETE FROM stock_items WHERE product_id = ?`, [ctx.match[1]]);
  ctx.reply('✅ Produk dihapus!');
});

bot.action('admin_add_stock', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  db.all(`SELECT * FROM products`, (err, rows) => {
    if (!rows || rows.length === 0) return ctx.reply('Tambah produk dulu!');
    const buttons = rows.map(p => [Markup.button.callback(`📦 ${p.name}`, `addstock_${p.id}`)]);
    ctx.reply('Pilih produk:', Markup.inlineKeyboard(buttons));
  });
});

bot.action(/^addstock_(.+)$/, (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'ADD_STOCK_CONTENT', prodId: ctx.match[1] };
  ctx.reply('Kirim isi stok (bisa banyak baris):');
});

bot.action('admin_edit_store', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'EDIT_STORE_NAME' };
  ctx.reply('Masukkan Nama Toko Baru:');
});

bot.action('admin_set_uname', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'SET_UNAME' };
  ctx.reply('Ketik Username Admin (contoh: @Admin):');
});

bot.action('admin_set_channel', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'SET_CHANNEL' };
  ctx.reply('Ketik Channel Wajib Join (atau 0 untuk matikan):');
});

bot.action('admin_set_payment', async (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  ctx.reply('Pilih metode:', Markup.inlineKeyboard([
    [Markup.button.callback('💙 Set DANA', 'set_dana'), Markup.button.callback('🟢 Set GOPAY', 'set_gopay')],
    [Markup.button.callback('🖼️ Set QRIS', 'set_qris')]
  ]));
});

bot.action('set_dana', (ctx) => { userState[getAdminId()] = { step: 'SET_DANA' }; ctx.reply('Ketik No DANA:'); });
bot.action('set_gopay', (ctx) => { userState[getAdminId()] = { step: 'SET_GOPAY' }; ctx.reply('Ketik No GOPAY:'); });
bot.action('set_qris', (ctx) => { userState[getAdminId()] = { step: 'SET_QRIS' }; ctx.reply('Kirim foto QRIS:'); });
bot.action('admin_set_log_group', (ctx) => { userState[getAdminId()] = { step: 'SET_LOG_GROUP' }; ctx.reply('Ketik ID Grup Testimoni:'); });

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
    ctx.reply('Pilih voucher:', Markup.inlineKeyboard(buttons));
  });
});

bot.action(/^delvouc_(.+)$/, (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  db.run(`DELETE FROM vouchers WHERE code = ?`, [ctx.match[1]]);
  ctx.reply('✅ Voucher dihapus!');
});

bot.action('admin_broadcast', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'BROADCAST_USER' };
  ctx.reply('Ketik pesan broadcast ke user:');
});

bot.action('admin_broadcast_group', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'BROADCAST_GROUP' };
  ctx.reply('Ketik pesan broadcast ke grup:');
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
    ctx.reply('✅ QRIS disimpan!');
  } else if (state && state.step === 'ADD_PROD_PHOTO' && Number(ctx.from.id) === adminId) {
    db.run(`INSERT INTO products (name, price, photo) VALUES (?, ?, ?)`, [state.name, state.price, photoId]);
    delete userState[adminId];
    ctx.reply('✅ Produk ditambahkan!');
  }
});

// HANDLER TEXT
bot.on('text', (ctx) => {
  const adminId = getAdminId();
  const state = userState[ctx.from.id];
  if (!state) return;

  if (state.step === 'INPUT_VOUCHER') {
    const code = ctx.message.text.trim().toUpperCase();
    db.get(`SELECT * FROM vouchers WHERE code = ? AND quota > 0`, [code], (err, vouc) => {
      if (!vouc) {
        ctx.reply('⚠️ Voucher tidak valid! Melanjutkan tanpa voucher...');
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
    ctx.reply('⭐️ Terima kasih ulasannya!');
    db.get(`SELECT log_group_id FROM store WHERE id = 1`, (err, store) => {
      if (store && store.log_group_id) {
        bot.telegram.sendMessage(store.log_group_id, `⭐️ *ULASAN PEMBELI*\n👤 ${ctx.from.first_name}\n⭐ ${'⭐'.repeat(state.stars)}\n💬 "${reviewText}"`, { parse_mode: 'Markdown' }).catch(() => {});
      }
    });
    return;
  }

  if (Number(ctx.from.id) === adminId) {
    if (state.step === 'ADD_PROD_NAME') {
      userState[adminId] = { step: 'ADD_PROD_PRICE', name: ctx.message.text.trim() };
      ctx.reply('Masukkan Harga:');
    } else if (state.step === 'ADD_PROD_PRICE') {
      const price = parseInt(ctx.message.text.trim());
      if (isNaN(price)) return ctx.reply('⚠️ Masukkan angka!');
      userState[adminId] = { step: 'ADD_PROD_PHOTO', name: state.name, price: price };
      ctx.reply('Kirim foto produk (atau ketik "skip"):');
    } else if (state.step === 'ADD_PROD_PHOTO' && ctx.message.text.toLowerCase() === 'skip') {
      db.run(`INSERT INTO products (name, price, photo) VALUES (?, ?, '')`, [state.name, state.price]);
      delete userState[adminId];
      ctx.reply('✅ Produk ditambahkan!');
    } else if (state.step === 'ADD_STOCK_CONTENT') {
      const items = ctx.message.text.split('\n').map(i => i.trim()).filter(i => i !== '');
      items.forEach(i => db.run(`INSERT INTO stock_items (product_id, content) VALUES (?, ?)`, [state.prodId, i]));
      delete userState[adminId];
      ctx.reply(`✅ Berhasil tambah ${items.length} stok!`);
    } else if (state.step === 'EDIT_STORE_NAME') {
      userState[adminId] = { step: 'EDIT_STORE_DESC', name: ctx.message.text.trim() };
      ctx.reply('Masukkan Deskripsi Baru:');
    } else if (state.step === 'EDIT_STORE_DESC') {
      db.run(`UPDATE store SET name = ?, desc = ? WHERE id = 1`, [state.name, ctx.message.text.trim()]);
      delete userState[adminId];
      ctx.reply('✅ Info toko diperbarui!');
    } else if (state.step === 'ADD_VOUC_CODE') {
      userState[adminId] = { step: 'ADD_VOUC_DISC', code: ctx.message.text.trim().toUpperCase() };
      ctx.reply('Masukkan Jumlah Potongan (contoh: 5000):');
    } else if (state.step === 'ADD_VOUC_DISC') {
      userState[adminId] = { step: 'ADD_VOUC_QUOTA', code: state.code, discount: parseInt(ctx.message.text.trim()) };
      ctx.reply('Masukkan Kuota:');
    } else if (state.step === 'ADD_VOUC_QUOTA') {
      db.run(`INSERT OR REPLACE INTO vouchers (code, discount, quota) VALUES (?, ?, ?)`, [state.code, state.discount, parseInt(ctx.message.text.trim())]);
      delete userState[adminId];
      ctx.reply(`✅ Voucher ${state.code} dibuat!`);
    } else if (state.step === 'SET_UNAME') {
      db.run(`UPDATE store SET admin_uname = ? WHERE id = 1`, [ctx.message.text.trim()]);
      delete userState[adminId];
      ctx.reply('✅ Username Admin disimpan!');
    } else if (state.step === 'SET_CHANNEL') {
      db.run(`UPDATE store SET required_channel = ? WHERE id = 1`, [ctx.message.text.trim() === '0' ? '' : ctx.message.text.trim()]);
      delete userState[adminId];
      ctx.reply('✅ Channel diperbarui!');
    } else if (state.step === 'SET_DANA') {
      db.run(`UPDATE store SET dana = ? WHERE id = 1`, [ctx.message.text.trim()]);
      delete userState[adminId];
      ctx.reply('✅ DANA disimpan!');
    } else if (state.step === 'SET_GOPAY') {
      db.run(`UPDATE store SET gopay = ? WHERE id = 1`, [ctx.message.text.trim()]);
      delete userState[adminId];
      ctx.reply('✅ GOPAY disimpan!');
    } else if (state.step === 'SET_LOG_GROUP') {
      db.run(`UPDATE store SET log_group_id = ? WHERE id = 1`, [ctx.message.text.trim()]);
      delete userState[adminId];
      ctx.reply('✅ Grup Log diset!');
    } else if (state.step === 'BROADCAST_USER') {
      const text = ctx.message.text;
      delete userState[adminId];
      db.all(`SELECT user_id FROM users`, (err, users) => {
        if (users) users.forEach(u => bot.telegram.sendMessage(u.user_id, `📢 *INFO*\n\n${text}`, { parse_mode: 'Markdown' }).catch(() => {}));
        ctx.reply('✅ Broadcast terkirim!');
      });
    }
  }
});

// APPROVE & REJECT ORDER
bot.action(/^app_(.+)$/, (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  const orderId = ctx.match[1];

  db.get(`SELECT o.*, p.name as product_name, p.price as product_price FROM orders o JOIN products p ON o.product_id = p.id WHERE o.id = ?`, [orderId], (err, order) => {
    if (!order || order.status !== 'PROSES') return ctx.reply('Sudah diproses.');

    db.get(`SELECT * FROM stock_items WHERE product_id = ? AND status = 'AVAILABLE' LIMIT 1`, [order.product_id], (err, stock) => {
      if (!stock) return ctx.reply(`⚠️ Stok habis!`);

      db.run(`UPDATE orders SET status = 'APPROVED' WHERE id = ?`, [orderId]);
      db.run(`UPDATE stock_items SET status = 'SOLD' WHERE id = ?`, [stock.id]);

      const ratingButtons = Markup.inlineKeyboard([
        [Markup.button.callback('⭐ 1', `rate_1`), Markup.button.callback('⭐ 2', `rate_2`), Markup.button.callback('⭐ 3', `rate_3`), Markup.button.callback('⭐ 4', `rate_4`), Markup.button.callback('⭐ 5', `rate_5`)]
      ]);

      bot.telegram.sendMessage(order.user_id, `🎉 *PEMBAYARAN DISETUJUI!*\n\nItem Anda (#${orderId}):\n\`${stock.content}\`\n\n⭐ Berikan penilaian:`, { parse_mode: 'Markdown', ...ratingButtons });
      ctx.reply(`✅ Order #${orderId} Di-Approve.`);
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
  ctx.reply(`❌ Order #${orderId} Ditolak.`);
});

bot.launch();
console.log('Bot Telegram Running...');
