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

let db; // Variable para mantener la conexión a la base de datos

// Conectamos a MongoDB al iniciar el bot
MongoClient.connect(DATABASE_URL)
  .then(client => {
    console.log('✅ Conectado exitosamente a la base de datos');
    db = client.db('Hostaddres'); // Nombre de tu base de datos
  })
  .catch(error => console.error('🔴 Error al conectar a la base de datos:', error));


// --- RUTAS DEL SERVIDOR ---

// 1. Ruta principal para mantener el bot activo con UptimeRobot
app.get('/', (req, res) => {
  res.status(200).send('¡El bot de WhatsApp está activo y escuchando!');
});

// 2. Ruta para la verificación del Webhook con Meta (Facebook)
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
            whatsapp_number,
            business_name,
            recommendation,
            createdAt: new Date()
            // El campo 'welcome_message_sent' ya no es necesario
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
    const from = body.entry[0].changes[0].value.messages[0].from;
    const msg_body = body.entry[0].changes[0].value.messages[0].text.body;

    try {
      // --- LÓGICA MODIFICADA ---
      const user = await db.collection('users').findOne({ whatsapp_number: from });

      // Si encontramos al usuario en la base de datos...
      if (user) {
        // Le enviamos su recomendación guardada, sin importar lo que escriba.
        const introMessage = `Hola ${user.business_name}, aquí tienes la última recomendación que generamos para ti:`;
        await sendMessage(from, introMessage);
        await sendMessage(from, user.recommendation);

      } else {
        // Si el usuario es nuevo (no está en la DB), aplicamos la lógica general.
        if (msg_body.toLowerCase() === 'hola') {
            await sendMessage(from, 'Bienvenido a Hostaddres, ¿en qué puedo ayudarte?');
        } else {
            await sendMessage(from, 'No he entendido tu mensaje. Si necesitas ayuda, escribe "hola".');
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

// --- FUNCIÓN PARA ENVIAR MENSAJES ---
async function sendMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to: to, text: { body: text } },
      { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } }
    );
    console.log(`✅ Mensaje enviado a ${to}`);
  } catch (error) {
    console.error('🔴 Error enviando mensaje:', error.response ? error.response.data : error.message);
  }
}

// --- ARRANQUE DEL SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
});
