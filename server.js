// server.js
const express = require("express");
const twilio = require("twilio");

const app = express();
app.use(express.json());

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  EASYROUTES_CLIENT_ID,
  EASYROUTES_SECRET_KEY,
  PUBLIC_BASE_URL,
  PORT = 3000,
} = process.env;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

async function getEasyRoutesToken() {
  const res = await fetch("https://api.easyroutes.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: EASYROUTES_CLIENT_ID,
      client_secret: EASYROUTES_SECRET_KEY,
    }),
  });
  return (await res.json()).access_token;
}

async function getRoute(routeId, token) {
  const res = await fetch(`https://api.easyroutes.com/routes/${routeId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json();
}

function isDeliveryStop(s) {
  const type = (s.type || s.stopType || "delivery").toLowerCase();
  return type === "delivery";
}

function getPhone(s) {
  return s.phone || s.customer?.phone || s.address?.phone || null;
}

async function callStop(stop) {
  const phone = getPhone(stop);
  if (!phone) {
    console.log("No phone for stop", stop.id);
    return;
  }
  await twilioClient.calls.create({
    to: phone,
    from: TWILIO_FROM_NUMBER,
    url: `${PUBLIC_BASE_URL}/voice`,
  });
  console.log("Called", phone);
}

app.post("/easyroutes-webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const event = req.body;
    const topic = event.topic || event.event;
    const token = await getEasyRoutesToken();

    if (topic === "ROUTE_STARTED" || topic === "ROUTE_DISPATCHED") {
      const routeId = event.route?.id || event.routeId;
      const route = await getRoute(routeId, token);
      const first = (route.stops || []).find(isDeliveryStop);
      if (first) await callStop(first);
      return;
    }

    const stop = event.stop || event.data || {};
    if ((stop.status || "").toLowerCase() !== "completed") return;

    const routeId = stop.routeId || event.routeId;
    const route = await getRoute(routeId, token);
    const stops = route.stops || [];
    const idx = stops.findIndex((s) => s.id === stop.id);
    const next = stops
      .slice(idx + 1)
      .find((s) => isDeliveryStop(s) && (s.status || "").toLowerCase() !== "completed");

    if (next) await callStop(next);
  } catch (err) {
    console.error("Webhook error:", err);
  }
});

app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say(
    { voice: "alice" },
    "Hello, this is a delivery update from T O Balloons. " +
    "Your order is next and your driver is on the way to you now. " +
    "Please have someone available to receive your delivery. Thank you!"
  );
  res.type("text/xml").send(twiml.toString());
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
