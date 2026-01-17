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
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method === "GET") {
        const mode = req.query["hub.mode"];
        const token = req.query["hub.verify_token"];
        const challenge = req.query["hub.challenge"];

        if (mode === "subscribe" && token === VERIFY_TOKEN) {
            return res.status(200).send(challenge);
        }
        return res.status(403).send("Forbidden");
    }

    if (req.method === "POST") {
        const body = req.body || {};
        
        if (body.action === "send_reply") {
            try {
                const { message_type, recipient_id, message, comment_id } = body;
                console.log(`Sending reply: type=${message_type}, to=${recipient_id || comment_id}`);
                
                let result;
                if (message_type === "comment") {
                    if (!comment_id) throw new Error("ID de comentario no recibido por el webhook");
                    result = await callMetaAPI(`/${comment_id}/replies`, { message });
                } else {
                    if (!recipient_id) throw new Error("ID de destinatario no recibido por el webhook");
                    result = await callMetaAPI(`/me/messages`, {
                        recipient: { id: recipient_id },
                        message: { text: message }
                    });
                }
                
                return res.status(200).json({ success: true, meta_response: result });
            } catch (error) {
                console.error("Meta API Call Failed:", error.message);
                let metaError = error.message;
                try {
                    const parsed = JSON.parse(error.message);
                    if (parsed.error && parsed.error.message) {
                        metaError = `${parsed.error.message} (Código Meta: ${parsed.error.code})`;
                    }
                } catch(e) {}
                
                return res.status(500).json({ 
                    success: false, 
                    error: metaError,
                    details: error.message 
                });
            }
        }
        
        try {
            if (body.object === "instagram") {
                const entries = body.entry || [];
                for (const entry of entries) {
                    const messaging = entry?.messaging;
                    if (messaging && messaging.length > 0) {
                        for (const msgEvent of messaging) {
                            if (msgEvent.message && !msgEvent.message.is_echo) {
                                await processMessage({
                                    sourceId: msgEvent.sender.id,
                                    sourceType: "instagram",
                                    messageType: "dm",
                                    text: msgEvent.message.text,
                                    metaMsgId: msgEvent.message.mid
                                });
                            }
                        }
                    }

                    const changes = entry?.changes;
                    if (changes && changes.length > 0) {
                        for (const change of changes) {
                            if (change.field === "comments") {
                                const comment = change.value;
                                await processMessage({
                                    sourceId: comment.from.id,
                                    sourceType: "instagram",
                                    messageType: "comment",
                                    name: comment.from.username,
                                    text: comment.text,
                                    metaMsgId: comment.id,
                                    commentId: comment.id,
                                    postId: comment.media?.id
                                });
                            }
                        }
                    }
                }
            }

            if (body.object === "whatsapp_business_account") {
                const entries = body.entry || [];
                for (const entry of entries) {
                    const changes = entry?.changes;
                    if (changes && changes.length > 0) {
                        for (const change of changes) {
                            const value = change?.value;
                            const messages = value?.messages;
                            const contacts = value?.contacts;
                            if (messages && messages.length > 0) {
                                const msg = messages[0];
                                const contact = contacts?.[0];
                                await processMessage({
                                    sourceId: contact?.wa_id || msg.from,
                                    sourceType: "whatsapp",
                                    messageType: "dm",
                                    name: contact?.profile?.name || "WhatsApp User",
                                    text: msg.text?.body || "[Media/Other]",
                                    metaMsgId: msg.id
                                });
                            }
                        }
                    }
                }
            }

            return res.status(200).send("OK");
        } catch (error) {
            console.error("Webhook Processing Error:", error);
            return res.status(500).send(error.message);
        }
    }

    return res.status(405).send("Method Not Allowed");
};

async function callMetaAPI(endpoint, data) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify(data);
        const options = {
            hostname: 'graph.facebook.com',
            port: 443,
            path: `/v21.0${endpoint}?access_token=${META_ACCESS_TOKEN}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const request = https.request(options, (response) => {
            let resData = '';
            response.on('data', chunk => resData += chunk);
            response.on('end', () => {
                if (response.statusCode >= 200 && response.statusCode < 300) {
                    resolve(JSON.parse(resData));
                } else {
                    reject(new Error(resData));
                }
            });
        });

        request.on('error', (e) => reject(new Error(`Network Error: ${e.message}`)));
        request.write(postData);
        request.end();
    });
}

async function processMessage({ sourceId, sourceType, messageType, name, text, metaMsgId, commentId, postId }) {
    if (!sourceId || !text) return;

    const field = sourceType === "whatsapp" ? "wa_id" : "ig_id";
    let customerRef;
    
    const customerSnap = await db.collection("customers").where(field, "==", sourceId).limit(1).get();
    if (!customerSnap.empty) {
        customerRef = customerSnap.docs[0].ref;
    } else {
        customerRef = await db.collection("customers").add({ 
            name: name || "Cliente Nuevo", 
            [field]: sourceId, 
            created_at: admin.firestore.FieldValue.serverTimestamp() 
        });
    }

    let conversationRef;
    if (messageType === "comment" && commentId) {
        const commentConvSnap = await db.collection("conversations")
            .where("comment_id", "==", commentId)
            .limit(1)
            .get();
            
        if (!commentConvSnap.empty) {
            conversationRef = commentConvSnap.docs[0].ref;
            await conversationRef.update({ updated_at: admin.firestore.FieldValue.serverTimestamp() });
        } else {
            conversationRef = await db.collection("conversations").add({
                customer_id: customerRef.id,
                status: "open",
                channel_source: sourceType,
                message_type: "comment",
                comment_id: commentId,
                post_id: postId || null,
                assigned_agent_id: null,
                created_at: admin.firestore.FieldValue.serverTimestamp(),
                updated_at: admin.firestore.FieldValue.serverTimestamp()
            });
        }
    } else {
        const dmsSnap = await db.collection("conversations")
            .where("customer_id", "==", customerRef.id)
            .where("status", "==", "open")
            .get();
        
        const existingDm = dmsSnap.docs.find(d => d.data().message_type === "dm");
        
        if (existingDm) {
            conversationRef = existingDm.ref;
            await conversationRef.update({ updated_at: admin.firestore.FieldValue.serverTimestamp() });
        } else {
            conversationRef = await db.collection("conversations").add({
                customer_id: customerRef.id,
                status: "open",
                channel_source: sourceType,
                message_type: "dm",
                assigned_agent_id: null,
                created_at: admin.firestore.FieldValue.serverTimestamp(),
                updated_at: admin.firestore.FieldValue.serverTimestamp()
            });
        }
    }
    
    await db.collection("messages").add({
        conversation_id: conversationRef.id,
        customer_id: customerRef.id,
        type: "incoming",
        text: text,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        meta_msg_id: metaMsgId,
        comment_id: commentId || null
    });
}
