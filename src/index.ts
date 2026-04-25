import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';

// Routes
import authRoutes from './routes/auth';
import contactsRoutes from './routes/contacts';
import ordersRoutes from './routes/orders';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Create HTTP server (needed for Socket.IO)
const httpServer = http.createServer(app);

// ===== SOCKET.IO SETUP =====
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    methods: ["GET", "POST"],
    credentials: true
  }
});

io.on('connection', (socket) => {
  console.log('✅ Socket connected:', socket.id);
  
  socket.emit('welcome', { message: 'Connected to Wexo Meta' });
  
  socket.on('disconnect', () => {
    console.log('❌ Socket disconnected:', socket.id);
  });
});

// ===== MIDDLEWARE =====
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:5173",
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== ROUTES =====
app.use('/api/auth', authRoutes);
app.use('/api/contacts', contactsRoutes);
app.use('/api/orders', ordersRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    sockets: io.engine.clientsCount
  });
});

// Webhook - for testing real-time
app.post('/webhook', (req, res) => {
  console.log('📩 Webhook received:', req.body);
  // Broadcast to all connected frontends
  io.emit('new-message', req.body);
  res.status(200).json({ received: true });
});

// Root
app.get('/', (req, res) => {
  res.json({ message: 'Wexo Meta Backend Running', socket: 'enabled' });
});

// ===== START SERVER =====
httpServer.listen(PORT, () => {
  console.log(`\n🚀 Backend running on http://localhost:${PORT}`);
  console.log(`✅ Socket.IO ready`);
  console.log(`📡 Frontend URL: ${process.env.FRONTEND_URL || "http://localhost:5173"}\n`);
});

export { io };