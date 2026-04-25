const aiReplies = {
  size: [
    "Yes akka! {size} size stock irukku. {product} la 3 colours irukku. Photo anupattuma?",
    "M size irukku da! Last 2 pieces than. Confirm pannitengala?",
    "XL sold out pa. L size adjust aaguma? Illa na next week varum.",
    "Stock irukku! {product} ready to ship. Today order panna naalaikku dispatch.",
    "Size chart anupren. Unga usual size enna? Naan suggest pannren.",
  ],
  price: [
    "{product} ₹{price} than akka. Quality super irukkum. COD available.",
    "₹{price} fixed rate da. Offer la 2 edutha ₹{discount} discount.",
    "Best price than pa. First time customer ku ₹50 off pannalam. Okay va?",
    "₹{price} including shipping! Vera charge illa.",
  ],
  cod: [
    "COD available all over Tamil Nadu! Delivery 2-3 days. ₹50 extra.",
    "Yes anna! COD irukku. Address confirm pannunga, naanga anuprom.",
    "Illa pa, COD um irukku, GPay um irukku. Convenient ah choose pannunga.",
  ],
  delivery: [
    "Coimbatore ku 1-2 days. Chennai 2-3 days. Other TN 3-4 days max.",
    "Shipping free above ₹999! Keela na ₹50 than.",
    "Dispatch aana udane tracking link anuprom. WhatsApp la update varum.",
  ],
  photos: [
    "Sure! {product} photos anupren. 1 min wait pannunga.",
    "Ithe real pic than akka! No filter. Video call la kuda kaatalaam.",
  ],
  exchange: [
    "7 days exchange irukku pa. Size issue na free exchange.",
    "Damage iruntha full refund. Size exchange 7 days. No questions.",
  ],
  greeting: [
    "Vanakkam akka! 🙏 ChatSprout boutique ku welcome. Enna paakanum?",
    "Hello da! Epdi irukkinga? Enna help venum?",
    "Yes available! Full time online than. Sollunga enna venum?",
  ]
};

function getAIReply(category, variables = {}) {
  const replies = aiReplies[category] || aiReplies.greeting;
  let reply = replies[Math.floor(Math.random() * replies.length)];
  Object.entries(variables).forEach(([key, value]) => {
    reply = reply.replace(new RegExp(`{${key}}`, 'g'), value);
  });
  return reply;
}

module.exports = { getAIReply };