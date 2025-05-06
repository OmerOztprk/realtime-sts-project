const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const logsEl = document.getElementById("logs");
const promptEl = document.getElementById("promptInput");
const saveBtn = document.getElementById("savePromptBtn");

let pc, dc, localTrack, audioEl;
let userPrompt = "";              // güncel prompt burada tutulacak

function log(...args) {
    console.log(...args);
    logsEl.textContent += args.join(" ") + "\n";
    logsEl.scrollTop = logsEl.scrollHeight;
}

/* ---------- Prompt Kaydet ---------- */
saveBtn.addEventListener("click", () => {
    userPrompt = promptEl.value.trim();
    if (!userPrompt) {
        alert("Önce prompt girin."); return;
    }
    log("💾  Prompt kaydedildi.");

    // Bağlantı açıksa anında session.update gönder
    if (dc && dc.readyState === "open") {
        sendPromptToSession();
    }
});

/* ---------- Bağlan ---------- */
export async function connect() {
    if (!userPrompt) {
        alert("Lütfen önce prompt girip 'Yönergeyi Kaydet' butonuna basın.");
        return;
    }

    startBtn.disabled = true;
    stopBtn.disabled = false;

    /* 1 – Ephemeral key */
    const { client_secret, id: sessionId } = await (await fetch("/session")).json();
    const EPHEMERAL_KEY = client_secret.value;

    /* 2 – Peer & Data‑channel */
    pc = new RTCPeerConnection();
    dc = pc.createDataChannel("oai-events");

    dc.onopen = () => {
        // VAD + prompt birlikte gönderilsin
        sendPromptToSession(true);
    };

    dc.onmessage = (e) => {
        const evt = JSON.parse(e.data);
        if (evt.type === "input_audio_buffer.speech_started") log("🗣️  Konuşma başladı");
        if (evt.type === "input_audio_buffer.speech_stopped") log("🤫  Konuşma bitti");
        if (evt.type === "response.done") log("🔈  Yanıt tamam");
        if (evt.type === "error") log("⚠️  Hata:", evt.message);
    };

    /* 3 – Remote audio */
    audioEl = new Audio();
    audioEl.autoplay = true;
    pc.ontrack = (e) => { audioEl.srcObject = e.streams[0]; };

    /* 4 – Mikrofon */
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: false }
    });
    localTrack = stream.getTracks()[0];
    pc.addTrack(localTrack);

    /* 5 – SDP Offer/Answer */
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sdpRes = await fetch(
        "https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
        {
            method: "POST",
            body: offer.sdp,
            headers: {
                Authorization: `Bearer ${EPHEMERAL_KEY}`,
                "Content-Type": "application/sdp"
            }
        }
    );
    const answer = { type: "answer", sdp: await sdpRes.text() };
    await pc.setRemoteDescription(answer);

    log("✅  Bağlantı kuruldu — Session:", sessionId);
}

/* ---------- Prompt'u modele gönder ---------- */
function sendPromptToSession(includeVad = false) {
    const payload = {
        type: "session.update",
        session: {
            instructions: `Tüm yanıtlarını Türkçe ver. ${userPrompt}`
        }
    };

    if (includeVad) {
        payload.session.turn_detection = {
            type: "server_vad",
            threshold: 0.75,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
            create_response: true,
            interrupt_response: true
        };
        payload.session.input_audio_noise_reduction = { type: "near_field" };
    }

    dc.send(JSON.stringify(payload));
    log("📜  Prompt oturuma uygulandı.");
}

/* ---------- Bağlantı kapat ---------- */
export function disconnect() {
    stopBtn.disabled = true;
    startBtn.disabled = false;
    if (dc) dc.close();
    if (pc) pc.close();
    if (localTrack) localTrack.stop();
    pc = dc = localTrack = null;
    log("⛔  Bağlantı kapatıldı");
}

startBtn.addEventListener("click", connect);
stopBtn.addEventListener("click", disconnect);
