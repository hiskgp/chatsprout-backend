import express, { Application, Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import dotenv from 'dotenv';
import { checkDatabaseHealth } from './utils/prisma';
import disconnectPrisma from './utils/prisma';
import { logger } from './utils/logger';
import { rateLimiter, getRedisClient } from './services/redis.service';
import { closeWorkers } from './workers';

// Load environment variables
dotenv.config();

const app: Application = express();
const httpServer = createServer(app);

// Initialize Socket.IO
// export const io = new SocketIOServer(httpServer, {
//   cors: {
//     origin: process.env.FRONTEND_URL || 'http://localhost:5173',
//     credentials: true,
//   },
//   transports: ['websocket', 'polling'],
// });

export const io = new SocketIOServer(httpServer, {
  
  cors: { origin: '*', credentials: false },
  transports: ['websocket', 'polling'],
  allowEIO3: true
});

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https://graph.facebook.com'],
    },
  },
}));

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });
  next();
});

// Rate limiting middleware - global
app.use(async (req, res, next) => {
  const key = `ratelimit:global:${req.ip}`;
  const { allowed, remaining } = await rateLimiter.check(key, 100, 60);

  res.setHeader('X-RateLimit-Remaining', remaining.toString());

  if (!allowed) {
    return res.status(429).json({
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Please try again later.',
      },
    });
  }

  next();
});

// Health check endpoint
app.get('/health', async (req: Request, res: Response) => {
  const dbHealth = await checkDatabaseHealth();
  const redis = getRedisClient();
  let redisHealth = false;

  try {
    await redis.ping();
    redisHealth = true;
  } catch (error) {
    logger.error('Redis health check failed:', error);
  }

  const health = {
    status: dbHealth && redisHealth ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    services: {
      database: dbHealth ? 'up' : 'down',
      redis: redisHealth ? 'up' : 'down',
    },
    uptime: process.uptime(),
    environment: process.env.NODE_ENV,
  };

  res.status(dbHealth && redisHealth ? 200 : 503).json(health);
});

// WhatsApp webhook verification
app.get('/webhook/whatsapp', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    logger.info('WhatsApp webhook verified');
    res.status(200).send(challenge);
  } else {
    logger.warn('WhatsApp webhook verification failed');
    res.sendStatus(403);
  }
});

// ===== SAFE ROUTE LOADER =====
const safeLoadRoute = (path: string, mountPath: string) => {
  try {
    const route = require(path);
    const router = route.default || route;
    if (router && (typeof router === 'function' || router.stack)) {
      app.use(mountPath, router);
      logger.info(`✅ Loaded route: ${mountPath}`);
    } else {
      logger.warn(`⚠️ Skipped ${mountPath} - not a valid router`);
    }
  } catch (error: any) {
    logger.warn(`⚠️ Skipped ${mountPath} - ${error.message}`);
  }
};

// Load routes safely
safeLoadRoute('./modules/webhooks/webhook.routes', '/webhook');
safeLoadRoute('./modules/auth/auth.routes', '/api/auth');
safeLoadRoute('./modules/contacts/contacts.routes', '/api/contacts');
safeLoadRoute('./modules/orders/order.routes', '/api/orders');

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.path} not found`,
    },
  });
});

// Global error handler - inline, no import needed
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  logger.error('Error:', err);
  res.status(err.status || 500).json({
    success: false,
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: err.message || 'Something went wrong',
    },
  });
});

// Socket.IO setup
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication token required'));

    const jwt = await import('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;

    socket.data.user = {
      id: decoded.userId,
      orgId: decoded.orgId,
      role: decoded.role,
    };

    socket.join(`org:${decoded.orgId}`);
    socket.join(`user:${decoded.userId}`);
    next();
  } catch (error) {
    next(new Error('Authentication failed'));
  }
});

io.on('connection', (socket) => {
  logger.info(`Socket connected: ${socket.id}`, { userId: socket.data.user?.id });
  socket.on('disconnect', () => {
    logger.info(`Socket disconnected: ${socket.id}`);
  });
});

// Graceful shutdown
const gracefulShutdown = async (signal: string) => {
  logger.info(`${signal} received. Starting graceful shutdown...`);
  httpServer.close(() => logger.info('HTTP server closed'));
  io.close(() => logger.info('Socket.IO server closed'));
  await closeWorkers();
  await disconnectPrisma.$disconnect();
  const redis = getRedisClient();
  await redis.quit();
  logger.info('Graceful shutdown complete');
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection:', reason);
  gracefulShutdown('UNHANDLED_REJECTION');
});

// Start server
const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    const dbHealthy = await checkDatabaseHealth();
    if (!dbHealthy) throw new Error('Database connection failed');

    const redis = getRedisClient();
    await redis.ping();
    logger.info('Redis connected');

    httpServer.listen(PORT, () => {
      logger.info(`🚀 Server running on port ${PORT}`);
      logger.info(`📡 Environment: ${process.env.NODE_ENV}`);
      logger.info(`🔗 Frontend URL: ${process.env.FRONTEND_URL}`);
      logger.info(`💾 Database: Connected`);
      logger.info(`⚡ Redis: Connected`);
      logger.info(`🔌 Socket.IO: Ready`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

export { app, httpServer };