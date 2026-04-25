const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'chatsprout2026';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Receive messages
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0]?.changes?.[0]?.value;
    const message = entry?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const text = message.text?.body?.toLowerCase() || '';

    let reply = "Welcome to ChatSprout Boutique! 👋\nReply:\n1 - View Catalog\n2 - My Orders\n3 - Talk to human";

    if (text.includes('1') || text.includes('catalog')) {
      const { data: products } = await supabase.from('products').select('*').limit(5);
      reply = "🛍️ Our Collection:\n\n" + products.map((p,i) =>
        `${i+1}. ${p.name} - ₹${p.price}\nReply ORDER ${i+1}`
      ).join('\n\n');
    }

    if (text.startsWith('order')) {
      const num = parseInt(text.split(' ')[1]) || 1;
      const { data: products } = await supabase.from('products').select('*');
      const product = products[num-1];
      if (product) {
        await supabase.from('orders').insert({
          customer_phone: from,
          product_id: product.id,
          status: 'new'
        });
        reply = `✅ Order placed!\n${product.name} - ₹${product.price}\n\nWe'll confirm via WhatsApp shortly. Thank you!`;
      }
    }

    if (text.includes('2')) {
      const { data: orders } = await supabase.from('orders')
       .select('*, products(name,price)')
       .eq('customer_phone', from)
       .order('created_at', { ascending: false })
       .limit(3);
      reply = orders.length?
        "📦 Your Orders:\n" + orders.map(o => `• ${o.products.name} - ₹${o.products.price} (${o.status})`).join('\n') :
        "No orders yet. Reply 1 to shop!";
    }

    // Send reply via WhatsApp
    if (WHATSAPP_TOKEN && PHONE_NUMBER_ID && WHATSAPP_TOKEN!== 'temp') {
      await axios.post(
        `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: 'whatsapp',
          to: from,
          text: { body: reply }
        },
        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
      );
    }

    console.log(`Replied to ${from}: ${reply.substring(0,50)}...`);
  } catch (e) {
    console.error('Error:', e.message);
  }
  res.sendStatus(200);
});

app.get('/', (req, res) => res.send('ChatSprout API running'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));