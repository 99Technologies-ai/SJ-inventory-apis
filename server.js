require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const csv = require('csv-parser');
const xml2js = require('xml2js')
const ebay = require('./ebay-service');
const { Rembg } = require('@xixiyahaha/rembg-node');
const sharp = require('sharp');

// ★ PATCH #1 — Process-level error handlers.
//   Without these, any uncaught exception or unhandled promise rejection
//   kills the entire Node process. With them, errors are logged and the
//   server keeps running.
process.on('uncaughtException', (err, origin) => {
    console.error('🔥 [uncaughtException]', origin, '\n', err);
    // Do NOT exit — log and stay alive.
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 [unhandledRejection]', reason);
});

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));
app.use(cors());

// --- DATABASE ---
// ★ PATCH #2 — Pool sizing + timeouts + error handler.
//   The pool.on('error') listener is the single most important fix:
//   without it, an idle pg connection drop (which happens routinely
//   after 8-24 hours of uptime) emits an unhandled 'error' event and
//   crashes the process. With it, the bad client is discarded and the
//   pool moves on.
const pool = new Pool({
    user:                    process.env.DB_USER,
    host:                    process.env.DB_HOST,
    database:                process.env.DB_NAME,
    password:                process.env.DB_PASS,
    port:                    5432,
    max:                     20,
    idleTimeoutMillis:       30000,
    connectionTimeoutMillis: 5000,
    statement_timeout:       30000,
});

pool.on('error', (err, client) => {
    console.error('🔥 [pg pool error on idle client]', err);
    // Pool auto-removes the broken client. Don't crash.
});

pool.on('connect', (client) => {
    client.on('error', (err) => {
        console.error('🔥 [pg client error]', err);
    });
});

// --- FILE STORAGE ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const userId = req.user ? req.user.id : 'anonymous';
        const dir = `./uploads/products/${userId}`;
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});
const upload = multer({ storage });
app.use('/files', express.static('uploads'));

const PORT = process.env.MODE == "production" ? 3002 : 3006;
const BASE_URL = process.env.MODE == "production" ? 'https://api.sj.99technologies.com' : `http://localhost:3006`;
const TRADING_API = 'https://api.ebay.com/ws/api.dll';
const WEBHOOK_URL= process.env.MODE == "production" ? BASE_URL : "https://surround-enlighten-dagger.ngrok-free.dev";


// --- AUTH MIDDLEWARE ---
const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.sendStatus(401);
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') return res.sendStatus(401);
    jwt.verify(parts[1], process.env.JWT_SECRET, (err, authData) => {
        if (err) return res.sendStatus(403);
        req.user = authData;
        next();
    });
};
const verifyAdmin = (req, res, next) => {
    if (!req.user || req.user.role !== 'Admin') return res.status(403).json({ error: "Admins only." });
    next();
};

// ★ PATCH #3 — Async route wrapper.
//   Wrap any async route handler to ensure thrown errors / rejected
//   promises reach the Express error middleware (PATCH #5) instead of
//   becoming silent UnhandledPromiseRejections. Most existing routes
//   already have try/catch — this is a defence-in-depth helper.
//   Usage:  app.get('/foo', verifyToken, asyncHandler(async (req, res) => { ... }));
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

function calculateHash(buffer) {
    return crypto.createHash('md5').update(buffer).digest('hex');
}

function findExistingFile(folderPath, targetHash) {
    if (!fs.existsSync(folderPath)) return null;
    for (const file of fs.readdirSync(folderPath)) {
        const filePath = path.join(folderPath, file);
        if (!fs.statSync(filePath).isFile()) continue;
        const existingHash = calculateHash(fs.readFileSync(filePath));
        if (existingHash === targetHash) return file;
    }
    return null;
}

// ✅ FIX: Safe write — never silently overwrite a file that has
//         different content.  If the target filename already exists
//         with a different MD5, we mint a unique name instead so
//         both files coexist.  This prevents two items that share
//         the same partNumber + SKU (and therefore the same folder
//         in older code) from clobbering each other's images.
function safeWriteFile(folderPath, filename, buffer) {
    const filePath = path.join(folderPath, filename);
    if (fs.existsSync(filePath)) {
        const existingHash = calculateHash(fs.readFileSync(filePath));
        const newHash = calculateHash(buffer);
        if (existingHash === newHash) {
            // Byte-for-byte identical — no write needed, reuse as-is.
            return { finalFileName: filename, action: 'reused' };
        }
        // Different content: generate a unique name to avoid overwriting.
        const ext = path.extname(filename);
        const base = path.basename(filename, ext);
        const uniqueName = `${base}_${Date.now()}${ext}`;
        fs.writeFileSync(path.join(folderPath, uniqueName), buffer);
        return { finalFileName: uniqueName, action: 'created' };
    }
    // File does not exist yet — normal write.
    fs.writeFileSync(filePath, buffer);
    return { finalFileName: filename, action: 'created' };
}

// =============================================================================
// CORE INVENTORY IMPORT
// =============================================================================
async function processInventoryImport(client, itemsToProcess) {
    let successCount = 0;
    const errors = [];

    for (const [index, row] of itemsToProcess.entries()) {
        const itemId = row['Item_ID'] || row['item_id'] || row['itemId'];

        if (!itemId) {
            errors.push({ row_index: index, error: "Missing Item_ID", data: row });
            continue;
        }

        const incomingOriginalSku = row['Original_SKU'] || row['original_sku'] || null;
        const incomingCleanedSku = row['Cleaned_SKU'] || row['cleaned_sku'] || null;

        // FIX #2: Safely parse quantity.
        // This prevents a missing 'estimated_available_qty' field from defaulting to 0
        // and overwriting a valid existing quantity. It will now correctly be NULL.
        const rawQty = row['Estimated Available Qty'] || row['estimated_available_qty'];
        const parsedQty = (rawQty === null || rawQty === undefined || rawQty === '') ? null : parseInt(rawQty, 10);

        // FIX #1: The `values` array is now correct (no `hasSku`).
        const values = [
            itemId,
            incomingOriginalSku,
            incomingCleanedSku,
            row['Title'] || row['title'] || null,
            row['Subtitle'] || row['subtitle'] || null,
            row['Price'] || row['price'] || null,
            row['Currency'] || row['currency'] || null,
            parsedQty, // Use the safely parsed quantity
            row['Condition'] || row['condition'] || null,
            row['Condition Description'] || row['condition_description'] || null,
            row['Brand'] || row['brand'] || null,
            row['MPN'] || row['mpn'] || null,
            row['GTIN'] || row['gtin'] || null,
            row['Category_Path'] || row['category_path'] || null,
            row['Seller_Username'] || row['seller_username'] || null,
            row['Seller_Feedback_Score'] || row['seller_feedback_score'] || null,
            row['Image_URL'] || row['image_url'] || null,
            row['Item_URL'] || row['item_url'] || null,
            row['Item_Affiliate_URL'] || row['item_affiliate_url'] || null,
            row['Status'] || row['status'] || 'Fetched'
        ];

        // FIX #1: The SQL query is now correct (no `has_sku`).
        const query = `
            INSERT INTO ebay_inventory (
                item_id, original_sku, cleaned_sku, title, subtitle,
                price, currency, estimated_available_qty, condition, condition_description,
                brand, mpn, gtin, category_path, seller_username,
                seller_feedback_score, image_url, item_url, item_affiliate_url, status, updated_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW())
            ON CONFLICT (item_id) DO UPDATE SET
                original_sku = COALESCE(NULLIF(EXCLUDED.original_sku, ''), ebay_inventory.original_sku),
                cleaned_sku = COALESCE(NULLIF(EXCLUDED.cleaned_sku, ''), ebay_inventory.cleaned_sku),
                title = COALESCE(NULLIF(EXCLUDED.title, ''), ebay_inventory.title),
                subtitle = COALESCE(NULLIF(EXCLUDED.subtitle, ''), ebay_inventory.subtitle),
                price = COALESCE(NULLIF(EXCLUDED.price, ''), ebay_inventory.price),
                currency = COALESCE(NULLIF(EXCLUDED.currency, ''), ebay_inventory.currency),
                estimated_available_qty = COALESCE(EXCLUDED.estimated_available_qty, ebay_inventory.estimated_available_qty),
                condition = COALESCE(NULLIF(EXCLUDED.condition, ''), ebay_inventory.condition),
                condition_description = COALESCE(NULLIF(EXCLUDED.condition_description, ''), ebay_inventory.condition_description),
                brand = COALESCE(NULLIF(EXCLUDED.brand, ''), ebay_inventory.brand),
                mpn = COALESCE(NULLIF(EXCLUDED.mpn, ''), ebay_inventory.mpn),
                gtin = COALESCE(NULLIF(EXCLUDED.gtin, ''), ebay_inventory.gtin),
                category_path = COALESCE(NULLIF(EXCLUDED.category_path, ''), ebay_inventory.category_path),
                seller_username = COALESCE(NULLIF(EXCLUDED.seller_username, ''), ebay_inventory.seller_username),
                image_url = COALESCE(NULLIF(EXCLUDED.image_url, ''), ebay_inventory.image_url),
                item_url = COALESCE(NULLIF(EXCLUDED.item_url, ''), ebay_inventory.item_url),
                item_affiliate_url = COALESCE(NULLIF(EXCLUDED.item_affiliate_url, ''), ebay_inventory.item_affiliate_url),
                status = COALESCE(NULLIF(EXCLUDED.status, ''), ebay_inventory.status),
                seller_feedback_score = CASE
                    WHEN EXCLUDED.seller_feedback_score IS NULL OR EXCLUDED.seller_feedback_score = ''
                        THEN ebay_inventory.seller_feedback_score
                    WHEN ebay_inventory.seller_feedback_score IS NULL OR ebay_inventory.seller_feedback_score = ''
                        THEN EXCLUDED.seller_feedback_score
                    WHEN CAST(EXCLUDED.seller_feedback_score AS INTEGER) > CAST(ebay_inventory.seller_feedback_score AS INTEGER)
                        THEN EXCLUDED.seller_feedback_score
                    ELSE ebay_inventory.seller_feedback_score
                END,
                updated_at = NOW();
        `;

        try {
            await client.query(query, values);
            successCount++;
        } catch (dbErr) {
            console.error(`DB Error for Item ${itemId}:`, dbErr.message);
            errors.push({ item_id: itemId, error: dbErr.message });
        }
    }

    return { successCount, errors };
}

app.post('/change-sku-with-item-id', async (req, res) => {
    const { itemId, sku } = req.body;
    if (!itemId || !sku) return res.status(400).json({ error: 'itemId and sku are required' });
    const result = await ebay.changeSKUForItemID({ itemId, sku });
    res.status(result.success ? 200 : 400).json(result);
});

// =============================================================================
// AUTH
// =============================================================================
app.post('/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json("Email and Password required");
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) return res.status(401).json("User not found");
        const user = result.rows[0];
        if (user.password !== password) return res.status(401).json("Invalid Password");
        const token = jwt.sign(
            { id: user.userid, role: user.role, name: user.name },
            process.env.JWT_SECRET,
            { expiresIn: '30d' }
        );
        res.json({ token, role: user.role, name: user.name, id: user.userid });
    } catch (err) { res.status(500).send("Server Error: " + err.message); }
});

app.post('/auth/create-user', async (req, res) => {
    try {
        const { email, name, password, role } = req.body;
        const allowedRoles = ['Receiver', 'Verifier', 'Photographer', 'Picker', 'Admin', 'System'];
        if (!allowedRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });
        const result = await pool.query(
            `SELECT * FROM create_new_user($1, $2, $3, $4::"UserRole")`,
            [email, name, password, role]
        );
        res.json({ user: result.rows[0] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/users/me', verifyToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT userid, email, name, role, created_at FROM users WHERE userid = $1',
            [req.user.id]
        );
        if (result.rows.length === 0) return res.status(404).json("User not found");
        res.json(result.rows[0]);
    } catch (err) { res.status(500).send(err.message); }
});


// =============================================================================
// USER MANAGEMENT
// =============================================================================

app.get('/users/me', verifyToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT userid, email, name, role, created_at FROM users WHERE userid = $1',
            [req.user.id]
        );
        if (result.rows.length === 0) return res.status(404).json("User not found");
        res.json(result.rows[0]);
    } catch (err) { res.status(500).send(err.message); }
});

// DELETE /users/:userId — Delete a user by userid
app.delete('/users/:userId', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { userId } = req.params;

        // Prevent self-deletion
        if (req.user.id === userId)
            return res.status(400).json({ error: "You cannot delete your own account." });

        const result = await pool.query(
            'DELETE FROM users WHERE userid = $1 RETURNING userid, email, name, role',
            [userId]
        );

        if (result.rowCount === 0)
            return res.status(404).json({ error: "User not found." });

        res.json({ success: true, message: "User deleted.", user: result.rows[0] });
    } catch (err) {
        console.error('DELETE /users/:userId error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /users — Create a new user (admin only, direct insert)
app.post('/users', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { email, name, password, role } = req.body;

        if (!email || !password)
            return res.status(400).json({ error: "email and password are required." });

        const allowedRoles = ['Receiver', 'Verifier', 'Photographer', 'Picker', 'Admin', 'System'];
        if (role && !allowedRoles.includes(role))
            return res.status(400).json({ error: "Invalid role.", allowedRoles });

        const existing = await pool.query('SELECT userid FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0)
            return res.status(409).json({ error: "A user with this email already exists." });

        const result = await pool.query(
            `INSERT INTO users (email, name, password, role)
             VALUES ($1, $2, $3, $4::"UserRole")
             RETURNING userid, email, name, role, created_at`,
            [email, name || null, password, role || 'Receiver']
        );

        res.status(201).json({ success: true, user: result.rows[0] });
    } catch (err) {
        console.error('POST /users error:', err);
        res.status(500).json({ error: err.message });
    }
});

// PATCH /users/:userId/password — Change a user's password
app.patch('/users/:userId/password', verifyToken, async (req, res) => {
    try {
        const { userId } = req.params;
        const { current_password, new_password } = req.body;

        if (!new_password || new_password.length < 6)
            return res.status(400).json({ error: "new_password is required (min 6 characters)." });

        const isAdmin = req.user.role === 'Admin';
        const isSelf = req.user.id === userId;

        if (!isAdmin && !isSelf)
            return res.status(403).json({ error: "You can only change your own password." });

        // Non-admins must provide their current password
        if (!isAdmin) {
            if (!current_password)
                return res.status(400).json({ error: "current_password is required." });

            const userResult = await pool.query(
                'SELECT password FROM users WHERE userid = $1', [userId]
            );
            if (userResult.rows.length === 0)
                return res.status(404).json({ error: "User not found." });

            if (userResult.rows[0].password !== current_password)
                return res.status(401).json({ error: "Current password is incorrect." });
        }

        const result = await pool.query(
            `UPDATE users SET password = $1, updated_at = NOW()
             WHERE userid = $2
             RETURNING userid, email, name, role, updated_at`,
            [new_password, userId]
        );

        if (result.rowCount === 0)
            return res.status(404).json({ error: "User not found." });

        res.json({ success: true, message: "Password updated.", user: result.rows[0] });
    } catch (err) {
        console.error('PATCH /users/:userId/password error:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /users — List all users (admin only)
app.get('/users', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT userid, email, name, role, created_at, updated_at FROM users ORDER BY created_at DESC'
        );
        res.json({ count: result.rowCount, users: result.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =============================================================================
// EBAY WEBHOOK — Receive notifications & upsert into ebay_inventory
// =============================================================================
app.post('/ebay/webhooks', express.text({ type: '*/*' }), async (req, res) => {
    // Respond immediately so eBay doesn't retry
    res.status(200).send('OK');
 
    try {
        const parsed = await xml2js.parseStringPromise(req.body, {
            explicitArray: false,
            tagNameProcessors: [xml2js.processors.stripPrefix],
        });
 
        // 🆕 Full dump of every incoming notification
        console.log('\n' + '='.repeat(70));
        console.log(`📨 NOTIFICATION RECEIVED: ${new Date().toISOString()}`);
        console.log('='.repeat(70));
        console.log(JSON.stringify(parsed, null, 2));
        console.log('='.repeat(70) + '\n');

        const body = parsed?.Envelope?.Body;
        if (!body) return console.log('⚠️ Webhook: No Body in notification');
        
        // Find the response key (GetItemResponse, GetItemTransactionResponse, etc.)
        const responseKey = Object.keys(body).find(k => k.endsWith('Response'));
        if (!responseKey) return console.log('⚠️ Webhook: No Response key found');
 
        const response = body[responseKey];
        const eventName = response.NotificationEventName;
        const item = response.Item;
 
        if (!item?.ItemID) return console.log('⚠️ Webhook: No Item or ItemID in notification');
 
        console.log('\n' + '='.repeat(70));
        console.log(`📨 WEBHOOK [${eventName}] ItemID: ${item.ItemID}`);
        console.log(`   Title: ${item.Title || 'N/A'}`);
        console.log('='.repeat(70));
 
        // --- Extract price ---
        const price = item.SellingStatus?.CurrentPrice?._
            || item.SellingStatus?.CurrentPrice
            || item.StartPrice?._
            || null;
 
        const currency = item.SellingStatus?.CurrentPrice?.$?.currencyID
            || item.Currency
            || 'USD';
 
        // --- Quantity: total listed - sold = available ---
        const totalQty = parseInt(item.Quantity) || 0;
        const soldQty = parseInt(item.SellingStatus?.QuantitySold) || 0;
        const availableQty = totalQty - soldQty;
 
        // --- Brand / MPN / GTIN ---
        let brand = item.ProductListingDetails?.BrandMPN?.Brand || null;
        let mpn = item.ProductListingDetails?.BrandMPN?.MPN || null;
        const gtin = item.ProductListingDetails?.UPC || null;
 
        // Also check ItemSpecifics (can be more reliable)
        const specs = item.ItemSpecifics?.NameValueList;
        if (Array.isArray(specs)) {
            for (const spec of specs) {
                if (spec.Name === 'Brand' && !brand) brand = spec.Value;
                if (spec.Name === 'MPN' && !mpn) mpn = spec.Value;
            }
        }
 
        // --- Status mapping ---
        const listingStatus = item.SellingStatus?.ListingStatus;
        let status = 'Active';
        if (eventName === 'ItemClosed' || eventName === 'ItemUnsold' || listingStatus === 'Ended') {
            status = 'Ended';
        } else if (eventName === 'ItemListed') {
            status = 'Active';
        } else if (eventName === 'ItemSold' || eventName === 'FixedPriceTransaction') {
            status = 'Active'; // Still active, just sold some qty
        }
 
        // --- Image URL (first one) ---
        const picUrls = item.PictureDetails?.PictureURL;
        const imageUrl = Array.isArray(picUrls) ? picUrls[0] : (picUrls || null);
 
        // --- Build payload matching processInventoryImport format ---
        const payload = [{
            item_id:                 item.ItemID,
            original_sku:            item.SKU || null,
            cleaned_sku:             item.SKU ? `"${item.SKU.trim()}"` : null,
            title:                   item.Title || null,
            subtitle:                item.SubTitle || null,
            price:                   price,
            currency:                currency,
            estimated_available_qty: availableQty,
            condition:               item.ConditionDisplayName || null,
            condition_description:   item.ConditionDescription || null,
            brand:                   brand,
            mpn:                     mpn,
            gtin:                    (gtin && gtin !== 'Does not apply') ? gtin : null,
            category_path:           item.PrimaryCategory?.CategoryName || null,
            seller_username:         item.Seller?.UserID || response.RecipientUserID || null,
            seller_feedback_score:   item.Seller?.FeedbackScore || null,
            image_url:               imageUrl,
            item_url:                item.ListingDetails?.ViewItemURL || null,
            item_affiliate_url:      null,
            status:                  status,
        }];
 
        console.log(`   SKU: ${payload[0].original_sku || 'N/A'} | Price: ${price} ${currency} | Qty: ${availableQty} | Status: ${status}`);
 
        // --- Upsert into DB using existing processInventoryImport ---
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await processInventoryImport(client, payload);
            await client.query('COMMIT');
            console.log(`   ✅ DB upsert complete — success: ${result.successCount}, errors: ${result.errors.length}`);
            if (result.errors.length > 0) console.log('   ❌ Errors:', JSON.stringify(result.errors));
        } catch (dbErr) {
            await client.query('ROLLBACK');
            console.error(`   ❌ DB error:`, dbErr.message);
        } finally {
            client.release();
        }
 
    } catch (e) {
        console.log('⚠️ Webhook parse error:', e.message);
        console.log('RAW BODY (first 500 chars):', req.body?.substring?.(0, 500));
    }
});
// =============================================================================
// EBAY WEBHOOK SUBSCRIBE — Register your domain URL with eBay
// Call once: GET /ebay/webhooks/subscribe
// After this, eBay will continuously POST notifications to /ebay/webhooks
// =============================================================================
app.get('/ebay/webhooks/subscribe', verifyToken, async (req, res) => {
    try {
        const token = await ebay.getEbayAccessToken();
        const webhookUrl = `${WEBHOOK_URL}/ebay/webhooks`;
 
        const events = [
            'ItemListed',
            'ItemRevised',
            'ItemSold',
            'ItemClosed',
            'FixedPriceTransaction',
            'EndOfAuction',
            'ItemUnsold',
            'BestOffer',
        ];
 
        const eventXml = events.map(e => `
        <NotificationEnable>
            <EventType>${e}</EventType>
            <EventEnable>Enable</EventEnable>
        </NotificationEnable>`).join('');
 
        const body = `<?xml version="1.0" encoding="utf-8"?>
<SetNotificationPreferencesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
    <RequesterCredentials>
        <eBayAuthToken>${token}</eBayAuthToken>
    </RequesterCredentials>
    <ApplicationDeliveryPreferences>
        <ApplicationURL>${webhookUrl}</ApplicationURL>
        <ApplicationEnable>Enable</ApplicationEnable>
        <DeviceType>Platform</DeviceType>
    </ApplicationDeliveryPreferences>
    <UserDeliveryPreferenceArray>${eventXml}
    </UserDeliveryPreferenceArray>
</SetNotificationPreferencesRequest>`;
 
        const response = await fetch(TRADING_API, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml',
                'X-EBAY-API-COMPATIBILITY-LEVEL': '1351',
                'X-EBAY-API-CALL-NAME': 'SetNotificationPreferences',
                'X-EBAY-API-SITEID': '0',
            },
            body,
        });
 
        const text = await response.text();
 
        let parsed;
        try {
            parsed = await xml2js.parseStringPromise(text, {
                explicitArray: false,
                tagNameProcessors: [xml2js.processors.stripPrefix],
            });
        } catch (_) {}
 
        const ack = parsed?.Envelope?.Body?.SetNotificationPreferencesResponse?.Ack
            || parsed?.SetNotificationPreferencesResponse?.Ack;
 
        if (ack === 'Success') {
            console.log('\n' + '='.repeat(70));
            console.log('✅ EBAY WEBHOOK SUBSCRIBED SUCCESSFULLY');
            console.log(`   URL: ${webhookUrl}`);
            console.log(`   Events: ${events.join(', ')}`);
            console.log('='.repeat(70) + '\n');
 
            res.json({
                success: true,
                message: 'eBay webhook subscription active.',
                webhook_url: webhookUrl,
                events,
            });
        } else {
            console.error('⚠️ eBay subscription response:', text);
            res.status(400).json({
                success: false,
                message: 'eBay did not return Success.',
                ebay_response: text,
            });
        }
    } catch (err) {
        console.error('❌ Subscribe error:', err.message);
        res.status(500).json({ error: err.message });
    }
});
 
// =============================================================================
// EBAY WEBHOOK UNSUBSCRIBE — Disable all notifications
// Call: GET /ebay/webhooks/unsubscribe
// =============================================================================
app.get('/ebay/webhooks/unsubscribe', verifyToken, async (req, res) => {
    try {
        const token = await ebay.getEbayAccessToken();
 
        const body = `<?xml version="1.0" encoding="utf-8"?>
<SetNotificationPreferencesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
    <RequesterCredentials>
        <eBayAuthToken>${token}</eBayAuthToken>
    </RequesterCredentials>
    <ApplicationDeliveryPreferences>
        <ApplicationURL>${WEBHOOK_URL}/ebay/webhooks</ApplicationURL>
        <ApplicationEnable>Disable</ApplicationEnable>
        <DeviceType>Platform</DeviceType>
    </ApplicationDeliveryPreferences>
</SetNotificationPreferencesRequest>`;
 
        const response = await fetch(TRADING_API, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml',
                'X-EBAY-API-COMPATIBILITY-LEVEL': '1351',
                'X-EBAY-API-CALL-NAME': 'SetNotificationPreferences',
                'X-EBAY-API-SITEID': '0',
            },
            body,
        });
 
        const text = await response.text();
        console.log('🔕 Webhook unsubscribed. eBay response:', text);
        res.json({ success: true, message: 'Webhook notifications disabled.', ebay_response: text });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
 
// =============================================================================
// EBAY WEBHOOK STATUS — Check current notification preferences
// Call: GET /ebay/webhooks/status
// =============================================================================
app.get('/ebay/webhooks/status', verifyToken, async (req, res) => {
    try {
        const token = await ebay.getEbayAccessToken();
 
        const body = `<?xml version="1.0" encoding="utf-8"?>
<GetNotificationPreferencesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
    <RequesterCredentials>
        <eBayAuthToken>${token}</eBayAuthToken>
    </RequesterCredentials>
    <PreferenceLevel>User</PreferenceLevel>
</GetNotificationPreferencesRequest>`;
 
        const response = await fetch(TRADING_API, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml',
                'X-EBAY-API-COMPATIBILITY-LEVEL': '1351',
                'X-EBAY-API-CALL-NAME': 'GetNotificationPreferences',
                'X-EBAY-API-SITEID': '0',
            },
            body,
        });
 
        const text = await response.text();
 
        let parsed;
        try {
            parsed = await xml2js.parseStringPromise(text, {
                explicitArray: false,
                tagNameProcessors: [xml2js.processors.stripPrefix],
            });
        } catch (_) {}
 
        const prefs = parsed?.Envelope?.Body?.GetNotificationPreferencesResponse
            || parsed?.GetNotificationPreferencesResponse;
 
        res.json({
            success: true,
            application_delivery: prefs?.ApplicationDeliveryPreferences || null,
            user_delivery: prefs?.UserDeliveryPreferenceArray?.NotificationEnable || null,
            raw: prefs,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =============================================================================
// INVENTORY IMPORT
// =============================================================================
app.post('/inventory/import/file', verifyToken, upload.single('file'), async (req, res) => {
    const client = await pool.connect();
    try {
        if (!req.file) return res.status(400).json({ error: "No CSV file uploaded." });
        const items = await new Promise((resolve, reject) => {
            const results = [];
            fs.createReadStream(req.file.path)
                .pipe(csv())
                .on('data', (data) => results.push(data))
                .on('end', () => { fs.unlinkSync(req.file.path); resolve(results); })
                .on('error', (err) => reject(err));
        });
        if (items.length === 0) return res.status(400).json({ error: "CSV file was empty." });
        await client.query('BEGIN');
        const result = await processInventoryImport(client, items);
        await client.query('COMMIT');
        res.json({ message: "File Import Complete", processed: items.length, success: result.successCount, errors: result.errors });
    } catch (err) {
        await client.query('ROLLBACK');
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: "Server Error", details: err.message });
    } finally { client.release(); }
});

app.post('/inventory/import/json', verifyToken, async (req, res) => {
    console.log('\n' + '='.repeat(80));
    console.log('📥 REQUEST RECEIVED AT /inventory/import/json');
    console.log('Time:', new Date().toISOString());
    console.log('Body is Array:', Array.isArray(req.body), '| Length:', Array.isArray(req.body) ? req.body.length : 'N/A');
    console.log('='.repeat(80) + '\n');

    const client = await pool.connect();
    try {
        const items = req.body;
        if (!Array.isArray(items) || items.length === 0)
            return res.status(400).json({ error: "Request body must be a non-empty JSON array." });
        await client.query('BEGIN');
        const result = await processInventoryImport(client, items);
        await client.query('COMMIT');
        res.json({ message: "JSON Import Complete", processed: items.length, success: result.successCount, errors: result.errors });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: "Server Error", details: err.message });
    } finally { client.release(); }
});

app.post('/inventory/adjust', verifyToken, async (req, res) => {
    try {
        const { ebay_id, val } = req.body;
        const adjustResult = await pool.query(
            'SELECT * FROM increment_ebay_inventory_quantity($1, $2)', [ebay_id, val]
        );
        res.json(adjustResult.rows[0]);
    } catch (err) { res.status(500).send(err.message); }
});

app.get('/inventory', verifyToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM ebay_inventory');
        res.json({ count: result.rowCount, items: result.rows });
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/inventory/find-by-part-numbers', verifyToken, async (req, res) => {
    try {
        const { partNumbers } = req.body;
        if (!partNumbers || !Array.isArray(partNumbers) || partNumbers.length === 0)
            return res.status(400).json({ error: "A non-empty array of partNumbers is required." });
        const result = await pool.query(
            `SELECT *
            FROM ebay_inventory
            WHERE (
                original_sku = ANY($1::text[]) OR
                cleaned_sku  = ANY($1::text[]) OR
                item_id      = ANY($1::text[]) OR
                mpn          = ANY($1::text[]) OR
                gtin         = ANY($1::text[])
            )
            AND status != 'Ended'`,
            [partNumbers]
        );
        res.json(result.rows);
    } catch (err) { res.status(500).send("Server Error"); }
});

app.post('/inventory/find-item-by-image', verifyToken, upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "Image file is required." });

        // 1. LOGIN: Get the token from your Python API (http://localhost:8000)
        // Note: Make sure the URL matches your Python service address exactly
        const loginResponse = await fetch("http://192.168.90.59:8000/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                username: "admin",
                password: "PassWord!@"
            })
        });

        if (!loginResponse.ok) {
            throw new Error("Failed to authenticate with Gemini service");
        }

        const loginData = await loginResponse.json();
        const pythonToken = loginData.token;

        // 2. PREPARE FILE: Read the uploaded file from multer
        const fileBuffer = fs.readFileSync(req.file.path);
        const formData = new FormData();
        formData.append("image", new Blob([fileBuffer]), req.file.originalname);

        // 3. CALL GEMINI: Use the token retrieved in Step 1
        const geminiResponse = await fetch("http://192.168.90.59:8000/extract-gemini", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${pythonToken}`
            },
            body: formData
        });

        const data = await geminiResponse.json();

        // 4. Cleanup temporary file
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

        // 5. Send final response
        res.status(geminiResponse.status).json(data);

    } catch (err) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        console.error('Proxy Error:', err);
        res.status(500).json({ error: "Failed to process image", details: err.message });
    }
});
// =============================================================================
// BINS
// =============================================================================
app.get('/bins', verifyToken, async (req, res) => {
    try {
        const query = `
            SELECT
                b.id::text AS bin_id,
                b.bin_name,
                b.location,
                b.current_load,
                COUNT(bi.id) FILTER (WHERE bi.id IS NOT NULL)::int AS item_count,
                COALESCE(
                    json_agg(
                        json_build_object(
                            'bin_item_id',          bi.id::text,
                            'sku',                  bi.sku,
                            'quantity',             bi.quantity,
                            'bin_item_created_at',  bi.created_at,
                            'bin_item_updated_at',  bi.updated_at,
                            'item_id',              ei.item_id,
                            'title',                COALESCE(ei.title, ''),
                            'subtitle',             ei.subtitle,
                            'original_sku',         ei.original_sku,
                            'cleaned_sku',          ei.cleaned_sku,
                            'has_sku',              (ei.original_sku IS NOT NULL AND ei.original_sku != ''),
                            'price',                COALESCE(ei.price, ''),
                            'currency',             COALESCE(ei.currency, ''),
                            'estimated_available_qty', COALESCE(ei.estimated_available_qty, 0),
                            'condition',            COALESCE(ei.condition, ''),
                            'condition_description',COALESCE(ei.condition_description, ''),
                            'brand',                COALESCE(ei.brand, ''),
                            'mpn',                  COALESCE(ei.mpn, ''),
                            'gtin',                 COALESCE(ei.gtin, ''),
                            'category_path',        COALESCE(ei.category_path, ''),
                            'seller_username',      COALESCE(ei.seller_username, ''),
                            'seller_feedback_score',COALESCE(ei.seller_feedback_score, ''),
                            'image_url',            COALESCE(ei.image_url, ''),
                            'item_url',             COALESCE(ei.item_url, ''),
                            'item_affiliate_url',   ei.item_affiliate_url,
                            'ebay_status',          COALESCE(ei.status, '')
                        )
                        ORDER BY bi.id
                    ) FILTER (WHERE bi.id IS NOT NULL),
                    '[]'::json
                ) AS items
            FROM bins b
            LEFT JOIN bin_items bi ON b.id = bi.bin_id
            LEFT JOIN ebay_inventory ei ON bi.product_id::text = ei.item_id
            GROUP BY b.id
            ORDER BY b.id;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/bins/check/:binName', verifyToken, async (req, res) => {
    try {
        const { binName } = req.params;
        const result = await pool.query(`
            SELECT b.*, COALESCE(json_agg(bi.*) FILTER (WHERE bi.id IS NOT NULL), '[]') AS bin_inventory
            FROM bins b
            LEFT JOIN bin_items bi ON b.id = bi.bin_id
            WHERE b.bin_name = $1
            GROUP BY b.id ORDER BY b.id
        `, [binName]);
        res.status(200).json(result.rows.length === 0 ? [] : result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/bins', verifyToken, async (req, res) => {
    try {
        const { bin_name, location } = req.body;
        if (!bin_name) return res.status(400).json({ error: "bin_name is required." });
        const existingBin = await pool.query(
            'SELECT * FROM bins WHERE bin_name = $1 AND location IS NOT DISTINCT FROM $2',
            [bin_name, location ?? null]
        );
        if (existingBin.rows.length > 0) return res.status(200).json(existingBin.rows[0]);
        const result = await pool.query(
            'INSERT INTO bins (bin_name, location) VALUES ($1, $2) RETURNING *',
            [bin_name, location ?? null]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) { res.status(500).send("Server Error"); }
});

app.get('/bins/:binId/items/details', verifyToken, async (req, res) => {
    try {
        const { binId } = req.params;
        const binCheck = await pool.query('SELECT * FROM bins WHERE id = $1', [binId]);
        if (binCheck.rows.length === 0) return res.status(404).json({ error: "Bin not found." });
        const result = await pool.query(`
            SELECT
                bi.id AS bin_item_id,
                bi.sku, bi.quantity, bi.created_at AS bin_item_created_at, bi.updated_at AS bin_item_updated_at,
                ei.item_id, ei.title, ei.subtitle,
                ei.original_sku, ei.cleaned_sku,
                (ei.original_sku IS NOT NULL AND ei.original_sku != '') AS has_sku,
                ei.price, ei.currency, ei.estimated_available_qty,
                ei.condition, ei.condition_description, ei.brand, ei.mpn, ei.gtin,
                ei.category_path, ei.seller_username, ei.seller_feedback_score,
                ei.image_url, ei.item_url, ei.item_affiliate_url, ei.status AS ebay_status
            FROM bins b
            LEFT JOIN bin_items bi ON b.id = bi.bin_id
            LEFT JOIN ebay_inventory ei ON bi.product_id::text = ei.item_id
            WHERE b.id = $1 ORDER BY bi.id
        `, [binId]);
        const bin = binCheck.rows[0];
        const items = result.rows.filter(r => r.bin_item_id !== null);
        res.json({ bin_id: bin.id, bin_name: bin.bin_name, location: bin.location, current_load: bin.current_load, item_count: items.length, items });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/bins/items', verifyToken, async (req, res) => {
    const { binId, productId, sku } = req.body;
    const quantity = parseInt(req.body.quantity, 10);
    if (!binId || !sku || !productId || isNaN(quantity) || quantity <= 0)
        return res.status(400).json({ error: "Invalid input." });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const existingItem = await client.query('SELECT * FROM bin_items WHERE bin_id = $1 AND sku = $2', [binId, sku]);
        let finalItem;
        if (existingItem.rows.length > 0) {
            const r = await client.query(
                'UPDATE bin_items SET quantity = quantity + $1, product_id = $2, updated_at = NOW() WHERE id = $3 RETURNING *',
                [quantity, productId, existingItem.rows[0].id]
            );
            finalItem = r.rows[0];
        } else {
            const r = await client.query(
                'INSERT INTO bin_items (bin_id, sku, quantity, product_id) VALUES ($1,$2,$3,$4) RETURNING *',
                [binId, sku, quantity, productId]
            );
            finalItem = r.rows[0];
        }
        await client.query('UPDATE bins SET current_load = current_load + $1 WHERE id = $2', [quantity, binId]);
        await client.query('COMMIT');
        res.status(200).json(finalItem);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: "Server Error", details: err.message });
    } finally { client.release(); }
});


// =============================================================================
// BINS V2
// =============================================================================

const parseBins = (input) => {
    if (Array.isArray(input)) return input.flatMap(b => parseBins(b));
    return String(input)
        .replace(/\s+and\s+/gi, ',')
        .replace(/[&()[\]{}<>|/\\;:!@#$%^*+=~`"']/g, ',')
        .split(',')
        .map(b => b.trim())
        .filter(Boolean);
};

// GET — Find bins by item ID
app.get('/bins/by-item/:itemId', verifyToken, async (req, res) => {
    try {
        const { itemId } = req.params;
        const result = await pool.query(`
            SELECT
                bi.id::text AS bin_item_id,
                b.id::text AS bin_id,
                b.bin_name,
                b.location,
                b.current_load,
                bi.sku,
                bi.quantity,
                bi.created_at AS bin_item_created_at,
                bi.updated_at AS bin_item_updated_at,
                ei.item_id,
                COALESCE(ei.title, '') AS title,
                ei.subtitle,
                ei.original_sku,
                ei.cleaned_sku,
                (ei.original_sku IS NOT NULL AND ei.original_sku != '') AS has_sku,
                COALESCE(ei.price, '') AS price,
                COALESCE(ei.currency, '') AS currency,
                COALESCE(ei.estimated_available_qty, 0) AS estimated_available_qty,
                COALESCE(ei.condition, '') AS condition,
                COALESCE(ei.condition_description, '') AS condition_description,
                COALESCE(ei.brand, '') AS brand,
                COALESCE(ei.mpn, '') AS mpn,
                COALESCE(ei.gtin, '') AS gtin,
                COALESCE(ei.category_path, '') AS category_path,
                COALESCE(ei.seller_username, '') AS seller_username,
                COALESCE(ei.seller_feedback_score, '') AS seller_feedback_score,
                COALESCE(ei.image_url, '') AS image_url,
                COALESCE(ei.item_url, '') AS item_url,
                ei.item_affiliate_url,
                COALESCE(ei.status, '') AS ebay_status
            FROM bin_items bi
            JOIN bins b ON b.id = bi.bin_id
            LEFT JOIN ebay_inventory ei ON bi.product_id::text = ei.item_id
            WHERE bi.product_id::text = $1
            ORDER BY bi.id
        `, [itemId]);

        // Reshape: one entry per bin_item, with nested items array for BinModel compatibility
        const bins = result.rows.map(row => ({
            bin_id: row.bin_id,
            bin_name: row.bin_name,
            location: row.location,
            current_load: row.current_load,
            item_count: 1,
            items: [{
                bin_item_id: row.bin_item_id,
                sku: row.sku,
                quantity: row.quantity,
                bin_item_created_at: row.bin_item_created_at,
                bin_item_updated_at: row.bin_item_updated_at,
                item_id: row.item_id,
                title: row.title,
                subtitle: row.subtitle,
                original_sku: row.original_sku,
                cleaned_sku: row.cleaned_sku,
                has_sku: row.has_sku,
                price: row.price,
                currency: row.currency,
                estimated_available_qty: row.estimated_available_qty,
                condition: row.condition,
                condition_description: row.condition_description,
                brand: row.brand,
                mpn: row.mpn,
                gtin: row.gtin,
                category_path: row.category_path,
                seller_username: row.seller_username,
                seller_feedback_score: row.seller_feedback_score,
                image_url: row.image_url,
                item_url: row.item_url,
                item_affiliate_url: row.item_affiliate_url,
                ebay_status: row.ebay_status,
            }]
        }));

        res.json({ itemId, bin_count: bins.length, bins });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// PUT — Set desired bin state, auto-diffs
app.put('/bins/manage-item-bins', verifyToken, async (req, res) => {
    const { itemId, bins } = req.body;
    if (!itemId || !bins)
        return res.status(400).json({ error: 'itemId and bins are required' });

    const desiredNames = parseBins(bins);
    if (desiredNames.length === 0)
        return res.status(400).json({ error: 'No valid bin names provided' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const current = await client.query(`
            SELECT bi.id, bi.bin_id, bi.quantity, b.bin_name
            FROM bin_items bi
            JOIN bins b ON b.id = bi.bin_id
            WHERE bi.product_id::text = $1
        `, [itemId]);

        const currentBins = current.rows;
        const currentNames = currentBins.map(r => r.bin_name);

        const toAdd = desiredNames.filter(name => !currentNames.includes(name));
        const toRemove = currentBins.filter(r => !desiredNames.includes(r.bin_name));

        for (const row of toRemove) {
            await client.query(`DELETE FROM bin_items WHERE id = $1`, [row.id]);
            await client.query(
                `UPDATE bins SET current_load = GREATEST(current_load - $1, 0) WHERE id = $2`,
                [row.quantity, row.bin_id]
            );
        }

        for (const name of toAdd) {
            let bin = await client.query(`SELECT * FROM bins WHERE bin_name = $1`, [name]);
            if (bin.rows.length === 0) {
                bin = await client.query(
                    `INSERT INTO bins (bin_name) VALUES ($1) RETURNING *`, [name]
                );
            }
            const binId = bin.rows[0].id;

            await client.query(
                `INSERT INTO bin_items (bin_id, product_id, sku, quantity) VALUES ($1, $2, $3, 1)`,
                [binId, itemId, name]
            );
            await client.query(
                `UPDATE bins SET current_load = current_load + 1 WHERE id = $1`, [binId]
            );
        }

        await client.query('COMMIT');

        res.json({
            success: true,
            itemId,
            previousBins: currentNames,
            newBins: desiredNames,
            added: toAdd,
            removed: toRemove.map(r => r.bin_name),
            preserved: desiredNames.filter(name => currentNames.includes(name))
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// POST — Quick add one or more bins
app.post('/bins/add-bin-to-item', verifyToken, async (req, res) => {
    const { itemId, binName, quantity } = req.body;
    if (!itemId || !binName) return res.status(400).json({ error: 'itemId and binName are required' });

    const names = parseBins(binName);
    if (names.length === 0) return res.status(400).json({ error: 'No valid bin names provided' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const results = [];

        for (const name of names) {
            let bin = await client.query(`SELECT * FROM bins WHERE bin_name = $1`, [name]);
            if (bin.rows.length === 0) {
                bin = await client.query(
                    `INSERT INTO bins (bin_name) VALUES ($1) RETURNING *`, [name]
                );
            }
            const binId = bin.rows[0].id;

            const existing = await client.query(
                `SELECT * FROM bin_items WHERE bin_id = $1 AND product_id::text = $2`, [binId, itemId]
            );

            let binItem;
            if (existing.rows.length > 0) {
                const r = await client.query(
                    `UPDATE bin_items SET quantity = quantity + $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
                    [quantity || 1, existing.rows[0].id]
                );
                binItem = r.rows[0];
            } else {
                const r = await client.query(
                    `INSERT INTO bin_items (bin_id, product_id, sku, quantity) VALUES ($1, $2, $3, $4) RETURNING *`,
                    [binId, itemId, name, quantity || 1]
                );
                binItem = r.rows[0];
            }

            await client.query(
                `UPDATE bins SET current_load = current_load + $1 WHERE id = $2`,
                [quantity || 1, binId]
            );

            results.push({ bin: bin.rows[0], binItem });
        }

        await client.query('COMMIT');

        res.json({ success: true, itemId, added: results });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// DELETE — Remove one or more bins from an item
app.delete('/bins/remove-bin-from-item', verifyToken, async (req, res) => {
    const { itemId, binName } = req.body;
    if (!itemId || !binName) return res.status(400).json({ error: 'itemId and binName are required' });

    const names = parseBins(binName);
    if (names.length === 0) return res.status(400).json({ error: 'No valid bin names provided' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const removed = [];
        const notFound = [];

        for (const name of names) {
            const result = await client.query(`
                SELECT bi.id, bi.bin_id, bi.quantity
                FROM bin_items bi
                JOIN bins b ON b.id = bi.bin_id
                WHERE bi.product_id::text = $1 AND b.bin_name = $2
            `, [itemId, name]);

            if (result.rows.length === 0) {
                notFound.push(name);
                continue;
            }

            const row = result.rows[0];
            await client.query(`DELETE FROM bin_items WHERE id = $1`, [row.id]);
            await client.query(
                `UPDATE bins SET current_load = GREATEST(current_load - $1, 0) WHERE id = $2`,
                [row.quantity, row.bin_id]
            );
            removed.push(name);
        }

        await client.query('COMMIT');

        res.json({ success: true, itemId, removed, notFound });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// =============================================================================
// SUBMISSIONS
// =============================================================================
app.get('/submissions', verifyToken, async (req, res) => {
    try {
        const pickerId = req.user.id;
        const { rows } = await pool.query(`
            SELECT
                ps.id, ps.picker_id, ps.photographer_id, ps.quantity, ps.photo_data,
                ps.status, ps.created_at, ps.assigned_at,
                jsonb_build_object('userid', pu.userid, 'name', pu.name, 'email', pu.email) AS picker,
                CASE WHEN ps.photographer_id IS NOT NULL THEN
                    jsonb_build_object('userid', phu.userid, 'name', phu.name, 'email', phu.email)
                ELSE NULL END AS photographer
            FROM public.picker_submissions ps
            JOIN public.users pu ON pu.userid = ps.picker_id
            LEFT JOIN public.users phu ON phu.userid = ps.photographer_id
            WHERE ps.picker_id = $1 OR ps.photographer_id = $1
        `, [pickerId]);
        res.json({ success: true, count: rows.length, data: rows });
    } catch (error) { res.status(500).json({ message: 'Internal server error.' }); }
});

app.post('/submissions', verifyToken, async (req, res) => {
    const { photo_data, quantity = 1 } = req.body;
    const pickerId = req.user.id;
    if (!pickerId) return res.status(401).json({ message: 'User ID missing from token.' });
    if (!photo_data?.trim()) return res.status(400).json({ message: 'photo_data is required.' });
    if (quantity < 1) return res.status(400).json({ message: 'Quantity must be at least 1.' });
    try {
        const { rows: [photographer] } = await pool.query(`
            SELECT u.userid FROM public.users u
            LEFT JOIN public.picker_submissions ps ON ps.photographer_id = u.userid AND ps.status IN ('Pending','Approved')
            WHERE u.role = 'Photographer'
            GROUP BY u.userid ORDER BY COUNT(ps.picker_id) ASC LIMIT 1
        `);
        if (!photographer) return res.status(503).json({ message: 'No photographers available.' });
        const { rows: [submission] } = await pool.query(`
            INSERT INTO public.picker_submissions (picker_id, photographer_id, quantity, photo_data, status, assigned_at)
            VALUES ($1,$2,$3,$4,'Pending',NOW())
            RETURNING id::text AS id, picker_id, photographer_id, quantity, photo_data, status, created_at, assigned_at
        `, [pickerId, photographer.userid, Number(quantity), photo_data.trim()]);
        res.status(201).json(submission);
    } catch (err) { res.status(500).json({ message: 'Server error.', details: err.message }); }
});

app.put('/submissions/:id/status', async (req, res) => {
    const { status } = req.body;
    const { id } = req.params;
    if (!status) return res.status(400).json({ message: 'status is required.' });
    if (!['Pending', 'Approved', 'Rejected'].includes(status))
        return res.status(400).json({ message: 'status must be Pending, Approved or Rejected.' });
    const { rows: [existing] } = await pool.query(`SELECT * FROM public.picker_submissions WHERE id = $1`, [id]);
    if (!existing) return res.status(404).json({ message: 'Submission not found.' });
    const { rows: [updated] } = await pool.query(`
        UPDATE public.picker_submissions SET status = $1 WHERE id = $2
        RETURNING id::text AS id, picker_id, photographer_id, quantity, photo_data, status, created_at, assigned_at
    `, [status, id]);
    res.json(updated);
});

// =============================================================================
// REQUESTS
// =============================================================================
app.get('/requests', verifyToken, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        const requestsResult = await pool.query(
            `SELECT * FROM requests ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]
        );
        if (requestsResult.rows.length === 0) return res.json({ count: 0, items: [] });
        const requestIds = requestsResult.rows.map(r => r.id);
        const imagesResult = await pool.query(
            `SELECT request_id, image_data FROM request_images WHERE request_id = ANY($1::int[])`, [requestIds]
        );
        const mergedItems = requestsResult.rows.map(req => ({
            ...req,
            image_data: imagesResult.rows.find(i => i.request_id === req.id)?.image_data || null
        }));
        res.json({ count: mergedItems.length, items: mergedItems });
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/requests', verifyToken, async (req, res) => {
    try {
        const { part_identifiers, other_data } = req.body;
        const result = await pool.query(
            `INSERT INTO requests (part_identifiers, other_data, created_by_user_id, created_by_user_name, status)
             VALUES ($1,$2,$3,$4,'Pending') RETURNING id`,
            [JSON.stringify(part_identifiers), other_data, req.user.id, req.user.name]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) { res.status(500).send(err.message); }
});

app.put('/requests/:id/status', verifyToken, async (req, res) => {
    try {
        const { status } = req.body;
        if (!status) return res.status(400).json({ error: "Status is required" });
        const result = await pool.query(
            `UPDATE requests SET status = $1 WHERE id = $2 RETURNING *`, [status, req.params.id]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: "Request not found" });
        res.status(200).json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/requests/:requestId/image', verifyToken, async (req, res) => {
    try {
        const { imageData } = req.body;
        if (!imageData || typeof imageData !== 'string' || imageData.length < 10)
            return res.status(400).json({ error: 'Valid Base64 string required.' });
        await pool.query(
            `INSERT INTO request_images (request_id, image_data, created_by_user_id, created_by_user_name)
             VALUES ($1,$2,$3,$4) RETURNING id`,
            [req.params.requestId, imageData, req.user.id, req.user.name]
        );
        res.json({ message: "Image saved successfully" });
    } catch (err) { res.status(500).send("Server Error"); }
});

// =============================================================================
// SCAN HISTORY
// =============================================================================
app.get('/scan-history', verifyToken, async (req, res) => {
    try {
        const { page = 1, limit = 50, userId, binId, status, ebayItemId, sku, startDate, endDate } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let baseQuery = `
            SELECT sh.*,
                ei.title AS ebay_title, ei.subtitle, ei.price, ei.currency, ei.condition, ei.brand,
                ei.mpn, ei.gtin, ei.image_url, ei.item_url, ei.estimated_available_qty AS current_ebay_qty,
                ei.category_path, ei.cleaned_sku AS current_sku,
                (ei.original_sku IS NOT NULL AND ei.original_sku != '') AS has_sku
            FROM scan_history sh
            LEFT JOIN ebay_inventory ei ON sh.ebay_item_id = ei.item_id
        `;
        const conditions = [], params = [];
        let idx = 1;

        if (userId) { conditions.push(`sh.uid = $${idx++}`); params.push(userId); }
        if (binId) { conditions.push(`sh.bin_id = $${idx++}`); params.push(binId); }
        if (status) { conditions.push(`sh.status ILIKE $${idx++}`); params.push(`%${status}%`); }
        if (ebayItemId) { conditions.push(`sh.ebay_item_id = $${idx++}`); params.push(ebayItemId); }
        if (sku) { conditions.push(`sh.sku ILIKE $${idx++}`); params.push(`%${sku}%`); }
        if (startDate) { conditions.push(`sh.scanned_at >= $${idx++}`); params.push(startDate); }
        if (endDate) { conditions.push(`sh.scanned_at <= $${idx++}`); params.push(endDate); }
        if (conditions.length > 0) baseQuery += ' WHERE ' + conditions.join(' AND ');
        baseQuery += ` ORDER BY sh.scanned_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
        params.push(parseInt(limit), offset);

        const result = await pool.query(baseQuery, params);
        const countResult = await pool.query(
            'SELECT COUNT(*) FROM scan_history sh' + (conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : ''),
            params.slice(0, -2)
        );
        const totalCount = parseInt(countResult.rows[0].count);

        res.json({
            count: result.rowCount, total: totalCount,
            page: parseInt(page), limit: parseInt(limit),
            totalPages: Math.ceil(totalCount / parseInt(limit)),
            hasMore: offset + result.rowCount < totalCount,
            items: result.rows
        });
    } catch (err) { res.status(500).json({ error: "Server Error", details: err.message }); }
});

app.post('/scan-history', verifyToken, async (req, res) => {
    try {
        const { status, name, quantity, bin_id, ebay_item_id, parsed_data } = req.body;
        if (!status) return res.status(400).json({ error: "A 'status' is required." });
        if (!ebay_item_id) return res.status(400).json({ error: "An 'ebay_item_id' is required." });

        const ebayResult = await pool.query(
            `SELECT estimated_available_qty, cleaned_sku, original_sku, title FROM ebay_inventory WHERE item_id = $1`,
            [ebay_item_id]
        );
        if (ebayResult.rows.length === 0) return res.status(404).json({ error: "eBay item not found." });

        const ebayItem = ebayResult.rows[0];
        const original_count = ebayItem.estimated_available_qty || 0;
        const sku = ebayItem.cleaned_sku || ebayItem.original_sku || null;
        const added_quantity = quantity ?? 0;
        const new_count = original_count + added_quantity;

        const result = await pool.query(
            `INSERT INTO scan_history
             (uid, user_name, status, name, quantity, bin_id, ebay_item_id, original_count, new_count, sku, parsed_data, scanned_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW()) RETURNING *`,
            [req.user.id, req.user.name, status, name || ebayItem.title, added_quantity,
            bin_id || null, ebay_item_id, original_count, new_count, sku,
            parsed_data ? JSON.stringify(parsed_data) : JSON.stringify({})]
        );
        res.status(201).json({
            success: true, data: result.rows[0],
            message: `Successfully scanned. Added ${added_quantity}. New total: ${new_count}`
        });
    } catch (err) { res.status(500).json({ error: "Server Error", details: err.message }); }
});

// =============================================================================
// PRODUCT IMAGES
// ✅ FIX: Uses safeWriteFile() instead of bare fs.writeFileSync() so a file
//         that already exists with DIFFERENT content is never silently
//         overwritten.  Two items with the same partNumber + SKU (and
//         therefore potentially the same folder in older uploads) will now
//         each keep their own bytes.
// =============================================================================
app.post('/product/images', verifyToken, async (req, res) => {
    try {
        const { images } = req.body;
        if (!images || !Array.isArray(images) || images.length === 0)
            return res.status(400).json({ error: "images array is required." });

        const BASE_DIR = path.join(__dirname, 'uploads', 'products');
        const processedUrls = [];
        const stats = { created: 0, updated: 0, reused: 0, unchanged: 0 };

        for (let i = 0; i < images.length; i++) {
            const imageData = images[i];
            let folderName = imageData.folder;
            let filename = imageData.filename;
            const base64 = imageData.base64 || imageData;
            const existingUrl = imageData.existingUrl;
            if (!folderName || !filename || !base64) continue;

            folderName = folderName.trim().replace(/\s+/g, '_');
            filename = filename.trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '');

            const folderPath = path.join(BASE_DIR, folderName);
            if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });

            const matches = base64.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
            const buffer = matches ? Buffer.from(matches[2], 'base64') : Buffer.from(base64, 'base64');
            const newHash = calculateHash(buffer);
            let finalFileName, action;
            const filePath = path.join(folderPath, filename);

            if (existingUrl && fs.existsSync(filePath)) {
                // Caller is explicitly updating an existing file by URL.
                const existingHash = calculateHash(fs.readFileSync(filePath));
                if (existingHash === newHash) {
                    // Bytes are identical — no write needed.
                    finalFileName = filename;
                    action = 'unchanged';
                    stats.unchanged++;
                } else {
                    // ✅ Content differs: use safeWriteFile so we never
                    //    silently clobber a file that belongs to another item.
                    const writeResult = safeWriteFile(folderPath, filename, buffer);
                    finalFileName = writeResult.finalFileName;
                    action = 'updated';
                    stats.updated++;
                }
            } else {
                // New upload — check for an existing identical file first.
                const existingFileName = findExistingFile(folderPath, newHash);
                if (existingFileName) {
                    // Identical bytes already on disk — reuse without writing.
                    finalFileName = existingFileName;
                    action = 'reused';
                    stats.reused++;
                } else {
                    // ✅ Truly new content — safeWriteFile handles the edge
                    //    case where the target filename is already occupied by
                    //    a different item's photo (gives it a unique name).
                    const writeResult = safeWriteFile(folderPath, filename, buffer);
                    finalFileName = writeResult.finalFileName;
                    action = 'created';
                    stats.created++;
                }
            }

            processedUrls.push({
                url: `${BASE_URL}/files/products/${encodeURIComponent(folderName)}/${encodeURIComponent(finalFileName)}`,
                action, hash: newHash, folder: folderName, filename: finalFileName, index: i
            });
        }

        if (processedUrls.length === 0) return res.status(400).json({ error: "No valid images processed." });
        res.status(201).json({ urls: processedUrls.map(i => i.url), details: processedUrls, stats });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================================================
// VERIFICATION ITEMS
// =============================================================================
// REPLACE WITH:
// ─────────────────────────────────────────────
//  Helper: serialize a DB row for JSON response
//  Converts BYTEA[] buffers → base64 strings
// ─────────────────────────────────────────────
function serializeItem(row) {
    if (!row) return row;
    if (row.audio_notes && Array.isArray(row.audio_notes)) {
        row.audio_notes = row.audio_notes.map(buf =>
            Buffer.isBuffer(buf) ? buf.toString('base64') : buf
        );
    }
    return row;
}

// ─────────────────────────────────────────────
//  GET /verification-items
//  List with optional status filter + pagination
// ─────────────────────────────────────────────
app.get('/verification-items', verifyToken, async (req, res) => {
    try {
        const { status, search, search_by, sortBy, sortOrder } = req.query;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
        const offset = (page - 1) * limit;

        const statuses = status
            ? (Array.isArray(status) ? status : [status])
            : null;
        const searchTerm = search?.trim() || null;
        const searchBy = ['sku', 'title'].includes(search_by) ? search_by : null;

        // Validate and set sorting
        const validSortFields = ['createdAt', 'title', 'sku', 'price', 'condition'];
        const sortField = validSortFields.includes(sortBy) ? sortBy : 'createdAt';
        const sortDirection = (sortOrder?.toUpperCase() === 'ASC') ? 'ASC' : 'DESC';

        // Map frontend sort fields to database columns
        const sortColumnMap = {
            'createdAt': 'vi.created_at',
            'title': 'vi.title',
            'sku': 'vi.sku',
            'price': 'o.price_value',
            'condition': 'vi.condition'
        };
        const sortColumn = sortColumnMap[sortField];

        // Build WHERE conditions and params array dynamically
        const conditions = [];
        const params = [];
        let idx = 1;

        // Status filter
        if (statuses) {
            conditions.push(`o.status = ANY($${idx++})`);
            params.push(statuses);
        } else {
            conditions.push(`o.status != 'READY_TO_SUBMIT'`);
        }

        // Search filter - searches title and SKU, or just one if search_by is specified
        if (searchTerm) {
            if (searchBy === 'sku') {
                conditions.push(`vi.sku ILIKE $${idx}`);
            } else if (searchBy === 'title') {
                conditions.push(`vi.title ILIKE $${idx}`);
            } else {
                conditions.push(`(vi.sku ILIKE $${idx} OR vi.title ILIKE $${idx})`);
            }
            params.push(`%${searchTerm}%`);
            idx++;
        }

        const whereClause = conditions.join(' AND ');

        // Total count for pagination metadata
        const countResult = await pool.query(`
            SELECT COUNT(DISTINCT vi.id)
            FROM verification_items vi
            LEFT JOIN offers o ON vi.id = o.verification_item_id
            WHERE ${whereClause}
        `, params);
        const totalCount = parseInt(countResult.rows[0].count);
        const totalPages = Math.ceil(totalCount / limit);

        // Main query with sorting
        const result = await pool.query(`
            SELECT vi.*, to_jsonb(o) AS offer,
                COALESCE(json_agg(vii.image_url ORDER BY vii.position)
                FILTER (WHERE vii.id IS NOT NULL), '[]') AS images
            FROM verification_items vi
            LEFT JOIN offers o ON vi.id = o.verification_item_id
            LEFT JOIN verification_item_images vii ON vi.id = vii.verification_item_id
            WHERE ${whereClause}
            GROUP BY vi.id, o.id
            ORDER BY ${sortColumn} ${sortDirection}
            LIMIT $${idx++} OFFSET $${idx++}
        `, [...params, limit, offset]);

        res.json({
            items: result.rows.map(serializeItem),
            pagination: {
                page,
                limit,
                totalCount,
                totalPages,
                hasNextPage: page < totalPages,
                hasPrevPage: page > 1,
            },
            filters: {
                search: searchTerm,
                searchBy: searchBy,
                status: statuses,
                sortBy: sortField,
                sortOrder: sortDirection
            }
        });
    } catch (err) { 
        console.error('GET /verification-items error:', err);
        res.status(500).send(err.message); 
    }
});

// ─────────────────────────────────────────────
//  POST /verification-items
//  Create a new verification item + offer
// ─────────────────────────────────────────────
app.post('/verification-items', verifyToken, async (req, res) => {
    const client = await pool.connect();
    try {
        const { package_weight_and_size, product, offer } = req.body;

        // Validate product fields
        for (const f of ['sku', 'title', 'categoryId', 'condition', 'brand', 'categoryPath'])
            if (!product[f]) return res.status(400).json({ error: `Product field "${f}" is required.` });

        // Validate offer fields
        for (const f of ['status', 'format', 'qty', 'listingDescription'])
            if (!offer[f]) return res.status(400).json({ error: `Offer field "${f}" is required.` });

        if (!['DRAFT', 'READY_TO_SUBMIT', 'PUBLISHED', 'ENDED', 'REJECTED'].includes(offer.status))
            return res.status(400).json({ error: "Invalid offer status." });
        if (!['FIXED_PRICE', 'AUCTION'].includes(offer.format))
            return res.status(400).json({ error: "Invalid offer format." });

        // Parse audio_notes: accept base64 strings, store as BYTEA[]
        const audioNotes = Array.isArray(product.audio_notes)
            ? product.audio_notes.map(b64 => Buffer.from(b64, 'base64'))
            : [];


        await client.query('BEGIN');

        const productResult = await client.query(
            `INSERT INTO verification_items
                (sku, title, description, brand, mpn, category_id, category_path, aspects,
                 condition, condition_description, package_weight_and_size, audio_notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
            [
                product.sku,
                product.title,
                product.description || null,
                product.brand,
                product.mpn || null,
                product.categoryId,
                product.categoryPath,
                product.aspects ? JSON.stringify(product.aspects) : null,
                product.condition,
                product.condition_description || null,
                package_weight_and_size ? JSON.stringify(package_weight_and_size) : null,
                audioNotes,
            ]
        );
        const itemId = productResult.rows[0].id;

        // Insert images
        if (product.images?.length > 0) {
            await Promise.all(product.images.map((url, i) =>
                client.query(
                    `INSERT INTO verification_item_images (verification_item_id, image_url, position) VALUES ($1,$2,$3)`,
                    [itemId, url, i + 1]
                )
            ));
        }

        // Insert offer
        await client.query(
            `INSERT INTO offers
                (verification_item_id, status, price_value, available_quantity, marketplace_id,
                 format, listing_description, payment_policy_id, return_policy_id, fulfillment_policy_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
                itemId,
                offer.status,
                offer.price || 0,
                offer.qty,
                offer.marketplaceId || 'EBAY_US',
                offer.format,
                offer.listingDescription,
                offer.paymentPolicyId || null,
                offer.returnPolicyId || null,
                offer.fulfillmentPolicyId || null,
            ]
        );

        await client.query('COMMIT');

        const fullResult = await pool.query(`
            SELECT vi.*, to_jsonb(o) AS offer,
                COALESCE(json_agg(vii.image_url ORDER BY vii.position)
                FILTER (WHERE vii.id IS NOT NULL), '[]') AS images
            FROM verification_items vi
            LEFT JOIN offers o ON vi.id = o.verification_item_id
            LEFT JOIN verification_item_images vii ON vi.id = vii.verification_item_id
            WHERE vi.id = $1 GROUP BY vi.id, o.id
        `, [itemId]);

        res.status(201).json(serializeItem(fullResult.rows[0]));
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
});

// ─────────────────────────────────────────────
//  GET /verification-items/:id
//  Fetch a single item by ID
// ─────────────────────────────────────────────
app.get('/verification-items/:id', verifyToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT vi.*, to_jsonb(o) AS offer,
                COALESCE(json_agg(vii.image_url ORDER BY vii.position) FILTER (WHERE vii.id IS NOT NULL), '[]') AS images
            FROM verification_items vi
            LEFT JOIN offers o ON vi.id = o.verification_item_id
            LEFT JOIN verification_item_images vii ON vi.id = vii.verification_item_id
            WHERE vi.id = $1 GROUP BY vi.id, o.id
        `, [req.params.id]);

        if (result.rows.length === 0) return res.status(404).json("Item not found");
        res.json(serializeItem(result.rows[0]));
    } catch (err) { res.status(500).send(err.message); }
});

// ─────────────────────────────────────────────
//  PATCH /verification-items/:id/status
//  Update offer status only
// ─────────────────────────────────────────────
app.patch('/verification-items/:id/status', verifyToken, async (req, res) => {
    const client = await pool.connect();
    try {
        const { status } = req.body;
        if (!status) return res.status(400).json({ error: "Status is required" });
        if (!['DRAFT', 'READY_TO_SUBMIT', 'PUBLISHED', 'ENDED', 'REJECTED'].includes(status))
            return res.status(400).json({ error: "Invalid status" });

        await client.query('BEGIN');

        const updateResult = await client.query(
            `UPDATE offers SET status = $1 WHERE verification_item_id = $2 RETURNING *`,
            [status, req.params.id]
        );

        if (updateResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: "Item not found or has no offer" });
        }

        await client.query('COMMIT');

        const result = await client.query(`
            SELECT vi.*, to_jsonb(o) AS offer,
                COALESCE(json_agg(vii.image_url ORDER BY vii.position) FILTER (WHERE vii.id IS NOT NULL), '[]') AS images
            FROM verification_items vi
            LEFT JOIN offers o ON vi.id = o.verification_item_id
            LEFT JOIN verification_item_images vii ON vi.id = vii.verification_item_id
            WHERE vi.id = $1 GROUP BY vi.id, o.id
        `, [req.params.id]);

        res.json({
            success: true,
            message: `Status updated to ${status}`,
            item: serializeItem(result.rows[0]),
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
});

// ─────────────────────────────────────────────
//  PUT /verification-items/:id
//  Full or partial update of item + offer + images + audio_notes
// ─────────────────────────────────────────────
app.put('/verification-items/:id', verifyToken, async (req, res) => {
    const client = await pool.connect();
    try {
        const { product, offer, package_weight_and_size, audio_notes } = req.body;
        await client.query('BEGIN');

        const fields = [];
        const values = [];
        let idx = 1;

        // 1. Update product and root fields
        if (product) {
            const allowed = ['sku', 'title', 'description', 'brand', 'mpn', 'category_id', 'aspects', 'condition', 'condition_description'];
            for (const [key, value] of Object.entries(product)) {
                if (allowed.includes(key)) {
                    fields.push(`${key} = $${idx}`);
                    values.push(key === 'aspects' ? JSON.stringify(value) : value);
                    idx++;
                }
            }
        }

        // Handle audio_notes at root level
        if (audio_notes !== undefined) {
            fields.push(`audio_notes = $${idx}`);
            values.push(Array.isArray(audio_notes)
                ? audio_notes.map(b64 => Buffer.from(b64, 'base64'))
                : []);
            idx++;
        }

        // Handle package size
        if (package_weight_and_size !== undefined) {
            fields.push(`package_weight_and_size = $${idx}`);
            values.push(package_weight_and_size ? JSON.stringify(package_weight_and_size) : null);
            idx++;
        }

        if (fields.length > 0) {
            values.push(req.params.id);
            await client.query(
                `UPDATE verification_items SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${idx}`,
                values
            );
        }

        // 2. Update offers
        if (offer) {
            const offerFields = [], offerValues = [];
            let oIdx = 2;
            const fieldMap = {
                status: 'status',
                price: 'price_value',
                qty: 'available_quantity',
                listingDescription: 'listing_description',
                paymentPolicyId: 'payment_policy_id',
                returnPolicyId: 'return_policy_id',
                fulfillmentPolicyId: 'fulfillment_policy_id'
            };

            for (const [key, value] of Object.entries(offer)) {
                if (fieldMap[key]) {
                    offerFields.push(`${fieldMap[key]} = $${oIdx}`);
                    offerValues.push(value);
                    oIdx++;
                }
            }

            if (offerFields.length > 0) {
                await client.query(
                    `UPDATE offers SET ${offerFields.join(', ')} WHERE verification_item_id = $1`,
                    [req.params.id, ...offerValues]
                );
            }
        }

        // 3. Update images
        if (product?.images && Array.isArray(product.images)) {
            const images = product.images.filter(url => typeof url === 'string' && url.trim().length > 0);
            await client.query(`DELETE FROM verification_item_images WHERE verification_item_id = $1`, [req.params.id]);
            for (let i = 0; i < images.length; i++) {
                await client.query(
                    `INSERT INTO verification_item_images (verification_item_id, image_url, position) VALUES ($1,$2,$3)`,
                    [req.params.id, images[i], i + 1]
                );
            }
        }

        await client.query('COMMIT');

        const result = await client.query(`
            SELECT vi.*, to_jsonb(o) AS offer,
                COALESCE(json_agg(vii.image_url ORDER BY vii.position) FILTER (WHERE vii.id IS NOT NULL), '[]') AS images
            FROM verification_items vi
            LEFT JOIN offers o ON vi.id = o.verification_item_id
            LEFT JOIN verification_item_images vii ON vi.id = vii.verification_item_id
            WHERE vi.id = $1 GROUP BY vi.id, o.id
        `, [req.params.id]);

        res.json(serializeItem(result.rows[0]));
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});
// ─────────────────────────────────────────────
//  DELETE /verification-items/:id
//  Remove item, offer, images (DB + disk), and audio_notes
// ─────────────────────────────────────────────
app.delete('/verification-items/:id', verifyToken, async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;

        // 1. Confirm the item exists and grab image URLs in one query
        const itemResult = await client.query(
            `SELECT vi.id, vi.sku, vi.mpn,
                COALESCE(
                    json_agg(vii.image_url ORDER BY vii.position)
                    FILTER (WHERE vii.id IS NOT NULL),
                    '[]'
                ) AS image_urls
             FROM verification_items vi
             LEFT JOIN verification_item_images vii ON vi.id = vii.verification_item_id
             WHERE vi.id = $1
             GROUP BY vi.id`,
            [id]
        );

        if (itemResult.rows.length === 0)
            return res.status(404).json({ error: 'Verification item not found.' });

        const item = itemResult.rows[0];
        const imageUrls = item.image_urls || [];

        // 2. Delete image files from disk (best-effort, before DB changes)
        const BASE_DIR = path.join(__dirname, 'uploads', 'products');
        const filesDeleted = [];
        const filesMissing = [];
        const fileErrors = [];
        const foldersToClean = new Set();

        for (const url of imageUrls) {
            if (!url) continue;

            const match = url.match(/\/files\/products\/([^/?#]+)\/([^/?#]+)/);
            if (!match) {
                fileErrors.push({ url, error: 'Could not extract valid /files/products/folder/file path from URL.' });
                continue;
            }

            const folder = decodeURIComponent(match[1]).replace(/\.\./g, '').replace(/[/\\]/g, '');
            const filename = decodeURIComponent(match[2]).replace(/\.\./g, '').replace(/[/\\]/g, '');
            const filePath = path.join(BASE_DIR, folder, filename);
            const folderPath = path.join(BASE_DIR, folder);

            foldersToClean.add(folderPath);

            if (fs.existsSync(filePath)) {
                try {
                    fs.unlinkSync(filePath);
                    filesDeleted.push(filePath);
                } catch (fsErr) {
                    fileErrors.push({ url, path: filePath, error: fsErr.message });
                }
            } else {
                filesMissing.push(filePath);
            }
        }

        // Clean up empty folders
        const foldersDeleted = [];
        for (const folderPath of foldersToClean) {
            try {
                if (fs.existsSync(folderPath) && fs.readdirSync(folderPath).length === 0) {
                    fs.rmdirSync(folderPath);
                    foldersDeleted.push(folderPath);
                }
            } catch (_) { /* ignore */ }
        }

        // 3. Delete DB rows in dependency order
        //    audio_notes lives on verification_items itself — dropped with the row
        await client.query('BEGIN');

        const imgDeleteResult = await client.query(
            `DELETE FROM verification_item_images WHERE verification_item_id = $1`, [id]
        );

        await client.query(
            `DELETE FROM offers WHERE verification_item_id = $1`, [id]
        );

        await client.query(
            `DELETE FROM verification_items WHERE id = $1`, [id]
        );

        await client.query('COMMIT');

        res.json({
            success: true,
            message: `Verification item ${id} fully deleted.`,
            item_id: Number(id),
            sku: item.sku,
            mpn: item.mpn,
            db: {
                images_removed: imgDeleteResult.rowCount,
                offer_removed: true,
                item_removed: true,
            },
            disk: {
                files_deleted: filesDeleted,
                files_missing: filesMissing,
                file_errors: fileErrors,
                folders_deleted: foldersDeleted,
            },
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('DELETE /verification-items/:id error:', err);
        res.status(500).json({ error: 'Server Error', details: err.message });
    } finally {
        client.release();
    }
});

// =============================================================================
// ADMIN
// =============================================================================


app.get('/admin/receive-all-data', verifyToken, verifyAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        const queries = {
            users: 'SELECT * FROM users',
            scan_history: 'SELECT * FROM scan_history ORDER BY scanned_at DESC',
            bins: 'SELECT * FROM bins ORDER BY id ASC',
            bin_items: `SELECT bi.*, to_jsonb(ei.*) - 'item_id' AS item_details FROM bin_items bi INNER JOIN ebay_inventory ei ON bi.product_id::text = ei.item_id`,
            verification_items: 'SELECT * FROM verification_items ORDER BY id ASC',
            offers: 'SELECT * FROM offers',
            verification_item_images: 'SELECT * FROM verification_item_images ORDER BY position ASC',
            requests: 'SELECT * FROM requests ORDER BY created_at DESC',
            request_images: 'SELECT * FROM request_images'
        };
        const rawData = {};
        // ★ PATCH #4 — SERIAL, not parallel. A single pg client cannot run
        //   multiple queries simultaneously; Promise.all on one client puts
        //   it into an invalid state and corrupts the pool slot.
        for (const [key, q] of Object.entries(queries)) {
            rawData[key] = (await client.query(q)).rows;
        }
        res.json({
            timestamp: new Date(),
            users: rawData.users,
            scan_history: rawData.scan_history,
            bins: rawData.bins.map(bin => ({ ...bin, bin_items: rawData.bin_items.filter(i => i.bin_id === bin.id) })),
            verification_items: rawData.verification_items.map(item => ({
                ...item,
                offers: rawData.offers.filter(o => o.verification_item_id === item.id),
                images: rawData.verification_item_images.filter(i => i.verification_item_id === item.id)
            })),
            requests: rawData.requests.map(r => ({ ...r, images: rawData.request_images.filter(i => i.request_id === r.id) }))
        });
    } catch (err) {
        console.error('GET /admin/receive-all-data error:', err);
        res.status(500).json({ error: "Failed to export data", details: err.message });
    } finally { client.release(); }
});

// =============================================================================
// ACTIONS
// =============================================================================
const validateAction = (req, res, next) => {
    const validScanTypes = [
        'RECEIVER_ITEM_ADDED_TO_BIN', 'RECEIVER_CREATED_BIN', 'RECEIVER_SENT_REQUEST_TO_PHOTOGRAPHER',
        'RECEIVER_SCAN_CANCELLED', 'PHOTOGRAPHER_CANCELLED_REQUEST', 'PHOTOGRAPHER_SUBMITTED_ITEM_TO_VERIFIER',
        'PHOTOGRAPHER_VERIFIED_ITEM_REMOVAL_FROM_BIN', 'VERIFIER_REJECTED_ITEM', 'VERIFIER_MODIFIED_ITEM',
        'VERIFIER_PUBLISHED_ITEM', 'VERIFIER_ITEM_ADDED_TO_BIN', 'VERIFIER_CREATED_BIN',
        'VERIFIER_ADDED_ITEM_TO_INVENTORY', 'PICKER_REMOVED_ITEM',
    ];
    if (!validScanTypes.includes(req.body.scan_type))
        return res.status(400).json({ error: 'Invalid scan_type', validTypes: validScanTypes });
    next();
};

app.post('/actions', verifyToken, validateAction, async (req, res) => {
    const { scan_type, ebay_id, bin_id, photographer_request_item_id, verification_item_id, picker_id } = req.body;
    try {
        const result = await pool.query(
            `INSERT INTO actions (userid, username, scan_type, ebay_id, bin_id, photographer_request_item_id, verification_item_id, picker_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [req.user.id, req.user.name, scan_type, ebay_id || null, bin_id || null, photographer_request_item_id || null, verification_item_id || null, picker_id || null]
        );
        res.status(201).json({ success: true, action: result.rows[0] });
    } catch (error) { res.status(500).json({ error: 'Failed to create action' }); }
});

app.get('/actions', async (req, res) => {
    const { userid, scan_type, bin_id, photographer_request_item_id, verification_item_id, picker_id, ebay_id, limit = 50, offset = 0, sort_by = 'created_at', sort_order = 'DESC' } = req.query;
    try {
        let query = `
            SELECT a.*,
                CASE WHEN a.ebay_id IS NOT NULL THEN jsonb_build_object('item_id',e.item_id,'title',e.title,'subtitle',e.subtitle,'price',e.price,'currency',e.currency,'sku',COALESCE(e.cleaned_sku,e.original_sku),'has_sku',(e.original_sku IS NOT NULL AND e.original_sku != ''),'condition',COALESCE(e.condition_description,e.condition),'image_url',e.image_url) ELSE NULL END AS ebay,
                CASE WHEN a.bin_id IS NOT NULL THEN jsonb_build_object('id',b.id,'bin_name',b.bin_name,'location',b.location,'current_load',b.current_load) ELSE NULL END AS bin,
                CASE WHEN a.photographer_request_item_id IS NOT NULL THEN jsonb_build_object('id',r.id,'part_identifiers',r.part_identifiers,'status',r.status,'created_at',r.created_at,'created_by_user_name',r.created_by_user_name) ELSE NULL END AS photographer_request,
                CASE WHEN a.verification_item_id IS NOT NULL THEN jsonb_build_object('id',v.id,'sku',v.sku,'title',v.title,'description',v.description,'brand',v.brand,'mpn',v.mpn,'category_id',v.category_id,'condition',v.condition,'aspects',v.aspects,'created_at',v.created_at,'updated_at',v.updated_at) ELSE NULL END AS verification_item,
                CASE WHEN a.picker_id IS NOT NULL THEN jsonb_build_object('id',p.id::text,'picker_id',p.picker_id,'photographer_id',p.photographer_id,'quantity',p.quantity,'photo_data',p.photo_data,'status',p.status,'created_at',p.created_at,'assigned_at',p.assigned_at) ELSE NULL END AS picker_submission
            FROM actions a
            LEFT JOIN ebay_inventory e ON a.ebay_id = e.item_id
            LEFT JOIN bins b ON a.bin_id = b.id
            LEFT JOIN requests r ON a.photographer_request_item_id = r.id
            LEFT JOIN verification_items v ON a.verification_item_id = v.id
            LEFT JOIN picker_submissions p ON a.picker_id::text = p.id::text
            WHERE 1=1
        `;
        const params = [];
        let idx = 1;
        if (userid) { query += ` AND a.userid = $${idx++}`; params.push(userid); }
        if (scan_type) { query += ` AND a.scan_type = $${idx++}`; params.push(scan_type); }
        if (bin_id) { query += ` AND a.bin_id = $${idx++}`; params.push(bin_id); }
        if (photographer_request_item_id) { query += ` AND a.photographer_request_item_id = $${idx++}`; params.push(photographer_request_item_id); }
        if (verification_item_id) { query += ` AND a.verification_item_id = $${idx++}`; params.push(verification_item_id); }
        if (picker_id) { query += ` AND a.picker_id = $${idx++}`; params.push(picker_id); }
        if (ebay_id) { query += ` AND a.ebay_id = $${idx++}`; params.push(ebay_id); }

        const validSort = ['id', 'created_at', 'updated_at', 'userid'];
        const sortCol = validSort.includes(sort_by) ? sort_by : 'created_at';
        const order = sort_order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
        query += ` ORDER BY a.${sortCol} ${order} LIMIT $${idx++} OFFSET $${idx++}`;
        params.push(parseInt(limit), parseInt(offset));

        const result = await pool.query(query, params);

        const countParams = params.slice(0, -2);
        let countQuery = 'SELECT COUNT(*) FROM actions a WHERE 1=1';
        let countIdx = 1;
        if (userid) { countQuery += ` AND a.userid = $${countIdx++}`; }
        if (scan_type) { countQuery += ` AND a.scan_type = $${countIdx++}`; }
        if (bin_id) { countQuery += ` AND a.bin_id = $${countIdx++}`; }
        if (photographer_request_item_id) { countQuery += ` AND a.photographer_request_item_id = $${countIdx++}`; }
        if (verification_item_id) { countQuery += ` AND a.verification_item_id = $${countIdx++}`; }
        if (picker_id) { countQuery += ` AND a.picker_id = $${countIdx++}`; }
        if (ebay_id) { countQuery += ` AND a.ebay_id = $${countIdx++}`; }
        const countResult = await pool.query(countQuery, countParams);
        const totalCount = parseInt(countResult.rows[0].count);

        const allSubmissions = await pool.query(`
            SELECT ps.id::text AS id, ps.picker_id, ps.photographer_id, ps.quantity, ps.photo_data, ps.status, ps.created_at, ps.assigned_at,
                jsonb_build_object('userid',pu.userid,'name',pu.name,'email',pu.email) AS picker,
                CASE WHEN ps.photographer_id IS NOT NULL THEN jsonb_build_object('userid',phu.userid,'name',phu.name,'email',phu.email) ELSE NULL END AS photographer
            FROM public.picker_submissions ps
            JOIN public.users pu ON pu.userid = ps.picker_id
            LEFT JOIN public.users phu ON phu.userid = ps.photographer_id
            ORDER BY ps.created_at DESC
        `);

        res.json({
            success: true,
            actions: result.rows,
            picker_submissions: allSubmissions.rows,
            pagination: { total: totalCount, limit: parseInt(limit), offset: parseInt(offset), hasMore: parseInt(offset) + result.rows.length < totalCount }
        });
    } catch (error) { res.status(500).json({ error: 'Failed to fetch actions' }); }
});

// =============================================================================
// ORIGINAL EBAY INVENTORY / OFFER ROUTES
// =============================================================================
app.get('/ebay/token', verifyToken, async (req, res) => {
    try {
        const token = await ebay.getEbayAccessToken();
        res.json({ token });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/ebay/listings/:itemId/quantity', verifyToken, async (req, res) => {
    const { quantity } = req.body;
    if (quantity == null || isNaN(parseInt(quantity)))
        return res.status(400).json({ error: 'quantity (integer) is required.' });
    const result = await ebay.updateEbayQuantity({ itemId: req.params.itemId, quantity: parseInt(quantity) });
    res.status(result.success ? 200 : 400).json(result);
});

app.get('/ebay/merchant-location', verifyToken, async (req, res) => {
    try {
        const key = await ebay.getOrSetMerchantLocationKey();
        res.json({ merchantLocationKey: key });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/ebay/inventory/:sku', verifyToken, async (req, res) => {
    const result = await ebay.createOrUpdateInventoryItem(req.params.sku, req.body);
    res.status(result.success ? 200 : 400).json(result);
});

app.get('/ebay/inventory', verifyToken, async (req, res) => {
    const result = await ebay.getAllInventoryItems();
    res.status(result.success ? 200 : 500).json(result);
});

app.post('/ebay/inventory/bulk', verifyToken, async (req, res) => {
    const { skus } = req.body;
    if (!Array.isArray(skus)) return res.status(400).json({ error: 'skus[] array required.' });
    const result = await ebay.bulkGetInventoryItems(skus);
    res.status(result.success ? 200 : 400).json(result);
});

// NOTE: /sku/:sku and /:offerId/item-id MUST be defined before /:offerId
app.get('/ebay/offers', verifyToken, async (req, res) => {
    const result = await ebay.getAllOffers({ limit: parseInt(req.query.limit) || 100, offset: parseInt(req.query.offset) || 0 });
    res.status(result.success ? 200 : 500).json(result);
});

app.get('/ebay/offers/sku/:sku', verifyToken, async (req, res) => {
    const result = await ebay.getOffersForSku(req.params.sku);
    res.status(result.success ? 200 : 400).json(result);
});

app.get('/ebay/offers/:offerId/item-id', verifyToken, async (req, res) => {
    const result = await ebay.getItemIdFromOfferId(req.params.offerId);
    res.status(result.success ? 200 : 400).json(result);
});

app.get('/ebay/offers/:offerId', verifyToken, async (req, res) => {
    const result = await ebay.getOffer(req.params.offerId);
    res.status(result.success ? 200 : 400).json(result);
});

app.put('/ebay/offers/:offerId', verifyToken, async (req, res) => {
    const result = await ebay.updateOffer(req.params.offerId, req.body);
    res.status(result.success ? 200 : 400).json(result);
});

app.post('/ebay/offers/:offerId/publish', verifyToken, async (req, res) => {
    const result = await ebay.publishOffer(req.params.offerId);
    res.status(result.success ? 200 : 400).json(result);
});

app.post('/ebay/offers/:offerId/withdraw', verifyToken, async (req, res) => {
    const result = await ebay.withdrawOffer(req.params.offerId);
    res.status(result.success ? 200 : 400).json(result);
});

app.delete('/ebay/offers/:offerId', verifyToken, async (req, res) => {
    const result = await ebay.deleteOffer(req.params.offerId);
    res.status(result.success ? 200 : 400).json(result);
});

app.post('/ebay/draft', verifyToken, async (req, res) => {
    const { sku, inventoryData, offerData } = req.body;
    if (!sku || !inventoryData || !offerData)
        return res.status(400).json({ error: 'sku, inventoryData, and offerData are required.' });
    const result = await ebay.createAndMakeItDraft(sku, inventoryData, offerData);
    res.status(result.success ? 201 : 400).json(result);
});

// =============================================================================
// FX LISTING FEED API
// =============================================================================
app.post('/ebay/fx/task', verifyToken, async (req, res) => {
    const result = await ebay.createFxListingTask();
    res.status(result.success ? 201 : 400).json(result);
});

app.post('/ebay/fx/task/:taskId/upload', verifyToken, async (req, res) => {
    const { taskId } = req.params;
    const { inventoryData, offerData } = req.body;

    if (!inventoryData || !offerData)
        return res.status(400).json({ error: 'inventoryData and offerData are required.' });

    try {
        const tsv = await ebay.generateFxListingTsvFromRaw(inventoryData, offerData);
        const result = await ebay.uploadFxListingFile(taskId, tsv);
        res.status(result.success ? 200 : 400).json({ ...result, sku: offerData.sku });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/ebay/fx/task/:taskId', verifyToken, async (req, res) => {
    const result = await ebay.getFxTask(req.params.taskId);
    res.status(result.success ? 200 : 400).json(result);
});

app.get('/ebay/fx/tasks', verifyToken, async (req, res) => {
    const result = await ebay.getAllFxTasks({
        limit: parseInt(req.query.limit) || 25,
        offset: parseInt(req.query.offset) || 0,
    });
    res.status(result.success ? 200 : 500).json(result);
});

app.get('/ebay/fx/task/:taskId/results', verifyToken, async (req, res) => {
    const { taskId } = req.params;
    const syncDb = req.query.sync === 'true';

    const result = await ebay.downloadAndParseFxTaskResults(taskId);
    if (!result.success) return res.status(400).json(result);

    const { skuToItemId, rows } = result.data;
    let dbSyncResults = null;

    if (syncDb) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const synced = [], skipped = [];

            for (const [sku, itemId] of Object.entries(skuToItemId)) {
                if (!itemId) { skipped.push({ sku, reason: 'No itemId in result file' }); continue; }

                const existing = await client.query(
                    `SELECT item_id FROM ebay_inventory
                     WHERE original_sku = $1 OR cleaned_sku = $1 OR cleaned_sku = $2
                     LIMIT 1`,
                    [sku, `"${sku}"`]
                );

                if (existing.rows.length > 0) {
                    skipped.push({ sku, existingItemId: existing.rows[0].item_id, reason: 'Already linked' });
                } else {
                    await client.query(
                        `INSERT INTO ebay_inventory (item_id, original_sku, cleaned_sku, status, updated_at)
                         VALUES ($1,$2,$2,'Draft',NOW())
                         ON CONFLICT (item_id) DO NOTHING`,
                        [itemId, sku]
                    );
                    synced.push({ sku, itemId });
                }
            }

            await client.query('COMMIT');
            dbSyncResults = { synced_count: synced.length, skipped_count: skipped.length, synced, skipped };
        } catch (dbErr) {
            await client.query('ROLLBACK');
            dbSyncResults = { error: dbErr.message };
        } finally { client.release(); }
    }

    res.json({
        task_id: taskId,
        total_rows: rows.length,
        mapped: Object.keys(skuToItemId).length,
        sku_to_item_id: skuToItemId,
        rows,
        db_sync: dbSyncResults,
    });
});

app.post('/ebay/fx/pipeline', verifyToken, async (req, res) => {
    const { inventoryData, offerData } = req.body;

    if (!inventoryData || !offerData)
        return res.status(400).json({ error: 'inventoryData and offerData are required.' });

    const sku = offerData.sku ?? 'unknown';
    const condition = (inventoryData.condition ?? '').toUpperCase();
    const condCode = ebay.getConditionCode(condition);

    console.log(`[FX Pipeline] sku: ${sku} | condition: ${condition} (${condCode}) | EPS: ${condCode >= 2500}`);

    try {
        const tsv = await ebay.generateFxListingCsvFromRaw(inventoryData, offerData);

        const taskResult = await ebay.createFxListingTask();
        if (!taskResult.success) return res.status(400).json({ step: 'create_task', error: taskResult.error });
        const taskId = taskResult.data.taskId;

        const uploadResult = await ebay.uploadFxListingFile(taskId, tsv);
        if (!uploadResult.success) return res.status(400).json({ step: 'upload_file', task_id: taskId, error: uploadResult.error });

        res.status(202).json({
            message: 'Pipeline complete. eBay is processing the file.',
            task_id: taskId,
            sku,
            condition_code: condCode,
            eps_applied: condCode >= 2500,
            next_steps: {
                poll: `GET /ebay/fx/task/${taskId}`,
                results: `GET /ebay/fx/task/${taskId}/results?sync=true  (after COMPLETED)`,
            },
        });
    } catch (err) {
        console.error('[FX Pipeline] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// =============================================================================
// SERVER START
// =============================================================================
 
async function subscribeToEbayWebhooks(attempt = 1, maxAttempts = 5) {
    const webhookUrl = `${WEBHOOK_URL}/ebay/webhooks`;
    const delayMs = Math.min(attempt * 10000, 60000); // 10s, 20s, 30s, 40s, 50s
 
    try {
        const token = await ebay.getEbayAccessToken();
 
        const events = [
            'ItemListed', 'ItemRevised', 'ItemSold', 'ItemClosed',
            'FixedPriceTransaction', 'EndOfAuction', 'ItemUnsold', 'BestOffer',
        ];
 
        const eventXml = events.map(e => `
        <NotificationEnable>
            <EventType>${e}</EventType>
            <EventEnable>Enable</EventEnable>
        </NotificationEnable>`).join('');
 
        const body = `<?xml version="1.0" encoding="utf-8"?>
<SetNotificationPreferencesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
    <RequesterCredentials>
        <eBayAuthToken>${token}</eBayAuthToken>
    </RequesterCredentials>
    <ApplicationDeliveryPreferences>
        <ApplicationURL>${webhookUrl}</ApplicationURL>
        <ApplicationEnable>Enable</ApplicationEnable>
        <DeviceType>Platform</DeviceType>
    </ApplicationDeliveryPreferences>
    <UserDeliveryPreferenceArray>${eventXml}
    </UserDeliveryPreferenceArray>
</SetNotificationPreferencesRequest>`;
 
        const response = await fetch(TRADING_API, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml',
                'X-EBAY-API-COMPATIBILITY-LEVEL': '1351',
                'X-EBAY-API-CALL-NAME': 'SetNotificationPreferences',
                'X-EBAY-API-SITEID': '0',
            },
            body,
        });
 
        const text = await response.text();
        const parsed = await xml2js.parseStringPromise(text, {
            explicitArray: false,
            tagNameProcessors: [xml2js.processors.stripPrefix],
        }).catch(() => null);
 
        const ack = parsed?.Envelope?.Body?.SetNotificationPreferencesResponse?.Ack
            || parsed?.SetNotificationPreferencesResponse?.Ack;
 
        if (ack === 'Success') {
            console.log('📡 eBay webhook auto-subscribed successfully');
            console.log(`   URL: ${webhookUrl}`);
            console.log(`   Events: ${events.join(', ')}\n`);
            return true;
        } else {
            throw new Error(`eBay returned: ${ack || 'unknown'} — ${text.substring(0, 200)}`);
        }
    } catch (err) {
        console.error(`⚠️ Webhook subscribe attempt ${attempt}/${maxAttempts} failed:`, err.message);
 
        if (attempt < maxAttempts) {
            console.log(`   🔄 Retrying in ${delayMs / 1000}s...`);
            setTimeout(() => subscribeToEbayWebhooks(attempt + 1, maxAttempts), delayMs);
        } else {
            console.error('   ❌ All subscribe attempts failed. Use GET /ebay/webhooks/subscribe to retry manually.');
        }
        return false;
    }
}
 
// ★ PATCH #5 — Final Express error-handling middleware.
//   Anything that reaches next(err) — including from asyncHandler wrappers
//   in PATCH #3 — lands here. The 4-parameter signature is required for
//   Express to recognise this as an error middleware.
app.use((err, req, res, next) => {
    console.error('🔥 [Express error middleware]', err);
    if (!res.headersSent) {
        res.status(500).json({
            error: 'Server Error',
            details: err.message,
        });
    }
});

app.listen(PORT, () => {
    console.log('\n==================================================');
    console.log('  ✅ SERVER IS ONLINE');
    console.log('  👉 URL: ' + BASE_URL);
    console.log('  📡 Webhook: ' + WEBHOOK_URL + '/ebay/webhooks');
    console.log('==================================================\n');
 
    // Auto-subscribe with retry
    subscribeToEbayWebhooks();
});