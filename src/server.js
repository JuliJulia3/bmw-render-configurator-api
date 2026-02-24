import express from "express";
import multer from "multer";
import sharp from "sharp";
import heicConvert from "heic-convert";

import { AccessoriesStore } from "./accessoriesStore.js";
import { buildEditPrompt } from "./prompt.js";

const app = express();
const PORT = process.env.PORT || 3000;

// multipart upload
const upload = multer({ limits: { fileSize: 15 * 1024 * 1024 } });

const store = new AccessoriesStore();
try {
  const count = store.load();
  console.log(`Loaded accessories: ${count}`);
} catch (e) {
  console.error("Failed to load accessories_merged.json:", e);
}

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

function normalizeSize(s) {
  const v = String(s || "1536x1024").trim();
  const allowed = new Set(["1024x1024", "1536x1024", "1024x1536"]);
  return allowed.has(v) ? v : "1536x1024";
}

async function bikeToPngBuffer(file) {
  const mime = (file.mimetype || "").toLowerCase();
  const name = (file.originalname || "").toLowerCase();

  const isHeic =
    mime === "image/heic" ||
    mime === "image/heif" ||
    name.endsWith(".heic") ||
    name.endsWith(".heif");

  try {
    return await sharp(file.buffer, { animated: false })
      .rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
  } catch (err) {
    if (!isHeic) throw err;

    const converted = await heicConvert({ buffer: file.buffer, format: "PNG" });
    return await sharp(Buffer.from(converted))
      .rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
  }
}

/**
 * Call OpenAI /v1/images/edits using GPT Image model (the "good" behaviour).
 * - Uses native FormData + Blob (no manual multipart headers).
 * - Uses field name "image" (repeat for multiple images if needed).
 * Docs: edits endpoint supports gpt-image-1.5 and others. :contentReference[oaicite:4]{index=4}
 */
async function callOpenAIImageEdit({ apiKey, model, pngBuffer, prompt, size }) {
  const form = new FormData();

  // Field name per docs: "image"
  const blob = new Blob([pngBuffer], { type: "image/png" });
  form.append("image", blob, "bike.png");

  form.append("model", model);
  form.append("prompt", prompt);
  form.append("size", size);

  // These are supported parameters in the Images API for GPT image models. :contentReference[oaicite:5]{index=5}
  form.append("quality", "high");
  form.append("output_format", "png");
  form.append("response_format", "b64_json");

  const r = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  return { ok: r.ok, status: r.status, json, rawText: text };
}

app.post("/v1/bike/render", upload.single("bike_image"), async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    if (!req.file) {
      return res.status(400).json({ error: "bike_image (file) is required" });
    }

    const variant = normalizeVariant(req.body?.variant);
    if (!variant) {
      return res.status(400).json({ error: "variant must be r1300gs or r1300gs_adventure" });
    }

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

    const prompt = buildEditPrompt({
      variant,
      view,
      background,
      realism,
      accessories: selected,
    });

    if (debug) {
      return res.json({
        ok: true,
        variant,
        view,
        size,
        missing_accessory_ids: missing,
        filtered_out,
        resolved_accessories: selected,
        prompt,
      });
    }

    // Normalize bike image to PNG for stability
    const bikePng = await bikeToPngBuffer(req.file);

    // This is the key line that gives you the old behaviour:
    const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1.5";
    form.append("model", model)

    const result = await callOpenAIImageEdit({
      apiKey,
      model,
      pngBuffer: bikePng,
      prompt,
      size,
    });

    if (!result.ok) {
      // If your project forces dall-e-2, OpenAI will error here.
      return res.status(result.status).json({
        error: "OpenAI request failed",
        details: result.json ?? result.rawText,
        hint:
          "If you see 'Value must be dall-e-2', your current OpenAI key/project does not have access to gpt-image-1.5. Use a key/project with GPT Image enabled and set OPENAI_IMAGE_MODEL=gpt-image-1.5.",
      });
    }

    const b64 = result.json?.data?.[0]?.b64_json;
    if (!b64) {
      return res.status(500).json({
        error: "No image returned",
        details: (result.json ?? result.rawText ?? "").toString().slice(0, 2000),
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