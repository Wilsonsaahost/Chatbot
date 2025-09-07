// --- LIBRERÍAS NECESARIAS ---
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { MongoClient } = require('mongodb');

// --- CONFIGURACIÓN SEGURA DESDE RENDER ---
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const DATABASE_URL = process.env.DATABASE_URL;
const API_SECRET_KEY = process.env.API_SECRET_KEY;

// --- INICIALIZACIÓN DE LA APLICACIÓN Y LA BASE DE DATOS ---
const app = express();
app.use(bodyParser.json());

let db;

MongoClient.connect(DATABASE_URL)
  .then(client => {
    console.log('✅ Conectado exitosamente a la base de datos');
    db = client.db('Hostaddres');
  })
  .catch(error => console.error('🔴 Error al conectar a la base de datos:', error));

// --- GESTIÓN DE ESTADO Y TIMEOUTS ---
const userSessions = new Map();
const userTimeouts = new Map();

// --- FUNCIÓN DE NORMALIZACIÓN DE NÚMEROS ---
function normalizePhoneNumber(phoneNumber) {
  const digitsOnly = phoneNumber.replace(/\D/g, '');
  if (digitsOnly.startsWith('57') && digitsOnly.length > 10) {
    return digitsOnly.substring(2);
  }
  return digitsOnly;
}

// --- FUNCIÓN: OBTENER O CREAR USUARIO ---
async function getOrCreateUser(normalizedPhone, profileName) {
    const users = db.collection('users');
    let user = await users.findOne({ whatsapp_number: normalizedPhone });

    if (!user) {
        console.log(`[Info] Usuario no encontrado para ${normalizedPhone}. Creando nuevo perfil.`);
        const newUserDoc = {
            whatsapp_number: normalizedPhone,
            business_name: profileName,
            recommendation: null,
            conversationHistory: [],
            createdAt: new Date()
        };
        const result = await users.insertOne(newUserDoc);
        user = { ...newUserDoc, _id: result.insertedId };
    }
    return user;
}

// --- RUTAS DEL SERVIDOR ---
app.get('/', (req, res) => res.status(200).send('¡El bot de WhatsApp está activo y escuchando!'));
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && token === VERIFY_TOKEN && mode === 'subscribe') {
    console.log('WEBHOOK_VERIFIED');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});
app.post('/save-recommendation', async (req, res) => {
    const providedApiKey = req.header('x-api-key');
    if (providedApiKey !== API_SECRET_KEY) return res.status(401).send('Acceso no autorizado');
    const { whatsapp_number, business_name, recommendation } = req.body;
    if (!whatsapp_number || !business_name || !recommendation) return res.status(400).send('Faltan datos');
    try {
        const collection = db.collection('users');
        await collection.updateOne(
            { whatsapp_number: normalizePhoneNumber(whatsapp_number) },
            { $set: { business_name, recommendation, createdAt: new Date() }, $setOnInsert: { conversationHistory: [] } },
            { upsert: true }
        );
        console.log(`✅ Recomendación guardada/actualizada para ${business_name}`);
        res.status(200).send('Recomendación guardada');
    } catch (error) {
        console.error('🔴 Error al guardar la recomendación:', error);
        res.status(500).send('Error interno');
    }
});

// 4. Ruta principal para recibir los mensajes de WhatsApp
app.post('/webhook', async (req, res) => {
  const body = req.body;
  
  if (body.object && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
    const message = body.entry[0].changes?.[0]?.value?.messages?.[0];
    const contact = body.entry[0].changes[0].value.contacts[0];
    const from = message.from;
    const userName = contact.profile.name;
    const normalizedFrom = normalizePhoneNumber(from);

    if (userTimeouts.has(from)) clearTimeout(userTimeouts.get(from));
    const timeout = setTimeout(async () => {
      await endSession(from, "inactividad");
    }, 60000);
    userTimeouts.set(from, timeout);

    try {
      const user = await getOrCreateUser(normalizedFrom, userName);
      let messageContent = '';

      if (message.type === 'text') {
        messageContent = message.text.body;
      } else if (message.type === 'interactive') {
        messageContent = `[Usuario seleccionó: ${message.interactive.list_reply?.title || message.interactive.button_reply?.title}]`;
      }
      
      await db.collection('users').updateOne({ _id: user._id }, {
        $push: { conversationHistory: { sender: 'user', message: messageContent, timestamp: new Date() } }
      });

      // --- Lógica de Respuesta ---
      if (message.type === 'text') {
        if (!userSessions.has(from)) {
          userSessions.set(from, true);
          const welcomePayload = {
            messaging_product: "whatsapp", to: from, text: { body: `👋 ¡Hola, ${userName}! Soy tu *AsesorIA* y te doy la bienvenida a *Hostaddrees*.` }
          };
          await sendWhatsAppMessage(welcomePayload, user);
          await sendMainMenu(from, user);
        } else {
          const reminderPayload = {
            messaging_product: "whatsapp", to: from, text: { body: "Por favor, selecciona una de las opciones del menú para continuar." }
          };
          await sendWhatsAppMessage(reminderPayload, user);
          await sendMainMenu(from, user);
        }
      } else if (message.type === 'interactive') {
        const selectedId = message.interactive.list_reply?.id || message.interactive.button_reply?.id;
        let replyText = '';
        let showFollowUp = true;
        
        switch(selectedId) {
            case 'show_recommendation':
                if(user && user.recommendation) replyText = `📄 *Aquí tienes tu última recomendación para ${user.business_name}:*\n\n${user.recommendation}`;
                else replyText = "No he encontrado una recomendación para ti. Puedes generar una en nuestro sitio web.";
                break;
            case 'generate_recommendation':
                replyText = "¡Claro! 💡 Genera tu recomendación personalizada en el siguiente enlace:\nwww.hostaddrees.com/#IA";
                break;
            case 'contact_sales':
                replyText = "Para hablar con nuestro equipo de ventas, por favor usa este enlace: 🤝\nhttps://api.whatsapp.com/send/?phone=573223063648&text=Hola+Ventas+&type=phone_number&app_absent=0";
                break;
            case 'contact_support':
                replyText = "Para recibir soporte técnico, por favor usa este enlace: ⚙️\nhttps://api.whatsapp.com/send/?phone=573223063648&text=Hola+Soporte+&type=phone_number&app_absent=0";
                break;
            case 'show_main_menu':
                await sendMainMenu(from, user);
                showFollowUp = false;
                break;
            case 'end_chat':
                await endSession(from, "usuario");
                showFollowUp = false;
                break;
        }

        if (replyText) {
          const replyPayload = { messaging_product: "whatsapp", to: from, text: { body: replyText } };
          await sendWhatsAppMessage(replyPayload, user);
        }
        if (showFollowUp) {
          await sendFollowUpMenu(to);
        }
      }
    } catch (error) {
      console.error('🔴 Error procesando el mensaje:', error);
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// --- FUNCIÓN PARA FINALIZAR SESIÓN ---
async function endSession(from, reason) {
    let farewellMessage = '';
    if (reason === "usuario") {
        farewellMessage = "✅ ¡Entendido! Ha sido un placer ayudarte. Si necesitas algo más, solo tienes que escribir de nuevo.";
    } else if (reason === "inactividad") {
        farewellMessage = "👋 Ha pasado un tiempo. Se ha finalizado esta sesión. Si necesitas algo más, solo tienes que escribir de nuevo.";
    }
    if (farewellMessage) {
        const farewellPayload = { messaging_product: "whatsapp", to: from, text: { body: farewellMessage } };
        const normalizedFrom = normalizePhoneNumber(from);
        const user = await db.collection('users').findOne({ whatsapp_number: normalizedFrom });
        await sendWhatsAppMessage(farewellPayload, user);
    }
    console.log(`Finalizando sesión para ${from} por ${reason}.`);
    if (userTimeouts.has(from)) clearTimeout(userTimeouts.get(from));
    userTimeouts.delete(from);
    userSessions.delete(from);
}

// --- FUNCIONES DE MENÚS ---
async function sendMainMenu(to, user) {
  const commonRows = [
    { id: "contact_sales", title: "🤝 Contactar con Ventas" },
    { id: "contact_support", title: "⚙️ Contactar con Soporte" },
    { id: "end_chat", title: "🔚 Finalizar Chat" }
  ];
  let firstRow, menuBodyText;
  if (user && user.recommendation) {
    firstRow = { id: "show_recommendation", title: "📄 Ver recomendación" };
    menuBodyText = `Veo que tienes una recomendación para *${user.business_name}*.\n\nPor favor, selecciona una opción:`;
  } else {
    firstRow = { id: "generate_recommendation", title: "💡 Crear recomendación" };
    menuBodyText = "Por favor, selecciona una de las siguientes opciones:";
  }
  const menuPayload = {
    messaging_product: "whatsapp", to: to, type: "interactive",
    interactive: {
      type: "list", header: { type: "text", text: "Menú Principal" },
      body: { text: menuBodyText }, footer: { text: "✨ Hostaddrees AsesorIA" },
      action: { button: "Ver Opciones ⚙️", sections: [{ title: "ACCIONES", rows: [firstRow, ...commonRows] }] }
    }
  };
  await sendWhatsAppMessage(menuPayload, user);
}
async function sendFollowUpMenu(to) {
  const followUpPayload = {
    messaging_product: "whatsapp", to: to, type: "interactive",
    interactive: {
      type: "button", body: { text: "¿Puedo ayudarte en algo más?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "show_main_menu", title: "Sí, ver menú" } },
          { type: "reply", reply: { id: "end_chat", title: "No, gracias" } }
        ]
      }
    }
  };
  const normalizedFrom = normalizePhoneNumber(to);
  const user = await db.collection('users').findOne({ whatsapp_number: normalizedFrom });
  await sendWhatsAppMessage(followUpPayload, user);
}

// --- FUNCIÓN DE ENVÍO DE MENSAJES Y GUARDADO DE HISTORIAL (VERSIÓN DEPURACIÓN) ---
async function sendWhatsAppMessage(messagePayload, user = null) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      messagePayload,
      { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } }
    );
    console.log(`✅ Mensaje enviado a ${messagePayload.to}`);

    if (user && user._id) {
      let botMessageContent = '';
      if (messagePayload.text) {
        botMessageContent = messagePayload.text.body;
      } else if (messagePayload.type === 'interactive') {
        botMessageContent = `[Bot envió menú: ${messagePayload.interactive.header.text}]`;
      }
      
      const updateResult = await db.collection('users').updateOne({ _id: user._id }, {
        $push: { conversationHistory: { sender: 'bot', message: botMessageContent, timestamp: new Date() } },
        $set: { lastBotInteraction: new Date() } // <-- EL "SELLO" DE ACTUALIZACIÓN
      });

      // Log para ver si la actualización fue exitosa
      if (updateResult.modifiedCount > 0) {
        console.log(`[Depuración] ¡ÉXITO! Se actualizó el historial para ${user.whatsapp_number}.`);
      } else {
        console.log(`[Depuración] AVISO: El comando de actualización se ejecutó pero no modificó el documento para ${user.whatsapp_number}.`);
      }
    }
  } catch (error) {
    console.error('🔴 Error enviando mensaje o guardando historial:', error.response ? error.response.data.error : error.message);
  }
}

// --- ARRANQUE DEL SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
});
