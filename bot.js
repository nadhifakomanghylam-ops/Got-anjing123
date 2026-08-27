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

// 1. DATABASE SETUP
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
    created_at TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS stock_items (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER, content TEXT, status TEXT DEFAULT 'AVAILABLE')`);
  
  db.get(`SELECT * FROM store WHERE id = 1`, (err, row) => {
    if (!row) {
      db.run(`INSERT INTO store (id, name, desc, photo, qris, dana, gopay, admin_uname, required_channel, log_group_id) VALUES (1, '🛍️ TOKO DIGITAL', 'Selamat datang di toko kami!', '', '', '', '', '', '', '')`);
    }
  });
});

const userState = {};
const userSpamMap = new Map();

const deleteMessage = async (ctx) => {
  try {
    if (ctx.callbackQuery && ctx.callbackQuery.message) {
      await ctx.deleteMessage(ctx.callbackQuery.message.message_id);
    }
  } catch (e) {}
};

// SIMPAN STATISTIK USER & GRUP
const saveUserAndVisitor = (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username ? `@${ctx.from.username}` : '';
  const firstName = ctx.from.first_name || 'User';
  const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

  db.run(`INSERT OR IGNORE INTO users (user_id) VALUES (?)`, [userId]);
  db.run(`INSERT OR IGNORE INTO visitors (user_id, username, first_name, joined_at) VALUES (?, ?, ?, ?)`, [userId, username, firstName, now]);
};

const saveGroup = (groupId) => db.run(`INSERT OR IGNORE INTO groups (group_id) VALUES (?)`, [groupId]);

// ANTI LINK WA & TELEGRAM + ANTI SPAM CHAT DI GRUP
bot.use(async (ctx, next) => {
  if (ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup')) {
    saveGroup(ctx.chat.id);
    const userId = ctx.from.id;

    if (userId === getAdminId()) return next();

    if (ctx.message && ctx.message.text) {
      const text = ctx.message.text.toLowerCase();
      const linkRegex = /(chat\.whatsapp\.com|wa\.me|t\.me|telegram\.me)/i;
      if (linkRegex.test(text)) {
        try {
          await ctx.deleteMessage();
          const warning = await ctx.reply(`⚠️ *@${ctx.from.username || ctx.from.first_name}*, dilarang mengirim link WhatsApp/Telegram di grup ini!`, { parse_mode: 'Markdown' });
          setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, warning.message_id).catch(() => {}), 5000);
        } catch (e) {}
        return;
      }
    }

    const now = Date.now();
    const userData = userSpamMap.get(userId) || { count: 0, lastMsgTime: now };
    if (now - userData.lastMsgTime < 4000) {
      userData.count += 1;
      if (userData.count > 3) {
        try { await ctx.deleteMessage(); } catch (e) {}
        return;
      }
    } else {
      userData.count = 1;
      userData.lastMsgTime = now;
    }
    userSpamMap.set(userId, userData);
  }
  return next();
});

// CHECK MEMBERSHIP WAJIB JOIN
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
    [Markup.button.callback('✅ Saya Sudah Join', 'check_join')]
  ]);
  ctx.replyWithMarkdown(`⚠️ *AKSES DIBATASI*\n\nSilakan bergabung ke Channel resmi terlebih dahulu.`, buttons);
};

// KEYBOARD MENU UTAMA & ADMIN
const getMainMenu = (userId) => {
  const adminId = getAdminId();
  const buttons = [
    [Markup.button.callback('🛒 Katalog Produk', 'user_catalog'), Markup.button.callback('📞 Customer Service', 'user_contact')],
    [Markup.button.callback('🆔 Cek Akun ID', 'user_check_id')]
  ];
  if (Number(userId) === adminId && adminId !== 0) {
    buttons.push([Markup.button.callback('⚙️ Dashboard Admin', 'admin_dashboard')]);
  }
  return Markup.inlineKeyboard(buttons);
};

const getAdminMenu = () => {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📊 Statistik Pengunjung', 'admin_stats'), Markup.button.callback('💾 Backup Database', 'admin_backup')],
    [Markup.button.callback('➕ Tambah Produk', 'admin_add_prod'), Markup.button.callback('🗑️ Hapus Produk', 'admin_del_prod')],
    [Markup.button.callback('📦 Isi Stok Produk', 'admin_add_stock'), Markup.button.callback('💳 Set Metode Pembayaran', 'admin_set_payment')],
    [Markup.button.callback('✏️ Edit Info/Foto Toko', 'admin_edit_store'), Markup.button.callback('👤 Set Admin Username', 'admin_set_uname')],
    [Markup.button.callback('🔒 Wajib Join Channel', 'admin_set_channel'), Markup.button.callback('📢 Set Grup Log & Testi', 'admin_set_log_group')],
    [Markup.button.callback('📢 Broadcast All User', 'admin_broadcast'), Markup.button.callback('📢 Broadcast All Grup', 'admin_broadcast_group')],
    [Markup.button.callback('🔙 Kembali ke Menu Utama', 'main_menu')]
  ]);
};

// COMMANDS
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
  await deleteMessage(ctx);
  db.get(`SELECT * FROM store WHERE id = 1`, (err, store) => {
    const text = `🏬 *${store.name}*\n\n${store.desc}`;
    if (store.photo) {
      ctx.replyWithPhoto(store.photo, { caption: text, parse_mode: 'Markdown', ...getMainMenu(ctx.from.id) });
    } else {
      ctx.replyWithMarkdown(text, getMainMenu(ctx.from.id));
    }
  });
});

bot.action('user_check_id', async (ctx) => {
  ctx.answerCbQuery();
  ctx.replyWithMarkdown(`👤 *ID Pengguna Anda:* \`${ctx.from.id}\``);
});

bot.action('user_contact', checkMembership, async (ctx) => {
  ctx.answerCbQuery();
  db.get(`SELECT admin_uname FROM store WHERE id = 1`, (err, store) => {
    const uname = (store && store.admin_uname) ? store.admin_uname.replace('@', '') : '';
    if (uname) {
      ctx.reply(`Silakan hubungi Customer Service:`, Markup.inlineKeyboard([[Markup.button.url('💬 Chat Admin', `https://t.me/${uname}`)]]));
    } else {
      ctx.replyWithMarkdown(`Admin belum mengatur Username.`);
    }
  });
});

// KATALOG & PEMBAYARAN DIPISAHKAN
bot.action('user_catalog', checkMembership, async (ctx) => {
  await deleteMessage(ctx);
  const query = `SELECT p.*, COUNT(s.id) AS stock_count FROM products p LEFT JOIN stock_items s ON p.id = s.product_id AND s.status = 'AVAILABLE' GROUP BY p.id`;
  db.all(query, (err, products) => {
    if (!products || products.length === 0) return ctx.reply('⚠️ Katalog produk saat ini kosong.', Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali', 'main_menu')]]));
    
    products.forEach((prod) => {
      const btnText = prod.stock_count > 0 ? `🛒 Beli (Rp${prod.price.toLocaleString('id-ID')})` : `❌ Stok Habis`;
      const buttons = [[Markup.button.callback(btnText, `buy_${prod.id}`)], [Markup.button.callback('🔙 Menu Utama', 'main_menu')]];
      const caption = `📌 *${prod.name}*\n💰 *Harga:* Rp${prod.price.toLocaleString('id-ID')}\n📦 *Sisa Stok:* ${prod.stock_count} item`;
      if (prod.photo) ctx.replyWithPhoto(prod.photo, { caption, parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
      else ctx.replyWithMarkdown(caption, Markup.inlineKeyboard(buttons));
    });
  });
});

bot.action(/^buy_(.+)$/, checkMembership, async (ctx) => {
  await deleteMessage(ctx);
  const prodId = ctx.match[1];
  
  db.get(`SELECT * FROM products WHERE id = ?`, [prodId], (err, prod) => {
    db.get(`SELECT COUNT(id) AS stock_count FROM stock_items WHERE product_id = ? AND status = 'AVAILABLE'`, [prodId], (err, res) => {
      if (!res || res.stock_count <= 0) return ctx.reply(`⚠️ Stok *${prod.name}* sedang habis!`);

      const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
      const username = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'Buyer');

      db.run(`INSERT INTO orders (user_id, username, product_id, status, created_at) VALUES (?, ?, ?, 'PENDING', ?)`, [ctx.from.id, username, prodId, now], function(err) {
        const orderId = this.lastID;
        userState[ctx.from.id] = { step: 'WAITING_PROOF', orderId: orderId };

        db.get(`SELECT * FROM store WHERE id = 1`, (err, store) => {
          const detailText = `🧾 *RINCIAN PESANAN #${orderId}*\n\n` +
            `📦 *Produk:* ${prod.name}\n` +
            `💵 *Total:* Rp${prod.price.toLocaleString('id-ID')}\n` +
            `👤 *Pembeli:* ${username}\n` +
            `🕒 *Waktu:* ${now}\n\n` +
            `💳 *METODE PEMBAYARAN:*\n` +
            `💙 *DANA:* \`${store.dana || 'Belum diset'}\`\n` +
            `🟢 *GOPAY:* \`${store.gopay || 'Belum diset'}\`\n` +
            `_(Ketuk angka rekening/e-wallet di atas untuk menyalin otomatis)_\n\n` +
            `📸 *Setelah bayar, wajib kirimkan foto Bukti Transfer ke chat ini!*`;

          if (store && store.qris) {
            ctx.replyWithPhoto(store.qris, { caption: detailText, parse_mode: 'Markdown' });
          } else {
            ctx.replyWithMarkdown(detailText);
          }
        });
      });
    });
  });
});

// DASHBOARD ADMIN & BROADCAST GRUP
bot.action('admin_dashboard', async (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  await deleteMessage(ctx);
  ctx.replyWithMarkdown('⚙️ *DASHBOARD ADMIN TOKO*', getAdminMenu());
});

bot.action('admin_broadcast_group', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'BROADCAST_GROUP' };
  ctx.reply('Ketikkan pesan broadcast yang ingin dikirim ke SELURUH GRUP:');
});

bot.action('admin_stats', async (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  db.get(`SELECT COUNT(user_id) AS total_visitors FROM visitors`, (err, row) => {
    db.get(`SELECT COUNT(group_id) AS total_groups FROM groups`, (err, gRow) => {
      ctx.replyWithMarkdown(`📊 *STATISTIK BOT*\n\n👤 *Pengunjung Unik:* ${row ? row.total_visitors : 0}\n👥 *Total Grup:* ${gRow ? gRow.total_groups : 0}`);
    });
  });
});

bot.action('admin_backup', async (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  try {
    await ctx.replyWithDocument({ source: dbPath, filename: 'database.db' }, { caption: '💾 *DATABASE BACKUP SUKSES*', parse_mode: 'Markdown' });
  } catch (e) { ctx.reply('❌ Gagal backup: ' + e.message); }
});

bot.action('admin_set_payment', async (ctx) => {
  await deleteMessage(ctx);
  ctx.reply('Pilih pengaturan pembayaran:', Markup.inlineKeyboard([
    [Markup.button.callback('💙 Set DANA', 'set_dana'), Markup.button.callback('🟢 Set GOPAY', 'set_gopay')],
    [Markup.button.callback('🖼️ Set QRIS (Foto)', 'set_qris')],
    [Markup.button.callback('🔙 Batal', 'admin_dashboard')]
  ]));
});

bot.action('set_dana', (ctx) => { userState[getAdminId()] = { step: 'SET_DANA' }; ctx.reply('Ketik No DANA:'); });
bot.action('set_gopay', (ctx) => { userState[getAdminId()] = { step: 'SET_GOPAY' }; ctx.reply('Ketik No GOPAY:'); });
bot.action('set_qris', (ctx) => { userState[getAdminId()] = { step: 'SET_QRIS' }; ctx.reply('Kirim foto QRIS:'); });
bot.action('admin_set_log_group', (ctx) => { userState[getAdminId()] = { step: 'SET_LOG_GROUP' }; ctx.reply('Ketik ID Grup Log/Testimoni (contoh: -100xxx):'); });

// HANDLER FOTO BUKTI TRANSFER & METODE PEMBAYARAN
bot.on('photo', (ctx) => {
  const adminId = getAdminId();
  const state = userState[ctx.from.id];
  const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;

  if (state && state.step === 'WAITING_PROOF') {
    db.run(`UPDATE orders SET proof = ?, status = 'PROSES' WHERE id = ?`, [photoId, state.orderId]);
    delete userState[ctx.from.id];
    ctx.reply('✅ Bukti pembayaran diterima! Sedang diproses Admin.');
    
    const adminButtons = Markup.inlineKeyboard([[Markup.button.callback('✅ Approve Order', `app_${state.orderId}`), Markup.button.callback('❌ Reject Order', `rej_${state.orderId}`)]]);
    const proofText = `🔔 *BUKTI PEMBAYARAN MASUK!*\n\n🧾 *Order ID:* #${state.orderId}\n👤 *Pembeli:* ${ctx.from.username ? '@' + ctx.from.username : ctx.from.first_name}\n🆔 *User ID:* \`${ctx.from.id}\``;
    if (adminId !== 0) bot.telegram.sendPhoto(adminId, photoId, { caption: proofText, parse_mode: 'Markdown', ...adminButtons });
  } else if (state && state.step === 'SET_QRIS' && Number(ctx.from.id) === adminId) {
    db.run(`UPDATE store SET qris = ? WHERE id = 1`, [photoId]);
    delete userState[adminId];
    ctx.reply('✅ Foto QRIS disimpan!');
  }
});

bot.on('text', (ctx) => {
  const adminId = getAdminId();
  const state = userState[ctx.from.id];
  if (!state) return;

  if (Number(ctx.from.id) === adminId) {
    if (state.step === 'SET_DANA') {
      db.run(`UPDATE store SET dana = ? WHERE id = 1`, [ctx.message.text.trim()]);
      delete userState[adminId];
      ctx.reply(`✅ No DANA disimpan: ${ctx.message.text.trim()}`);
    } else if (state.step === 'SET_GOPAY') {
      db.run(`UPDATE store SET gopay = ? WHERE id = 1`, [ctx.message.text.trim()]);
      delete userState[adminId];
      ctx.reply(`✅ No GOPAY disimpan: ${ctx.message.text.trim()}`);
    } else if (state.step === 'SET_LOG_GROUP') {
      db.run(`UPDATE store SET log_group_id = ? WHERE id = 1`, [ctx.message.text.trim()]);
      delete userState[adminId];
      ctx.reply(`✅ ID Grup Testimoni diset ke: ${ctx.message.text.trim()}`);
    } else if (state.step === 'BROADCAST_GROUP') {
      const text = ctx.message.text;
      delete userState[adminId];
      db.all(`SELECT group_id FROM groups`, (err, groups) => {
        if (groups && groups.length > 0) {
          groups.forEach(g => bot.telegram.sendMessage(g.group_id, `📢 *INFORMASI TOKO*\n\n${text}`, { parse_mode: 'Markdown' }).catch(() => {}));
          ctx.reply(`✅ Broadcast berhasil dikirim ke ${groups.length} grup!`);
        } else {
          ctx.reply('⚠️ Belum ada grup terdaftar.');
        }
      });
    }
  }
});

// ACC & AUTO UPLOAD TESTIMONI KE GRUP
bot.action(/^app_(.+)$/, (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  const orderId = ctx.match[1];

  db.get(`SELECT o.*, p.name as product_name, p.price as product_price FROM orders o JOIN products p ON o.product_id = p.id WHERE o.id = ?`, [orderId], (err, order) => {
    if (!order || order.status !== 'PROSES') return ctx.reply('Pesanan ini sudah diproses.');

    db.get(`SELECT * FROM stock_items WHERE product_id = ? AND status = 'AVAILABLE' LIMIT 1`, [order.product_id], (err, stock) => {
      if (!stock) return ctx.reply(`⚠️ Stok produk telah HABIS!`);

      db.run(`UPDATE orders SET status = 'APPROVED' WHERE id = ?`, [orderId]);
      db.run(`UPDATE stock_items SET status = 'SOLD' WHERE id = ?`, [stock.id]);

      bot.telegram.sendMessage(order.user_id, `🎉 *PEMBAYARAN DISETUJUI!*\n\nBerikut item pesanan Anda (#${orderId}):\n\`${stock.content}\``, { parse_mode: 'Markdown' });
      ctx.reply(`✅ Order #${orderId} Berhasil Di-Approve.`);

      // UPLOAD TESTIMONI OTOMATIS KE GRUP
      db.get(`SELECT log_group_id FROM store WHERE id = 1`, (err, store) => {
        if (store && store.log_group_id) {
          const testiText = `🎉 *TESTIMONI TRANSAKSI SUKSES*\n\n` +
            `🧾 *ID Transaksi:* #${order.id}\n` +
            `📦 *Produk:* ${order.product_name}\n` +
            `💰 *Harga:* Rp${order.product_price.toLocaleString('id-ID')}\n` +
            `👤 *Pembeli:* ${order.username}\n` +
            `🕒 *Tanggal & Jam:* ${order.created_at}\n\n` +
            `✅ _Status: Lunas & Terkirim Otomatis_`;

          if (order.proof) bot.telegram.sendPhoto(store.log_group_id, order.proof, { caption: testiText, parse_mode: 'Markdown' }).catch(() => {});
          else bot.telegram.sendMessage(store.log_group_id, testiText, { parse_mode: 'Markdown' }).catch(() => {});
        }
      });
    });
  });
});

bot.launch();
console.log('Bot Telegram Berhasil Jalan!');
