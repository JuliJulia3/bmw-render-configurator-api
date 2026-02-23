import fs from "fs";
import path from "path";

const ACCESSORIES_PATH = path.resolve("./accessories_merged.json");

// Not bike-mounted / confusing for bike-only renders
const DISALLOWED_PRODUCT_TYPES = new Set([
  "backpack",
  "rucksack",
  "shoulder bag",
  "apparel",
  "jacket",
  "pants",
  "gloves",
  "boots",
  "helmet",
  "shirt",
  "t-shirt",
  "hoodie",
]);

const DISALLOWED_TEXT_HINTS = [
  "backpack",
  "rucksack",
  "shoulder bag",
  "daypack",
  "laptop sleeve",
  "wear",
  "worn",
];

function norm(s) {
  return String(s || "").toLowerCase().trim();
}

// keywords.product_type is often an object like { "tank bag": 9 }
function getProductTypes(item) {
  const pt = item?.keywords?.product_type;
  if (!pt || typeof pt !== "object") return [];
  return Object.keys(pt).map(norm);
}

function isMountable(item) {
  const types = getProductTypes(item);
  const text = `${item?.name || ""} ${item?.description || ""} ${item?.category || ""}`.toLowerCase();
  const hasDisallowedType = types.some((t) => DISALLOWED_PRODUCT_TYPES.has(t));
  const hasDisallowedText = DISALLOWED_TEXT_HINTS.some((h) => text.includes(h));
  return !(hasDisallowedType || hasDisallowedText);
}

export class AccessoriesStore {
  constructor() {
    this.items = [];
    this.byId = new Map();
  }

  load() {
    const raw = fs.readFileSync(ACCESSORIES_PATH, "utf-8");
    this.items = JSON.parse(raw);
    this.byId = new Map(this.items.map((x) => [String(x.id).trim(), x]));
    return this.items.length;
  }

  search({ q = "", limit = 100, mountableOnly = false } = {}) {
    const qq = norm(q);
    const lim = Math.max(1, Math.min(1000, Number(limit || 100)));

    let items = this.items;

    if (qq) {
      items = items.filter((a) => {
        const t = `${a.name || ""} ${a.description || ""} ${a.category || ""}`.toLowerCase();
        return t.includes(qq);
      });
    }

    if (mountableOnly) items = items.filter(isMountable);

    const sliced = items.slice(0, lim).map((a) => ({
      id: String(a.id ?? ""),
      name: a.name || a.title || "",
      category: a.category || "",
      description: a.description || "",
    }));

    return { total: items.length, items: sliced };
  }

  resolveFromCsv(csvIds, { mountableOnly = true } = {}) {
    const ids = String(csvIds || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!ids.length) return { selected: [], missing: [], filtered_out: [] };

    const selected = [];
    const missing = [];
    const filtered_out = [];

    for (const id of ids) {
      const item = this.byId.get(id);

      if (!item) {
        missing.push(id);
        continue;
      }

      if (mountableOnly && !isMountable(item)) {
        const types = getProductTypes(item).filter((t) => DISALLOWED_PRODUCT_TYPES.has(t));
        const reason =
          types.length > 0
            ? `excluded by product_type (${types.join(", ")})`
            : "excluded by text hint (non-mountable)";
        filtered_out.push({ id, reason });
        continue;
      }

      selected.push({
        id,
        name: item.name || item.title || "",
        category: item.category || "",
        description: item.description || "",
      });
    }

    return { selected, missing, filtered_out };
  }
}