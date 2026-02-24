import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";
import heicConvert from "heic-convert";
import swaggerUi from "swagger-ui-express";

import { AccessoriesStore } from "./accessoriesStore.js";
import { buildEditPrompt } from "./prompt.js";
import { openapiSpec } from "./openapi.js";

const app = express();
const PORT = process.env.PORT || 3000;

// --------------------
// CORS (safe)
// --------------------
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.length === 0) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.options("*", cors());

// --------------------
// Swagger (MUST be before other routes)
// --------------------
app.get("/", (req, res) => res.redirect("/docs"));
app.get("/openapi.json", (req, res) => res.json(openapiSpec));
app.use(
  "/docs",
  swaggerUi.serve,
  swaggerUi.setup(openapiSpec, {
    explorer: true,
    customSiteTitle: "BMW Render Configurator API Docs",
  })
);

// --------------------
// Upload
// --------------------
const upload = multer({ limits: { fileSize: 15 * 1024 * 1024 } });

// --------------------
// Data store
// --------------------
const store = new AccessoriesStore();
try {
  const count = store.load();
  console.log(`Loaded accessories: ${count}`);
} catch (e) {
  console.error("Failed to load accessories_merged.json:", e);
}

// --------------------
// Routes
// --------------------
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/v1/accessories", (req, res) => {
  const q = String(req.query.q || "");
  const limit = Number(req.query.limit || 100);
  const mountableOnly = String(req.query.mountable_only || "false") === "true";
  res.json(store.search({ q, limit, mountableOnly }));
});

function normalizeVariant(v) {
  const s = String(v || "").toLowerCase().trim();
  if (s === "r1300gs" || s === "r1300gs_adventure") return s;
  return null;
}

function normalizeView(v) {
  const s = String(v || "left").toLowerCase().trim();
  const allowed = new Set(["left", "right", "front_3q", "rear_3q"]);
  return allowed.has(s) ? s : "left";
}

// For non-dall-e-2 models (if you ever enable them)
function normalizeSize(s) {
  const v = String(s || "1536x1024").trim();
  const allowed = new Set(["1024x1024", "1536x1024", "1024x1536"]);
  return allowed.has(v) ? v : "1536x1024";
}

// DALL·E 2 edits require square sizes: 256/512/1024
function normalizeDalle2Size() {
  return "1024x1024";
}

function viewText(view) {
  if (view === "front_3q") return "front three-quarter view";
  if (view === "rear_3q") return "rear three-quarter view";
  return `${view} side view`;
}

function variantText(variant) {
  return variant === "r1300gs_adventure" ? "BMW R1300GS Adventure" : "BMW R1300GS";
}

/**
 * DALL·E 2 has prompt max length 1000.
 * This builds a compact prompt (names only) and guarantees maxLen.
 */
function buildCompactDalle2Prompt({ variant, view, background, realism, accessories, maxLen = 950 }) {
  const bikeText = variantText(variant);
  const bg = background === "white" ? "pure white seamless studio background" : "neutral studio gray studio background";

  const style =
    realism === "more_real"
      ? "Photorealistic studio product render, realistic materials, accurate shadows."
      : realism === "slightly_stylized"
      ? "High-quality studio 3D product render, subtle stylization, realistic materials."
      : "Premium studio 3D catalog render, realistic materials, clean lighting.";

  // Names only. No descriptions (they explode length).
  const names = (accessories || [])
    .map((a) => String(a?.name || a?.title || a?.id || "").trim())
    .filter(Boolean);

  // Start with a strict, short base prompt.
  let p =
    `Edit the uploaded photo of a motorcycle.\n` +
    `Keep the same motorcycle identity and silhouette.\n` +
    `Transform it into a single clean ${bikeText} studio product render, ${viewText(view)}.\n` +
    `Style: ${style}\n` +
    `Background: ${bg}\n` +
    `Constraints: one bike only, no people, no extra objects, no text, no watermark.\n`;

  // Add accessories but stop before hitting maxLen
  if (names.length > 0) {
    p += `Accessories to install and clearly show mounted on the bike: `;
    for (let i = 0; i < names.length; i++) {
      const part = (i === 0 ? "" : ", ") + names[i];
      if ((p + part).length > maxLen) break;
      p += part;
    }
    p += ".\n";
  }

  // Final hard cap
  if (p.length > maxLen) p = p.slice(0, maxLen);

  return p.trim();
}

/**
 * Convert input file -> PNG buffer.
 * If square=true, produce a square image of targetPx x targetPx (cover crop),
 * which matches dall-e-2 expectations.
 */
async function toPngBuffer(file, { targetPx = 1600, square = false } = {}) {
  const mime = (file.mimetype || "").toLowerCase();
  const name = (file.originalname || "").toLowerCase();
  const isHeic =
    mime === "image/heic" ||
    mime === "image/heif" ||
    name.endsWith(".heic") ||
    name.endsWith(".heif");

  const pipeline = (inputBuf) => {
    let p = sharp(inputBuf, { animated: false }).rotate();
    if (square) {
      p = p.resize({ width: targetPx, height: targetPx, fit: "cover" });
    } else {
      p = p.resize({ width: targetPx, height: targetPx, fit: "inside", withoutEnlargement: true });
    }
    return p.png().toBuffer();
  };

  try {
    return await pipeline(file.buffer);
  } catch (err) {
    if (!isHeic) throw err;
    const converted = await heicConvert({ buffer: file.buffer, format: "PNG" });
    return await pipeline(Buffer.from(converted));
  }
}

/**
 * OpenAI Image Edit call (native FormData + Blob)
 */
async function callOpenAIImageEdit({ apiKey, pngBuffer, prompt, size, model }) {
  const form = new FormData();
  const blob = new Blob([pngBuffer], { type: "image/png" });

  // Correct field name for edits
  form.append("image", blob, "bike.png");
  form.append("model", model);
  form.append("prompt", String(prompt || ""));
  form.append("size", String(size));
  form.append("response_format", "b64_json");

  const r = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  const text = await r.text();

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  return { ok: r.ok, status: r.status, rawText: text, json };
}

app.post("/v1/bike/render", upload.single("bike_image"), async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    if (!req.file) return res.status(400).json({ error: "bike_image (file) is required" });

    const variant = normalizeVariant(req.body?.variant);
    if (!variant) return res.status(400).json({ error: "variant must be r1300gs or r1300gs_adventure" });

    const view = normalizeView(req.body?.view);
    const background = String(req.body?.background || "studio_gray").toLowerCase().trim();
    const realism = String(req.body?.realism || "studio_3d").toLowerCase().trim();
    const requestedSize = normalizeSize(req.body?.size);
    const debug = String(req.body?.debug || "false") === "true";

    const accessoryCsv = String(req.body?.accessory_ids || "");
    if (!accessoryCsv.trim()) {
      return res.status(400).json({ error: "accessory_ids is required (comma-separated IDs)" });
    }

    const { selected, missing, filtered_out } = store.resolveFromCsv(accessoryCsv, { mountableOnly: true });

    // Choose image model (your OpenAI is forcing dall-e-2)
    const model = String(process.env.OPENAI_IMAGE_MODEL || "dall-e-2").trim();
    const isDalle2 = model === "dall-e-2";

    // Size handling
    const size = isDalle2 ? normalizeDalle2Size() : requestedSize;

    // Prompt handling: DALL·E 2 prompt must be <= 1000 chars
    const prompt = isDalle2
      ? buildCompactDalle2Prompt({ variant, view, background, realism, accessories: selected, maxLen: 950 })
      : buildEditPrompt({ variant, view, background, realism, accessories: selected });

    if (debug) {
      return res.json({
        ok: true,
        model,
        variant,
        view,
        requested_size: requestedSize,
        effective_size: size,
        prompt_length: prompt.length,
        missing_accessory_ids: missing,
        filtered_out,
        resolved_accessories: selected,
        prompt,
      });
    }

    // Image prep: for dall-e-2, force square 1024
    const bikePng = isDalle2
      ? await toPngBuffer(req.file, { targetPx: 1024, square: true })
      : await toPngBuffer(req.file, { targetPx: 1600, square: false });

    const result = await callOpenAIImageEdit({ apiKey, pngBuffer: bikePng, prompt, size, model });

    if (!result.ok) {
      return res.status(result.status).json({
        error: "OpenAI request failed",
        details: result.json ?? result.rawText,
      });
    }

    const b64 = result.json?.data?.[0]?.b64_json;
    if (!b64) {
      return res.status(500).json({
        error: "No b64_json returned",
        details: result.json ?? result.rawText,
      });
    }

    const img = Buffer.from(b64, "base64");
    res.setHeader("Content-Type", "image/png");
    res.setHeader("X-Missing-Accessory-Ids", missing.join(","));
    res.setHeader("X-Filtered-Out-Accessory-Ids", filtered_out.map((x) => x.id).join(","));
    return res.send(img);
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
});

app.post("/v1/bike/render/json", upload.single("bike_image"), async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    if (!req.file) return res.status(400).json({ error: "bike_image (file) is required" });

    const variant = normalizeVariant(req.body?.variant);
    if (!variant) return res.status(400).json({ error: "variant must be r1300gs or r1300gs_adventure" });

    const view = normalizeView(req.body?.view);
    const background = String(req.body?.background || "studio_gray").toLowerCase().trim();
    const realism = String(req.body?.realism || "studio_3d").toLowerCase().trim();
    const requestedSize = normalizeSize(req.body?.size);

    const accessoryCsv = String(req.body?.accessory_ids || "");
    if (!accessoryCsv.trim()) {
      return res.status(400).json({ error: "accessory_ids is required (comma-separated IDs)" });
    }

    const { selected, missing, filtered_out } = store.resolveFromCsv(accessoryCsv, { mountableOnly: true });

    const model = String(process.env.OPENAI_IMAGE_MODEL || "dall-e-2").trim();
    const isDalle2 = model === "dall-e-2";
    const size = isDalle2 ? normalizeDalle2Size() : requestedSize;

    const prompt = isDalle2
      ? buildCompactDalle2Prompt({ variant, view, background, realism, accessories: selected, maxLen: 950 })
      : buildEditPrompt({ variant, view, background, realism, accessories: selected });

    const bikePng = isDalle2
      ? await toPngBuffer(req.file, { targetPx: 1024, square: true })
      : await toPngBuffer(req.file, { targetPx: 1600, square: false });

    const result = await callOpenAIImageEdit({ apiKey, pngBuffer: bikePng, prompt, size, model });

    return res.status(result.status).json({
      ok: result.ok,
      status: result.status,
      model,
      requested_size: requestedSize,
      effective_size: size,
      prompt_length: prompt.length,
      missing_accessory_ids: missing,
      filtered_out,
      openai: result.json ?? result.rawText,
    });
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
});

app.listen(PORT, () => console.log(`Listening on :${PORT}`));