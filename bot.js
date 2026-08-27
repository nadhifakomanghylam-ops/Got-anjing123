require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();

const bot = new Telegraf(process.env.BOT_TOKEN);

// Konversi ADMIN_ID ke Number dan hapus spasi jika ada
const ADMIN_ID = Number(String(process.env.ADMIN_ID).trim());

// 1. DATABASE SETUP
const db = new sqlite3.Database('./database.db');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS store (id INTEGER PRIMARY KEY, name TEXT, desc TEXT, qris TEXT, admin_uname TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, price INTEGER, photo TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, product_id INTEGER, status TEXT, proof TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS stock_items (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER, content TEXT, status TEXT DEFAULT 'AVAILABLE')`);
  
  db.get(`SELECT * FROM store WHERE id = 1`, (err, row) => {
    if (!row) {
      db.run(`INSERT INTO store (id, name, desc, qris, admin_uname) VALUES (1, 'Toko Digital Saya', 'Selamat datang di toko kami! Silakan pilih produk.', '', '')`);
    }
  });
});

const userState = {};

// 2. KEYBOARD NAVIGATION
const getMainMenu = (userId) => {
  const buttons = [
    [Markup.button.callback('🛒 Katalog Produk', 'user_catalog')],
    [Markup.button.callback('📞 Kontak Admin', 'user_contact')]
  ];
  
  if (Number(userId) === ADMIN_ID) {
    buttons.push([Markup.button.callback('⚙️ Dashboard Admin', 'admin_dashboard')]);
  }
  return Markup.inlineKeyboard(buttons);
};

const getAdminMenu = () => {
  return Markup.inlineKeyboard([
    [Markup.button.callback('➕ Tambah Produk', 'admin_add_prod'), Markup.button.callback('🗑️ Hapus Produk', 'admin_del_prod')],
    [Markup.button.callback('📦 Isi Stok Produk', 'admin_add_stock'), Markup.button.callback('🖼️ Set QRIS Payment', 'admin_set_qris')],
    [Markup.button.callback('✏️ Edit Info Toko', 'admin_edit_store'), Markup.button.callback('👤 Set Username Admin', 'admin_set_uname')],
    [Markup.button.callback('📢 Broadcast Pesan', 'admin_broadcast')],
    [Markup.button.callback('🔙 Kembali ke Menu Utama', 'main_menu')]
  ]);
};

// 3. COMMANDS
bot.start((ctx) => {
  db.get(`SELECT * FROM store WHERE id = 1`, (err, store) => {
    ctx.reply(`Welcome to *${store.name}*\n\n${store.desc}`, {
      parse_mode: 'Markdown',
      ...getMainMenu(ctx.from.id)
    });
  });
});

// Perintah langsung ketik /admin
bot.command('admin', (ctx) => {
  if (Number(ctx.from.id) === ADMIN_ID) {
    ctx.reply('⚙️ *DASHBOARD ADMIN TOKO*', { parse_mode: 'Markdown', ...getAdminMenu() });
  } else {
    ctx.reply(`❌ Akses Ditolak!\nID Anda: \`${ctx.from.id}\`\nID Admin di Railway: \`${ADMIN_ID}\`\n\nJika angka ini berbeda, ubah ADMIN_ID di Railway Variables.`, { parse_mode: 'Markdown' });
  }
});

bot.action('main_menu', (ctx) => {
  ctx.answerCbQuery();
  db.get(`SELECT * FROM store WHERE id = 1`, (err, store) => {
    ctx.editMessageText(`Welcome to *${store.name}*\n\n${store.desc}`, {
      parse_mode: 'Markdown',
      ...getMainMenu(ctx.from.id)
    });
  });
});

// 4. ALUR USER (PEMBELI)
bot.action('user_contact', (ctx) => {
  ctx.answerCbQuery();
  db.get(`SELECT admin_uname FROM store WHERE id = 1`, (err, store) => {
    const uname = (store && store.admin_uname) ? store.admin_uname.replace('@', '') : '';
    if (uname) {
      ctx.reply(`Hubungi Admin via link di bawah ini:`, Markup.inlineKeyboard([
        [Markup.button.url('💬 Chat Admin Langsung', `https://t.me/${uname}`)]
      ]));
    } else {
      ctx.reply(`Admin belum mengatur Username. Silakan hubungi via ID: ${ADMIN_ID}`);
    }
  });
});

bot.action('user_catalog', (ctx) => {
  ctx.answerCbQuery();
  const query = `
    SELECT p.*, COUNT(s.id) AS stock_count 
    FROM products p 
    LEFT JOIN stock_items s ON p.id = s.product_id AND s.status = 'AVAILABLE' 
    GROUP BY p.id
  `;

  db.all(query, (err, products) => {
    if (!products || products.length === 0) return ctx.reply('⚠️ Katalog produk masih kosong.\n(Admin belum menambahkan produk)');
    
    products.forEach((prod) => {
      const isAvailable = prod.stock_count > 0;
      const btnText = isAvailable ? `Beli (Rp${prod.price.toLocaleString('id-ID')})` : '❌ Stok Habis';
      const buttons = [];
      
      if (isAvailable) {
        buttons.push([Markup.button.callback(btnText, `buy_${prod.id}`)]);
      }

      const caption = `📌 *${prod.name}*\nHarga: Rp${prod.price.toLocaleString('id-ID')}\nStok: ${prod.stock_count}`;

      if (prod.photo) {
        ctx.replyWithPhoto(prod.photo, { caption, parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
      } else {
        ctx.reply(caption, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
      }
    });
  });
});

bot.action(/^buy_(.+)$/, (ctx) => {
  const prodId = ctx.match[1];
  db.get(`SELECT * FROM products WHERE id = ?`, [prodId], (err, prod) => {
    db.get(`SELECT qris FROM store WHERE id = 1`, (err, store) => {
      db.run(`INSERT INTO orders (user_id, product_id, status) VALUES (?, ?, 'PENDING')`, [ctx.from.id, prodId], function(err) {
        const orderId = this.lastID;
        userState[ctx.from.id] = { step: 'WAITING_PROOF', orderId: orderId };
        
        const text = `🛒 *PESANAN #${orderId}*\n\nProduk: ${prod.name}\nTotal: Rp${prod.price.toLocaleString('id-ID')}\n\nSilakan scan/transfer via QRIS di bawah ini, lalu *kirim screenshot bukti transfer ke chat bot ini*.`;
        
        if (store && store.qris) {
          ctx.replyWithPhoto(store.qris, { caption: text, parse_mode: 'Markdown' });
        } else {
          ctx.reply(text, { parse_mode: 'Markdown' });
        }
      });
    });
  });
});

// 5. DASHBOARD ADMIN
bot.action('admin_dashboard', (ctx) => {
  if (Number(ctx.from.id) !== ADMIN_ID) return;
  ctx.answerCbQuery();
  ctx.editMessageText('⚙️ *DASHBOARD ADMIN TOKO*', { parse_mode: 'Markdown', ...getAdminMenu() });
});

bot.action('admin_add_prod', (ctx) => {
  if (Number(ctx.from.id) !== ADMIN_ID) return;
  userState[ADMIN_ID] = { step: 'ADD_PROD_NAME' };
  ctx.reply('Ketik Nama Produk baru:');
});

bot.action('admin_add_stock', (ctx) => {
  if (Number(ctx.from.id) !== ADMIN_ID) return;
  db.all(`SELECT * FROM products`, (err, products) => {
    if (!products || products.length === 0) return ctx.reply('Belum ada produk.');
    const buttons = products.map(p => [Markup.button.callback(`📦 ${p.name}`, `addstock_${p.id}`)]);
    buttons.push([Markup.button.callback('🔙 Batal', 'admin_dashboard')]);
    ctx.reply('Pilih produk yang ingin ditambah stoknya:', Markup.inlineKeyboard(buttons));
  });
});

bot.action(/^addstock_(.+)$/, (ctx) => {
  if (Number(ctx.from.id) !== ADMIN_ID) return;
  userState[ADMIN_ID] = { step: 'INPUT_STOCK', prodId: ctx.match[1] };
  ctx.reply('Kirimkan teks lisensi/voucher atau kirimkan file/dokumen stok ke bot ini:');
});

bot.action('admin_set_qris', (ctx) => {
  if (Number(ctx.from.id) !== ADMIN_ID) return;
  userState[ADMIN_ID] = { step: 'SET_QRIS' };
  ctx.reply('Kirimkan foto QRIS toko kamu:');
});

bot.action('admin_set_uname', (ctx) => {
  if (Number(ctx.from.id) !== ADMIN_ID) return;
  userState[ADMIN_ID] = { step: 'SET_UNAME' };
  ctx.reply('Ketik Username Telegram kamu (contoh: `@UsernameKamu`):');
});

bot.action('admin_edit_store', (ctx) => {
  if (Number(ctx.from.id) !== ADMIN_ID) return;
  userState[ADMIN_ID] = { step: 'EDIT_STORE_NAME' };
  ctx.reply('Ketik Nama Toko baru:');
});

bot.action('admin_del_prod', (ctx) => {
  if (Number(ctx.from.id) !== ADMIN_ID) return;
  db.all(`SELECT * FROM products`, (err, products) => {
    if (!products || products.length === 0) return ctx.reply('Tidak ada produk.');
    const buttons = products.map(p => [Markup.button.callback(`❌ ${p.name}`, `del_${p.id}`)]);
    buttons.push([Markup.button.callback('🔙 Batal', 'admin_dashboard')]);
    ctx.reply('Pilih produk yang ingin dihapus:', Markup.inlineKeyboard(buttons));
  });
});

bot.action(/^del_(.+)$/, (ctx) => {
  if (Number(ctx.from.id) !== ADMIN_ID) return;
  db.run(`DELETE FROM products WHERE id = ?`, [ctx.match[1]], () => {
    ctx.reply('✅ Produk berhasil dihapus!');
  });
});

bot.action('admin_broadcast', (ctx) => {
  if (Number(ctx.from.id) !== ADMIN_ID) return;
  userState[ADMIN_ID] = { step: 'BROADCAST' };
  ctx.reply('Ketik pesan broadcast yang ingin dikirim:');
});

// 6. EVENT LISTENERS
bot.on('photo', (ctx) => {
  const state = userState[ctx.from.id];
  const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;

  if (state && state.step === 'WAITING_PROOF') {
    db.run(`UPDATE orders SET proof = ?, status = 'PROSES' WHERE id = ?`, [photoId, state.orderId]);
    delete userState[ctx.from.id];
    
    ctx.reply('✅ Bukti pembayaran diterima! Pesanan Anda sedang diverifikasi admin.');
    
    const adminButtons = Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Approve', `app_${state.orderId}`),
        Markup.button.callback('❌ Reject', `rej_${state.orderId}`)
      ]
    ]);
    
    bot.telegram.sendPhoto(ADMIN_ID, photoId, {
      caption: `🔔 *BUKTI PEMBAYARAN BARU*\n\nOrder ID: #${state.orderId}\nDari User ID: ${ctx.from.id}`,
      parse_mode: 'Markdown',
      ...adminButtons
    });
  } else if (state && state.step === 'ADD_PROD_PHOTO' && Number(ctx.from.id) === ADMIN_ID) {
    db.run(`INSERT INTO products (name, price, photo) VALUES (?, ?, ?)`, [state.name, state.price, photoId]);
    delete userState[ADMIN_ID];
    ctx.reply('✅ Produk berhasil ditambahkan!');
  } else if (state && state.step === 'SET_QRIS' && Number(ctx.from.id) === ADMIN_ID) {
    db.run(`UPDATE store SET qris = ? WHERE id = 1`, [photoId]);
    delete userState[ADMIN_ID];
    ctx.reply('✅ Foto QRIS toko diperbarui!');
  }
});

bot.on('document', (ctx) => {
  const state = userState[ctx.from.id];
  if (Number(ctx.from.id) === ADMIN_ID && state && state.step === 'INPUT_STOCK') {
    const fileId = ctx.message.document.file_id;
    db.run(`INSERT INTO stock_items (product_id, content) VALUES (?, ?)`, [state.prodId, `FILE:${fileId}`], () => {
      delete userState[ADMIN_ID];
      ctx.reply('✅ File stok berhasil dimasukkan!');
    });
  }
});

bot.on('text', (ctx) => {
  const state = userState[ctx.from.id];
  if (!state) return;

  if (Number(ctx.from.id) === ADMIN_ID) {
    if (state.step === 'ADD_PROD_NAME') {
      userState[ADMIN_ID] = { step: 'ADD_PROD_PRICE', name: ctx.message.text };
      ctx.reply('Masukkan harga produk (Angka saja):');
    } else if (state.step === 'ADD_PROD_PRICE') {
      const price = parseInt(ctx.message.text);
      if (isNaN(price)) return ctx.reply('Harga harus angka!');
      userState[ADMIN_ID] = { step: 'ADD_PROD_PHOTO', name: state.name, price: price };
      ctx.reply('Kirim foto produk (atau ketik "skip" tanpa foto):');
    } else if (state.step === 'ADD_PROD_PHOTO' && ctx.message.text.toLowerCase() === 'skip') {
      db.run(`INSERT INTO products (name, price, photo) VALUES (?, ?, NULL)`, [state.name, state.price]);
      delete userState[ADMIN_ID];
      ctx.reply('✅ Produk ditambahkan tanpa foto!');
    } else if (state.step === 'INPUT_STOCK') {
      db.run(`INSERT INTO stock_items (product_id, content) VALUES (?, ?)`, [state.prodId, ctx.message.text], () => {
        delete userState[ADMIN_ID];
        ctx.reply('✅ Kode stok/lisensi ditambahkan!');
      });
    } else if (state.step === 'SET_UNAME') {
      const uname = ctx.message.text.replace('@', '');
      db.run(`UPDATE store SET admin_uname = ? WHERE id = 1`, [uname]);
      delete userState[ADMIN_ID];
      ctx.reply(`✅ Username admin diubah jadi: @${uname}`);
    } else if (state.step === 'EDIT_STORE_NAME') {
      userState[ADMIN_ID] = { step: 'EDIT_STORE_DESC', storeName: ctx.message.text };
      ctx.reply('Ketik Deskripsi Toko baru:');
    } else if (state.step === 'EDIT_STORE_DESC') {
      db.run(`UPDATE store SET name = ?, desc = ? WHERE id = 1`, [state.storeName, ctx.message.text]);
      delete userState[ADMIN_ID];
      ctx.reply('✅ Info toko diperbarui!');
    } else if (state.step === 'BROADCAST') {
      db.all(`SELECT DISTINCT user_id FROM orders`, (err, users) => {
        if (users) {
          users.forEach(u => bot.telegram.sendMessage(u.user_id, `📢 *INFORMASI TOKO*\n\n${ctx.message.text}`, { parse_mode: 'Markdown' }));
        }
        ctx.reply(`✅ Broadcast terkirim.`);
      });
      delete userState[ADMIN_ID];
    }
  }
});

// 7. APPROVE / REJECT
bot.action(/^app_(.+)$/, (ctx) => {
  if (Number(ctx.from.id) !== ADMIN_ID) return;
  const orderId = ctx.match[1];

  db.get(`SELECT * FROM orders WHERE id = ?`, [orderId], (err, order) => {
    if (!order || order.status !== 'PROSES') return ctx.reply('Order sudah diproses.');

    db.get(`SELECT * FROM stock_items WHERE product_id = ? AND status = 'AVAILABLE' LIMIT 1`, [order.product_id], (err, stock) => {
      if (!stock) return ctx.reply(`⚠️ Gagal Approve: Stok produk ini HABIS!`);

      db.run(`UPDATE orders SET status = 'APPROVED' WHERE id = ?`, [orderId]);
      db.run(`UPDATE stock_items SET status = 'SOLD' WHERE id = ?`, [stock.id]);

      bot.telegram.sendMessage(order.user_id, `🎉 *Pesanan #${orderId} telah Disetujui!*\n\nBerikut item produk Anda:`, { parse_mode: 'Markdown' })
        .then(() => {
          if (stock.content.startsWith('FILE:')) {
            bot.telegram.sendDocument(order.user_id, stock.content.replace('FILE:', ''));
          } else {
            bot.telegram.sendMessage(order.user_id, `\`\`\`\n${stock.content}\n\`\`\``, { parse_mode: 'Markdown' });
          }
        });

      ctx.reply(`✅ Order #${orderId} di-Approve & barang terkirim.`);
    });
  });
});

bot.action(/^rej_(.+)$/, (ctx) => {
  if (Number(ctx.from.id) !== ADMIN_ID) return;
  const orderId = ctx.match[1];
  db.get(`SELECT * FROM orders WHERE id = ?`, [orderId], (err, order) => {
    db.run(`UPDATE orders SET status = 'REJECTED' WHERE id = ?`, [orderId]);
    bot.telegram.sendMessage(order.user_id, `❌ *Pesanan #${orderId} ditolak.* Hubungi admin jika ada masalah.`, { parse_mode: 'Markdown' });
    ctx.reply(`Order #${orderId} Ditolak.`);
  });
});

bot.launch();
console.log('Bot running...');
