/*
  VISHAL QX SYSTEME.IO TRACKING SNIPPET

  1) Replace BACKEND_URL below with your Railway public URL.
  2) Paste this script into your Systeme.io funnel page custom code.
  3) The script tracks page visits and Telegram button clicks.
  4) It detects Facebook / Instagram from UTM parameters or click IDs.
  5) Telegram links are routed through /go so the server can use the
     correct source-specific join-request invite link.

  You can keep your existing Meta Pixel on the page.
*/

(function () {
  const BACKEND_URL = "https://YOUR-RAILWAY-DOMAIN";

  function getSource() {
    const p = new URLSearchParams(window.location.search);
    const utm = (p.get("utm_source") || "").toLowerCase();

    if (utm.includes("instagram") || p.has("igshid")) return "instagram";
    if (utm.includes("facebook") || utm === "fb" || p.has("fbclid")) return "facebook";
    if (utm) return utm;
    return "unknown";
  }

  function sessionId() {
    const key = "vqx_sid";
    let id = localStorage.getItem(key);
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
      localStorage.setItem(key, id);
    }
    return id;
  }

  async function post(path, payload) {
    try {
      await fetch(BACKEND_URL + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true
      });
    } catch (e) {
      // Tracking failure must never block the visitor.
    }
  }

  const source = getSource();
  const sid = sessionId();
  const params = new URLSearchParams(window.location.search);

  post("/api/track/visit", {
    session_id: sid,
    source,
    utm_source: params.get("utm_source") || "",
    utm_campaign: params.get("utm_campaign") || "",
    utm_content: params.get("utm_content") || "",
    utm_medium: params.get("utm_medium") || "",
    page: window.location.href,
    referrer: document.referrer || ""
  });

  function sourcePath() {
    if (source === "instagram") return "instagram";
    if (source === "facebook") return "facebook";
    return "auto";
  }

  document.addEventListener("click", function (event) {
    const a = event.target.closest && event.target.closest("a");
    if (!a) return;

    const href = a.href || "";
    if (!href.includes("t.me/")) return;

    event.preventDefault();

    post("/api/track/click", {
      session_id: sid,
      source,
      utm_source: params.get("utm_source") || "",
      utm_campaign: params.get("utm_campaign") || "",
      utm_content: params.get("utm_content") || "",
      destination: href
    });

    const go = BACKEND_URL + "/go?source=" + encodeURIComponent(sourcePath()) +
      "&sid=" + encodeURIComponent(sid);

    setTimeout(function () {
      window.location.href = go;
    }, 150);
  }, true);
})();
