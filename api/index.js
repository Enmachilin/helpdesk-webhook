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
                if (message_type === "comment") {
                    await replyToComment(comment_id, message);
                } else {
                    await sendDirectMessage(recipient_id, message);
                }
                return res.status(200).json({ success: true });
            } catch (error) {
                console.error("Error sending reply:", error);
                return res.status(500).json({ error: error.message });
            }
        }
        
        try {
            if (body.object === "instagram") {
                const entries = body.entry || [];
                for (const entry of entries) {
                    const messaging = entry?.messaging?.[0];
                    const change = entry?.changes?.[0];

                    if (messaging && messaging.message && !messaging.message.is_echo) {
                        await processMessage({
                            sourceId: messaging.sender.id,
                            sourceType: "instagram",
                            messageType: "dm",
                            text: messaging.message.text,
                            metaMsgId: messaging.message.mid
                        });
                    }

                    if (change && change.field === "comments") {
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

            if (body.object === "whatsapp_business_account") {
                const entries = body.entry || [];
                for (const entry of entries) {
                    const change = entry?.changes?.[0];
                    const value = change?.value;
                    const message = value?.messages?.[0];
                    const contact = value?.contacts?.[0];

                    if (message) {
                        await processMessage({
                            sourceId: contact.wa_id,
                            sourceType: "whatsapp",
                            messageType: "dm",
                            name: contact.profile?.name,
                            text: message.text?.body,
                            metaMsgId: message.id
                        });
                    }
                }
            }

            return res.status(200).send("OK");
        } catch (error) {
            console.error("Webhook Internal Error:", error);
            return res.status(500).send(error.message);
        }
    }
    return res.status(405).send("Method Not Allowed");
};

async function replyToComment(commentId, messageText) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({ message: messageText });
        const options = {
            hostname: 'graph.facebook.com',
            port: 443,
            path: `/v21.0/${commentId}/replies?access_token=${META_ACCESS_TOKEN}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
        };
        const request = https.request(options, (response) => {
            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
                if (response.statusCode >= 200 && response.statusCode < 300) resolve(JSON.parse(data));
                else reject(new Error(data));
            });
        });
        request.on('error', reject);
        request.write(postData);
        request.end();
    });
}

async function sendDirectMessage(recipientId, messageText) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({ recipient: { id: recipientId }, message: { text: messageText } });
        const options = {
            hostname: 'graph.facebook.com',
            port: 443,
            path: `/v21.0/me/messages?access_token=${META_ACCESS_TOKEN}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
        };
        const request = https.request(options, (response) => {
            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
                if (response.statusCode >= 200 && response.statusCode < 300) resolve(JSON.parse(data));
                else reject(new Error(data));
            });
        });
        request.on('error', reject);
        request.write(postData);
        request.end();
    });
}

async function processMessage({ sourceId, sourceType, messageType, name, text, metaMsgId, commentId, postId }) {
    const field = sourceType === "whatsapp" ? "wa_id" : "ig_id";
    let customerRef;
    const customerSnap = await db.collection("customers").where(field, "==", sourceId).limit(1).get();
    if (!customerSnap.empty) {
        customerRef = customerSnap.docs[0].ref;
    } else {
        customerRef = await db.collection("customers").add({ name: name || "Cliente Nuevo", [field]: sourceId, created_at: admin.firestore.FieldValue.serverTimestamp() });
    }

    let conversationRef;
    if (messageType === "comment" && commentId) {
        const commentConvSnap = await db.collection("conversations").where("comment_id", "==", commentId).limit(1).get();
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
        const dmsSnap = await db.collection("conversations").where("customer_id", "==", customerRef.id).where("status", "==", "open").get();
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
