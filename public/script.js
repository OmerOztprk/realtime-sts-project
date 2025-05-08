/* =========================================================
   Voice Bot – GPT-4o Realtime  (Push-to-Talk + Dynamic Vars)
   ======================================================== */

/* ---------- DOM ---------- */
const $ = (s) => document.getElementById(s);
const startBtn = $("startBtn");
const stopBtn = $("stopBtn");
const pushBtn = $("pushBtn");
const logsEl = $("logs");
const promptEl = $("promptInput");
const saveBtn = $("savePromptBtn");
const voiceSel = $("voiceSelect");
const varsList = $("varsList");
const addVarBtn = $("addVarBtn");

/* ---------- State ---------- */
let pc, dc, localTrack, audioEl;
let userPrompt = "";
let selectedVoice = voiceSel.value;
let micEnabled = false;
let variables = {};

/* ---------- Util ---------- */
const log = (...a) => {
  console.log(...a);
  logsEl.textContent += a.join(" ") + "\n";
  logsEl.scrollTop = logsEl.scrollHeight;
};

/* ---------- Mic Helpers ---------- */
const micOn = () => {
  if (!localTrack || micEnabled) return;
  localTrack.enabled = true;
  micEnabled = true;
  pushBtn.classList.add("talking");
  log("🎤  Mikrofon AÇIK");
};
const micOff = () => {
  if (!localTrack || !micEnabled) return;
  localTrack.enabled = false;
  micEnabled = false;
  pushBtn.classList.remove("talking");
  log("🔇  Mikrofon KAPALI");
};

/* ---------- Variable Rows ---------- */
const addVarRow = (name = "", value = "") => {
  const row = document.createElement("div");
  row.className = "var-row";
  row.innerHTML = `
    <input class="var-name"  placeholder="isim"  value="${name}">
    <input class="var-value" placeholder="değer" value="${value}">
    <button class="remove" title="Sil">&times;</button>
  `;
  row.querySelector(".remove").onclick = () => row.remove();
  varsList.appendChild(row);
};
addVarBtn.addEventListener("click", () => addVarRow());

/* ---------- Safe mini-eval for “=expr” ---------- */
const safeEval = (expr) => {
  try {
    const sandbox = { Math, Date, Number, String, Boolean, JSON };
    return Function("with(this){ return (" + expr + "); }").call(sandbox);
  } catch {
    return expr;
  }
};

/* ---------- Variables → object ---------- */
const collectVariables = () => {
  variables = {};
  varsList.querySelectorAll(".var-row").forEach((row) => {
    const key = row.querySelector(".var-name").value.trim();
    const val = row.querySelector(".var-value").value.trim();
    if (key) variables[key] = val;
  });
};

/* ---------- Replace {{placeholder}} ---------- */
const applyVariables = (str) => {
  collectVariables();
  return str.replace(/{{\s*(\w+)\s*}}/g, (_, k) => {
    let val = variables[k] ?? "";
    if (typeof val === "string" && val.startsWith("=")) {
      // HER ÇAĞRIDA yeniden hesapla
      val = safeEval(val.slice(1));
    }
    return val;
  });
};

/* ---------- Prompt / Voice Events ---------- */
saveBtn.addEventListener("click", () => {
  userPrompt = promptEl.value.trim();
  if (!userPrompt) return alert("Önce prompt girin.");
  log("💾  Prompt kaydedildi.");
  if (dc?.readyState === "open") sendPromptToSession();
});

voiceSel.addEventListener("change", () => {
  selectedVoice = voiceSel.value;
  log("🎙️  Seçilen bot sesi:", selectedVoice);
});

/* ---------- Push-to-Talk Events ---------- */
["mousedown", "touchstart"].forEach((evt) =>
  pushBtn.addEventListener(evt, () => !pushBtn.disabled && micOn())
);
["mouseup", "mouseleave", "touchend", "touchcancel"].forEach((evt) =>
  pushBtn.addEventListener(evt, () => !pushBtn.disabled && micOff())
);

/* =========================================================
   Connection Lifecycle
========================================================= */
export async function connect() {
  if (!userPrompt) return alert("Önce prompt kaydedin.");

  startBtn.disabled = true;
  stopBtn.disabled = false;

  /* 1 — Mint Ephemeral Key */
  const sesRes = await fetch(
    `/session?voice=${encodeURIComponent(selectedVoice)}`
  );
  if (!sesRes.ok) {
    alert("Session oluşturulamadı");
    startBtn.disabled = false;
    stopBtn.disabled = true;
    return;
  }
  const { client_secret, id: sessionId } = await sesRes.json();
  const EPHEMERAL_KEY = client_secret.value;

  /* 2 — Peer & DC */
  pc = new RTCPeerConnection();
  dc = pc.createDataChannel("oai-events");
  dc.onopen = () => sendPromptToSession(true);
  dc.onmessage = handleServerEvent;

  /* 3 — Remote Audio */
  audioEl = new Audio();
  audioEl.autoplay = true;
  pc.ontrack = (e) => (audioEl.srcObject = e.streams[0]);

  /* 4 — Mic Track */
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: false },
  });
  localTrack = stream.getTracks()[0];
  micOff();
  pc.addTrack(localTrack);
  pushBtn.disabled = false;

  /* 5 — SDP Offer/Answer */
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const sdpRes = await fetch(
    "https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
    {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${EPHEMERAL_KEY}`,
        "Content-Type": "application/sdp",
      },
    }
  );
  if (!sdpRes.ok) {
    alert("SDP exchange başarısız");
    disconnect();
    return;
  }
  await pc.setRemoteDescription({ type: "answer", sdp: await sdpRes.text() });
  log("✅  Bağlantı kuruldu — Session:", sessionId);
}

/* ---------- Handle Server Events ---------- */
async function handleServerEvent(e) {
  const evt = JSON.parse(e.data);

  switch (evt.type) {
    case "input_audio_buffer.speech_started":
      log("🗣️  Konuşma başladı");
      break;
    case "input_audio_buffer.speech_stopped":
      log("🤫  Konuşma bitti");
      break;
    case "response.done":
      log("🔈  Yanıt tamam");
      if (evt.response?.output?.[0]?.type === "function_call")
        await handleFunctionCall(evt.response.output[0]);
      // → Her model yanıtından sonra prompt’u yeniden gönder
      sendPromptToSession();
      break;
    case "error":
      log("⚠️  Hata:", evt.message);
      break;
    default:
      break;
  }
}

/* ---------- Send session.update ---------- */
const sendPromptToSession = (includeVad = false) => {
  const payload = {
    type: "session.update",
    session: {
      instructions: applyVariables(`Tüm yanıtlarını Türkçe ver. ${userPrompt}`),
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Şehir için güncel sıcaklık & hava açıklaması getir.",
          parameters: {
            type: "object",
            properties: { city: { type: "string", description: "Şehir adı" } },
            required: ["city"],
          },
        },
        {
          type: "function",
          name: "get_rate",
          description: "İki para birimi arasındaki kuru getir.",
          parameters: {
            type: "object",
            properties: {
              base: { type: "string", description: "Baz para (örn USD)" },
              target: { type: "string", description: "Hedef para (örn TRY)" },
            },
            required: ["target"],
          },
        },
      ],
      tool_choice: "auto",
    },
  };

  if (includeVad) {
    Object.assign(payload.session, {
      turn_detection: {
        type: "server_vad",
        threshold: 0.75,
        prefix_padding_ms: 300,
        silence_duration_ms: 500,
        create_response: true,
        interrupt_response: true,
      },
      input_audio_noise_reduction: { type: "near_field" },
    });
  }

  dc.send(JSON.stringify(payload));
  log("📜  Prompt + tools oturuma uygulandı.");
};

/* ---------- Function Call Handler ---------- */
async function handleFunctionCall(call) {
  const { name, arguments: argsJSON, call_id } = call;
  let output;

  try {
    const args = JSON.parse(argsJSON || "{}");
    if (name === "get_weather") {
      const q = new URLSearchParams({ city: args.city }).toString();
      output = await (await fetch(`/tool/weather?${q}`)).json();
    } else if (name === "get_rate") {
      const q = new URLSearchParams({
        base: args.base || "USD",
        target: args.target,
      }).toString();
      output = await (await fetch(`/tool/rate?${q}`)).json();
    } else {
      throw new Error("Unrecognized function: " + name);
    }

    dc.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id, output: JSON.stringify(output) },
      })
    );
    log(`🔧 ${name} →`, JSON.stringify(output));

    dc.send(
      JSON.stringify({
        type: "response.create",
        response: { modalities: ["audio", "text"] },
      })
    );
    log("📢  response.create gönderildi (fonksiyon sonrası)");
  } catch (err) {
    log("❌ Function error:", err);
  }
}

/* ---------- Disconnect ---------- */
export const disconnect = () => {
  stopBtn.disabled = true;
  startBtn.disabled = false;
  pushBtn.disabled = true;
  micOff();

  dc?.close();
  pc?.close();
  localTrack?.stop();
  pc = dc = localTrack = null;

  log("⛔ Bağlantı kapatıldı");
};

startBtn.addEventListener("click", connect);
stopBtn.addEventListener("click", disconnect);
