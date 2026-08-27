require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();

const bot = new Telegraf(process.env.BOT_TOKEN);

const getAdminId = () => {
  const raw = process.env.ADMIN_ID;
  if (!raw) return 0;
  return Number(String(raw).replace(/[^0-9]/g, ''));
};

// 1. DATABASE SETUP
const db = new sqlite3.Database('./database.db');
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
  db.run(`CREATE TABLE IF NOT EXISTS groups (group_id INTEGER PRIMARY KEY)`);
  db.run(`CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, price INTEGER, photo TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, product_id INTEGER, status TEXT, proof TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS stock_items (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER, content TEXT, status TEXT DEFAULT 'AVAILABLE')`);
  
  db.get(`SELECT * FROM store WHERE id = 1`, (err, row) => {
    if (!row) {
      db.run(`INSERT INTO store (id, name, desc, photo, qris, dana, gopay, admin_uname, required_channel, log_group_id) VALUES (1, 'Toko Digital Saya', 'Selamat datang di toko kami! Silakan pilih produk.', '', '', '', '', '', '', '')`);
    }
  });
});

const userState = {};

// Helper: Hapus pesan lama agar chat rapi
const deleteMessage = async (ctx) => {
  try {
    if (ctx.callbackQuery && ctx.callbackQuery.message) {
      await ctx.deleteMessage(ctx.callbackQuery.message.message_id);
    }
  } catch (e) {}
};

// Helper: Simpan user & grup
const saveUser = (userId) => db.run(`INSERT OR IGNORE INTO users (user_id) VALUES (?)`, [userId]);
const saveGroup = (groupId) => db.run(`INSERT OR IGNORE INTO groups (group_id) VALUES (?)`, [groupId]);

// Helper Cek Membership
const checkMembership = async (ctx, next) => {
  if (ctx.chat.type !== 'private') {
    saveGroup(ctx.chat.id);
    return next();
  }
  
  const userId = ctx.from.id;
  saveUser(userId);

  if (userId === getAdminId()) return next();

  db.get(`SELECT required_channel FROM store WHERE id = 1`, async (err, store) => {
    if (store && store.required_channel && store.required_channel.trim() !== '') {
      const channel = store.required_channel.trim();
      try {
        const member = await ctx.telegram.getChatMember(channel, userId);
        if (['creator', 'administrator', 'member'].includes(member.status)) {
          return next();
        } else {
          showJoinGate(ctx, channel);
        }
      } catch (e) {
        return next();
      }
    } else {
      return next();
    }
  });
};

const showJoinGate = (ctx, channel) => {
  const channelUrl = channel.startsWith('@') ? `https://t.me/${channel.replace('@', '')}` : channel;
  const buttons = Markup.inlineKeyboard([
    [Markup.button.url('📢 Join Channel/Grup', channelUrl)],
    [Markup.button.callback('✅ Saya Sudah Join', 'check_join')]
  ]);
  const text = `⚠️ *AKSES DITOLAK*\n\nAnda harus bergabung ke Channel/Grup kami terlebih dahulu untuk menggunakan bot ini.`;
  ctx.replyWithMarkdown(text, buttons);
};

bot.action('check_join', async (ctx) => {
  await deleteMessage(ctx);
  db.get(`SELECT required_channel FROM store WHERE id = 1`, async (err, store) => {
    if (!store || !store.required_channel) return ctx.reply('Silakan ketik /start kembali.');
    const channel = store.required_channel.trim();
    try {
      const member = await ctx.telegram.getChatMember(channel, ctx.from.id);
      if (['creator', 'administrator', 'member'].includes(member.status)) {
        ctx.reply('✅ Verifikasi berhasil! Silakan ketik /start');
      } else {
        ctx.reply('❌ Anda belum bergabung. Silakan join terlebih dahulu.');
      }
    } catch (e) {
      ctx.reply('✅ Silakan ketik /start untuk lanjut.');
    }
  });
});

// KEYBOARD MENUS
const getMainMenu = (userId) => {
  const adminId = getAdminId();
  const buttons = [
    [Markup.button.callback('🛒 Katalog Produk', 'user_catalog'), Markup.button.callback('📞 Kontak Admin', 'user_contact')],
    [Markup.button.callback('🆔 Cek ID Akun', 'user_check_id')]
  ];
  
  if (Number(userId) === adminId && adminId !== 0) {
    buttons.push([Markup.button.callback('⚙️ Dashboard Admin', 'admin_dashboard')]);
  }
  return Markup.inlineKeyboard(buttons);
};

const getAdminMenu = () => {
  return Markup.inlineKeyboard([
    [Markup.button.callback('➕ Tambah Produk', 'admin_add_prod'), Markup.button.callback('🗑️ Hapus Produk', 'admin_del_prod')],
    [Markup.button.callback('📦 Isi Stok', 'admin_add_stock'), Markup.button.callback('💳 Set Pembayaran (DANA/GOPAY/QRIS)', 'admin_set_payment')],
    [Markup.button.callback('✏️ Edit Deskripsi/Foto Toko', 'admin_edit_store'), Markup.button.callback('👤 Set Username Admin', 'admin_set_uname')],
    [Markup.button.callback('🔒 Wajib Join Channel', 'admin_set_channel'), Markup.button.callback('🔔 Set Grup Log Notifikasi', 'admin_set_log_group')],
    [Markup.button.callback('📢 Broadcast User', 'admin_broadcast'), Markup.button.callback('📢 Broadcast Grup', 'admin_broadcast_group')],
    [Markup.button.callback('🔙 Kembali ke Menu Utama', 'main_menu')]
  ]);
};

// COMMANDS
bot.start(checkMembership, async (ctx) => {
  db.get(`SELECT * FROM store WHERE id = 1`, (err, store) => {
    const text = `🛍️ *${store.name}*\n\n${store.desc}`;
    if (store.photo) {
      ctx.replyWithPhoto(store.photo, { caption: text, parse_mode: 'Markdown', ...getMainMenu(ctx.from.id) });
    } else {
      ctx.replyWithMarkdown(text, getMainMenu(ctx.from.id));
    }
  });
});

// Command Cek ID (Bisa di PM / Grup)
bot.command('id', (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  let text = `👤 *ID Anda:* \`${userId}\`\n(Klik teks di atas untuk copy)`;
  if (ctx.chat.type !== 'private') {
    text += `\n👥 *ID Grup Ini:* \`${chatId}\``;
  }
  ctx.replyWithMarkdown(text);
});

bot.command('admin', (ctx) => {
  if (Number(ctx.from.id) === getAdminId()) {
    ctx.replyWithMarkdown('⚙️ *DASHBOARD ADMIN TOKO*', getAdminMenu());
  } else {
    ctx.reply('❌ Akses Ditolak!');
  }
});

bot.action('main_menu', checkMembership, async (ctx) => {
  await deleteMessage(ctx);
  db.get(`SELECT * FROM store WHERE id = 1`, (err, store) => {
    const text = `🛍️ *${store.name}*\n\n${store.desc}`;
    if (store.photo) {
      ctx.replyWithPhoto(store.photo, { caption: text, parse_mode: 'Markdown', ...getMainMenu(ctx.from.id) });
    } else {
      ctx.replyWithMarkdown(text, getMainMenu(ctx.from.id));
    }
  });
});

bot.action('user_check_id', async (ctx) => {
  ctx.answerCbQuery();
  ctx.replyWithMarkdown(`👤 *ID Anda:* \`${ctx.from.id}\`\n(Klik teks ID di atas untuk langsung meng-copy)`);
});

// ALUR USER
bot.action('user_contact', checkMembership, async (ctx) => {
  ctx.answerCbQuery();
  db.get(`SELECT admin_uname FROM store WHERE id = 1`, (err, store) => {
    const uname = (store && store.admin_uname) ? store.admin_uname.replace('@', '') : '';
    if (uname) {
      ctx.reply(`Hubungi Admin via link di bawah ini:`, Markup.inlineKeyboard([
        [Markup.button.url('💬 Chat Admin Langsung', `https://t.me/${uname}`)]
      ]));
    } else {
      ctx.replyWithMarkdown(`Admin belum mengatur Username. Contact ID: \`${getAdminId()}\``);
    }
  });
});

bot.action('user_catalog', checkMembership, async (ctx) => {
  await deleteMessage(ctx);
  const query = `
    SELECT p.*, COUNT(s.id) AS stock_count 
    FROM products p 
    LEFT JOIN stock_items s ON p.id = s.product_id AND s.status = 'AVAILABLE' 
    GROUP BY p.id
  `;

  db.all(query, (err, products) => {
    if (!products || products.length === 0) {
      return ctx.reply('⚠️ Katalog produk masih kosong.', Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali', 'main_menu')]]));
    }
    
    products.forEach((prod) => {
      const btnText = prod.stock_count > 0 
        ? `🛒 Beli Sekarang (Rp${prod.price.toLocaleString('id-ID')})` 
        : `❌ Stok Habis`;
        
      const buttons = [
        [Markup.button.callback(btnText, `buy_${prod.id}`)],
        [Markup.button.callback('🔙 Menu Utama', 'main_menu')]
      ];
      const caption = `📌 *${prod.name}*\nHarga: Rp${prod.price.toLocaleString('id-ID')}\nStok: ${prod.stock_count}`;

      if (prod.photo) {
        ctx.replyWithPhoto(prod.photo, { caption, parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
      } else {
        ctx.replyWithMarkdown(caption, Markup.inlineKeyboard(buttons));
      }
    });
  });
});

bot.action(/^buy_(.+)$/, checkMembership, async (ctx) => {
  await deleteMessage(ctx);
  const prodId = ctx.match[1];
  
  db.get(`SELECT * FROM products WHERE id = ?`, [prodId], (err, prod) => {
    db.get(`SELECT COUNT(id) AS stock_count FROM stock_items WHERE product_id = ? AND status = 'AVAILABLE'`, [prodId], (err, res) => {
      if (!res || res.stock_count <= 0) {
        return ctx.reply(`⚠️ Maaf, stok produk *${prod.name}* sedang HABIS!`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Katalog', 'user_catalog')]]));
      }

      db.get(`SELECT * FROM store WHERE id = 1`, (err, store) => {
        db.run(`INSERT INTO orders (user_id, product_id, status) VALUES (?, ?, 'PENDING')`, [ctx.from.id, prodId], function(err) {
          const orderId = this.lastID;
          userState[ctx.from.id] = { step: 'WAITING_PROOF', orderId: orderId };
          
          // NOTIFIKASI KANTONG / LOG ADMIN & GRUP
          const notifMsg = `🔔 *ORDER BARU (MENUNGGU BAYAR)*\n\nOrder ID: #${orderId}\nProduk: ${prod.name}\nUser ID: \`${ctx.from.id}\``;
          if (getAdminId() !== 0) bot.telegram.sendMessage(getAdminId(), notifMsg, { parse_mode: 'Markdown' });
          if (store.log_group_id) bot.telegram.sendMessage(store.log_group_id, notifMsg, { parse_mode: 'Markdown' });

          let payText = `🛒 *PESANAN #${orderId}*\n\nProduk: *${prod.name}*\nTotal: *Rp${prod.price.toLocaleString('id-ID')}*\n\n`;
          payText += `💳 *METODE PEMBAYARAN:*\n`;
          payText += store.dana ? `🔹 DANA: \`${store.dana}\` (Klik untuk copy)\n` : '';
          payText += store.gopay ? `🔹 GOPAY: \`${store.gopay}\` (Klik untuk copy)\n` : '';
          if (!store.dana && !store.gopay && !store.qris) payText += `_(Admin belum memasukkan metode pembayaran)_\n`;
          
          payText += `\nSilakan transfer sesuai nominal di atas, lalu *Kirimkan Foto Screenshot Bukti Pembayaran* ke chat bot ini.`;

          if (store && store.qris) {
            ctx.replyWithPhoto(store.qris, { caption: payText, parse_mode: 'Markdown' });
          } else {
            ctx.replyWithMarkdown(payText);
          }
        });
      });
    });
  });
});

// DASHBOARD ADMIN
bot.action('admin_dashboard', async (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  await deleteMessage(ctx);
  ctx.replyWithMarkdown('⚙️ *DASHBOARD ADMIN TOKO*', getAdminMenu());
});

bot.action('admin_set_payment', async (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  await deleteMessage(ctx);
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback('📱 Set No DANA', 'set_dana'), Markup.button.callback('📱 Set No GOPAY', 'set_gopay')],
    [Markup.button.callback('🖼️ Set QRIS (Foto)', 'set_qris')],
    [Markup.button.callback('🔙 Batal', 'admin_dashboard')]
  ]);
  ctx.replyWithMarkdown('Pilih metode pembayaran yang ingin diatur:', buttons);
});

bot.action('set_dana', (ctx) => {
  userState[getAdminId()] = { step: 'SET_DANA' };
  ctx.reply('Ketik No DANA toko kamu:');
});
bot.action('set_gopay', (ctx) => {
  userState[getAdminId()] = { step: 'SET_GOPAY' };
  ctx.reply('Ketik No GOPAY toko kamu:');
});
bot.action('set_qris', (ctx) => {
  userState[getAdminId()] = { step: 'SET_QRIS' };
  ctx.reply('Kirimkan foto QRIS toko kamu:');
});

bot.action('admin_set_log_group', (ctx) => {
  userState[getAdminId()] = { step: 'SET_LOG_GROUP' };
  ctx.replyWithMarkdown('Ketik **ID Grup Log Notifikasi** (Contoh: `-1001234567890`):\n\n💡 _Gunakan command /id di grup tujuan untuk mengetahui ID grup._');
});

bot.action('admin_edit_store', async (ctx) => {
  await deleteMessage(ctx);
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback('📝 Edit Deskripsi Toko', 'edit_desc')],
    [Markup.button.callback('🖼️ Set Header Foto Toko', 'edit_photo')],
    [Markup.button.callback('🔙 Batal', 'admin_dashboard')]
  ]);
  ctx.reply('Pilih pengaturan toko yang ingin diubah:', buttons);
});

bot.action('edit_desc', (ctx) => {
  userState[getAdminId()] = { step: 'EDIT_STORE_DESC' };
  ctx.reply('Ketik Deskripsi Toko baru:');
});
bot.action('edit_photo', (ctx) => {
  userState[getAdminId()] = { step: 'EDIT_STORE_PHOTO' };
  ctx.reply('Kirimkan foto header banner toko baru:');
});

bot.action('admin_add_prod', (ctx) => {
  userState[getAdminId()] = { step: 'ADD_PROD_NAME' };
  ctx.reply('Ketik Nama Produk baru:');
});

bot.action('admin_add_stock', async (ctx) => {
  await deleteMessage(ctx);
  db.all(`SELECT * FROM products`, (err, products) => {
    if (!products || products.length === 0) return ctx.reply('Belum ada produk.');
    const buttons = products.map(p => [Markup.button.callback(`📦 ${p.name}`, `addstock_${p.id}`)]);
    buttons.push([Markup.button.callback('🔙 Batal', 'admin_dashboard')]);
    ctx.reply('Pilih produk yang ingin ditambah stoknya:', Markup.inlineKeyboard(buttons));
  });
});

bot.action(/^addstock_(.+)$/, (ctx) => {
  userState[getAdminId()] = { step: 'INPUT_STOCK', prodId: ctx.match[1] };
  ctx.reply('Kirimkan teks lisensi/voucher atau kirimkan file stok:');
});

bot.action('admin_set_uname', (ctx) => {
  userState[getAdminId()] = { step: 'SET_UNAME' };
  ctx.reply('Ketik Username Telegram kamu (contoh: @UsernameKamu):');
});

bot.action('admin_set_channel', (ctx) => {
  userState[getAdminId()] = { step: 'SET_CHANNEL' };
  ctx.reply('Masukkan Username Channel/Grup Wajib Join (contoh: @NamaChannel) atau ketik "off" untuk mematikan:');
});

bot.action('admin_del_prod', async (ctx) => {
  await deleteMessage(ctx);
  db.all(`SELECT * FROM products`, (err, products) => {
    if (!products || products.length === 0) return ctx.reply('Tidak ada produk.');
    const buttons = products.map(p => [Markup.button.callback(`❌ ${p.name}`, `del_${p.id}`)]);
    buttons.push([Markup.button.callback('🔙 Batal', 'admin_dashboard')]);
    ctx.reply('Pilih produk yang ingin dihapus:', Markup.inlineKeyboard(buttons));
  });
});

bot.action(/^del_(.+)$/, (ctx) => {
  db.run(`DELETE FROM products WHERE id = ?`, [ctx.match[1]], () => {
    ctx.reply('✅ Produk berhasil dihapus!');
  });
});

bot.action('admin_broadcast', (ctx) => {
  userState[getAdminId()] = { step: 'BROADCAST_USER' };
  ctx.reply('Ketik pesan broadcast ke SELURUH USER:');
});

bot.action('admin_broadcast_group', (ctx) => {
  userState[getAdminId()] = { step: 'BROADCAST_GROUP' };
  ctx.reply('Ketik pesan broadcast ke SELURUH GRUP:');
});

// EVENT LISTENERS
bot.on('photo', (ctx) => {
  const adminId = getAdminId();
  const state = userState[ctx.from.id];
  const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;

  if (state && state.step === 'WAITING_PROOF') {
    db.run(`UPDATE orders SET proof = ?, status = 'PROSES' WHERE id = ?`, [photoId, state.orderId]);
    delete userState[ctx.from.id];
    
    ctx.reply('✅ Bukti pembayaran diterima! Pesanan Anda sedang diverifikasi admin.');
    
    const adminButtons = Markup.inlineKeyboard([
      [Markup.button.callback('✅ Approve', `app_${state.orderId}`), Markup.button.callback('❌ Reject', `rej_${state.orderId}`)]
    ]);
    
    const proofText = `🔔 *BUKTI PEMBAYARAN MASUK!*\n\nOrder ID: #${state.orderId}\nDari User ID: \`${ctx.from.id}\``;

    if (adminId !== 0) {
      bot.telegram.sendPhoto(adminId, photoId, { caption: proofText, parse_mode: 'Markdown', ...adminButtons });
    }
    
    db.get(`SELECT log_group_id FROM store WHERE id = 1`, (err, store) => {
      if (store && store.log_group_id) {
        bot.telegram.sendPhoto(store.log_group_id, photoId, { caption: proofText, parse_mode: 'Markdown', ...adminButtons });
      }
    });

  } else if (state && state.step === 'ADD_PROD_PHOTO' && Number(ctx.from.id) === adminId) {
    db.run(`INSERT INTO products (name, price, photo) VALUES (?, ?, ?)`, [state.name, state.price, photoId]);
    delete userState[adminId];
    ctx.reply('✅ Produk berhasil ditambahkan!');
  } else if (state && state.step === 'SET_QRIS' && Number(ctx.from.id) === adminId) {
    db.run(`UPDATE store SET qris = ? WHERE id = 1`, [photoId]);
    delete userState[adminId];
    ctx.reply('✅ Foto QRIS diperbarui!');
  } else if (state && state.step === 'EDIT_STORE_PHOTO' && Number(ctx.from.id) === adminId) {
    db.run(`UPDATE store SET photo = ? WHERE id = 1`, [photoId]);
    delete userState[adminId];
    ctx.reply('✅ Foto Header Toko diperbarui!');
  }
});

bot.on('document', (ctx) => {
  const adminId = getAdminId();
  const state = userState[ctx.from.id];
  if (Number(ctx.from.id) === adminId && state && state.step === 'INPUT_STOCK') {
    const fileId = ctx.message.document.file_id;
    db.run(`INSERT INTO stock_items (product_id, content) VALUES (?, ?)`, [state.prodId, `FILE:${fileId}`], () => {
      delete userState[adminId];
      ctx.reply('✅ File stok berhasil dimasukkan!');
    });
  }
});

bot.on('text', (ctx) => {
  if (ctx.chat.type !== 'private') saveGroup(ctx.chat.id);
  else saveUser(ctx.from.id);

  const adminId = getAdminId();
  const state = userState[ctx.from.id];
  if (!state) return;

  if (Number(ctx.from.id) === adminId) {
    if (state.step === 'ADD_PROD_NAME') {
      userState[adminId] = { step: 'ADD_PROD_PRICE', name: ctx.message.text };
      ctx.reply('Masukkan harga produk (Angka saja):');
    } else if (state.step === 'ADD_PROD_PRICE') {
      const price = parseInt(ctx.message.text);
      if (isNaN(price)) return ctx.reply('Harga harus berupa angka!');
      userState[adminId] = { step: 'ADD_PROD_PHOTO', name: state.name, price: price };
      ctx.reply('Kirim foto produk (atau ketik "skip" jika tanpa foto):');
    } else if (state.step === 'ADD_PROD_PHOTO' && ctx.message.text.toLowerCase() === 'skip') {
      db.run(`INSERT INTO products (name, price, photo) VALUES (?, ?, NULL)`, [state.name, state.price]);
      delete userState[adminId];
      ctx.reply('✅ Produk berhasil ditambahkan tanpa foto!');
    } else if (state.step === 'INPUT_STOCK') {
      db.run(`INSERT INTO stock_items (product_id, content) VALUES (?, ?)`, [state.prodId, ctx.message.text], () => {
        delete userState[adminId];
        ctx.reply('✅ Kode stok/lisensi ditambahkan!');
      });
    } else if (state.step === 'SET_DANA') {
      db.run(`UPDATE store SET dana = ? WHERE id = 1`, [ctx.message.text.trim()]);
      delete userState[adminId];
      ctx.reply(`✅ Nomor DANA berhasil diatur ke: ${ctx.message.text.trim()}`);
    } else if (state.step === 'SET_GOPAY') {
      db.run(`UPDATE store SET gopay = ? WHERE id = 1`, [ctx.message.text.trim()]);
      delete userState[adminId];
      ctx.reply(`✅ Nomor GOPAY berhasil diatur ke: ${ctx.message.text.trim()}`);
    } else if (state.step === 'SET_LOG_GROUP') {
      db.run(`UPDATE store SET log_group_id = ? WHERE id = 1`, [ctx.message.text.trim()]);
      delete userState[adminId];
      ctx.reply(`✅ ID Grup Log Notifikasi diubah ke: ${ctx.message.text.trim()}`);
    } else if (state.step === 'SET_UNAME') {
      const uname = ctx.message.text.replace('@', '');
      db.run(`UPDATE store SET admin_uname = ? WHERE id = 1`, [uname]);
      delete userState[adminId];
      ctx.reply(`✅ Username admin diubah jadi: @${uname}`);
    } else if (state.step === 'SET_CHANNEL') {
      const val = ctx.message.text.toLowerCase() === 'off' ? '' : ctx.message.text.trim();
      db.run(`UPDATE store SET required_channel = ? WHERE id = 1`, [val]);
      delete userState[adminId];
      ctx.reply(val ? `✅ Wajib join diset ke: ${val}` : `✅ Fitur Wajib Join Dimatikan.`);
    } else if (state.step === 'EDIT_STORE_DESC') {
      db.run(`UPDATE store SET desc = ? WHERE id = 1`, [ctx.message.text]);
      delete userState[adminId];
      ctx.reply('✅ Deskripsi toko berhasil diperbarui!');
    } else if (state.step === 'BROADCAST_USER') {
      const text = ctx.message.text;
      delete userState[adminId];
      db.all(`SELECT user_id FROM users`, (err, users) => {
        if (users && users.length > 0) {
          users.forEach(u => bot.telegram.sendMessage(u.user_id, `📢 *INFORMASI TOKO*\n\n${text}`, { parse_mode: 'Markdown' }).catch(() => {}));
          ctx.reply(`✅ Broadcast terkirim ke ${users.length} pengguna!`);
        }
      });
    } else if (state.step === 'BROADCAST_GROUP') {
      const text = ctx.message.text;
      delete userState[adminId];
      db.all(`SELECT group_id FROM groups`, (err, groups) => {
        if (groups && groups.length > 0) {
          groups.forEach(g => bot.telegram.sendMessage(g.group_id, `📢 *INFORMASI TOKO*\n\n${text}`, { parse_mode: 'Markdown' }).catch(() => {}));
          ctx.reply(`✅ Broadcast terkirim ke ${groups.length} grup!`);
        }
      });
    }
  }
});

// APPROVE / REJECT
bot.action(/^app_(.+)$/, (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  const orderId = ctx.match[1];

  db.get(`SELECT * FROM orders WHERE id = ?`, [orderId], (err, order) => {
    if (!order || order.status !== 'PROSES') return ctx.reply('Order ini sudah diproses.');

    db.get(`SELECT * FROM stock_items WHERE product_id = ? AND status = 'AVAILABLE' LIMIT 1`, [order.product_id], (err, stock) => {
      if (!stock) return ctx.reply(`⚠️ Gagal Approve: Stok produk ini HABIS!`);

      db.run(`UPDATE orders SET status = 'APPROVED' WHERE id = ?`, [orderId]);
      db.run(`UPDATE stock_items SET status = 'SOLD' WHERE id = ?`, [stock.id]);

      bot.telegram.sendMessage(order.user_id, `🎉 *Pesanan #${orderId} telah Disetujui!*\n\nBerikut item produk Anda:`, { parse_mode: 'Markdown' })
        .then(() => {
          if (stock.content.startsWith('FILE:')) {
            bot.telegram.sendDocument(order.user_id, stock.content.replace('FILE:', ''));
          } else {
            bot.telegram.sendMessage(order.user_id, stock.content);
          }
        });

      ctx.reply(`✅ Order #${orderId} di-Approve & barang terkirim.`);
    });
  });
});

bot.action(/^rej_(.+)$/, (ctx) => {
  if (Number(ctx.from.id) !== getAdminId()) return;
  const orderId = ctx.match[1];
  db.get(`SELECT * FROM orders WHERE id = ?`, [orderId], (err, order) => {
    db.run(`UPDATE orders SET status = 'REJECTED' WHERE id = ?`, [orderId]);
    bot.telegram.sendMessage(order.user_id, `❌ Pesanan #${orderId} ditolak. Hubungi admin jika ada kendala.`);
    ctx.reply(`Order #${orderId} Ditolak.`);
  });
});

bot.launch();
console.log('Bot running...');
