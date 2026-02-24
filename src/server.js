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

// API accepts these, but if we're using dall-e-2 we will override to 1024x1024 anyway
function normalizeSize(s) {
  const v = String(s || "1536x1024").trim();
  const allowed = new Set(["1024x1024", "1536x1024", "1024x1536"]);
  return allowed.has(v) ? v : "1536x1024";
}

// For dall-e-2 edits, valid sizes are 256/512/1024 square.
// We'll choose 1024x1024 for best quality, and force the input image to match.
function normalizeDalle2Size() {
  return "1024x1024";
}

/**
 * Convert input file -> PNG buffer.
 * If square=true, we produce a square image of targetPx x targetPx (cover),
 * which matches dall-e-2 "square png" expectations.
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
      // Force square for dall-e-2 (cover crops as needed)
      p = p.resize({ width: targetPx, height: targetPx, fit: "cover" });
    } else {
      // Keep aspect ratio
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
 * Uses OPENAI_IMAGE_MODEL if set, else defaults to dall-e-2.
 */
async function callOpenAIImageEdit({ apiKey, pngBuffer, prompt, size, model }) {
  const form = new FormData();

  const blob = new Blob([pngBuffer], { type: "image/png" });

  // IMPORTANT: for edits, field name is "image"
  form.append("image", blob, "bike.png");

  form.append("model", model);
  form.append("prompt", String(prompt || ""));

  // For dall-e-2, size must be square 256/512/1024.
  form.append("size", String(size));
  form.append("response_format", "b64_json");

  const r = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      // DO NOT set Content-Type manually
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

    const prompt = buildEditPrompt({ variant, view, background, realism, accessories: selected });

    // Choose image model (default dall-e-2 because your project is restricted)
    const model = String(process.env.OPENAI_IMAGE_MODEL || "dall-e-2").trim();

    // If using dall-e-2, force square size and square input
    const isDalle2 = model === "dall-e-2";
    const size = isDalle2 ? normalizeDalle2Size() : requestedSize;

    if (debug) {
      return res.json({
        ok: true,
        variant,
        view,
        requested_size: requestedSize,
        effective_size: size,
        model,
        missing_accessory_ids: missing,
        filtered_out,
        resolved_accessories: selected,
        prompt,
      });
    }

    // Prepare image buffer according to model constraints
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

    const prompt = buildEditPrompt({ variant, view, background, realism, accessories: selected });

    const model = String(process.env.OPENAI_IMAGE_MODEL || "dall-e-2").trim();
    const isDalle2 = model === "dall-e-2";
    const size = isDalle2 ? normalizeDalle2Size() : requestedSize;

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
      missing_accessory_ids: missing,
      filtered_out,
      openai: result.json ?? result.rawText,
    });
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
});

app.listen(PORT, () => console.log(`Listening on :${PORT}`));