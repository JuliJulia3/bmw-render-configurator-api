// src/server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";
import heicConvert from "heic-convert";
import FormData from "form-data";
import { AccessoriesStore } from "./accessoriesStore.js";
import { buildEditPrompt } from "./prompt.js";

const app = express();
const PORT = process.env.PORT || 3000;

// --------------------
// CORS
// --------------------
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // No Origin header = curl / Postman / server-to-server
      if (!origin) return callback(null, true);

      // If allowlist not set, allow all (dev-friendly)
      if (allowedOrigins.length === 0) return callback(null, true);

      if (allowedOrigins.includes(origin)) return callback(null, true);

      // Block silently (do not throw)
      return callback(null, false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

app.options("*", cors());

// --------------------
// Upload
// --------------------
const upload = multer({
  limits: { fileSize: 15 * 1024 * 1024 } // 15MB
});

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
// Helpers
// --------------------
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

function normalizeSize(s) {
  const v = String(s || "1536x1024").trim();
  const allowed = new Set(["1024x1024", "1536x1024", "1024x1536"]);
  return allowed.has(v) ? v : "1536x1024";
}

/**
 * Converts incoming file buffer to PNG with RGBA (alpha channel).
 * This fixes: "format must be in ['RGBA','LA','L'], got RGB."
 *
 * Optional resize:
 * - Set RESIZE_MAX=1600 to constrain max dimension (keeps aspect).
 * - If RESIZE_MAX is not set, it will NOT resize.
 */
async function toRgbaPngBuffer(file) {
  const mime = (file.mimetype || "").toLowerCase();
  const name = (file.originalname || "").toLowerCase();

  const isHeic =
    mime === "image/heic" ||
    mime === "image/heif" ||
    name.endsWith(".heic") ||
    name.endsWith(".heif");

  const resizeMax = Number(process.env.RESIZE_MAX || 0); // 0 = no resize

  async function pipeline(inputBuf) {
    let img = sharp(inputBuf, { animated: false }).rotate();

    if (resizeMax > 0) {
      img = img.resize({
        width: resizeMax,
        height: resizeMax,
        fit: "inside",
        withoutEnlargement: true
      });
    }

    // Force RGBA output
    return await img.ensureAlpha().png().toBuffer();
  }

  try {
    return await pipeline(file.buffer);
  } catch (err) {
    if (!isHeic) throw err;
    const converted = await heicConvert({ buffer: file.buffer, format: "PNG" });
    return await pipeline(Buffer.from(converted));
  }
}

/**
 * Calls OpenAI Images Edits endpoint using proper Node multipart form-data.
 * IMPORTANT:
 * - Use `form-data` package (NOT browser FormData/Blob) to avoid invalid_multipart_form_data.
 * - Do NOT send "quality" (your endpoint currently rejects it).
 */
async function callOpenAIImageEdit({ apiKey, model, pngBuffer, prompt, size }) {
  const form = new FormData();

  // OpenAI /v1/images/edits only accepts the field named "image" (not "image[]").
  // Sending both breaks multipart parsing (invalid_multipart_form_data).
  form.append("image", pngBuffer, { filename: "bike.png", contentType: "image/png" });

  form.append("model", model);
  form.append("prompt", prompt);
  form.append("size", size);

  // ask for base64 output explicitly
  form.append("response_format", "b64_json");

  // Node 18 native fetch does not reliably stream the form-data npm package as a body.
  // Serialize to a Buffer first so fetch sends it as a complete, correctly-framed payload.
  const formBuffer = form.getBuffer();
  const formHeaders = form.getHeaders();

  const r = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...formHeaders
    },
    body: formBuffer
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

app.post("/v1/bike/render", upload.single("bike_image"), async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    const model = String(process.env.OPENAI_IMAGE_MODEL || "gpt-image-1.5").trim();

    if (!req.file) return res.status(400).json({ error: "bike_image (file) is required" });

    const variant = normalizeVariant(req.body?.variant);
    if (!variant) return res.status(400).json({ error: "variant must be r1300gs or r1300gs_adventure" });

    const view = normalizeView(req.body?.view);
    const background = String(req.body?.background || "studio_gray").toLowerCase().trim();
    const realism = String(req.body?.realism || "studio_3d").toLowerCase().trim();
    const size = normalizeSize(req.body?.size);
    const debug = String(req.body?.debug || "false") === "true";

    const accessoryCsv = String(req.body?.accessory_ids || "");
    if (!accessoryCsv.trim()) {
      return res.status(400).json({ error: "accessory_ids is required (comma-separated IDs)" });
    }

    // Filter out non-mountable items by default
    const { selected, missing, filtered_out } = store.resolveFromCsv(accessoryCsv, { mountableOnly: true });

    // Build prompt (this is your “worked wonderfully before” behavior)
    const prompt = buildEditPrompt({
      variant,
      view,
      background,
      realism,
      accessories: selected
    });

    if (debug) {
      return res.json({
        ok: true,
        model,
        variant,
        view,
        size,
        missing_accessory_ids: missing,
        filtered_out,
        resolved_accessories: selected,
        prompt_length: prompt.length,
        prompt
      });
    }

    // Convert bike to RGBA PNG (fix RGB rejection)
    const bikePng = await toRgbaPngBuffer(req.file);

    const result = await callOpenAIImageEdit({
      apiKey,
      model,
      pngBuffer: bikePng,
      prompt,
      size
    });

    if (!result.ok) {
      // Return JSON error (curl will save JSON if you --output, which is correct)
      return res.status(result.status).json({
        error: "OpenAI request failed",
        details: result.json ?? result.rawText,
        hint:
          "If you see 'Value must be dall-e-2', your OpenAI project/key does not have access to gpt-image-1.5. Use a project with GPT Image enabled."
      });
    }

    const b64 = result.json?.data?.[0]?.b64_json;
    if (!b64) {
      return res.status(500).json({
        error: "No b64_json returned",
        details: result.json ?? result.rawText
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

app.listen(PORT, () => console.log(`Listening on :${PORT}`));