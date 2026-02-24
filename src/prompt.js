function viewText(view) {
  if (view === "front_3q") return "front three-quarter view";
  if (view === "rear_3q") return "rear three-quarter view";
  return `${view} side view`;
}

function variantText(variant) {
  return variant === "r1300gs_adventure" ? "BMW R1300GS Adventure" : "BMW R1300GS";
}

export function buildEditPrompt({ variant, view, background, realism, accessories }) {
  const bikeText = variantText(variant);

  const bg =
    background === "white"
      ? "pure white seamless studio background"
      : "neutral studio gray seamless background";

  const styleLine =
    realism === "more_real"
      ? "Convert the photo into a photorealistic studio product render with PBR materials and accurate shadows."
      : realism === "slightly_stylized"
      ? "Convert the photo into a high-quality studio 3D product render with subtle stylization, still realistic materials."
      : "Convert the photo into a premium studio 3D product render (catalog look), realistic materials, clean lighting.";

  const accLines =
    accessories.length > 0
      ? accessories.map((a) => `- ${a.name}${a.description ? `: ${a.description}` : ""}`).join("\n")
      : "- (none)";

  // Build short checklist labels for "must visibly include"
  const mustList =
    accessories.length > 0
      ? accessories
          .map((a) => a.name)
          .slice(0, 12)
          .map((n) => `- ${n}`)
          .join("\n")
      : "- (none)";

  return `
You are editing a photo of a motorcycle.

Goal:
- Keep the same motorcycle identity and overall silhouette from the input photo.
- Transform it into a single clean ${bikeText} studio product render, ${viewText(view)}.

Style:
- ${styleLine}
- Lighting: professional studio softboxes, clean highlights, realistic shadow under the bike.
- Background: ${bg}

Accessories:
Install and clearly show these accessories mounted on the bike:
${accLines}

Important:
- If the input photo already contains luggage, bars, guards, racks, or similar accessories, REPLACE them with the specified accessories above.
- Make the installed accessories clearly visible and prominent in the final render (do not hide them).

Constraints:
- One bike only. No rider. No people.
- No text, no watermark, no labels.
- Do not add extra bikes or extra objects.
- Keep geometry consistent with a real ${bikeText}.

Must visibly include (non-negotiable):
${mustList}
If any item above is not visible, regenerate and fix until all are visible.
`.trim();
}