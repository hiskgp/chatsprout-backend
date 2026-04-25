import { PrismaClient } from '@prisma/client';
import { logger } from './logger';

// PrismaClient singleton pattern
// Prevents multiple instances in development with hot reload

declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

const prismaClientSingleton = () => {
  return new PrismaClient({
    log: [
      {
        emit: 'event',
        level: 'query',
      },
      {
        emit: 'event',
        level: 'error',
      },
      {
        emit: 'event',
        level: 'warn',
      },
    ],
    errorFormat: 'pretty',
  });
};

// Use global instance in development, new instance in production
export const prisma = global.prisma || prismaClientSingleton();

// Log queries in development
if (process.env.NODE_ENV === 'development') {
  prisma.$on('query', (e) => {
    if (process.env.LOG_QUERIES === 'true') {
      logger.debug(`Query: ${e.query}`);
      logger.debug(`Params: ${e.params}`);
      logger.debug(`Duration: ${e.duration}ms`);
    }
  });
}

// Log errors
prisma.$on('error', (e) => {
  logger.error('Prisma Error:', e);
});

// Log warnings
prisma.$on('warn', (e) => {
  logger.warn('Prisma Warning:', e);
});

// Save to global in development
if (process.env.NODE_ENV !== 'production') {
  global.prisma = prisma;
}

/**
 * Connect to database
 * Called on server startup
 */
export const connectDatabase = async (): Promise<void> => {
  try {
    await prisma.$connect();
    logger.info('✅ Database connected successfully');
  } catch (error) {
    logger.error('❌ Database connection failed:', error);
    throw error;
  }
};

/**
 * Disconnect from database
 * Called on graceful shutdown
 */
export const disconnectDatabase = async (): Promise<void> => {
  try {
    await prisma.$disconnect();
    logger.info('Database disconnected successfully');
  } catch (error) {
    logger.error('Error disconnecting database:', error);
    throw error;
  }
};

/**
 * Check database health
 * Used in /health endpoint
 */
export const checkDatabaseHealth = async (): Promise<boolean> => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    logger.error('Database health check failed:', error);
    return false;
  }
};

/**
 * Transaction helper with retry logic
 * Handles Prisma transaction with automatic retry on deadlock
 */
export const transactionWithRetry = async <T>(
  fn: (tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>) => Promise<T>,
  maxRetries: number = 3
): Promise<T> => {
  let lastError: Error | unknown;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await prisma.$transaction(fn, {
        maxWait: 5000, // 5s max wait
        timeout: 10000, // 10s timeout
      });
    } catch (error: any) {
      lastError = error;
      
      // Retry on deadlock or serialization failure
      if (
        error.code === 'P2034' || // Transaction failed
        error.code === 'P2024' || // Timeout
        error.message?.includes('deadlock')
      ) {
        const delay = Math.pow(2, i) * 100; // Exponential backoff
        logger.warn(`Transaction retry ${i + 1}/${maxRetries} after ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      
      // Don't retry other errors
      throw error;
    }
  }

  throw lastError;
};

export default prisma;