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

// --- FUNCIÓN DE NORMALIZACIÓN DE NÚMEROS ---
function normalizePhoneNumber(phoneNumber) {
  const digitsOnly = phoneNumber.replace(/\D/g, '');
  if (digitsOnly.startsWith('57') && digitsOnly.length > 10) {
    return digitsOnly.substring(2);
  }
  return digitsOnly;
}

// --- RUTAS DEL SERVIDOR ---

// 1. Ruta principal para UptimeRobot
app.get('/', (req, res) => {
  res.status(200).send('¡El bot de WhatsApp está activo y escuchando!');
});

// 2. Ruta para la verificación del Webhook con Meta
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

// 3. Ruta secreta para recibir datos desde WordPress
app.post('/save-recommendation', async (req, res) => {
    const providedApiKey = req.header('x-api-key');
    if (providedApiKey !== API_SECRET_KEY) {
        return res.status(401).send('Acceso no autorizado');
    }
    const { whatsapp_number, business_name, recommendation } = req.body;
    if (!whatsapp_number || !business_name || !recommendation) {
        return res.status(400).send('Faltan datos en la solicitud');
    }
    try {
        const collection = db.collection('users');
        const document = {
            whatsapp_number: normalizePhoneNumber(whatsapp_number),
            business_name,
            recommendation,
            createdAt: new Date()
        };
        await collection.insertOne(document);
        console.log(`✅ Recomendación guardada para ${business_name}`);
        res.status(200).send('Recomendación guardada exitosamente');
    } catch (error) {
        console.error('🔴 Error al guardar la recomendación desde WordPress:', error);
        res.status(500).send('Error interno del servidor');
    }
});

// 4. Ruta principal para recibir los mensajes de WhatsApp
app.post('/webhook', async (req, res) => {
  const body = req.body;
  
  if (body.object && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
    const message = body.entry[0].changes[0].value.messages[0];
    const from = message.from;
    const normalizedFrom = normalizePhoneNumber(from);

    try {
      // --- LÓGICA DE BÚSQUEDA MEJORADA ---

      // 1. Buscamos la recomendación más reciente del usuario
      const today = new Date();
      today.setHours(0, 0, 0, 0); // Establecemos la hora a las 00:00:00 del día de hoy

      const userRecommendation = await db.collection('users').findOne(
        {
          whatsapp_number: normalizedFrom,
          createdAt: { $gte: today } // Filtramos para que sea solo de hoy
        },
        { sort: { createdAt: -1 } } // Ordenamos para obtener la más reciente
      );

      // CASO 1: El usuario envía un mensaje de texto "hola"
      if (message.type === 'text' && message.text.body.toLowerCase() === 'hola') {
        if (userRecommendation) {
          // Si el usuario tiene una recomendación de HOY, le mostramos el botón.
          const messagePayload = {
            messaging_product: "whatsapp",
            to: from,
            type: "interactive",
            interactive: {
              type: "button",
              body: { text: `¡Hola ${userRecommendation.business_name}! Bienvenido de nuevo. Veo que generaste una recomendación hoy.` },
              action: {
                buttons: [{
                  type: "reply",
                  reply: { id: "show_recommendation", title: "Ver mi recomendación" }
                }]
              }
            }
          };
          await sendWhatsAppMessage(messagePayload);
        } else {
          // Si no tiene recomendación de hoy, le enviamos un saludo normal.
          const messagePayload = {
            messaging_product: "whatsapp",
            to: from,
            type: "text",
            text: { body: "Bienvenido a Hostaddres, ¿en qué puedo ayudarte? Si generas una recomendación en nuestro sitio, podrás verla aquí." }
          };
          await sendWhatsAppMessage(messagePayload);
        }
      }
      // CASO 2: El usuario presiona un botón
      else if (message.type === 'interactive' && message.interactive.type === 'button_reply') {
        if (message.interactive.button_reply.id === 'show_recommendation') {
          // Volvemos a buscar la recomendación para asegurarnos de que la tenemos
          if (userRecommendation) {
            const messagePayload = {
              messaging_product: "whatsapp",
              to: from,
              type: "text",
              text: { body: userRecommendation.recommendation }
            };
            await sendWhatsAppMessage(messagePayload);
          }
        }
      }
      // CASO 3: El usuario escribe algo diferente a "hola"
      else if (message.type === 'text') {
        const messagePayload = {
          messaging_product: "whatsapp",
          to: from,
          type: "text",
          text: { body: 'Para comenzar, por favor escribe "hola".' }
        };
        await sendWhatsAppMessage(messagePayload);
      }
      
    } catch (error) {
      console.error('🔴 Error procesando el mensaje:', error);
    }

    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// --- FUNCIÓN DE ENVÍO DE MENSAJES (sin cambios) ---
async function sendWhatsAppMessage(messagePayload) {
  const to = messagePayload.to;
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      messagePayload,
      { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log(`✅ Mensaje enviado a ${to}`);
  } catch (error) {
    console.error('🔴 Error enviando mensaje:', error.response ? error.response.data.error : error.message);
  }
}

// --- ARRANQUE DEL SERVIDOR (sin cambios) ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
});
