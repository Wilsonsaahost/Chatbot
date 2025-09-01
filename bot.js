// Importa las librerías necesarias
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

// --- CONFIGURACIÓN - RELLENA CON TUS DATOS ---
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
// Crea una instancia de la aplicación Express
const app = express();
app.use(bodyParser.json());

// --- 1. CONFIGURACIÓN DEL WEBHOOK PARA RECIBIR MENSAJES ---
app.get('/webhook', (req, res) => {
  // Verificación del Webhook con Meta
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

app.post('/webhook', (req, res) => {
  const body = req.body;

  // Imprime en la consola el mensaje recibido para que lo veas
  console.log(JSON.stringify(body, null, 2));

  if (body.object) {
    if (
      body.entry &&
      body.entry[0].changes &&
      body.entry[0].changes[0] &&
      body.entry[0].changes[0].value.messages &&
      body.entry[0].changes[0].value.messages[0]
    ) {
      const from = body.entry[0].changes[0].value.messages[0].from; // Número que envió el mensaje
      const msg_body = body.entry[0].changes[0].value.messages[0].text.body; // Texto del mensaje

   // --- LÓGICA DEL BOT ---
      // Aquí es donde decides qué responder.
      // Ejemplo: si el usuario envía "hola", le respondemos.
      if (msg_body.toLowerCase() === 'hola') {
        sendMessage(from, 'Bienvenido a Hostaddres, ¿en qué puedo ayudarte?');
      }
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// --- 2. FUNCIÓN PARA ENVIAR MENSAJES ---
async function sendMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        text: { body: text },
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log(`Mensaje enviado a ${to}: ${text}`);
  } catch (error) {
    console.error('Error enviando mensaje:', error.response ? error.response.data : error.message);
  }
}

// Inicia el servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});