import os
import json
import telebot
from telebot import types

# --- KONFIGURASI DASAR ---
API_TOKEN = os.getenv('TELEGRAM_TOKEN')
ADMIN_ID = int(os.getenv('ADMIN_ID'))
bot = telebot.TeleBot(API_TOKEN)

# --- DATABASE PRODUK (JSON) ---
DB_FILE = 'products.json'
STATE_FILE = 'user_state.json'  # Simpan cart & progress checkout pembeli

def load_json(path):
    if os.path.exists(path):
        with open(path, 'r') as f:
            return json.load(f)
    return {}

def save_json(path, data):
    with open(path, 'w') as f:
        json.dump(data, f, indent=4)

def save_products(data):
    """Simpan data produk ke JSON. Menerima parameter agar tidak bergantung global."""
    save_json(DB_FILE, data)

def save_user_state():
    """Simpan cart & progress checkout pembeli, agar tidak hilang saat bot restart/sleep."""
    save_json(STATE_FILE, user_state)

PRODUK = load_json(DB_FILE)
# JSON keys selalu string, jadi key chat_id (int) akan jadi string setelah load.
# Kita normalisasi balik ke int agar konsisten dengan pemakaian chat_id di kode.
_raw_state = load_json(STATE_FILE)
user_state = {int(k): v for k, v in _raw_state.items()}

# --- STATE MANAGEMENT ---
# user_state: persistent (cart + checkout progress pembeli)
# admin_state, temp_data: sengaja tetap di RAM (cuma progress form admin, low-risk kalau reset)
admin_state = {}
temp_data = {}

# --- HELPER FUNCTIONS ---
def format_rupiah(angka):
    return "Rp " + "{:,.0f}".format(angka).replace(",", ".")

def is_admin(user_id):
    return user_id == ADMIN_ID

def get_next_product_id():
    """Generate ID produk berikutnya berdasarkan max ID yang ada."""
    if not PRODUK:
        return "1"
    max_id = max(int(k) for k in PRODUK.keys())
    return str(max_id + 1)

# ==========================================
# MENU UTAMA PEMBELI
# ==========================================
@bot.message_handler(commands=['start', 'help'])
def send_welcome(message):
    markup = types.InlineKeyboardMarkup(row_width=1)
    markup.add(
        types.InlineKeyboardButton("🛍️ Katalog Produk", callback_data="cat_open"),
        types.InlineKeyboardButton("🛒 Keranjang Saya", callback_data="cart_open")
    )
    if is_admin(message.from_user.id):
        markup.add(types.InlineKeyboardButton("⚙️ Panel Admin", callback_data="adm_menu"))

    bot.send_message(message.chat.id, 
        f"<b>Halo {message.from_user.first_name}! 👋</b>\n\n"
        "Selamat datang di toko kami. Silakan pilih menu di bawah ini:", 
        reply_markup=markup, parse_mode="HTML")

# ==========================================
# HANDLER TOMBOL (ROUTING)
# ==========================================
@bot.callback_query_handler(func=lambda call: True)
def callback_handler(call):
    chat_id = call.message.chat.id
    msg_id = call.message.message_id
    user_id = call.from_user.id  # ✅ FIX: dipakai untuk cek admin, bukan chat_id
    data = call.data

    # --- ROUTING HOME ---
    if data == "home":
        send_welcome(call.message)
        bot.answer_callback_query(call.id, "Kembali ke menu utama")

    # --- ROUTING KATALOG ---
    elif data == "cat_open":
        show_catalog(chat_id, msg_id)
    elif data.startswith("cat_add_"):
        add_to_cart(chat_id, call, data.split("_")[2])
    elif data == "cart_open":
        show_cart(chat_id, msg_id)
    elif data.startswith("cart_inc_"):
        update_cart_qty(chat_id, call, data.split("_")[2], 1)
    elif data.startswith("cart_dec_"):
        update_cart_qty(chat_id, call, data.split("_")[2], -1)
    elif data == "cart_clear":
        clear_cart(chat_id, call)
    elif data == "checkout_start":
        start_checkout(chat_id, call)

    # --- ROUTING ADMIN ---
    elif data == "adm_menu":
        if not is_admin(user_id): return bot.answer_callback_query(call.id, "Akses Ditolak!")  # ✅ FIX
        show_admin_menu(chat_id, msg_id)
    elif data == "adm_add_start":
        if not is_admin(user_id): return bot.answer_callback_query(call.id, "Akses Ditolak!")  # ✅ FIX
        admin_state[chat_id] = "await_name"
        bot.send_message(chat_id, "✏️ <b>TAMBAH PRODUK BARU</b>\n\nSilakan ketik <b>Nama Produk</b>:", parse_mode="HTML")
        bot.answer_callback_query(call.id, "Mode tambah produk aktif!")
    elif data == "adm_del_list":
        if not is_admin(user_id): return bot.answer_callback_query(call.id, "Akses Ditolak!")  # ✅ FIX
        show_admin_delete_list(chat_id, msg_id)
    elif data.startswith("adm_del_"):
        if not is_admin(user_id): return bot.answer_callback_query(call.id, "Akses Ditolak!")  # ✅ FIX
        delete_product(chat_id, call, data.split("_")[2])
    elif data == "adm_back":
        if not is_admin(user_id): return bot.answer_callback_query(call.id, "Akses Ditolak!")  # ✅ FIX
        show_admin_menu(chat_id, msg_id)

# ==========================================
# LOGIKA KATALOG & KERANJANG (PEMBELI)
# ==========================================
def show_catalog(chat_id, msg_id):
    markup = types.InlineKeyboardMarkup(row_width=1)
    text = "<b>🛍️ KATALOG PRODUK</b>\n\nPilih produk favorit Anda:\n\n"
    
    if not PRODUK:
        text += "<i>Maaf, produk sedang kosong.</i>"
    else:
        for id_p, p in PRODUK.items():
            stok_info = f"(Stok: {p['stok']})" if p['stok'] > 0 else "<b>(HABIS)</b>"
            text += f"• <b>{p['nama']}</b> - {format_rupiah(p['harga'])} {stok_info}\n"
            if p['stok'] > 0:
                markup.add(types.InlineKeyboardButton(f"➕ Tambah ke Keranjang", callback_data=f"cat_add_{id_p}"))
            
    markup.add(types.InlineKeyboardButton("🛒 Lihat Keranjang", callback_data="cart_open"))
    markup.add(types.InlineKeyboardButton("🏠 Menu Utama", callback_data="home"))
    
    try: bot.edit_message_text(text, chat_id, msg_id, reply_markup=markup, parse_mode="HTML")
    except: pass

def add_to_cart(chat_id, call, prod_id):
    if prod_id not in PRODUK: 
        bot.answer_callback_query(call.id, "❌ Produk tidak ditemukan!")
        return
    
    prod = PRODUK[prod_id]
    
    # Cek stok
    if prod['stok'] <= 0:
        bot.answer_callback_query(call.id, "❌ Maaf, stok produk ini habis!")
        return
    
    if chat_id not in user_state: 
        user_state[chat_id] = {'cart': {}}
    
    cart = user_state[chat_id]['cart']
    current_qty = cart.get(prod_id, 0)
    
    # Cek apakah qty di keranjang sudah mencapai stok
    if current_qty >= prod['stok']:
        bot.answer_callback_query(call.id, f"❌ Stok hanya tersisa {prod['stok']}!")
        return
    
    cart[prod_id] = current_qty + 1
    save_user_state()  # ✅ persist
    bot.answer_callback_query(call.id, f"✅ {prod['nama']} ditambahkan!")

def show_cart(chat_id, msg_id):
    cart = user_state.get(chat_id, {}).get('cart', {})
    markup = types.InlineKeyboardMarkup(row_width=1)
    
    if not cart:
        bot.edit_message_text("🛒 Keranjang Anda masih kosong.\nYuk mulai belanja!", chat_id, msg_id)
        return

    text = "<b>🛒 KERANJANG BELANJA</b>\n\n"
    total = 0
    
    # Buat list item yang valid, skip yang produknya sudah dihapus
    valid_items = []
    removed_any = False
    for id_p, qty in list(cart.items()):  # Pakai list() agar bisa modify cart di loop
        if id_p not in PRODUK:
            # Produk sudah dihapus admin, hapus dari cart
            del cart[id_p]
            removed_any = True
            continue
        valid_items.append((id_p, qty))
    
    if removed_any:
        save_user_state()  # ✅ persist perubahan cart
    
    if not valid_items:
        bot.edit_message_text("🛒 Keranjang Anda kosong (produk sudah tidak tersedia).", chat_id, msg_id)
        return
    
    for id_p, qty in valid_items:
        p = PRODUK[id_p]
        sub = p['harga'] * qty
        total += sub
        text += f"• <b>{p['nama']}</b>\n  {qty} x {format_rupiah(p['harga'])} = {format_rupiah(sub)}\n\n"
        
        markup.add(
            types.InlineKeyboardButton("➖", callback_data=f"cart_dec_{id_p}"),
            types.InlineKeyboardButton(f"{qty}", callback_data="ignore"),
            types.InlineKeyboardButton("➕", callback_data=f"cart_inc_{id_p}")
        )

    text += f"\n<b>TOTAL: {format_rupiah(total)}</b>"
    
    markup.add(types.InlineKeyboardButton("💳 Checkout", callback_data="checkout_start"))
    markup.add(types.InlineKeyboardButton("🗑️ Kosongkan Keranjang", callback_data="cart_clear"))
    markup.add(types.InlineKeyboardButton("🛍️ Lanjut Belanja", callback_data="cat_open"))

    try: bot.edit_message_text(text, chat_id, msg_id, reply_markup=markup, parse_mode="HTML")
    except: pass

def update_cart_qty(chat_id, call, prod_id, change):
    cart = user_state.get(chat_id, {}).get('cart', {})
    
    # Cek apakah produk masih ada
    if prod_id not in PRODUK:
        bot.answer_callback_query(call.id, "❌ Produk sudah tidak tersedia!")
        if prod_id in cart:
            del cart[prod_id]
            save_user_state()  # ✅ persist
        show_cart(chat_id, call.message.message_id)
        return
    
    if prod_id in cart:
        new_qty = cart[prod_id] + change
        
        # Cek stok saat menambah
        if change > 0 and new_qty > PRODUK[prod_id]['stok']:
            bot.answer_callback_query(call.id, f"❌ Stok hanya tersisa {PRODUK[prod_id]['stok']}!")
            return
        
        if new_qty <= 0:
            del cart[prod_id]
        else:
            cart[prod_id] = new_qty
        save_user_state()  # ✅ persist
    show_cart(chat_id, call.message.message_id)
    bot.answer_callback_query(call.id, "Keranjang diperbarui!")

def clear_cart(chat_id, call):
    if chat_id in user_state: user_state[chat_id]['cart'] = {}
    save_user_state()  # ✅ persist
    show_cart(chat_id, call.message.message_id)
    bot.answer_callback_query(call.id, "Keranjang dikosongkan!")

# ==========================================
# LOGIKA CHECKOUT
# ==========================================
def start_checkout(chat_id, call):
    cart = user_state.get(chat_id, {}).get('cart', {})
    if not cart: return bot.answer_callback_query(call.id, "Keranjang kosong!")
    
    user_state[chat_id]['step'] = 'ask_name'
    save_user_state()  # ✅ persist
    bot.send_message(chat_id, "💳 <b>CHECKOUT</b>\n\nSilakan ketik <b>Nama Lengkap</b> Anda:", parse_mode="HTML")
    bot.answer_callback_query(call.id, "Lanjut ke checkout!")

@bot.message_handler(func=lambda m: user_state.get(m.chat.id, {}).get('step'))
def handle_checkout_text(message):
    chat_id = message.chat.id
    step = user_state[chat_id]['step']
    
    if 'data' not in user_state[chat_id]: user_state[chat_id]['data'] = {}

    if step == 'ask_name':
        user_state[chat_id]['data']['nama'] = message.text
        user_state[chat_id]['step'] = 'ask_address'
        save_user_state()  # ✅ persist
        bot.send_message(chat_id, "✅ Nama diterima.\n\nSekarang ketik <b>Alamat Lengkap</b> (beserta Kode Pos):", parse_mode="HTML")
    elif step == 'ask_address':
        user_state[chat_id]['data']['alamat'] = message.text
        user_state[chat_id]['step'] = 'ask_phone'
        save_user_state()  # ✅ persist
        bot.send_message(chat_id, "✅ Alamat diterima.\n\nTerakhir, ketik <b>Nomor WhatsApp/HP</b> yang aktif:")
    elif step == 'ask_phone':
        user_state[chat_id]['data']['hp'] = message.text
        save_user_state()  # ✅ persist sebelum proses invoice
        process_invoice(chat_id)

def process_invoice(chat_id):
    data = user_state[chat_id]['data']
    cart = user_state[chat_id]['cart']
    
    total = 0
    detail = ""
    
    # Validasi stok lagi sebelum proses (untuk handle race condition)
    for id_p, qty in list(cart.items()):
        if id_p not in PRODUK:
            bot.send_message(chat_id, f"❌ Produk dengan ID {id_p} sudah tidak tersedia.")
            user_state[chat_id] = {'cart': {}}
            save_user_state()  # ✅ persist
            return
        if PRODUK[id_p]['stok'] < qty:
            bot.send_message(chat_id, f"❌ Stok {PRODUK[id_p]['nama']} tidak cukup! Tersisa: {PRODUK[id_p]['stok']}")
            user_state[chat_id] = {'cart': {}}
            save_user_state()  # ✅ persist
            return
    
    # Hitung total & kurangi stok
    for id_p, qty in cart.items():
        p = PRODUK[id_p]
        sub = p['harga'] * qty
        total += sub
        detail += f"• {p['nama']} (x{qty}) = {format_rupiah(sub)}\n"
        
        # Kurangi stok
        PRODUK[id_p]['stok'] -= qty
    
    # Simpan perubahan stok ke database
    save_products(PRODUK)

    msg_buyer = (
        f"🧾 <b>INVOICE PESANAN</b>\n\n"
        f"Terima kasih <b>{data['nama']}</b>!\n\n"
        f"<b>Detail Barang:</b>\n{detail}\n"
        f"<b>Total Tagihan: {format_rupiah(total)}</b>\n\n"
        f"<b>Data Pengiriman:</b>\n"
        f"Alamat: {data['alamat']}\nHP: {data['hp']}\n\n"
        f"💳 <b>Silakan transfer ke:</b>\n"
        f"BCA: 1234567890 (a.n Nama Anda)\n\n"
        f"⚠️ Setelah transfer, balas pesan ini dengan <b>Bukti Transfer</b>."
    )
    bot.send_message(chat_id, msg_buyer, parse_mode="HTML")

    msg_admin = (
        f"🚨 <b>PESANAN BARU!</b>\n\n"
        f"<b>Pembeli:</b> {data['nama']}\n"
        f"<b>HP/WA:</b> {data['hp']}\n"
        f"<b>Alamat:</b> {data['alamat']}\n\n"
        f"<b>Barang:</b>\n{detail}\n"
        f"<b>TOTAL: {format_rupiah(total)}</b>"
    )
    bot.send_message(ADMIN_ID, msg_admin, parse_mode="HTML")

    user_state[chat_id] = {'cart': {}}
    save_user_state()  # ✅ persist

# ==========================================
# LOGIKA ADMIN PANEL
# ==========================================
def show_admin_menu(chat_id, msg_id):
    markup = types.InlineKeyboardMarkup(row_width=2)
    markup.add(
        types.InlineKeyboardButton("➕ Tambah Produk", callback_data="adm_add_start"),
        types.InlineKeyboardButton("🗑️ Hapus Produk", callback_data="adm_del_list")
    )
    bot.edit_message_text("⚙️ <b>PANEL ADMIN</b>\n\nKelola produk toko Anda:", chat_id, msg_id, reply_markup=markup, parse_mode="HTML")

def show_admin_delete_list(chat_id, msg_id):
    markup = types.InlineKeyboardMarkup(row_width=1)
    text = "<b>🗑️ HAPUS PRODUK</b>\n\nPilih produk yang ingin dihapus:\n\n"
    
    if not PRODUK:
        text += "<i>Tidak ada produk.</i>"
    else:
        for id_p, p in PRODUK.items():
            text += f"• {p['nama']} ({format_rupiah(p['harga'])})\n"
            markup.add(types.InlineKeyboardButton(f"🗑️ Hapus: {p['nama']}", callback_data=f"adm_del_{id_p}"))
            
    markup.add(types.InlineKeyboardButton("🔙 Kembali", callback_data="adm_menu"))
    try: bot.edit_message_text(text, chat_id, msg_id, reply_markup=markup, parse_mode="HTML")
    except: pass

def delete_product(chat_id, call, prod_id):
    if prod_id in PRODUK:
        nama = PRODUK[prod_id]['nama']
        del PRODUK[prod_id]
        save_products(PRODUK)
        bot.answer_callback_query(call.id, f"✅ {nama} berhasil dihapus!")
        show_admin_delete_list(chat_id, call.message.message_id)
    else:
        bot.answer_callback_query(call.id, "Produk tidak ditemukan!")

@bot.message_handler(func=lambda m: admin_state.get(m.chat.id) and is_admin(m.from_user.id))
def handle_admin_add(m):
    chat_id = m.chat.id
    state = admin_state[chat_id]
    
    if chat_id not in temp_data: 
        temp_data[chat_id] = {}

    if state == 'await_name':
        temp_data[chat_id]['nama'] = m.text
        admin_state[chat_id] = 'await_price'
        bot.send_message(chat_id, "✅ Nama diterima.\n\nSekarang ketik <b>Harga</b> (angka saja, misal: 50000):", parse_mode="HTML")
    elif state == 'await_price':
        try:
            temp_data[chat_id]['harga'] = int(m.text)
            admin_state[chat_id] = 'await_stock'
            bot.send_message(chat_id, "✅ Harga diterima.\n\nKetik <b>Stok</b> awal (angka):")
        except ValueError:
            bot.send_message(chat_id, "❌ Format harga salah! Masukkan angka saja.")
    elif state == 'await_stock':
        try:
            temp_data[chat_id]['stok'] = int(m.text)
            
            new_id = get_next_product_id()
                    
            PRODUK[new_id] = {
                'nama': temp_data[chat_id]['nama'],
                'harga': temp_data[chat_id]['harga'],
                'stok': temp_data[chat_id]['stok']
            }
            save_products(PRODUK)
            
            bot.send_message(chat_id, f"🎉 <b>Produk Berhasil Ditambahkan!</b>\n\nNama: {temp_data[chat_id]['nama']}\nHarga: {format_rupiah(temp_data[chat_id]['harga'])}\nStok: {temp_data[chat_id]['stok']}", parse_mode="HTML")
            
            admin_state.pop(chat_id, None)
            temp_data.pop(chat_id, None)
        except ValueError:
            bot.send_message(chat_id, "❌ Format stok salah! Masukkan angka saja.")

if __name__ == '__main__':
    print("Bot Premium sedang berjalan...")
    bot.infinity_polling()
