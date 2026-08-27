/**
 * ====================================================================
 * FULL BOT WHATSAPP UTUH (BAILEYS VERSION)
 * Termasuk Fitur Utama, Perbaikan UI/Font, QRIS + Button, 
 * Broadcast Group, Anti-Spam, Anti-Link, & Auto Testimoni
 * ====================================================================
 */

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeInMemoryStore,
    proto
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const fs = require('fs');
const path = require('path');

// ====================================================================
// 1. KONFIGURASI BOT & PENGATURAN UTAMA
// ====================================================================
const CONFIG = {
    botName: "STORE BOT AUTOMATION",
    adminNumbers: ["6281234567890@s.whatsapp.net"], // Ganti dengan nomor WhatsApp Admin Anda
    testiGroupId: "120363000000000000@g.us",         // Ganti dengan JID/ID Grup Testimoni Anda
    payment: {
        qrisPath: "./assets/qris.jpg",               // Lokasi file foto QRIS Anda
        danaNumber: "081234567890",                  // Nomor DANA
        gopayNumber: "081234567890",                 // Nomor GOPAY
        accountName: "A.N. TOKO KITA"
    },
    antiSpamCooldownMs: 3000                         // Delay cooldown anti-spam (3 detik)
};

// ====================================================================
// 2. DATABASE SEDERHANA & MEMORY STORAGE
// ====================================================================
const userCooldowns = new Map();
const registeredGroups = new Set();
const pendingTransactions = new Map(); // Menyimpan transaksi aktif

// Load/Save Registered Groups (Persistensi Data Grup untuk Broadcast)
const GROUPS_FILE = './registered_groups.json';
if (fs.existsSync(GROUPS_FILE)) {
    try {
        const savedGroups = JSON.parse(fs.readFileSync(GROUPS_FILE));
        savedGroups.forEach(id => registeredGroups.add(id));
    } catch (e) {
        console.error("Gagal memuat registered_groups.json", e);
    }
}

function saveGroupsToFile() {
    fs.writeFileSync(GROUPS_FILE, JSON.stringify(Array.from(registeredGroups), null, 2));
}

// ====================================================================
// 3. HELPER FORMAT FONT / UI BOT (FONT CLEAN & PROFESSIONAL)
// ====================================================================
const formatUI = {
    header: (title) => `━━━━━[ *${title.toUpperCase()}* ]━━━━━\n`,
    mono: (text) => `\`\`\`${text}\`\`\``,
    bold: (text) => `*${text}*`,
    quote: (text) => `> ${text}`,
    divider: () => `\n───────────────────────────\n`
};

// ====================================================================
// 4. MODUL KEAMANAN (ANTI-SPAM & ANTI-LINK GRUP)
// ====================================================================
async function handleGroupSecurity(sock, m, isGroup, sender, textMessage) {
    if (!isGroup) return false;

    // A. Anti-Link (WhatsApp & Telegram)
    const linkRegex = /(chat\.whatsapp\.com\/|wa\.me\/|t\.me\/|telegram\.me\/|telegram\.dog\/)/i;
    if (linkRegex.test(textMessage)) {
        try {
            // Hapus pesan jika bot menjadi Admin
            await sock.sendMessage(m.key.remoteJid, { delete: m.key });
            await sock.sendMessage(m.key.remoteJid, { 
                text: `⚠️ ${formatUI.bold('PERINGATAN ANTI-LINK')}\n\nMohon maaf @${sender.split('@')[0]}, dilarang mengirimkan link grup WhatsApp atau Telegram di grup ini!`,
                mentions: [sender]
            }, { quoted: m });
        } catch (err) {
            console.log("Gagal menghapus pesan anti-link (Mungkin bot bukan admin).");
        }
        return true;
    }

    // B. Anti-Spam Command (Cooldown System)
    const now = Date.now();
    const lastTime = userCooldowns.get(sender) || 0;
    if (now - lastTime < CONFIG.antiSpamCooldownMs) {
        await sock.sendMessage(m.key.remoteJid, { 
            text: `⏳ ${formatUI.mono('Mohon tunggu beberapa detik sebelum menggunakan perintah bot lagi.')}` 
        }, { quoted: m });
        return true;
    }
    userCooldowns.set(sender, now);

    return false;
}

// ====================================================================
// 5. MODUL PEMESANAN & METODE PEMBAYARAN (TERPISAH)
// ====================================================================
async function sendOrderPayment(sock, jid, orderData) {
    const orderDetails = 
`${formatUI.header('DETAIL PESANAN')}
${formatUI.quote('ID Transaksi : ' + formatUI.mono(orderData.trxId))}
${formatUI.quote('Produk       : ' + formatUI.bold(orderData.productName))}
${formatUI.quote('Harga        : Rp ' + orderData.price.toLocaleString('id-ID'))}
${formatUI.quote('Pembeli      : @' + orderData.buyerJid.split('@')[0])}
${formatUI.quote('Waktu        : ' + orderData.dateTime)}
${formatUI.divider()}
📌 ${formatUI.bold('Petunjuk Pembayaran:')}
Silakan lakukan scan pada foto QRIS di bawah ini, atau salin nomor e-wallet menggunakan tombol di bawah.`;

    // 1. Kirim Foto QRIS + Caption Detail Pesanan
    if (fs.existsSync(CONFIG.payment.qrisPath)) {
        await sock.sendMessage(jid, {
            image: fs.readFileSync(CONFIG.payment.qrisPath),
            caption: orderDetails,
            mentions: [orderData.buyerJid]
        });
    } else {
        // Fallback jika file QRIS tidak ditemukan
        await sock.sendMessage(jid, { 
            text: `${orderDetails}\n\n*(Foto QRIS belum diunggah oleh admin)*`,
            mentions: [orderData.buyerJid]
        });
    }

    // 2. Kirim Tombol Pembayaran DANA & GOPAY (Tombol Salin Kode)
    const paymentButtons = [
        {
            name: 'cta_copy',
            buttonParamsJson: JSON.stringify({
                display_text: '📋 Salin No. DANA',
                id: 'copy_dana',
                copy_code: CONFIG.payment.danaNumber
            })
        },
        {
            name: 'cta_copy',
            buttonParamsJson: JSON.stringify({
                display_text: '📋 Salin No. GOPAY',
                id: 'copy_gopay',
                copy_code: CONFIG.payment.gopayNumber
            })
        }
    ];

    await sock.sendMessage(jid, {
        text: `💳 ${formatUI.bold('OPSI REKENING & E-WALLET')}\n${formatUI.quote('A.N: ' + CONFIG.payment.accountName)}\n\nKlik tombol di bawah ini untuk menyalin nomor secara otomatis:`,
        footer: CONFIG.botName,
        buttons: paymentButtons
    });
}

// ====================================================================
// 6. MODUL AUTO UPLOAD TESTIMONI KE GRUP
// ====================================================================
async function approveAndSendTesti(sock, transactionData, receiptMessage) {
    const now = new Date();
    const dateStr = now.toLocaleDateString('id-ID');
    const timeStr = now.toLocaleTimeString('id-ID');

    const testiCaption = 
`${formatUI.header('TRANSAKSI SUCCESS / TESTIMONI')}
✅ ${formatUI.bold('Pesanan Telah Berhasil Dikonfirmasi!')}

${formatUI.quote('ID Transaksi : ' + formatUI.mono(transactionData.trxId))}
${formatUI.quote('Nama Produk  : ' + formatUI.bold(transactionData.productName))}
${formatUI.quote('Harga        : Rp ' + transactionData.price.toLocaleString('id-ID'))}
${formatUI.quote('Pembeli      : @' + transactionData.buyerJid.split('@')[0])}
${formatUI.quote('Tanggal      : ' + dateStr)}
${formatUI.quote('Jam          : ' + timeStr + ' WIB')}

${formatUI.divider()}
Terima kasih telah berbelanja! Kepuasan Anda adalah prioritas kami.`;

    try {
        // Jika ada bukti foto transfer yang dikirim pembeli
        if (receiptMessage?.message?.imageMessage) {
            const buffer = await sock.downloadMediaMessage(receiptMessage);
            await sock.sendMessage(CONFIG.testiGroupId, {
                image: buffer,
                caption: testiCaption,
                mentions: [transactionData.buyerJid]
            });
        } else {
            // Jika approval tanpa foto bukti transfer
            await sock.sendMessage(CONFIG.testiGroupId, {
                text: testiCaption,
                mentions: [transactionData.buyerJid]
            });
        }
    } catch (err) {
        console.error("Gagal mengirimkan testimoni ke grup:", err);
    }
}

// ====================================================================
// 7. MODUL BROADCAST KE SEMUA GRUP
// ====================================================================
async function broadcastToGroups(sock, messageText) {
    let successCount = 0;
    let failedCount = 0;

    const bcText = `${formatUI.header('BROADCAST INFORMASI')}\n\n${messageText}\n\n${formatUI.quote(CONFIG.botName)}`;

    for (const groupId of registeredGroups) {
        try {
            await sock.sendMessage(groupId, { text: bcText });
            successCount++;
            await new Promise(res => setTimeout(res, 1500)); // Delay per grup agar aman dari ban
        } catch (err) {
            failedCount++;
        }
    }

    return { successCount, failedCount };
}

// ====================================================================
// 8. MESSAGE HANDLER (PENANGAN PESAN MASUK & COMMANDS)
// ====================================================================
async function handleMessages(sock, m) {
    try {
        if (!m.message) return;
        const from = m.key.remoteJid;
        const isGroup = from.endsWith('@g.us');
        const sender = isGroup ? (m.key.participant || m.participant) : from;

        // Ambil isi teks pesan
        const body = m.message?.conversation || 
                     m.message?.extendedTextMessage?.text || 
                     m.message?.imageMessage?.caption || "";

        // Daftarkan ID grup jika ada aktivitas di grup
        if (isGroup && !registeredGroups.has(from)) {
            registeredGroups.add(from);
            saveGroupsToFile();
        }

        // Jalankan Fitur Keamanan (Anti-Spam & Anti-Link)
        const isBlocked = await handleGroupSecurity(sock, m, isGroup, sender, body);
        if (isBlocked) return;

        // --- DAFTAR COMMAND BOT ---

        // 1. Menu Utama
        if (body.toLowerCase() === '!menu' || body.toLowerCase() === '.menu') {
            const menuText = 
`${formatUI.header(CONFIG.botName)}
Halo! Selamat datang di layanan otomatis kami.

${formatUI.bold('📌 FITUR USER:')}
- ${formatUI.mono('!order')} : Membuat simulasi pesanan baru.
- ${formatUI.mono('!pay [ID]')} : Menampilkan ulang metode pembayaran.

${formatUI.bold('📌 FITUR ADMIN:')}
- ${formatUI.mono('!approve [ID]')} : Approve transaksi & kirim auto testimoni.
- ${formatUI.mono('!bcgroup [Pesan]')} : Broadcast ke seluruh grup terdaftar.

${formatUI.divider()}
Ketik perintah sesuai daftar di atas.`;
            return await sock.sendMessage(from, { text: menuText }, { quoted: m });
        }

        // 2. Command Order Produk (Simulasi)
        if (body.toLowerCase() === '!order' || body.toLowerCase() === '.order') {
            const trxId = 'TRX-' + Math.floor(100000 + Math.random() * 900000);
            const orderData = {
                trxId: trxId,
                productName: 'VIP Premium Access (30 Hari)',
                price: 25000,
                buyerJid: sender,
                dateTime: new Date().toLocaleString('id-ID')
            };

            // Simpan transaksi di memory
            pendingTransactions.set(trxId, orderData);

            // Kirim Detail Produk + QRIS + Tombol Pembayaran
            await sendOrderPayment(sock, from, orderData);
        }

        // 3. Command Admin: Approve Transaksi & Kirim Auto Testimoni
        if (body.startsWith('!approve')) {
            if (!CONFIG.adminNumbers.includes(sender)) {
                return sock.sendMessage(from, { text: '❌ Anda tidak memiliki akses untuk perintah ini.' }, { quoted: m });
            }

            const args = body.split(' ');
            const trxId = args[1];

            if (!trxId || !pendingTransactions.has(trxId)) {
                return sock.sendMessage(from, { text: `⚠️ Transaksi dengan ID ${trxId || ''} tidak ditemukan!` }, { quoted: m });
            }

            const trxData = pendingTransactions.get(trxId);
            
            // Auto upload testimoni ke grup testimoni
            await approveAndSendTesti(sock, trxData, m);

            // Beri respon ke Admin
            await sock.sendMessage(from, { 
                text: `✅ ${formatUI.bold('Transaksi Berhasil Dikonfirmasi!')}\n\nDetail testimoni otomatis diunggah ke grup testimoni.` 
            }, { quoted: m });

            // Hapus dari pending
            pendingTransactions.delete(trxId);
        }

        // 4. Command Admin: Broadcast ke Seluruh Grup
        if (body.startsWith('!bcgroup')) {
            if (!CONFIG.adminNumbers.includes(sender)) {
                return sock.sendMessage(from, { text: '❌ Perintah ini khusus untuk Admin.' }, { quoted: m });
            }

            const textToBroadcast = body.replace('!bcgroup', '').trim();
            if (!textToBroadcast) {
                return sock.sendMessage(from, { text: '⚠️ Format salah. Gunakan: !bcgroup [Isi pesan yang ingin disebar]' }, { quoted: m });
            }

            await sock.sendMessage(from, { text: '⏳ Sedang mengirimkan broadcast ke seluruh grup...' }, { quoted: m });

            const result = await broadcastToGroups(sock, textToBroadcast);

            await sock.sendMessage(from, { 
                text: `✅ ${formatUI.bold('BROADCAST SELESAI')}\n\n- ${formatUI.bold('Berhasil')}: ${result.successCount} Grup\n- ${formatUI.bold('Gagal')}: ${result.failedCount} Grup` 
            }, { quoted: m });
        }

    } catch (err) {
        console.error("Error pada Message Handler:", err);
    }
}

// ====================================================================
// 9. KONEKSI UTAMA BOT (BAILEYS INITIALIZATION)
// ====================================================================
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    console.log(`Menggunakan Baileys v${version.join('.')}`);

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        auth: state,
        browser: [CONFIG.botName, 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi terputus. Mencoba menghubungkan ulang...', shouldReconnect);
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === 'open') {
            console.log('==================================================');
            console.log(` BOT BERHASIL TERHUBUNG DENGAN NOMOR: ${sock.user.id.split(':')[0]}`);
            console.log('==================================================');
        }
    });

    sock.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            const m = chatUpdate.messages[0];
            if (!m.message || m.key.fromMe) return;
            await handleMessages(sock, m);
        } catch (err) {
            console.error("Error Message Upsert:", err);
        }
    });
}

// Jalankan Bot
startBot();
