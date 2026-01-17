const admin = require("firebase-admin");
const https = require("https");

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
}
const db = admin.firestore();

const VERIFY_TOKEN = process.env.HUB_VERIFY_TOKEN || "helpdesk_secret_2024";
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method === "GET") {
        const mode = req.query["hub.mode"];
        const token = req.query["hub.verify_token"];
        const challenge = req.query["hub.challenge"];
        if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
        return res.status(403).send("Forbidden");
    }
    if (req.method === "POST") {
        const body = req.body || {};
        if (body.action === "send_reply") {
            try {
                const { message_type, recipient_id, message, comment_id } = body;
                let result;
                if (message_type === "comment") {
                    if (!comment_id) throw new Error("ID de comentario faltante");
                    result = await callMetaAPI(`/${comment_id}/replies`, { message });
                } else {
                    if (!recipient_id) throw new Error("ID de destinatario faltante");
                    result = await callMetaAPI(`/me/messages`, { recipient: { id: recipient_id }, message: { text: message } });
                }
                return res.status(200).json({ success: true, meta_response: result });
            } catch (error) {
                let metaMsg = error.message;
                try {
                    const parsed = JSON.parse(error.message);
                    if (parsed.error && parsed.error.message) metaMsg = `Error de Meta: ${parsed.error.message} (Código ${parsed.error.code})`;
                } catch(e) {}
                return res.status(500).json({ success: false, error: metaMsg, details: error.message });
            }
        }
        try {
            if (body.object === "instagram") {
                for (const entry of body.entry || []) {
                    if (entry.messaging) {
                        for (const msgEvent of entry.messaging) {
                            if (msgEvent.message && !msgEvent.message.is_echo) await processMessage({ sourceId: msgEvent.sender.id, sourceType: "instagram", messageType: "dm", text: msgEvent.message.text, metaMsgId: msgEvent.message.mid });
                        }
                    }
                    if (entry.changes) {
                        for (const change of entry.changes) {
                            if (change.field === "comments") {
                                const comment = change.value;
                                await processMessage({ sourceId: comment.from.id, sourceType: "instagram", messageType: "comment", name: comment.from.username, text: comment.text, metaMsgId: comment.id, commentId: comment.id, postId: comment.media?.id });
                            }
                        }
                    }
                }
            }
            if (body.object === "whatsapp_business_account") {
                for (const entry of body.entry || []) {
                    if (entry.changes) {
                        for (const change of entry.changes) {
                            const value = change.value;
                            if (value && value.messages) {
                                for (const msg of value.messages) {
                                    const contact = value.contacts && value.contacts[0];
                                    await processMessage({ sourceId: contact ? contact.wa_id : msg.from, sourceType: "whatsapp", messageType: "dm", name: contact ? contact.profile.name : "WhatsApp User", text: msg.text ? msg.text.body : "[Mensaje Multimedia]", metaMsgId: msg.id });
                                }
                            }
                        }
                    }
                }
            }
            return res.status(200).send("OK");
        } catch (error) { return res.status(500).send(error.message); }
    }
    return res.status(405).send("Method Not Allowed");
};
async function callMetaAPI(endpoint, data) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify(data);
        const options = { hostname: 'graph.facebook.com', port: 443, path: `/v21.0${endpoint}?access_token=${META_ACCESS_TOKEN}`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } };
        const request = https.request(options, (response) => {
            let resData = '';
            response.on('data', chunk => resData += chunk);
            response.on('end', () => {
                if (response.statusCode >= 200 && response.statusCode < 300) resolve(JSON.parse(resData));
                else reject(new Error(resData));
            });
        });
        request.on('error', (e) => reject(new Error(`Network Error: ${e.message}`)));
        request.write(postData);
        request.end();
    });
}
async function processMessage(...) { /* omito por brevedad pero incluyo lógica real en el push */ }
