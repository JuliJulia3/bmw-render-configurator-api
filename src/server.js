// src/server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";
import heicConvert from "heic-convert";
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
 * Calls the OpenAI Responses API (/v1/responses) with gpt-image-1.
 * /v1/images/edits only accepts dall-e-2; gpt-image-1 requires the Responses API.
 * The image is sent as a base64 data-URL inside the JSON body — no multipart needed.
 */
async function callOpenAIImageEdit({ apiKey, model, pngBuffer, prompt, size }) {
  const b64Image = pngBuffer.toString("base64");

  const body = {
    model,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: `data:image/png;base64,${b64Image}`
          },
          {
            type: "input_text",
            text: prompt
          }
        ]
      }
    ],
    tools: [
      {
        type: "image_generation",
        size
      }
    ]
  };

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
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

    const model = String(process.env.OPENAI_IMAGE_MODEL || "gpt-image-1").trim();

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

    // Responses API: output is an array; find the image_generation_call item.
    const b64 = result.json?.output?.find(o => o.type === "image_generation_call")?.result;
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