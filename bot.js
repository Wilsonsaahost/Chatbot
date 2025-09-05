// --- LIBRERÍAS NECESARIAS ---
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { MongoClient, ObjectId } = require('mongodb'); // ObjectId es necesario para buscar por ID

// --- CONFIGURACIÓN SEGURA DESDE RENDER ---
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const DATABASE_URL = process.env.DATABASE_URL;
const API_SECRET_KEY = process.env.API_SECRET_KEY;
const NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL; // NUEVO: Email para notificaciones

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

// --- RUTAS DEL SERVIDOR ---
// (Las rutas '/', '/webhook' GET, y '/save-recommendation' se mantienen sin cambios)
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
        const document = {
            whatsapp_number: normalizePhoneNumber(whatsapp_number),
            business_name,
            recommendation,
            conversationHistory: [], // NUEVO: Inicializamos el historial
            createdAt: new Date()
        };
        await collection.insertOne(document);
        console.log(`✅ Recomendación guardada para ${business_name}`);
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

    // Reiniciamos el temporizador de inactividad con cada mensaje
    if (userTimeouts.has(from)) clearTimeout(userTimeouts.get(from));
    const timeout = setTimeout(() => {
      const timeoutPayload = {
        messaging_product: "whatsapp", to: from, text: { body: "👋 Ha pasado un tiempo. Se ha finalizado esta sesión. Si necesitas algo más, solo tienes que escribir de nuevo." }
      };
      sendWhatsAppMessage(from, timeoutPayload);
      userTimeouts.delete(from);
      userSessions.delete(from);
    }, 60000);
    userTimeouts.set(from, timeout);

    try {
      const user = await db.collection('users').findOne({ whatsapp_number: normalizedFrom }, { sort: { createdAt: -1 } });
      let messagePayload;
      let messageContent = ''; // Variable para guardar el texto del mensaje

      if (message.type === 'text') {
        messageContent = message.text.body;
      } else if (message.type === 'interactive') {
        messageContent = `[Usuario seleccionó: ${message.interactive.list_reply?.title || message.interactive.button_reply?.title}]`;
      }
      
      // Guardamos el mensaje del usuario en el historial
      if(user) {
        await db.collection('users').updateOne({ _id: user._id }, {
          $push: { conversationHistory: { sender: 'user', message: messageContent, timestamp: new Date() } }
        });
      }

      // ---- INICIO DE LA LÓGICA DE RESPUESTA ----

      if (message.type === 'text') {
        if (!userSessions.has(from)) {
          userSessions.set(from, true);
          messagePayload = {
            messaging_product: "whatsapp", to: from, text: { body: `👋 ¡Hola, ${userName}! Soy tu *AsesorIA* y te doy la bienvenida a *Hostaddrees*.` }
          };
          await sendWhatsAppMessage(from, messagePayload);
          await sendMainMenu(from, user);
        } else {
          messagePayload = {
            messaging_product: "whatsapp", to: from, text: { body: "Por favor, selecciona una de las opciones del menú para continuar." }
          };
          await sendWhatsAppMessage(from, messagePayload);
          await sendMainMenu(from, user);
        }
      } else if (message.type === 'interactive') {
        // ... (resto de la lógica interactiva sin cambios, solo asegúrate de llamar a sendWhatsAppMessage(from, payload))
        // ...
      }
      
    } catch (error) {
      console.error('🔴 Error procesando el mensaje:', error);
    }

    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// --- FUNCIONES DE MENÚS Y ENVÍO ---

async function sendMainMenu(to, user) {
  // ... (código sin cambios)
  // ...
  await sendWhatsAppMessage(to, menuPayload);
}

async function sendFollowUpMenu(to) {
  // ... (código sin cambios)
  // ...
  await sendWhatsAppMessage(to, followUpPayload);
}

// --- FUNCIÓN DE ENVÍO DE MENSAJES MODIFICADA ---
async function sendWhatsAppMessage(from, messagePayload) {
  try {
    // Primero, enviamos el mensaje a WhatsApp
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      messagePayload,
      { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log(`✅ Mensaje enviado a ${from}`);

    // Segundo, guardamos el mensaje del bot en la base de datos
    const normalizedFrom = normalizePhoneNumber(from);
    const user = await db.collection('users').findOne({ whatsapp_number: normalizedFrom }, { sort: { createdAt: -1 } });
    if (user) {
      let botMessageContent = '';
      if (messagePayload.text) {
        botMessageContent = messagePayload.text.body;
      } else if (messagePayload.type === 'interactive') {
        botMessageContent = `[Bot envió menú: ${messagePayload.interactive.header.text}]`;
      }
      // Añadimos más condiciones si envías otros tipos de mensajes (imágenes, etc.)
      
      await db.collection('users').updateOne({ _id: user._id }, {
        $push: { conversationHistory: { sender: 'bot', message: botMessageContent, timestamp: new Date() } }
      });
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
