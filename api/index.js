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

    // Verificacion de Webhook (GET)
    if (req.method === "GET") {
        const mode = req.query["hub.mode"];
        const token = req.query["hub.verify_token"];
        const challenge = req.query["hub.challenge"];

        if (mode === "subscribe" && token === VERIFY_TOKEN) {
            return res.status(200).send(challenge);
        }
        return res.status(403).send("Forbidden");
    }

    // POST
    if (req.method === "POST") {
        const body = req.body;
        
        // Enviar respuesta desde el frontend
        if (body.action === "send_reply") {
            try {
                const { message_type, recipient_id, message, comment_id } = body;
                
                if (message_type === "comment") {
                    // Responder a un comentario
                    await replyToComment(comment_id, message);
                } else {
                    // Enviar DM
                    await sendDirectMessage(recipient_id, message);
                }
                
                return res.status(200).json({ success: true });
            } catch (error) {
                console.error("Error enviando respuesta:", error);
                return res.status(500).json({ error: error.message });
            }
        }
        
        console.log("Webhook recibido:", JSON.stringify(body, null, 2));

        try {
            // Instagram
            if (body.object === "instagram") {
                const entry = body.entry?.[0];
                const messaging = entry?.messaging?.[0];
                const changes = entry?.changes?.[0];

                // DMs
                if (messaging && messaging.message && !messaging.message.is_echo) {
                    await processMessage({
                        sourceId: messaging.sender.id,
                        sourceType: "instagram",
                        messageType: "dm",
                        text: messaging.message.text,
                        metaMsgId: messaging.message.mid
                    });
                }

                // Comentarios
                if (changes && changes.field === "comments") {
                    const comment = changes.value;
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

            // WhatsApp
            if (body.object === "whatsapp_business_account") {
                const entry = body.entry?.[0];
                const changes = entry?.changes?.[0];
                const value = changes?.value;
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

            return res.status(200).send("OK");
        } catch (error) {
            console.error("Error procesando webhook:", error);
            return res.status(500).send("Error interno");
        }
    }

    return res.status(405).send("Method Not Allowed");
};

// Responder a un comentario de Instagram
async function replyToComment(commentId, messageText) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            message: messageText
        });

        const options = {
            hostname: 'graph.facebook.com',
            port: 443,
            path: `/v21.0/${commentId}/replies?access_token=${META_ACCESS_TOKEN}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const request = https.request(options, (response) => {
            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
                if (response.statusCode >= 200 && response.statusCode < 300) {
                    console.log("Respuesta a comentario enviada:", data);
                    resolve(JSON.parse(data));
                } else {
                    console.error("Error de Instagram API:", data);
                    reject(new Error(data));
                }
            });
        });

        request.on('error', reject);
        request.write(postData);
        request.end();
    });
}

// Enviar DM de Instagram
async function sendDirectMessage(recipientId, messageText) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            recipient: { id: recipientId },
            message: { text: messageText }
        });

        const options = {
            hostname: 'graph.facebook.com',
            port: 443,
            path: `/v21.0/me/messages?access_token=${META_ACCESS_TOKEN}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const request = https.request(options, (response) => {
            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
                if (response.statusCode >= 200 && response.statusCode < 300) {
                    console.log("DM enviado:", data);
                    resolve(JSON.parse(data));
                } else {
                    console.error("Error de Instagram API:", data);
                    reject(new Error(data));
                }
            });
        });

        request.on('error', reject);
        request.write(postData);
        request.end();
    });
}

async function processMessage({ sourceId, sourceType, messageType, name, text, metaMsgId, commentId, postId }) {
    const field = sourceType === "whatsapp" ? "wa_id" : "ig_id";

    // Buscar o crear cliente
    let customerRef;
    const customerSnap = await db.collection("customers")
        .where(field, "==", sourceId)
        .limit(1)
        .get();

    if (!customerSnap.empty) {
        customerRef = customerSnap.docs[0].ref;
    } else {
        customerRef = await db.collection("customers").add({
            name: name || "Cliente Nuevo",
            [field]: sourceId,
            created_at: admin.firestore.FieldValue.serverTimestamp()
        });
    }

    // Para comentarios: cada comentario es una "conversación" separada
    // Para DMs: una conversación por cliente
    let conversationRef;
    
    if (messageType === "comment" && commentId) {
        // Crear conversación específica para este comentario
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
    } else {
        // Para DMs: buscar conversación existente o crear nueva
        const convSnap = await db.collection("conversations")
            .where("customer_id", "==", customerRef.id)
            .where("status", "==", "open")
            .where("message_type", "==", "dm")
            .limit(1)
            .get();

        if (!convSnap.empty) {
            conversationRef = convSnap.docs[0].ref;
            await conversationRef.update({
                updated_at: admin.firestore.FieldValue.serverTimestamp()
            });
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

    // Guardar mensaje
    await db.collection("messages").add({
        conversation_id: conversationRef.id,
        customer_id: customerRef.id,
        type: "incoming",
        text: text,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        meta_msg_id: metaMsgId,
        comment_id: commentId || null
    });

    console.log(`[${messageType.toUpperCase()}] Mensaje guardado: ${(text || "").substring(0, 50)}...`);
}
