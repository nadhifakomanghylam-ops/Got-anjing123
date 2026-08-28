require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const axios = require('axios');

const bot = new Telegraf(process.env.BOT_TOKEN);

const getAdminId = () => {
  const raw = process.env.ADMIN_ID;
  if (!raw) return 0;
  return Number(String(raw).replace(/[^0-9]/g, ''));
};

const SAWERIA_USERNAME = process.env.SAWERIA_USERNAME || '';
const SAWERIA_STREAM_KEY = process.env.SAWERIA_STREAM_KEY || '';

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
    amount INTEGER DEFAULT 0,
    created_at TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS stock_items (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER, content TEXT, status TEXT DEFAULT 'AVAILABLE')`);
  db.run(`CREATE TABLE IF NOT EXISTS vouchers (code TEXT PRIMARY KEY, discount INTEGER, quota INTEGER)`);
  
  db.run(`CREATE TABLE IF NOT EXISTS auto_reply (
    keyword TEXT PRIMARY KEY, 
    reply_type TEXT DEFAULT 'text',
    content TEXT,
    file_id TEXT,
    btn_label TEXT,
    btn_url TEXT
  )`);
  
  db.get(`SELECT * FROM store WHERE id = 1`, (err, row) => {
    if (!row) {
      db.run(`INSERT INTO store (id, name, desc, photo, qris, dana, gopay, admin_uname, required_channel, log_group_id) VALUES (1, '🛍️ TOKO DIGITAL', 'Selamat datang di toko kami!', '', '', '', '', '', '', '')`);
    }
  });
});

const userState = {};

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
    if (!row) db.run(`INSERT INTO users (user_id, upline_id) VALUES (?, ?)`, [userId, uplineId]);
  });
  db.run(`INSERT OR IGNORE INTO visitors (user_id, username, first_name, joined_at) VALUES (?, ?, ?, ?)`, [userId, username, firstName, now]);
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
    [Markup.button.callback('📦 Tambah Stok (Massal)', 'admin_add_stock'), Markup.button.callback('✏️ Edit Info Toko', 'admin_edit_store')],
    [Markup.button.callback('🖼️ Ganti Foto Header', 'admin_set_header_photo'), Markup.button.callback('🤖 Atur Auto-Reply', 'admin_autoreply_type')],
    [Markup.button.callback('🗑️ Hapus Auto-Reply', 'admin_del_autoreply'), Markup.button.callback('👤 Set Admin Uname', 'admin_set_uname')],
    [Markup.button.callback('🔒 Wajib Join Channel', 'admin_set_channel'), Markup.button.callback('📢 Grup Log/Testi', 'admin_set_log_group')],
    [Markup.button.callback('🎁 Buat Voucher', 'admin_add_voucher'), Markup.button.callback('🗑️ Hapus Voucher', 'admin_del_voucher')],
    [Markup.button.callback('📢 Broadcast Chat', 'admin_broadcast_menu'), Markup.button.callback('🔗 Broadcast + Button', 'admin_bc_button')],
    [Markup.button.callback('🔙 Menu Utama', 'main_menu')]
  ]);
};

bot.start(async (ctx) => {
  saveUserAndVisitor(ctx);
  db.get(`SELECT * FROM store WHERE id = 1`, (err, store) => {
    const text = `🏬 *${store.name}*\n\n${store.desc}`;
    if (store && store.photo) {
      ctx.replyWithPhoto(store.photo, { caption: text, parse_mode: 'Markdown', ...getMainMenu(ctx.from.id) });
    } else {
      ctx.replyWithMarkdown(text, getMainMenu(ctx.from.id));
    }
  });
});

bot.action('main_menu', async (ctx) => {
  db.get(`SELECT * FROM store WHERE id = 1`, async (err, store) => {
    const text = `🏬 *${store.name}*\n\n${store.desc}`;
    if (store && store.photo) {
      await safeUpdateMainDisplay(ctx, text, { photo: store.photo, ...getMainMenu(ctx.from.id) });
    } else {
      await safeUpdateMainDisplay(ctx, text, getMainMenu(ctx.from.id));
    }
  });
});

bot.action('user_check_id', async (ctx) => {
  ctx.answerCbQuery();
  ctx.replyWithMarkdown(`👤 *ID Telegram Anda:* \`${ctx.from.id}\``);
});

bot.action('user_faq', async (ctx) => {
  ctx.answerCbQuery();
  const faqText = `📖 *CARA BELANJA DI TOKO KAMI*\n\n` +
    `1️⃣ Pilih menu *Katalog Produk*.\n` +
    `2️⃣ Pilih produk yang ingin dibeli.\n` +
    `3️⃣ Klik *Bayar QRIS Otomatis*.\n` +
    `4️⃣ Scan & Bayar QRIS sesuai Nominal Pas.\n` +
    `5️⃣ Klik tombol *Cek Status Pembayaran*.\n` +
    `6️⃣ Produk/akun akan langsung terkirim otomatis!`;
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

bot.action('user_contact', async (ctx) => {
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

// KATALOG & SAWERIA QRIS AUTOMATIC
bot.action('user_catalog', async (ctx) => {
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

bot.action(/^buy_(.+)$/, async (ctx) => {
  const prodId = ctx.match[1];
  db.get(`SELECT * FROM products WHERE id = ?`, [prodId], (err, prod) => {
    db.get(`SELECT COUNT(id) AS stock_count FROM stock_items WHERE product_id = ? AND status = 'AVAILABLE'`, [prodId], async (err, res) => {
      if (!res || res.stock_count <= 0) {
        return ctx.answerCbQuery(`⚠️ Stok ${prod.name} habis!`, { show_alert: true });
      }
      const buttons = Markup.inlineKeyboard([
        [Markup.button.callback('🎟️ Pakai Kode Voucher', `vouc_${prodId}`)],
        [Markup.button.callback('💳 Bayar QRIS Otomatis', `pay_${prodId}_0`)],
        [Markup.button.callback('🔙 Kembali ke Katalog', 'user_catalog')]
      ]);
      await safeUpdateMainDisplay(ctx, `🛒 *PEMBELIAN: ${prod.name}*\n💰 *Harga:* Rp${prod.price.toLocaleString('id-ID')}\n📦 *Stok Tersedia:* ${res.stock_count}`, buttons);
    });
  });
});

bot.action(/^vouc_(.+)$/, async (ctx) => {
  const prodId = ctx.match[1];
  userState[ctx.from.id] = { step: 'INPUT_VOUCHER', prodId: prodId };
  await safeUpdateMainDisplay(ctx, `🎟️ *MASUKKAN KODE VOUCHER*\n\nKetik kode voucher diskon di chat:`, Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', `buy_${prodId}`)]]));
});

// GENERATE QRIS OTOMATIS
bot.action(/^pay_(.+)_(.+)$/, async (ctx) => {
  const prodId = ctx.match[1];
  const discount = parseInt(ctx.match[2]) || 0;

  db.get(`SELECT * FROM products WHERE id = ?`, [prodId], (err, prod) => {
    const uniqueCode = Math.floor(Math.random() * 900) + 100;
    const basePrice = Math.max(1000, prod.price - discount);
    const finalPrice = basePrice + uniqueCode;
    const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    const username = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'Buyer');

    db.run(`INSERT INTO orders (user_id, username, product_id, status, discount, amount, created_at) VALUES (?, ?, ?, 'PENDING', ?, ?, ?)`, 
      [ctx.from.id, username, prodId, discount, finalPrice, now], async function(err) {
      const orderId = this.lastID;
      
      const saweriaUrl = `https://saweria.co/${SAWERIA_USERNAME}?amount=${finalPrice}&msg=ORDER${orderId}`;
      const qrisApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(saweriaUrl)}`;

      const detailText = `🧾 *PESANAN #${orderId}*\n\n` +
        `📦 *Produk:* ${prod.name}\n` +
        `💰 *Total Pas:* *Rp${finalPrice.toLocaleString('id-ID')}*\n` +
        `⚠️ *PENTING:* Harus bayar sesuai *NOMINAL PAS* (termasuk kode unik) agar otomatis terverifikasi!\n\n` +
        `📲 Scan QRIS di atas atau Klik tombol *BAYAR SEKARANG* di bawah:`;

      const buttons = Markup.inlineKeyboard([
        [Markup.button.url('💳 BAYAR SEKARANG (QRIS)', saweriaUrl)],
        [Markup.button.callback('🔄 Cek Status Pembayaran', `check_pay_${orderId}`)],
        [Markup.button.callback('❌ Batal Pesanan', 'user_catalog')]
      ]);

      await ctx.replyWithPhoto(qrisApiUrl, { caption: detailText, parse_mode: 'Markdown', ...buttons });
    });
  });
});

// AUTO CHECK PEMBAYARAN SAWERIA
bot.action(/^check_pay_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  db.get(`SELECT o.*, p.name as product_name FROM orders o JOIN products p ON o.product_id = p.id WHERE o.id = ?`, [orderId], async (err, order) => {
    if (!order) return ctx.answerCbQuery('Pesanan tidak ditemukan.', { show_alert: true });
    if (order.status === 'APPROVED') return ctx.answerCbQuery('Pesanan ini sudah selesai!', { show_alert: true });

    try {
      const res = await axios.get(`https://api.saweria.co/stream?streamKey=${SAWERIA_STREAM_KEY}`);
      const donations = res.data.data || [];
      
      const matched = donations.find(d => Number(d.amount) === Number(order.amount));

      if (matched) {
        db.get(`SELECT * FROM stock_items WHERE product_id = ? AND status = 'AVAILABLE' LIMIT 1`, [order.product_id], (err, stock) => {
          if (!stock) {
            return ctx.reply(`⚠️ Pembayaran sukses terdeteksi, tetapi stok habis! Hubungi Admin.`);
          }

          db.run(`UPDATE orders SET status = 'APPROVED' WHERE id = ?`, [orderId]);
          db.run(`UPDATE stock_items SET status = 'SOLD' WHERE id = ?`, [stock.id]);

          ctx.replyWithMarkdown(`🎉 *PEMBAYARAN QRIS TERVERIFIKASI!*\n\nDetail Akun/Produk (#${orderId}):\n\`${stock.content}\``);

          db.get(`SELECT log_group_id FROM store WHERE id = 1`, (err, store) => {
            if (store && store.log_group_id) {
              const testiText = `🎉 *TRANSAKSI SUKSES (QRIS)*\n\n🧾 *ID:* #${order.id}\n📦 *Produk:* ${order.product_name}\n💰 *Total:* Rp${order.amount.toLocaleString('id-ID')}\n👤 *Buyer:* ${order.username}`;
              bot.telegram.sendMessage(store.log_group_id, testiText, { parse_mode: 'Markdown' }).catch(() => {});
            }
          });
        });
      } else {
        ctx.answerCbQuery('❌ Pembayaran belum terdeteksi. Silakan coba 10-20 detik lagi setelah bayar.', { show_alert: true });
      }
    } catch (e) {
      ctx.answerCbQuery('⚠️ Pembayaran belum masuk / Gagal terhubung ke Saweria.', { show_alert: true });
    }
  });
});

// DASHBOARD ADMIN & ACTION HANDLERS
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

bot.action('admin_edit_store', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'EDIT_STORE_NAME' };
  ctx.reply('Masukkan Nama Toko Baru:');
});

bot.action('admin_set_header_photo', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'SET_HEADER_PHOTO' };
  ctx.reply('Kirimkan foto/gambar untuk dijadikan Banner Header Toko:');
});

bot.action('admin_set_uname', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'SET_ADMIN_UNAME' };
  ctx.reply('Masukkan Username Telegram CS (Contoh: @AdminStore):');
});

bot.action('admin_set_channel', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'SET_REQ_CHANNEL' };
  ctx.reply('Masukkan Username Channel Wajib Join (Contoh: @ChannelToko):');
});

bot.action('admin_set_log_group', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'SET_LOG_GROUP' };
  ctx.reply('Masukkan ID Grup Log/Testi (Contoh: -10012345678):');
});

bot.action('admin_add_voucher', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'ADD_VOUCHER_CODE' };
  ctx.reply('Masukkan Kode Voucher Baru (Contoh: DISKON50):');
});

bot.action('admin_del_voucher', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  db.all(`SELECT * FROM vouchers`, (err, rows) => {
    if (!rows || rows.length === 0) return ctx.reply('Belum ada voucher.');
    const buttons = rows.map(v => [Markup.button.callback(`🗑️ ${v.code} (Potongan Rp${v.discount})`, `delvouc_${v.code}`)]);
    ctx.reply('Pilih voucher yang ingin dihapus:', Markup.inlineKeyboard(buttons));
  });
});

bot.action(/^delvouc_(.+)$/, (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  db.run(`DELETE FROM vouchers WHERE code = ?`, [ctx.match[1]]);
  ctx.reply('✅ Voucher berhasil dihapus!');
});

bot.action('admin_broadcast_menu', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'BROADCAST_TEXT' };
  ctx.reply('Masukkan pesan teks broadcast yang ingin dikirim ke semua pengguna:');
});

bot.action('admin_bc_button', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'BC_BTN_TEXT' };
  ctx.reply('Masukkan teks pesan broadcast (+ tombol link):');
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

bot.action('admin_autoreply_type', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'ADD_AR_KEYWORD' };
  ctx.reply('Masukkan Kata Kunci Auto-Reply Baru:');
});

bot.action('admin_del_autoreply', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  db.all(`SELECT keyword FROM auto_reply`, (err, rows) => {
    if (!rows || rows.length === 0) return ctx.reply('Belum ada auto-reply.');
    const buttons = rows.map(ar => [Markup.button.callback(`🗑️ ${ar.keyword}`, `delar_${ar.keyword}`)]);
    ctx.reply('Pilih Auto-Reply yang ingin dihapus:', Markup.inlineKeyboard(buttons));
  });
});

bot.action(/^delar_(.+)$/, (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  db.run(`DELETE FROM auto_reply WHERE keyword = ?`, [ctx.match[1]]);
  ctx.reply('✅ Auto-reply berhasil dihapus!');
});

// PHOTO HANDLER FOR BANNER HEADER
bot.on('photo', async (ctx) => {
  const adminId = getAdminId();
  if (Number(ctx.from.id) === adminId && userState[adminId] && userState[adminId].step === 'SET_HEADER_PHOTO') {
    const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    db.run(`UPDATE store SET photo = ? WHERE id = 1`, [photoId]);
    delete userState[adminId];
    ctx.reply('✅ Foto Banner Header Toko Berhasil Diganti!');
  }
});

// HANDLER TEXT ADMIN & USER (FULL ENGINE)
bot.on('text', async (ctx) => {
  const adminId = getAdminId();
  const state = userState[ctx.from.id];

  if (!state) {
    // Check Auto Reply Keyword
    const textMsg = ctx.message.text.trim().toLowerCase();
    db.get(`SELECT * FROM auto_reply WHERE LOWER(keyword) = ?`, [textMsg], (err, ar) => {
      if (ar) {
        if (ar.btn_label && ar.btn_url) {
          ctx.reply(ar.content, Markup.inlineKeyboard([[Markup.button.url(ar.btn_label, ar.btn_url)]]));
        } else {
          ctx.reply(ar.content);
        }
      }
    });
    return;
  }

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

  if (Number(ctx.from.id) === adminId) {
    if (state.step === 'EDIT_STORE_NAME') {
      userState[adminId] = { step: 'EDIT_STORE_DESC', name: ctx.message.text.trim() };
      ctx.reply('Masukkan Deskripsi Toko Baru:');
    } else if (state.step === 'EDIT_STORE_DESC') {
      db.run(`UPDATE store SET name = ?, desc = ? WHERE id = 1`, [state.name, ctx.message.text.trim()]);
      delete userState[adminId];
      ctx.reply('✅ Info Toko berhasil diperbarui!');
    } else if (state.step === 'SET_ADMIN_UNAME') {
      db.run(`UPDATE store SET admin_uname = ? WHERE id = 1`, [ctx.message.text.trim()]);
      delete userState[adminId];
      ctx.reply('✅ Username Admin CS berhasil diperbarui!');
    } else if (state.step === 'SET_REQ_CHANNEL') {
      db.run(`UPDATE store SET required_channel = ? WHERE id = 1`, [ctx.message.text.trim()]);
      delete userState[adminId];
      ctx.reply('✅ Channel Wajib Join berhasil diperbarui!');
    } else if (state.step === 'SET_LOG_GROUP') {
      db.run(`UPDATE store SET log_group_id = ? WHERE id = 1`, [ctx.message.text.trim()]);
      delete userState[adminId];
      ctx.reply('✅ ID Grup Log/Testi berhasil diperbarui!');
    } else if (state.step === 'ADD_VOUCHER_CODE') {
      userState[adminId] = { step: 'ADD_VOUCHER_DISC', code: ctx.message.text.trim().toUpperCase() };
      ctx.reply('Masukkan Potongan Harga Voucher (Angka saja):');
    } else if (state.step === 'ADD_VOUCHER_DISC') {
      const disc = parseInt(ctx.message.text.trim());
      userState[adminId] = { step: 'ADD_VOUCHER_QUOTA', code: state.code, disc: disc };
      ctx.reply('Masukkan Kuota Penggunaan Voucher:');
    } else if (state.step === 'ADD_VOUCHER_QUOTA') {
      const quota = parseInt(ctx.message.text.trim());
      db.run(`INSERT OR REPLACE INTO vouchers (code, discount, quota) VALUES (?, ?, ?)`, [state.code, state.disc, quota]);
      delete userState[adminId];
      ctx.reply('✅ Voucher berhasil dibuat!');
    } else if (state.step === 'ADD_AR_KEYWORD') {
      userState[adminId] = { step: 'ADD_AR_CONTENT', keyword: ctx.message.text.trim() };
      ctx.reply('Masukkan Balasan Pesan Auto-Reply:');
    } else if (state.step === 'ADD_AR_CONTENT') {
      db.run(`INSERT OR REPLACE INTO auto_reply (keyword, reply_type, content) VALUES (?, 'text', ?)`, [state.keyword, ctx.message.text.trim()]);
      delete userState[adminId];
      ctx.reply('✅ Auto-Reply berhasil dibuat!');
    } else if (state.step === 'BROADCAST_TEXT') {
      const msgText = ctx.message.text.trim();
      delete userState[adminId];
      ctx.reply('🚀 Mengirim Broadcast...');
      db.all(`SELECT user_id FROM visitors`, (err, rows) => {
        if (rows) {
          rows.forEach(r => {
            bot.telegram.sendMessage(r.user_id, msgText, { parse_mode: 'Markdown' }).catch(() => {});
          });
        }
      });
    } else if (state.step === 'BC_BTN_TEXT') {
      userState[adminId] = { step: 'BC_BTN_LABEL', msgText: ctx.message.text.trim() };
      ctx.reply('Masukkan Label Tombol (Contoh: Kunjungi Web):');
    } else if (state.step === 'BC_BTN_LABEL') {
      userState[adminId] = { step: 'BC_BTN_URL', msgText: state.msgText, label: ctx.message.text.trim() };
      ctx.reply('Masukkan Link/URL Tombol (Contoh: https://google.com):');
    } else if (state.step === 'BC_BTN_URL') {
      const url = ctx.message.text.trim();
      const { msgText, label } = state;
      delete userState[adminId];
      ctx.reply('🚀 Mengirim Broadcast Button...');
      db.all(`SELECT user_id FROM visitors`, (err, rows) => {
        if (rows) {
          rows.forEach(r => {
            bot.telegram.sendMessage(r.user_id, msgText, Markup.inlineKeyboard([[Markup.button.url(label, url)]])).catch(() => {});
          });
        }
      });
    } else if (state.step === 'ADD_PROD_NAME') {
      userState[adminId] = { step: 'ADD_PROD_PRICE', name: ctx.message.text.trim() };
      ctx.reply('Masukkan Harga Produk (angka saja):');
    } else if (state.step === 'ADD_PROD_PRICE') {
      const price = parseInt(ctx.message.text.trim());
      if (isNaN(price)) return ctx.reply('⚠️ Masukkan angka yang valid!');
      db.run(`INSERT INTO products (name, price, photo) VALUES (?, ?, '')`, [state.name, price]);
      delete userState[adminId];
      ctx.reply('✅ Produk berhasil ditambahkan!');
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
    }
  }
});

bot.launch();
console.log('Bot Telegram Running Fully with Automatic Saweria QRIS...');
