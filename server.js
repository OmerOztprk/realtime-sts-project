import express from "express";
import dotenv from "dotenv";

dotenv.config();
const { OPENAI_API_KEY, PORT = 3000 } = process.env;

if (!OPENAI_API_KEY) {
  console.error("❌  OPENAI_API_KEY missing in .env");
  process.exit(1);
}

const app = express();
app.use(express.static("public"));

app.get("/session", async (_req, res) => {
  try {
    const r = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-realtime-preview-2024-12-17",
        voice: "alloy",
        instructions: "Tüm yanıtlarını Türkçe ver.",
      })
    });

    if (!r.ok) {
      const err = await r.text();
      return res.status(500).json({ error: err });
    }

    const data = await r.json();
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create Realtime session" });
  }
});

app.listen(PORT, () =>
  console.log(`✅  Voice bot server running on http://localhost:${PORT}`)
);
