const admin = require("firebase-admin");

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
}
const db = admin.firestore();

const VERIFY_TOKEN = process.env.HUB_VERIFY_TOKEN || "helpdesk_secret_2024";

module.exports = async (req, res) => {
    if (req.method === "GET") {
        const mode = req.query["hub.mode"];
        const token = req.query["hub.verify_token"];
        const challenge = req.query["hub.challenge"];

        if (mode === "subscribe" && token === VERIFY_TOKEN) {
            console.log("Webhook verificado correctamente");
            return res.status(200).send(challenge);
        }
        return res.status(403).send("Forbidden");
    }

    if (req.method === "POST") {
        const body = req.body;
        console.log("Webhook recibido:", JSON.stringify(body, null, 2));

        try {
            if (body.object === "instagram") {
                const entry = body.entry?.[0];
                const messaging = entry?.messaging?.[0];
                const changes = entry?.changes?.[0];

                if (messaging && messaging.message && !messaging.message.is_echo) {
                    await processMessage({
                        sourceId: messaging.sender.id,
                        sourceType: "instagram",
                        text: messaging.message.text,
                        metaMsgId: messaging.message.mid
                    });
                }

                if (changes && changes.field === "comments") {
                    const comment = changes.value;
                    await processMessage({
                        sourceId: comment.from.id,
                        sourceType: "instagram",
                        name: comment.from.username,
                        text: "[Comentario]: " + comment.text,
                        metaMsgId: comment.id
                    });
                }
            }

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

async function processMessage({ sourceId, sourceType, name, text, metaMsgId }) {
    const field = sourceType === "whatsapp" ? "wa_id" : "ig_id";

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

    let conversationRef;
    const convSnap = await db.collection("conversations")
        .where("customer_id", "==", customerRef.id)
        .where("status", "==", "open")
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
            assigned_agent_id: null,
            created_at: admin.firestore.FieldValue.serverTimestamp(),
            updated_at: admin.firestore.FieldValue.serverTimestamp()
        });
    }

    await db.collection("messages").add({
        conversation_id: conversationRef.id,
        customer_id: customerRef.id,
        type: "incoming",
        text: text,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        meta_msg_id: metaMsgId
    });

    console.log("Mensaje guardado: " + (text ? text.substring(0, 50) : "") + "...");
}
