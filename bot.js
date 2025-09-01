// --- LIBRERÍAS NECESARIAS ---
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { MongoClient } = require('mongodb'); // <-- AÑADIDO: Driver para la base de datos

// --- CONFIGURACIÓN SEGURA DESDE RENDER ---
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const DATABASE_URL = process.env.DATABASE_URL; // <-- AÑADIDO: Tu cadena de conexión a MongoDB

// --- INICIALIZACIÓN DE LA APLICACIÓN Y LA BASE DE DATOS ---
const app = express();
app.use(bodyParser.json());

let db; // Variable para mantener la conexión a la base de datos

// Conectamos a MongoDB al iniciar el bot
MongoClient.connect(DATABASE_URL)
  .then(client => {
    console.log('✅ Conectado exitosamente a la base de datos');
    // Reemplaza 'nombre_de_tu_base_de_datos' por el nombre real de tu DB
    db = client.db('nombre_de_tu_base_de_datos'); 
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

// 3. Ruta principal para recibir los mensajes de WhatsApp
app.post('/webhook', async (req, res) => { // <-- La función ahora es 'async' para poder esperar a la DB
  const body = req.body;
  
  // Verificamos que sea un mensaje válido de WhatsApp
  if (body.object && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
    const from = body.entry[0].changes[0].value.messages[0].from; // Número del cliente
    const msg_body = body.entry[0].changes[0].value.messages[0].text.body; // Texto del mensaje

    try {
      // --- LÓGICA INTELIGENTE DEL BOT ---

      // 1. Buscamos al usuario en la base de datos por su número de WhatsApp
      // Reemplaza 'users' si tu colección se llama de otra forma
      const user = await db.collection('users').findOne({ whatsapp_number: from });

      // 2. Comprobamos si el usuario existe y si NO le hemos enviado el mensaje de bienvenida
      if (user && !user.welcome_message_sent) {
        
        // Creamos los mensajes personalizados
        const welcomeMessage = `Hola ${user.business_name}, qué bueno tenerte de nuevo. Te envío una copia de la recomendación que generaste en nuestro sitio:`;
        
        // Enviamos el saludo y la recomendación
        await sendMessage(from, welcomeMessage);
        await sendMessage(from, user.recommendation);

        // Actualizamos al usuario en la base de datos para no volver a saludarlo
        await db.collection('users').updateOne(
          { _id: user._id },
          { $set: { welcome_message_sent: true } }
        );

      } else {
        // --- LÓGICA NORMAL (si el usuario no existe o ya fue saludado) ---
        if (msg_body.toLowerCase() === 'hola') {
            await sendMessage(from, 'Bienvenido a Hostaddres, ¿en qué puedo ayudarte?');
        } else {
            // Aquí puedes añadir más comandos en el futuro
            await sendMessage(from, 'No he entendido tu mensaje. Si necesitas ayuda, escribe "hola".');
        }
      }
    } catch (error) {
      console.error('🔴 Error procesando el mensaje:', error);
    }

    res.sendStatus(200); // Respondemos a Meta para que sepa que recibimos el mensaje
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
