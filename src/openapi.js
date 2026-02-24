// src/openapi.js
export const openapiSpec = {
  openapi: "3.0.3",
  info: {
    title: "BMW Render Configurator API",
    version: "1.0.0",
    description:
      "Upload a BMW R1300GS / R1300GS Adventure photo, choose accessories from a JSON catalog, and get back a studio-style 3D product render PNG."
  },
  servers: [
    { url: "https://bmw-render-configurator-api.onrender.com", description: "Production (Render)" },
    { url: "http://localhost:3000", description: "Local dev" }
  ],
  tags: [{ name: "System" }, { name: "Accessories" }, { name: "Render" }],
  paths: {
    "/health": {
      get: {
        tags: ["System"],
        summary: "Health check",
        responses: {
          200: {
            description: "OK",
            content: {
              "application/json": {
                schema: { type: "object", properties: { ok: { type: "boolean" } } },
                example: { ok: true }
              }
            }
          }
        }
      }
    },

    "/v1/accessories": {
      get: {
        tags: ["Accessories"],
        summary: "Search/list accessories",
        parameters: [
          { name: "q", in: "query", schema: { type: "string" }, required: false },
          { name: "limit", in: "query", schema: { type: "integer", default: 100 }, required: false },
          { name: "mountable_only", in: "query", schema: { type: "boolean", default: false }, required: false }
        ],
        responses: {
          200: {
            description: "Accessory list",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    total: { type: "integer" },
                    items: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          name: { type: "string" },
                          category: { type: "string" },
                          description: { type: "string" }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },

    "/v1/bike/render": {
      post: {
        tags: ["Render"],
        summary: "Generate a studio 3D product render PNG from an uploaded bike photo",
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["bike_image", "variant", "accessory_ids"],
                properties: {
                  bike_image: { type: "string", format: "binary" },
                  variant: { type: "string", enum: ["r1300gs", "r1300gs_adventure"] },
                  view: { type: "string", enum: ["left", "right", "front_3q", "rear_3q"], default: "left" },
                  accessory_ids: { type: "string", description: "Comma-separated IDs" },
                  background: { type: "string", default: "studio_gray" },
                  realism: { type: "string", default: "studio_3d" },
                  size: { type: "string", enum: ["1024x1024", "1536x1024", "1024x1536"], default: "1536x1024" },
                  debug: { type: "boolean", default: false }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: "PNG image (or JSON if debug=true)",
            content: {
              "image/png": { schema: { type: "string", format: "binary" } },
              "application/json": { schema: { type: "object" } }
            }
          }
        }
      }
    },

    "/v1/bike/render/json": {
      post: {
        tags: ["Render"],
        summary: "Debug endpoint: always returns JSON (OpenAI response)",
        requestBody: { $ref: "#/paths/~1v1~1bike~1render/post/requestBody" },
        responses: {
          200: {
            description: "JSON response",
            content: { "application/json": { schema: { type: "object" } } }
          }
        }
      }
    }
  }
};