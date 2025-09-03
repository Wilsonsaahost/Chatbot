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
    const message = body.entry[0].changes?.[0]?.value?.messages?.[0];
    const contact = body.entry[0].changes[0].value.contacts[0];
    const from = message.from;
    const userName = contact.profile.name; // <-- OBTENEMOS EL NOMBRE DE WHATSAPP
    const normalizedFrom = normalizePhoneNumber(from);

    try {
      const user = await db.collection('users').findOne(
        { whatsapp_number: normalizedFrom },
        { sort: { createdAt: -1 } }
      );

      // CASO 1: El usuario envía CUALQUIER mensaje de texto
      if (message.type === 'text') {
        // Primero, enviamos el saludo general y personalizado con su nombre.
        const welcomePayload = {
          messaging_product: "whatsapp",
          to: from,
          text: { body: `👋 ¡Hola, ${userName}! Soy tu *AsesorIA* y te doy la bienvenida a *Hostaddrees*.` }
        };
        await sendWhatsAppMessage(welcomePayload);

        // Preparamos las opciones comunes del menú
        const commonRows = [
          { id: "contact_sales", title: "🤝 Hablar con Ventas" },
          { id: "contact_support", title: "⚙️ Pedir Soporte" }
        ];

        let firstRow;
        let menuBodyText;

        if (user) {
          firstRow = { id: "show_recommendation", title: "📄 Ver recomendación" };
          // Personalizamos el cuerpo del menú con el nombre de la empresa
          menuBodyText = `Veo que tienes una recomendación para *${user.business_name}*.\n\nPor favor, selecciona una opción:`;
        } else {
          firstRow = { id: "generate_recommendation", title: "💡 Crear recomendación" };
          menuBodyText = "Por favor, selecciona una de las siguientes opciones:";
        }

        // Construimos el menú interactivo
        const menuPayload = {
          messaging_product: "whatsapp",
          to: from,
          type: "interactive",
          interactive: {
            type: "list",
            header: { type: "text", text: "Menú Principal" },
            body: { text: menuBodyText },
            footer: { text: "✨ Hostaddrees AsesorIA" },
            action: {
              button: "Ver Opciones ⚙️",
              sections: [
                {
                  title: "ACCIONES",
                  rows: [firstRow, ...commonRows]
                }
              ]
            }
          }
        };
        await sendWhatsAppMessage(menuPayload);
      }

      // CASO 2: El usuario selecciona una opción del menú (lista)
      else if (message.type === 'interactive' && message.interactive.type === 'list_reply') {
        const selectedId = message.interactive.list_reply.id;
        let replyText = '';

        if (selectedId === 'show_recommendation' && user) {
          replyText = `📄 *Aquí tienes tu última recomendación para ${user.business_name}:*\n\n${user.recommendation}`;
        } else if (selectedId === 'generate_recommendation') {
          replyText = "¡Claro! 💡 Genera tu recomendación personalizada en el siguiente enlace:\nwww.hostaddrees.com/#IA";
        } else if (selectedId === 'contact_sales') {
          replyText = "Para hablar con nuestro equipo de ventas, por favor usa este enlace: 🤝\nhttps://api.whatsapp.com/send/?phone=573223063648&text=Hola+Ventas+&type=phone_number&app_absent=0";
        } else if (selectedId === 'contact_support') {
          replyText = "Para recibir soporte técnico, por favor usa este enlace: ⚙️\nhttps://api.whatsapp.com/send/?phone=573223063648&text=Hola+Soporte+&type=phone_number&app_absent=0";
        }

        if (replyText) {
          const replyPayload = {
            messaging_product: "whatsapp",
            to: from,
            text: { body: replyText }
          };
          await sendWhatsAppMessage(replyPayload);
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
