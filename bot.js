require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const express = require('express');
const { verifyCasakuSignature, generateDynamicQRIS } = require('./casaku');
const bot = new Telegraf(process.env.BOT_TOKEN);

// === MULTI-ADMIN SUPPORT ===
const getAdminIds = () => {
  const raw = process.env.ADMIN_ID;
  if (!raw) return [];
  return String(raw).split(',').map(id => Number(id.trim().replace(/[^0-9]/g, ''))).filter(id => id > 0);
};
const getAdminId = () => getAdminIds()[0] || 0;
const isAdmin = (userId) => getAdminIds().includes(Number(userId));

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
  db.run(`CREATE TABLE IF NOT EXISTS users ( user_id INTEGER PRIMARY KEY, upline_id INTEGER DEFAULT 0, balance INTEGER DEFAULT 0, tier TEXT DEFAULT 'Bronze', last_checkin TEXT )`);
  db.run(`ALTER TABLE users ADD COLUMN balance INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN tier TEXT DEFAULT 'Bronze'`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN last_checkin TEXT`, () => {});
  db.run(`ALTER TABLE products ADD COLUMN note TEXT DEFAULT ''`, () => {});
  db.run(`CREATE TABLE IF NOT EXISTS visitors ( user_id INTEGER PRIMARY KEY, username TEXT, first_name TEXT, joined_at TEXT )`);
  db.run(`CREATE TABLE IF NOT EXISTS groups (group_id INTEGER PRIMARY KEY)`);
  db.run(`CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, price INTEGER, photo TEXT DEFAULT '', note TEXT DEFAULT '')`);
  db.run(`CREATE TABLE IF NOT EXISTS orders ( id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, username TEXT, product_id INTEGER, quantity INTEGER DEFAULT 1, status TEXT, proof TEXT, discount INTEGER DEFAULT 0, amount INTEGER DEFAULT 0, created_at TEXT, casaku_transaction_id TEXT, qris_expires_at TEXT )`);
  db.run(`ALTER TABLE orders ADD COLUMN quantity INTEGER DEFAULT 1`, () => {});
  db.run(`ALTER TABLE orders ADD COLUMN casaku_transaction_id TEXT`, () => {});
  db.run(`ALTER TABLE orders ADD COLUMN qris_expires_at TEXT`, () => {});
  db.run(`CREATE TABLE IF NOT EXISTS stock_items (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER, content TEXT, status TEXT DEFAULT 'AVAILABLE')`);
  db.run(`CREATE TABLE IF NOT EXISTS vouchers (code TEXT PRIMARY KEY, discount INTEGER, quota INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS topups ( id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, username TEXT, amount INTEGER, unique_code INTEGER, total_amount INTEGER, status TEXT DEFAULT 'PENDING', proof TEXT, created_at TEXT, casaku_transaction_id TEXT, qris_expires_at TEXT )`);
  db.run(`ALTER TABLE topups ADD COLUMN casaku_transaction_id TEXT`, () => {});
  db.run(`ALTER TABLE topups ADD COLUMN qris_expires_at TEXT`, () => {});
  db.run(`CREATE TABLE IF NOT EXISTS auto_reply ( keyword TEXT PRIMARY KEY, reply_type TEXT DEFAULT 'text', content TEXT, file_id TEXT, btn_label TEXT, btn_url TEXT )`);
  db.run(`CREATE TABLE IF NOT EXISTS chat_relay ( admin_msg_id INTEGER PRIMARY KEY, buyer_id INTEGER, buyer_name TEXT )`);
  db.run(`CREATE TABLE IF NOT EXISTS casaku_webhook_log ( transaction_id TEXT PRIMARY KEY, matched_type TEXT, matched_id INTEGER, amount INTEGER, received_at TEXT )`);
  db.run(`CREATE TABLE IF NOT EXISTS vpn_subscriptions ( id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, username TEXT, server_name TEXT, expired_at TEXT, status TEXT DEFAULT 'ACTIVE' )`);
  db.run(`CREATE TABLE IF NOT EXISTS bot_scripts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, price INTEGER, zip_file_id TEXT, video_file_id TEXT, instruction_text TEXT, stock INTEGER DEFAULT 0)`);
  db.run(`CREATE TABLE IF NOT EXISTS script_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, username TEXT, script_id INTEGER, amount INTEGER, status TEXT DEFAULT 'PENDING', proof TEXT, casaku_transaction_id TEXT, qris_expires_at TEXT, created_at TEXT)`);

  // === TABEL BARU UNTUK 9 FITUR ===
  db.run(`CREATE TABLE IF NOT EXISTS withdrawals ( id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, username TEXT, amount INTEGER, method TEXT, account_number TEXT, status TEXT DEFAULT 'PENDING', created_at TEXT )`);
  db.run(`CREATE TABLE IF NOT EXISTS lucky_spins ( id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, prize TEXT, amount_won INTEGER, created_at TEXT )`);
  db.run(`CREATE TABLE IF NOT EXISTS product_requests ( id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, username TEXT, product_name TEXT, description TEXT, status TEXT DEFAULT 'PENDING', created_at TEXT )`);
  db.run(`CREATE TABLE IF NOT EXISTS admin_logs ( id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER, admin_name TEXT, action TEXT, details TEXT, created_at TEXT )`);
  db.run(`CREATE TABLE IF NOT EXISTS reviews ( id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, user_id INTEGER, rating INTEGER, comment TEXT, created_at TEXT )`);

  db.get(`SELECT * FROM store WHERE id = 1`, (err, row) => {
    if (!row) {
      db.run(`INSERT INTO store (id, name, desc, photo, qris, dana, gopay, admin_uname, required_channel, log_group_id, welcome_msg, leave_msg) VALUES (1, '🛍️ TOKO DIGITAL PREMIUM', 'Selamat datang di toko kami!', '', '', '', '', '', '', '', 'Selamat datang {user} di grup kami! 🎉', 'Sampai jumpa {user} 👋')`);
    }
  });
});

const userState = {};

// === HELPER LOG ADMIN ===
const logAdminAction = (adminId, action, details) => {
  const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const adminName = adminId === getAdminId() ? 'Owner' : `Admin ${adminId}`;
  db.run(`INSERT INTO admin_logs (admin_id, admin_name, action, details, created_at) VALUES (?, ?, ?, ?, ?)`, [adminId, adminName, action, details, now]);
};

// MIDDLEWARE WAJIB JOIN CHANNEL
const checkForceJoin = async (ctx, next) => {
  if (ctx.chat && ctx.chat.type !== 'private') return next();
  const userId = ctx.from.id;
  if (isAdmin(userId)) return next();
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

const safeClearAndSend = async (ctx, text, extra = {}) => {
  try { await ctx.deleteMessage(); } catch (e) {}
  if (extra.photo) {
    return await ctx.replyWithPhoto(extra.photo, { caption: text, parse_mode: 'Markdown', ...extra });
  } else {
    return await ctx.replyWithMarkdown(text, extra);
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

const getUserInfoLine = (ctx, cb) => {
  const userId = ctx.from.id;
  const username = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'Buyer');
  db.get(`SELECT balance, tier FROM users WHERE user_id = ?`, [userId], (err, row) => {
    const tier = row ? (row.tier || 'Bronze') : 'Bronze';
    let balanceDisplay = 'Rp0';
    if (tier === 'Owner' || isAdmin(userId)) balanceDisplay = '∞ (Unlimited)';
    else if (row) balanceDisplay = `Rp${(row.balance || 0).toLocaleString('id-ID')}`;
    const card = `✨ *INFORMASI BUYER*\n👤 *Username:* ${username}\n🆔 *ID Telegram:* \`${userId}\`\n💳 *Saldo:* ${balanceDisplay}\n🏷️ *Tier Status:* *${tier}*`;
    cb(card);
  });
};

const deliverScript = async (ctx, script) => {
  try {
    if (script.instruction_text) await ctx.replyWithMarkdown(`📝 *INSTRUKSI PEMBELIAN SCRIPT*\n\n${script.instruction_text}`);
    if (script.video_file_id) await ctx.replyWithVideo(script.video_file_id, { caption: '🎥 Video Tutorial Script Bot' });
    if (script.zip_file_id) await ctx.replyWithDocument(script.zip_file_id, { caption: '📂 File Source Code (ZIP)' });
    await ctx.reply('✅ Terima kasih! Script telah dikirim.', Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu Utama', 'main_menu')]]));
  } catch (e) {
    ctx.reply('⚠️ Gagal mengirim beberapa file script. Hubungi admin.');
  }
};

const deliverScriptById = async (userId, script) => {
  try {
    if (script.instruction_text) await bot.telegram.sendMessage(userId, `📝 *INSTRUKSI PEMBELIAN SCRIPT*\n\n${script.instruction_text}`, { parse_mode: 'Markdown' });
    if (script.video_file_id) await bot.telegram.sendVideo(userId, script.video_file_id, { caption: '🎥 Video Tutorial Script Bot' });
    if (script.zip_file_id) await bot.telegram.sendDocument(userId, script.zip_file_id, { caption: '📂 File Source Code (ZIP)' });
  } catch (e) { console.error('Gagal deliver script:', e.message); }
};

// MENU UTAMA (DENGAN 9 FITUR BARU)
const getMainMenu = (userId) => {
  const adminId = getAdminId();
  const buttons = [
    [Markup.button.callback('🛒 Katalog Produk', 'user_catalog'), Markup.button.callback('🔍 Cari Produk', 'user_search_prod')],
    [Markup.button.callback('🌐 Layanan VPN', 'user_vpn_menu'), Markup.button.callback('💳 Saldo & Top Up', 'user_balance_menu')],
    [Markup.button.callback('📦 Cek Pesanan', 'user_my_orders'), Markup.button.callback('📊 Cek Stok Live', 'user_live_stock')],
    [Markup.button.callback('🔗 Program Referral', 'user_referral'), Markup.button.callback('📖 Cara Belanja', 'user_faq')],
    [Markup.button.callback('📞 Customer Service', 'user_contact'), Markup.button.callback('🆔 Cek ID', 'user_check_id')],
    [Markup.button.callback('🤖 Beli Script Bot', 'user_script_menu'), Markup.button.callback('📝 Request Produk', 'user_request_product')],
    [Markup.button.callback('🎰 Lucky Spin', 'user_lucky_spin'), Markup.button.callback('📅 Absen Harian', 'user_daily_checkin')],
    [Markup.button.callback('🏆 Leaderboard', 'user_leaderboard'), Markup.button.callback('💸 Tarik Saldo', 'user_withdraw')],
    [Markup.button.callback('🎵 Lagu', 'user_lagu')]
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
    [Markup.button.callback('🖼️ Ganti Foto Header', 'admin_set_header_photo'), Markup.button.callback('🧾 Set Foto QRIS', 'admin_set_qris_photo')],
    [Markup.button.callback('👋 Set Welcome Msg', 'admin_set_welcome'), Markup.button.callback('👋 Set Leave Msg', 'admin_set_leave')],
    [Markup.button.callback('🎵 Set Lagu', 'admin_set_song'), Markup.button.callback('🤖 Atur Auto-Reply', 'admin_autoreply_type')],
    [Markup.button.callback('🗑️ Hapus Auto-Reply', 'admin_del_autoreply'), Markup.button.callback('👤 Set Admin Uname', 'admin_set_uname')],
    [Markup.button.callback('🔒 Wajib Join Channel', 'admin_set_channel'), Markup.button.callback('👥 Wajib Join Grup', 'admin_set_req_group')],
    [Markup.button.callback('📢 Grup Log/Testi', 'admin_set_log_group')],
    [Markup.button.callback('🎁 Buat Voucher', 'admin_add_voucher'), Markup.button.callback('🗑️ Hapus Voucher', 'admin_del_voucher')],
    [Markup.button.callback('👤 Kelola Saldo/Tier User', 'admin_manage_user')],
    [Markup.button.callback('📢 Broadcast Chat', 'admin_broadcast_menu'), Markup.button.callback('🔗 Broadcast + Button', 'admin_bc_button')],
    [Markup.button.callback('📦 Jual Script Bot', 'admin_script_menu')],
    [Markup.button.callback('💸 Kelola Withdraw', 'admin_withdraw_menu')],
    [Markup.button.callback('📝 Request Produk', 'admin_request_menu')],
    [Markup.button.callback('📜 Log Aktivitas Admin', 'admin_logs')],
    [Markup.button.callback('📊 Laporan Keuangan', 'admin_financial_report')],
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

bot.start(async (ctx) => {
  saveUserAndVisitor(ctx);
  db.get(`SELECT * FROM store WHERE id = 1`, (err, store) => {
    getUserInfoLine(ctx, (infoLine) => {
      const text = `🏬 *${store.name}*\n\n${store.desc}\n\n━━━━━━━━━━━━━━━━━━━\n${infoLine}\n━━━━━━━━━━━━━━━━━━━`;
      if (store && store.photo) ctx.replyWithPhoto(store.photo, { caption: text, parse_mode: 'Markdown', ...getStartMenu(store) });
      else ctx.replyWithMarkdown(text, getStartMenu(store));
    });
  });
});

bot.action('main_menu', async (ctx) => {
  db.get(`SELECT * FROM store WHERE id = 1`, async (err, store) => {
    getUserInfoLine(ctx, async (infoLine) => {
      const text = `🏬 *${store.name}*\n\n${store.desc}\n\n━━━━━━━━━━━━━━━━━━━\n${infoLine}\n━━━━━━━━━━━━━━━━━━━`;
      if (store && store.photo) await safeClearAndSend(ctx, text, { photo: store.photo, ...getMainMenu(ctx.from.id) });
      else await safeClearAndSend(ctx, text, getMainMenu(ctx.from.id));
    });
  });
});

// === FITUR 1: ABSEN HARIAN ===
bot.action('user_daily_checkin', async (ctx) => {
  ctx.answerCbQuery();
  const userId = ctx.from.id;
  const today = new Date().toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' });
  
  db.get(`SELECT last_checkin FROM users WHERE user_id = ?`, [userId], (err, row) => {
    if (row && row.last_checkin === today) {
      return safeClearAndSend(ctx, `📅 *ABSEN HARIAN*\n\nAnda sudah absen hari ini!\nKembali lagi besok untuk bonus saldo.`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu Utama', 'main_menu')]]));
    }
    
    const bonus = Math.floor(Math.random() * 500) + 100;
    db.run(`UPDATE users SET balance = balance + ?, last_checkin = ? WHERE user_id = ?`, [bonus, today, userId]);
    
    safeClearAndSend(ctx, `🎉 *ABSEN BERHASIL!*\n\nAnda mendapatkan bonus saldo *Rp${bonus.toLocaleString('id-ID')}*!\nKembali lagi besok ya!`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu Utama', 'main_menu')]]));
  });
});

// === FITUR 2: LUCKY SPIN ===
bot.action('user_lucky_spin', async (ctx) => {
  ctx.answerCbQuery();
  const userId = ctx.from.id;
  const spinCost = 2000;
  
  db.get(`SELECT balance, tier FROM users WHERE user_id = ?`, [userId], (err, row) => {
    const tier = row ? row.tier : 'Bronze';
    const balance = row ? row.balance : 0;
    
    if (tier !== 'Owner' && !isAdmin(userId) && balance < spinCost) {
      return safeClearAndSend(ctx, `🎰 *LUCKY SPIN*\n\n⚠️ Saldo tidak cukup!\nBiaya spin: Rp${spinCost.toLocaleString('id-ID')}\nSaldo Anda: Rp${balance.toLocaleString('id-ID')}`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu Utama', 'main_menu')]]));
    }
    
    if (tier !== 'Owner' && !isAdmin(userId)) {
      db.run(`UPDATE users SET balance = balance - ? WHERE user_id = ?`, [spinCost, userId]);
    }
    
    const prizes = [
      { prize: '💸 Saldo Rp500', amount: 500, weight: 40 },
      { prize: '💰 Saldo Rp1.000', amount: 1000, weight: 30 },
      { prize: '🎁 Saldo Rp2.500', amount: 2500, weight: 15 },
      { prize: '🏆 Saldo Rp5.000', amount: 5000, weight: 10 },
      { prize: '💎 Saldo Rp10.000', amount: 10000, weight: 5 }
    ];
    
    const totalWeight = prizes.reduce((sum, p) => sum + p.weight, 0);
    const random = Math.random() * totalWeight;
    let cumulative = 0;
    let selectedPrize = prizes[0];
    
    for (const p of prizes) {
      cumulative += p.weight;
      if (random <= cumulative) {
        selectedPrize = p;
        break;
      }
    }
    
    db.run(`UPDATE users SET balance = balance + ? WHERE user_id = ?`, [selectedPrize.amount, userId]);
    db.run(`INSERT INTO lucky_spins (user_id, prize, amount_won, created_at) VALUES (?, ?, ?, ?)`, 
      [userId, selectedPrize.prize, selectedPrize.amount, new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })]);
    
    safeClearAndSend(ctx, `🎰 *LUCKY SPIN RESULT*\n\n🎊 Selamat! Anda mendapatkan:\n*${selectedPrize.prize}*\n\nSaldo telah ditambahkan!`, Markup.inlineKeyboard([[Markup.button.callback('🎰 Spin Lagi (Rp2.000)', 'user_lucky_spin')], [Markup.button.callback('🔙 Menu Utama', 'main_menu')]]));
  });
});

// === FITUR 3: LEADERBOARD ===
bot.action('user_leaderboard', async (ctx) => {
  ctx.answerCbQuery();
  
  db.all(`SELECT u.user_id, COUNT(d.user_id) as total_downline FROM users u LEFT JOIN users d ON u.user_id = d.upline_id GROUP BY u.user_id ORDER BY total_downline DESC LIMIT 5`, (err, refRows) => {
    db.all(`SELECT user_id, username, SUM(amount) as total_spent FROM orders WHERE status = 'APPROVED' GROUP BY user_id ORDER BY total_spent DESC LIMIT 5`, (err, buyerRows) => {
      let text = `🏆 *LEADERBOARD BULANAN*\n\n`;
      
      text += `🔗 *TOP REFERRAL:*\n`;
      if (refRows && refRows.length > 0) {
        refRows.forEach((r, i) => {
          text += `${i + 1}. \`${r.user_id}\` - ${r.total_downline} downline\n`;
        });
      } else {
        text += `Belum ada data\n`;
      }
      
      text += `\n💰 *TOP BUYER:*\n`;
      if (buyerRows && buyerRows.length > 0) {
        buyerRows.forEach((r, i) => {
          text += `${i + 1}. ${r.username || `\`${r.user_id}\``} - Rp${r.total_spent.toLocaleString('id-ID')}\n`;
        });
      } else {
        text += `Belum ada data\n`;
      }
      
      safeClearAndSend(ctx, text, Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu Utama', 'main_menu')]]));
    });
  });
});

// === FITUR 4: REQUEST PRODUK ===
bot.action('user_request_product', async (ctx) => {
  ctx.answerCbQuery();
  userState[ctx.from.id] = { step: 'REQUEST_PRODUCT_NAME' };
  safeClearAndSend(ctx, `📝 *REQUEST PRODUK*\n\nKetik nama produk yang ingin Anda request:`, Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', 'main_menu')]]));
});

// === FITUR 5: WITHDRAW ===
bot.action('user_withdraw', async (ctx) => {
  ctx.answerCbQuery();
  const userId = ctx.from.id;
  
  db.get(`SELECT balance, tier FROM users WHERE user_id = ?`, [userId], (err, row) => {
    const tier = row ? row.tier : 'Bronze';
    const balance = row ? row.balance : 0;
    const minWithdraw = 10000;
    
    if (tier !== 'Owner' && !isAdmin(userId) && balance < minWithdraw) {
      return safeClearAndSend(ctx, `💸 *TARIK SALDO*\n\n⚠️ Saldo tidak cukup!\nMinimal withdraw: Rp${minWithdraw.toLocaleString('id-ID')}\nSaldo Anda: Rp${balance.toLocaleString('id-ID')}`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu Utama', 'main_menu')]]));
    }
    
    userState[userId] = { step: 'WITHDRAW_AMOUNT' };
    safeClearAndSend(ctx, `💸 *TARIK SALDO*\n\n💰 Saldo Anda: Rp${balance.toLocaleString('id-ID')}\n💵 Minimal withdraw: Rp${minWithdraw.toLocaleString('id-ID')}\n\nMasukkan nominal yang ingin ditarik:`, Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', 'main_menu')]]));
  });
});

// === HANDLER VPN (EXISTING) ===
bot.action('user_vpn_menu', async (ctx) => {
  ctx.answerCbQuery();
  const text = `🌐 *LAYANAN NADIA VPN*\n\nNikmati koneksi internet cepat, aman, dan tanpa batas.\n\nSilakan pilih menu di bawah ini:`;
  await safeClearAndSend(ctx, text, Markup.inlineKeyboard([
    [Markup.button.callback('📦 Beli / Buat Akun VPN', 'vpn_buy_list')],
    [Markup.button.callback('👤 Status VPN Saya', 'vpn_my_status')],
    [Markup.button.callback('🔙 Menu Utama', 'main_menu')]
  ]));
});
bot.action('vpn_buy_list', async (ctx) => {
  ctx.answerCbQuery();
  await safeClearAndSend(ctx, `🌐 *PEMBELIAN VPN*\n\nSilakan pilih melalui katalog produk utama atau hubungi admin.`, Markup.inlineKeyboard([
    [Markup.button.callback('🛒 Ke Katalog Produk', 'user_catalog')],
    [Markup.button.callback('🔙 Kembali', 'user_vpn_menu')]
  ]));
});
bot.action('vpn_my_status', async (ctx) => {
  ctx.answerCbQuery();
  const userId = ctx.from.id;
  db.all(`SELECT * FROM vpn_subscriptions WHERE user_id = ? AND status = 'ACTIVE'`, [userId], async (err, rows) => {
    if (!rows || rows.length === 0) {
      return await safeClearAndSend(ctx, `👤 *STATUS VPN ANDA*\n\nAnda belum memiliki langganan VPN aktif.`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali', 'user_vpn_menu')]]));
    }
    let text = `👤 *STATUS VPN AKTIF ANDA:*\n\n`;
    rows.forEach(r => { text += `• *Server:* ${r.server_name}\n Berakhir: ${r.expired_at}\n\n`; });
    await safeClearAndSend(ctx, text, Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali', 'user_vpn_menu')]]));
  });
});

// === HANDLER SCRIPT BOT (EXISTING) ===
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
      [Markup.button.callback('💳 Bayar via QRIS', `script_pay_qris_1`)],
      [Markup.button.callback('💰 Bayar Pakai Saldo', `script_pay_saldo_1`)],
      [Markup.button.callback('🔙 Menu Utama', 'main_menu')]
    ];
    safeClearAndSend(ctx, text, Markup.inlineKeyboard(buttons));
  });
});

bot.action(/^script_pay_saldo_(.+)$/, async (ctx) => {
  const scriptId = ctx.match[1];
  const userId = ctx.from.id;
  db.get(`SELECT * FROM bot_scripts WHERE id = ?`, [scriptId], (err, script) => {
    if (!script) return ctx.answerCbQuery('Script tidak ditemukan.', { show_alert: true });
    if (script.stock <= 0) return ctx.answerCbQuery('Stok habis!', { show_alert: true });
    db.get(`SELECT balance, tier FROM users WHERE user_id = ?`, [userId], (err, row) => {
      const tier = row ? row.tier : 'Bronze';
      const balance = row ? row.balance : 0;
      if (tier !== 'Owner' && !isAdmin(userId) && balance < script.price) {
        return ctx.answerCbQuery(`⚠️ Saldo tidak cukup!`, { show_alert: true });
      }
      if (tier !== 'Owner' && !isAdmin(userId)) {
        db.run(`UPDATE users SET balance = balance - ? WHERE user_id = ?`, [script.price, userId]);
      }
      db.run(`UPDATE bot_scripts SET stock = stock - 1 WHERE id = ?`, [scriptId]);
      const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
      const username = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'Buyer');
      db.run(`INSERT INTO script_orders (user_id, username, script_id, amount, status, created_at) VALUES (?, ?, ?, ?, 'APPROVED', ?)`,
        [userId, username, scriptId, script.price, now]);
      deliverScript(ctx, script);
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
      const qris = await generateDynamicQRIS(script.price, `SCR`);
      const now = new Date().toISOString();
      const username = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'Buyer');
      db.run(`INSERT INTO script_orders (user_id, username, script_id, amount, status, created_at, casaku_transaction_id, qris_expires_at) VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
        [userId, username, scriptId, script.price, now, qris.transactionId, qris.expiresAt], function (dbErr) {
          if (dbErr) return ctx.reply('⚠️ Gagal membuat pesanan.');
          const orderId = this.lastID;
          const detailText = `🧾 *PESANAN SCRIPT #${orderId}*\n\n📦 *Script:* ${script.name}\n💰 *Total Bayar:* *Rp${qris.totalAmount.toLocaleString('id-ID')}*\n🧾 *Transaksi:* \`${qris.transactionId}\`\n⏳ *Berlaku sampai:* ${new Date(qris.expiresAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\n\n📲 Scan QRIS dinamis.`;
          safeClearAndSend(ctx, detailText, {
            photo: { source: qris.imageBuffer },
            ...Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', 'user_script_menu')]])
          });
        });
    } catch (e) {
      return ctx.answerCbQuery(`⚠️ Gagal membuat QRIS: ${e.message}`, { show_alert: true });
    }
  });
});

bot.action('admin_script_menu', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
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
  if (!isAdmin(ctx.from.id)) return;
  userState[getAdminId()] = { step: 'SCRIPT_SET_INFO' };
  ctx.reply('Masukkan Nama dan Harga Script (Format: `Nama|Harga`)\nContoh: `Bot Toko Premium|50000`', { parse_mode: 'Markdown' });
});
bot.action('admin_script_upload_zip', (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  userState[getAdminId()] = { step: 'SCRIPT_UPLOAD_ZIP' };
  ctx.reply('Kirimkan File ZIP Script Bot:');
});
bot.action('admin_script_upload_video', (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  userState[getAdminId()] = { step: 'SCRIPT_UPLOAD_VIDEO' };
  ctx.reply('Kirimkan Video Tutorial Script Bot:');
});
bot.action('admin_script_set_text', (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  userState[getAdminId()] = { step: 'SCRIPT_SET_TEXT' };
  ctx.reply('Kirimkan Teks Instruksi:');
});
bot.action('admin_script_add_stock', (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  userState[getAdminId()] = { step: 'SCRIPT_ADD_STOCK' };
  ctx.reply('Masukkan jumlah stok:');
});
bot.action('admin_script_delete', (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  db.run(`DELETE FROM bot_scripts WHERE id = 1`);
  logAdminAction(ctx.from.id, 'DELETE_SCRIPT', 'Hapus script bot');
  ctx.answerCbQuery('✅ Script dihapus!', { show_alert: true });
});

bot.on('document', async (ctx) => {
  const userId = ctx.from.id;
  if (isAdmin(userId) && userState[getAdminId()]) {
    if (userState[getAdminId()].step === 'SCRIPT_UPLOAD_ZIP') {
      const fileId = ctx.message.document.file_id;
      db.get(`SELECT id FROM bot_scripts WHERE id = 1`, (err, row) => {
        if (!row) db.run(`INSERT INTO bot_scripts (id, name, price, stock) VALUES (1, 'Script Bot', 0, 0)`, () => {
          db.run(`UPDATE bot_scripts SET zip_file_id = ? WHERE id = 1`, [fileId]);
        });
        else db.run(`UPDATE bot_scripts SET zip_file_id = ? WHERE id = 1`, [fileId]);
        delete userState[getAdminId()];
        logAdminAction(userId, 'UPLOAD_SCRIPT_ZIP', `File ID: ${fileId}`);
        ctx.reply('✅ File ZIP diupload!');
      });
      return;
    }
  }
});

bot.on('video', async (ctx) => {
  const userId = ctx.from.id;
  if (isAdmin(userId) && userState[getAdminId()]) {
    if (userState[getAdminId()].step === 'SCRIPT_UPLOAD_VIDEO') {
      const fileId = ctx.message.video.file_id;
      db.get(`SELECT id FROM bot_scripts WHERE id = 1`, (err, row) => {
        if (!row) db.run(`INSERT INTO bot_scripts (id, name, price, stock) VALUES (1, 'Script Bot', 0, 0)`, () => {
          db.run(`UPDATE bot_scripts SET video_file_id = ? WHERE id = 1`, [fileId]);
        });
        else db.run(`UPDATE bot_scripts SET video_file_id = ? WHERE id = 1`, [fileId]);
        delete userState[getAdminId()];
        logAdminAction(userId, 'UPLOAD_SCRIPT_VIDEO', `File ID: ${fileId}`);
        ctx.reply('✅ Video diupload!');
      });
      return;
    }
  }
});

// === ADMIN: WITHDRAW MENU (FITUR 6) ===
bot.action('admin_withdraw_menu', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  db.all(`SELECT * FROM withdrawals WHERE status = 'PENDING' ORDER BY id DESC LIMIT 10`, (err, rows) => {
    if (!rows || rows.length === 0) {
      return safeClearAndSend(ctx, `💸 *KELOLA WITHDRAW*\n\nTidak ada request withdraw pending.`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Dashboard Admin', 'admin_dashboard')]]));
    }
    let text = `💸 *REQUEST WITHDRAW PENDING*\n\n`;
    let buttons = [];
    rows.forEach(r => {
      text += `#${r.id} - ${r.username} - Rp${r.amount.toLocaleString('id-ID')} (${r.method})\n`;
      buttons.push([Markup.button.callback(`✅ Approve #${r.id}`, `approve_withdraw_${r.id}`), Markup.button.callback(`❌ Reject #${r.id}`, `reject_withdraw_${r.id}`)]);
    });
    buttons.push([Markup.button.callback('🔙 Dashboard Admin', 'admin_dashboard')]);
    safeClearAndSend(ctx, text, Markup.inlineKeyboard(buttons));
  });
});

bot.action(/^approve_withdraw_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const withdrawId = ctx.match[1];
  db.get(`SELECT * FROM withdrawals WHERE id = ?`, [withdrawId], (err, withdraw) => {
    if (!withdraw) return ctx.answerCbQuery('Tidak ditemukan.', { show_alert: true });
    db.run(`UPDATE withdrawals SET status = 'APPROVED' WHERE id = ?`, [withdrawId]);
    bot.telegram.sendMessage(withdraw.user_id, `✅ *WITHDRAW DISETUJUI*\n\nRequest withdraw Rp${withdraw.amount.toLocaleString('id-ID')} telah disetujui.\n\nMetode: ${withdraw.method}\nNo. Rekening: ${withdraw.account_number}`, { parse_mode: 'Markdown' }).catch(() => {});
    logAdminAction(ctx.from.id, 'APPROVE_WITHDRAW', `ID: ${withdrawId}, Amount: ${withdraw.amount}`);
    ctx.answerCbQuery('✅ Withdraw di-approve!', { show_alert: true });
    ctx.editMessageText(`✅ APPROVED - Withdraw #${withdrawId}`).catch(() => {});
  });
});

bot.action(/^reject_withdraw_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const withdrawId = ctx.match[1];
  db.get(`SELECT * FROM withdrawals WHERE id = ?`, [withdrawId], (err, withdraw) => {
    if (!withdraw) return ctx.answerCbQuery('Tidak ditemukan.', { show_alert: true });
    db.run(`UPDATE withdrawals SET status = 'REJECTED' WHERE id = ?`, [withdrawId]);
    db.run(`UPDATE users SET balance = balance + ? WHERE user_id = ?`, [withdraw.amount, withdraw.user_id]);
    bot.telegram.sendMessage(withdraw.user_id, `❌ *WITHDRAW DITOLAK*\n\nRequest withdraw #${withdrawId} ditolak.\nSaldo Rp${withdraw.amount.toLocaleString('id-ID')} telah dikembalikan.`, { parse_mode: 'Markdown' }).catch(() => {});
    logAdminAction(ctx.from.id, 'REJECT_WITHDRAW', `ID: ${withdrawId}, Amount: ${withdraw.amount}`);
    ctx.answerCbQuery('Withdraw ditolak.', { show_alert: true });
    ctx.editMessageText(`❌ REJECTED - Withdraw #${withdrawId}`).catch(() => {});
  });
});

// === ADMIN: REQUEST PRODUK MENU (FITUR 7) ===
bot.action('admin_request_menu', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  db.all(`SELECT * FROM product_requests WHERE status = 'PENDING' ORDER BY id DESC LIMIT 10`, (err, rows) => {
    if (!rows || rows.length === 0) {
      return safeClearAndSend(ctx, `📝 *REQUEST PRODUK*\n\nTidak ada request produk pending.`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Dashboard Admin', 'admin_dashboard')]]));
    }
    let text = `📝 *REQUEST PRODUK PENDING*\n\n`;
    let buttons = [];
    rows.forEach(r => {
      text += `#${r.id} - ${r.username}\nProduk: ${r.product_name}\n${r.description ? `Desc: ${r.description}\n` : ''}\n`;
      buttons.push([Markup.button.callback(`✅ Approve #${r.id}`, `approve_request_${r.id}`), Markup.button.callback(`❌ Reject #${r.id}`, `reject_request_${r.id}`)]);
    });
    buttons.push([Markup.button.callback('🔙 Dashboard Admin', 'admin_dashboard')]);
    safeClearAndSend(ctx, text, Markup.inlineKeyboard(buttons));
  });
});

bot.action(/^approve_request_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const requestId = ctx.match[1];
  db.run(`UPDATE product_requests SET status = 'APPROVED' WHERE id = ?`, [requestId]);
  logAdminAction(ctx.from.id, 'APPROVE_REQUEST', `ID: ${requestId}`);
  ctx.answerCbQuery('✅ Request di-approve!', { show_alert: true });
  ctx.editMessageText(`✅ APPROVED - Request #${requestId}`).catch(() => {});
});

bot.action(/^reject_request_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const requestId = ctx.match[1];
  db.run(`UPDATE product_requests SET status = 'REJECTED' WHERE id = ?`, [requestId]);
  logAdminAction(ctx.from.id, 'REJECT_REQUEST', `ID: ${requestId}`);
  ctx.answerCbQuery('Request ditolak.', { show_alert: true });
  ctx.editMessageText(`❌ REJECTED - Request #${requestId}`).catch(() => {});
});

// === ADMIN: LOG AKTIVITAS (FITUR 8) ===
bot.action('admin_logs', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  db.all(`SELECT * FROM admin_logs ORDER BY id DESC LIMIT 20`, (err, rows) => {
    if (!rows || rows.length === 0) {
      return safeClearAndSend(ctx, `📜 *LOG AKTIVITAS ADMIN*\n\nBelum ada log aktivitas.`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Dashboard Admin', 'admin_dashboard')]]));
    }
    let text = `📜 *LOG AKTIVITAS ADMIN (20 Terakhir)*\n\n`;
    rows.forEach(r => {
      text += `[${r.created_at}] *${r.admin_name}*\n${r.action}: ${r.details}\n\n`;
    });
    safeClearAndSend(ctx, text, Markup.inlineKeyboard([[Markup.button.callback('🔙 Dashboard Admin', 'admin_dashboard')]]));
  });
});

// === ADMIN: LAPORAN KEUANGAN (FITUR 9) ===
bot.action('admin_financial_report', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  
  const today = new Date().toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' });
  
  db.get(`SELECT SUM(amount) as total_sales FROM orders WHERE status = 'APPROVED' AND DATE(created_at) = DATE('now')`, (err, salesRow) => {
    db.get(`SELECT SUM(amount) as total_topup FROM topups WHERE status = 'APPROVED' AND DATE(created_at) = DATE('now')`, (err, topupRow) => {
      db.get(`SELECT SUM(amount) as total_withdraw FROM withdrawals WHERE status = 'APPROVED' AND DATE(created_at) = DATE('now')`, (err, withdrawRow) => {
        const totalSales = salesRow && salesRow.total_sales ? salesRow.total_sales : 0;
        const totalTopup = topupRow && topupRow.total_topup ? topupRow.total_topup : 0;
        const totalWithdraw = withdrawRow && withdrawRow.total_withdraw ? withdrawRow.total_withdraw : 0;
        const profit = totalSales + totalTopup - totalWithdraw;
        
        const text = `📊 *LAPORAN KEUANGAN HARI INI*\n\n` +
          `📅 Tanggal: ${today}\n\n` +
          `💰 Total Penjualan: Rp${totalSales.toLocaleString('id-ID')}\n` +
          `💳 Total Top Up: Rp${totalTopup.toLocaleString('id-ID')}\n` +
          `💸 Total Withdraw: Rp${totalWithdraw.toLocaleString('id-ID')}\n\n` +
          `━━━━━━━━━━━━━━━━━━━\n` +
          `📈 *Profit Bersih: Rp${profit.toLocaleString('id-ID')}*`;
        
        safeClearAndSend(ctx, text, Markup.inlineKeyboard([[Markup.button.callback('🔙 Dashboard Admin', 'admin_dashboard')]]));
      });
    });
  });
});

// Sisa handler existing (user_check_id, user_lagu, user_faq, dll) - tetap sama
// ... (kode existing lainnya tetap ada di file lu)

// Handler text untuk fitur baru
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const state = userState[userId];
  
  if (!state) return;
  
  // Request Product
  if (state.step === 'REQUEST_PRODUCT_NAME') {
    userState[userId] = { step: 'REQUEST_PRODUCT_DESC', productName: ctx.message.text.trim() };
    ctx.reply('Ketik deskripsi produk (atau ketik *lewati*):', { parse_mode: 'Markdown' });
    return;
  }
  
  if (state.step === 'REQUEST_PRODUCT_DESC') {
    const desc = ctx.message.text.trim().toLowerCase() === 'lewati' ? '' : ctx.message.text.trim();
    const username = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'User');
    db.run(`INSERT INTO product_requests (user_id, username, product_name, description, created_at) VALUES (?, ?, ?, ?, ?)`,
      [userId, username, state.productName, desc, new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })]);
    delete userState[userId];
    ctx.reply('✅ Request produk berhasil dikirim! Admin akan mereview.');
    return;
  }
  
  // Withdraw
  if (state.step === 'WITHDRAW_AMOUNT') {
    const amount = parseInt(ctx.message.text.trim().replace(/\D/g, ''));
    if (!amount || amount < 10000) return ctx.reply('⚠️ Minimal withdraw Rp10.000');
    userState[userId] = { step: 'WITHDRAW_METHOD', amount };
    ctx.reply('Pilih metode penarikan:\n1. Dana\n2. Gopay\n3. OVO\n\nKetik angka (1-3):');
    return;
  }
  
  if (state.step === 'WITHDRAW_METHOD') {
    const methodMap = { '1': 'Dana', '2': 'Gopay', '3': 'OVO' };
    const method = methodMap[ctx.message.text.trim()];
    if (!method) return ctx.reply('⚠️ Pilih 1-3');
    userState[userId] = { step: 'WITHDRAW_ACCOUNT', amount: state.amount, method };
    ctx.reply(`Masukkan nomor rekening ${method}:`);
    return;
  }
  
  if (state.step === 'WITHDRAW_ACCOUNT') {
    const accountNumber = ctx.message.text.trim();
    const username = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'User');
    
    db.get(`SELECT balance, tier FROM users WHERE user_id = ?`, [userId], (err, row) => {
      const tier = row ? row.tier : 'Bronze';
      const balance = row ? row.balance : 0;
      
      if (tier !== 'Owner' && !isAdmin(userId) && balance < state.amount) {
        delete userState[userId];
        return ctx.reply('⚠️ Saldo tidak cukup!');
      }
      
      if (tier !== 'Owner' && !isAdmin(userId)) {
        db.run(`UPDATE users SET balance = balance - ? WHERE user_id = ?`, [state.amount, userId]);
      }
      
      db.run(`INSERT INTO withdrawals (user_id, username, amount, method, account_number, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, username, state.amount, state.method, accountNumber, new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })]);
      
      delete userState[userId];
      ctx.reply(`✅ Request withdraw berhasil!\n\nNominal: Rp${state.amount.toLocaleString('id-ID')}\nMetode: ${state.method}\nNo. Rekening: ${accountNumber}\n\nMohon tunggu verifikasi admin.`);
    });
    return;
  }
  
  // Admin Script handlers
  if (isAdmin(userId)) {
    if (state.step === 'SCRIPT_SET_INFO') {
      const parts = ctx.message.text.split('|');
      if (parts.length !== 2) return ctx.reply('⚠️ Format salah! Gunakan: Nama|Harga');
      const name = parts[0].trim();
      const price = parseInt(parts[1].trim());
      if (isNaN(price)) return ctx.reply('⚠️ Harga harus angka!');
      db.get(`SELECT id FROM bot_scripts WHERE id = 1`, (err, row) => {
        if (!row) db.run(`INSERT INTO bot_scripts (id, name, price, stock) VALUES (1, ?, ?, 0)`, [name, price]);
        else db.run(`UPDATE bot_scripts SET name = ?, price = ? WHERE id = 1`, [name, price]);
        delete userState[getAdminId()];
        logAdminAction(userId, 'SET_SCRIPT_INFO', `Name: ${name}, Price: ${price}`);
        ctx.reply('✅ Script info diupdate!');
      });
      return;
    }
    if (state.step === 'SCRIPT_SET_TEXT') {
      db.run(`UPDATE bot_scripts SET instruction_text = ? WHERE id = 1`, [ctx.message.text.trim()]);
      delete userState[getAdminId()];
      logAdminAction(userId, 'SET_SCRIPT_TEXT', 'Update instruction text');
      ctx.reply('✅ Teks instruksi diupdate!');
      return;
    }
    if (state.step === 'SCRIPT_ADD_STOCK') {
      const stock = parseInt(ctx.message.text.trim());
      if (isNaN(stock) || stock <= 0) return ctx.reply('⚠️ Angka tidak valid!');
      db.get(`SELECT id FROM bot_scripts WHERE id = 1`, (err, row) => {
        if (!row) return ctx.reply('⚠️ Script belum di-setting.');
        db.run(`UPDATE bot_scripts SET stock = stock + ? WHERE id = 1`, [stock]);
        delete userState[getAdminId()];
        logAdminAction(userId, 'ADD_SCRIPT_STOCK', `Added: ${stock}`);
        ctx.reply(`✅ Stok ditambah ${stock}!`);
      });
      return;
    }
  }
});

// Webhook Casaku (existing)
const app = express();
app.post('/webhook/casaku', express.raw({ type: '*/*' }), async (req, res) => {
  // ... (kode webhook existing lu)
  res.status(200).send('OK');
});

app.get('/', (req, res) => res.send('Bot is running.'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Webhook server listening on port ${PORT}`));
bot.launch();
console.log('Bot Telegram Running dengan 9 Fitur Baru!');