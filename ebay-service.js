/**
 * ebay-service.js
 * All methods return { success, data?, error? }
 * Dependencies: npm i node-fetch@2 fast-xml-parser form-data
 */

const fetch      = require('node-fetch');
const FormData   = require('form-data');
const { XMLParser } = require('fast-xml-parser');

// ★ PATCH — Sharp memory safety.
//   sharp.cache(false) prevents libvips from keeping decoded images in
//   memory between calls. sharp.concurrency(1) serialises libvips work
//   so we never have 13 parallel pipelines decoding multi-MB images.
//   Both are mandatory for a long-running Node server doing image work.
const sharp = require('sharp');
sharp.cache(false);
sharp.concurrency(1);

// ─── Credentials ─────────────────────────────────────────────────────────────
const CLIENT_ID     = 'JasonHal-SJApp-PRD-618432bc3-015b6932';
const CLIENT_SECRET = 'PRD-18432bc3f47f-33fd-485b-bb0d-ba81';
const REFRESH_TOKEN = 'v^1.1#i^1#f^0#p^3#I^3#r^1#t^Ul4xMF8xMDoxNkY1NTYwMTRFMEUwNzlCOTUxQjREMUU5MzNDQzUyMl8yXzEjRV4yNjA=';

const BASE_URL        = 'https://api.ebay.com/sell/inventory/v1';
const FEED_API_URL    = 'https://api.ebay.com/sell/feed/v1';
const TRADING_API_URL = 'https://api.ebay.com/ws/api.dll';
const ACCOUNT_API_URL = 'https://api.ebay.com/sell/account/v1';

let cachedAccessToken = null;
let tokenExpiryTime   = 0;

// ─── Response helpers ─────────────────────────────────────────────────────────
const ok  = (data)  => ({ success: true,  data });
const err = (error) => ({ success: false, error: String(error) });

// =============================================================================
// OAUTH TOKENS
// =============================================================================
async function getEbayAccessToken() {
    const now = Date.now();

    if (cachedAccessToken && now < tokenExpiryTime) {
        return cachedAccessToken;
    }

    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

    const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
        method : 'POST',
        headers: {
            'Content-Type' : 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${credentials}`,
        },
        body: new URLSearchParams({
            grant_type   : 'refresh_token',
            refresh_token: REFRESH_TOKEN,
            scope: 'https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.account',
        }),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`eBay token fetch failed: ${res.status} ${body}`);
    }

    const data = await res.json();

    cachedAccessToken = data.access_token;
    tokenExpiryTime = now + (data.expires_in - 60) * 1000;

    console.log('[eBay] New OAuth token cached');

    return cachedAccessToken;
}

// =============================================================================
// TRADING API
// =============================================================================
async function updateEbayQuantity({ itemId, quantity }) {
    try {
        const ebayToken = await getEbayAccessToken();
        const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${ebayToken}</eBayAuthToken>
  </RequesterCredentials>
  <InventoryStatus>
    <ItemID>${itemId}</ItemID>
    <Quantity>${quantity}</Quantity>
  </InventoryStatus>
</ReviseInventoryStatusRequest>`;
        const res = await fetch(TRADING_API_URL, {
            method : 'POST',
            headers: {
                'X-EBAY-API-CALL-NAME'          : 'ReviseInventoryStatus',
                'X-EBAY-API-SITEID'             : '0',
                'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
                'Content-Type'                  : 'text/xml',
            },
            body: xmlBody,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const doc  = new XMLParser().parse(await res.text());
        const root = doc.ReviseInventoryStatusResponse ?? {};
        const ack  = root.Ack;
        if (!ack) throw new Error('Ack missing in eBay response');
        const fatalErrors = [].concat(root.Errors ?? []).filter(e => e.SeverityCode === 'Error');
        if (ack === 'Failure' || ack === 'PartialFailure' || fatalErrors.length) {
            throw new Error(`eBay: ${ack} | ${fatalErrors.map(e => e.ShortMessage || e.LongMessage).join(' | ')}`);
        }
        console.info(`[eBay] Quantity updated itemId=${itemId} qty=${quantity}`);
        return ok({ itemId, quantity, ack });
    } catch (e) {
        console.error('[eBay] updateEbayQuantity:', e.message);
        return err(e.message);
    }
}

// =============================================================================
// INVENTORY API
// =============================================================================
async function getOrSetMerchantLocationKey() {
    const ebayToken = await getEbayAccessToken();
    try {
        const res = await fetch(`${BASE_URL}/location`, {
            headers: { Authorization: `Bearer ${ebayToken}` },
        });
        if (res.ok) {
            const data = await res.json();
            if (data.locations?.length) return data.locations[0].merchantLocationKey;
        }
    } catch (_) {}
    const newKey = 'main-warehouse-key';
    const r = await fetch(`${BASE_URL}/location/${newKey}`, {
        method : 'POST',
        headers: { Authorization: `Bearer ${ebayToken}`, 'Content-Type': 'application/json' },
        body   : JSON.stringify({
            name    : 'Main Warehouse',
            location: {
                address: {
                    addressLine1: 'Warehouse',
                    city: 'Saint Paul',
                    stateOrProvince: 'MN',
                    postalCode: '55121',
                    country: 'US'
                }
            },
            merchantLocationStatus: 'ENABLED',
        }),
    });
    if (r.status === 204 || r.status === 200) return newKey;
    throw new Error(`Create merchant location failed: ${await r.text()}`);
}

async function createOrUpdateInventoryItem(sku, productData) {
    try {
        const ebayToken = await getEbayAccessToken();
        const body = { ...productData }; delete body.location;
        const res = await fetch(`${BASE_URL}/inventory_item/${encodeURIComponent(sku)}`, {
            method : 'PUT',
            headers: {
                Authorization     : `Bearer ${ebayToken}`,
                'Content-Type'    : 'application/json',
                Accept            : 'application/json',
                'Content-Language': 'en-US',
            },
            body: JSON.stringify(body),
        });
        if (res.status === 204) return ok(null);
        const data = await res.json();
        return res.ok ? ok(data) : err(JSON.stringify(data));
    } catch (e) { return err(e.message); }
}

async function createDraftProduct(sku, inventoryData, offerData) {
    const locationKey = await getOrSetMerchantLocationKey();
    const offer = { ...offerData, merchantLocationKey: locationKey }; delete offer.location;
    const invRes = await createOrUpdateInventoryItem(sku, inventoryData);
    if (!invRes.success) return err(`Inventory item failed: ${invRes.error}`);
    try {
        const ebayToken = await getEbayAccessToken();
        console.log("=== SENDING TO EBAY INVENTORY API ===");
        console.log(JSON.stringify(inventoryData, null, 2));
        console.log("=== SENDING TO EBAY OFFER API ===");
        console.log(JSON.stringify(offer, null, 2));
        const res = await fetch(`${BASE_URL}/offer`, {
            method : 'POST',
            headers: {
                Authorization     : `Bearer ${ebayToken}`,
                'Content-Type'    : 'application/json',
                Accept            : 'application/json',
                'Content-Language': 'en-US',
            },
            body: JSON.stringify(offer),
        });
        const data = await res.json();
        return res.ok ? ok(data) : err(JSON.stringify(data) ?? 'Unknown offer error');
    } catch (e) { return err(e.message); }
}

async function createAndMakeItDraft(sku, inventoryData, offerData) {
    const res = await createDraftProduct(sku, inventoryData, offerData);
    return res.success ? ok({ offerId: res.data.offerId }) : res;
}

async function publishOffer(offerId) {
    try {
        const ebayToken = await getEbayAccessToken();
        const res = await fetch(`${BASE_URL}/offer/${encodeURIComponent(offerId)}/publish`, {
            method : 'POST',
            headers: { Authorization: `Bearer ${ebayToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        });
        const data = await res.json();
        return res.ok ? ok({ listingId: data.listingId, offerId, fullResponse: data }) : err(JSON.stringify(data));
    } catch (e) { return err(e.message); }
}

async function bulkGetInventoryItems(skus = []) {
    if (!skus.length) return ok({ inventoryMap: {} });
    try {
        const ebayToken = await getEbayAccessToken();
        const res = await fetch(`${BASE_URL}/bulk_get_inventory_item`, {
            method : 'POST',
            headers: { Authorization: `Bearer ${ebayToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
            body   : JSON.stringify({ requests: skus.map(sku => ({ sku })) }),
        });
        if (!res.ok) return err(await res.text());
        const data = await res.json();
        const inventoryMap = Object.fromEntries(
            (data.responses ?? []).filter(r => r.statusCode === 200 && r.sku).map(r => [r.sku, r])
        );
        return ok({ inventoryMap });
    } catch (e) { return err(e.message); }
}

async function getOffer(offerId) {
    try {
        const ebayToken = await getEbayAccessToken();
        const res = await fetch(`${BASE_URL}/offer/${encodeURIComponent(offerId)}`, {
            headers: { Authorization: `Bearer ${ebayToken}`, Accept: 'application/json' },
        });
        if (!res.ok) return err(await res.text());
        const data = await res.json();
        return ok({ offerId, listingId: data.listing?.listingId ?? null, status: data.status, sku: data.sku, fullData: data });
    } catch (e) { return err(e.message); }
}

async function getItemIdFromOfferId(offerId) {
    const res = await getOffer(offerId);
    if (!res.success) return res;
    return res.data.listingId
        ? ok({ itemId: res.data.listingId, offerId, status: res.data.status })
        : err('Offer not published yet.');
}

async function withdrawOffer(offerId) {
    try {
        const ebayToken = await getEbayAccessToken();
        const res = await fetch(`${BASE_URL}/offer/${encodeURIComponent(offerId)}/withdraw`, {
            method : 'POST',
            headers: { Authorization: `Bearer ${ebayToken}`, 'Content-Type': 'application/json' },
        });
        return res.ok ? ok({ message: 'Offer withdrawn successfully' }) : err(await res.text());
    } catch (e) { return err(e.message); }
}

async function deleteOffer(offerId) {
    try {
        const ebayToken = await getEbayAccessToken();
        const res = await fetch(`${BASE_URL}/offer/${encodeURIComponent(offerId)}`, {
            method : 'DELETE',
            headers: { Authorization: `Bearer ${ebayToken}` },
        });
        return (res.status === 204 || res.status === 200)
            ? ok({ message: 'Offer deleted successfully' })
            : err(await res.text());
    } catch (e) { return err(e.message); }
}

async function updateOffer(offerId, updates) {
    try {
        const ebayToken = await getEbayAccessToken();
        const res = await fetch(`${BASE_URL}/offer/${encodeURIComponent(offerId)}`, {
            method : 'PUT',
            headers: {
                Authorization     : `Bearer ${ebayToken}`,
                'Content-Type'    : 'application/json',
                Accept            : 'application/json',
                'Content-Language': 'en-US',
            },
            body: JSON.stringify(updates),
        });
        return (res.status === 204 || res.status === 200)
            ? ok({ message: 'Offer updated successfully' })
            : err(await res.text());
    } catch (e) { return err(e.message); }
}

async function getAllOffers({ limit = 100, offset = 0 } = {}) {
    try {
        const ebayToken = await getEbayAccessToken();
        const res = await fetch(`${BASE_URL}/offer?limit=${limit}&offset=${offset}`, {
            headers: { Authorization: `Bearer ${ebayToken}`, Accept: 'application/json' },
        });
        if (!res.ok) return err(await res.text());
        const data = await res.json();
        return ok({ offers: data.offers ?? [], total: data.total ?? 0 });
    } catch (e) { return err(e.message); }
}

async function getAllInventoryItems() {
    const all = []; let offset = 0;
    try {
        while (true) {
            const ebayToken = await getEbayAccessToken();
            const res = await fetch(`${BASE_URL}/inventory_item?limit=100&offset=${offset}`, {
                headers: { Authorization: `Bearer ${ebayToken}`, Accept: 'application/json' },
            });
            if (!res.ok) return err(await res.text());
            const data  = await res.json();
            const items = data.inventoryItems ?? [];
            all.push(...items);
            if (items.length < 100) break;
            offset += items.length;
        }
        return ok({ inventoryItems: all });
    } catch (e) { return err(e.message); }
}

async function getOffersForSku(sku) {
    try {
        const ebayToken = await getEbayAccessToken();
        const res = await fetch(`${BASE_URL}/offer?sku=${encodeURIComponent(sku)}`, {
            headers: { Authorization: `Bearer ${ebayToken}`, Accept: 'application/json' },
        });
        return res.ok ? ok(await res.json()) : err(await res.text());
    } catch (e) { return err(e.message); }
}

// =============================================================================
// ACCOUNT API
// =============================================================================
async function getPaymentPolicy(policyId) {
    try {
        const ebayToken = await getEbayAccessToken();
        const res = await fetch(`${ACCOUNT_API_URL}/payment_policy/${encodeURIComponent(policyId)}`, {
            headers: { Authorization: `Bearer ${ebayToken}`, Accept: 'application/json' },
        });
        return res.ok ? ok(await res.json()) : err(await res.text());
    } catch (e) { return err(e.message); }
}

async function getReturnPolicy(policyId) {
    try {
        const ebayToken = await getEbayAccessToken();
        const res = await fetch(`${ACCOUNT_API_URL}/return_policy/${encodeURIComponent(policyId)}`, {
            headers: { Authorization: `Bearer ${ebayToken}`, Accept: 'application/json' },
        });
        return res.ok ? ok(await res.json()) : err(await res.text());
    } catch (e) { return err(e.message); }
}

async function getFulfillmentPolicy(policyId) {
    try {
        const ebayToken = await getEbayAccessToken();
        const res = await fetch(`${ACCOUNT_API_URL}/fulfillment_policy/${encodeURIComponent(policyId)}`, {
            headers: { Authorization: `Bearer ${ebayToken}`, Accept: 'application/json' },
        });
        return res.ok ? ok(await res.json()) : err(await res.text());
    } catch (e) { return err(e.message); }
}

// =============================================================================
// FX LISTING FEED API  — TSV-based (tab-separated values)
// Tabs cannot appear in policy names or any eBay field value, so TSV
// eliminates all comma-escaping issues that plagued the CSV approach.
// =============================================================================

const CONDITION_CODE_MAP = {
    // ── Numeric codes as strings (in case condition arrives as "1500") ─
    '1000': 1000, '1500': 1500, '1750': 1750,
    '2000': 2000, '2010': 2010, '2020': 2020, '2030': 2030, '2040': 2040,
    '2500': 2500, '2750': 2750,
    '3000': 3000, '4000': 4000, '5000': 5000, '6000': 6000, '7000': 7000,

    // ── 1000 — New / Brand New ─────────────────────────────────────────
    'NEW':                        1000,
    'BRAND NEW':                  1000,
    'BRAND_NEW':                  1000,
    'BRAND-NEW':                  1000,
    'BRANDNEW':                   1000,

    // ── 1500 — Open Box / New Other ────────────────────────────────────
    'NEW_OTHER':                  1500,
    'NEW OTHER':                  1500,
    'NEW-OTHER':                  1500,
    'NEWOTHER':                   1500,
    'OPEN BOX':                   1500,
    'OPEN_BOX':                   1500,
    'OPEN-BOX':                   1500,
    'OPENBOX':                    1500,

    // ── 1750 — New with Defects ────────────────────────────────────────
    'NEW_WITH_DEFECTS':           1750,
    'NEW WITH DEFECTS':           1750,
    'NEW-WITH-DEFECTS':           1750,

    // ── 2000 — Manufacturer Refurbished ────────────────────────────────
    'MANUFACTURER_REFURBISHED':   2000,
    'MANUFACTURER REFURBISHED':   2000,
    'MANUFACTURER-REFURBISHED':   2000,

    // ── 2010 — Certified Refurbished ───────────────────────────────────
    'CERTIFIED_REFURBISHED':      2010,
    'CERTIFIED REFURBISHED':      2010,
    'CERTIFIED-REFURBISHED':      2010,
    'CERTIFIED - REFURBISHED':    2010,

    // ── 2020 — Excellent Refurbished ───────────────────────────────────
    'EXCELLENT_REFURBISHED':      2020,
    'EXCELLENT REFURBISHED':      2020,
    'EXCELLENT-REFURBISHED':      2020,
    'EXCELLENT - REFURBISHED':    2020,

    // ── 2030 — Very Good Refurbished ───────────────────────────────────
    'VERY_GOOD_REFURBISHED':      2030,
    'VERY GOOD REFURBISHED':      2030,
    'VERY-GOOD-REFURBISHED':      2030,
    'VERY GOOD - REFURBISHED':    2030,

    // ── 2040 — Good Refurbished ────────────────────────────────────────
    'GOOD_REFURBISHED':           2040,
    'GOOD REFURBISHED':           2040,
    'GOOD-REFURBISHED':           2040,
    'GOOD - REFURBISHED':         2040,

    // ── 2500 — Seller Refurbished ──────────────────────────────────────
    'SELLER_REFURBISHED':         2500,
    'SELLER REFURBISHED':         2500,
    'SELLER-REFURBISHED':         2500,
    'REFURBISHED':                2500,

    // ── 2750 — Like New ────────────────────────────────────────────────
    'LIKE_NEW':                   2750,
    'LIKE NEW':                   2750,
    'LIKE-NEW':                   2750,
    'LIKENEW':                    2750,

    // ── 3000 — Used ────────────────────────────────────────────────────
    'USED':                       3000,
    'USED_EXCELLENT':             3000,
    'USED EXCELLENT':             3000,
    'USED-EXCELLENT':             3000,
    'USED_VERY_GOOD':             3000,
    'USED VERY GOOD':             3000,
    'USED-VERY-GOOD':             3000,
    'USED_GOOD':                  3000,
    'USED GOOD':                  3000,
    'USED-GOOD':                  3000,

    // ── 4000 — Used Acceptable / Very Good (media) ─────────────────────
    'USED_ACCEPTABLE':            4000,
    'USED ACCEPTABLE':            4000,
    'USED-ACCEPTABLE':            4000,
    'VERY_GOOD':                  4000,
    'VERY GOOD':                  4000,
    'VERY-GOOD':                  4000,
    'VERYGOOD':                   4000,

    // ── 5000 — Good (media) ────────────────────────────────────────────
    'GOOD':                       5000,

    // ── 6000 — Acceptable (media) ──────────────────────────────────────
    'ACCEPTABLE':                 6000,

    // ── 7000 — For Parts or Not Working ────────────────────────────────
    'FOR_PARTS_OR_NOT_WORKING':   7000,
    'FOR PARTS OR NOT WORKING':   7000,
    'FOR-PARTS-OR-NOT-WORKING':   7000,
    'FOR_PARTS':                  7000,
    'FOR PARTS':                  7000,
    'FOR-PARTS':                  7000,
    'FORPARTS':                   7000,
    'NOT_WORKING':                7000,
    'NOT WORKING':                7000,
    'NOT-WORKING':                7000,
    'PARTS':                      7000,
    'PARTS_OR_NOT_WORKING':       7000,
    'PARTS OR NOT WORKING':       7000,
    'BROKEN':                     7000,
};
// ---------------------------------------------------------------------------
// cleanCell — sanitise a single TSV cell.
// Strips newlines and tabs so no value can accidentally create a new
// row or column in the TSV output.
// ---------------------------------------------------------------------------
function cleanCell(value) {
    return String(value ?? '')
        .replace(/\r?\n|\r/g, ' ')  // newlines → space
        .replace(/\t/g, ' ')         // tabs → space
        .trim();
}

// ---------------------------------------------------------------------------
// cleanCsvCell — kept for any legacy callers; not used by FX pipeline.
// ---------------------------------------------------------------------------
function cleanCsvCell(value) {
    let v = String(value ?? '')
        .replace(/\r?\n|\r/g, ' ')
        .replace(/\t/g, ' ')
        .trim();
    if (v.includes('"')) v = v.replace(/"/g, '""');
    if (v.includes(',') || v.includes('"')) v = `"${v}"`;
    return v;
}

// ---------------------------------------------------------------------------
// stripHtml — remove HTML tags + decode common entities + collapse whitespace.
// ---------------------------------------------------------------------------
function stripHtml(html) {
    return (html ?? '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
}

// ---------------------------------------------------------------------------
// EPS upload — uses getEbayAccessToken (Trading API)
// ---------------------------------------------------------------------------

const MAX_EPS_SIZE = 7 * 1024 * 1024;       // 7 MB
const TARGET_SIZE  = 6.7 * 1024 * 1024;      // ~6.7 MB

async function compressImageBuffer(buffer, targetBytes = TARGET_SIZE) {
    // sharp is required at the top of the file with cache(false) + concurrency(1)
    for (let quality = 92; quality >= 30; quality -= 5) {
        const compressed = await sharp(buffer)
            .jpeg({ quality, mozjpeg: true })
            .toBuffer();
        console.log(`[EPS compress] quality=${quality} → ${(compressed.length / 1024 / 1024).toFixed(2)} MB`);
        if (compressed.length <= targetBytes) return compressed;
    }
    // Last resort: resize down + low quality
    const metadata = await sharp(buffer).metadata();
    return sharp(buffer)
        .resize(Math.round(metadata.width * 0.8), null, { withoutEnlargement: true })
        .jpeg({ quality: 40, mozjpeg: true })
        .toBuffer();
}
async function uploadImageToEbayEps(imageUrl) {
    if (!imageUrl || !imageUrl.startsWith('http')) return imageUrl;
    try {
        const ebayToken = await getEbayAccessToken();

        // ── Download to check size ───────────────────────────────────────
        const imgRes = await fetch(imageUrl);
        if (!imgRes.ok) throw new Error(`Image download failed: ${imgRes.status}`);
        const imgBuffer = await imgRes.buffer();
        const sizeMB = (imgBuffer.length / 1024 / 1024).toFixed(2);
        console.log(`[EPS] Image size: ${sizeMB} MB — ${imageUrl}`);

        if (imgBuffer.length >= MAX_EPS_SIZE) {
            // ── ≥7 MB: compress → binary multipart upload ────────────────
            console.log(`[EPS] ⚠️  ${sizeMB} MB ≥ 7 MB — compressing...`);
            const compressed = await compressImageBuffer(imgBuffer);
            console.log(`[EPS] ✅ Compressed to ${(compressed.length / 1024 / 1024).toFixed(2)} MB`);

            const xmlPayload = `<?xml version="1.0" encoding="utf-8"?>
<UploadSiteHostedPicturesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${ebayToken}</eBayAuthToken>
  </RequesterCredentials>
  <PictureName>img_${Date.now()}_${Math.round(Math.random() * 1e6)}</PictureName>
  <PictureSet>Supersize</PictureSet>
</UploadSiteHostedPicturesRequest>`;

            const form = new FormData();
            form.append('XML Payload', xmlPayload, { contentType: 'text/xml' });
            form.append('image', compressed, {
                filename: `compressed_${Date.now()}.jpg`,
                contentType: 'image/jpeg',
            });

            const res = await fetch(TRADING_API_URL, {
                method : 'POST',
                headers: {
                    'X-EBAY-API-CALL-NAME'          : 'UploadSiteHostedPictures',
                    'X-EBAY-API-SITEID'             : '0',
                    'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
                    ...form.getHeaders(),
                },
                body: form,
            });

            const text = await res.text();
            const doc  = new XMLParser({ ignoreAttributes: false }).parse(text);
            const root = doc['UploadSiteHostedPicturesResponse'] ?? {};
            const ack  = root.Ack ?? '';
            if (ack === 'Success' || ack === 'Warning') {
                const epsUrl = root.SiteHostedPictureDetails?.FullURL;
                if (epsUrl) {
                    console.log(`[EPS] ✅ (compressed) ${imageUrl} → ${epsUrl}`);
                    return epsUrl;
                }
            }
            const errMsg = [].concat(root.Errors ?? []).map(e => e.ShortMessage || e.LongMessage).join(' | ');
            console.warn(`[EPS] ⚠️  Failed (${ack}) for compressed ${imageUrl}: ${errMsg}`);
            return imageUrl;

        } else {
            // ── < 7 MB: original ExternalPictureURL path ─────────────────
            const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<UploadSiteHostedPicturesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${ebayToken}</eBayAuthToken>
  </RequesterCredentials>
  <ExternalPictureURL>${imageUrl}</ExternalPictureURL>
  <PictureName>img_${Date.now()}_${Math.round(Math.random() * 1e6)}</PictureName>
  <PictureSet>Supersize</PictureSet>
</UploadSiteHostedPicturesRequest>`;

            const res = await fetch(TRADING_API_URL, {
                method : 'POST',
                headers: {
                    'X-EBAY-API-CALL-NAME'          : 'UploadSiteHostedPictures',
                    'X-EBAY-API-SITEID'             : '0',
                    'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
                    'Content-Type'                  : 'text/xml',
                },
                body: xmlBody,
            });
            const text = await res.text();
            const doc  = new XMLParser({ ignoreAttributes: false }).parse(text);
            const root = doc['UploadSiteHostedPicturesResponse'] ?? {};
            const ack  = root.Ack ?? '';
            if (ack === 'Success' || ack === 'Warning') {
                const epsUrl = root.SiteHostedPictureDetails?.FullURL;
                if (epsUrl) {
                    console.log(`[EPS] ✅ ${imageUrl} → ${epsUrl}`);
                    return epsUrl;
                }
            }
            const errMsg = [].concat(root.Errors ?? []).map(e => e.ShortMessage || e.LongMessage).join(' | ');
            console.warn(`[EPS] ⚠️  Failed (${ack}) for ${imageUrl}: ${errMsg}`);
            return imageUrl;
        }
    } catch (e) {
        console.warn(`[EPS] ⚠️  Exception for ${imageUrl}: ${e.message}`);
        return imageUrl;
    }
}

async function uploadAllImagesToEps(imageUrls = []) {
    return Promise.all(imageUrls.map(url => uploadImageToEbayEps(url)));
}

function _parseAspects(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch { return {}; }
}

// ---------------------------------------------------------------------------
// generateFxListingTsvFromRaw
// Outputs a TSV (tab-separated) file instead of CSV, which means policy
// names containing commas (e.g. "Returns Accepted,Seller,30 Days,...") are
// written verbatim without any quoting or escaping issues.
// ---------------------------------------------------------------------------
async function generateFxListingCsvFromRaw(inventoryData, offerData) {
    const product = inventoryData.product ?? {};
    const pricing = offerData.pricingSummary?.price ?? {};
    const pkg = inventoryData.packageWeightAndSize ?? inventoryData.package_weight_and_size ?? {};
    const dims = pkg.dimensions ?? {};
    const weight = pkg.weight ?? {};
    const aspects = _parseAspects(product.aspects);

    const policies = offerData.listingPolicies ?? {};
    const paymentPolicyId     = policies.paymentPolicyId;
    const returnPolicyId      = policies.returnPolicyId;
    const fulfillmentPolicyId = policies.fulfillmentPolicyId;

    console.log(paymentPolicyId);
    console.log(returnPolicyId);
    console.log(fulfillmentPolicyId);

    const scheduleDate = new Date();
    scheduleDate.setDate(scheduleDate.getDate() + 5);
    const formattedScheduleTime = scheduleDate.toISOString();

    const rawImages = (product.imageUrls ?? []).filter(Boolean);

    let payPol = null, retPol = null, fulPol = null;
    const fetchTasks = [ uploadAllImagesToEps(rawImages) ];

    if (paymentPolicyId) {
        fetchTasks.push(getPaymentPolicy(paymentPolicyId).then(r => { payPol = r.success ? r.data : null; }));
    }
    if (returnPolicyId) {
        fetchTasks.push(getReturnPolicy(returnPolicyId).then(r => { retPol = r.success ? r.data : null; }));
    }
    if (fulfillmentPolicyId) {
        fetchTasks.push(getFulfillmentPolicy(fulfillmentPolicyId).then(r => { fulPol = r.success ? r.data : null; }));
    }

    const [hostedImages] = await Promise.all(fetchTasks);

    console.log('[FX Policy Fetch Results]', {
        payPol: payPol ? payPol.name : 'NULL - fetch failed',
        retPol: retPol ? retPol.name : 'NULL - fetch failed',
        fulPol: fulPol ? fulPol.name : 'NULL - fetch failed',
    });

    const rowData = {
        "Action"              : "Add",
        "CustomLabel"         : (offerData.sku ?? '').trim(),
        "MarketplaceID"       : "EBAY_US",
        "Format"              : "FixedPriceItem",
        "Title"               : product.title ?? "",
        "Description"         : offerData.listingDescription || product.description,
        "CategoryID"          : product.categoryId ?? offerData.categoryId ?? '',
        "Condition"           : CONDITION_CODE_MAP[(inventoryData.condition ?? '').toUpperCase()] ?? 3000,
        "ConditionDescription": inventoryData.conditionDescription ?? '',
        "Price"               : parseFloat(pricing.value ?? 0).toFixed(2),
        "Currency"            : pricing.currency ?? 'USD',
        "AvailableQuantity"   : Math.max(1, parseInt(offerData.availableQuantity ?? 1, 10)),
    };

    // Policy names — commas in these values are safe because we use TSV
    if (payPol?.name || paymentPolicyId) {
        rowData["PaymentProfileName"] = payPol?.name || paymentPolicyId;
    }
    if (retPol?.name || returnPolicyId) {
        rowData["ReturnProfileName"] = retPol?.name || returnPolicyId;
    }
    if (fulPol?.name || fulfillmentPolicyId) {
        rowData["ShippingProfileName"] = fulPol?.name || fulfillmentPolicyId;
    }

    const resolveIdentifier = (v1, v2) => {
        const isValid = (v) => v && v.length > 0 && String(v).toLowerCase() !== 'does not apply';
        if (isValid(v1)) return String(v1).split(',')[0].trim();
        if (isValid(v2)) return String(v2).split(',')[0].trim();
        return "Does Not Apply";
    };

    rowData["UPC"]     = resolveIdentifier(product.upc, aspects.UPC);
    rowData["C:MPN"]   = resolveIdentifier(product.mpn, aspects.MPN);
    rowData["C:Brand"] = (aspects.Brand || product.brand || "Unbranded").trim();

    for (const [key, value] of Object.entries(aspects)) {
        if (['Brand', 'MPN', 'UPC', 'Condition'].includes(key)) continue;
        if (value) {
            let processedValue = String(value).trim();
            if (processedValue.includes(',')) {
                processedValue = processedValue.split(',').map(s => s.trim()).filter(s => s.length > 0).join('|');
            }
            if (processedValue && processedValue !== '|') rowData[`C:${key}`] = processedValue;
        }
    }

    if (hostedImages.length === 0) throw new Error(`SKU ${offerData.sku} has no images.`);
    rowData["PicURL"] = hostedImages.join("|");

    const isImperial  = (weight.unit ?? '').toUpperCase() === 'POUND';
    const majorWeight = Math.floor(weight.value ?? 0);
    const minorWeight = isImperial
        ? Math.round(((weight.value ?? 0) - majorWeight) * 16)
        : Math.round(((weight.value ?? 0) - majorWeight) * 1000);

    Object.assign(rowData, {
        "WeightMajor"      : majorWeight || "",
        "WeightMinor"      : minorWeight || "",
        "PackageLength"    : dims.length ?? "",
        "PackageWidth"     : dims.width ?? "",
        "PackageDepth"     : dims.height ?? "",
        "MeasurementUnit"  : isImperial ? "English" : "Metric",
        "ListingDuration"  : "GTC",
        "Location"         : "Saint Paul, MN",
        "Country"          : "US",
        "PostalCode"       : "55121",
        "GalleryType"      : "Gallery",
        "ScheduleTime"     : formattedScheduleTime,
    });

    // ── Output as TSV (tab-separated) ────────────────────────────────────────
    // cleanCell strips any stray tabs/newlines inside values so no cell
    // can corrupt the column alignment.
    const headers = Object.keys(rowData);
    const values  = Object.values(rowData).map(cleanCell);

    const tsv = [headers.join("\t"), values.join("\t")].join("\n");

    console.log('[FX TSV preview]', tsv.substring(0, 300));
    console.log('[FX Policy Names in TSV]', {
        payment : rowData["PaymentProfileName"],
        returns : rowData["ReturnProfileName"],
        shipping: rowData["ShippingProfileName"],
    });

    return tsv;
}

// ---------------------------------------------------------------------------
// Step 2 — Create Feed Task
// ---------------------------------------------------------------------------
async function createFxListingTask() {
    try {
        const feedToken = await getEbayAccessToken();
        const res = await fetch(`${FEED_API_URL}/task`, {
            method : 'POST',
            headers: {
                Authorization            : `Bearer ${feedToken}`,
                'Content-Type'           : 'application/json',
                Accept                   : 'application/json',
                'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
            },
            body: JSON.stringify({ feedType: 'FX_LISTING', schemaVersion: '1.0' }),
        });
        if (res.status === 204 || res.status === 201 || res.status === 202) {
            const location = res.headers.get('location') || res.headers.get('Location') || '';
            const taskId   = location.split('/').pop() || '';
            if (!taskId) {
                console.error('[FX] Location header missing:', Object.fromEntries(res.headers.entries()));
                return err('Task created but Location header missing — cannot extract taskId.');
            }
            console.log(`[FX] Task created: ${taskId}`);
            return ok({ taskId });
        }
        const body = await res.text();
        let detail = body;
        try { detail = JSON.stringify(JSON.parse(body)); } catch (_) {}
        console.error(`[FX] createFxListingTask unexpected status ${res.status}:`, detail);
        return err(`HTTP ${res.status}: ${detail}`);
    } catch (e) { return err(e.message); }
}

// ---------------------------------------------------------------------------
// Step 3 — Upload TSV file
// Content-Type is now text/tab-separated-values to match the TSV output.
// ---------------------------------------------------------------------------
async function uploadFxListingFile(taskId, tsvContent) {
    try {
        const feedToken = await getEbayAccessToken();
        const form      = new FormData();
        form.append('file', Buffer.from(tsvContent, 'utf-8'), {
            filename   : 'fx_listing.tsv',
            contentType: 'text/tab-separated-values',  // ← was 'text/csv'
        });
        const res = await fetch(
            `${FEED_API_URL}/task/${encodeURIComponent(taskId)}/upload_file`,
            {
                method : 'POST',
                headers: {
                    Authorization            : `Bearer ${feedToken}`,
                    'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
                    ...form.getHeaders(),
                },
                body: form,
            }
        );
        if (res.status === 204) return ok({ message: 'File uploaded successfully', taskId });
        const body = await res.text();
        return res.ok ? ok({ message: body, taskId }) : err(body);
    } catch (e) { return err(e.message); }
}

// ---------------------------------------------------------------------------
// Step 4 — Poll task status
// ---------------------------------------------------------------------------
async function getFxTask(taskId) {
    try {
        const feedToken = await getEbayAccessToken();
        const res = await fetch(`${FEED_API_URL}/task/${encodeURIComponent(taskId)}`, {
            headers: {
                Authorization            : `Bearer ${feedToken}`,
                Accept                   : 'application/json',
                'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
            },
        });
        return res.ok ? ok(await res.json()) : err(await res.text());
    } catch (e) { return err(e.message); }
}

// ---------------------------------------------------------------------------
// Step 5 — List all tasks
// ---------------------------------------------------------------------------
async function getAllFxTasks({ limit = 25, offset = 0 } = {}) {
    try {
        const feedToken = await getEbayAccessToken();
        const res = await fetch(
            `${FEED_API_URL}/task?feed_type=FX_LISTING&limit=${limit}&offset=${offset}`,
            {
                headers: {
                    Authorization            : `Bearer ${feedToken}`,
                    Accept                   : 'application/json',
                    'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
                },
            }
        );
        return res.ok ? ok(await res.json()) : err(await res.text());
    } catch (e) { return err(e.message); }
}

// ---------------------------------------------------------------------------
// Step 6 — Download + parse result file
// eBay's result file for a TSV-uploaded task is also TSV, so we split on
// tabs instead of running the CSV parser.
// ---------------------------------------------------------------------------
async function downloadAndParseFxTaskResults(taskId) {
    try {
        const feedToken = await getEbayAccessToken();
        const res = await fetch(
            `${FEED_API_URL}/task/${encodeURIComponent(taskId)}/download_result_file`,
            {
                headers: {
                    Authorization            : `Bearer ${feedToken}`,
                    'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
                },
            }
        );

        if (!res.ok) return err(await res.text());

        const raw   = await res.text();
        const lines = raw.split(/\r?\n/);
        if (lines.length < 2) return ok({ skuToItemId: {}, rows: [] });

        // Find the header row (eBay sometimes prepends a *Action metadata row)
        const headerRowIdx = lines[0].startsWith('*Action') ? 1 : 0;

        // ── Split on TAB (not comma) ─────────────────────────────────────────
        const headers = lines[headerRowIdx].split('\t').map(h => h.trim().toLowerCase());

        const findIndex = (possibleNames, fallbackIndex) => {
            const idx = headers.findIndex(h => possibleNames.includes(h));
            return idx !== -1 ? idx : fallbackIndex;
        };

        const LINE_NUM_INDEX   = findIndex(['linenumber', 'line number'], 0);
        const ACTION_INDEX     = findIndex(['action'], 1);
        const STATUS_INDEX     = findIndex(['status'], 2);
        const ERROR_CODE_INDEX = findIndex(['errorcode', 'error code'], 5);
        const ERROR_MSG_INDEX  = findIndex(['errormessage', 'error message'], 6);
        const ITEM_ID_INDEX    = findIndex(['itemid', 'item id'], 9);
        const SKU_INDEX        = findIndex(['customlabel', 'custom label'], 36);

        const skuToItemId = {};
        const parsedRows  = [];

        for (let i = headerRowIdx + 1; i < lines.length; i++) {
            if (!lines[i].trim()) continue;

            // ── Split on TAB ─────────────────────────────────────────────────
            const cols = lines[i].split('\t');

            const lineNumber = cols[LINE_NUM_INDEX] || String(i + 1);
            const action     = cols[ACTION_INDEX]   || '';
            const statusStr  = (cols[STATUS_INDEX]  || '').trim().toLowerCase();
            const codesRaw   = cols[ERROR_CODE_INDEX] || '';
            const msgsRaw    = cols[ERROR_MSG_INDEX]  || '';
            const itemId     = cols[ITEM_ID_INDEX]    || null;
            const sku        = cols[SKU_INDEX]         || '';

            // eBay separates multiple ErrorCodes with '|' and ErrorMessages with '||'
            const codes    = codesRaw.split('|').map(c => c.trim()).filter(Boolean);
            const messages = msgsRaw.split('||').map(m => m.trim()).filter(Boolean);

            const isFailure = statusStr === 'failure' || statusStr === 'error';
            const isError   = isFailure || (!itemId && ['add', 'revise', 'relist'].includes(action.toLowerCase()));
            const isWarning = statusStr === 'warning' && !isError;
            const finalStatus = isError ? 'Error' : (isWarning ? 'Warning' : 'Success');

            const rowResult = {
                lineNumber,
                action,
                sku,
                itemId: itemId || null,
                status: finalStatus,
                errors: [],
                warnings: [],
                raw: lines[i],
            };

            if (isError) {
                if (codes.length === 0 && messages.length === 0) {
                    rowResult.errors.push({
                        code: 'MISSING_ITEM_ID',
                        description: 'eBay returned a success/warning status but the Item ID was missing.',
                    });
                } else {
                    const maxLen = Math.max(codes.length, messages.length);
                    for (let j = 0; j < maxLen; j++) {
                        rowResult.errors.push({
                            code: codes[j] || 'UNKNOWN_CODE',
                            description: messages[j] || 'No description provided by eBay.',
                        });
                    }
                }
            } else if (isWarning) {
                const maxLen = Math.max(codes.length, messages.length);
                for (let j = 0; j < maxLen; j++) {
                    const codeStr = codes[j] ? `[${codes[j]}] ` : '';
                    const msgStr  = messages[j] || 'Unknown warning text';
                    rowResult.warnings.push(`${codeStr}${msgStr}`);
                }
            }

            if (!isError && sku && itemId) {
                skuToItemId[sku] = itemId;
            }

            parsedRows.push(rowResult);
        }

        return ok({ skuToItemId, rows: parsedRows });
    } catch (e) {
        return err(e.message);
    }
}

async function changeSKUForItemID({ itemId, sku }) {
    try {
        const ebayToken = await getEbayAccessToken();
        const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${ebayToken}</eBayAuthToken>
  </RequesterCredentials>
  <Item>
    <ItemID>${itemId}</ItemID>
    <SKU>${sku}</SKU>
  </Item>
</ReviseFixedPriceItemRequest>`;
        const res = await fetch(TRADING_API_URL, {
            method : 'POST',
            headers: {
                'X-EBAY-API-CALL-NAME'          : 'ReviseFixedPriceItem',
                'X-EBAY-API-SITEID'             : '0',
                'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
                'Content-Type'                  : 'text/xml',
            },
            body: xmlBody,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const doc  = new XMLParser().parse(await res.text());
        const root = doc.ReviseFixedPriceItemResponse ?? {};
        const ack  = root.Ack;
        if (!ack) throw new Error('Ack missing in eBay response');
        const fatalErrors = [].concat(root.Errors ?? []).filter(e => e.SeverityCode === 'Error');
        if (ack === 'Failure' || ack === 'PartialFailure' || fatalErrors.length) {
            throw new Error(`eBay: ${ack} | ${fatalErrors.map(e => e.ShortMessage || e.LongMessage).join(' | ')}`);
        }
        console.info(`[eBay] SKU updated itemId=${itemId} sku=${sku}`);
        return ok({ itemId, sku, ack });
    } catch (e) {
        console.error('[eBay] changeSKUForItemID:', e.message);
        return err(e.message);
    }
}

// =============================================================================
// EXPORTS
// =============================================================================
module.exports = {
    // OAuth
    getEbayAccessToken,

    // Trading API
    updateEbayQuantity,

    // Inventory API
    getOrSetMerchantLocationKey,
    createOrUpdateInventoryItem,
    createDraftProduct,
    createAndMakeItDraft,
    publishOffer,
    bulkGetInventoryItems,
    getOffer,
    getItemIdFromOfferId,
    withdrawOffer,
    deleteOffer,
    updateOffer,
    getAllOffers,
    getAllInventoryItems,
    getOffersForSku,

    // FX Listing Feed API
    uploadImageToEbayEps,
    uploadAllImagesToEps,
    generateFxListingCsvFromRaw,
    getConditionCode: (conditionString) => CONDITION_CODE_MAP[(conditionString ?? '').toUpperCase()] ?? 3000,
    createFxListingTask,
    uploadFxListingFile,
    getFxTask,
    getAllFxTasks,
    downloadAndParseFxTaskResults,
    changeSKUForItemID
};