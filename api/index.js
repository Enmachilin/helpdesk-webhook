const admin = require("firebase-admin");
const https = require("https");

const serviceAccountVar = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!admin.apps.length) {
    try {
        if (!serviceAccountVar) {
            console.error("CRITICAL: FIREBASE_SERVICE_ACCOUNT is missing in environment variables");
        } else {
            const serviceAccount = JSON.parse(serviceAccountVar);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log("Firebase Admin Initialized successfully");
        }
    } catch (e) {
        console.error("Firebase Initialization Error:", e.message);
    }
}
const db = admin.firestore();

const VERIFY_TOKEN = process.env.HUB_VERIFY_TOKEN || "helpdesk_secret_2024";
// Page Access Token - Mundo Cuarzos (Testing)
const META_ACCESS_TOKEN = "EAAdxJndK0e0BQWaouIRBJdjWUUoSk6JQE9iPRMQHTYppicypQMs5TIOpnBcr6h6ah0CIZBu8VoPZAzphqx5rqucgJkLV90dyXxq9ZBXToGl8lFwHAycn4vk4leVjbZCoRRJ4PvxZCX229TRT7X6UDJhsfBrs0fMa4ciiEVJpbuiFKTmZA8OZAGGK3GIZCX2SASbmDCDBTIN9SMJYUm4J704eY3EZCpAZDZD";

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
                console.log(`REPLY ATTEMPT: ${message_type} to ${recipient_id || comment_id}`);
                
                let result;
                if (message_type === "comment") {
                    if (!comment_id) throw new Error("Missing comment_id for comment reply");
                    result = await callMetaAPI(`/${comment_id}/replies`, { message });
                } else {
                    if (!recipient_id) throw new Error("Missing recipient_id for DM reply");
                    // ID de página definitivo: Mundo Cuarzos (457641490771604)
                    const PAGE_ID = "457641490771604";
                    result = await callMetaAPI(`/${PAGE_ID}/messages`, {
                        recipient: { id: recipient_id },
                        message: { text: message }
                    });
                }
                return res.status(200).json({ success: true, meta_response: result });
            } catch (error) {
                console.error("META_API_ERROR:", error.message);
                let displayError = error.message;
                try {
                    const parsed = JSON.parse(error.message);
                    if (parsed.error) displayError = `${parsed.error.message} (Code: ${parsed.error.code})`;
                } catch(e) {}
                return res.status(500).json({ success: false, error: displayError });
            }
        }

        try {
            const data = body;
            if (data.object === "instagram") {
                for (const entry of data.entry || []) {
                    if (entry.messaging) {
                        for (const msg of entry.messaging) {
                            if (msg.message && !msg.message.is_echo) {
                                await processIncoming(msg.sender.id, "instagram", "dm", msg.message.text, msg.message.mid);
                            }
                        }
                    }
                    if (entry.changes) {
                        for (const change of entry.changes) {
                            if (change.field === "comments") {
                                const c = change.value;
                                await processIncoming(c.from.id, "instagram", "comment", c.text, c.id, c.id, c.media?.id, c.from.username);
                            }
                        }
                    }
                }
            }
            if (data.object === "whatsapp_business_account") {
                for (const entry of data.entry || []) {
                    for (const change of entry.changes || []) {
                        const val = change.value;
                        if (val && val.messages) {
                            for (const msg of val.messages) {
                                const contact = val.contacts && val.contacts[0];
                                await processIncoming(contact?.wa_id || msg.from, "whatsapp", "dm", msg.text?.body || "[Media]", msg.id, null, null, contact?.profile?.name);
                            }
                        }
                    }
                }
            }
            return res.status(200).send("OK");
        } catch (e) {
            console.error("WEBHOOK_ERR:", e.message);
            return res.status(500).send(e.message);
        }
    }
    return res.status(405).send("Not Allowed");
};

async function callMetaAPI(endpoint, data) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(data);
        const options = {
            hostname: 'graph.facebook.com',
            port: 443,
            path: `/v21.0${endpoint}?access_token=${META_ACCESS_TOKEN}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        };
        const r = https.request(options, (res) => {
            let d = '';
            res.on('data', chunk => d += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(d));
                else reject(new Error(d));
            });
        });
        r.on('error', e => reject(e));
        r.write(body);
        r.end();
    });
}

async function processIncoming(sourceId, sourceType, messageType, text, msgId, commentId = null, postId = null, name = null) {
    if (!sourceId || !text) return;
    const field = sourceType === "whatsapp" ? "wa_id" : "ig_id";
    let customerRef;
    const cSnap = await db.collection("customers").where(field, "==", sourceId).limit(1).get();
    if (!cSnap.empty) {
        customerRef = cSnap.docs[0].ref;
    } else {
        customerRef = await db.collection("customers").add({
            name: name || "Cliente Nuevo", [field]: sourceId,
            created_at: admin.firestore.FieldValue.serverTimestamp()
        });
    }
    let convRef;
    if (messageType === "comment" && commentId) {
        const q = await db.collection("conversations").where("comment_id", "==", commentId).limit(1).get();
        if (!q.empty) convRef = q.docs[0].ref;
        else convRef = await db.collection("conversations").add({
            customer_id: customerRef.id, channel_source: sourceType, message_type: "comment",
            comment_id: commentId, post_id: postId, status: "open",
            created_at: admin.firestore.FieldValue.serverTimestamp(), updated_at: admin.firestore.FieldValue.serverTimestamp()
        });
    } else {
        const q = await db.collection("conversations").where("customer_id", "==", customerRef.id).where("status", "==", "open").get();
        const existing = q.docs.find(d => d.data().message_type === "dm");
        if (existing) convRef = existing.ref;
        else convRef = await db.collection("conversations").add({
            customer_id: customerRef.id, channel_source: sourceType, message_type: "dm", status: "open",
            created_at: admin.firestore.FieldValue.serverTimestamp(), updated_at: admin.firestore.FieldValue.serverTimestamp()
        });
    }
    await convRef.update({ updated_at: admin.firestore.FieldValue.serverTimestamp() });
    await db.collection("messages").add({
        conversation_id: convRef.id, customer_id: customerRef.id,
        type: "incoming", text: text, timestamp: admin.firestore.FieldValue.serverTimestamp(),
        meta_msg_id: msgId, comment_id: commentId
    });
}
