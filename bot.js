require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const express = require('express');
const { verifyAutoKuySignature, generateDynamicQRIS } = require('./autokuy');
const bot = new Telegraf(process.env.BOT_TOKEN);

// ====== FOTO DEFAULT (HARDCODE) ======
// Kalau admin BELUM set foto lewat menu, atau database ke-reset saat redeploy,
// bot otomatis pakai link di bawah ini. Ganti sesuai punya kamu (boleh link
// gambar publik/imgur/dsb, boleh juga file_id Telegram).
const DEFAULT_QRIS_PHOTO = ''; // contoh: 'https://i.imgur.com/xxxxxxx.png'
const DEFAULT_HEADER_PHOTO = ''; // foto banner/header toko, contoh: 'https://i.imgur.com/yyyyyyy.png'
const DEFAULT_STORE_NAME = '🛍️ TOKO DIGITAL PREMIUM'; // nama toko default
const DEFAULT_STORE_DESC = 'Selamat datang di toko kami!'; // deskripsi toko default

const getAdminId = () => {
  const raw = process.env.ADMIN_ID;
  if (!raw) return 0;
  return Number(String(raw).replace(/[^0-9]/g, ''));
};

// DATABASE SETUP
const dbDir = process.env.DB_PATH || __dirname;
try {
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
    console.log(`Folder DB_PATH "${dbDir}" belum ada, berhasil dibuat.`);
  }
} catch (e) {
  console.log(`⚠️ Gagal membuat folder DB_PATH "${dbDir}":`, e.message);
}
const dbPath = path.join(dbDir, 'database.db');
console.log('Menggunakan database di:', dbPath);

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.log('❌ GAGAL BUKA DATABASE:', err.message);
  else console.log('✅ Database berhasil dibuka.');
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS store ( id INTEGER PRIMARY KEY, name TEXT, desc TEXT, photo TEXT, qris TEXT, dana TEXT, gopay TEXT, admin_uname TEXT, required_channel TEXT, log_group_id TEXT, song TEXT, welcome_msg TEXT, leave_msg TEXT )`);
  db.run(`ALTER TABLE store ADD COLUMN song TEXT`, () => {});
  db.run(`ALTER TABLE store ADD COLUMN welcome_msg TEXT`, () => {});
  db.run(`ALTER TABLE store ADD COLUMN leave_msg TEXT`, () => {});
  db.run(`ALTER TABLE store ADD COLUMN required_group TEXT`, () => {});
  db.run(`CREATE TABLE IF NOT EXISTS users ( user_id INTEGER PRIMARY KEY, upline_id INTEGER DEFAULT 0, balance INTEGER DEFAULT 0, tier TEXT DEFAULT 'Bronze' )`);
  db.run(`ALTER TABLE users ADD COLUMN balance INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN tier TEXT DEFAULT 'Bronze'`, () => {});
  db.run(`ALTER TABLE products ADD COLUMN note TEXT DEFAULT ''`, () => {});
  db.run(`CREATE TABLE IF NOT EXISTS visitors ( user_id INTEGER PRIMARY KEY, username TEXT, first_name TEXT, joined_at TEXT )`);
  db.run(`CREATE TABLE IF NOT EXISTS groups (group_id INTEGER PRIMARY KEY)`);
  db.run(`CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, price INTEGER, photo TEXT DEFAULT '', note TEXT DEFAULT '')`);
  db.run(`CREATE TABLE IF NOT EXISTS orders ( id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, username TEXT, product_id INTEGER, quantity INTEGER DEFAULT 1, status TEXT, proof TEXT, discount INTEGER DEFAULT 0, amount INTEGER DEFAULT 0, created_at TEXT, casaku_transaction_id TEXT, qris_expires_at TEXT )`);
  db.run(`ALTER TABLE orders ADD COLUMN quantity INTEGER DEFAULT 1`, () => {});
  db.run(`ALTER TABLE orders ADD COLUMN casaku_transaction_id TEXT`, () => {});
  db.run(`ALTER TABLE orders ADD COLUMN qris_expires_at TEXT`, () => {});
  db.run(`ALTER TABLE orders ADD COLUMN qris_message_id TEXT`, () => {});
  db.run(`CREATE TABLE IF NOT EXISTS stock_items (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER, content TEXT, status TEXT DEFAULT 'AVAILABLE')`);
  db.run(`CREATE TABLE IF NOT EXISTS vouchers (code TEXT PRIMARY KEY, discount INTEGER, quota INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS topups ( id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, username TEXT, amount INTEGER, unique_code INTEGER, total_amount INTEGER, status TEXT DEFAULT 'PENDING', proof TEXT, created_at TEXT, casaku_transaction_id TEXT, qris_expires_at TEXT )`);
  db.run(`ALTER TABLE topups ADD COLUMN casaku_transaction_id TEXT`, () => {});
  db.run(`ALTER TABLE topups ADD COLUMN qris_expires_at TEXT`, () => {});
  db.run(`ALTER TABLE topups ADD COLUMN qris_message_id TEXT`, () => {});
  db.run(`CREATE TABLE IF NOT EXISTS auto_reply ( keyword TEXT PRIMARY KEY, reply_type TEXT DEFAULT 'text', content TEXT, file_id TEXT, btn_label TEXT, btn_url TEXT )`);
  db.run(`CREATE TABLE IF NOT EXISTS chat_relay ( admin_msg_id INTEGER PRIMARY KEY, buyer_id INTEGER, buyer_name TEXT )`);
  db.run(`CREATE TABLE IF NOT EXISTS casaku_webhook_log ( transaction_id TEXT PRIMARY KEY, matched_type TEXT, matched_id INTEGER, amount INTEGER, received_at TEXT )`);
  db.run(`CREATE TABLE IF NOT EXISTS bot_scripts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, price INTEGER, zip_file_id TEXT, video_file_id TEXT, instruction_text TEXT, stock INTEGER DEFAULT 0)`);
  db.run(`CREATE TABLE IF NOT EXISTS script_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, username TEXT, script_id INTEGER, amount INTEGER, status TEXT DEFAULT 'PENDING', proof TEXT, casaku_transaction_id TEXT, qris_expires_at TEXT, created_at TEXT)`);
  db.run(`ALTER TABLE script_orders ADD COLUMN qris_message_id TEXT`, () => {});

  db.get(`SELECT * FROM store WHERE id = 1`, (err, row) => {
    if (!row) {
      db.run(`INSERT INTO store (id, name, desc, photo, qris, dana, gopay, admin_uname, required_channel, log_group_id, welcome_msg, leave_msg) VALUES (1, ?, ?, '', '', '', '', '', '', '', 'Selamat datang {user} di grup kami! 🎉', 'Sampai jumpa {user} 👋')`, [DEFAULT_STORE_NAME, DEFAULT_STORE_DESC]);
    }
  });
});

const userState = {};

// MIDDLEWARE WAJIB JOIN CHANNEL
const checkForceJoin = async (ctx, next) => {
  if (ctx.chat && ctx.chat.type !== 'private') return next();
  const userId = ctx.from.id;
  if (userId === getAdminId()) return next();
  return new Promise((resolve) => {
    db.get(`SELECT required_channel FROM store WHERE id = 1`, async (err, store) => {
      if (!store || !store.required_channel || store.required_channel.trim() === '') return resolve(next());
      let ch = store.required_channel.trim();
      if (!ch.startsWith('@') && !ch.startsWith('-100')) ch = `@${ch}`;
      try {
        const member = await ctx.telegram.getChatMember(ch, userId);
        if (['creator', 'administrator', 'member'].includes(member.status)) return resolve(next());
      } catch (e) {}
      const chUrl = ch.startsWith('@') ? `https://t.me/${ch.replace('@', '')}` : '#';
      await ctx.reply(`⚠️ *AKSES DITOLAK*\n\nAnda harus bergabung ke channel kami terlebih dahulu!`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.url('📢 Join Channel Sekarang', chUrl)],
          [Markup.button.callback('✅ Saya Sudah Join', 'main_menu')]
        ])
      });
      return resolve();
    });
  });
};
bot.use(checkForceJoin);

// WELCOME & LEAVE GROUP
bot.on('new_chat_members', (ctx) => {
  db.get(`SELECT welcome_msg FROM store WHERE id = 1`, (err, store) => {
    const msg = (store && store.welcome_msg) ? store.welcome_msg : 'Selamat datang {user}! 🎉';
    ctx.message.new_chat_members.forEach(member => {
      const name = member.first_name || 'Member';
      ctx.reply(msg.replace('{user}', `[${name}](tg://user?id=${member.id})`), { parse_mode: 'Markdown' });
    });
  });
});
bot.on('left_chat_member', (ctx) => {
  db.get(`SELECT leave_msg FROM store WHERE id = 1`, (err, store) => {
    const msg = (store && store.leave_msg) ? store.leave_msg : 'Sampai jumpa {user} 👋';
    const member = ctx.message.left_chat_member;
    const name = member.first_name || 'Member';
    ctx.reply(msg.replace('{user}', `[${name}](tg://user?id=${member.id})`), { parse_mode: 'Markdown' });
  });
});

bot.command('cekid', async (ctx) => {
  const chat = ctx.chat;
  await ctx.reply(`🆔 *INFO CHAT*\n\nChat ID: \`${chat.id}\`\nTipe: ${chat.type}`, { parse_mode: 'Markdown' });
});

// Melacak pesan terakhir yang dikirim bot ke tiap user, supaya bisa dihapus
// walau pesan itu bukan hasil klik tombol (misal setelah user ketik teks bebas).
const lastBotMsg = {};

const safeClearAndSend = async (ctx, text, extra = {}) => {
  const uid = ctx.from && ctx.from.id;
  // Hapus pesan yang sedang "aktif" (kalau trigger-nya klik tombol inline)
  try { await ctx.deleteMessage(); } catch (e) {}
  // Hapus juga pesan bot terakhir yang tercatat untuk user ini (kalau trigger-nya ketik teks)
  if (uid && lastBotMsg[uid]) {
    const prev = lastBotMsg[uid];
    delete lastBotMsg[uid];
    if (!(ctx.callbackQuery && ctx.callbackQuery.message && ctx.callbackQuery.message.message_id === prev.messageId)) {
      try { await ctx.telegram.deleteMessage(prev.chatId, prev.messageId); } catch (e) {}
    }
  }
  let sent;
  try {
    const mode = extra.parse_mode || 'Markdown';
    if (extra.photo) {
      sent = await ctx.replyWithPhoto(extra.photo, { ...extra, caption: text, parse_mode: mode });
    } else {
      sent = await ctx.reply(text, { ...extra, parse_mode: mode });
    }
  } catch (e) {
    // Kalau teksnya ada karakter markdown liar (contoh: underscore di nama produk/username),
    // Telegram menolak parse_mode Markdown. Kirim ulang tanpa parse_mode biar tetap terkirim.
    const plainExtra = { ...extra, parse_mode: undefined };
    if (extra.photo) {
      sent = await ctx.replyWithPhoto(extra.photo, { caption: text, ...plainExtra });
    } else {
      sent = await ctx.reply(text, plainExtra);
    }
  }
  if (uid && sent && sent.message_id) lastBotMsg[uid] = { chatId: sent.chat.id, messageId: sent.message_id };
  return sent;
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

const getUserInfoLine = (ctx, cb) => {
  const userId = ctx.from.id;
  const username = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'Buyer');
  db.get(`SELECT balance, tier FROM users WHERE user_id = ?`, [userId], (err, row) => {
    const tier = row ? (row.tier || 'Bronze') : 'Bronze';
    let balanceDisplay = 'Rp0';
    if (tier === 'Owner' || userId === getAdminId()) balanceDisplay = '∞ (Unlimited)';
    else if (row) balanceDisplay = `Rp${(row.balance || 0).toLocaleString('id-ID')}`;
    const card = `✨ *INFORMASI BUYER*\n👤 *Username:* ${username}\n🆔 *ID Telegram:* \`${userId}\`\n💳 *Saldo:* ${balanceDisplay}\n🏷️ *Tier Status:* *${tier}*`;
    cb(card);
  });
};

// Telegram tidak punya fitur teks "berjalan/muter-muter". Alternatif resminya
// adalah blockquote yang bisa dibuka-tutup ("Baca selengkapnya..."), pakai
// parse_mode HTML. Dipakai untuk teks yang cukup panjang (instruksi, catatan).
const escapeHtml = (str) => String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const LONG_TEXT_THRESHOLD = 200;
const formatMaybeLongHtml = (title, body) => {
  const safeBody = escapeHtml(body);
  if (String(body).length > LONG_TEXT_THRESHOLD) {
    return `${title}\n<blockquote expandable>${safeBody}</blockquote>`;
  }
  return `${title}\n${safeBody}`;
};

// === HELPER DELIVERY SCRIPT ===
// PENTING: pesan instruksi/video/dokumen di sini SENGAJA tidak lewat safeClearAndSend,
// karena semuanya harus tetap ada bareng-bareng (bukan layar navigasi yang saling ganti).
const deliverScript = async (ctx, script) => {
  try {
    if (script.instruction_text) {
      await ctx.reply(formatMaybeLongHtml('📝 <b>INSTRUKSI PEMBELIAN SCRIPT</b>', script.instruction_text), { parse_mode: 'HTML' });
    }
    if (script.video_file_id) await ctx.replyWithVideo(script.video_file_id, { caption: '🎥 Video Tutorial Script Bot' });
    if (script.zip_file_id) await ctx.replyWithDocument(script.zip_file_id, { caption: '📂 File Source Code (ZIP)' });
    await safeClearAndSend(ctx, '✅ Terima kasih! Script telah dikirim.', Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu Utama', 'main_menu')]]));
  } catch (e) {
    safeClearAndSend(ctx, '⚠️ Gagal mengirim beberapa file script. Hubungi admin.');
  }
};

const deliverScriptById = async (userId, script) => {
  try {
    if (script.instruction_text) {
      await bot.telegram.sendMessage(userId, formatMaybeLongHtml('📝 <b>INSTRUKSI PEMBELIAN SCRIPT</b>', script.instruction_text), { parse_mode: 'HTML' });
    }
    if (script.video_file_id) await bot.telegram.sendVideo(userId, script.video_file_id, { caption: '🎥 Video Tutorial Script Bot' });
    if (script.zip_file_id) await bot.telegram.sendDocument(userId, script.zip_file_id, { caption: '📂 File Source Code (ZIP)' });
  } catch (e) { console.error('Gagal deliver script:', e.message); }
};

// MENU UTAMA (VPN DIHAPUS)
const getMainMenu = (userId) => {
  const adminId = getAdminId();
  const buttons = [
    [Markup.button.callback('🛒 Katalog Produk', 'user_catalog'), Markup.button.callback('🔍 Cari Produk', 'user_search_prod')],
    [Markup.button.callback('💳 Saldo & Top Up', 'user_balance_menu'), Markup.button.callback('📦 Cek Pesanan', 'user_my_orders')],
    [Markup.button.callback('📊 Cek Stok Live', 'user_live_stock'), Markup.button.callback('🔗 Program Referral', 'user_referral')],
    [Markup.button.callback('📞 Customer Service', 'user_contact'), Markup.button.callback('🆔 Cek ID', 'user_check_id')],
    [Markup.button.callback('🤖 Beli Script Bot', 'user_script_menu'), Markup.button.callback('📖 Cara Belanja', 'user_faq')]
  ];
  if (Number(userId) === adminId && adminId !== 0) {
    buttons.push([Markup.button.callback('⚙️ Dashboard Admin', 'admin_dashboard')]);
  }
  return Markup.inlineKeyboard(buttons);
};

const getAdminMenu = () => {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📊 Statistik', 'admin_stats'), Markup.button.callback('💾 Backup DB', 'admin_backup')],
    [Markup.button.callback('📄 Backup bot.js', 'admin_backup_code')],
    [Markup.button.callback('➕ Tambah Produk', 'admin_add_prod'), Markup.button.callback('🗑️ Hapus Produk', 'admin_del_prod')],
    [Markup.button.callback('📦 Tambah Stok (Massal)', 'admin_add_stock'), Markup.button.callback('✏️ Edit Info Toko', 'admin_edit_store')],
    [Markup.button.callback('🖼️ Ganti Foto Header', 'admin_set_header_photo'), Markup.button.callback('🧾 Set Foto QRIS', 'admin_set_qris_photo')],
    [Markup.button.callback('🅳 Set Nomor DANA', 'admin_set_dana'), Markup.button.callback('🅶 Set Nomor GoPay', 'admin_set_gopay')],
    [Markup.button.callback('👋 Set Welcome Msg', 'admin_set_welcome'), Markup.button.callback('👋 Set Leave Msg', 'admin_set_leave')],
    [Markup.button.callback('🎵 Set Lagu', 'admin_set_song'), Markup.button.callback('🤖 Atur Auto-Reply', 'admin_autoreply_type')],
    [Markup.button.callback('🗑️ Hapus Auto-Reply', 'admin_del_autoreply'), Markup.button.callback('👤 Set Admin Uname', 'admin_set_uname')],
    [Markup.button.callback('🔒 Wajib Join Channel', 'admin_set_channel'), Markup.button.callback('👥 Wajib Join Grup', 'admin_set_req_group')],
    [Markup.button.callback('📢 Grup Log/Testi', 'admin_set_log_group')],
    [Markup.button.callback('🎁 Buat Voucher', 'admin_add_voucher'), Markup.button.callback('🗑️ Hapus Voucher', 'admin_del_voucher')],
    [Markup.button.callback('👤 Kelola Saldo/Tier User', 'admin_manage_user')],
    [Markup.button.callback('📢 Broadcast Chat', 'admin_broadcast_menu'), Markup.button.callback('🔗 Broadcast + Button', 'admin_bc_button')],
    [Markup.button.callback('📦 Jual Script Bot', 'admin_script_menu')],
    [Markup.button.callback('🔙 Menu Utama', 'main_menu')]
  ]);
};

const buildJoinUrl = (raw) => {
  if (!raw || !String(raw).trim()) return null;
  let v = String(raw).trim();
  if (v.startsWith('http://') || v.startsWith('https://')) return v;
  if (v.startsWith('@')) v = v.slice(1);
  if (v.startsWith('-100')) return null;
  return `https://t.me/${v}`;
};

const getStartMenu = (store) => {
  const rows = [];
  const chUrl = buildJoinUrl(store && store.required_channel);
  const grUrl = buildJoinUrl(store && store.required_group);
  if (chUrl) rows.push(Markup.button.url('📢 Channel', chUrl));
  if (grUrl) rows.push(Markup.button.url('👥 Grup', grUrl));
  const buttons = [];
  if (rows.length) buttons.push(rows);
  buttons.push([Markup.button.callback('🏠 Main Menu', 'main_menu')]);
  return Markup.inlineKeyboard(buttons);
};

// Kirim lagu (file audio) yang sudah di-set admin, kalau ada. Dikirim sebagai
// pesan audio TERPISAH (bukan lewat safeClearAndSend) supaya tidak ikut terhapus
// saat user pindah menu.
const sendStoreSong = async (ctx, store) => {
  if (store && store.song && String(store.song).trim() !== '') {
    try { await ctx.replyWithAudio(store.song); } catch (e) { console.log('Gagal kirim lagu:', e.message); }
  }
};

// === START COMMAND (AUTO KIRIM LAGU) ===
bot.start(async (ctx) => {
  saveUserAndVisitor(ctx);
  db.get(`SELECT * FROM store WHERE id = 1`, async (err, store) => {
    getUserInfoLine(ctx, async (infoLine) => {
      const storeName = (DEFAULT_STORE_NAME && DEFAULT_STORE_NAME.trim() !== '') ? DEFAULT_STORE_NAME : (store && store.name ? store.name : '');
      const storeDesc = (DEFAULT_STORE_DESC && DEFAULT_STORE_DESC.trim() !== '') ? DEFAULT_STORE_DESC : (store && store.desc ? store.desc : '');
      const text = `🏬 *${storeName}*\n\n${storeDesc}\n\n━━━━━━━━━━━━━━━━━━━\n${infoLine}\n━━━━━━━━━━━━━━━━━━━`;
      const headerPhoto = (DEFAULT_HEADER_PHOTO && DEFAULT_HEADER_PHOTO.trim() !== '') ? DEFAULT_HEADER_PHOTO : (store && store.photo ? store.photo : '');
      if (headerPhoto) {
        const sent = await ctx.replyWithPhoto(headerPhoto, { caption: text, parse_mode: 'Markdown', ...getStartMenu(store) });
        if (sent) lastBotMsg[ctx.from.id] = { chatId: sent.chat.id, messageId: sent.message_id };
      } else {
        await safeClearAndSend(ctx, text, getStartMenu(store));
      }
      await sendStoreSong(ctx, store);
    });
  });
});

bot.action('main_menu', async (ctx) => {
  db.get(`SELECT * FROM store WHERE id = 1`, async (err, store) => {
    getUserInfoLine(ctx, async (infoLine) => {
      const storeName = (DEFAULT_STORE_NAME && DEFAULT_STORE_NAME.trim() !== '') ? DEFAULT_STORE_NAME : (store && store.name ? store.name : '');
      const storeDesc = (DEFAULT_STORE_DESC && DEFAULT_STORE_DESC.trim() !== '') ? DEFAULT_STORE_DESC : (store && store.desc ? store.desc : '');
      const text = `🏬 *${storeName}*\n\n${storeDesc}\n\n━━━━━━━━━━━━━━━━━━━\n${infoLine}\n━━━━━━━━━━━━━━━━━━━`;
      const headerPhoto = (DEFAULT_HEADER_PHOTO && DEFAULT_HEADER_PHOTO.trim() !== '') ? DEFAULT_HEADER_PHOTO : (store && store.photo ? store.photo : '');
      if (headerPhoto) await safeClearAndSend(ctx, text, { photo: headerPhoto, ...getMainMenu(ctx.from.id) });
      else await safeClearAndSend(ctx, text, getMainMenu(ctx.from.id));
    });
  });
});

// === CUSTOMER SERVICE (LIVE CHAT) ===
bot.action('user_contact', async (ctx) => {
  ctx.answerCbQuery();
  userState[ctx.from.id] = { step: 'CS_CHAT' };
  await safeClearAndSend(ctx, `📞 *CUSTOMER SERVICE*\n\nSilakan ketik pesan atau keluhan Anda di chat ini.\nAdmin akan membalas pesan Anda secara langsung melalui bot ini.`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali', 'main_menu')]]));
});

// === HANDLER SCRIPT BOT (USER) ===
bot.action('user_script_menu', async (ctx) => {
  ctx.answerCbQuery();
  db.get(`SELECT * FROM bot_scripts WHERE id = 1`, (err, script) => {
    if (!script || !script.name) {
      return safeClearAndSend(ctx, `⚠️ Script Bot belum tersedia saat ini.`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu Utama', 'main_menu')]]));
    }
    let text = `🤖 *SCRIPT BOT PREMIUM*\n\n`;
    text += `📝 *Nama:* ${script.name}\n💰 *Harga:* Rp${script.price.toLocaleString('id-ID')}\n📊 *Stok Tersedia:* ${script.stock}\n\n`;
    text += `📦 *Yang akan Anda dapatkan:*\n• File Source Code (ZIP)\n• Video Tutorial Lengkap\n• Teks Instruksi Instalasi\n\n`;
    if (script.stock <= 0) {
      text += `⚠️ Stok sedang habis!`;
      return safeClearAndSend(ctx, text, Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu Utama', 'main_menu')]]));
    }
    const buttons = [
      [Markup.button.callback('💳 Bayar via QRIS (Otomatis)', `script_pay_qris_1`)],
      [Markup.button.callback('🧾 Bayar QRIS Manual', `script_pay_manual_1`)],
      [Markup.button.callback('🅳 Bayar via DANA', `script_pay_dana_1`)],
      [Markup.button.callback('🅶 Bayar via GoPay', `script_pay_gopay_1`)],
      [Markup.button.callback('💰 Bayar Pakai Saldo', `script_pay_saldo_1`)],
      [Markup.button.callback('🔙 Menu Utama', 'main_menu')]
    ];
    safeClearAndSend(ctx, text, Markup.inlineKeyboard(buttons));
  });
});

// Bayar Script via QRIS Manual (foto QRIS statis) / DANA / GoPay (nomor teks)
const scriptPayManualBase = async (ctx, scriptId, methodType) => {
  db.get(`SELECT * FROM bot_scripts WHERE id = ?`, [scriptId], async (err, script) => {
    if (!script) return ctx.answerCbQuery('Script tidak ditemukan.', { show_alert: true });
    if (script.stock <= 0) return ctx.answerCbQuery('Stok habis!', { show_alert: true });
    db.get(`SELECT qris, dana, gopay FROM store WHERE id = 1`, async (err, store) => {
      const username = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'Buyer');
      const now = new Date().toISOString();
      const insertOrder = (cb) => {
        db.run(`INSERT INTO script_orders (user_id, username, script_id, amount, status, created_at) VALUES (?, ?, ?, ?, 'PENDING', ?)`,
          [ctx.from.id, username, scriptId, script.price, now], function (dbErr) { cb(dbErr, this.lastID); });
      };
      if (methodType === 'qris') {
        const qrisPhoto = (DEFAULT_QRIS_PHOTO && DEFAULT_QRIS_PHOTO.trim() !== '') ? DEFAULT_QRIS_PHOTO : (store && store.qris ? store.qris : '');
        if (!qrisPhoto) return ctx.answerCbQuery('⚠️ Foto QRIS manual belum diatur admin.', { show_alert: true });
        insertOrder((dbErr, orderId) => {
          if (dbErr) return safeClearAndSend(ctx, '⚠️ Gagal membuat pesanan.');
          userState[ctx.from.id] = { step: 'UPLOAD_SCRIPT_PROOF', scriptOrderId: orderId };
          const detailText = `🧾 *PESANAN SCRIPT #${orderId}* (QRIS Manual)\n\n📦 *Script:* ${script.name}\n💳 *Total Bayar:* *Rp${script.price.toLocaleString('id-ID')}*\n\n📲 Scan QRIS di atas, lalu kirim *foto bukti transfer* ke chat ini.`;
          safeClearAndSend(ctx, detailText, { photo: qrisPhoto, ...Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', 'user_script_menu')]]) });
        });
      } else {
        const methodKey = methodType === 'dana' ? 'dana' : 'gopay';
        const methodLabel = methodType === 'dana' ? 'DANA' : 'GoPay';
        const number = store && store[methodKey] ? store[methodKey].trim() : '';
        if (!number) return ctx.answerCbQuery(`⚠️ Nomor ${methodLabel} belum diatur admin.`, { show_alert: true });
        insertOrder((dbErr, orderId) => {
          if (dbErr) return safeClearAndSend(ctx, '⚠️ Gagal membuat pesanan.');
          userState[ctx.from.id] = { step: 'UPLOAD_SCRIPT_PROOF', scriptOrderId: orderId };
          const detailText = `🧾 *PESANAN SCRIPT #${orderId}* (${methodLabel})\n\n📦 *Script:* ${script.name}\n💳 *Total Bayar:* *Rp${script.price.toLocaleString('id-ID')}*\n\n📲 Transfer ke *${methodLabel}*:\n\`${number}\`\n\nSetelah transfer, kirim *foto bukti* ke chat ini.`;
          safeClearAndSend(ctx, detailText, Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', 'user_script_menu')]]));
        });
      }
    });
  });
};
bot.action(/^script_pay_manual_(.+)$/, async (ctx) => { await scriptPayManualBase(ctx, ctx.match[1], 'qris'); });
bot.action(/^script_pay_dana_(.+)$/, async (ctx) => { await scriptPayManualBase(ctx, ctx.match[1], 'dana'); });
bot.action(/^script_pay_gopay_(.+)$/, async (ctx) => { await scriptPayManualBase(ctx, ctx.match[1], 'gopay'); });

bot.action(/^script_pay_saldo_(.+)$/, async (ctx) => {
  const scriptId = ctx.match[1];
  const userId = ctx.from.id;
  db.get(`SELECT * FROM bot_scripts WHERE id = ?`, [scriptId], (err, script) => {
    if (!script) return ctx.answerCbQuery('Script tidak ditemukan.', { show_alert: true });
    if (script.stock <= 0) return ctx.answerCbQuery('Stok habis!', { show_alert: true });
    db.get(`SELECT balance, tier FROM users WHERE user_id = ?`, [userId], (err, row) => {
      const tier = row ? row.tier : 'Bronze';
      const balance = row ? row.balance : 0;
      if (tier !== 'Owner' && userId !== getAdminId() && balance < script.price) {
        return ctx.answerCbQuery(`⚠️ Saldo tidak cukup!`, { show_alert: true });
      }
      if (tier !== 'Owner' && userId !== getAdminId()) {
        db.run(`UPDATE users SET balance = balance - ? WHERE user_id = ?`, [script.price, userId]);
      }
      db.run(`UPDATE bot_scripts SET stock = stock - 1 WHERE id = ?`, [scriptId]);
      const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
      const username = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'Buyer');
      db.run(`INSERT INTO script_orders (user_id, username, script_id, amount, status, created_at) VALUES (?, ?, ?, ?, 'APPROVED', ?)`,
        [userId, username, scriptId, script.price, now]);
      deliverScript(ctx, script);
      const adminId = getAdminId();
      if (adminId) bot.telegram.sendMessage(adminId, `🎉 *PEMBELIAN SCRIPT SUKSES (SALDO)*\n\n👤 Buyer: ${username} (ID: ${userId})\n📦 Script: ${script.name}\n💰 Total: Rp${script.price.toLocaleString('id-ID')}`, { parse_mode: 'Markdown' }).catch(() => {});
    });
  });
});

bot.action(/^script_pay_qris_(.+)$/, async (ctx) => {
  const scriptId = ctx.match[1];
  const userId = ctx.from.id;
  db.get(`SELECT * FROM bot_scripts WHERE id = ?`, [scriptId], async (err, script) => {
    if (!script) return ctx.answerCbQuery('Script tidak ditemukan.', { show_alert: true });
    if (script.stock <= 0) return ctx.answerCbQuery('Stok habis!', { show_alert: true });
    try {
      const buyerName = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'Buyer');
      const qris = await generateDynamicQRIS(script.price, `SCR`, { name: buyerName, phone: String(ctx.from.id) });
      const now = new Date().toISOString();
      const username = buyerName;
      db.run(`INSERT INTO script_orders (user_id, username, script_id, amount, status, created_at, casaku_transaction_id, qris_expires_at) VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
        [userId, username, scriptId, script.price, now, qris.transactionId, qris.expiresAt], function (dbErr) {
          if (dbErr) return safeClearAndSend(ctx, '⚠️ Gagal membuat pesanan.');
          const orderId = this.lastID;
          userState[userId] = { step: 'UPLOAD_SCRIPT_PROOF', scriptOrderId: orderId };
          const detailText = `🧾 *PESANAN SCRIPT #${orderId}*\n\n📦 *Script:* ${script.name}\n💰 *Total Bayar:* *Rp${qris.totalAmount.toLocaleString('id-ID')}*\n🧾 *Transaksi:* \`${qris.transactionId}\`\n⏳ *Berlaku sampai:* ${new Date(qris.expiresAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\n\n📲 Scan QRIS di atas, lalu kirim *foto bukti transfer* ke chat ini.`;
          safeClearAndSend(ctx, detailText, {
            photo: { source: qris.imageBuffer },
            ...Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', 'user_script_menu')]])
          }).then((sent) => {
            if (sent && sent.message_id) db.run(`UPDATE script_orders SET qris_message_id = ? WHERE id = ?`, [sent.message_id, orderId]);
          });
        });
    } catch (e) {
      return ctx.answerCbQuery(`⚠️ Gagal membuat QRIS: ${e.message}`, { show_alert: true });
    }
  });
});

// === HANDLER SCRIPT BOT (ADMIN) ===
bot.action('admin_script_menu', async (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  db.get(`SELECT * FROM bot_scripts WHERE id = 1`, (err, script) => {
    let text = `📦 *MANAJEMEN JUAL SCRIPT BOT*\n\n`;
    if (!script || !script.name) text += `Script belum di-setting.`;
    else text += `📝 *Nama:* ${script.name}\n💰 *Harga:* Rp${script.price.toLocaleString('id-ID')}\n📊 *Stok:* ${script.stock}\n📂 *ZIP:* ${script.zip_file_id ? '✅ Ada' : '❌ Belum'}\n🎥 *Video:* ${script.video_file_id ? '✅ Ada' : '❌ Belum'}\n📄 *Instruksi:* ${script.instruction_text ? '✅ Ada' : '❌ Belum'}`;
    const buttons = [
      [Markup.button.callback('⚙️ Set Nama & Harga', 'admin_script_set_info')],
      [Markup.button.callback('📂 Upload File ZIP', 'admin_script_upload_zip')],
      [Markup.button.callback('🎥 Upload Video Tutorial', 'admin_script_upload_video')],
      [Markup.button.callback('📝 Set Teks Instruksi', 'admin_script_set_text')],
      [Markup.button.callback('➕ Tambah Stok', 'admin_script_add_stock')],
      [Markup.button.callback('🗑️ Hapus Script', 'admin_script_delete')],
      [Markup.button.callback('🔙 Dashboard Admin', 'admin_dashboard')]
    ];
    safeClearAndSend(ctx, text, Markup.inlineKeyboard(buttons));
  });
});
bot.action('admin_script_set_info', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'SCRIPT_SET_INFO' };
  safeClearAndSend(ctx, 'Masukkan Nama dan Harga Script (Format: `Nama|Harga`)\nContoh: `Bot Toko Premium|50000`', { parse_mode: 'Markdown' });
});
bot.action('admin_script_upload_zip', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'SCRIPT_UPLOAD_ZIP' };
  safeClearAndSend(ctx, 'Kirimkan File ZIP Script Bot:');
});
bot.action('admin_script_upload_video', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'SCRIPT_UPLOAD_VIDEO' };
  safeClearAndSend(ctx, 'Kirimkan Video Tutorial Script Bot:');
});
bot.action('admin_script_set_text', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'SCRIPT_SET_TEXT' };
  safeClearAndSend(ctx, 'Kirimkan Teks Instruksi:');
});
bot.action('admin_script_add_stock', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'SCRIPT_ADD_STOCK' };
  safeClearAndSend(ctx, 'Masukkan jumlah stok:');
});
bot.action('admin_script_delete', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  db.run(`DELETE FROM bot_scripts WHERE id = 1`);
  ctx.answerCbQuery('✅ Script dihapus!', { show_alert: true });
});

bot.on('document', async (ctx) => {
  const adminId = getAdminId();
  const userId = ctx.from.id;
  if (Number(userId) === adminId && userState[adminId]) {
    if (userState[adminId].step === 'SCRIPT_UPLOAD_ZIP') {
      const fileId = ctx.message.document.file_id;
      db.get(`SELECT id FROM bot_scripts WHERE id = 1`, (err, row) => {
        if (!row) db.run(`INSERT INTO bot_scripts (id, name, price, stock) VALUES (1, 'Script Bot', 0, 0)`, () => {
          db.run(`UPDATE bot_scripts SET zip_file_id = ? WHERE id = 1`, [fileId]);
        });
        else db.run(`UPDATE bot_scripts SET zip_file_id = ? WHERE id = 1`, [fileId]);
        delete userState[adminId];
        safeClearAndSend(ctx, '✅ File ZIP diupload!');
      });
      return;
    }
  }
});

bot.on('video', async (ctx) => {
  const adminId = getAdminId();
  const userId = ctx.from.id;
  if (Number(userId) === adminId && userState[adminId]) {
    if (userState[adminId].step === 'SCRIPT_UPLOAD_VIDEO') {
      const fileId = ctx.message.video.file_id;
      db.get(`SELECT id FROM bot_scripts WHERE id = 1`, (err, row) => {
        if (!row) db.run(`INSERT INTO bot_scripts (id, name, price, stock) VALUES (1, 'Script Bot', 0, 0)`, () => {
          db.run(`UPDATE bot_scripts SET video_file_id = ? WHERE id = 1`, [fileId]);
        });
        else db.run(`UPDATE bot_scripts SET video_file_id = ? WHERE id = 1`, [fileId]);
        delete userState[adminId];
        safeClearAndSend(ctx, '✅ Video diupload!');
      });
      return;
    }
  }
});

// === HANDLER USER LAINNYA ===
bot.action('user_check_id', async (ctx) => {
  ctx.answerCbQuery();
  safeClearAndSend(ctx, `👤 *ID Telegram Anda:* \`${ctx.from.id}\``);
});
bot.action('user_faq', async (ctx) => {
  ctx.answerCbQuery();
  const faqText = `📖 *CARA BELANJA*\n\n1️⃣ Pilih *Katalog Produk*\n2️⃣ Pilih produk & jumlah\n3️⃣ Pilih metode bayar (*QRIS* atau *Saldo*)\n4️⃣ Jika via QRIS, scan & transfer sesuai Nominal Pas\n5️⃣ Produk dikirim otomatis!`;
  await safeClearAndSend(ctx, faqText, Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali', 'main_menu')]]));
});
bot.action('user_live_stock', async (ctx) => {
  ctx.answerCbQuery();
  const query = `SELECT p.name, p.price, COUNT(s.id) AS stock_count FROM products p LEFT JOIN stock_items s ON p.id = s.product_id AND s.status = 'AVAILABLE' GROUP BY p.id`;
  db.all(query, async (err, rows) => {
    if (!rows || rows.length === 0) return await safeClearAndSend(ctx, `📊 *STATUS STOK*\n\nBelum ada produk.`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali', 'main_menu')]]));
    let text = `📊 *STATUS STOK REAL-TIME*\n\n`;
    rows.forEach(r => {
      const statusEmoji = r.stock_count > 0 ? '🟢 Tersedia' : '🔴 Habis';
      text += `• *${r.name}* - Rp${r.price.toLocaleString('id-ID')}\n Status: ${statusEmoji} (*${r.stock_count} item*)\n\n`;
    });
    await safeClearAndSend(ctx, text, Markup.inlineKeyboard([[Markup.button.callback('🛒 Beli Sekarang', 'user_catalog'), Markup.button.callback('🔙 Menu Utama', 'main_menu')]]));
  });
});

const sendReferral = async (ctx) => {
  const userId = ctx.from.id;
  db.get(`SELECT COUNT(user_id) as total_downline FROM users WHERE upline_id = ?`, [userId], async (err, row) => {
    const botInfo = await ctx.telegram.getMe();
    const refLink = `https://t.me/${botInfo.username}?start=${userId}`;
    const text = `🔗 *PROGRAM REFERRAL*\n\nBagikan link:\n\`${refLink}\`\n\n👥 Total diundang: ${row ? row.total_downline : 0} orang`;
    await safeClearAndSend(ctx, text, Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali', 'main_menu')]]));
  });
};
bot.action('user_referral', async (ctx) => { ctx.answerCbQuery(); await sendReferral(ctx); });
bot.command('referral', sendReferral);

bot.action('user_search_prod', async (ctx) => {
  ctx.answerCbQuery();
  userState[ctx.from.id] = { step: 'SEARCH_PRODUCT' };
  await safeClearAndSend(ctx, `🔍 *PENCARIAN PRODUK*\n\nKetik kata kunci:`, Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', 'user_catalog')]]));
});

const sendMyOrders = async (ctx) => {
  const userId = ctx.from.id;
  db.all(`SELECT o.*, p.name as prod_name FROM orders o JOIN products p ON o.product_id = p.id WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 5`, [userId], async (err, rows) => {
    if (!rows || rows.length === 0) return await safeClearAndSend(ctx, `📦 *RIWAYAT PESANAN*\n\nBelum pernah transaksi.`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali', 'main_menu')]]));
    let text = `📦 *5 TRANSAKSI TERAKHIR:*\n\n`;
    rows.forEach(r => { text += `• *Order #${r.id}* - ${r.prod_name} (${r.quantity || 1}x)\n Status: *${r.status}* (${r.created_at})\n\n`; });
    await safeClearAndSend(ctx, text, Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali', 'main_menu')]]));
  });
};
bot.action('user_my_orders', async (ctx) => { ctx.answerCbQuery(); await sendMyOrders(ctx); });
bot.command('pesanan', sendMyOrders);

bot.action('user_balance_menu', async (ctx) => {
  ctx.answerCbQuery();
  const userId = ctx.from.id;
  db.get(`SELECT balance, tier FROM users WHERE user_id = ?`, [userId], async (err, row) => {
    const tier = row ? (row.tier || 'Bronze') : 'Bronze';
    const balance = (tier === 'Owner' || userId === getAdminId()) ? '∞ (Unlimited)' : `Rp${(row ? row.balance || 0 : 0).toLocaleString('id-ID')}`;
    const text = `💳 *MANAJEMEN SALDO*\n\n💰 *Saldo:* ${balance}\n🏷️ *Tier:* ${tier}\n\nPilih nominal Top Up:`;
    await safeClearAndSend(ctx, text, Markup.inlineKeyboard([
      [Markup.button.callback('➕ Rp500', 'topup_amt_500'), Markup.button.callback('➕ Rp1.000', 'topup_amt_1000')],
      [Markup.button.callback('➕ Rp5.000', 'topup_amt_5000'), Markup.button.callback('➕ Rp10.000', 'topup_amt_10000')],
      [Markup.button.callback('✍️ Nominal Custom', 'user_topup_custom')],
      [Markup.button.callback('🔙 Kembali', 'main_menu')]
    ]));
  });
});
bot.action(/^topup_amt_(.+)$/, async (ctx) => { processTopUp(ctx, parseInt(ctx.match[1])); });
bot.action('user_topup_custom', async (ctx) => {
  ctx.answerCbQuery();
  userState[ctx.from.id] = { step: 'TOPUP_AMOUNT' };
  await safeClearAndSend(ctx, `💰 *TOP UP CUSTOM*\n\nMasukkan nominal (500-10000000):`, Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', 'user_balance_menu')]]));
});

const processTopUp = async (ctx, amount) => {
  if (!Number.isInteger(amount) || amount < 500 || amount > 10000000) return ctx.answerCbQuery('⚠️ Nominal harus Rp500–Rp10.000.000.', { show_alert: true });
  try {
    const username = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'User');
    const qris = await generateDynamicQRIS(amount, `TOPUP`, { name: username, phone: String(ctx.from.id) });
    const now = new Date().toISOString();
    db.run(`INSERT INTO topups (user_id, username, amount, unique_code, total_amount, status, created_at, casaku_transaction_id, qris_expires_at) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
      [ctx.from.id, username, amount, qris.uniqueCode, qris.totalAmount, now, qris.transactionId, qris.expiresAt], function (err) {
        if (err) return safeClearAndSend(ctx, '⚠️ Gagal membuat invoice.');
        const topupId = this.lastID;
        userState[ctx.from.id] = { step: 'UPLOAD_TOPUP_PROOF', topupId };
        const detailText = `💰 *INVOICE TOP UP #${topupId}*\n\n💵 *Nominal:* Rp${amount.toLocaleString('id-ID')}\n💳 *Total Bayar:* *Rp${qris.totalAmount.toLocaleString('id-ID')}*\n🧾 *Transaksi:* \`${qris.transactionId}\`\n⏳ *Berlaku sampai:* ${new Date(qris.expiresAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\n\n📲 Scan QRIS di atas.`;
        safeClearAndSend(ctx, detailText, {
          photo: { source: qris.imageBuffer },
          ...Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', 'user_balance_menu')]])
        }).then((sent) => {
          if (sent && sent.message_id) db.run(`UPDATE topups SET qris_message_id = ? WHERE id = ?`, [sent.message_id, topupId]);
        });
      });
  } catch (e) {
    return ctx.answerCbQuery(`⚠️ Gagal membuat QRIS: ${e.message}`, { show_alert: true });
  }
};

const sendCatalog = async (ctx) => {
  const query = `SELECT p.*, COUNT(s.id) AS stock_count FROM products p LEFT JOIN stock_items s ON p.id = s.product_id AND s.status = 'AVAILABLE' GROUP BY p.id`;
  db.all(query, async (err, products) => {
    if (!products || products.length === 0) return await safeClearAndSend(ctx, '⚠️ Katalog kosong.', Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali', 'main_menu')]]));
    let text = `🛒 *KATALOG PRODUK*\n\nPilih produk:`;
    let buttons = products.map(prod => [Markup.button.callback(`${prod.name} (Rp${prod.price.toLocaleString('id-ID')}) [${prod.stock_count}]`, `buy_${prod.id}`)]);
    buttons.push([Markup.button.callback('🔙 Menu Utama', 'main_menu')]);
    await safeClearAndSend(ctx, text, Markup.inlineKeyboard(buttons));
  });
};
bot.action('user_catalog', sendCatalog);
bot.command('katalog', sendCatalog);

const renderQtySelector = async (ctx, prodId, qty, editInPlace) => {
  db.get(`SELECT * FROM products WHERE id = ?`, [prodId], (err, prod) => {
    if (!prod) return;
    db.get(`SELECT COUNT(id) AS stock_count FROM stock_items WHERE product_id = ? AND status = 'AVAILABLE'`, [prodId], async (err, res) => {
      const available = res ? res.stock_count : 0;
      if (available <= 0) return ctx.answerCbQuery ? ctx.answerCbQuery(`⚠️ Stok ${prod.name} habis!`, { show_alert: true }) : null;
      qty = Math.max(1, Math.min(qty, available));
      const totalPrice = prod.price * qty;
      const captionText = `📦 *DETAIL: ${prod.name}*\n💰 *Harga Satuan:* Rp${prod.price.toLocaleString('id-ID')}\n📊 *Stok:* ${available}\n\n🔢 *Jumlah:* ${qty}\n💵 *Total:* Rp${totalPrice.toLocaleString('id-ID')}`;
      const buttons = Markup.inlineKeyboard([
        [Markup.button.callback('➖', `qtyadj_${prodId}_${qty}_dec`), Markup.button.callback(`${qty}`, `qtyadj_${prodId}_${qty}_noop`), Markup.button.callback('➕', `qtyadj_${prodId}_${qty}_inc`)],
        [Markup.button.callback('✍️ Ketik Jumlah', `qtytype_${prodId}`)],
        [Markup.button.callback('✅ Lanjut ke Pembayaran', `qtyconfirm_${prodId}_${qty}`)],
        [Markup.button.callback('🔙 Katalog', 'user_catalog')]
      ]);
      if (editInPlace) {
        try {
          if (prod.photo && prod.photo !== '') await ctx.editMessageCaption(captionText, { parse_mode: 'Markdown', ...buttons });
          else await ctx.editMessageText(captionText, { parse_mode: 'Markdown', ...buttons });
        } catch (e) { /* pesan sama persis, abaikan */ }
      } else {
        if (prod.photo && prod.photo !== '') await safeClearAndSend(ctx, captionText, { photo: prod.photo, ...buttons });
        else await safeClearAndSend(ctx, captionText, buttons);
      }
    });
  });
};

bot.action(/^buy_(.+)$/, async (ctx) => {
  const prodId = ctx.match[1];
  await renderQtySelector(ctx, prodId, 1, false);
});

bot.action(/^qtyadj_(.+)_(.+)_(inc|dec|noop)$/, async (ctx) => {
  const prodId = ctx.match[1];
  let qty = parseInt(ctx.match[2]);
  const action = ctx.match[3];
  ctx.answerCbQuery();
  if (action === 'inc') qty += 1;
  if (action === 'dec') qty -= 1;
  if (qty < 1) qty = 1;
  await renderQtySelector(ctx, prodId, qty, true);
});

bot.action(/^qtytype_(.+)$/, async (ctx) => {
  const prodId = ctx.match[1];
  userState[ctx.from.id] = { step: 'QTY_CUSTOM_INPUT', prodId };
  ctx.answerCbQuery();
  await safeClearAndSend(ctx, `✍️ *KETIK JUMLAH*\n\nMasukkan jumlah yang mau dibeli (angka):`, Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', `buy_${prodId}`)]]));
});

const showPaymentOptions = (ctx, prodId, qty) => {
  db.get(`SELECT * FROM products WHERE id = ?`, [prodId], (err, prod) => {
    if (!prod) return;
    const totalPrice = prod.price * qty;
    const buttons = Markup.inlineKeyboard([
      [Markup.button.callback('🎟️ Pakai Voucher', `vouc_${prodId}_${qty}`)],
      [Markup.button.callback('💳 Bayar via QRIS (Otomatis)', `pay_${prodId}_${qty}_0`)],
      [Markup.button.callback('🧾 Bayar QRIS Manual', `paymanual_${prodId}_${qty}_0`)],
      [Markup.button.callback('🅳 Bayar via DANA', `paydana_${prodId}_${qty}_0`)],
      [Markup.button.callback('🅶 Bayar via GoPay', `paygopay_${prodId}_${qty}_0`)],
      [Markup.button.callback('💰 Bayar Pakai Saldo', `paysaldo_${prodId}_${qty}`)],
      [Markup.button.callback('🔙 Kembali', `buy_${prodId}`)]
    ]);
    safeClearAndSend(ctx, `🛍️ *KONFIRMASI PESANAN*\n\n📦 *Produk:* ${prod.name}\n🔢 *Jumlah:* ${qty} item\n💰 *Total:* Rp${totalPrice.toLocaleString('id-ID')}`, buttons);
  });
};

bot.action(/^qtyconfirm_(.+)_(.+)$/, async (ctx) => {
  ctx.answerCbQuery();
  showPaymentOptions(ctx, ctx.match[1], parseInt(ctx.match[2]));
});

bot.action(/^selectqty_(.+)_(.+)$/, async (ctx) => {
  showPaymentOptions(ctx, ctx.match[1], parseInt(ctx.match[2]));
});

bot.action(/^vouc_(.+)_(.+)$/, async (ctx) => {
  userState[ctx.from.id] = { step: 'INPUT_VOUCHER', prodId: ctx.match[1], qty: ctx.match[2] };
  await safeClearAndSend(ctx, `🎟️ *MASUKKAN KODE VOUCHER*`, Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', `selectqty_${ctx.match[1]}_${ctx.match[2]}`)]]));
});

// FIX: Regex pay_ sekarang pakai underscore pemisah
bot.action(/^pay_(.+)_(.+)_(.+)$/, async (ctx) => {
  const prodId = ctx.match[1];
  const qty = parseInt(ctx.match[2]);
  const discount = parseInt(ctx.match[3]) || 0;
  db.get(`SELECT * FROM products WHERE id = ?`, [prodId], async (err, prod) => {
    if (err || !prod) return ctx.answerCbQuery('⚠️ Produk tidak ditemukan.', { show_alert: true });
    const basePrice = Math.max(1000, (prod.price * qty) - discount);
    const username = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'Buyer');
    try {
      const qris = await generateDynamicQRIS(basePrice, `ORD`, { name: username, phone: String(ctx.from.id) });
      const now = new Date().toISOString();
      db.run(`INSERT INTO orders (user_id, username, product_id, quantity, status, discount, amount, created_at, casaku_transaction_id, qris_expires_at) VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?)`,
        [ctx.from.id, username, prodId, qty, discount, qris.totalAmount, now, qris.transactionId, qris.expiresAt], function (dbErr) {
          if (dbErr) return safeClearAndSend(ctx, '⚠️ Gagal membuat pesanan.');
          const orderId = this.lastID;
          userState[ctx.from.id] = { step: 'UPLOAD_PROOF', orderId };
          const detailText = `🧾 *PESANAN #${orderId}*\n\n📦 *Produk:* ${prod.name} (${qty}x)\n💰 *Harga:* Rp${basePrice.toLocaleString('id-ID')}\n💳 *Total Bayar:* *Rp${qris.totalAmount.toLocaleString('id-ID')}*\n🧾 *Transaksi:* \`${qris.transactionId}\`\n⏳ *Berlaku sampai:* ${new Date(qris.expiresAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`;
          safeClearAndSend(ctx, detailText, {
            photo: { source: qris.imageBuffer },
            ...Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', 'user_catalog')]])
          }).then((sent) => {
            if (sent && sent.message_id) db.run(`UPDATE orders SET qris_message_id = ? WHERE id = ?`, [sent.message_id, orderId]);
          });
        });
    } catch (e) {
      return ctx.answerCbQuery(`⚠️ Gagal membuat QRIS: ${e.message}`, { show_alert: true });
    }
  });
});

// Bayar QRIS MANUAL — pakai foto QRIS statis yang di-set admin (bukan QRIS dinamis Casaku)
bot.action(/^paymanual_(.+)_(.+)_(.+)$/, async (ctx) => {
  const prodId = ctx.match[1];
  const qty = parseInt(ctx.match[2]);
  const discount = parseInt(ctx.match[3]) || 0;
  db.get(`SELECT * FROM products WHERE id = ?`, [prodId], async (err, prod) => {
    if (err || !prod) return ctx.answerCbQuery('⚠️ Produk tidak ditemukan.', { show_alert: true });
    db.get(`SELECT qris FROM store WHERE id = 1`, async (err, store) => {
      const qrisPhoto = (DEFAULT_QRIS_PHOTO && DEFAULT_QRIS_PHOTO.trim() !== '') ? DEFAULT_QRIS_PHOTO : (store && store.qris ? store.qris : '');
      if (!qrisPhoto || qrisPhoto.trim() === '') {
        return ctx.answerCbQuery('⚠️ Foto QRIS manual belum diatur admin. Gunakan QRIS Otomatis.', { show_alert: true });
      }
      const totalPrice = Math.max(1000, (prod.price * qty) - discount);
      const username = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'Buyer');
      const now = new Date().toISOString();
      db.run(`INSERT INTO orders (user_id, username, product_id, quantity, status, discount, amount, created_at) VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
        [ctx.from.id, username, prodId, qty, discount, totalPrice, now], function (dbErr) {
          if (dbErr) return safeClearAndSend(ctx, '⚠️ Gagal membuat pesanan.');
          const orderId = this.lastID;
          userState[ctx.from.id] = { step: 'UPLOAD_PROOF', orderId };
          const detailText = `🧾 *PESANAN #${orderId}* (QRIS Manual)\n\n📦 *Produk:* ${prod.name} (${qty}x)\n💳 *Total Bayar:* *Rp${totalPrice.toLocaleString('id-ID')}*\n\n📲 Scan QRIS di atas, lalu kirim *foto bukti transfer* ke chat ini.`;
          safeClearAndSend(ctx, detailText, {
            photo: qrisPhoto,
            ...Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', 'user_catalog')]])
          });
        });
    });
  });
});

// Bayar via DANA / GoPay — manual, pakai nomor teks yang di-set admin
const payManualNumber = async (ctx, prodId, qty, discount, methodKey, methodLabel) => {
  db.get(`SELECT * FROM products WHERE id = ?`, [prodId], async (err, prod) => {
    if (err || !prod) return ctx.answerCbQuery('⚠️ Produk tidak ditemukan.', { show_alert: true });
    db.get(`SELECT ${methodKey} FROM store WHERE id = 1`, async (err, store) => {
      const number = store && store[methodKey] ? store[methodKey].trim() : '';
      if (!number) return ctx.answerCbQuery(`⚠️ Nomor ${methodLabel} belum diatur admin.`, { show_alert: true });
      const totalPrice = Math.max(1000, (prod.price * qty) - discount);
      const username = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'Buyer');
      const now = new Date().toISOString();
      db.run(`INSERT INTO orders (user_id, username, product_id, quantity, status, discount, amount, created_at) VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
        [ctx.from.id, username, prodId, qty, discount, totalPrice, now], function (dbErr) {
          if (dbErr) return safeClearAndSend(ctx, '⚠️ Gagal membuat pesanan.');
          const orderId = this.lastID;
          userState[ctx.from.id] = { step: 'UPLOAD_PROOF', orderId };
          const detailText = `🧾 *PESANAN #${orderId}* (${methodLabel})\n\n📦 *Produk:* ${prod.name} (${qty}x)\n💳 *Total Bayar:* *Rp${totalPrice.toLocaleString('id-ID')}*\n\n📲 Transfer ke *${methodLabel}*:\n\`${number}\`\n\nSetelah transfer, kirim *foto bukti* ke chat ini.`;
          safeClearAndSend(ctx, detailText, Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', 'user_catalog')]]));
        });
    });
  });
};

bot.action(/^paydana_(.+)_(.+)_(.+)$/, async (ctx) => {
  await payManualNumber(ctx, ctx.match[1], parseInt(ctx.match[2]), parseInt(ctx.match[3]) || 0, 'dana', 'DANA');
});

bot.action(/^paygopay_(.+)_(.+)_(.+)$/, async (ctx) => {
  await payManualNumber(ctx, ctx.match[1], parseInt(ctx.match[2]), parseInt(ctx.match[3]) || 0, 'gopay', 'GoPay');
});

bot.action(/^paysaldo_(.+)_(.+)$/, async (ctx) => {
  const prodId = ctx.match[1];
  const qty = parseInt(ctx.match[2]);
  const userId = ctx.from.id;
  db.get(`SELECT * FROM products WHERE id = ?`, [prodId], (err, prod) => {
    if (!prod) return ctx.answerCbQuery('⚠️ Produk tidak ditemukan.', { show_alert: true });
    db.all(`SELECT * FROM stock_items WHERE product_id = ? AND status = 'AVAILABLE' LIMIT ?`, [prodId, qty], (err, stocks) => {
      if (!stocks || stocks.length < qty) return ctx.answerCbQuery(`⚠️ Stok tidak cukup!`, { show_alert: true });
      db.get(`SELECT balance, tier FROM users WHERE user_id = ?`, [userId], (err, row) => {
        const tier = row ? row.tier : 'Bronze';
        const balance = row ? row.balance : 0;
        const totalCost = prod.price * qty;
        if (tier !== 'Owner' && userId !== getAdminId() && balance < totalCost) return ctx.answerCbQuery(`⚠️ Saldo tidak cukup!`, { show_alert: true });
        const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        const username = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'Buyer');
        if (tier !== 'Owner' && userId !== getAdminId()) db.run(`UPDATE users SET balance = balance - ? WHERE user_id = ?`, [totalCost, userId]);
        const stockIds = stocks.map(s => s.id);
        const stockContents = stocks.map(s => s.content).join('\n---\n');
        db.run(`UPDATE stock_items SET status = 'SOLD' WHERE id IN (${stockIds.join(',')})`);
        db.run(`INSERT INTO orders (user_id, username, product_id, quantity, status, discount, amount, created_at) VALUES (?, ?, ?, ?, 'APPROVED', 0, ?, ?)`,
          [userId, username, prodId, qty, totalCost, now], async function (err) {
            const orderId = this.lastID;
            const catatanHtml = prod.note ? formatMaybeLongHtml('📝 <b>CATATAN:</b>', prod.note) : '';
            const successText = `🎉 <b>PEMBELIAN BERHASIL (SALDO)!</b>\n\nDetail (#${orderId}):\n<pre>${escapeHtml(stockContents)}</pre>\n\n${catatanHtml}`;
            await safeClearAndSend(ctx, successText, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu Utama', 'main_menu')]]) });
          });
      });
    });
  });
});

const approveTopupById = (topupId) => {
  return new Promise((resolve) => {
    db.get(`SELECT * FROM topups WHERE id = ?`, [topupId], (err, topup) => {
      if (!topup) return resolve({ ok: false, reason: 'NOT_FOUND' });
      if (topup.status === 'APPROVED') return resolve({ ok: false, reason: 'ALREADY_APPROVED', topup });
      db.run(`UPDATE topups SET status = 'APPROVED' WHERE id = ?`, [topupId]);
      db.run(`UPDATE users SET balance = COALESCE(balance, 0) + ? WHERE user_id = ?`, [topup.amount, topup.user_id]);
      if (topup.qris_message_id) bot.telegram.deleteMessage(topup.user_id, topup.qris_message_id).catch(() => {});
      bot.telegram.sendMessage(topup.user_id, `🎉 *TOP UP DIKONFIRMASI!*\n\nSaldo Rp${topup.amount.toLocaleString('id-ID')} telah ditambahkan.`, { parse_mode: 'Markdown' }).catch(() => {});
      resolve({ ok: true, topup });
    });
  });
};

bot.action(/^topupapprove_(.+)$/, async (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  const result = await approveTopupById(ctx.match[1]);
  if (!result.ok) return ctx.answerCbQuery(result.reason === 'ALREADY_APPROVED' ? 'Sudah di-approve!' : 'Tidak ditemukan.', { show_alert: true });
  ctx.answerCbQuery('✅ Top up di-approve.', { show_alert: true });
});

bot.action(/^topupreject_(.+)$/, async (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  db.get(`SELECT * FROM topups WHERE id = ?`, [ctx.match[1]], (err, topup) => {
    if (!topup) return ctx.answerCbQuery('Tidak ditemukan.', { show_alert: true });
    db.run(`UPDATE topups SET status = 'REJECTED' WHERE id = ?`, [ctx.match[1]]);
    bot.telegram.sendMessage(topup.user_id, `❌ *TOP UP DITOLAK*`, { parse_mode: 'Markdown' }).catch(() => {});
    ctx.answerCbQuery('Top up ditolak.', { show_alert: true });
  });
});

// Kirim testi transaksi sukses ke grup log/testi (kalau sudah di-set admin)
const postTestiToGroup = (text, photo) => {
  db.get(`SELECT log_group_id FROM store WHERE id = 1`, (err, store) => {
    if (!store || !store.log_group_id || String(store.log_group_id).trim() === '') return;
    const groupId = store.log_group_id.trim();
    if (photo) {
      bot.telegram.sendPhoto(groupId, photo, { caption: text, parse_mode: 'Markdown' }).catch((e) => {
        console.log('⚠️ Gagal kirim testi ke grup:', e.message);
      });
    } else {
      bot.telegram.sendMessage(groupId, text, { parse_mode: 'Markdown' }).catch((e) => {
        console.log('⚠️ Gagal kirim testi ke grup:', e.message);
      });
    }
  });
};

const approveOrderById = (orderId) => {
  return new Promise((resolve) => {
    db.get(`SELECT o.*, p.name as product_name, p.note as product_note FROM orders o JOIN products p ON o.product_id = p.id WHERE o.id = ?`, [orderId], (err, order) => {
      if (!order) return resolve({ ok: false, reason: 'NOT_FOUND' });
      if (order.status === 'APPROVED') return resolve({ ok: false, reason: 'ALREADY_APPROVED', order });
      db.all(`SELECT * FROM stock_items WHERE product_id = ? AND status = 'AVAILABLE' LIMIT ?`, [order.product_id, order.quantity], (err, stocks) => {
        if (!stocks || stocks.length < order.quantity) return resolve({ ok: false, reason: 'OUT_OF_STOCK', order, available: stocks ? stocks.length : 0 });
        const stockIds = stocks.map(s => s.id);
        const stockContents = stocks.map(s => s.content).join('\n---\n');
        db.run(`UPDATE orders SET status = 'APPROVED' WHERE id = ?`, [orderId]);
        db.run(`UPDATE stock_items SET status = 'SOLD' WHERE id IN (${stockIds.join(',')})`);
        const catatanHtml2 = order.product_note ? formatMaybeLongHtml('📝 <b>CATATAN:</b>', order.product_note) : '';
        if (order.qris_message_id) bot.telegram.deleteMessage(order.user_id, order.qris_message_id).catch(() => {});
        bot.telegram.sendMessage(order.user_id, `🎉 <b>PEMBAYARAN DIKONFIRMASI!</b>\n\nDetail (#${orderId}):\n<pre>${escapeHtml(stockContents)}</pre>\n\n${catatanHtml2}`, { parse_mode: 'HTML' }).catch(() => {});
        const testiText = `✅ *TRANSAKSI SUKSES*\n\n📦 *Produk:* ${order.product_name} (${order.quantity || 1}x)\n💰 *Total:* Rp${order.amount.toLocaleString('id-ID')}\n👤 *Buyer:* ${order.username}\n\n_Terima kasih sudah belanja di toko kami!_`;
        postTestiToGroup(testiText, order.proof);
        resolve({ ok: true, order });
      });
    });
  });
};

bot.action(/^approve_(.+)$/, async (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  const result = await approveOrderById(ctx.match[1]);
  if (!result.ok) return ctx.answerCbQuery('Error.', { show_alert: true });
  ctx.answerCbQuery('✅ Pesanan di-approve.', { show_alert: true });
});

bot.action(/^reject_(.+)$/, async (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  db.get(`SELECT * FROM orders WHERE id = ?`, [ctx.match[1]], (err, order) => {
    if (!order) return ctx.answerCbQuery('Tidak ditemukan.', { show_alert: true });
    db.run(`UPDATE orders SET status = 'REJECTED' WHERE id = ?`, [ctx.match[1]]);
    bot.telegram.sendMessage(order.user_id, `❌ *PEMBAYARAN DITOLAK*`, { parse_mode: 'Markdown' }).catch(() => {});
    ctx.answerCbQuery('Pesanan ditolak.', { show_alert: true });
  });
});

const approveScriptOrderById = (scriptOrderId) => {
  return new Promise((resolve) => {
    db.get(`SELECT so.*, bs.* , so.id as order_id FROM script_orders so JOIN bot_scripts bs ON so.script_id = bs.id WHERE so.id = ?`, [scriptOrderId], async (err, order) => {
      if (!order) return resolve({ ok: false, reason: 'NOT_FOUND' });
      if (order.status === 'APPROVED') return resolve({ ok: false, reason: 'ALREADY_APPROVED', order });
      if (order.stock <= 0) return resolve({ ok: false, reason: 'OUT_OF_STOCK', order });
      db.run(`UPDATE script_orders SET status = 'APPROVED' WHERE id = ?`, [scriptOrderId]);
      db.run(`UPDATE bot_scripts SET stock = stock - 1 WHERE id = ?`, [order.script_id]);
      await deliverScriptById(order.user_id, order);
      if (order.qris_message_id) bot.telegram.deleteMessage(order.user_id, order.qris_message_id).catch(() => {});
      bot.telegram.sendMessage(order.user_id, `🎉 *PEMBAYARAN SCRIPT DIKONFIRMASI!*\n\nTerima kasih! Script telah dikirim.`, { parse_mode: 'Markdown' }).catch(() => {});
      const testiText = `✅ *TRANSAKSI SCRIPT SUKSES*\n\n📦 *Script:* ${order.name}\n💰 *Total:* Rp${order.amount.toLocaleString('id-ID')}\n👤 *Buyer:* ${order.username}\n\n_Terima kasih sudah belanja di toko kami!_`;
      postTestiToGroup(testiText, order.proof);
      resolve({ ok: true, order });
    });
  });
};

bot.action(/^scriptapprove_(.+)$/, async (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  const result = await approveScriptOrderById(ctx.match[1]);
  if (!result.ok) {
    const msg = result.reason === 'ALREADY_APPROVED' ? 'Sudah di-approve!' : result.reason === 'OUT_OF_STOCK' ? 'Stok script habis!' : 'Tidak ditemukan.';
    return ctx.answerCbQuery(msg, { show_alert: true });
  }
  ctx.answerCbQuery('✅ Script order di-approve & dikirim ke buyer.', { show_alert: true });
});

bot.action(/^scriptreject_(.+)$/, async (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  db.get(`SELECT * FROM script_orders WHERE id = ?`, [ctx.match[1]], (err, order) => {
    if (!order) return ctx.answerCbQuery('Tidak ditemukan.', { show_alert: true });
    db.run(`UPDATE script_orders SET status = 'REJECTED' WHERE id = ?`, [ctx.match[1]]);
    bot.telegram.sendMessage(order.user_id, `❌ *PEMBAYARAN SCRIPT DITOLAK*`, { parse_mode: 'Markdown' }).catch(() => {});
    ctx.answerCbQuery('Script order ditolak.', { show_alert: true });
  });
});

const sendAdminDashboard = async (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  await safeClearAndSend(ctx, '⚙️ DASHBOARD ADMIN TOKO', getAdminMenu());
};
bot.action('admin_dashboard', sendAdminDashboard);
bot.command('admin', sendAdminDashboard);

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
  try { await ctx.replyWithDocument({ source: dbPath, filename: 'database.db' }, { caption: '💾 DATABASE BACKUP' }); }
  catch (e) { safeClearAndSend(ctx, '❌ Gagal backup.'); }
});

bot.action('admin_backup_code', async (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  try {
    const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    await ctx.replyWithDocument({ source: __filename, filename: 'bot.js' }, { caption: `📄 *SOURCE CODE BACKUP*\n\n🕒 ${now}`, parse_mode: 'Markdown' });
  } catch (e) { safeClearAndSend(ctx, '❌ Gagal backup source code: ' + e.message); }
});

bot.action('admin_edit_store', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'EDIT_STORE_NAME' };
  safeClearAndSend(ctx, 'Masukkan Nama Toko Baru:');
});
bot.action('admin_set_header_photo', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'SET_HEADER_PHOTO' };
  safeClearAndSend(ctx, 'Kirimkan foto untuk Banner Header:');
});
bot.action('admin_set_qris_photo', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'SET_QRIS_PHOTO' };
  safeClearAndSend(ctx, 'Kirimkan foto QRIS toko:');
});
bot.action('admin_set_dana', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'SET_DANA_NUMBER' };
  safeClearAndSend(ctx, 'Masukkan Nomor DANA (contoh: 0812xxxxxxx a.n Nama):');
});
bot.action('admin_set_gopay', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'SET_GOPAY_NUMBER' };
  safeClearAndSend(ctx, 'Masukkan Nomor GoPay (contoh: 0812xxxxxxx a.n Nama):');
});
bot.action('admin_set_welcome', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'SET_WELCOME_MSG' };
  safeClearAndSend(ctx, 'Kirim pesan Welcome:');
});
bot.action('admin_set_leave', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'SET_LEAVE_MSG' };
  safeClearAndSend(ctx, 'Kirim pesan Leave:');
});
bot.action('admin_set_song', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'SET_SONG' };
  safeClearAndSend(ctx, '🎵 Kirimkan file audio/lagu:');
});
bot.action('admin_set_uname', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'SET_ADMIN_UNAME' };
  safeClearAndSend(ctx, 'Masukkan Username CS:');
});
bot.action('admin_set_channel', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'SET_REQ_CHANNEL' };
  safeClearAndSend(ctx, 'Masukkan Username Channel:');
});
bot.action('admin_set_log_group', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'SET_LOG_GROUP' };
  safeClearAndSend(ctx, 'Masukkan ID Grup Log:');
});
bot.action('admin_set_req_group', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'SET_REQ_GROUP' };
  safeClearAndSend(ctx, 'Masukkan Username Grup:');
});
bot.action('admin_add_voucher', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'ADD_VOUCHER_CODE' };
  safeClearAndSend(ctx, 'Masukkan Kode Voucher:');
});
bot.action('admin_del_voucher', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  db.all(`SELECT * FROM vouchers`, (err, rows) => {
    if (!rows || rows.length === 0) return safeClearAndSend(ctx, 'Belum ada voucher.');
    const buttons = rows.map(v => [Markup.button.callback(`🗑️ ${v.code}`, `delvouc_${v.code}`)]);
    safeClearAndSend(ctx, 'Pilih voucher yang dihapus:', Markup.inlineKeyboard(buttons));
  });
});
bot.action(/^delvouc_(.+)$/, (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  db.run(`DELETE FROM vouchers WHERE code = ?`, [ctx.match[1]]);
  safeClearAndSend(ctx, '✅ Voucher dihapus!');
});

const showUserManageCard = (ctx, targetId) => {
  db.get(`SELECT * FROM users WHERE user_id = ?`, [targetId], (err, row) => {
    if (!row) {
      db.run(`INSERT INTO users (user_id, upline_id, balance, tier) VALUES (?, 0, 0, 'Bronze')`, [targetId], () => showUserManageCard(ctx, targetId));
      return;
    }
    const tier = row.tier || 'Bronze';
    const balance = tier === 'Owner' ? '∞ (Unlimited)' : `Rp${(row.balance || 0).toLocaleString('id-ID')}`;
    safeClearAndSend(ctx, `👤 *KELOLA USER*\n\n🆔 *ID:* \`${targetId}\`\n💳 Saldo: ${balance}\n🏷️ Tier: ${tier}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
      [Markup.button.callback('➕ Tambah Saldo', `adduser_saldo_${targetId}`), Markup.button.callback('➖ Kurangi Saldo', `subuser_saldo_${targetId}`)],
      [Markup.button.callback('🥉 Bronze', `settier_${targetId}_Bronze`), Markup.button.callback('🥈 Silver', `settier_${targetId}_Silver`)],
      [Markup.button.callback('🥇 Gold', `settier_${targetId}_Gold`), Markup.button.callback('👑 Owner', `settier_${targetId}_Owner`)],
      [Markup.button.callback('🔙 Dashboard Admin', 'admin_dashboard')]
    ]) });
  });
};

bot.action('admin_manage_user', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'ADMIN_MANAGE_USER_ID' };
  safeClearAndSend(ctx, 'Masukkan ID Telegram user:');
});
bot.action(/^adduser_saldo_(.+)$/, (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'ADMIN_ADD_SALDO_AMOUNT', targetId: ctx.match[1] };
  safeClearAndSend(ctx, `Masukkan nominal saldo yang *DITAMBAH* untuk \`${ctx.match[1]}\`:`, { parse_mode: 'Markdown' });
});
bot.action(/^subuser_saldo_(.+)$/, (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'ADMIN_SUB_SALDO_AMOUNT', targetId: ctx.match[1] };
  safeClearAndSend(ctx, `Masukkan nominal saldo yang *DIKURANGI* dari \`${ctx.match[1]}\`:`, { parse_mode: 'Markdown' });
});
bot.action(/^settier_(.+)_(Bronze|Silver|Gold|Owner)$/, (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  const targetId = ctx.match[1];
  const tier = ctx.match[2];
  db.run(`UPDATE users SET tier = ? WHERE user_id = ?`, [tier, targetId]);
  ctx.answerCbQuery(`✅ Tier ${targetId} → ${tier}`, { show_alert: true });
  bot.telegram.sendMessage(targetId, `🏷️ *TIER DIPERBARUI*\n\nTier Anda: *${tier}*`, { parse_mode: 'Markdown' }).catch(() => {});
  showUserManageCard(ctx, targetId);
});

bot.action('admin_broadcast_menu', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'BROADCAST_TEXT' };
  safeClearAndSend(ctx, 'Masukkan pesan broadcast:');
});
bot.action('admin_bc_button', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'BC_BTN_TEXT' };
  safeClearAndSend(ctx, 'Masukkan teks broadcast (+ tombol):');
});
bot.action('admin_add_prod', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'ADD_PROD_NAME' };
  safeClearAndSend(ctx, 'Masukkan Nama Produk:');
});
bot.action('admin_del_prod', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  db.all(`SELECT * FROM products`, (err, rows) => {
    if (!rows || rows.length === 0) return safeClearAndSend(ctx, 'Tidak ada produk.');
    const buttons = rows.map(p => [Markup.button.callback(`🗑️ ${p.name}`, `delprod_${p.id}`)]);
    safeClearAndSend(ctx, 'Pilih produk yang dihapus:', Markup.inlineKeyboard(buttons));
  });
});
bot.action(/^delprod_(.+)$/, (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  db.run(`DELETE FROM products WHERE id = ?`, [ctx.match[1]]);
  db.run(`DELETE FROM stock_items WHERE product_id = ?`, [ctx.match[1]]);
  safeClearAndSend(ctx, '✅ Produk dihapus!');
});
bot.action('admin_add_stock', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  db.all(`SELECT * FROM products`, (err, rows) => {
    if (!rows || rows.length === 0) return safeClearAndSend(ctx, 'Tambah produk dulu!');
    const buttons = rows.map(p => [Markup.button.callback(`📦 ${p.name}`, `addstock_${p.id}`)]);
    safeClearAndSend(ctx, 'Pilih produk:', Markup.inlineKeyboard(buttons));
  });
});
bot.action(/^addstock_(.+)$/, (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'ADD_STOCK_BULK', prodId: ctx.match[1] };
  safeClearAndSend(ctx, '📥 TAMBAH STOK MASSAL\n\nPaste banyak akun/kode (setiap baris = 1 stok):');
});
bot.action('admin_autoreply_type', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  userState[getAdminId()] = { step: 'ADD_AR_KEYWORD' };
  safeClearAndSend(ctx, 'Masukkan Kata Kunci Auto-Reply:');
});
bot.action('admin_del_autoreply', (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  db.all(`SELECT keyword FROM auto_reply`, (err, rows) => {
    if (!rows || rows.length === 0) return safeClearAndSend(ctx, 'Belum ada auto-reply.');
    const buttons = rows.map(ar => [Markup.button.callback(`🗑️ ${ar.keyword}`, `delar_${ar.keyword}`)]);
    safeClearAndSend(ctx, 'Pilih Auto-Reply:', Markup.inlineKeyboard(buttons));
  });
});
bot.action(/^delar_(.+)$/, (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  db.run(`DELETE FROM auto_reply WHERE keyword = ?`, [ctx.match[1]]);
  safeClearAndSend(ctx, '✅ Auto-reply dihapus!');
});

// Handler Audio
bot.on('audio', async (ctx) => {
  const adminId = getAdminId();
  if (Number(ctx.from.id) !== adminId || !userState[adminId] || userState[adminId].step !== 'SET_SONG') return;
  const audioId = ctx.message.audio.file_id;
  db.run(`UPDATE store SET song = ? WHERE id = 1`, [audioId]);
  delete userState[adminId];
  safeClearAndSend(ctx, '✅ Lagu berhasil dipasang!');
});

// Handler Photo
bot.on('photo', async (ctx) => {
  const adminId = getAdminId();
  const userId = ctx.from.id;
  const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  if (Number(userId) === adminId && userState[adminId]) {
    if (userState[adminId].step === 'SET_HEADER_PHOTO') {
      db.run(`UPDATE store SET photo = ? WHERE id = 1`, [photoId]);
      delete userState[adminId];
      return safeClearAndSend(ctx, '✅ Foto Banner diganti!');
    }
    if (userState[adminId].step === 'SET_QRIS_PHOTO') {
      db.run(`UPDATE store SET qris = ? WHERE id = 1`, [photoId]);
      delete userState[adminId];
      return safeClearAndSend(ctx, '✅ Foto QRIS diatur!');
    }
    if (userState[adminId].step === 'ADD_PROD_PHOTO') {
      const { name, price } = userState[adminId];
      db.run(`INSERT INTO products (name, price, photo) VALUES (?, ?, ?)`, [name, price, photoId]);
      delete userState[adminId];
      return safeClearAndSend(ctx, '✅ Produk dengan foto ditambahkan!');
    }
    return;
  }
  const state = userState[userId];
  if (state && state.step === 'UPLOAD_TOPUP_PROOF') {
    const topupId = state.topupId;
    delete userState[userId];
    db.get(`SELECT * FROM topups WHERE id = ?`, [topupId], (err, topup) => {
      if (!topup) return safeClearAndSend(ctx, '⚠️ Data top up tidak ditemukan.');
      db.run(`UPDATE topups SET proof = ?, status = 'PENDING_REVIEW' WHERE id = ?`, [photoId, topupId]);
      safeClearAndSend(ctx, '✅ Bukti top up diterima! Mohon tunggu verifikasi admin.');
      if (adminId) {
        const reviewText = `💰 *KONFIRMASI TOP UP #${topupId}*\n\n💵 *Nominal:* Rp${topup.amount.toLocaleString('id-ID')}\n💳 *Total:* Rp${topup.total_amount.toLocaleString('id-ID')}\n👤 *User:* ${topup.username} (ID: ${topup.user_id})`;
        bot.telegram.sendPhoto(adminId, photoId, {
          caption: reviewText, parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('✅ Approve', `topupapprove_${topupId}`), Markup.button.callback('❌ Reject', `topupreject_${topupId}`)]])
        }).catch(() => {});
      }
    });
    return;
  }
  if (state && state.step === 'UPLOAD_SCRIPT_PROOF') {
    const scriptOrderId = state.scriptOrderId;
    delete userState[userId];
    db.get(`SELECT so.*, bs.name as script_name FROM script_orders so JOIN bot_scripts bs ON so.script_id = bs.id WHERE so.id = ?`, [scriptOrderId], (err, order) => {
      if (!order) return safeClearAndSend(ctx, '⚠️ Pesanan script tidak ditemukan.');
      db.run(`UPDATE script_orders SET proof = ?, status = 'PENDING_REVIEW' WHERE id = ?`, [photoId, scriptOrderId]);
      safeClearAndSend(ctx, '✅ Bukti transfer diterima! Mohon tunggu admin.');
      if (adminId) {
        const reviewText = `🤖 *KONFIRMASI PEMBAYARAN SCRIPT #${scriptOrderId}*\n\n📦 *Script:* ${order.script_name}\n💰 *Total:* Rp${order.amount.toLocaleString('id-ID')}\n👤 *Buyer:* ${order.username} (ID: ${order.user_id})`;
        bot.telegram.sendPhoto(adminId, photoId, {
          caption: reviewText, parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('✅ Approve', `scriptapprove_${scriptOrderId}`), Markup.button.callback('❌ Reject', `scriptreject_${scriptOrderId}`)]])
        }).catch(() => {});
      }
    });
    return;
  }
  if (state && state.step === 'UPLOAD_PROOF') {
    const orderId = state.orderId;
    delete userState[userId];
    db.get(`SELECT o.*, p.name as product_name FROM orders o JOIN products p ON o.product_id = p.id WHERE o.id = ?`, [orderId], (err, order) => {
      if (!order) return safeClearAndSend(ctx, '⚠️ Pesanan tidak ditemukan.');
      db.run(`UPDATE orders SET proof = ?, status = 'PENDING_REVIEW' WHERE id = ?`, [photoId, orderId]);
      safeClearAndSend(ctx, '✅ Bukti transfer diterima! Mohon tunggu admin.');
      if (adminId) {
        const reviewText = `🧾 *KONFIRMASI PEMBAYARAN #${orderId}*\n\n📦 *Produk:* ${order.product_name} (${order.quantity || 1}x)\n💰 *Total:* Rp${order.amount.toLocaleString('id-ID')}\n👤 *Buyer:* ${order.username} (ID: ${order.user_id})`;
        bot.telegram.sendPhoto(adminId, photoId, {
          caption: reviewText, parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('✅ Approve', `approve_${orderId}`), Markup.button.callback('❌ Reject', `reject_${orderId}`)]])
        }).catch(() => {});
      }
    });
    return;
  }
});

// === HANDLER TEXT (CS LIVE CHAT & ADMIN REPLY) ===
bot.on('text', async (ctx) => {
  const adminId = getAdminId();
  const userId = ctx.from.id;
  const state = userState[userId];

  // 1. ADMIN MEMBALAS PESAN USER
  if (Number(userId) === adminId && ctx.message.reply_to_message) {
    const repliedMsgId = ctx.message.reply_to_message.message_id;
    const relay = await new Promise((resolve) => {
      db.get(`SELECT * FROM chat_relay WHERE admin_msg_id = ?`, [repliedMsgId], (err, row) => resolve(row));
    });
    if (relay) {
      bot.telegram.sendMessage(relay.buyer_id, `💬 *Admin:*\n${ctx.message.text}`, { parse_mode: 'Markdown' })
        .then(() => safeClearAndSend(ctx, '✅ Balasan terkirim ke buyer.'))
        .catch(() => safeClearAndSend(ctx, '⚠️ Gagal kirim balasan ke buyer.'));
      return;
    }
  }

  // 2. USER MENGIRIM PESAN CS
  if (state && state.step === 'CS_CHAT') {
    const buyerName = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'Buyer');
    const relayText = `📞 *PESAN CS DARI BUYER*\n👤 ${buyerName} (ID: \`${userId}\`)\n\n${ctx.message.text}\n\n_↩️ Reply pesan ini untuk membalas ke buyer._`;
    
    bot.telegram.sendMessage(adminId, relayText, { parse_mode: 'Markdown' })
      .then((sentMsg) => { 
        db.run(`INSERT OR REPLACE INTO chat_relay (admin_msg_id, buyer_id, buyer_name) VALUES (?, ?, ?)`, [sentMsg.message_id, userId, buyerName]); 
      })
      .catch(() => {});
      
    safeClearAndSend(ctx, '✅ Pesan Anda telah diteruskan ke Admin. Mohon tunggu balasan.');
    return;
  }

  // 3. AUTO REPLY BIASA
  if (!state) {
    const textMsg = ctx.message.text.trim().toLowerCase();
    db.get(`SELECT * FROM auto_reply WHERE LOWER(keyword) = ?`, [textMsg], (err, ar) => {
      if (ar) {
        if (ar.btn_label && ar.btn_url) safeClearAndSend(ctx, ar.content, Markup.inlineKeyboard([[Markup.button.url(ar.btn_label, ar.btn_url)]]));
        else safeClearAndSend(ctx, ar.content);
      }
    });
    return;
  }

  // 4. HANDLER TEXT LAINNYA (SEARCH, VOUCHER, TOPUP, ADMIN SETTINGS)
  if (state.step === 'SEARCH_PRODUCT') {
    const keyword = ctx.message.text.trim();
    delete userState[ctx.from.id];
    db.all(`SELECT p.*, COUNT(s.id) AS stock_count FROM products p LEFT JOIN stock_items s ON p.id = s.product_id AND s.status = 'AVAILABLE' WHERE p.name LIKE ? GROUP BY p.id`, [`%${keyword}%`], async (err, products) => {
      if (!products || products.length === 0) return safeClearAndSend(ctx, `❌ Tidak ada produk "*${keyword}*"`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Katalog', 'user_catalog')]]));
      let text = `🔍 *HASIL PENCARIAN ("${keyword}"):*\n\n`;
      let buttons = products.map(prod => [Markup.button.callback(`${prod.name} (Rp${prod.price.toLocaleString('id-ID')}) [${prod.stock_count}]`, `buy_${prod.id}`)]);
      buttons.push([Markup.button.callback('🔙 Katalog', 'user_catalog')]);
      safeClearAndSend(ctx, text, Markup.inlineKeyboard(buttons));
    });
    return;
  }

  if (state.step === 'QTY_CUSTOM_INPUT') {
    const qty = parseInt(ctx.message.text.trim());
    delete userState[ctx.from.id];
    if (!qty || qty < 1) return safeClearAndSend(ctx, '⚠️ Jumlah tidak valid, coba lagi lewat menu produk.');
    db.get(`SELECT COUNT(id) AS stock_count FROM stock_items WHERE product_id = ? AND status = 'AVAILABLE'`, [state.prodId], (err, res) => {
      const available = res ? res.stock_count : 0;
      if (qty > available) return safeClearAndSend(ctx, `⚠️ Stok cuma ${available}, masukkan jumlah lebih kecil.`);
      renderQtySelector(ctx, state.prodId, qty, false);
    });
    return;
  }

  if (state.step === 'INPUT_VOUCHER') {
    const code = ctx.message.text.trim().toUpperCase();
    db.get(`SELECT * FROM vouchers WHERE code = ? AND quota > 0`, [code], (err, vouc) => {
      if (!vouc) {
        safeClearAndSend(ctx, '⚠️ Voucher tidak valid / habis!');
        delete userState[ctx.from.id];
        safeClearAndSend(ctx, 'Klik:', Markup.inlineKeyboard([[Markup.button.callback('⏩ Lanjut Bayar', `pay_${state.prodId}_${state.qty}_0`)]]));
      } else {
        delete userState[ctx.from.id];
        safeClearAndSend(ctx, `🎉 *VOUCHER AKTIF:* Potongan Rp${vouc.discount.toLocaleString('id-ID')}`, Markup.inlineKeyboard([[Markup.button.callback('💳 Lanjut Bayar', `pay_${state.prodId}_${state.qty}_${vouc.discount}`)]]));
      }
    });
    return;
  }

  if (state.step === 'TOPUP_AMOUNT') {
    const amount = parseInt(ctx.message.text.trim().replace(/\D/g, ''));
    if (!amount || amount < 500 || amount > 10000000) return safeClearAndSend(ctx, '⚠️ Nominal tidak valid (500-10000000):');
    delete userState[ctx.from.id];
    processTopUp(ctx, amount);
    return;
  }

  // ADMIN HANDLERS
  if (Number(ctx.from.id) === adminId) {
    if (state.step === 'SCRIPT_SET_INFO') {
      const parts = ctx.message.text.split('|');
      if (parts.length !== 2) return safeClearAndSend(ctx, '⚠️ Format salah! Gunakan: Nama|Harga');
      const name = parts[0].trim();
      const price = parseInt(parts[1].trim());
      if (isNaN(price)) return safeClearAndSend(ctx, '⚠️ Harga harus angka!');
      db.get(`SELECT id FROM bot_scripts WHERE id = 1`, (err, row) => {
        if (!row) db.run(`INSERT INTO bot_scripts (id, name, price, stock) VALUES (1, ?, ?, 0)`, [name, price]);
        else db.run(`UPDATE bot_scripts SET name = ?, price = ? WHERE id = 1`, [name, price]);
        delete userState[adminId];
        safeClearAndSend(ctx, '✅ Script info diupdate!');
      });
      return;
    }
    if (state.step === 'SCRIPT_SET_TEXT') {
      db.run(`UPDATE bot_scripts SET instruction_text = ? WHERE id = 1`, [ctx.message.text.trim()]);
      delete userState[adminId];
      safeClearAndSend(ctx, '✅ Teks instruksi diupdate!');
      return;
    }
    if (state.step === 'SCRIPT_ADD_STOCK') {
      const stock = parseInt(ctx.message.text.trim());
      if (isNaN(stock) || stock <= 0) return safeClearAndSend(ctx, '⚠️ Angka tidak valid!');
      db.get(`SELECT id FROM bot_scripts WHERE id = 1`, (err, row) => {
        if (!row) return safeClearAndSend(ctx, '⚠️ Script belum di-setting.');
        db.run(`UPDATE bot_scripts SET stock = stock + ? WHERE id = 1`, [stock]);
        delete userState[adminId];
        safeClearAndSend(ctx, `✅ Stok ditambah ${stock}!`);
      });
      return;
    }

    if (state.step === 'ADMIN_MANAGE_USER_ID') {
      const targetId = ctx.message.text.trim().replace(/[^0-9]/g, '');
      delete userState[adminId];
      if (!targetId) return safeClearAndSend(ctx, '⚠️ ID tidak valid.');
      showUserManageCard(ctx, targetId);
    } else if (state.step === 'ADMIN_ADD_SALDO_AMOUNT') {
      const amount = parseInt(ctx.message.text.trim().replace(/\D/g, ''));
      const targetId = state.targetId;
      if (!amount || amount <= 0) return safeClearAndSend(ctx, '⚠️ Angka tidak valid!');
      delete userState[adminId];
      db.run(`UPDATE users SET balance = COALESCE(balance, 0) + ? WHERE user_id = ?`, [amount, targetId], () => {
        safeClearAndSend(ctx, `✅ Saldo \`${targetId}\` ditambah Rp${amount.toLocaleString('id-ID')}.`, { parse_mode: 'Markdown' });
        bot.telegram.sendMessage(targetId, `💰 *SALDO BERTAMBAH*\n\nAdmin menambahkan Rp${amount.toLocaleString('id-ID')}.`, { parse_mode: 'Markdown' }).catch(() => {});
        showUserManageCard(ctx, targetId);
      });
    } else if (state.step === 'ADMIN_SUB_SALDO_AMOUNT') {
      const amount = parseInt(ctx.message.text.trim().replace(/\D/g, ''));
      const targetId = state.targetId;
      if (!amount || amount <= 0) return safeClearAndSend(ctx, '⚠️ Angka tidak valid!');
      delete userState[adminId];
      db.run(`UPDATE users SET balance = MAX(0, COALESCE(balance, 0) - ?) WHERE user_id = ?`, [amount, targetId], () => {
        safeClearAndSend(ctx, `✅ Saldo \`${targetId}\` dikurangi Rp${amount.toLocaleString('id-ID')}.`, { parse_mode: 'Markdown' });
        bot.telegram.sendMessage(targetId, `⚠️ *SALDO DIKURANGI*\n\nAdmin mengurangi Rp${amount.toLocaleString('id-ID')}.`, { parse_mode: 'Markdown' }).catch(() => {});
        showUserManageCard(ctx, targetId);
      });
    } else if (state.step === 'EDIT_STORE_NAME') {
      userState[adminId] = { step: 'EDIT_STORE_DESC', name: ctx.message.text.trim() };
      safeClearAndSend(ctx, 'Masukkan Deskripsi Toko:');
    } else if (state.step === 'EDIT_STORE_DESC') {
      db.run(`UPDATE store SET name = ?, desc = ? WHERE id = 1`, [state.name, ctx.message.text.trim()]);
      delete userState[adminId];
      safeClearAndSend(ctx, '✅ Info Toko diperbarui!');
    } else if (state.step === 'SET_WELCOME_MSG') {
      db.run(`UPDATE store SET welcome_msg = ? WHERE id = 1`, [ctx.message.text.trim()]);
      delete userState[adminId];
      safeClearAndSend(ctx, '✅ Welcome diperbarui!');
    } else if (state.step === 'SET_LEAVE_MSG') {
      db.run(`UPDATE store SET leave_msg = ? WHERE id = 1`, [ctx.message.text.trim()]);
      delete userState[adminId];
      safeClearAndSend(ctx, '✅ Leave diperbarui!');
    } else if (state.step === 'SET_ADMIN_UNAME') {
      db.run(`UPDATE store SET admin_uname = ? WHERE id = 1`, [ctx.message.text.trim()]);
      delete userState[adminId];
      safeClearAndSend(ctx, '✅ Username CS diperbarui!');
    } else if (state.step === 'SET_DANA_NUMBER') {
      db.run(`UPDATE store SET dana = ? WHERE id = 1`, [ctx.message.text.trim()]);
      delete userState[adminId];
      safeClearAndSend(ctx, '✅ Nomor DANA diperbarui!');
    } else if (state.step === 'SET_GOPAY_NUMBER') {
      db.run(`UPDATE store SET gopay = ? WHERE id = 1`, [ctx.message.text.trim()]);
      delete userState[adminId];
      safeClearAndSend(ctx, '✅ Nomor GoPay diperbarui!');
    } else if (state.step === 'SET_REQ_CHANNEL') {
      db.run(`UPDATE store SET required_channel = ? WHERE id = 1`, [ctx.message.text.trim()]);
      delete userState[adminId];
      safeClearAndSend(ctx, '✅ Channel diperbarui!');
    } else if (state.step === 'SET_LOG_GROUP') {
      db.run(`UPDATE store SET log_group_id = ? WHERE id = 1`, [ctx.message.text.trim()]);
      delete userState[adminId];
      safeClearAndSend(ctx, '✅ ID Grup Log diperbarui!');
    } else if (state.step === 'SET_REQ_GROUP') {
      db.run(`UPDATE store SET required_group = ? WHERE id = 1`, [ctx.message.text.trim()]);
      delete userState[adminId];
      safeClearAndSend(ctx, '✅ Link Grup diperbarui!');
    } else if (state.step === 'ADD_VOUCHER_CODE') {
      userState[adminId] = { step: 'ADD_VOUCHER_DISC', code: ctx.message.text.trim().toUpperCase() };
      safeClearAndSend(ctx, 'Masukkan Potongan Harga Voucher (angka):');
    } else if (state.step === 'ADD_VOUCHER_DISC') {
      const disc = parseInt(ctx.message.text.trim());
      userState[adminId] = { step: 'ADD_VOUCHER_QUOTA', code: state.code, disc };
      safeClearAndSend(ctx, 'Masukkan Kuota Voucher:');
    } else if (state.step === 'ADD_VOUCHER_QUOTA') {
      const quota = parseInt(ctx.message.text.trim());
      db.run(`INSERT OR REPLACE INTO vouchers (code, discount, quota) VALUES (?, ?, ?)`, [state.code, state.disc, quota]);
      delete userState[adminId];
      safeClearAndSend(ctx, '✅ Voucher dibuat!');
    } else if (state.step === 'ADD_AR_KEYWORD') {
      userState[adminId] = { step: 'ADD_AR_CONTENT', keyword: ctx.message.text.trim() };
      safeClearAndSend(ctx, 'Masukkan Balasan Auto-Reply:');
    } else if (state.step === 'ADD_AR_CONTENT') {
      db.run(`INSERT OR REPLACE INTO auto_reply (keyword, reply_type, content) VALUES (?, 'text', ?)`, [state.keyword, ctx.message.text.trim()]);
      delete userState[adminId];
      safeClearAndSend(ctx, '✅ Auto-Reply dibuat!');
    } else if (state.step === 'BROADCAST_TEXT') {
      const msgText = ctx.message.text.trim();
      delete userState[adminId];
      safeClearAndSend(ctx, '🚀 Mengirim Broadcast...');
      db.all(`SELECT user_id FROM visitors`, (err, rows) => {
        if (rows) rows.forEach(r => bot.telegram.sendMessage(r.user_id, msgText, { parse_mode: 'Markdown' }).catch(() => {}));
      });
    } else if (state.step === 'BC_BTN_TEXT') {
      userState[adminId] = { step: 'BC_BTN_LABEL', msgText: ctx.message.text.trim() };
      safeClearAndSend(ctx, 'Masukkan Label Tombol:');
    } else if (state.step === 'BC_BTN_LABEL') {
      userState[adminId] = { step: 'BC_BTN_URL', msgText: state.msgText, label: ctx.message.text.trim() };
      safeClearAndSend(ctx, 'Masukkan URL Tombol:');
    } else if (state.step === 'BC_BTN_URL') {
      const url = ctx.message.text.trim();
      const { msgText, label } = state;
      delete userState[adminId];
      safeClearAndSend(ctx, '🚀 Mengirim Broadcast Button...');
      db.all(`SELECT user_id FROM visitors`, (err, rows) => {
        if (rows) rows.forEach(r => bot.telegram.sendMessage(r.user_id, msgText, Markup.inlineKeyboard([[Markup.button.url(label, url)]])).catch(() => {}));
      });
    } else if (state.step === 'ADD_PROD_NAME') {
      userState[adminId] = { step: 'ADD_PROD_PRICE', name: ctx.message.text.trim() };
      safeClearAndSend(ctx, 'Masukkan Harga Produk (angka):');
    } else if (state.step === 'ADD_PROD_PRICE') {
      const price = parseInt(ctx.message.text.trim());
      if (isNaN(price)) return safeClearAndSend(ctx, '⚠️ Angka tidak valid!');
      userState[adminId] = { step: 'ADD_PROD_PHOTO', name: state.name, price };
      safeClearAndSend(ctx, '📸 Kirim foto produk (atau ketik *lewati*):', { parse_mode: 'Markdown' });
    } else if (state.step === 'ADD_PROD_PHOTO' && ctx.message.text.toLowerCase() === 'lewati') {
      db.run(`INSERT INTO products (name, price, photo) VALUES (?, ?, '')`, [state.name, state.price]);
      delete userState[adminId];
      safeClearAndSend(ctx, '✅ Produk ditambahkan tanpa foto!');
    } else if (state.step === 'ADD_STOCK_BULK') {
      const lines = ctx.message.text.split('\n').map(i => i.trim()).filter(i => i !== '');
      if (lines.length === 0) return safeClearAndSend(ctx, '⚠️ Tidak ada stok terdeteksi.');
      let inserted = 0;
      const stmt = db.prepare(`INSERT INTO stock_items (product_id, content) VALUES (?, ?)`);
      lines.forEach(item => { stmt.run(state.prodId, item); inserted++; });
      stmt.finalize();
      userState[adminId] = { step: 'ADD_STOCK_NOTE', prodId: state.prodId, inserted };
      safeClearAndSend(ctx, `✅ *${inserted} stok* ditambahkan!\n\n📝 Kirim *catatan/arahan* untuk pembeli (atau ketik *lewati*):`, { parse_mode: 'Markdown' });
    } else if (state.step === 'ADD_STOCK_NOTE') {
      const note = ctx.message.text.trim();
      if (note.toLowerCase() === 'lewati') {
        delete userState[adminId];
        return safeClearAndSend(ctx, `✅ *${state.inserted} stok* tersimpan. Catatan tidak diubah.`, { parse_mode: 'Markdown' });
      }
      db.run(`UPDATE products SET note = ? WHERE id = ?`, [note, state.prodId], (err) => {
        if (err) return safeClearAndSend(ctx, '⚠️ Gagal simpan catatan.');
        delete userState[adminId];
        safeClearAndSend(ctx, `✅ *${state.inserted} stok* tersimpan + catatan disimpan!`, { parse_mode: 'Markdown' });
      });
    }
  }
});

const setupCommandMenu = async () => {
  try {
    await bot.telegram.setMyCommands([
      { command: 'start', description: '🏠 Menu Utama' },
      { command: 'katalog', description: '🛒 Katalog Produk' },
      { command: 'pesanan', description: '📦 Riwayat Pesanan' },
      { command: 'referral', description: '🔗 Link Referral' },
      { command: 'cs', description: '📞 Customer Service' }
    ]);
    const adminId = getAdminId();
    if (adminId) {
      await bot.telegram.setMyCommands([
        { command: 'start', description: '🏠 Menu Utama' },
        { command: 'katalog', description: '🛒 Katalog Produk' },
        { command: 'pesanan', description: '📦 Riwayat Pesanan' },
        { command: 'referral', description: '🔗 Link Referral' },
        { command: 'cs', description: '📞 Customer Service' },
        { command: 'admin', description: '⚙️ Dashboard Admin' }
      ], { scope: { type: 'chat', chat_id: adminId } });
    }
  } catch (e) { console.log('Gagal set command menu:', e.message); }
};

const app = express();
app.post('/webhook/autokuy', express.raw({ type: '*/*' }), async (req, res) => {
  const secret = process.env.AUTOKUY_WEBHOOK_SECRET;
  const signature = req.headers['x-autokuy-signature'];
  const timestamp = req.headers['x-autokuy-timestamp'];
  const rawBody = req.body;
  if (!secret) return res.status(500).send('Webhook secret not configured');

  // Tolak timestamp yang kelewat lama (anti-replay), sesuai rekomendasi dokumentasi AutoKuy (>5 menit)
  const tsNumber = Number(timestamp);
  if (!tsNumber || Math.abs(Date.now() / 1000 - tsNumber) > 300) {
    return res.status(401).send('Invalid or expired timestamp');
  }
  if (!verifyAutoKuySignature(timestamp, rawBody, signature, secret)) return res.status(401).send('Invalid signature');

  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); } catch (e) { return res.status(400).send('Invalid JSON'); }
  res.status(200).send('OK'); // balas 2xx dulu secepatnya, baru proses (sesuai retry policy AutoKuy)

  const { event, event_id, invoice_id, amount, status } = payload;
  if (!event_id || !invoice_id) return;

  db.get(`SELECT transaction_id FROM casaku_webhook_log WHERE transaction_id = ?`, [event_id], async (err, existing) => {
    if (existing) return; // event ini sudah pernah diproses, anti-replay
    const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

    if (event === 'invoice.paid' && status === 'PAID') {
      let matchedType = null, matchedId = null;
      db.get(`SELECT id FROM script_orders WHERE status = 'PENDING' AND casaku_transaction_id = ? LIMIT 1`, [invoice_id], async (err, scriptOrder) => {
        if (scriptOrder) {
          const result = await approveScriptOrderById(scriptOrder.id);
          if (result.ok) { matchedType = 'script_order'; matchedId = scriptOrder.id; }
          return db.run(`INSERT OR IGNORE INTO casaku_webhook_log (transaction_id, matched_type, matched_id, amount, received_at) VALUES (?, ?, ?, ?, ?)`, [event_id, matchedType, matchedId, amount, now]);
        }
        db.get(`SELECT id FROM orders WHERE status = 'PENDING' AND casaku_transaction_id = ? LIMIT 1`, [invoice_id], async (err, order) => {
          if (order) {
            const result = await approveOrderById(order.id);
            if (result.ok) { matchedType = 'order'; matchedId = order.id; }
            return db.run(`INSERT OR IGNORE INTO casaku_webhook_log (transaction_id, matched_type, matched_id, amount, received_at) VALUES (?, ?, ?, ?, ?)`, [event_id, matchedType, matchedId, amount, now]);
          }
          db.get(`SELECT id FROM topups WHERE status = 'PENDING' AND casaku_transaction_id = ? LIMIT 1`, [invoice_id], async (err, topup) => {
            if (topup) {
              const result = await approveTopupById(topup.id);
              if (result.ok) { matchedType = 'topup'; matchedId = topup.id; }
            }
            db.run(`INSERT OR IGNORE INTO casaku_webhook_log (transaction_id, matched_type, matched_id, amount, received_at) VALUES (?, ?, ?, ?, ?)`, [event_id, matchedType, matchedId, amount, now]);
          });
        });
      });
    } else if (event === 'invoice.expired') {
      // Invoice kadaluarsa tanpa dibayar: tandai PENDING jadi EXPIRED biar tidak nyangkut
      db.run(`UPDATE script_orders SET status = 'EXPIRED' WHERE status = 'PENDING' AND casaku_transaction_id = ?`, [invoice_id]);
      db.run(`UPDATE orders SET status = 'EXPIRED' WHERE status = 'PENDING' AND casaku_transaction_id = ?`, [invoice_id]);
      db.run(`UPDATE topups SET status = 'EXPIRED' WHERE status = 'PENDING' AND casaku_transaction_id = ?`, [invoice_id]);
      db.run(`INSERT OR IGNORE INTO casaku_webhook_log (transaction_id, matched_type, matched_id, amount, received_at) VALUES (?, ?, ?, ?, ?)`, [event_id, 'expired', null, amount, now]);
    } else {
      db.run(`INSERT OR IGNORE INTO casaku_webhook_log (transaction_id, matched_type, matched_id, amount, received_at) VALUES (?, ?, ?, ?, ?)`, [event_id, 'ignored', null, amount, now]);
    }
  });
});

app.get('/', (req, res) => res.send('Bot is running.'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Webhook server listening on port ${PORT}`));
bot.launch().then(setupCommandMenu);
console.log('Bot Telegram Running Full Edition...');