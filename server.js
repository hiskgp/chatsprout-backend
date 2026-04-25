require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { getAIReply } = require('./aiTemplates');

const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'chatsprout2026';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const API_VERSION = 'v21.0';

// 1. Webhook verification (Meta calls this once)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// 2. Receive messages
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0]?.changes?.[0]?.value;
    const message = entry?.messages?.[0];

    if (!message || message.type!== 'text') {
      return res.sendStatus(200);
    }

    const from = message.from; // user phone
    const text = message.text.body.toLowerCase();

    console.log(`📩 From ${from}: ${text}`);

    // AI detects intent
    let category = 'greeting';
    let variables = { product: 'kurti', price: '1299', size: 'M' };

    if (text.includes('price') || text.includes('rate') || text.includes('enna') || text.includes('₹') || text.includes('cost') || text.includes('evalo')) {
      category = 'price';
    } else if (text.includes('size') || text.includes('stock') || text.includes('irukka') || text.includes('available') || text.includes('iruka')) {
      category = 'size';
    } else if (text.includes('cod') || text.includes('cash')) {
      category = 'cod';
    } else if (text.includes('deliver') || text.includes('ship') || text.includes('days') || text.includes('evlo')) {
      category = 'delivery';
    } else if (text.includes('photo') || text.includes('pic') || text.includes('image') || text.includes('kaatu')) {
      category = 'photos';
    } else if (text.includes('exchange') || text.includes('return') || text.includes('refund')) {
      category = 'exchange';
    }

    const reply = getAIReply(category, variables);

    // Send reply via WhatsApp
    await axios.post(
      `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: from,
        type: 'text',
        text: { body: reply }
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`✅ Replied: ${reply}`);
    res.sendStatus(200);
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    res.sendStatus(500);
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ChatSprout Backend Running',
    time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Webhook URL: http://localhost:${PORT}/webhook`);
});