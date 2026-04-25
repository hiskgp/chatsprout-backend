import { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';
import { AppError, isAppError } from '../utils/errors';
import { logger } from '../utils/logger';

/**
 * Global Error Handler Middleware
 * Must be the last middleware in server.ts
 * Catches all errors and sends proper response
 */
export const errorHandler = (
  err: Error | AppError,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  let error = err;

  // Log error
  logger.error(`Error on ${req.method} ${req.path}`, error, {
    ip: req.ip,
    userAgent: req.get('user-agent'),
    orgId: req.headers['x-org-id'],
  });

  // Convert Prisma errors to AppError
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    error = handlePrismaError(error);
  }

  // Handle JWT errors
  if (error instanceof TokenExpiredError) {
    error = new AppError('Token expired', 401, true, 'TOKEN_EXPIRED');
  }

  if (error instanceof JsonWebTokenError) {
    error = new AppError('Invalid token', 401, true, 'INVALID_TOKEN');
  }

  // Handle validation errors from Zod
  if (error.name === 'ZodError') {
    const zodError = error as any;
    error = new AppError(
      'Validation failed',
      422,
      true,
      'VALIDATION_ERROR',
      zodError.errors
    );
  }

  // Handle Multer errors (file upload)
  if (error.name === 'MulterError') {
    const multerError = error as any;
    if (multerError.code === 'LIMIT_FILE_SIZE') {
      error = new AppError('File too large', 400, true, 'FILE_TOO_LARGE');
    } else {
      error = new AppError('File upload error', 400, true, 'UPLOAD_ERROR');
    }
  }

  // If it's our AppError, send structured response
  if (isAppError(error)) {
    const response: any = {
      success: false,
      error: error.message,
      code: error.code,
    };

    // Add details in development
    if (process.env.NODE_ENV === 'development') {
      response.details = error.details;
      response.stack = error.stack;
    }

    res.status(error.statusCode).json(response);
    return;
  }

  // Unknown error - don't leak details in production
  const statusCode = 500;
  const response: any = {
    success: false,
    error: 'Internal server error',
    code: 'INTERNAL_SERVER_ERROR',
  };

  // Add error details in development only
  if (process.env.NODE_ENV === 'development') {
    response.error = error.message;
    response.stack = error.stack;
    response.name = error.name;
  }

  res.status(statusCode).json(response);
};

/**
 * Handle Prisma Client Known Request Errors
 * Converts Prisma errors to user-friendly AppErrors
 */
const handlePrismaError = (error: Prisma.PrismaClientKnownRequestError): AppError => {
  switch (error.code) {
    case 'P2002':
      // Unique constraint violation
      const target = (error.meta?.target as string[]) || ['field'];
      return new AppError(
        `Duplicate entry for ${target.join(', ')}`,
        409,
        true,
        'DUPLICATE_ENTRY',
        { field: target }
      );

    case 'P2003':
      // Foreign key constraint violation
      return new AppError(
        'Related record not found',
        400,
        true,
        'FOREIGN_KEY_ERROR',
        { field: error.meta?.field_name }
      );

    case 'P2025':
      // Record not found
      return new AppError(
        'Record not found',
        404,
        true,
        'NOT_FOUND',
        { cause: error.meta?.cause }
      );

    case 'P2024':
      // Connection timeout
      return new AppError(
        'Database timeout',
        503,
        true,
        'DATABASE_TIMEOUT'
      );

    case 'P2034':
      // Transaction failed
      return new AppError(
        'Transaction failed, please retry',
        503,
        true,
        'TRANSACTION_FAILED'
      );

    default:
      // Unknown Prisma error
      logger.error('Unhandled Prisma error:', error);
      return new AppError(
        'Database operation failed',
        500,
        false,
        'DATABASE_ERROR',
        { code: error.code }
      );
  }
};

/**
 * 404 Not Found Handler
 * Use this before errorHandler in server.ts
 */
export const notFoundHandler = (req: Request, res: Response): void => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    code: 'NOT_FOUND',
    path: req.path,
    method: req.method,
  });
};

/**
 * Async Handler Wrapper
 * Wraps async route handlers to catch errors
 * Usage: router.get('/', asyncHandler(async (req, res) => {...}))
 */
export const asyncHandler = (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};