// =====================================================================
// SUPTel - Objednávkový systém - frontend
// Komunikuje so Supabase (schéma "objednavky"). Jediný spôsob vzniku
// objednávky je RPC funkcia create_order (pozri 03_security_and_functions.sql) -
// frontend teda nikdy nezapisuje priamo do tabuľky "orders".
// =====================================================================

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    db: { schema: SUPABASE_SCHEMA }
});

// ---------------------------------------------------------------------
// Globálny stav aplikácie
// ---------------------------------------------------------------------
const state = {
    user: null,
    profile: null,
    companies: [],       // firmy, na ktoré má používateľ právo
    templates: [],       // 5 šablón
    suppliers: [],        // databáza dodávateľov
    zakazky: [],          // aktívne zákazky
    zakazkyByLabel: new Map(),
    suppliersByLabel: new Map(),
    selectedCompany: null,   // objekt z companies
    selectedTemplate: null,  // objekt z order_templates
    lastOrder: null,
    lastItems: []
};

const PAYMENT_LABELS = {
    ucet: 'Na účet',
    hotovost: 'Hotovosť',
    kreditka: 'Kreditnou kartou',
    sekom: 'Šekom'
};

const UNIT_OPTIONS = ['ks', 'm', 'm2', 'm3', 'kg', 't', 'hod', 'kpl', 'súbor', 'l'];

// ---------------------------------------------------------------------
// Pomocné funkcie
// ---------------------------------------------------------------------
function el(id) { return document.getElementById(id); }

function formatMoney(value) {
    const n = Number(value) || 0;
    return n.toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function todayStr() {
    return new Date().toISOString().slice(0, 10);
}

function showError(message) {
    const banner = el('global-error');
    if (!message) {
        banner.classList.add('hidden');
        banner.textContent = '';
        return;
    }
    banner.textContent = message;
    banner.classList.remove('hidden');
}

function setFieldError(id, message) {
    const elm = el(id);
    if (elm) elm.textContent = message || '';
}

// =====================================================================
// PRIHLÁSENIE
// =====================================================================
el('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    el('login-button').disabled = true;
    el('login-error').classList.add('hidden');

    const email = el('login-email').value.trim();
    const password = el('login-password').value;

    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });

    el('login-button').disabled = false;

    if (error) {
        el('login-error').textContent = 'Prihlásenie sa nepodarilo: ' + error.message;
        el('login-error').classList.remove('hidden');
        return;
    }

    await onLoggedIn(data.user);
});

el('logout-button').addEventListener('click', async () => {
    await supabaseClient.auth.signOut();
    location.reload();
});

async function checkExistingSession() {
    const { data } = await supabaseClient.auth.getSession();
    if (data.session && data.session.user) {
        await onLoggedIn(data.session.user);
    }
}

async function onLoggedIn(user) {
    state.user = user;

    // Profil prihláseného používateľa (iniciály, stredisko, oprávnenia)
    const { data: profile, error: profileError } = await supabaseClient
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .single();

    if (profileError || !profile) {
        showLoginOnlyError(
            'Tento účet nemá v systéme vytvorený profil (tabuľka profiles). ' +
            'Kontaktujte administrátora, aby doplnil váš profil (meno, iniciály, stredisko, oprávnenia).'
        );
        return;
    }

    if (!profile.is_active) {
        showLoginOnlyError('Váš účet je v systéme deaktivovaný.');
        return;
    }

    state.profile = profile;

    el('login-view').classList.add('hidden');
    el('app-view').classList.remove('hidden');
    el('user-name').textContent = profile.full_name + ' (' + profile.initials + ')';

    await loadAppData();
}

function showLoginOnlyError(message) {
    el('login-view').classList.remove('hidden');
    el('app-view').classList.add('hidden');
    el('login-error').textContent = message;
    el('login-error').classList.remove('hidden');
    supabaseClient.auth.signOut();
}

// =====================================================================
// NAČÍTANIE ZÁKLADNÝCH DÁT (firmy, šablóny, dodávatelia, zákazky)
// =====================================================================
async function loadAppData() {
    showError(null);

    const [companiesRes, templatesRes, suppliersRes, zakazkyRes] = await Promise.all([
        supabaseClient.from('companies').select('*'),
        supabaseClient.from('order_templates').select('*').order('sort_order'),
        supabaseClient.from('suppliers').select('*').eq('is_active', true).order('name'),
        supabaseClient.from('zakazky').select('*').eq('aktivna', true).order('cislo')
    ]);

    if (companiesRes.error || templatesRes.error || suppliersRes.error || zakazkyRes.error) {
        showError('Nepodarilo sa načítať základné údaje. Skúste obnoviť stránku.');
        console.error(companiesRes.error, templatesRes.error, suppliersRes.error, zakazkyRes.error);
        return;
    }

    // Iba firmy, na ktoré má prihlásený používateľ právo
    state.companies = (companiesRes.data || []).filter(c =>
        (state.profile.allowed_company_codes || []).includes(c.code)
    );
    state.templates = templatesRes.data || [];
    state.suppliers = suppliersRes.data || [];
    state.zakazky = zakazkyRes.data || [];

    renderCompanyTiles();
    renderZakazkyDatalist();
    renderSuppliersDatalist();
}

// =====================================================================
// KROK 1: VÝBER FIRMY
// =====================================================================
function renderCompanyTiles() {
    const wrap = el('company-tiles');
    wrap.innerHTML = '';

    if (state.companies.length === 0) {
        wrap.innerHTML = '<p>Váš profil nemá povolenú žiadnu firmu. Kontaktujte administrátora.</p>';
        return;
    }

    state.companies.forEach(company => {
        const tile = document.createElement('div');
        tile.className = 'tile';
        tile.innerHTML = `${escapeHtml(company.name)}<small>${escapeHtml(company.code)}</small>`;
        tile.addEventListener('click', () => selectCompany(company, tile));
        wrap.appendChild(tile);
    });

    // Ak existuje len jedna firma, vyberie sa automaticky
    if (state.companies.length === 1) {
        selectCompany(state.companies[0], wrap.firstChild);
    }
}

function selectCompany(company, tileElm) {
    state.selectedCompany = company;

    document.querySelectorAll('#company-tiles .tile').forEach(t => t.classList.remove('selected'));
    if (tileElm) tileElm.classList.add('selected');

    el('step-template').classList.remove('hidden');
    renderTemplateTiles();

    // zrušiť prípadne už rozbehnutý formulár, ak používateľ zmenil firmu
    el('step-form').classList.add('hidden');
    state.selectedTemplate = null;
}

// =====================================================================
// KROK 2: VÝBER ŠABLÓNY
// =====================================================================
function renderTemplateTiles() {
    const wrap = el('template-tiles');
    wrap.innerHTML = '';

    state.templates.forEach(tpl => {
        const tile = document.createElement('div');
        tile.className = 'tile';
        tile.textContent = tpl.name;
        tile.addEventListener('click', () => selectTemplate(tpl, tile));
        wrap.appendChild(tile);
    });
}

function selectTemplate(tpl, tileElm) {
    state.selectedTemplate = tpl;

    document.querySelectorAll('#template-tiles .tile').forEach(t => t.classList.remove('selected'));
    if (tileElm) tileElm.classList.add('selected');

    el('step-form').classList.remove('hidden');
    el('step-result').classList.add('hidden');
    buildOrderForm(tpl);
    el('step-form').scrollIntoView({ behavior: 'smooth' });
}

el('back-to-template-button').addEventListener('click', () => {
    el('step-form').classList.add('hidden');
    document.querySelectorAll('#template-tiles .tile').forEach(t => t.classList.remove('selected'));
    state.selectedTemplate = null;
});

// =====================================================================
// KROK 3: FORMULÁR OBJEDNÁVKY
// =====================================================================
function buildOrderForm(tpl) {
    // Reset formulára
    el('order-form').reset();
    showError(null);
    ['err-zakazka', 'err-supplier', 'err-new-supplier', 'err-items', 'err-delivery-date']
        .forEach(id => setFieldError(id, ''));

    el('zakazka-input').value = '';
    el('zakazka-input').classList.remove('invalid');
    el('supplier-input').value = '';
    el('supplier-input').classList.remove('invalid');
    el('new-supplier-toggle').checked = false;
    el('new-supplier-fields').classList.add('hidden');

    // Predvyplnené texty zo šablóny
    el('intro-text').value = tpl.default_intro_text || '';

    if (tpl.billing_note) {
        el('billing-note-wrap').classList.remove('hidden');
        el('billing-note').value = tpl.billing_note;
    } else {
        el('billing-note-wrap').classList.add('hidden');
        el('billing-note').value = '';
    }

    if (tpl.default_attachment) {
        el('attachment-note-wrap').classList.remove('hidden');
        el('attachment-note').value = tpl.default_attachment;
    } else {
        el('attachment-note-wrap').classList.add('hidden');
        el('attachment-note').value = '';
    }

    // Minimálny dátum dodania = dnes
    el('delivery-date').min = todayStr();
    el('delivery-date').value = '';

    // Tabuľka položiek - hlavička podľa šablóny
    const head = el('items-head');
    if (tpl.show_quantity_columns) {
        head.innerHTML = '<th style="width:90px;">Počet</th><th style="width:90px;">Jedn.</th>' +
                          '<th>Popis</th><th style="width:120px;">Cena za jedn.</th>' +
                          '<th style="width:110px;">CELKEM</th><th style="width:30px;"></th>';
        el('items-total-row').classList.remove('hidden');
    } else {
        head.innerHTML = '<th>Popis</th><th style="width:30px;"></th>';
        el('items-total-row').classList.add('hidden');
    }

    el('items-body').innerHTML = '';
    addItemRow(); // jedna prázdna položka na začiatok
}

// ---------------------------------------------------------------------
// Položky objednávky
// ---------------------------------------------------------------------
function addItemRow() {
    const tpl = state.selectedTemplate;
    const tr = document.createElement('tr');

    if (tpl.show_quantity_columns) {
        tr.innerHTML = `
            <td><input type="number" step="0.001" min="0" class="item-qty" /></td>
            <td><input list="units-list" class="item-unit" /></td>
            <td><input type="text" class="item-desc" /></td>
            <td><input type="number" step="0.01" min="0" class="item-price" /></td>
            <td class="total-cell">0,00 €</td>
            <td><button type="button" class="danger remove-item">×</button></td>
        `;
    } else {
        tr.innerHTML = `
            <td><input type="text" class="item-desc" /></td>
            <td><button type="button" class="danger remove-item">×</button></td>
        `;
    }

    el('items-body').appendChild(tr);

    // doplniť spoločný datalist pre jednotky, ak ešte neexistuje
    if (!el('units-list')) {
        const dl = document.createElement('datalist');
        dl.id = 'units-list';
        dl.innerHTML = UNIT_OPTIONS.map(u => `<option value="${u}"></option>`).join('');
        document.body.appendChild(dl);
    }

    tr.querySelectorAll('.item-qty, .item-price').forEach(inp => {
        inp.addEventListener('input', () => recalcRow(tr));
    });

    tr.querySelector('.remove-item').addEventListener('click', () => {
        tr.remove();
        recalcTotal();
    });

    recalcRow(tr);
}

function recalcRow(tr) {
    const qtyInp = tr.querySelector('.item-qty');
    const priceInp = tr.querySelector('.item-price');
    const totalCell = tr.querySelector('.total-cell');

    if (qtyInp && priceInp && totalCell) {
        const qty = parseFloat(qtyInp.value) || 0;
        const price = parseFloat(priceInp.value) || 0;
        totalCell.textContent = formatMoney(qty * price);
    }
    recalcTotal();
}

function recalcTotal() {
    if (!state.selectedTemplate || !state.selectedTemplate.show_quantity_columns) {
        el('items-total-value').textContent = formatMoney(0);
        return;
    }
    let total = 0;
    document.querySelectorAll('#items-body tr').forEach(tr => {
        const qty = parseFloat(tr.querySelector('.item-qty')?.value) || 0;
        const price = parseFloat(tr.querySelector('.item-price')?.value) || 0;
        total += qty * price;
    });
    el('items-total-value').textContent = formatMoney(total);
}

el('add-item-button').addEventListener('click', addItemRow);

// =====================================================================
// ZÁKAZKY a DODÁVATELIA - datalisty + validácia výberu
// =====================================================================
function renderZakazkyDatalist() {
    const dl = el('zakazky-list');
    dl.innerHTML = '';
    state.zakazkyByLabel.clear();

    state.zakazky.forEach(z => {
        const label = `${z.cislo} - ${z.nazov}`;
        state.zakazkyByLabel.set(label, z);
        const opt = document.createElement('option');
        opt.value = label;
        dl.appendChild(opt);
    });
}

function renderSuppliersDatalist() {
    const dl = el('suppliers-list');
    dl.innerHTML = '';
    state.suppliersByLabel.clear();

    state.suppliers.forEach(s => {
        const label = `${s.name} (IČO ${s.ico || '—'})`;
        state.suppliersByLabel.set(label, s);
        const opt = document.createElement('option');
        opt.value = label;
        dl.appendChild(opt);
    });
}

function getSelectedZakazka() {
    const value = el('zakazka-input').value.trim();
    return state.zakazkyByLabel.get(value) || null;
}

function getSelectedSupplier() {
    const value = el('supplier-input').value.trim();
    return state.suppliersByLabel.get(value) || null;
}

el('zakazka-input').addEventListener('input', () => {
    el('zakazka-input').classList.remove('invalid');
    setFieldError('err-zakazka', '');
});

el('supplier-input').addEventListener('input', () => {
    el('supplier-input').classList.remove('invalid');
    setFieldError('err-supplier', '');
});

el('new-supplier-toggle').addEventListener('change', (e) => {
    if (e.target.checked) {
        el('new-supplier-fields').classList.remove('hidden');
        el('supplier-input').value = '';
        el('supplier-input').disabled = true;
        el('supplier-input').classList.remove('invalid');
        setFieldError('err-supplier', '');
    } else {
        el('new-supplier-fields').classList.add('hidden');
        el('supplier-input').disabled = false;
    }
});

// =====================================================================
// VALIDÁCIA A ODOSLANIE FORMULÁRA
// =====================================================================
el('order-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError(null);

    const tpl = state.selectedTemplate;
    let ok = true;

    // --- Zákazka ---
    const zakazka = getSelectedZakazka();
    if (!zakazka) {
        el('zakazka-input').classList.add('invalid');
        setFieldError('err-zakazka', 'Vyberte zákazku zo zoznamu (nedá sa zapísať voľný text).');
        ok = false;
    }

    // --- Dodávateľ ---
    const isNewSupplier = el('new-supplier-toggle').checked;
    let supplier = null;
    let newSupplierData = null;

    if (isNewSupplier) {
        const name = el('ns-name').value.trim();
        const ico = el('ns-ico').value.trim();
        const address = el('ns-address').value.trim();
        const city = el('ns-city').value.trim();

        if (!name || !ico || !address || !city) {
            setFieldError('err-new-supplier', 'Vyplňte aspoň Názov, IČO, Adresu a Mesto nového dodávateľa.');
            ok = false;
        } else if (!/^\d{6,12}$/.test(ico)) {
            setFieldError('err-new-supplier', 'IČO musí obsahovať len číslice (6-12 znakov).');
            ok = false;
        } else {
            setFieldError('err-new-supplier', '');
            newSupplierData = {
                name, ico, address, city,
                zip: el('ns-zip').value.trim() || null,
                dic: el('ns-dic').value.trim() || null,
                contact_person: el('ns-contact').value.trim() || null,
                phone: el('ns-phone').value.trim() || null,
                created_by: state.profile.id
            };
        }
    } else {
        supplier = getSelectedSupplier();
        if (!supplier) {
            el('supplier-input').classList.add('invalid');
            setFieldError('err-supplier', 'Vyberte dodávateľa zo zoznamu, alebo zaškrtnite "Nový dodávateľ".');
            ok = false;
        }
    }

    // --- Položky ---
    const items = [];
    document.querySelectorAll('#items-body tr').forEach(tr => {
        const desc = tr.querySelector('.item-desc').value.trim();
        if (!desc) return; // prázdne riadky ignorujeme
        const item = { description: desc };

        if (tpl.show_quantity_columns) {
            const qtyVal = tr.querySelector('.item-qty').value;
            const priceVal = tr.querySelector('.item-price').value;
            const unitVal = tr.querySelector('.item-unit').value.trim();

            item.quantity = qtyVal === '' ? null : parseFloat(qtyVal);
            item.unit_price = priceVal === '' ? null : parseFloat(priceVal);
            item.unit = unitVal || null;

            if (item.quantity !== null && item.quantity < 0) ok = false;
            if (item.unit_price !== null && item.unit_price < 0) ok = false;
        } else {
            item.quantity = null;
            item.unit_price = null;
            item.unit = null;
        }
        items.push(item);
    });

    if (items.length === 0) {
        setFieldError('err-items', 'Objednávka musí obsahovať aspoň jednu položku s popisom.');
        ok = false;
    } else {
        setFieldError('err-items', '');
    }

    // --- Dátum dodania ---
    const deliveryDateVal = el('delivery-date').value;
    if (deliveryDateVal && deliveryDateVal < todayStr()) {
        setFieldError('err-delivery-date', 'Dátum dodania nesmie byť v minulosti.');
        ok = false;
    } else {
        setFieldError('err-delivery-date', '');
    }

    if (!ok) return;

    // --- Odoslanie ---
    el('submit-order-button').disabled = true;
    try {
        let supplierId = null;
        let supplierSnapshot = null;

        if (isNewSupplier) {
            const { data: inserted, error: insertError } = await supabaseClient
                .from('suppliers')
                .insert(newSupplierData)
                .select()
                .single();

            if (insertError) {
                if (insertError.message && insertError.message.includes('suppliers_ico_unique_idx')) {
                    showError('Dodávateľ s týmto IČO už v databáze existuje - vyhľadajte ho v poli "Dodávateľ" namiesto vytvárania nového.');
                } else {
                    showError('Nepodarilo sa uložiť nového dodávateľa: ' + insertError.message);
                }
                el('submit-order-button').disabled = false;
                return;
            }
            supplier = inserted;
            supplierId = inserted.id;
            state.suppliers.push(inserted);
            renderSuppliersDatalist();
        } else {
            supplierId = supplier.id;
        }

        supplierSnapshot = {
            name: supplier.name,
            address: supplier.address,
            zip: supplier.zip,
            city: supplier.city,
            ico: supplier.ico,
            dic: supplier.dic,
            contact_person: supplier.contact_person,
            phone: supplier.phone,
            email: supplier.email
        };

        const payload = {
            p_company_code: state.selectedCompany.code,
            p_template_code: tpl.code,
            p_zakazka_cislo: zakazka.cislo,
            p_supplier_id: supplierId,
            p_supplier_snapshot: supplierSnapshot,
            p_intro_text: el('intro-text').value.trim() || null,
            p_billing_note: el('billing-note').value.trim() || null,
            p_attachment_note: el('attachment-note').value.trim() || null,
            p_delivery_date: deliveryDateVal || null,
            p_payment_method: document.querySelector('input[name="payment"]:checked').value,
            p_doprava: el('doprava').value.trim() || null,
            p_sprava: el('sprava').value.trim() || null,
            p_note: el('note').value.trim() || null,
            p_items: items
        };

        const { data: order, error: orderError } = await supabaseClient.rpc('create_order', payload);

        if (orderError) {
            showError('Objednávku sa nepodarilo uložiť: ' + orderError.message);
            el('submit-order-button').disabled = false;
            return;
        }

        const { data: orderItems } = await supabaseClient
            .from('order_items')
            .select('*')
            .eq('order_id', order.id)
            .order('position');

        state.lastOrder = order;
        state.lastItems = orderItems || [];

        showResult(order);
    } finally {
        el('submit-order-button').disabled = false;
    }
});

// =====================================================================
// KROK 4: VÝSLEDOK
// =====================================================================
function showResult(order) {
    el('step-form').classList.add('hidden');
    el('step-result').classList.remove('hidden');
    el('result-banner').textContent = `Objednávka č. ${order.order_number} bola vystavená.`;
    el('step-result').scrollIntoView({ behavior: 'smooth' });
}

el('new-order-button').addEventListener('click', () => {
    location.reload();
});

// =====================================================================
// EXPORT DO EXCELU
// =====================================================================
el('export-excel-button').addEventListener('click', () => {
    const order = state.lastOrder;
    const items = state.lastItems;
    const company = state.selectedCompany;
    const supplier = order.supplier_snapshot;
    const profile = state.profile;

    const ws = XLSX.utils.aoa_to_sheet([]);

    function set(addr, value) {
        ws[addr] = { v: value, t: typeof value === 'number' ? 'n' : 's' };
    }

    set('A1', company.name);
    set('A2', company.address);
    set('A3', `${company.zip} ${company.city}`);
    set('A4', `email: ${company.email}`);
    set('A5', `IČO: ${company.ico}   DIČ: ${company.dic}`);

    set('F1', `Objednávka č. ${order.order_number}`);
    set('A7', 'OBJEDNÁVKA');

    set('A9', 'Dodávateľ');
    set('F9', 'Odberateľ');

    const rows = [
        ['Meno', supplier.name, company.name],
        ['Adresa', supplier.address, company.address],
        ['PSČ / Mesto', `${supplier.zip || ''} ${supplier.city || ''}`.trim(), `${company.zip} ${company.city}`],
        ['Vybavuje', supplier.contact_person || '', profile.full_name],
        ['Telefón', supplier.phone || '', profile.phone || ''],
        ['IČO', supplier.ico || '', company.ico],
        ['DIČ', supplier.dic || '', company.dic]
    ];

    rows.forEach((row, i) => {
        const r = 10 + i;
        set(`A${r}`, row[0]);
        set(`B${r}`, row[1]);
        set(`F${r}`, row[0]);
        set(`G${r}`, row[2]);
    });

    set('A18', 'Zákazka: ' + order.zakazka_cislo);
    set('A19', order.intro_text || '');

    const tpl = state.templates.find(t => t.code === order.template_code) || {};
    let headerRow = 21;

    if (tpl.show_quantity_columns) {
        set(`A${headerRow}`, 'Počet');
        set(`B${headerRow}`, 'Jedn.');
        set(`C${headerRow}`, 'Popis');
        set(`D${headerRow}`, 'Cena za jedn.');
        set(`E${headerRow}`, 'CELKEM');
    } else {
        set(`A${headerRow}`, 'Popis');
    }

    let r = headerRow + 1;
    items.forEach(it => {
        if (tpl.show_quantity_columns) {
            set(`A${r}`, it.quantity != null ? Number(it.quantity) : '');
            set(`B${r}`, it.unit || '');
            set(`C${r}`, it.description);
            set(`D${r}`, it.unit_price != null ? Number(it.unit_price) : '');
            set(`E${r}`, it.line_total != null ? Number(it.line_total) : '');
        } else {
            set(`A${r}`, it.description);
        }
        r++;
    });

    if (tpl.show_quantity_columns) {
        set(`D${r}`, 'CELKEM');
        set(`E${r}`, Number(order.total_amount));
        r++;
    }

    r += 1;
    if (order.billing_note) { set(`A${r}`, order.billing_note); r++; }
    if (order.attachment_note) { set(`A${r}`, 'Prílohy: ' + order.attachment_note); r++; }

    r += 1;
    set(`A${r}`, 'Spôsob platby: ' + (PAYMENT_LABELS[order.payment_method] || order.payment_method));
    r++;
    set(`A${r}`, 'Dátum objednávky: ' + order.order_date);
    r++;
    if (order.delivery_date) { set(`A${r}`, 'Dátum dodania: ' + order.delivery_date); r++; }
    if (order.doprava) { set(`A${r}`, 'Doprava: ' + order.doprava); r++; }
    if (order.sprava) { set(`A${r}`, 'Správa: ' + order.sprava); r++; }
    if (order.note) { set(`A${r}`, 'Poznámky: ' + order.note); r++; }

    ws['!ref'] = `A1:G${r + 1}`;
    ws['!cols'] = [
        { wch: 14 }, { wch: 32 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 2 }, { wch: 30 }
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Objednávka');

    const filename = `Objednavka_${order.order_number.replace(/\//g, '-')}.xlsx`;
    XLSX.writeFile(wb, filename);
});

// =====================================================================
// TLAČ / PDF
// =====================================================================
el('print-button').addEventListener('click', () => {
    const order = state.lastOrder;
    const items = state.lastItems;
    const company = state.selectedCompany;
    const supplier = order.supplier_snapshot;
    const profile = state.profile;
    const tpl = state.templates.find(t => t.code === order.template_code) || {};

    let itemsHtml = '';
    if (tpl.show_quantity_columns) {
        itemsHtml += '<table><thead><tr><th>Počet</th><th>Jedn.</th><th>Popis</th><th>Cena za jedn.</th><th>CELKEM</th></tr></thead><tbody>';
        items.forEach(it => {
            itemsHtml += `<tr><td>${it.quantity ?? ''}</td><td>${escapeHtml(it.unit || '')}</td><td>${escapeHtml(it.description)}</td>` +
                `<td>${it.unit_price != null ? formatMoney(it.unit_price) : ''}</td><td>${it.line_total != null ? formatMoney(it.line_total) : ''}</td></tr>`;
        });
        itemsHtml += `<tr><td colspan="4" style="text-align:right;font-weight:bold;">CELKEM</td><td style="font-weight:bold;">${formatMoney(order.total_amount)}</td></tr>`;
        itemsHtml += '</tbody></table>';
    } else {
        itemsHtml += '<table><thead><tr><th>Popis</th></tr></thead><tbody>';
        items.forEach(it => {
            itemsHtml += `<tr><td>${escapeHtml(it.description)}</td></tr>`;
        });
        itemsHtml += '</tbody></table>';
    }

    el('print-area').innerHTML = `
        <h1>${escapeHtml(company.name)}</h1>
        <p>${escapeHtml(company.address)}, ${escapeHtml(company.zip)} ${escapeHtml(company.city)}<br/>
        IČO: ${escapeHtml(company.ico)} DIČ: ${escapeHtml(company.dic)} email: ${escapeHtml(company.email)}</p>
        <h2>OBJEDNÁVKA č. ${escapeHtml(order.order_number)}</h2>
        <table>
            <tr><th>Dodávateľ</th><th>Odberateľ</th></tr>
            <tr>
                <td>
                    ${escapeHtml(supplier.name)}<br/>
                    ${escapeHtml(supplier.address)}<br/>
                    ${escapeHtml(supplier.zip || '')} ${escapeHtml(supplier.city || '')}<br/>
                    Vybavuje: ${escapeHtml(supplier.contact_person || '')}<br/>
                    Telefón: ${escapeHtml(supplier.phone || '')}<br/>
                    IČO: ${escapeHtml(supplier.ico || '')} DIČ: ${escapeHtml(supplier.dic || '')}
                </td>
                <td>
                    ${escapeHtml(company.name)}<br/>
                    ${escapeHtml(company.address)}<br/>
                    ${escapeHtml(company.zip)} ${escapeHtml(company.city)}<br/>
                    Vybavuje: ${escapeHtml(profile.full_name)}<br/>
                    Telefón: ${escapeHtml(profile.phone || '')}<br/>
                    IČO: ${escapeHtml(company.ico)} DIČ: ${escapeHtml(company.dic)}
                </td>
            </tr>
        </table>
        <p><strong>Zákazka:</strong> ${escapeHtml(order.zakazka_cislo)}</p>
        <p>${escapeHtml(order.intro_text || '').replace(/\n/g, '<br/>')}</p>
        ${itemsHtml}
        ${order.billing_note ? `<p>${escapeHtml(order.billing_note)}</p>` : ''}
        ${order.attachment_note ? `<p><strong>Prílohy:</strong> ${escapeHtml(order.attachment_note)}</p>` : ''}
        <p>
            Spôsob platby: ${escapeHtml(PAYMENT_LABELS[order.payment_method] || order.payment_method)}<br/>
            Dátum objednávky: ${escapeHtml(order.order_date)}<br/>
            ${order.delivery_date ? 'Dátum dodania: ' + escapeHtml(order.delivery_date) + '<br/>' : ''}
            ${order.doprava ? 'Doprava: ' + escapeHtml(order.doprava) + '<br/>' : ''}
            ${order.sprava ? 'Správa: ' + escapeHtml(order.sprava) + '<br/>' : ''}
        </p>
        ${order.note ? `<p><strong>Poznámky:</strong> ${escapeHtml(order.note)}</p>` : ''}
    `;

    window.print();
});

// ---------------------------------------------------------------------
function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// =====================================================================
// START
// =====================================================================
checkExistingSession();
